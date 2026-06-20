import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  ScrollArea,
  Separator,
} from "@geolibre/ui";
import {
  Check,
  HardDrive,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { hasActiveServiceWorker, warmUrls } from "../../lib/offline-tiles";
import { NoServiceWorkerBanner } from "./NoServiceWorkerBanner";
import {
  deleteOfflineRegion,
  formatBytes,
  getStorageEstimate,
  loadOfflineRegions,
  measureRegionBytes,
  type OfflineRegion,
  regionAllUrls,
  renameOfflineRegion,
} from "../../lib/offline-regions";

interface OfflineManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Sentinel busy id for the "update all" bulk action. */
const ALL = "__all__";

function formatDate(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

/**
 * Dashboard for the basemap regions the user has downloaded offline. Lists each
 * region with its bounds, zoom range, tile count, on-disk size, and date, and
 * lets the user re-warm (update) a region or delete it to reclaim space. Reads
 * the manifest persisted by the Download Offline Area flow (see
 * lib/offline-regions.ts).
 */
export function OfflineManagerDialog({
  open,
  onOpenChange,
}: OfflineManagerDialogProps) {
  const { t } = useTranslation();
  const [regions, setRegions] = useState<OfflineRegion[]>([]);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [estimate, setEstimate] = useState<{
    usage: number;
    quota: number;
  } | null>(null);
  // The region id currently updating (or ALL), with its live warm progress.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  // Two-step inline delete confirmation: first click arms, second deletes.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // Inline rename: the region id being edited and its draft name.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [swActive, setSwActive] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Mirror `regions` in a ref so the async `update` finally block re-measures
  // against the current list rather than the one captured when it started
  // (which may be stale if a delete landed while the update was in flight).
  const regionsRef = useRef(regions);
  regionsRef.current = regions;

  // Measure each region's cache footprint (async) and refresh the storage
  // estimate. Called on open and after any update/delete.
  const refreshSizes = useCallback(async (list: OfflineRegion[]) => {
    setEstimate(await getStorageEstimate());
    const entries = await Promise.all(
      list.map(async (r) => [r.id, await measureRegionBytes(r)] as const),
    );
    setSizes(Object.fromEntries(entries));
  }, []);

  // Load the manifest whenever the dialog opens.
  useEffect(() => {
    if (!open) {
      // Abort any in-flight update and clear busy state — the `update` finally
      // block skips `setBusyId(null)` when aborted, so without this a refresh
      // interrupted by closing the dialog would leave every button disabled on
      // reopen.
      abortRef.current?.abort();
      abortRef.current = null;
      setBusyId(null);
      setProgress({ done: 0, total: 0 });
      return;
    }
    setSwActive(hasActiveServiceWorker());
    setConfirmId(null);
    setEditingId(null);
    setBusyId(null);
    setProgress({ done: 0, total: 0 });
    const list = loadOfflineRegions();
    setRegions(list);
    void refreshSizes(list);
  }, [open, refreshSizes]);

  // Abort any in-flight update if the dialog unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Re-warm one or all regions, then re-measure footprints.
  const update = useCallback(
    async (targets: OfflineRegion[], busy: string) => {
      const urls = [...new Set(targets.flatMap(regionAllUrls))];
      if (urls.length === 0) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setBusyId(busy);
      setProgress({ done: 0, total: urls.length });
      try {
        await warmUrls(urls, {
          signal: controller.signal,
          onProgress: (p) => setProgress({ done: p.done, total: p.total }),
        });
      } catch {
        // Partial updates are fine; failures leave existing cache untouched.
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (!controller.signal.aborted) {
          setBusyId(null);
          await refreshSizes(regionsRef.current);
        }
      }
    },
    [refreshSizes],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setConfirmId(null);
      const { regions: remaining } = await deleteOfflineRegion(id);
      setRegions(remaining);
      await refreshSizes(remaining);
    },
    [refreshSizes],
  );

  const startRename = useCallback((region: OfflineRegion) => {
    setConfirmId(null);
    setEditingId(region.id);
    setDraftName(region.name);
  }, []);

  const cancelRename = useCallback(() => setEditingId(null), []);

  // Persist the trimmed draft as the region's name. An empty draft just cancels
  // (a region always keeps a non-empty label).
  const commitRename = useCallback(() => {
    if (editingId === null) return;
    const name = draftName.trim();
    if (name) setRegions(renameOfflineRegion(editingId, name));
    setEditingId(null);
  }, [editingId, draftName]);

  const totalBytes = Object.values(sizes).reduce((sum, b) => sum + b, 0);
  const busy = busyId !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("offlineManager.title")}</DialogTitle>
          <DialogDescription>
            {t("offlineManager.description")}
          </DialogDescription>
        </DialogHeader>

        {!swActive && (
          <NoServiceWorkerBanner message={t("offlineManager.noServiceWorker")} />
        )}

        {regions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t("offlineManager.empty")}
          </p>
        ) : (
          <ScrollArea className="max-h-[52vh] pr-3">
            <ul className="space-y-2">
              {regions.map((region) => {
                const isBusy = busyId === region.id || busyId === ALL;
                return (
                  <li
                    key={region.id}
                    className="rounded-md border border-border p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        {editingId === region.id ? (
                          <Input
                            autoFocus
                            value={draftName}
                            aria-label={t("offlineManager.nameLabel")}
                            className="mb-1 h-7 text-sm"
                            onChange={(event) =>
                              setDraftName(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") commitRename();
                              else if (event.key === "Escape") cancelRename();
                            }}
                          />
                        ) : (
                          <p className="truncate text-sm font-medium">
                            {region.name}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {t("offlineManager.zoomRange", {
                            min: region.minZoom,
                            max: region.maxZoom,
                          })}{" "}
                          ·{" "}
                          {t("offlineManager.tilesCount", {
                            count: region.tileCount,
                          })}{" "}
                          · {formatBytes(sizes[region.id] ?? 0)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t("offlineManager.savedOn", {
                            date: formatDate(region.updatedAt),
                          })}
                          {region.hosts.length > 0
                            ? ` · ${region.hosts.join(", ")}`
                            : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {editingId === region.id ? (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={t("common.save")}
                              onClick={commitRename}
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={t("common.cancel")}
                              onClick={cancelRename}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </>
                        ) : confirmId === region.id ? (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirmId(null)}
                            >
                              {t("common.cancel")}
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => void handleDelete(region.id)}
                            >
                              {t("offlineManager.confirmDelete")}
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={t("offlineManager.rename")}
                              disabled={busy}
                              onClick={() => startRename(region)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={t("offlineManager.update")}
                              disabled={busy || !swActive}
                              onClick={() => void update([region], region.id)}
                            >
                              {busyId === region.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <RefreshCw className="h-4 w-4" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={t("offlineManager.delete")}
                              disabled={busy}
                              onClick={() => setConfirmId(region.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                    {isBusy && (
                      <p className="mt-2 text-xs text-muted-foreground tabular-nums">
                        {t("offlineManager.updating", {
                          done: progress.done,
                          total: progress.total,
                        })}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}

        {regions.length > 0 && (
          <>
            <Separator />
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 text-muted-foreground">
                <HardDrive className="h-4 w-4" />
                {t("offlineManager.totalFootprint", {
                  size: formatBytes(totalBytes),
                  count: regions.length,
                })}
              </span>
              {estimate && estimate.quota > 0 && (
                <span className="tabular-nums text-muted-foreground">
                  {t("offlineManager.deviceUsage", {
                    usage: formatBytes(estimate.usage),
                    quota: formatBytes(estimate.quota),
                  })}
                </span>
              )}
            </div>
          </>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
          {regions.length > 0 && (
            <Button
              variant="outline"
              disabled={busy || !swActive}
              onClick={() => void update(regions, ALL)}
            >
              {busyId === ALL ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              {t("offlineManager.updateAll")}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
