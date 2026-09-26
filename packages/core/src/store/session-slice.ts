/**
 * Per-session selection and live readouts: the selected layer and features,
 * the Identify target, the attribute-table filter, and the pointer / camera /
 * GPS readouts the status bar shows. None of it is saved with the project or
 * tracked by undo history.
 */
import type { SliceCreator } from "./types";

/**
 * Latest live device-GPS fix published by the GPS Tracking tool (issue #1316),
 * read by the status bar readout. Device state, not project state: excluded
 * from undo history (partialize never lists it) and from project files, and
 * deliberately left untouched on project switches.
 */
export interface GpsStatusFix {
  lng: number;
  lat: number;
  /** Horizontal accuracy radius in meters. */
  accuracy: number;
  /** Satellites used for the fix, or null when the provider does not report it. */
  satellites: number | null;
  /** Ground speed in m/s, or null when the device doesn't report one. */
  speed: number | null;
  /** Fix time in epoch milliseconds. */
  timestamp: number;
}

/** Reserved Identify target for querying every visible queryable layer at once. */
export const IDENTIFY_ALL_LAYERS_ID = "__geolibre_identify_all_layers__";

/** The Identify fields of the store, as set together by an Identify change. */
export interface IdentifyState {
  identifyLayerId: string | null;
  identifyLayerIds: string[] | null;
}

/**
 * Resolve an Identify target against the layers that exist.
 *
 * Shared by the scripting `setIdentify` command and by project load, which
 * applies a project's saved `interaction.identify` (issue #2688).
 *
 * @param target - A layer id, `"all"`, a list of layer ids, or null/undefined.
 * @param layerIds - Ids of the layers currently in the project.
 * @returns The store fields to set. Ids that name no layer are dropped; a list
 *   that keeps one id becomes a single-layer target, and one that keeps several
 *   becomes the all-layers mode restricted to those ids.
 */
export function resolveIdentifyTarget(
  target: string | readonly string[] | null | undefined,
  layerIds: Iterable<string>,
): IdentifyState {
  const off: IdentifyState = { identifyLayerId: null, identifyLayerIds: null };
  if (target === null || target === undefined) return off;
  if (target === "all") return { identifyLayerId: IDENTIFY_ALL_LAYERS_ID, identifyLayerIds: null };
  const known = new Set(layerIds);
  if (typeof target === "string") {
    return known.has(target) ? { identifyLayerId: target, identifyLayerIds: null } : off;
  }
  const ids = [...new Set(target)].filter((id) => known.has(id));
  if (ids.length === 0) return off;
  if (ids.length === 1) return { identifyLayerId: ids[0], identifyLayerIds: null };
  return { identifyLayerId: IDENTIFY_ALL_LAYERS_ID, identifyLayerIds: ids };
}

/**
 * Whether the all-layers Identify mode may query a layer.
 *
 * @param layerId - The candidate layer's id.
 * @param identifyLayerIds - The store's `identifyLayerIds` restriction.
 * @returns True when there is no restriction or the layer is in it.
 */
export function identifyAllIncludes(
  layerId: string,
  identifyLayerIds: readonly string[] | null | undefined,
): boolean {
  return !identifyLayerIds || identifyLayerIds.includes(layerId);
}

/**
 * Drop removed layers from the Identify state.
 *
 * @param state - The current Identify fields.
 * @param removed - Ids of the layers being removed.
 * @returns The Identify fields with those layers gone. A restricted all-layers
 *   mode left with one layer narrows to it, and with none turns Identify off.
 */
export function identifyStateWithoutLayers(
  state: IdentifyState,
  removed: ReadonlySet<string>,
): IdentifyState {
  if (state.identifyLayerId !== null && removed.has(state.identifyLayerId)) {
    return { identifyLayerId: null, identifyLayerIds: null };
  }
  // Return fresh fields, never `state` itself: callers spread the result into
  // a store update and pass the whole store as `state`.
  const unchanged = {
    identifyLayerId: state.identifyLayerId,
    identifyLayerIds: state.identifyLayerIds,
  };
  if (!state.identifyLayerIds) return unchanged;
  const ids = state.identifyLayerIds.filter((id) => !removed.has(id));
  if (ids.length === state.identifyLayerIds.length) return unchanged;
  if (ids.length === 0) return { identifyLayerId: null, identifyLayerIds: null };
  if (ids.length === 1) return { identifyLayerId: ids[0], identifyLayerIds: null };
  return { identifyLayerId: state.identifyLayerId, identifyLayerIds: ids };
}

export interface SessionSlice {
  selectedLayerId: string | null;
  selectedFeatureId: string | null;
  /**
   * Full set of selected feature ids. The attribute table extends the single
   * selection to many rows via Ctrl/Cmd (toggle) and Shift (range). The anchor
   * — `selectedFeatureId` — is the primary/last-clicked feature used for map
   * fit, DuckDB highlight, and scripting, and is always one of these ids (or
   * `null` when the set is empty). A single click leaves exactly one id here.
   */
  selectedFeatureIds: string[];
  /**
   * Store-layer id targeted by Identify, or {@link IDENTIFY_ALL_LAYERS_ID} for
   * the map-level mode that queries every visible queryable layer — vector,
   * DuckDB query, WMS, COG, NetCDF image and time-slider raster alike.
   */
  identifyLayerId: string | null;
  /**
   * Layers the all-layers Identify mode is limited to, or null for every
   * visible queryable layer. Set only alongside {@link IDENTIFY_ALL_LAYERS_ID},
   * by a script or project that names several layers (issue #2688), and
   * cleared by every `setIdentifyLayer` call so the in-app buttons keep their
   * plain meaning.
   */
  identifyLayerIds: string[] | null;
  pointerCoords: [number, number] | null;
  /**
   * Ground elevation in true metres under the pointer, for the status bar
   * (issue #1813). Null when it cannot be resolved — the pointer is off the
   * map, terrain is off and the remote lookup has not answered (or failed), or
   * the active body is not Earth. Set alongside `pointerCoords` by MapCanvas,
   * which owns the map instance the terrain sample comes from.
   */
  pointerElevation: number | null;
  /**
   * Camera height above sea level in metres — Google Earth Pro's "Eye alt"
   * (issue #1816). Derived from the camera, so deliberately *not* part of
   * `mapView`: that shape is persisted into the project file, and a stored
   * altitude could only drift from the center/zoom/pitch it is computed from.
   * Null before the map loads, or when MapLibre cannot report it.
   */
  cameraAltitude: number | null;
  /** Live GPS fix for the status bar, or null while GPS tracking is off. */
  gpsStatus: GpsStatusFix | null;
  attributeFilter: string;

  setPointerCoords: (coords: [number, number] | null) => void;
  setPointerElevation: (elevation: number | null) => void;
  setCameraAltitude: (altitude: number | null) => void;
  setGpsStatus: (fix: GpsStatusFix | null) => void;
  selectLayer: (id: string | null) => void;
  selectFeature: (id: string | null) => void;
  /**
   * Replace the multi-selection with `ids`. The anchor (`selectedFeatureId`)
   * becomes `anchorId` when provided, otherwise the last id in the list (or
   * `null` when the list is empty).
   */
  selectFeatures: (ids: string[], anchorId?: string | null) => void;
  setIdentifyLayer: (id: string | null) => void;
  /** Set both Identify fields at once (see {@link resolveIdentifyTarget}). */
  setIdentifyState: (state: IdentifyState) => void;
  setAttributeFilter: (filter: string) => void;
}

export const createSessionSlice: SliceCreator<SessionSlice> = (set) => ({
  selectedLayerId: null,
  selectedFeatureId: null,
  selectedFeatureIds: [],
  identifyLayerId: null,
  identifyLayerIds: null,
  pointerCoords: null,
  pointerElevation: null,
  cameraAltitude: null,
  gpsStatus: null,
  attributeFilter: "",

  setPointerCoords: (coords) =>
    set(coords ? { pointerCoords: coords } : { pointerCoords: null, pointerElevation: null }),
  setPointerElevation: (elevation) => set({ pointerElevation: elevation }),
  setCameraAltitude: (altitude) => set({ cameraAltitude: altitude }),
  setGpsStatus: (fix) => set({ gpsStatus: fix }),

  selectLayer: (id) =>
    set({
      selectedLayerId: id,
      selectedFeatureId: null,
      selectedFeatureIds: [],
    }),
  // `""` is a valid feature id; only `null` clears the selection.
  selectFeature: (id) =>
    set({ selectedFeatureId: id, selectedFeatureIds: id === null ? [] : [id] }),
  selectFeatures: (ids, anchorId) =>
    set({
      selectedFeatureIds: ids,
      // Enforce the documented invariant for every caller: the anchor is
      // always a member of the set (or null when empty). A supplied anchor
      // that isn't in `ids` falls back to the last id rather than pointing
      // the map fit / calculator sample at an unselected feature.
      selectedFeatureId:
        anchorId != null && ids.includes(anchorId) ? anchorId : (ids.at(-1) ?? null),
    }),
  setIdentifyLayer: (id) => set({ identifyLayerId: id, identifyLayerIds: null }),
  setIdentifyState: ({ identifyLayerId, identifyLayerIds }) =>
    set({ identifyLayerId, identifyLayerIds }),
  setAttributeFilter: (filter) => set({ attributeFilter: filter }),
});
