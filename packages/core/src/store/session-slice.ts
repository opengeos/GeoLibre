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
  setAttributeFilter: (filter: string) => void;
}

export const createSessionSlice: SliceCreator<SessionSlice> = (set) => ({
  selectedLayerId: null,
  selectedFeatureId: null,
  selectedFeatureIds: [],
  identifyLayerId: null,
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
  setIdentifyLayer: (id) => set({ identifyLayerId: id }),
  setAttributeFilter: (filter) => set({ attributeFilter: filter }),
});
