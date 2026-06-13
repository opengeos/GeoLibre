import type { FeatureCollection } from "geojson";
import { v4 as uuidv4 } from "uuid";
import { create } from "zustand";
import { shallow } from "zustand/shallow";
import { temporal } from "zundo";
import { getHistoryCoalesceMs, leadingDebounce } from "./history";
import {
  applyProjectToStore,
  type CreateProjectOptions,
  createDefaultMapView,
  createEmptyProject,
  DEFAULT_PROJECT_NAME,
} from "./project";
import {
  DEFAULT_BASEMAP,
  DEFAULT_LAYER_STYLE,
  DEFAULT_LEGEND_CONFIG,
  DEFAULT_PROJECT_PREFERENCES,
  DEFAULT_STORY_MAP,
  type GeoLibreLayer,
  type GeoLibreProject,
  type LayerStyle,
  type LegendConfig,
  type MapViewState,
  type ProjectPluginState,
  type ProjectPreferences,
  type RecentProjectEntry,
  type StoryChapter,
  type StoryMap,
} from "./types";

export type ConversionToolKind =
  | "vector-to-geoparquet"
  | "vector-to-flatgeobuf"
  | "csv-to-geoparquet"
  | "vector-to-pmtiles"
  | "raster-to-cog";

/**
 * Identifiers of the vector processing tools. Kept in sync by hand with the
 * `id` fields of `VECTOR_TOOLS` in `@geolibre/processing` (`vector-tools.ts`);
 * deriving the type there would create a core -> processing circular import.
 */
export type VectorToolKind =
  | "buffer"
  | "centroids"
  | "convex-hull"
  | "dissolve"
  | "bounding-box"
  | "simplify"
  | "clip"
  | "intersection"
  | "difference"
  | "union"
  | "spatial-join"
  | "attribute-join"
  | "select-by-value"
  | "select-by-location"
  | "reproject"
  | "explode"
  | "aggregate"
  | "smooth"
  | "grid"
  | "voronoi"
  | "h3-grid"
  | "h3-bin-points";

/**
 * Identifiers of the raster processing tools. Kept in sync by hand with the
 * `id` fields of `RASTER_TOOLS` in `@geolibre/processing` (`raster-tools.ts`);
 * deriving the type there would create a core -> processing circular import.
 */
export type RasterToolKind =
  | "hillshade"
  | "slope"
  | "aspect"
  | "reproject"
  | "resample"
  | "clip-extent"
  | "clip-mask"
  | "polygonize"
  | "contour"
  | "interpolate"
  | "zonal"
  | "raster-calc"
  | "reclassify"
  | "mosaic"
  | "focal";

export interface AppState {
  projectName: string;
  projectPath: string | null;
  projectGeneration: number;
  isDirty: boolean;
  mapView: MapViewState;
  basemapStyleUrl: string;
  basemapVisible: boolean;
  basemapOpacity: number;
  layers: GeoLibreLayer[];
  preferences: ProjectPreferences;
  projectPlugins: ProjectPluginState | null;
  legend: LegendConfig;
  storymap: StoryMap | null;
  selectedLayerId: string | null;
  selectedFeatureId: string | null;
  identifyLayerId: string | null;
  pointerCoords: [number, number] | null;
  metadata: Record<string, unknown>;
  recentProjects: RecentProjectEntry[];
  attributeFilter: string;
  ui: {
    processingOpen: boolean;
    conversionOpen: ConversionToolKind | null;
    vectorToolOpen: VectorToolKind | null;
    rasterToolOpen: RasterToolKind | null;
    sqlWorkspaceOpen: boolean;
    attributeTableOpen: boolean;
    storymapPanelOpen: boolean;
    storymapPresenting: boolean;
    zoomToSelectedFeature: boolean;
  };

  setPointerCoords: (coords: [number, number] | null) => void;
  setMapView: (view: Partial<MapViewState>, markDirty?: boolean) => void;
  setBasemapStyleUrl: (url: string) => void;
  setBasemapVisible: (visible: boolean) => void;
  setBasemapOpacity: (opacity: number) => void;
  setPreferences: (preferences: ProjectPreferences) => void;
  setLegend: (legend: LegendConfig) => void;
  setProjectPlugins: (
    projectPlugins: ProjectPluginState | null,
    shouldMarkDirty?: boolean
  ) => void;
  selectLayer: (id: string | null) => void;
  selectFeature: (id: string | null) => void;
  setIdentifyLayer: (id: string | null) => void;
  setAttributeFilter: (filter: string) => void;
  setProcessingOpen: (open: boolean) => void;
  setConversionOpen: (kind: ConversionToolKind | null) => void;
  setVectorToolOpen: (kind: VectorToolKind | null) => void;
  setRasterToolOpen: (kind: RasterToolKind | null) => void;
  setSqlWorkspaceOpen: (open: boolean) => void;
  setAttributeTableOpen: (open: boolean) => void;
  setStorymapPanelOpen: (open: boolean) => void;
  setStorymapPresenting: (presenting: boolean) => void;
  setZoomToSelectedFeature: (enabled: boolean) => void;

  setStorymap: (storymap: StoryMap | null) => void;
  updateStorymapSettings: (
    patch: Partial<Omit<StoryMap, "chapters">>
  ) => void;
  addStoryChapter: (chapter: StoryChapter, atIndex?: number) => void;
  updateStoryChapter: (id: string, patch: Partial<StoryChapter>) => void;
  removeStoryChapter: (id: string) => void;
  moveStoryChapter: (id: string, targetIndex: number) => void;

  newProject: (options?: CreateProjectOptions & { name?: string }) => void;
  loadProject: (
    project: GeoLibreProject,
    path?: string | null,
    options?: { rememberRecent?: boolean }
  ) => void;
  setProjectPath: (path: string | null) => void;
  setProjectName: (name: string) => void;
  setRecentProjects: (projects: RecentProjectEntry[]) => void;
  rememberRecentProject: (entry: RecentProjectEntry) => void;
  forgetRecentProject: (path: string) => void;
  clearRecentProjects: () => void;
  markSaved: () => void;

  addLayer: (layer: GeoLibreLayer, beforeLayerId?: string | null) => void;
  removeLayer: (id: string) => void;
  updateLayer: (id: string, patch: Partial<GeoLibreLayer>) => void;
  setLayerVisibility: (id: string, visible: boolean) => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  setLayerStyle: (id: string, style: Partial<LayerStyle>) => void;
  reorderLayer: (id: string, direction: "up" | "down") => void;
  moveLayer: (id: string, targetIndex: number) => void;
  addGeoJsonLayer: (
    name: string,
    geojson: FeatureCollection,
    sourcePath?: string,
    beforeLayerId?: string | null
  ) => string;
}

const MAX_RECENT_PROJECTS = 10;

/** Derive a human-friendly display name from a file path or URL. */
export function projectPathLabel(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function normalizeRecentProjects(
  projects: RecentProjectEntry[]
): RecentProjectEntry[] {
  const seen = new Set<string>();
  const normalized: RecentProjectEntry[] = [];

  for (const project of projects) {
    const path = project.path.trim();
    if (!path || seen.has(path)) continue;

    const name = project.name.trim() || projectPathLabel(path);
    normalized.push({
      path,
      name,
      openedAt: project.openedAt || new Date().toISOString(),
    });
    seen.add(path);
  }

  return normalized.slice(0, MAX_RECENT_PROJECTS);
}

/** Cancels the active history coalesce window (assigned by zundo's handleSet). */
let cancelHistoryCoalesce: () => void = () => {};

export const useAppStore = create<AppState>()(
  temporal(
    (set, get) => ({
      projectName: DEFAULT_PROJECT_NAME,
      projectPath: null,
      projectGeneration: 0,
      isDirty: false,
      mapView: createDefaultMapView(),
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [],
      preferences: DEFAULT_PROJECT_PREFERENCES,
      projectPlugins: null,
      legend: { ...DEFAULT_LEGEND_CONFIG },
      storymap: null,
      selectedLayerId: null,
      selectedFeatureId: null,
      identifyLayerId: null,
      pointerCoords: null,
      metadata: {},
      recentProjects: [],
      attributeFilter: "",
      ui: {
        processingOpen: false,
        conversionOpen: null,
        vectorToolOpen: null,
        rasterToolOpen: null,
        sqlWorkspaceOpen: false,
        attributeTableOpen: false,
        storymapPanelOpen: false,
        storymapPresenting: false,
        zoomToSelectedFeature: false,
      },

      setPointerCoords: (coords) => set({ pointerCoords: coords }),
      setMapView: (view, markDirty = false) =>
        set((s) => ({
          mapView: { ...s.mapView, ...view },
          isDirty: markDirty || s.isDirty,
        })),
      setBasemapStyleUrl: (url) => set({ basemapStyleUrl: url, isDirty: true }),
      setBasemapVisible: (visible) =>
        set({ basemapVisible: visible, isDirty: true }),
      setBasemapOpacity: (opacity) =>
        set({ basemapOpacity: opacity, isDirty: true }),
      setPreferences: (preferences) => set({ preferences, isDirty: true }),
      setLegend: (legend) => set({ legend, isDirty: true }),
      // When shouldMarkDirty is false the existing dirty flag is preserved rather
      // than set; it cannot clear the flag (only markSaved() does that).
      setProjectPlugins: (projectPlugins, shouldMarkDirty = true) =>
        set((s) => ({
          projectPlugins,
          isDirty: shouldMarkDirty || s.isDirty,
        })),
      selectLayer: (id) =>
        set({ selectedLayerId: id, selectedFeatureId: null }),
      selectFeature: (id) => set({ selectedFeatureId: id }),
      setIdentifyLayer: (id) => set({ identifyLayerId: id }),
      setAttributeFilter: (filter) => set({ attributeFilter: filter }),
      setProcessingOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, processingOpen: open } })),
      setConversionOpen: (kind) =>
        set((s) => ({ ui: { ...s.ui, conversionOpen: kind } })),
      setVectorToolOpen: (kind) =>
        set((s) => ({ ui: { ...s.ui, vectorToolOpen: kind } })),
      setRasterToolOpen: (kind) =>
        set((s) => ({ ui: { ...s.ui, rasterToolOpen: kind } })),
      setSqlWorkspaceOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, sqlWorkspaceOpen: open } })),
      setAttributeTableOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, attributeTableOpen: open } })),
      setStorymapPanelOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, storymapPanelOpen: open } })),
      setStorymapPresenting: (presenting) =>
        set((s) => ({ ui: { ...s.ui, storymapPresenting: presenting } })),
      setZoomToSelectedFeature: (enabled) =>
        set((s) => ({ ui: { ...s.ui, zoomToSelectedFeature: enabled } })),

      setStorymap: (storymap) => set({ storymap, isDirty: true }),
      updateStorymapSettings: (patch) =>
        set((s) => ({
          storymap: { ...(s.storymap ?? DEFAULT_STORY_MAP), ...patch },
          isDirty: true,
        })),
      addStoryChapter: (chapter, atIndex) =>
        set((s) => {
          const base = s.storymap ?? DEFAULT_STORY_MAP;
          const chapters = [...base.chapters];
          const index =
            atIndex === undefined
              ? chapters.length
              : Math.min(Math.max(atIndex, 0), chapters.length);
          chapters.splice(index, 0, chapter);
          return { storymap: { ...base, chapters }, isDirty: true };
        }),
      updateStoryChapter: (id, patch) =>
        set((s) => {
          if (!s.storymap) return s;
          return {
            storymap: {
              ...s.storymap,
              chapters: s.storymap.chapters.map((chapter) =>
                chapter.id === id ? { ...chapter, ...patch } : chapter
              ),
            },
            isDirty: true,
          };
        }),
      removeStoryChapter: (id) =>
        set((s) => {
          if (!s.storymap) return s;
          return {
            storymap: {
              ...s.storymap,
              chapters: s.storymap.chapters.filter(
                (chapter) => chapter.id !== id
              ),
            },
            isDirty: true,
          };
        }),
      moveStoryChapter: (id, targetIndex) =>
        set((s) => {
          if (!s.storymap) return s;
          const current = s.storymap.chapters.findIndex(
            (chapter) => chapter.id === id
          );
          if (current < 0) return s;
          const chapters = [...s.storymap.chapters];
          const [chapter] = chapters.splice(current, 1);
          if (!chapter) return s;
          const next = Math.min(Math.max(targetIndex, 0), chapters.length);
          chapters.splice(next, 0, chapter);
          if (chapters.every((item, i) => item.id === s.storymap?.chapters[i]?.id)) {
            return s;
          }
          return { storymap: { ...s.storymap, chapters }, isDirty: true };
        }),

      setProjectPath: (path) => set({ projectPath: path }),
      setProjectName: (name) => set({ projectName: name, isDirty: true }),
      setRecentProjects: (projects) =>
        set({ recentProjects: normalizeRecentProjects(projects) }),
      rememberRecentProject: (entry) =>
        set((s) => ({
          recentProjects: normalizeRecentProjects([entry, ...s.recentProjects]),
        })),
      forgetRecentProject: (path) => {
        // Compare with separators normalized so a backslash/forward-slash mismatch
        // on Windows does not leave a stale entry behind.
        const normalized = path.replace(/\\/g, "/");
        set((s) => ({
          recentProjects: s.recentProjects.filter(
            (project) => project.path.replace(/\\/g, "/") !== normalized
          ),
        }));
      },
      clearRecentProjects: () => set({ recentProjects: [] }),
      markSaved: () => set({ isDirty: false }),

      addLayer: (layer, beforeLayerId = null) =>
        set((s) => {
          const layers = [...s.layers];
          const beforeIndex = beforeLayerId
            ? layers.findIndex((l) => l.id === beforeLayerId)
            : -1;
          const layerWithBeforeId =
            beforeLayerId && beforeIndex < 0
              ? { ...layer, beforeId: beforeLayerId }
              : { ...layer, beforeId: layer.beforeId };
          if (beforeIndex >= 0) {
            layers.splice(beforeIndex, 0, layerWithBeforeId);
          } else {
            layers.push(layerWithBeforeId);
          }
          return {
            layers,
            selectedLayerId: layer.id,
            isDirty: true,
          };
        }),

      removeLayer: (id) =>
        set((s) => ({
          layers: s.layers.filter((l) => l.id !== id),
          selectedLayerId:
            s.selectedLayerId === id
              ? s.layers.find((l) => l.id !== id)?.id ?? null
              : s.selectedLayerId,
          selectedFeatureId:
            s.selectedLayerId === id ? null : s.selectedFeatureId,
          identifyLayerId: s.identifyLayerId === id ? null : s.identifyLayerId,
          isDirty: true,
        })),

      updateLayer: (id, patch) =>
        set((s) => ({
          layers: s.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
          isDirty: true,
        })),

      setLayerVisibility: (id, visible) => get().updateLayer(id, { visible }),

      setLayerOpacity: (id, opacity) => get().updateLayer(id, { opacity }),

      setLayerStyle: (id, style) =>
        set((s) => ({
          layers: s.layers.map((l) =>
            l.id === id ? { ...l, style: { ...l.style, ...style } } : l
          ),
          isDirty: true,
        })),

      reorderLayer: (id, direction) =>
        set((s) => {
          const idx = s.layers.findIndex((l) => l.id === id);
          if (idx < 0) return s;
          const target = direction === "up" ? idx + 1 : idx - 1;
          if (target < 0 || target >= s.layers.length) return s;
          const next = [...s.layers];
          const [item] = next.splice(idx, 1);
          next.splice(target, 0, item);
          return { layers: next, isDirty: true };
        }),

      moveLayer: (id, targetIndex) =>
        set((s) => {
          const currentIndex = s.layers.findIndex((layer) => layer.id === id);
          if (currentIndex < 0) return s;
          const next = [...s.layers];
          const [layer] = next.splice(currentIndex, 1);
          const nextIndex = Math.min(Math.max(targetIndex, 0), next.length);
          next.splice(nextIndex, 0, layer);
          if (next.every((item, index) => item.id === s.layers[index]?.id)) {
            return s;
          }
          return { layers: next, isDirty: true };
        }),

      addGeoJsonLayer: (name, geojson, sourcePath, beforeLayerId = null) => {
        const id = uuidv4();
        const layer: GeoLibreLayer = {
          id,
          name,
          type: "geojson",
          source: { type: "geojson" },
          visible: true,
          opacity: 1,
          style: { ...DEFAULT_LAYER_STYLE },
          metadata: {},
          geojson,
          sourcePath,
        };
        get().addLayer(layer, beforeLayerId);
        return id;
      },

      newProject: (options = {}) => {
        const project = createEmptyProject(options.name, options);
        const applied = applyProjectToStore(project);
        set((s) => ({
          ...applied,
          projectPath: null,
          projectGeneration: s.projectGeneration + 1,
          isDirty: false,
          selectedLayerId: null,
          selectedFeatureId: null,
          identifyLayerId: null,
          pointerCoords: null,
          attributeFilter: "",
          // Don't carry an active story presentation into a different project.
          ui: { ...s.ui, storymapPresenting: false, storymapPanelOpen: false },
        }));
        clearHistory();
      },

      loadProject: (project, path = null, options = {}) => {
        const applied = applyProjectToStore(project);
        set((s) => ({
          ...applied,
          projectPath: path,
          projectGeneration: s.projectGeneration + 1,
          isDirty: false,
          selectedLayerId: applied.layers[0]?.id ?? null,
          selectedFeatureId: null,
          identifyLayerId: null,
          // Don't carry an active story presentation into a different project.
          ui: { ...s.ui, storymapPresenting: false, storymapPanelOpen: false },
        }));
        clearHistory();
        if (path && options.rememberRecent !== false) {
          get().rememberRecentProject({
            path,
            name: project.name,
            openedAt: new Date().toISOString(),
          });
        }
      },
    }),
    {
      // Only these fields participate in undo/redo; everything else (selection,
      // ui flags, mapView/camera, pointerCoords, project metadata, isDirty, ...)
      // is excluded, so changing them never creates a history entry.
      partialize: (s) => ({
        layers: s.layers,
        basemapStyleUrl: s.basemapStyleUrl,
        basemapVisible: s.basemapVisible,
        basemapOpacity: s.basemapOpacity,
        storymap: s.storymap,
      }),
      // Records a history entry only when the tracked slice really changed.
      // Basemap fields compare with ===; `layers` is compared element-by-element
      // (Object.is per element) via shallow. Every mutating action creates new
      // layer objects, so real changes differ; two distinct empty arrays compare
      // equal, so resetting layers (e.g. newProject) records nothing. `storymap`
      // is compared by reference: every authoring action creates a new object,
      // so real edits differ while an unchanged null stays equal.
      equality: (a, b) =>
        a.basemapStyleUrl === b.basemapStyleUrl &&
        a.basemapVisible === b.basemapVisible &&
        a.basemapOpacity === b.basemapOpacity &&
        a.storymap === b.storymap &&
        shallow(a.layers, b.layers),
      limit: 100,
      // Group rapid bursts (slider drags) into one entry; window is 0 in tests.
      // Keep the debounced wrapper so clearHistory can reset an in-flight burst.
      handleSet: (baseHandleSet) => {
        const debounced = leadingDebounce(baseHandleSet, getHistoryCoalesceMs);
        cancelHistoryCoalesce = debounced.cancel;
        return debounced;
      },
    }
  )
);

/**
 * After an undo/redo restores the tracked slice, mark the project dirty and
 * drop a `selectedLayerId` that no longer points at an existing layer (selection
 * is intentionally not tracked in history, so it can dangle after a restore).
 */
function finishHistoryStep(): void {
  const s = useAppStore.getState();
  const selectionDangling =
    s.selectedLayerId !== null &&
    !s.layers.some((layer) => layer.id === s.selectedLayerId);
  useAppStore.setState(
    selectionDangling
      ? { isDirty: true, selectedLayerId: null, selectedFeatureId: null }
      : { isDirty: true },
  );
  // The setState above must not leave a coalesce window open for the next edit.
  cancelHistoryCoalesce();
}

/**
 * Step the layer/basemap history back one entry and mark the project dirty.
 * zundo restores the partialized slice via the store's set; the resulting new
 * `layers`/basemap refs drive MapCanvas's existing effects, so the map
 * reconciles through MapController.syncLayers (never mutated directly here).
 */
export function undo(): void {
  const temporal = useAppStore.temporal.getState();
  if (temporal.pastStates.length === 0) return; // nothing to undo; stay clean
  cancelHistoryCoalesce(); // break any in-flight burst so the next edit records
  temporal.undo();
  finishHistoryStep();
}

/** Step the history forward one entry and mark the project dirty. */
export function redo(): void {
  const temporal = useAppStore.temporal.getState();
  if (temporal.futureStates.length === 0) return; // nothing to redo; stay clean
  cancelHistoryCoalesce(); // break any in-flight burst so the next edit records
  temporal.redo();
  finishHistoryStep();
}

/** Empty both the undo and redo stacks (e.g. on new/loaded project). */
export function clearHistory(): void {
  cancelHistoryCoalesce(); // reset any in-flight burst so the next edit records
  useAppStore.temporal.getState().clear();
}
