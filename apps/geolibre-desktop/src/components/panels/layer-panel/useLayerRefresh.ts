import { arcGISLayerHasPendingEdits } from "@geolibre/plugins";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import { reloadVectorControlLayer, replayVectorControlLayerById } from "@geolibre/plugins";
import {
  getLayerRefreshConfig,
  isRefreshableLayer,
  isVectorControlRefreshLayer,
  refreshGeoJsonLayer,
  setLayerConnectionResult,
  setLayerRefreshConfig,
  supportsAutoRefresh,
} from "../../../lib/layer-refresh";
import { isIcebergLayer, refreshIcebergLayer } from "../../../lib/iceberg";
import {
  getLayerWatchConfig,
  isLocalFileLayer,
  reloadLocalFileLayer,
  setLayerWatchConfig,
} from "../../../lib/local-file-watch";
import { isSqlQueryLayer, refreshSqlQueryLayer } from "../../../lib/sql-query-layer";
import { isTauri } from "../../../lib/is-tauri";
import {
  REFRESH_STATUS_DURATION_MS,
  SYNC_CLOCK_TICK_MS,
  type LayerRefreshStatus,
  type LayerRefreshTimer,
} from "./layer-panel-utils";

interface UseLayerRefreshOptions {
  /** The project's layers, in store order. */
  layers: GeoLibreLayer[];
  /** Whether the panel is collapsed to its rail (pauses the sync clock). */
  isCollapsed: boolean;
}

/**
 * Per-layer status notes plus everything that refreshes a layer's data: the
 * manual Refresh/Reload action, auto-refresh interval timers, the catch-up on
 * returning to the tab, and the local-file watchers. The status notes are also
 * the feedback row the layer actions write to (export, save, style copy), so
 * the setters are returned alongside the refresh handlers.
 *
 * @param options - The layers to schedule and the panel's collapse state.
 * @returns The status map, its setters, and the refresh handlers.
 */
export function useLayerRefresh({ layers, isCollapsed }: UseLayerRefreshOptions) {
  const { t } = useTranslation();
  const projectGeneration = useAppStore((s) => s.projectGeneration);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const [refreshStatuses, setRefreshStatuses] = useState<Record<string, LayerRefreshStatus>>({});
  // "Last synced <relative time>" is derived from the clock, not from store
  // state, so without a tick the label would keep reading "a few seconds ago"
  // until an unrelated re-render happened to recompute it. Tick once a minute
  // while the panel is open and at least one layer carries a sync timestamp.
  const [, setSyncClockTick] = useState(0);
  const hasSyncTimestamps = layers.some((layer) => Boolean(layer.connection?.lastSyncedAt));
  useEffect(() => {
    if (isCollapsed || !hasSyncTimestamps) return;
    const timer = window.setInterval(
      () => setSyncClockTick((tick) => tick + 1),
      SYNC_CLOCK_TICK_MS,
    );
    return () => window.clearInterval(timer);
  }, [isCollapsed, hasSyncTimestamps]);
  const refreshingLayerIdsRef = useRef(new Set<string>());
  const refreshTimersRef = useRef(new Map<string, LayerRefreshTimer>());
  const refreshStatusTimersRef = useRef(new Map<string, number>());
  // Active filesystem watchers for "watch local file" layers, keyed by layer id.
  // `path` lets us restart the watch if a layer's source path ever changes;
  // `unwatch` tears it down (and doubles as a cancel flag while `watch()` is
  // still resolving — see the watch-lifecycle effect below).
  const watchUnsubsRef = useRef(new Map<string, { path: string; unwatch: () => void }>());

  const clearRefreshStatusTimer = useCallback((layerId: string) => {
    const timer = refreshStatusTimersRef.current.get(layerId);
    if (!timer) return;
    window.clearTimeout(timer);
    refreshStatusTimersRef.current.delete(layerId);
  }, []);

  const scheduleStatusClear = useCallback(
    (layerId: string) => {
      clearRefreshStatusTimer(layerId);
      const timer = window.setTimeout(() => {
        refreshStatusTimersRef.current.delete(layerId);
        setRefreshStatuses((current) => {
          // Keep in-flight statuses; only fade finished success/error notes.
          if (!current[layerId] || current[layerId].type === "refreshing") {
            return current;
          }
          const next = { ...current };
          delete next[layerId];
          return next;
        });
      }, REFRESH_STATUS_DURATION_MS);
      refreshStatusTimersRef.current.set(layerId, timer);
    },
    [clearRefreshStatusTimer],
  );

  const handleRefreshLayer = useCallback(
    async (layer: GeoLibreLayer, automatic = false) => {
      if (refreshingLayerIdsRef.current.has(layer.id)) return;

      refreshingLayerIdsRef.current.add(layer.id);
      clearRefreshStatusTimer(layer.id);
      setRefreshStatuses((current) => ({
        ...current,
        [layer.id]: {
          type: "refreshing",
          message: automatic ? t("layers.refreshingAuto") : t("layers.refreshing"),
        },
      }));

      try {
        if (isSqlQueryLayer(layer)) {
          // SQL query layers refresh by re-executing their stored DuckDB
          // statement against the current layers (the query layer itself is
          // excluded so it cannot shadow a source table name).
          const { geojson, featureCount } = await refreshSqlQueryLayer(
            layer,
            useAppStore.getState().layers,
          );
          const latest = useAppStore
            .getState()
            .layers.find((candidate) => candidate.id === layer.id);
          if (!latest) return;

          updateLayer(layer.id, {
            geojson,
            ...setLayerConnectionResult(latest, {
              syncedAt: new Date().toISOString(),
              error: null,
            }),
            metadata: {
              ...latest.metadata,
              featureCount,
            },
          });

          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: {
              type: "success",
              message: t("layers.refreshedCount", {
                count: featureCount.toLocaleString(),
              }),
            },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
        if (isIcebergLayer(layer)) {
          // Iceberg layers re-run their stored, row-capped scan. This is the
          // only path that re-reads the table: they are excluded from the
          // interval scheduling below, so `automatic` is never true here.
          const { geojson, featureCount, totalRows, truncated } = await refreshIcebergLayer(layer);
          const latest = useAppStore
            .getState()
            .layers.find((candidate) => candidate.id === layer.id);
          if (!latest) return;

          updateLayer(layer.id, {
            geojson,
            ...setLayerConnectionResult(latest, {
              syncedAt: new Date().toISOString(),
              error: null,
            }),
            metadata: {
              ...latest.metadata,
              featureCount,
              icebergTotalRows: totalRows,
              icebergTruncated: truncated,
            },
          });

          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: {
              type: "success",
              message: truncated
                ? t("layers.refreshedTruncated", {
                    shown: featureCount.toLocaleString(),
                    total: totalRows.toLocaleString(),
                  })
                : t("layers.refreshedCount", {
                    count: featureCount.toLocaleString(),
                  }),
            },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
        if (isLocalFileLayer(layer)) {
          // Local-file vector layers re-read their features from disk (the same
          // conversion the import ran) rather than fetching a URL.
          const { geojson, featureCount } = await reloadLocalFileLayer(layer);
          const latest = useAppStore
            .getState()
            .layers.find((candidate) => candidate.id === layer.id);
          if (!latest) return;

          updateLayer(layer.id, {
            geojson,
            ...setLayerConnectionResult(latest, {
              syncedAt: new Date().toISOString(),
              error: null,
            }),
            metadata: {
              ...latest.metadata,
              featureCount,
            },
          });

          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: {
              type: "success",
              message: t("layers.refreshedCount", {
                count: featureCount.toLocaleString(),
              }),
            },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
        if (isVectorControlRefreshLayer(layer)) {
          // A layer whose restore failed stays in the project but never made it
          // into the control, so reloadLayer cannot find it. Replaying it is
          // what brings such a layer back once the source is reachable again,
          // which is why refresh (manual and automatic) tries that second.
          const info =
            (await reloadVectorControlLayer(layer.id)) ??
            (await replayVectorControlLayerById(layer.id));
          if (!info) {
            // The control is unavailable (panel never opened, or torn down
            // and not yet replayed) or the replay above did not succeed.
            // Automatic ticks fire on a timer the user didn't initiate, so
            // skip silently and clear the transient note instead of surfacing
            // an error every interval until the control comes back.
            if (automatic) {
              setRefreshStatuses((current) => {
                if (!current[layer.id]) return current;
                const next = { ...current };
                delete next[layer.id];
                return next;
              });
              return;
            }
            throw new Error(t("layers.refreshVectorControlError"));
          }
          // reloadLayer fires `layerupdated`, which drives
          // syncVectorLayersToStore to persist the refreshed featureCount (and
          // bounds) into the store. We intentionally don't call updateLayer
          // here: the metadata write is handled by that event, and a second
          // write would risk clobbering the synced values. `info` feeds only
          // the toast below.
          const featureCount = typeof info.featureCount === "number" ? info.featureCount : null;
          const latest = useAppStore
            .getState()
            .layers.find((candidate) => candidate.id === layer.id);
          if (latest) {
            updateLayer(
              layer.id,
              setLayerConnectionResult(latest, {
                syncedAt: new Date().toISOString(),
                error: null,
              }),
            );
          }
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: {
              type: "success",
              message:
                featureCount === null
                  ? t("layers.refreshed")
                  : t("layers.refreshedCount", {
                      count: featureCount.toLocaleString(),
                    }),
            },
          }));
          scheduleStatusClear(layer.id);
          return;
        }
        const {
          geojson,
          featureCount,
          metadata: refreshedMetadata,
        } = await refreshGeoJsonLayer(layer);
        const latest = useAppStore.getState().layers.find((candidate) => candidate.id === layer.id);
        if (!latest) return;

        updateLayer(layer.id, {
          geojson,
          ...setLayerConnectionResult(latest, {
            syncedAt: new Date().toISOString(),
            error: null,
          }),
          metadata: {
            ...latest.metadata,
            featureCount,
            // Source kinds whose refresh recomputes more than the count (an OGC
            // API - Features layer's numberMatched/truncated) patch it here.
            ...refreshedMetadata,
          },
        });

        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: {
            type: "success",
            message: t("layers.refreshedCount", {
              count: featureCount.toLocaleString(),
            }),
          },
        }));
        scheduleStatusClear(layer.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : t("layers.refreshError");
        const latest = useAppStore.getState().layers.find((candidate) => candidate.id === layer.id);
        if (latest) {
          updateLayer(layer.id, {
            ...setLayerConnectionResult(latest, { error: message }),
            ...(latest.connection?.onFailure === "clear" &&
            latest.geojson &&
            !arcGISLayerHasPendingEdits(latest.id)
              ? {
                  geojson: { type: "FeatureCollection" as const, features: [] },
                }
              : {}),
          });
        }
        setRefreshStatuses((current) => ({
          ...current,
          [layer.id]: {
            type: "error",
            message,
          },
        }));
        scheduleStatusClear(layer.id);
      } finally {
        refreshingLayerIdsRef.current.delete(layer.id);
      }
    },
    [clearRefreshStatusTimer, scheduleStatusClear, t, updateLayer],
  );

  // Read through a ref inside interval callbacks so long-lived timers never
  // capture a stale handleRefreshLayer closure.
  const handleRefreshLayerRef = useRef(handleRefreshLayer);
  useEffect(() => {
    handleRefreshLayerRef.current = handleRefreshLayer;
  }, [handleRefreshLayer]);

  // Drop the status notes (and their fade timers) of layers that were removed.
  useEffect(() => {
    const layerIds = new Set(layers.map((layer) => layer.id));
    for (const id of refreshStatusTimersRef.current.keys()) {
      if (!layerIds.has(id)) clearRefreshStatusTimer(id);
    }
    setRefreshStatuses((current) => {
      let changed = false;
      const next = { ...current };
      for (const id of Object.keys(next)) {
        if (!layerIds.has(id)) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [clearRefreshStatusTimer, layers]);

  useEffect(() => {
    const activeLayerIds = new Set<string>();

    for (const layer of layers) {
      const config = getLayerRefreshConfig(layer);
      if (!config.enabled || !isRefreshableLayer(layer) || !supportsAutoRefresh(layer)) continue;

      activeLayerIds.add(layer.id);
      const existing = refreshTimersRef.current.get(layer.id);
      if (existing?.intervalMs === config.intervalMs) continue;

      if (existing) window.clearInterval(existing.timer);
      const timer = window.setInterval(() => {
        if (document.hidden) return;
        const latest = useAppStore.getState().layers.find((candidate) => candidate.id === layer.id);
        if (!latest) return;

        const latestConfig = getLayerRefreshConfig(latest);
        if (!latestConfig.enabled || !isRefreshableLayer(latest)) return;
        if (!supportsAutoRefresh(latest)) return;
        void handleRefreshLayerRef.current(latest, true);
      }, config.intervalMs);

      refreshTimersRef.current.set(layer.id, {
        intervalMs: config.intervalMs,
        timer,
      });
    }

    for (const [id, entry] of refreshTimersRef.current) {
      if (activeLayerIds.has(id)) continue;
      window.clearInterval(entry.timer);
      refreshTimersRef.current.delete(id);
    }
  }, [layers]);

  // Timers pause while the tab is hidden. On return, immediately catch up any
  // connection whose last successful sync is older than its configured cadence.
  useEffect(() => {
    const catchUp = () => {
      if (document.hidden) return;
      const now = Date.now();
      for (const layer of useAppStore.getState().layers) {
        const config = getLayerRefreshConfig(layer);
        if (!config.enabled || !isRefreshableLayer(layer) || !supportsAutoRefresh(layer)) continue;
        const lastSynced = layer.connection?.lastSyncedAt
          ? new Date(layer.connection.lastSyncedAt).getTime()
          : 0;
        if (!Number.isFinite(lastSynced) || now - lastSynced >= config.intervalMs) {
          void handleRefreshLayerRef.current(layer, true);
        }
      }
    };
    document.addEventListener("visibilitychange", catchUp);
    catchUp();
    return () => document.removeEventListener("visibilitychange", catchUp);
  }, [projectGeneration]);

  // Watch-mode lifecycle: for each local-file layer with watch enabled, register
  // a debounced filesystem watcher that reloads the layer when the file changes.
  // Only runs on the desktop host (the browser cannot watch a local path).
  useEffect(() => {
    if (!isTauri()) return;
    const activeLayerIds = new Set<string>();

    for (const layer of layers) {
      if (!isLocalFileLayer(layer) || !getLayerWatchConfig(layer).enabled) {
        continue;
      }
      const path = layer.sourcePath;
      if (typeof path !== "string" || !path) continue;

      activeLayerIds.add(layer.id);
      const existing = watchUnsubsRef.current.get(layer.id);
      // Already watching this exact path (or a start is in flight for it).
      if (existing?.path === path) continue;
      if (existing) existing.unwatch();

      // `watch()` resolves asynchronously; the effect may re-run or unmount
      // before it does. Record a placeholder whose `unwatch` flips `cancelled`
      // so a watcher that lands after teardown is torn down immediately, and so
      // a concurrent effect run sees the path as already handled.
      let cancelled = false;
      watchUnsubsRef.current.set(layer.id, {
        path,
        unwatch: () => {
          cancelled = true;
        },
      });

      // The stock fs-plugin `watch()` is subject to the fs runtime scope, so it
      // only covers paths granted this session via a picker/drag-drop (persisted
      // by tauri-plugin-persisted-scope) — the common case for a file the user
      // just added. Unlike "Reload from disk" (which falls back to the
      // scope-bypassing `read_local_file` command), watching a project-reopened
      // path that was never picked on this install can be scope-denied; that
      // surfaces as the `watchError` status below rather than silently doing
      // nothing. A scope-bypassing Rust watcher would be the follow-up if that
      // case proves common.
      void import("@tauri-apps/plugin-fs")
        .then(({ watch }) =>
          watch(
            path,
            () => {
              const latest = useAppStore
                .getState()
                .layers.find((candidate) => candidate.id === layer.id);
              if (!latest || !getLayerWatchConfig(latest).enabled) return;
              void handleRefreshLayerRef.current(latest, true);
            },
            // Debounce a burst of write events (a rewrite is rarely one event)
            // into a single reload.
            { delayMs: 400 },
          ),
        )
        .then((unwatch) => {
          if (cancelled) {
            unwatch();
            return;
          }
          watchUnsubsRef.current.set(layer.id, { path, unwatch });
        })
        .catch((error) => {
          // Only act if this attempt is still the live one. If it was cancelled
          // (watch toggled off, or off-then-on so a newer attempt now owns this
          // layer id), deleting the map entry would drop the newer attempt's
          // watcher and show a spurious error while watching is actually active.
          if (cancelled) return;
          watchUnsubsRef.current.delete(layer.id);
          console.warn(`[GeoLibre] Could not watch "${path}" for changes.`, error);
          setRefreshStatuses((current) => ({
            ...current,
            [layer.id]: {
              type: "error",
              message: t("layers.watchError"),
            },
          }));
          scheduleStatusClear(layer.id);
        });
    }

    for (const [id, entry] of watchUnsubsRef.current) {
      if (activeLayerIds.has(id)) continue;
      entry.unwatch();
      watchUnsubsRef.current.delete(id);
    }
  }, [layers, scheduleStatusClear, t]);

  useEffect(() => {
    const watchers = watchUnsubsRef.current;
    const refreshTimers = refreshTimersRef.current;
    const refreshStatusTimers = refreshStatusTimersRef.current;
    return () => {
      for (const entry of watchers.values()) {
        entry.unwatch();
      }
      watchers.clear();
      for (const entry of refreshTimers.values()) {
        window.clearInterval(entry.timer);
      }
      refreshTimers.clear();
      for (const timer of refreshStatusTimers.values()) {
        window.clearTimeout(timer);
      }
      refreshStatusTimers.clear();
    };
  }, []);

  const setRefreshInterval = useCallback(
    (layer: GeoLibreLayer, intervalMs: number) => {
      // Read the latest layer from the store so a concurrent refresh's
      // metadata (e.g. featureCount) is not overwritten by a stale snapshot.
      const latest =
        useAppStore.getState().layers.find((candidate) => candidate.id === layer.id) ?? layer;
      updateLayer(
        layer.id,
        setLayerRefreshConfig(latest, {
          enabled: intervalMs > 0,
          intervalMs,
        }),
      );
    },
    [updateLayer],
  );

  const setRefreshFailurePolicy = useCallback(
    (layer: GeoLibreLayer, onFailure: "keep-last" | "clear") => {
      const latest =
        useAppStore.getState().layers.find((candidate) => candidate.id === layer.id) ?? layer;
      const config = getLayerRefreshConfig(latest);
      updateLayer(layer.id, {
        ...setLayerRefreshConfig(latest, config),
        connection: {
          layerId: layer.id,
          interval: config.enabled ? config.intervalMs / 1000 : null,
          lastSyncedAt: latest.connection?.lastSyncedAt ?? null,
          lastError: latest.connection?.lastError ?? null,
          onFailure,
        },
      });
    },
    [updateLayer],
  );

  const toggleWatchLayer = useCallback(
    (layer: GeoLibreLayer, enabled: boolean) => {
      // Read the latest layer so a concurrent reload's metadata is not
      // overwritten by a stale snapshot (mirrors setRefreshInterval).
      const latest =
        useAppStore.getState().layers.find((candidate) => candidate.id === layer.id) ?? layer;
      updateLayer(layer.id, setLayerWatchConfig(latest, enabled));
    },
    [updateLayer],
  );

  return {
    refreshStatuses,
    setRefreshStatuses,
    clearRefreshStatusTimer,
    scheduleStatusClear,
    handleRefreshLayer,
    setRefreshInterval,
    setRefreshFailurePolicy,
    toggleWatchLayer,
  };
}

/** The refresh state and handlers {@link useLayerRefresh} returns. */
export type LayerRefresh = ReturnType<typeof useLayerRefresh>;
