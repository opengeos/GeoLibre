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
  Input,
  Label,
  Separator,
  Slider,
} from "@geolibre/ui";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  RotateCw,
} from "lucide-react";
import {
  type Bbox,
  collectOfflineUrls,
  countOfflineTiles,
  countStyleAssets,
  hasActiveServiceWorker,
  planOfflineZoom,
  warmUrls,
  type WarmProgress,
} from "../../lib/offline-tiles";
import { NoServiceWorkerBanner } from "./NoServiceWorkerBanner";
import {
  describeBboxCenter,
  formatBytes,
  type OfflineRegion,
  regionId,
  touchOfflineRegion,
  upsertOfflineRegion,
  urlHosts,
} from "../../lib/offline-regions";

interface OfflineRegionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mapControllerRef: React.RefObject<MapController | null>;
}

/** Hosts the service worker is configured to cache (kept in sync with vite.config.ts). */
const CACHED_TILE_HOST = /(?:^|\.)(?:openfreemap\.org|cartocdn\.com)$/;

/** Rough average bytes per tile, for a ballpark download-size preview. */
const AVG_TILE_BYTES = 30 * 1024;

/**
 * Rough average bytes per shared style asset (sprite JSON/PNG, glyph PBF). These
 * are much smaller than map tiles, so they get their own average rather than
 * being sized with `AVG_TILE_BYTES`, which would overstate their contribution.
 */
const AVG_ASSET_BYTES = 10 * 1024;

const MAX_EXTRA_LEVELS = 5;

/**
 * Fallback map max zoom for the rare case where the live map can't be read at
 * dialog-open time. Matches the project's default max zoom (see
 * `DEFAULT_PROJECT_PREFERENCES.map.maxZoom`) so the degraded path doesn't revert
 * to the old hard-coded 22 ceiling; the real value comes from `getMaxZoom()`.
 */
const DEFAULT_MAX_ZOOM = 24;

/** Default and bounds for the advanced concurrency control. */
const DEFAULT_CONCURRENCY = 6;
const MAX_CONCURRENCY = 8;
/** Bounds (seconds) for the advanced per-request timeout; 0 means no timeout. */
const MAX_TIMEOUT_SEC = 120;

/**
 * The basemap service-worker cache cap (geolibre-basemaps maxEntries in
 * vite.config.ts). Beyond this, Workbox evicts the oldest tiles as new ones
 * arrive, so a region larger than this can't be fully retained — warn the user.
 */
const MAX_CACHE_ENTRIES = 8000;

type Phase = "idle" | "running" | "done";

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
  // Advanced network controls (collapsed by default): power users can lower
  // concurrency to slip past server rate limiting, or raise the per-request
  // timeout for slow links. See #564.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY);
  const [timeoutSec, setTimeoutSec] = useState(0);
  // When the planned download exceeds the cache cap, the user must explicitly
  // acknowledge that older tiles may be evicted before the download is allowed
  // (#994): the warning alone no longer leaves the action freely clickable.
  const [acknowledgeEviction, setAcknowledgeEviction] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<WarmProgress>({
    done: 0,
    total: 0,
    failed: 0,
    failedUrls: [],
  });
  const abortRef = useRef<AbortController | null>(null);
  // Mirror `progress` in a ref so `handleRetry` can read the latest failed URLs
  // without listing `progress` as a dependency — otherwise the callback would be
  // recreated on every settled tile, since each `onProgress` emits a fresh
  // `failedUrls` array.
  const progressRef = useRef(progress);
  progressRef.current = progress;

  // Snapshot the view (and the map's configured max zoom) when the dialog opens;
  // re-reading live would let the estimate drift while the user is interacting
  // with the dialog.
  const view = useMemo(() => {
    if (!open) return null;
    return mapControllerRef.current?.readView() ?? null;
  }, [open, mapControllerRef]);
  const mapMaxZoom = useMemo(() => {
    if (!open) return DEFAULT_MAX_ZOOM;
    const max = mapControllerRef.current?.getMap()?.getMaxZoom();
    return typeof max === "number" && Number.isFinite(max)
      ? max
      : DEFAULT_MAX_ZOOM;
  }, [open, mapControllerRef]);

  // Bound the extra-detail range by the map's real max zoom (configurable, up to
  // 24) instead of a fixed ceiling, so the slider tracks what the map can render,
  // every step has an effect, and the range never inverts at the top zoom (#750,
  // #751).
  const { baseZoom, maxZoom, maxExtraLevels, canIncludeExtra } = planOfflineZoom(
    view?.zoom ?? 0,
    mapMaxZoom,
    includeExtra,
    extraLevels,
    MAX_EXTRA_LEVELS,
  );
  const bbox = (view?.bbox ?? null) as Bbox | null;

  // Counts are resolved asynchronously: countOfflineTiles clamps each tile source
  // to its own maxzoom (the vector source's bound lives in a TileJSON we have to
  // fetch), so the estimate matches what actually downloads instead of counting
  // tiles past a source's maxzoom that would 404. Tiles and shared style assets
  // (sprite + glyphs) are tracked separately so the size estimate can price them
  // differently, but their sum (`resourceCount`) is what the download fetches —
  // so the preview equals the live "Downloading N / M" total rather than
  // undercounting by the asset overhead (#992).
  const [tileCount, setTileCount] = useState(0);
  const [assetCount, setAssetCount] = useState(0);
  const resourceCount = tileCount + assetCount;
  useEffect(() => {
    const map = mapControllerRef.current?.getMap();
    if (!open || !bbox || !map) {
      setTileCount(0);
      setAssetCount(0);
      return;
    }
    const controller = new AbortController();
    let active = true;
    countOfflineTiles(map, bbox, baseZoom, maxZoom, {
      signal: controller.signal,
    })
      .then((count) => {
        if (active) {
          setTileCount(count);
          setAssetCount(countStyleAssets(map));
        }
      })
      .catch(() => {
        // Discovery failed (e.g. aborted); leave the last known count.
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [open, bbox, baseZoom, maxZoom, mapControllerRef]);

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
      setProgress({ done: 0, total: 0, failed: 0, failedUrls: [] });
      setIncludeExtra(false);
      setExtraLevels(1);
      setShowAdvanced(false);
      setConcurrency(DEFAULT_CONCURRENCY);
      setTimeoutSec(0);
      setAcknowledgeEviction(false);
    } else {
      abortRef.current?.abort();
    }
  }, [open]);

  // Re-scoping the area (a different zoom range) invalidates the previous run's
  // outcome, so clear the completed/progress state and the eviction
  // acknowledgement. Without this, a stale "Saved N of N" count and a checked
  // acknowledgement would linger over the new settings (#994). The download
  // controls are disabled while running, so baseZoom/maxZoom can only change when
  // idle or done — never mid-run.
  useEffect(() => {
    setPhase((current) => (current === "running" ? current : "idle"));
    setProgress({ done: 0, total: 0, failed: 0, failedUrls: [] });
    setAcknowledgeEviction(false);
    // Zero the counts synchronously so the over-limit warning/checkbox don't
    // briefly flash with the previous range's count before the async recount
    // resolves.
    setTileCount(0);
    setAssetCount(0);
  }, [baseZoom, maxZoom]);

  // Abort any in-flight download if the dialog unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Full (re-)download of the whole region — also serves as "Retry all tiles".
  const handleDownload = useCallback(async () => {
    const map = mapControllerRef.current?.getMap();
    if (!map || !bbox) return;
    // Abort any in-flight run first so a "Retry all" issued while a previous
    // batch is settling can't leave two concurrent warmUrls runs racing.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : undefined;
    setPhase("running");
    setProgress({ done: 0, total: 0, failed: 0, failedUrls: [] });
    try {
      const { urls, tileUrls } = await collectOfflineUrls(
        map,
        bbox,
        baseZoom,
        maxZoom,
        { signal: controller.signal },
      );
      setProgress({ done: 0, total: urls.length, failed: 0, failedUrls: [] });
      const result = await warmUrls(urls, {
        concurrency,
        timeoutMs,
        signal: controller.signal,
        onProgress: setProgress,
      });
      setProgress(result);
      if (!controller.signal.aborted) {
        setPhase("done");
        // Record the download in the offline manifest so the Offline Manager can
        // list, re-warm, and delete it later. Gate on cached *tiles*, not total
        // successes: `urls` includes shared sprite/glyph assets, so a run where
        // every tile failed but an asset succeeded must not persist an empty
        // region.
        const failedSet = new Set(result.failedUrls);
        // tileCount reflects tiles actually cached, not attempted, so a
        // partial download's count matches what the manager can measure.
        const cachedTileCount = tileUrls.filter(
          (u) => !failedSet.has(u),
        ).length;
        if (cachedTileCount > 0) {
          const tileSet = new Set(tileUrls);
          const assetUrls = urls.filter((u) => !tileSet.has(u));
          const now = Date.now();
          const region: OfflineRegion = {
            id: regionId(bbox, baseZoom, maxZoom),
            name: describeBboxCenter(bbox),
            bbox,
            minZoom: baseZoom,
            maxZoom,
            tileUrls,
            assetUrls,
            tileCount: cachedTileCount,
            hosts: urlHosts(tileUrls),
            createdAt: now,
            updatedAt: now,
          };
          const { persisted } = upsertOfflineRegion(region);
          if (!persisted) {
            console.warn(
              "[GeoLibre] offline region manifest could not be saved (storage full?)",
            );
          }
        }
      }
    } catch {
      // collectOfflineUrls swallows TileJSON errors, but guard the rare throw
      // (e.g. getStyle failing) so the UI doesn't show a false "done" state.
      if (!controller.signal.aborted) setPhase("idle");
    } finally {
      // Only clear the ref if it still points to this run — a quick
      // cancel-then-redownload may have already installed a newer controller.
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [mapControllerRef, bbox, baseZoom, maxZoom, concurrency, timeoutSec]);

  // Re-warm only the URLs that failed, so the user can recover a partial
  // download (e.g. after a transient network blip) without re-fetching the
  // whole region. The live bar tracks this retry batch, but the final count is
  // reframed to the whole region (below) so the completion message reports the
  // full area, not just the handful that were retried.
  const handleRetry = useCallback(async () => {
    const failedUrls = progressRef.current.failedUrls;
    if (failedUrls.length === 0) return;
    // The total from the prior (full) run; the completion message is reframed to
    // this so a successful retry reads "N resources cached" for the whole region.
    const regionTotal = progressRef.current.total;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : undefined;
    setPhase("running");
    setProgress({
      done: 0,
      total: failedUrls.length,
      failed: 0,
      failedUrls: [],
    });
    try {
      const result = await warmUrls(failedUrls, {
        concurrency,
        timeoutMs,
        signal: controller.signal,
        onProgress: setProgress,
      });
      // Reframe to the whole region while keeping the WarmProgress convention
      // (`done` = all settled, successes + failures): all `regionTotal` resources
      // are now settled, `result.failed` of them are still outstanding (retried
      // but failed again), and the completion templates derive the saved count as
      // `done - failed`. `failedUrls` carries the remaining failures for another
      // retry.
      setProgress({
        done: regionTotal,
        total: regionTotal,
        failed: result.failed,
        failedUrls: result.failedUrls,
      });
      if (!controller.signal.aborted) {
        setPhase("done");
        // Bump the manifest's updatedAt so the Offline Manager reflects this
        // recovery instead of the original (partial) download's date. The stored
        // URL list already covers every tile, so no other field changes.
        if (bbox && result.done - result.failed > 0) {
          touchOfflineRegion(regionId(bbox, baseZoom, maxZoom), Date.now());
        }
      }
    } catch {
      if (!controller.signal.aborted) setPhase("idle");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [concurrency, timeoutSec, bbox, baseZoom, maxZoom]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    setPhase("idle");
  }, []);

  const percent =
    progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  // After a partial download the primary action becomes "Retry all tiles" (a
  // full re-warm from scratch), shown alongside the targeted "Retry failed".
  const hasFailures = phase === "done" && progress.failed > 0;
  // A fully successful run: every requested resource was cached and at least one
  // was fetched. The `done > 0` guard avoids a false "saved" banner if the URL
  // set ever resolves empty (e.g. the style loses its sources mid-dialog). This
  // drives the success confirmation and the "Done" footer that replaces the
  // re-enabled Download button (#993).
  const isComplete =
    phase === "done" && progress.failed === 0 && progress.done > 0;
  // The plan exceeds the service-worker cache cap, so older tiles would be
  // evicted as new ones arrive — the user must acknowledge before downloading
  // (#994).
  const overLimit = resourceCount > MAX_CACHE_ENTRIES;
  // Gate every download control while a run is in flight, and also when there is
  // no service worker to retain the tiles — without it the dialog would invite
  // the user to configure a download this build can never persist (see #608).
  const controlsDisabled = phase === "running" || !swActive;
  // The shared eviction gate: block while running / without a SW, and when the
  // plan exceeds the cache cap without an acknowledgement.
  const evictionBlocked =
    controlsDisabled || (overLimit && !acknowledgeEviction);
  // A fresh download additionally needs something to fetch. A retry doesn't —
  // its viability comes from its own failedUrls list, not resourceCount — so it
  // uses evictionBlocked alone.
  const downloadDisabled = evictionBlocked || resourceCount === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("offline.title")}</DialogTitle>
          <DialogDescription>{t("offline.description")}</DialogDescription>
        </DialogHeader>

        {!swActive && (
          <NoServiceWorkerBanner message={t("offline.noServiceWorker")} />
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
          {/* At the map's max zoom there is no deeper detail to fetch, so the
              "include extra" control is hidden — offering it would only produce
              an empty (or inverted) range (#751). */}
          {canIncludeExtra && (
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                className="h-4 w-4"
                type="checkbox"
                checked={includeExtra}
                disabled={controlsDisabled}
                onChange={(event) => setIncludeExtra(event.target.checked)}
              />
              {t("offline.includeExtra")}
            </label>
          )}

          {canIncludeExtra && includeExtra ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label>{t("offline.detailLevels")}</Label>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {t("offline.relativeLevels", {
                    count: maxZoom - baseZoom,
                    min: baseZoom,
                    max: maxZoom,
                  })}
                </span>
              </div>
              <Slider
                aria-label={t("offline.detailLevels")}
                min={1}
                max={maxExtraLevels}
                step={1}
                // Clamp only the displayed value, not the `extraLevels` state:
                // `maxExtraLevels` is derived from the view + map max zoom
                // snapshotted at open time and `extraLevels` resets to 1 on open,
                // so the two can't diverge within a session. planOfflineZoom
                // clamps again, so the footer stays correct regardless.
                value={[Math.min(extraLevels, maxExtraLevels)]}
                onValueChange={(value: number[]) => setExtraLevels(value[0])}
                disabled={controlsDisabled}
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("offline.currentViewOnly", { zoom: baseZoom })}
            </p>
          )}

          <div className="space-y-3">
            <button
              type="button"
              className="flex items-center gap-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground"
              aria-expanded={showAdvanced}
              disabled={controlsDisabled}
              onClick={() => setShowAdvanced((value) => !value)}
            >
              {showAdvanced ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              {t("offline.advanced")}
            </button>

            {showAdvanced && (
              <div className="space-y-4 rounded-md border border-border p-3">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>{t("offline.concurrency")}</Label>
                    <span className="text-sm tabular-nums text-muted-foreground">
                      {concurrency}
                    </span>
                  </div>
                  <Slider
                    aria-label={t("offline.concurrency")}
                    min={1}
                    max={MAX_CONCURRENCY}
                    step={1}
                    value={[concurrency]}
                    onValueChange={(value: number[]) =>
                      setConcurrency(value[0])
                    }
                    disabled={controlsDisabled}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("offline.concurrencyHint")}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="offline-timeout">
                    {t("offline.timeout")}
                  </Label>
                  <Input
                    id="offline-timeout"
                    type="number"
                    min={0}
                    max={MAX_TIMEOUT_SEC}
                    value={timeoutSec}
                    disabled={controlsDisabled}
                    onChange={(event) => {
                      const next = Math.round(Number(event.target.value));
                      setTimeoutSec(
                        Number.isFinite(next)
                          ? Math.min(MAX_TIMEOUT_SEC, Math.max(0, next))
                          : 0,
                      );
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    {timeoutSec > 0
                      ? t("offline.timeoutHint", { seconds: timeoutSec })
                      : t("offline.timeoutDisabled")}
                  </p>
                </div>
              </div>
            )}
          </div>

          <Separator />

          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t("offline.tiles")}</span>
            <span className="tabular-nums">
              {resourceCount.toLocaleString()} (~
              {formatBytes(
                tileCount * AVG_TILE_BYTES + assetCount * AVG_ASSET_BYTES,
              )}
              )
            </span>
          </div>

          {overLimit && !isComplete && (
            <div className="space-y-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
              <p>
                {t("offline.tooManyTiles", {
                  max: MAX_CACHE_ENTRIES.toLocaleString(),
                })}
              </p>
              <label className="flex items-center gap-2 font-medium">
                <input
                  className="h-4 w-4"
                  type="checkbox"
                  checked={acknowledgeEviction}
                  disabled={controlsDisabled}
                  onChange={(event) =>
                    setAcknowledgeEviction(event.target.checked)
                  }
                />
                {t("offline.acknowledgeEviction")}
              </label>
            </div>
          )}

          {phase !== "idle" && (
            <div className="space-y-1">
              <div className="h-2 w-full overflow-hidden rounded-full bg-primary/20">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
              {isComplete ? (
                <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  {/* isComplete guarantees progress.failed === 0 here, so done is
                      the full cached count. */}
                  {t("offline.complete", { count: progress.done })}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground tabular-nums">
                  {phase === "done"
                    ? t("offline.completeWithFailures", {
                        done: progress.done - progress.failed,
                        total: progress.total,
                        failed: progress.failed,
                      })
                    : t("offline.progress", {
                        done: progress.done,
                        total: progress.total,
                      })}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          {isComplete ? (
            // A successful download ends in a single "Done" action that closes
            // the dialog, rather than re-enabling a blue "Download" button that
            // reads as "nothing happened" and invites a duplicate run (#993).
            <Button onClick={() => onOpenChange(false)}>
              <CheckCircle2 className="mr-2 h-4 w-4" />
              {t("common.done")}
            </Button>
          ) : (
            <>
              {phase === "running" ? (
                <Button variant="outline" onClick={handleCancel}>
                  {t("offline.cancel")}
                </Button>
              ) : (
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  {t("common.close")}
                </Button>
              )}
              {hasFailures && (
                <Button
                  variant="outline"
                  onClick={handleRetry}
                  // Share the eviction gate so an over-limit retry is blocked
                  // until acknowledged (otherwise the user could uncheck the
                  // acknowledgement in the partial-failure state and bypass it via
                  // "Retry failed"). A retry doesn't depend on resourceCount, so
                  // it uses evictionBlocked rather than the full downloadDisabled.
                  disabled={evictionBlocked}
                >
                  <RotateCw className="mr-2 h-4 w-4" />
                  {t("offline.retryFailed", { count: progress.failed })}
                </Button>
              )}
              <Button
                // "Retry all" and "Download" share this handler (a full re-warm);
                // handleDownload aborts any in-flight run first, so it is safe to
                // keep enabled even while failures are outstanding.
                onClick={handleDownload}
                disabled={downloadDisabled}
              >
                {phase === "running" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : hasFailures ? (
                  <RotateCw className="mr-2 h-4 w-4" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                {hasFailures ? t("offline.retryAll") : t("offline.download")}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
