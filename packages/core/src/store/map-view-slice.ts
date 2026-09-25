/**
 * The map workspace: the primary camera, the basemap, project preferences, the
 * multi-map grid and its secondary panes, and which engine draws the primary
 * map. The basemap fields are tracked by undo history; the camera is not.
 */
import { v4 as uuidv4 } from "uuid";
import { createDefaultMapView, normalizeBlankBackgroundColor } from "../project";
import { DEFAULT_ELLIPSOID_ID } from "../ellipsoids";
import type { PlanetaryBasemap } from "../ellipsoids";
import {
  DEFAULT_BASEMAP,
  DEFAULT_MAP_GRID_LAYOUT,
  DEFAULT_PRIMARY_RENDERER,
  DEFAULT_PROJECT_PREFERENCES,
  MAX_MAP_GRID_DIM,
  type MapGridLayout,
  type MapRendererKind,
  type MapViewState,
  type ProjectPreferences,
  type SecondaryMapView,
} from "../types";
import type { AppState, SliceCreator } from "./types";

/** An explicit background choice replaces the active renderer's override. */
function preferencesForBasemap(state: AppState, ellipsoidId = state.preferences.map.ellipsoidId) {
  const clearMapbox =
    state.primaryRenderer === "mapbox" && state.preferences.map.mapboxStyleUrl !== undefined;
  // Any Cesium or ArcGIS pane, not only a primary one: split panes pick the
  // renderer independently, and a pinned globe imagery or Esri style would
  // otherwise ignore the picker.
  const clearCesium =
    state.preferences.map.cesiumBasemap !== "project" &&
    (state.primaryRenderer === "cesium" ||
      state.secondaryMapViews.some((pane) => pane.viewKind === "cesium"));
  const clearArcgis =
    state.preferences.map.arcgisBasemap !== undefined &&
    (state.primaryRenderer === "arcgis" ||
      state.secondaryMapViews.some((pane) => pane.viewKind === "arcgis"));
  if (
    !clearMapbox &&
    !clearCesium &&
    !clearArcgis &&
    ellipsoidId === state.preferences.map.ellipsoidId
  )
    return state.preferences;
  return {
    ...state.preferences,
    map: {
      ...state.preferences.map,
      ...(clearMapbox ? { mapboxStyleUrl: undefined } : {}),
      ...(clearCesium ? { cesiumBasemap: "project" as const } : {}),
      ...(clearArcgis ? { arcgisBasemap: undefined } : {}),
      ellipsoidId,
    },
  };
}

/** True when two camera states have identical center/zoom/bearing/pitch. */
function sameCamera(a: MapViewState, b: MapViewState): boolean {
  return (
    a.center[0] === b.center[0] &&
    a.center[1] === b.center[1] &&
    a.zoom === b.zoom &&
    a.bearing === b.bearing &&
    a.pitch === b.pitch
  );
}

/** Clamp a requested grid row/column count into the supported [1, MAX] range. */
function clampGridDim(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(MAX_MAP_GRID_DIM, Math.floor(value)));
}

/**
 * Pick a grid that holds at least `total` panes within the supported
 * `MAX_MAP_GRID_DIM x MAX_MAP_GRID_DIM` bound, minimizing empty cells first and
 * then preferring a column count close to (and, on ties, no smaller than)
 * `preferredCols` so removing a pane keeps the layout's orientation. Used when
 * collapsing the grid after a pane is removed.
 *
 * Bounding both dimensions matters: a prime `total` (e.g. 5 panes left after
 * removing one from a 2x3 grid) has no gap-free factor pair inside the bound, so
 * the only gap-free options (1x5 / 5x1) would exceed `MAX_MAP_GRID_DIM`. In that
 * case we accept the smallest bounded grid with one empty trailing cell (2x3)
 * rather than returning an out-of-range dimension.
 */
function fitGrid(total: number, preferredCols: number): { rows: number; cols: number } {
  if (total <= 1) return { rows: 1, cols: 1 };
  let best: {
    rows: number;
    cols: number;
    empty: number;
    score: number;
  } | null = null;
  for (let rows = 1; rows <= MAX_MAP_GRID_DIM; rows++) {
    for (let cols = 1; cols <= MAX_MAP_GRID_DIM; cols++) {
      const capacity = rows * cols;
      if (capacity < total) continue;
      const empty = capacity - total;
      const score = Math.abs(cols - preferredCols);
      // Fewest empty cells wins; then the column count closest to
      // preferredCols; then, on a tie, the larger column count (favoring wider,
      // side-by-side layouts over tall ones).
      const better =
        best === null ||
        empty < best.empty ||
        (empty === best.empty &&
          (score < best.score || (score === best.score && cols > best.cols)));
      if (better) best = { rows, cols, empty, score };
    }
  }
  return best ? { rows: best.rows, cols: best.cols } : { rows: 1, cols: 1 };
}

export interface MapViewSlice {
  mapView: MapViewState;
  basemapStyleUrl: string;
  basemapVisible: boolean;
  basemapOpacity: number;
  blankBackgroundColor: string | null;
  preferences: ProjectPreferences;
  /**
   * Multi-map grid layout (issue: split/grid view). A 1x1 grid is the normal
   * single-map workspace. `rows * cols` panes are shown; pane 0 is the primary
   * map driven by `mapView` / `basemap*`, panes 1.. are `secondaryMapViews`.
   */
  mapLayout: MapGridLayout;
  /**
   * Secondary map panes (everything past the primary pane). The store keeps
   * exactly `rows * cols - 1` entries in sync with `mapLayout`.
   */
  secondaryMapViews: SecondaryMapView[];
  /** User-entered label for the primary pane (shown only in multi-map mode). */
  primaryMapLabel: string;
  /**
   * Which engine draws the primary map area (issue #2217): the 2D MapLibre map
   * or the 3D Cesium globe. Both render the same store state, so switching
   * keeps the camera, basemap, layers, groups, visibility, and opacity — it
   * only changes what draws them. Independent of `mapLayout`: switching never
   * adds or removes panes.
   */
  primaryRenderer: MapRendererKind;

  setMapView: (view: Partial<MapViewState>, markDirty?: boolean) => void;
  /**
   * Resize the map grid. Clamps `rows`/`cols` into range and grows/shrinks
   * `secondaryMapViews` so it always holds `rows * cols - 1` panes; new panes
   * clone the primary map's current camera and basemap.
   */
  setMapGrid: (rows: number, cols: number) => void;
  /** Toggle synchronized camera across all panes. */
  setSyncView: (syncView: boolean) => void;
  /** Patch one secondary pane's camera by id (no-op if the id is unknown). */
  setSecondaryMapView: (id: string, view: Partial<MapViewState>, markDirty?: boolean) => void;
  /**
   * Override a layer's visibility in one secondary pane (no-op if the pane id is
   * unknown). The override forces the layer visible/hidden in that pane only,
   * independent of the primary map's visibility.
   */
  setSecondaryLayerVisibility: (id: string, layerId: string, visible: boolean) => void;
  /** Set the primary pane's custom label. */
  setPrimaryMapLabel: (label: string) => void;
  /**
   * Switch the primary map area between the 2D map and the 3D globe (no-op if
   * unchanged). Touches nothing else in the store, so the shared camera, layer,
   * and basemap state carries straight across the swap.
   */
  setPrimaryRenderer: (renderer: MapRendererKind) => void;
  /** Set one secondary pane's custom label (no-op if the id is unknown). */
  setSecondaryMapLabel: (id: string, label: string) => void;
  /**
   * Switch one secondary pane between the 2D map and the 3D globe (no-op if the
   * id is unknown or the kind is unchanged).
   */
  setSecondaryViewKind: (id: string, viewKind: NonNullable<SecondaryMapView["viewKind"]>) => void;
  /** Remove one secondary pane and collapse the grid back toward 1x1. */
  removeSecondaryMapView: (id: string) => void;
  setBasemapStyleUrl: (url: string) => void;
  /**
   * Apply a planetary basemap and sync the project's ellipsoid to the body it
   * depicts, so measurements and the globe control use that body's radius. Used
   * by both the basemap picker and the Layers-panel planet switcher.
   */
  applyPlanetaryBasemap: (basemap: PlanetaryBasemap) => void;
  /**
   * Return to Earth: apply `styleUrl` (typically the Earth basemap that was
   * active before a planet was selected, e.g. Liberty) and reset the ellipsoid
   * to Earth. Used when a planet is deselected in the switcher.
   */
  restoreEarthBasemap: (styleUrl: string) => void;
  setBasemapVisible: (visible: boolean) => void;
  setBasemapOpacity: (opacity: number) => void;
  setBlankBackgroundColor: (color: string | null) => void;
  setPreferences: (preferences: ProjectPreferences) => void;
}

export const createMapViewSlice: SliceCreator<MapViewSlice> = (set) => ({
  mapView: createDefaultMapView(),
  basemapStyleUrl: DEFAULT_BASEMAP,
  basemapVisible: true,
  basemapOpacity: 1,
  blankBackgroundColor: null,
  preferences: DEFAULT_PROJECT_PREFERENCES,
  mapLayout: { ...DEFAULT_MAP_GRID_LAYOUT },
  secondaryMapViews: [],
  primaryMapLabel: "",
  primaryRenderer: DEFAULT_PRIMARY_RENDERER,

  setMapView: (view, markDirty = false) =>
    set((s) => ({
      mapView: { ...s.mapView, ...view },
      isDirty: markDirty || s.isDirty,
    })),
  setMapGrid: (rows, cols) =>
    set((s) => {
      const clampedRows = clampGridDim(rows);
      const clampedCols = clampGridDim(cols);
      const desiredSecondary = clampedRows * clampedCols - 1;
      let secondaryMapViews = s.secondaryMapViews;
      if (desiredSecondary < secondaryMapViews.length) {
        secondaryMapViews = secondaryMapViews.slice(0, desiredSecondary);
      } else if (desiredSecondary > secondaryMapViews.length) {
        const additions: SecondaryMapView[] = [];
        for (let i = secondaryMapViews.length; i < desiredSecondary; i++) {
          // New panes start as a clone of the primary map's camera and (by
          // having no overrides) inherit its layer visibility, so the
          // comparison begins from the same view the user is looking at.
          additions.push({
            id: uuidv4(),
            view: { ...s.mapView },
            layerVisibility: {},
          });
        }
        secondaryMapViews = [...secondaryMapViews, ...additions];
      }
      return {
        mapLayout: {
          ...s.mapLayout,
          rows: clampedRows,
          cols: clampedCols,
        },
        secondaryMapViews,
        isDirty: true,
      };
    }),
  setSyncView: (syncView) =>
    set((s) => ({
      mapLayout: { ...s.mapLayout, syncView },
      isDirty: true,
    })),
  setSecondaryMapView: (id, view, markDirty = false) =>
    set((s) => {
      let changed = false;
      const secondaryMapViews = s.secondaryMapViews.map((pane) => {
        if (pane.id !== id) return pane;
        const merged = { ...pane.view, ...view };
        // Skip value-identical writes: a programmatic `applyView` (camera
        // sync, initial load) fires "moveend" too, so without this guard
        // each pane re-stores the same camera it was just given, churning a
        // new `secondaryMapViews` array and re-rendering every subscriber.
        if (sameCamera(pane.view, merged)) return pane;
        changed = true;
        return { ...pane, view: merged };
      });
      if (!changed) return s;
      return {
        secondaryMapViews,
        isDirty: markDirty || s.isDirty,
      };
    }),
  setSecondaryLayerVisibility: (id, layerId, visible) =>
    set((s) => {
      let changed = false;
      const secondaryMapViews = s.secondaryMapViews.map((pane) => {
        if (pane.id !== id) return pane;
        changed = true;
        return {
          ...pane,
          layerVisibility: { ...pane.layerVisibility, [layerId]: visible },
        };
      });
      if (!changed) return s;
      return { secondaryMapViews, isDirty: true };
    }),
  setPrimaryMapLabel: (label) => set({ primaryMapLabel: label, isDirty: true }),
  setPrimaryRenderer: (renderer) =>
    set((s) => (s.primaryRenderer === renderer ? s : { primaryRenderer: renderer, isDirty: true })),
  setSecondaryMapLabel: (id, label) =>
    set((s) => {
      let changed = false;
      const secondaryMapViews = s.secondaryMapViews.map((pane) => {
        if (pane.id !== id) return pane;
        changed = true;
        return { ...pane, label };
      });
      if (!changed) return s;
      return { secondaryMapViews, isDirty: true };
    }),
  setSecondaryViewKind: (id, viewKind) =>
    set((s) => {
      let changed = false;
      const secondaryMapViews = s.secondaryMapViews.map((pane) => {
        if (pane.id !== id) return pane;
        // Treat an absent viewKind as "maplibre" so switching a legacy pane
        // to maplibre is a no-op rather than a churned array.
        if ((pane.viewKind ?? "maplibre") === viewKind) return pane;
        changed = true;
        return { ...pane, viewKind };
      });
      if (!changed) return s;
      return { secondaryMapViews, isDirty: true };
    }),
  removeSecondaryMapView: (id) =>
    set((s) => {
      const secondaryMapViews = s.secondaryMapViews.filter((pane) => pane.id !== id);
      if (secondaryMapViews.length === s.secondaryMapViews.length) {
        return s;
      }
      // Collapse to a gap-free grid that fits the remaining panes, keeping
      // the layout's orientation as close as possible to the current one.
      const total = secondaryMapViews.length + 1;
      const { rows, cols } = fitGrid(total, s.mapLayout.cols);
      return {
        secondaryMapViews,
        mapLayout: { ...s.mapLayout, rows, cols },
        isDirty: true,
      };
    }),
  setBasemapStyleUrl: (url) =>
    set((state) => ({
      basemapStyleUrl: url,
      preferences: preferencesForBasemap(state),
      isDirty: true,
    })),
  applyPlanetaryBasemap: (basemap) =>
    set((state) => ({
      basemapStyleUrl: basemap.styleUrl,
      preferences: preferencesForBasemap(state, basemap.ellipsoidId),
      isDirty: true,
    })),
  restoreEarthBasemap: (styleUrl) =>
    set((state) => ({
      basemapStyleUrl: styleUrl,
      preferences: preferencesForBasemap(state, DEFAULT_ELLIPSOID_ID),
      isDirty: true,
    })),
  setBasemapVisible: (visible) => set({ basemapVisible: visible, isDirty: true }),
  setBasemapOpacity: (opacity) => set({ basemapOpacity: opacity, isDirty: true }),
  setBlankBackgroundColor: (color) =>
    set({ blankBackgroundColor: normalizeBlankBackgroundColor(color), isDirty: true }),
  setPreferences: (preferences) => set({ preferences, isDirty: true }),
});
