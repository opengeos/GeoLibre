import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MapController } from "@geolibre/map";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  Separator,
  Slider,
} from "@geolibre/ui";
import { Download, Loader2, WifiOff } from "lucide-react";
import {
  type Bbox,
  collectOfflineUrls,
  countTiles,
  hasActiveServiceWorker,
  warmUrls,
  type WarmProgress,
} from "../../lib/offline-tiles";

interface OfflineRegionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}

/** Hosts the service worker is configured to cache (kept in sync with vite.config.ts). */
const CACHED_TILE_HOST = /(?:^|\.)(?:openfreemap\.org|cartocdn\.com)$/;

/** Rough average bytes per tile, for a ballpark download-size preview. */
const AVG_TILE_BYTES = 30 * 1024;

const MAX_EXTRA_LEVELS = 5;

/**
 * The basemap service-worker cache cap (geolibre-basemaps maxEntries in
 * vite.config.ts). Beyond this, Workbox evicts the oldest tiles as new ones
 * arrive, so a region larger than this can't be fully retained — warn the user.
 */
const MAX_CACHE_ENTRIES = 8000;

type Phase = "idle" | "running" | "done";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Lets the user pre-download the current map area (across a zoom range) into the
 * service-worker cache so it renders offline. See lib/offline-tiles.ts for the
 * caching mechanism.
 */
export function OfflineRegionDialog({
  open,
  onOpenChange,
  mapControllerRef,
}: OfflineRegionDialogProps) {
  const { t } = useTranslation();
  // Default off, so the dialog starts scoped to the current view's zoom only.
  const [includeExtra, setIncludeExtra] = useState(false);
  const [extraLevels, setExtraLevels] = useState(1);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<WarmProgress>({
    done: 0,
    total: 0,
    failed: 0,
  });
  const abortRef = useRef<AbortController | null>(null);

  // Snapshot the view when the dialog opens; re-reading live would let the
  // estimate drift while the user is interacting with the dialog.
  const view = useMemo(() => {
    if (!open) return null;
    return mapControllerRef.current?.readView() ?? null;
  }, [open, mapControllerRef]);

  const baseZoom = view ? Math.floor(view.zoom) : 0;
  const effectiveExtra = includeExtra ? extraLevels : 0;
  const maxZoom = Math.min(22, baseZoom + effectiveExtra);
  const bbox = (view?.bbox ?? null) as Bbox | null;

  const tileCount = useMemo(
    () => (bbox ? countTiles(bbox, baseZoom, maxZoom) : 0),
    [bbox, baseZoom, maxZoom],
  );

  const { cacheableHosts, uncacheableHosts } = useMemo(() => {
    const map = mapControllerRef.current?.getMap();
    if (!open || !map) return { cacheableHosts: [], uncacheableHosts: [] };
    const cacheable = new Set<string>();
    const uncacheable = new Set<string>();
    const style = map.getStyle();
    for (const source of Object.values(style.sources ?? {})) {
      const spec = source as { type?: string; tiles?: string[]; url?: string };
      if (spec.type !== "vector" && spec.type !== "raster") continue;
      const ref = spec.tiles?.[0] ?? spec.url;
      if (!ref) continue;
      try {
        const host = new URL(ref, window.location.href).hostname;
        (CACHED_TILE_HOST.test(host) ? cacheable : uncacheable).add(host);
      } catch {
        // Ignore unparseable source refs.
      }
    }
    return {
      cacheableHosts: [...cacheable],
      uncacheableHosts: [...uncacheable],
    };
  }, [open, mapControllerRef]);

  const swActive = useMemo(
    () => (open ? hasActiveServiceWorker() : false),
    [open],
  );

  // Reset transient state each time the dialog is opened, and abort any
  // in-flight download when it is closed (Radix keeps the dialog mounted, so
  // closing it would otherwise leave the download running in the background).
  useEffect(() => {
    if (open) {
      setPhase("idle");
      setProgress({ done: 0, total: 0, failed: 0 });
      setIncludeExtra(false);
      setExtraLevels(1);
    } else {
      abortRef.current?.abort();
    }
  }, [open]);

  // Abort any in-flight download if the dialog unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleDownload = useCallback(async () => {
    const map = mapControllerRef.current?.getMap();
    if (!map || !bbox) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("running");
    setProgress({ done: 0, total: 0, failed: 0 });
    try {
      const urls = await collectOfflineUrls(map, bbox, baseZoom, maxZoom, {
        signal: controller.signal,
      });
      setProgress({ done: 0, total: urls.length, failed: 0 });
      const result = await warmUrls(urls, {
        signal: controller.signal,
        onProgress: setProgress,
      });
      setProgress(result);
      if (!controller.signal.aborted) setPhase("done");
    } catch {
      // collectOfflineUrls swallows TileJSON errors, but guard the rare throw
      // (e.g. getStyle failing) so the UI doesn't show a false "done" state.
      if (!controller.signal.aborted) setPhase("idle");
    } finally {
      // Only clear the ref if it still points to this run — a quick
      // cancel-then-redownload may have already installed a newer controller.
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [mapControllerRef, bbox, baseZoom, maxZoom]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    setPhase("idle");
  }, []);

  const percent =
    progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("offline.title")}</DialogTitle>
          <DialogDescription>{t("offline.description")}</DialogDescription>
        </DialogHeader>

        {!swActive && (
          <p className="flex items-start gap-2 rounded-md bg-amber-500/10 p-2 text-sm text-amber-700 dark:text-amber-400">
            <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
            {t("offline.noServiceWorker")}
          </p>
        )}

        {uncacheableHosts.length > 0 && (
          <>
            <p className="rounded-md bg-amber-500/10 p-2 text-sm text-amber-700 dark:text-amber-400">
              {t("offline.uncacheable", { hosts: uncacheableHosts.join(", ") })}
            </p>
            {cacheableHosts.length > 0 && (
              <p className="rounded-md bg-emerald-500/10 p-2 text-sm text-emerald-700 dark:text-emerald-400">
                {t("offline.cacheable", { hosts: cacheableHosts.join(", ") })}
              </p>
            )}
          </>
        )}

        <div className="space-y-4 py-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              className="h-4 w-4"
              type="checkbox"
              checked={includeExtra}
              disabled={phase === "running"}
              onChange={(event) => setIncludeExtra(event.target.checked)}
            />
            {t("offline.includeExtra")}
          </label>

          {includeExtra ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label>{t("offline.detailLevels")}</Label>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {t("offline.relativeLevels", {
                    count: extraLevels,
                    min: baseZoom,
                    max: maxZoom,
                  })}
                </span>
              </div>
              <Slider
                aria-label={t("offline.detailLevels")}
                min={1}
                max={MAX_EXTRA_LEVELS}
                step={1}
                value={[extraLevels]}
                onValueChange={(value: number[]) => setExtraLevels(value[0])}
                disabled={phase === "running"}
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("offline.currentViewOnly", { zoom: baseZoom })}
            </p>
          )}

          <Separator />

          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t("offline.tiles")}</span>
            <span className="tabular-nums">
              {tileCount.toLocaleString()} (~
              {formatBytes(tileCount * AVG_TILE_BYTES)})
            </span>
          </div>

          {tileCount > MAX_CACHE_ENTRIES && (
            <p className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
              {t("offline.tooManyTiles", {
                max: MAX_CACHE_ENTRIES.toLocaleString(),
              })}
            </p>
          )}

          {phase !== "idle" && (
            <div className="space-y-1">
              <div className="h-2 w-full overflow-hidden rounded-full bg-primary/20">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground tabular-nums">
                {phase === "done"
                  ? t("offline.complete", {
                      done: progress.done - progress.failed,
                      total: progress.total,
                      failed: progress.failed,
                    })
                  : t("offline.progress", {
                      done: progress.done,
                      total: progress.total,
                    })}
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          {phase === "running" ? (
            <Button variant="outline" onClick={handleCancel}>
              {t("offline.cancel")}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.close")}
            </Button>
          )}
          <Button
            onClick={handleDownload}
            disabled={phase === "running" || tileCount === 0 || !swActive}
          >
            {phase === "running" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            {t("offline.download")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
