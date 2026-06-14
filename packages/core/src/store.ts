import type { FeatureCollection } from "geojson";
import { v4 as uuidv4 } from "uuid";
import { create } from "zustand";
import { shallow } from "zustand/shallow";
import { temporal } from "zundo";
import {
  getHistoryCoalesceMs,
  getMaxHistoryFeatureCount,
  leadingDebounce,
  trimHistoryBySize,
} from "./history";
import {
  applyProjectToStore,
  type CreateProjectOptions,
  createDefaultMapView,
  createEmptyProject,
  DEFAULT_PROJECT_NAME,
} from "./project";
import {
  DEFAULT_LAYER_GROUP_OPACITY,
  normalizeGroupContiguity,
} from "./layer-groups";
import {
  DEFAULT_BASEMAP,
  DEFAULT_LAYER_STYLE,
  DEFAULT_LEGEND_CONFIG,
  DEFAULT_PROJECT_PREFERENCES,
  DEFAULT_STORY_MAP,
  type CollaborationParticipant,
  type CollaborationPresence,
  type CollaborationState,
  type GeoLibreLayer,
  type GeoLibreProject,
  type LayerGroup,
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
  | "vector-to-shapefile"
  | "vector-to-geopackage"
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

/** Identifiers of the network-analysis tools (`NETWORK_TOOLS` ids). */
export type NetworkToolKind = "isochrone" | "od-matrix";

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
  layerGroups: LayerGroup[];
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
  // Ephemeral live-collaboration session state (issue #307). Deliberately
  // excluded from the project file (project.ts never reads it) and from undo
  // history (partialize never lists it).
  collaboration: CollaborationState;
  ui: {
    processingOpen: boolean;
    conversionOpen: ConversionToolKind | null;
    vectorToolOpen: VectorToolKind | null;
    networkToolOpen: NetworkToolKind | null;
    rasterToolOpen: RasterToolKind | null;
    segmentationOpen: boolean;
    geocodeOpen: boolean;
    sqlWorkspaceOpen: boolean;
    pythonConsoleOpen: boolean;
    assistantOpen: boolean;
    attributeTableOpen: boolean;
    storymapPanelOpen: boolean;
    storymapPresenting: boolean;
    zoomToSelectedFeature: boolean;
  };

  setPointerCoords: (coords: [number, number] | null) => void;
  setCollaboration: (patch: Partial<CollaborationState>) => void;
  updateCollaborationPresence: (
    clientId: string,
    presence: CollaborationPresence | null
  ) => void;
  resetCollaboration: () => void;
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
  setNetworkToolOpen: (kind: NetworkToolKind | null) => void;
  setRasterToolOpen: (kind: RasterToolKind | null) => void;
  setSegmentationOpen: (open: boolean) => void;
  setGeocodeOpen: (open: boolean) => void;
  setSqlWorkspaceOpen: (open: boolean) => void;
  setPythonConsoleOpen: (open: boolean) => void;
  setAssistantOpen: (open: boolean) => void;
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
    options?: { rememberRecent?: boolean; presenting?: boolean }
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

  addLayerGroup: (name?: string, layerIds?: string[]) => string;
  removeLayerGroup: (id: string, options?: { removeChildren?: boolean }) => void;
  renameLayerGroup: (id: string, name: string) => void;
  setLayerGroupVisibility: (id: string, visible: boolean) => void;
  setLayerGroupOpacity: (id: string, opacity: number) => void;
  toggleLayerGroupCollapsed: (id: string) => void;
  moveLayerToGroup: (
    layerId: string,
    groupId: string | null,
    beforeLayerId?: string | null
  ) => void;
  reorderLayerGroup: (id: string, direction: "up" | "down") => void;
}

const MAX_RECENT_PROJECTS = 10;

/**
 * A fresh, inactive collaboration slice (no live session). Frozen (like
 * DEFAULT_LEGEND_CONFIG) to guard against accidental in-place mutation; store
 * actions always produce new objects via spread, so the frozen default is only
 * ever read.
 */
export const DEFAULT_COLLABORATION_STATE: CollaborationState = Object.freeze({
  isActive: false,
  connecting: false,
  sessionId: null,
  clientId: null,
  role: null,
  mode: "co-edit",
  selfName: "",
  selfColor: "",
  participants: Object.freeze([] as CollaborationParticipant[]) as CollaborationParticipant[],
  presence: Object.freeze({} as Record<string, CollaborationPresence>) as Record<
    string,
    CollaborationPresence
  >,
  followHost: false,
  error: null,
});

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

/**
 * Pick the lowest `Group N` name not already taken, so default names stay
 * unique while still preferring small numbers — starting the search at 1 (not
 * `length + 1`) avoids skipping free low numbers when some groups carry custom
 * names. Group counts are small, so the linear scan is negligible.
 */
function nextDefaultGroupName(groups: LayerGroup[]): string {
  const existing = new Set(groups.map((g) => g.name));
  let n = 1;
  while (existing.has(`Group ${n}`)) n++;
  return `Group ${n}`;
}

/**
 * Compare two `layerGroups` arrays for undo-history purposes, ignoring the
 * `collapsed` flag so expand/collapse (a UI-panel preference) never records a
 * history entry. Every other field — order, name, visibility, opacity — is
 * still compared, so real edits are tracked.
 */
function layerGroupsEqualForHistory(
  a: LayerGroup[],
  b: LayerGroup[]
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.visible !== y.visible ||
      x.opacity !== y.opacity
    ) {
      return false;
    }
  }
  return true;
}

/** Cancels the active history coalesce window (assigned by zundo's handleSet). */
let cancelHistoryCoalesce: () => void = () => {};

/**
 * Drop the oldest undo snapshots once their combined feature payload exceeds the
 * configured budget, bounding the memory held by history when a large vector
 * layer is edited repeatedly (issue #341). Called after a snapshot is appended.
 * Operates on the live temporal store directly; this never touches the main
 * store, so it does not itself record a history entry.
 */
function pruneHistoryBySize(): void {
  const temporalStore = useAppStore.temporal;
  const { pastStates } = temporalStore.getState();
  const trimmed = trimHistoryBySize(pastStates, getMaxHistoryFeatureCount());
  if (trimmed.length !== pastStates.length) {
    temporalStore.setState({ pastStates: trimmed });
  }
}

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
      layerGroups: [],
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
      collaboration: DEFAULT_COLLABORATION_STATE,
      ui: {
        processingOpen: false,
        conversionOpen: null,
        vectorToolOpen: null,
        networkToolOpen: null,
        rasterToolOpen: null,
        segmentationOpen: false,
        geocodeOpen: false,
        sqlWorkspaceOpen: false,
        pythonConsoleOpen: false,
        assistantOpen: false,
        attributeTableOpen: false,
        storymapPanelOpen: false,
        storymapPresenting: false,
        zoomToSelectedFeature: false,
      },

      setPointerCoords: (coords) => set({ pointerCoords: coords }),
      setCollaboration: (patch) =>
        set((s) => ({ collaboration: { ...s.collaboration, ...patch } })),
      // Add or remove a single remote participant's presence without rebuilding
      // the whole map on every cursor move. Passing `null` drops the entry (on
      // participant leave).
      updateCollaborationPresence: (clientId, presence) =>
        set((s) => {
          const next = { ...s.collaboration.presence };
          if (presence === null) {
            delete next[clientId];
          } else {
            next[clientId] = presence;
          }
          return { collaboration: { ...s.collaboration, presence: next } };
        }),
      resetCollaboration: () =>
        set({ collaboration: DEFAULT_COLLABORATION_STATE }),
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
      setNetworkToolOpen: (kind) =>
        set((s) => ({ ui: { ...s.ui, networkToolOpen: kind } })),
      setRasterToolOpen: (kind) =>
        set((s) => ({ ui: { ...s.ui, rasterToolOpen: kind } })),
      setSegmentationOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, segmentationOpen: open } })),
      setGeocodeOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, geocodeOpen: open } })),
      setSqlWorkspaceOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, sqlWorkspaceOpen: open } })),
      setPythonConsoleOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, pythonConsoleOpen: open } })),
      setAssistantOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, assistantOpen: open } })),
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

      addLayerGroup: (name, layerIds) => {
        const id = uuidv4();
        set((s) => {
          const group: LayerGroup = {
            id,
            name: name?.trim() || nextDefaultGroupName(s.layerGroups),
            collapsed: false,
            visible: true,
            opacity: DEFAULT_LAYER_GROUP_OPACITY,
          };
          const ids = new Set(layerIds ?? []);
          const layers =
            ids.size > 0
              ? normalizeGroupContiguity(
                  s.layers.map((l) =>
                    ids.has(l.id) ? { ...l, groupId: id } : l
                  )
                )
              : s.layers;
          return {
            layers,
            layerGroups: [...s.layerGroups, group],
            isDirty: true,
          };
        });
        return id;
      },

      removeLayerGroup: (id, options) =>
        set((s) => {
          const removeChildren = options?.removeChildren ?? false;
          const removedIds = new Set(
            s.layers.filter((l) => l.groupId === id).map((l) => l.id)
          );
          const layers = removeChildren
            ? s.layers.filter((l) => l.groupId !== id)
            : s.layers.map((l) =>
                l.groupId === id ? { ...l, groupId: undefined } : l
              );
          const selectionRemoved =
            removeChildren &&
            s.selectedLayerId !== null &&
            removedIds.has(s.selectedLayerId);
          return {
            layers,
            layerGroups: s.layerGroups.filter((g) => g.id !== id),
            selectedLayerId: selectionRemoved
              ? layers[layers.length - 1]?.id ?? null
              : s.selectedLayerId,
            selectedFeatureId: selectionRemoved ? null : s.selectedFeatureId,
            identifyLayerId:
              s.identifyLayerId !== null && removedIds.has(s.identifyLayerId)
                ? null
                : s.identifyLayerId,
            isDirty: true,
          };
        }),

      renameLayerGroup: (id, name) =>
        set((s) => ({
          layerGroups: s.layerGroups.map((g) =>
            g.id === id ? { ...g, name } : g
          ),
          isDirty: true,
        })),

      setLayerGroupVisibility: (id, visible) =>
        set((s) => ({
          layerGroups: s.layerGroups.map((g) =>
            g.id === id ? { ...g, visible } : g
          ),
          isDirty: true,
        })),

      setLayerGroupOpacity: (id, opacity) =>
        set((s) => ({
          layerGroups: s.layerGroups.map((g) =>
            g.id === id
              ? { ...g, opacity: Math.min(Math.max(opacity, 0), 1) }
              : g
          ),
          isDirty: true,
        })),

      // Collapsing/expanding a folder is a UI-panel preference, not a data
      // edit: it is still persisted in the project (folders reopen collapsed),
      // but it does not mark the project dirty and is excluded from undo (see
      // the equality comparator below) so Ctrl-Z never toggles a folder.
      toggleLayerGroupCollapsed: (id) =>
        set((s) => ({
          layerGroups: s.layerGroups.map((g) =>
            g.id === id ? { ...g, collapsed: !g.collapsed } : g
          ),
        })),

      moveLayerToGroup: (layerId, groupId, beforeLayerId = null) =>
        set((s) => {
          const current = s.layers.find((l) => l.id === layerId);
          if (!current) return s;
          if (groupId && !s.layerGroups.some((g) => g.id === groupId)) return s;
          const updated = { ...current, groupId: groupId ?? undefined };
          const without = s.layers.filter((l) => l.id !== layerId);
          let index: number;
          if (beforeLayerId) {
            const at = without.findIndex((l) => l.id === beforeLayerId);
            index = at < 0 ? without.length : at;
          } else if (groupId) {
            // Append to the end of the target group's block (top of the group
            // in the panel); fall back to the array end for an empty group.
            let last = -1;
            without.forEach((l, i) => {
              if (l.groupId === groupId) last = i;
            });
            index = last < 0 ? without.length : last + 1;
          } else {
            index = without.length;
          }
          const next = [...without];
          next.splice(index, 0, updated);
          const normalized = normalizeGroupContiguity(next);
          const unchanged = normalized.every(
            (l, i) =>
              l.id === s.layers[i]?.id && l.groupId === s.layers[i]?.groupId
          );
          if (unchanged) return s;
          return { layers: normalized, isDirty: true };
        }),

      reorderLayerGroup: (id, direction) =>
        set((s) => {
          // Build the top-level units in store (render) order: each ungrouped
          // layer is its own unit, and a group's contiguous members form one
          // unit. Reordering swaps the whole group block past its neighbor.
          const units: { key: string; layers: GeoLibreLayer[] }[] = [];
          for (const layer of s.layers) {
            const key = layer.groupId ?? `layer:${layer.id}`;
            const last = units[units.length - 1];
            if (last && last.key === key) last.layers.push(layer);
            else units.push({ key, layers: [layer] });
          }
          const unitIndex = units.findIndex((u) => u.key === id);
          if (unitIndex < 0) return s; // empty group: nothing to move
          const target = direction === "up" ? unitIndex + 1 : unitIndex - 1;
          if (target < 0 || target >= units.length) return s;
          const [unit] = units.splice(unitIndex, 1);
          units.splice(target, 0, unit);
          return { layers: units.flatMap((u) => u.layers), isDirty: true };
        }),

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
        // A project that ships a story map opens straight into the presentation
        // so the reader sees the story, not the editor. Projects without a story
        // (or with an empty one) open normally. Callers that open a project for
        // authoring rather than viewing can pass `presenting: false` to override.
        const presentStory =
          options.presenting ?? (applied.storymap?.chapters.length ?? 0) > 0;
        set((s) => ({
          ...applied,
          projectPath: path,
          projectGeneration: s.projectGeneration + 1,
          isDirty: false,
          selectedLayerId: applied.layers[0]?.id ?? null,
          selectedFeatureId: null,
          identifyLayerId: null,
          // Present a bundled story on load; otherwise drop any presentation
          // carried over from the previous project.
          ui: {
            ...s.ui,
            storymapPresenting: presentStory,
            storymapPanelOpen: false,
          },
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
        layerGroups: s.layerGroups,
        basemapStyleUrl: s.basemapStyleUrl,
        basemapVisible: s.basemapVisible,
        basemapOpacity: s.basemapOpacity,
        storymap: s.storymap,
      }),
      // Records a history entry only when the tracked slice really changed.
      // Basemap fields compare with ===; `layers` is compared element-by-element
      // (Object.is per element) via shallow. Every mutating action creates new
      // layer/group objects, so real changes differ; two distinct empty arrays
      // compare equal, so resetting them (e.g. newProject) records nothing.
      // `storymap` is compared by reference: every authoring action creates a
      // new object, so real edits differ while an unchanged null stays equal.
      // `layerGroups` is compared ignoring `collapsed`, which is a UI preference
      // excluded from undo (see toggleLayerGroupCollapsed).
      equality: (a, b) =>
        a.basemapStyleUrl === b.basemapStyleUrl &&
        a.basemapVisible === b.basemapVisible &&
        a.basemapOpacity === b.basemapOpacity &&
        a.storymap === b.storymap &&
        shallow(a.layers, b.layers) &&
        layerGroupsEqualForHistory(a.layerGroups, b.layerGroups),
      limit: 100,
      // Group rapid bursts (slider drags) into one entry; window is 0 in tests.
      // Keep the debounced wrapper so clearHistory can reset an in-flight burst.
      handleSet: (baseHandleSet) => {
        const debounced = leadingDebounce(baseHandleSet, getHistoryCoalesceMs);
        cancelHistoryCoalesce = debounced.cancel;
        // Trim history back under the feature-payload budget so editing large
        // layers can't pin unbounded copies of their feature sets in memory
        // (issue #341). Only the leading-edge call actually pushes a snapshot;
        // burst-suppressed calls leave `pastStates` untouched, so skip the scan
        // unless a new snapshot was appended.
        return (...args: Parameters<typeof debounced>) => {
          const before = useAppStore.temporal.getState().pastStates;
          debounced(...args);
          if (useAppStore.temporal.getState().pastStates !== before) {
            pruneHistoryBySize();
          }
        };
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
