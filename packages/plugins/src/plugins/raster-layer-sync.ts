import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import type { RasterLayerInfo, RasterLayerState } from "maplibre-gl-raster";

export const RASTER_SOURCE_KIND = "maplibre-gl-raster";

/**
 * The slice of the maplibre-gl-raster RasterControl surface the store sync
 * drives. Structural (rather than the concrete class) so tests can pass
 * fakes without touching deck.gl or a real map.
 */
export type RasterSyncableControl = {
  getRasters: () => RasterLayerInfo[];
  removeRaster: (id: string) => void;
  setRasterState: (id: string, patch: Partial<RasterLayerState>) => void;
  setVisible: (id: string, visible: boolean) => void;
};

let syncedControl: RasterSyncableControl | null = null;
let storeUnsubscribe: (() => void) | null = null;
// Guards the store subscriber against re-entrancy: store mutations made by
// syncRasterLayersToStore fire the subscriber synchronously, which would
// otherwise echo removeRaster calls back at the control for layers it
// already dropped from its own list.
let syncingLayersToStore = false;
// Suspends event-driven control->store syncs while this module itself is
// mutating the control (store->control pushes, project restore). The
// control emits raster* events synchronously from those calls, and syncing
// mid-mutation would observe a partially updated layer list.
let storeSyncSuspended = 0;

/**
 * Detects a layer panel entry owned by the maplibre-gl-raster control.
 *
 * @param layer - A store layer.
 * @returns True when the layer mirrors a control-managed raster.
 */
export function isRasterControlStoreLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.metadata.sourceKind === RASTER_SOURCE_KIND &&
    layer.metadata.externalNativeLayer === true
  );
}

/**
 * Builds the store layer mirroring a control raster snapshot.
 *
 * The deck.gl COGLayer renders through the control's shared overlay, so the
 * store layer registers as an external custom layer: layer-sync manages
 * ordering only, and wireRasterStoreSync applies panel visibility/opacity
 * back through the control API.
 *
 * @param info - Public raster snapshot from RasterControl.getRasters().
 * @returns The corresponding GeoLibre store layer.
 */
export function createRasterStoreLayer(info: RasterLayerInfo): GeoLibreLayer {
  const url = info.source.kind === "url" ? info.source.url : undefined;
  const sourcePath =
    url ?? (info.source.kind === "file" ? info.source.fileName : info.id);
  return {
    id: info.id,
    name: info.name,
    type: "cog",
    source: {
      type: "raster",
      ...(url ? { url } : {}),
    },
    visible: info.state.visible,
    opacity: info.state.opacity,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "raster",
      externalNativeLayer: true,
      identifiable: false,
      // In interleaved mode the deck.gl overlay inserts one custom style
      // layer per raster, keyed by the raster id, so ordering moves reach it.
      nativeLayerIds: [info.id],
      // The visualization state is persisted so restoreRasterLayers can
      // replay URL-backed rasters when a saved project is reopened.
      rasterSource: info.source.kind,
      rasterState: serializableRasterState(info.state),
      sourceIds: [],
      sourceKind: RASTER_SOURCE_KIND,
      ...(info.bounds
        ? {
            bounds: [
              info.bounds.west,
              info.bounds.south,
              info.bounds.east,
              info.bounds.north,
            ],
          }
        : {}),
      ...(info.error ? { error: info.error.message } : {}),
    },
    sourcePath,
  };
}

/**
 * Diffs the control's raster list into the app store so the layer panel
 * lists control-managed rasters. Adds new rasters, drops store layers whose
 * rasters are gone, and refreshes changed fields on existing layers. The
 * name is only seeded on creation so panel renames survive later syncs.
 *
 * @param control - The raster control to mirror.
 */
export function syncRasterLayersToStore(control: RasterSyncableControl): void {
  if (isRasterStoreSyncSuspended()) return;

  const infos = control.getRasters();
  const infoIds = new Set(infos.map((info) => info.id));

  syncingLayersToStore = true;
  try {
    for (const storeLayer of useAppStore.getState().layers) {
      if (!isRasterControlStoreLayer(storeLayer)) continue;
      if (!infoIds.has(storeLayer.id)) {
        useAppStore.getState().removeLayer(storeLayer.id);
      }
    }

    for (const info of infos) {
      const layer = createRasterStoreLayer(info);
      const existing = useAppStore
        .getState()
        .layers.find((current) => current.id === layer.id);

      if (!existing) {
        useAppStore.getState().addLayer(layer);
        continue;
      }

      if (
        existing.visible !== layer.visible ||
        existing.opacity !== layer.opacity ||
        existing.sourcePath !== layer.sourcePath ||
        JSON.stringify(existing.source) !== JSON.stringify(layer.source) ||
        JSON.stringify(existing.metadata) !== JSON.stringify(layer.metadata)
      ) {
        useAppStore.getState().updateLayer(layer.id, {
          // Replace metadata wholesale so stale keys (error, bounds) cannot
          // survive a raster being swapped out under the same id.
          metadata: layer.metadata,
          opacity: layer.opacity,
          source: layer.source,
          sourcePath: layer.sourcePath,
          visible: layer.visible,
        });
      }
    }
  } finally {
    syncingLayersToStore = false;
  }
}

/**
 * Watches the store for panel-side changes to control-managed rasters.
 * Removing a layer in the panel drops the control's raster, and visibility
 * and opacity edits are applied through the control API because the deck.gl
 * custom layers skip the generic paint sync in layer-sync.
 *
 * Subscribes once; later calls point the sync at the latest control
 * instance.
 *
 * @param control - The raster control to receive store changes.
 */
export function wireRasterStoreSync(control: RasterSyncableControl): void {
  syncedControl = control;
  storeUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const activeControl = syncedControl;
    if (
      !activeControl ||
      syncingLayersToStore ||
      isRasterStoreSyncSuspended() ||
      state.layers === previous.layers
    ) {
      return;
    }

    // The subscriber fires on every layers change; skip the per-layer scan
    // when the previous snapshot held no control-managed rasters at all.
    if (!previous.layers.some(isRasterControlStoreLayer)) return;

    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));
    runWithRasterStoreSyncSuspended(() => {
      for (const layer of previous.layers) {
        if (!isRasterControlStoreLayer(layer)) continue;

        const current = currentById.get(layer.id);
        if (!current) {
          activeControl.removeRaster(layer.id);
          continue;
        }

        if (current.visible !== layer.visible) {
          activeControl.setVisible(layer.id, current.visible);
        }
        if (current.opacity !== layer.opacity) {
          activeControl.setRasterState(layer.id, { opacity: current.opacity });
        }
      }
    });
  });
}

/**
 * Stops the store subscription and forgets the synced control. Used when
 * the control is removed from the map.
 */
export function unwireRasterStoreSync(): void {
  storeUnsubscribe?.();
  storeUnsubscribe = null;
  syncedControl = null;
}

/**
 * Removes every control-managed raster layer from the store, without
 * echoing the removals back at the control.
 */
export function removeRasterStoreLayers(): void {
  syncingLayersToStore = true;
  try {
    for (const layer of useAppStore.getState().layers) {
      if (isRasterControlStoreLayer(layer)) {
        useAppStore.getState().removeLayer(layer.id);
      }
    }
  } finally {
    syncingLayersToStore = false;
  }
}

/**
 * Runs a callback with event-driven control->store syncing (and the
 * store->control subscriber) suspended. Used around control mutations whose
 * intermediate states must not be mirrored.
 *
 * @param callback - The mutation to run while suspended.
 * @returns The callback's return value.
 */
export function runWithRasterStoreSyncSuspended<T>(callback: () => T): T {
  storeSyncSuspended += 1;
  try {
    return callback();
  } finally {
    storeSyncSuspended -= 1;
  }
}

/**
 * Whether sync suppression is currently active.
 *
 * @returns True while runWithRasterStoreSyncSuspended is executing.
 */
export function isRasterStoreSyncSuspended(): boolean {
  return storeSyncSuspended > 0;
}

/**
 * Clears the suspension counter. Called on control teardown so a control
 * torn down mid-restore cannot leave its successor permanently suppressing
 * store sync events.
 */
export function resetRasterStoreSyncSuspension(): void {
  storeSyncSuspended = 0;
}

/**
 * Reads the persisted visualization state from a store layer's metadata,
 * keeping only well-formed fields so a hand-edited project file cannot
 * crash the control.
 *
 * @param layer - A store layer created by createRasterStoreLayer.
 * @returns The state overrides to replay through RasterControl.addRaster.
 */
export function savedRasterState(
  layer: GeoLibreLayer,
): Partial<RasterLayerState> {
  const raw = layer.metadata.rasterState;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const candidate = raw as Record<string, unknown>;
  const state: Partial<RasterLayerState> = {};

  if (candidate.mode === "rgb" || candidate.mode === "single") {
    state.mode = candidate.mode;
  }
  if (
    Array.isArray(candidate.bands) &&
    candidate.bands.length > 0 &&
    candidate.bands.every(
      (band) => typeof band === "number" && Number.isInteger(band) && band > 0,
    )
  ) {
    state.bands = candidate.bands as number[];
  }
  // null is the control's "auto rescale from stats" state and round-trips
  // explicitly; an empty array is not a meaningful rescale value.
  if (
    candidate.rescale === null ||
    (Array.isArray(candidate.rescale) &&
      candidate.rescale.length > 0 &&
      candidate.rescale.every(
        (range) =>
          Array.isArray(range) &&
          range.length === 2 &&
          range.every(
            (value) => typeof value === "number" && Number.isFinite(value),
          ),
      ))
  ) {
    state.rescale = candidate.rescale as [number, number][] | null;
  }
  if (typeof candidate.colormap === "string" && candidate.colormap) {
    state.colormap = candidate.colormap;
  }
  if (
    candidate.nodata === "off" ||
    candidate.nodata === "auto" ||
    (typeof candidate.nodata === "number" && Number.isFinite(candidate.nodata))
  ) {
    state.nodata = candidate.nodata;
  }
  if (typeof candidate.gamma === "number" && Number.isFinite(candidate.gamma)) {
    state.gamma = candidate.gamma;
  }
  if (
    candidate.stretch === "linear" ||
    candidate.stretch === "log" ||
    candidate.stretch === "sqrt"
  ) {
    state.stretch = candidate.stretch;
  }

  return state;
}

function serializableRasterState(
  state: RasterLayerState,
): Record<string, unknown> {
  return {
    ...state,
    bands: [...state.bands],
    rescale: state.rescale?.map((range) => [...range]) ?? null,
  };
}
