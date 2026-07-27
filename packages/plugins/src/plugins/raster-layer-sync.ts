import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, styleValue, useAppStore } from "@geolibre/core";
import type { RasterLayerInfo, RasterLayerState, RenderEngine } from "maplibre-gl-raster";

export const RASTER_SOURCE_KIND = "maplibre-gl-raster";

// Absolute filesystem paths of File-backed rasters, by raster id. The control
// only ever sees a browser `File` -- the desktop host reads the bytes off disk
// and wraps them -- so the path that would let a saved project reload the
// raster is not recoverable from `RasterLayerInfo`. Hosts that opened the file
// by path record it here, and it is mirrored onto the store layer as
// `metadata.localFilePath` so it survives into the project file (issue #1463).
const localRasterPaths = new Map<string, string>();

/**
 * Record (or, with `undefined`, forget) the absolute path a File-backed raster
 * was read from, so a saved project can reload it. Callers that only have a
 * browser `File` (a web drag-and-drop, a tool output) pass nothing and the
 * raster stays unrestorable, as before.
 *
 * @param id - The raster/store layer id.
 * @param path - The absolute filesystem path, or undefined to forget it.
 */
export function rememberLocalRasterPath(id: string, path: string | undefined): void {
  if (path) localRasterPaths.set(id, path);
  else localRasterPaths.delete(id);
}

/**
 * The absolute path recorded for a File-backed raster, if any.
 *
 * @param id - The raster/store layer id.
 * @returns The path, or undefined when the raster was not opened by path.
 */
export function localRasterPath(id: string): string | undefined {
  return localRasterPaths.get(id);
}

/**
 * The slice of the maplibre-gl-raster RasterControl surface the store sync
 * drives. Structural (rather than the concrete class) so tests can pass
 * fakes without touching deck.gl or a real map.
 */
export type RasterSyncableControl = {
  getState?: () => { collapsed: boolean };
  getRasters: () => RasterLayerInfo[];
  removeRaster: (id: string) => void;
  setRasterState: (id: string, patch: Partial<RasterLayerState>) => void;
  setVisible: (id: string, visible: boolean) => void;
};

export type RasterSyncOptions = {
  interleaved?: boolean;
  /**
   * The control's active rendering backend. `maplibre-gl-raster` draws through
   * a deck.gl overlay; the other two add a real MapLibre raster source/layer
   * whose layer id is the raster id. Defaults to the deck.gl engine so callers
   * that predate the option keep their behavior.
   */
  engine?: RenderEngine;
};

/**
 * Whether an engine renders through a native MapLibre raster layer (rather than
 * a deck.gl overlay). Those layers carry a real style layer id, so layer-sync
 * can move them for ordering in every runtime -- including the desktop build,
 * where the deck.gl overlay is a separate stacked canvas with no style layer at
 * all (issue #1463).
 */
export function rendersNativeMapLibreLayer(engine: RenderEngine): boolean {
  return engine === "cog-tiler-wasm" || engine === "titiler";
}

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
    layer.metadata.sourceKind === RASTER_SOURCE_KIND && layer.metadata.externalNativeLayer === true
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
 * @param panelCollapsed - Whether the Add Raster Layer panel is collapsed.
 * @returns The corresponding GeoLibre store layer.
 */
export function createRasterStoreLayer(
  info: RasterLayerInfo,
  panelCollapsed = true,
  options: RasterSyncOptions = {},
): GeoLibreLayer {
  const interleaved = options.interleaved ?? true;
  const nativeMapLibreLayer = rendersNativeMapLibreLayer(options.engine ?? "maplibre-gl-raster");
  const url = info.source.kind === "url" ? info.source.url : undefined;
  // The control retains a File-backed raster's original bytes behind a blob
  // URL (source.objectUrl). Surface it as metadata.localBytesUrl so in-browser
  // tools (the WASM Whitebox runner, the symbology stats reader, raster export)
  // can read the bytes back. This covers every File-add path - drag-and-drop,
  // the Add Data > Raster Layer panel's own drop zone, and tool outputs - since
  // they all funnel through the control's addRaster.
  const localBytesUrl = info.source.kind === "file" ? info.source.objectUrl : undefined;
  // Only meaningful for a File-backed raster: a URL raster already restores
  // from source.url, and the path registry is never populated for one.
  const localFilePath = info.source.kind === "file" ? localRasterPaths.get(info.id) : undefined;
  const sourcePath = url ?? (info.source.kind === "file" ? info.source.fileName : info.id);
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
      // Not literally a deck.gl layer under the WASM/TiTiler engines, but the
      // flag is what makes layer-sync forward the computed beforeId to the
      // control (applyRasterLayerOrder -> setRasterBeforeId). Those engines
      // re-apply their own moveLayer on every render-setting change, so without
      // it a later opacity edit would silently pull the raster back to the top.
      externalDeckLayer: true,
      externalNativeLayer: true,
      identifiable: false,
      // The WASM/TiTiler engines add a native MapLibre raster layer keyed by
      // the raster id, in every runtime. With the deck.gl engine there is a
      // style layer id only in interleaved mode, where the overlay inserts one
      // custom style layer per raster; the Tauri/WebKit fallback uses a
      // separate deck.gl canvas, so there is no MapLibre style layer to sync.
      nativeLayerIds: nativeMapLibreLayer || interleaved ? [info.id] : [],
      panelCollapsed,
      rasterOverlayMode: nativeMapLibreLayer ? "native" : interleaved ? "interleaved" : "overlaid",
      // The visualization state is persisted so restoreRasterLayers can
      // replay URL-backed rasters when a saved project is reopened.
      rasterSource: info.source.kind,
      rasterState: serializableRasterState(info.state),
      // Band metadata powers the symbology panel's band / RGB pickers. Known
      // only once the GeoTIFF header loads (null until then). The Map is
      // serialized to pairs so the store / project JSON and the deep-equal
      // diff below can compare it.
      bandCount: info.bandCount,
      bandNames: serializeBandNames(info.bandNames),
      sourceIds: [],
      sourceKind: RASTER_SOURCE_KIND,
      ...(localBytesUrl ? { localBytesUrl } : {}),
      // Persisted so restoreRasterLayers can re-read the file when the project
      // is reopened on the machine that holds it (desktop only -- the browser
      // has no path). Absent for a raster added from a browser File.
      ...(localFilePath ? { localFilePath } : {}),
      ...(info.bounds
        ? {
            bounds: [info.bounds.west, info.bounds.south, info.bounds.east, info.bounds.north],
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
  syncRasterLayersToStoreWithOptions(control);
}

/**
 * Metadata keys GeoLibre writes onto control-managed raster layers that the
 * control itself knows nothing about: `rasterSymbology` (discrete
 * classification), `rasterAttributeTable` (the categorical class table,
 * #1307), and `localBytesUrl` (a blob URL retaining a File-loaded raster's
 * bytes for in-browser tools). The store sync rebuilds a raster layer's
 * metadata wholesale from the control's `RasterLayerInfo` on every control
 * event, so any key not listed here is silently wiped by the next opacity
 * drag or visibility toggle — add new GeoLibre-owned raster metadata keys to
 * this list.
 */
export const GEOLIBRE_OWNED_METADATA_KEYS = [
  "rasterSymbology",
  "rasterAttributeTable",
  "localBytesUrl",
] as const;

export function syncRasterLayersToStoreWithOptions(
  control: RasterSyncableControl,
  options: RasterSyncOptions = {},
): void {
  if (isRasterStoreSyncSuspended()) return;

  const infos = control.getRasters();
  const infoIds = new Set(infos.map((info) => info.id));
  const panelCollapsed = rasterPanelCollapsedFromControl(control);

  syncingLayersToStore = true;
  try {
    for (const storeLayer of useAppStore.getState().layers) {
      if (!isRasterControlStoreLayer(storeLayer)) continue;
      if (!infoIds.has(storeLayer.id)) {
        useAppStore.getState().removeLayer(storeLayer.id);
      }
    }

    for (const info of infos) {
      const layer = createRasterStoreLayer(info, panelCollapsed, options);
      const existing = useAppStore.getState().layers.find((current) => current.id === layer.id);

      if (!existing) {
        useAppStore.getState().addLayer(layer);
        continue;
      }

      // GeoLibre-owned metadata keys (see GEOLIBRE_OWNED_METADATA_KEYS) are
      // absent from RasterLayerInfo, so carry them forward across the
      // wholesale metadata rebuild instead of letting every control event
      // wipe them.
      const preserved: Record<string, unknown> = {};
      for (const key of GEOLIBRE_OWNED_METADATA_KEYS) {
        if (existing.metadata[key] !== undefined) {
          preserved[key] = existing.metadata[key];
        }
      }
      const metadata =
        Object.keys(preserved).length > 0 ? { ...layer.metadata, ...preserved } : layer.metadata;

      if (
        existing.visible !== layer.visible ||
        existing.opacity !== layer.opacity ||
        existing.sourcePath !== layer.sourcePath ||
        !recordsEqual(existing.source, layer.source) ||
        !recordsEqual(existing.metadata, metadata)
      ) {
        useAppStore.getState().updateLayer(layer.id, {
          // Replace metadata wholesale so stale keys (error, bounds) cannot
          // survive a raster being swapped out under the same id.
          metadata,
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
        const patch = rasterStatePatch(layer, current);
        if (patch) activeControl.setRasterState(layer.id, patch);
        const zoomPatch = zoomRangePatch(layer, current);
        if (zoomPatch) activeControl.setRasterState(layer.id, zoomPatch);
      }
    });
  });
}

// The rasterState fields the symbology panel edits and pushes back to the
// control. opacity/visible are handled above (they live on top-level layer
// fields); these live in metadata.rasterState.
const SYNCED_RASTER_STATE_KEYS = [
  "mode",
  "bands",
  "index",
  "colormap",
  "reversed",
  "rescale",
  "nodata",
  "stretch",
  "gamma",
] as const;

/**
 * Diffs the editable rasterState fields between two store snapshots of the
 * same layer and returns the changed subset to push through setRasterState,
 * or null when nothing relevant changed.
 *
 * @param previous - The prior store layer.
 * @param current - The current store layer.
 * @returns A partial RasterLayerState patch, or null.
 */
function rasterStatePatch(
  previous: GeoLibreLayer,
  current: GeoLibreLayer,
): Partial<RasterLayerState> | null {
  const before = rasterStateRecord(previous);
  const after = rasterStateRecord(current);
  const patch: Record<string, unknown> = {};
  let changed = false;
  for (const key of SYNCED_RASTER_STATE_KEYS) {
    if (!valuesEqual(before[key], after[key])) {
      patch[key] = after[key];
      changed = true;
    }
  }
  return changed ? (patch as Partial<RasterLayerState>) : null;
}

/**
 * Diffs a raster layer's min/max zoom between two store snapshots and returns
 * the range to push through setRasterState, or null when unchanged.
 *
 * The zoom-range control lives on `layer.style` (the shared Style-panel widget),
 * not in `metadata.rasterState`, so it is diffed separately from the symbology
 * fields. A control-managed COG is an external custom layer, so layer-sync skips
 * the native `map.setLayerZoomRange` path for it; the range reaches the raster
 * only through this bridge.
 *
 * @param previous - The prior store layer.
 * @param current - The current store layer.
 * @returns A `{ minZoom, maxZoom }` patch, or null.
 */
function zoomRangePatch(
  previous: GeoLibreLayer,
  current: GeoLibreLayer,
): Partial<RasterLayerState> | null {
  const beforeMin = styleValue(previous.style, "minZoom");
  const beforeMax = styleValue(previous.style, "maxZoom");
  const afterMin = styleValue(current.style, "minZoom");
  const afterMax = styleValue(current.style, "maxZoom");
  if (beforeMin === afterMin && beforeMax === afterMax) return null;
  return { minZoom: afterMin, maxZoom: afterMax };
}

function rasterStateRecord(layer: GeoLibreLayer): Record<string, unknown> {
  const raw = layer.metadata.rasterState;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function serializeBandNames(bandNames: Map<number, string> | null): [number, string][] | null {
  return bandNames ? [...bandNames.entries()] : null;
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
 *
 * Deliberately NOT called from the control's onRemove teardown: the control
 * is removed on map reinitialisation, where the store layers must survive
 * so restoreRasterLayers can replay them into the successor control.
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
export function savedRasterState(layer: GeoLibreLayer): Partial<RasterLayerState> {
  const raw = layer.metadata.rasterState;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const candidate = raw as Record<string, unknown>;
  const state: Partial<RasterLayerState> = {};

  if (candidate.mode === "rgb" || candidate.mode === "single" || candidate.mode === "index") {
    state.mode = candidate.mode;
  }
  // The normalized-difference preset id (index mode). The control tolerates
  // unknown ids (falls back to the first preset), so no allowlist here.
  if (typeof candidate.index === "string" && candidate.index) {
    state.index = candidate.index;
  }
  if (
    Array.isArray(candidate.bands) &&
    candidate.bands.length > 0 &&
    candidate.bands.every((band) => typeof band === "number" && Number.isInteger(band) && band > 0)
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
          range.every((value) => typeof value === "number" && Number.isFinite(value)),
      ))
  ) {
    state.rescale = candidate.rescale as [number, number][] | null;
  }
  // The valid names are a runtime property of maplibre-gl-raster (90+
  // colormaps), so no allowlist here; the control tolerates unknown names
  // (addRaster does not validate them and rendering falls back) rather
  // than throwing on restore.
  if (typeof candidate.colormap === "string" && candidate.colormap) {
    state.colormap = candidate.colormap;
  }
  if (typeof candidate.reversed === "boolean") {
    state.reversed = candidate.reversed;
  }
  if (
    candidate.nodata === "off" ||
    candidate.nodata === "auto" ||
    (typeof candidate.nodata === "number" && Number.isFinite(candidate.nodata))
  ) {
    state.nodata = candidate.nodata;
  }
  // Gamma is a power-law exponent; zero and negative values are physically
  // meaningless and could misbehave in the shader.
  if (
    typeof candidate.gamma === "number" &&
    Number.isFinite(candidate.gamma) &&
    candidate.gamma > 0
  ) {
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

function rasterPanelCollapsedFromControl(control: RasterSyncableControl): boolean {
  try {
    const collapsed = control.getState?.().collapsed;
    return typeof collapsed === "boolean" ? collapsed : true;
  } catch (error) {
    // getState is optional, so only a throwing implementation lands here;
    // surface it instead of letting it look like the method being absent.
    console.warn("[GeoLibre] rasterPanelCollapsedFromControl: getState threw", error);
    return true;
  }
}

// Key-order-insensitive deep equality for source/metadata records, matching
// the helper of the same name in maplibre-3d-tiles.ts. JSON.stringify would
// report a difference for semantically equal objects whose keys were built
// in a different order, forcing a spurious updateLayer on every event.
function recordsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!valuesEqual(left[key], right[key])) return false;
  }
  return true;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => valuesEqual(value, right[index]));
  }

  if (isRecord(left) || isRecord(right)) {
    return isRecord(left) && isRecord(right) && recordsEqual(left, right);
  }

  return Object.is(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializableRasterState(state: RasterLayerState): Record<string, unknown> {
  // visible and opacity live on the top-level layer fields (the panel edits
  // them there); persisting copies here would leave two competing values in
  // a saved project file, so they are omitted.
  const { visible: _visible, opacity: _opacity, ...vizState } = state;
  return {
    ...vizState,
    bands: [...state.bands],
    rescale: state.rescale?.map((range) => [...range]) ?? null,
  };
}
