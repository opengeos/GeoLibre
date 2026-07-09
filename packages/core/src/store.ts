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
  DEFAULT_DASHBOARD_COLUMNS,
  DEFAULT_LAYER_STYLE,
  DEFAULT_LEGEND_CONFIG,
  DEFAULT_MAP_GRID_LAYOUT,
  DEFAULT_PROJECT_PREFERENCES,
  MAX_MAP_GRID_DIM,
  DEFAULT_STORY_MAP,
  MAX_DASHBOARD_COLUMNS,
  MIN_DASHBOARD_COLUMNS,
  type AddTileLayerOptions,
  type CollaborationChatMessage,
  type CollaborationParticipant,
  type CollaborationPresence,
  type CollaborationState,
  type DashboardWidget,
  type GeoLibreLayer,
  type GeoLibreProject,
  type LayerGroup,
  type LayerStyle,
  type LegendConfig,
  type MapGridLayout,
  type MapViewState,
  type ProcessingModel,
  type SecondaryMapView,
  type ProjectPluginState,
  type ProjectPreferences,
  type RecentProjectEntry,
  type StoryChapter,
  type StoryMap,
} from "./types";
import { hasSimpleStyleProperties } from "./vector-color";
import { setActiveEllipsoidId } from "./ellipsoids";

export type ConversionToolKind =
  | "vector-to-vector"
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
  | "cell-sectors"
  | "h3-grid"
  | "h3-bin-points"
  | "trajectory-speed"
  | "detect-stops"
  | "space-time-proximity";

/** Identifiers of the network-analysis tools (`NETWORK_TOOLS` ids). */
export type NetworkToolKind = "isochrone" | "od-matrix" | "sequential-route";

/** Identifiers of the spatial-statistics tools (`STATISTICS_TOOLS` ids). */
export type StatisticsToolKind =
  | "global-morans-i"
  | "local-morans-i"
  | "getis-ord-gi"
  | "average-nearest-neighbor"
  | "kernel-density";

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
  | "spectral-index"
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
  /** Saved processing pipelines (batch/model chaining; issue #344). */
  models: ProcessingModel[];
  /** Saved Dashboard panel chart widgets (issue #401). */
  widgets: DashboardWidget[];
  /** Number of columns in the Dashboard widget grid. */
  dashboardColumns: number;
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
    /**
     * Tool id to preselect when the Whitebox toolbox dialog opens, set when the
     * user picks a specific tool from the Processing menu's category submenus.
     * Consumed and cleared by ProcessingDialog. Null means "no preselection".
     */
    processingInitialTool: string | null;
    conversionOpen: ConversionToolKind | null;
    vectorToolOpen: VectorToolKind | null;
    networkToolOpen: NetworkToolKind | null;
    statisticsToolOpen: StatisticsToolKind | null;
    rasterToolOpen: RasterToolKind | null;
    segmentationOpen: boolean;
    geocodeOpen: boolean;
    sqlWorkspaceOpen: boolean;
    loadEditorFeaturesOpen: boolean;
    // Store layer preselected in the "Load Features into Editor" dialog when it
    // is opened from a layer's context menu, or null when opened without a target.
    loadEditorFeaturesLayerId: string | null;
    pythonConsoleOpen: boolean;
    notebookOpen: boolean;
    assistantOpen: boolean;
    attributeTableOpen: boolean;
    dashboardOpen: boolean;
    storymapPanelOpen: boolean;
    storymapPresenting: boolean;
    // True when the active presentation was launched from the editor, so exiting
    // it reopens the Story Map editor instead of dropping to the bare map
    // (#918). Auto-presented projects (opened for viewing) leave this false.
    storymapReturnToEditor: boolean;
    // Id of the chapter currently being composed on the live map. When set, the
    // Story Map dialog is hidden so the user can pan/zoom/tilt the real map and
    // save the resulting camera back into this chapter (issue #775).
    storymapComposingId: string | null;
    modelBuilderOpen: boolean;
    zoomToSelectedFeature: boolean;
    // Live-collaboration dialog visibility. Lifted into the store (rather than
    // local toolbar state) so the on-canvas session-status badge can reopen the
    // Collaborate dialog from outside the toolbar's component tree (#754).
    collaborateDialogOpen: boolean;
  };

  setPointerCoords: (coords: [number, number] | null) => void;
  setCollaboration: (patch: Partial<CollaborationState>) => void;
  updateCollaborationPresence: (
    clientId: string,
    presence: CollaborationPresence | null
  ) => void;
  /** Append a chat message to the session log (bounded; #754). */
  addCollaborationChat: (message: CollaborationChatMessage) => void;
  resetCollaboration: () => void;
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
  setSecondaryMapView: (
    id: string,
    view: Partial<MapViewState>,
    markDirty?: boolean
  ) => void;
  /**
   * Override a layer's visibility in one secondary pane (no-op if the pane id is
   * unknown). The override forces the layer visible/hidden in that pane only,
   * independent of the primary map's visibility.
   */
  setSecondaryLayerVisibility: (
    id: string,
    layerId: string,
    visible: boolean
  ) => void;
  /** Set the primary pane's custom label. */
  setPrimaryMapLabel: (label: string) => void;
  /** Set one secondary pane's custom label (no-op if the id is unknown). */
  setSecondaryMapLabel: (id: string, label: string) => void;
  /**
   * Switch one secondary pane between the 2D map and the 3D globe (no-op if the
   * id is unknown or the kind is unchanged).
   */
  setSecondaryViewKind: (
    id: string,
    viewKind: NonNullable<SecondaryMapView["viewKind"]>
  ) => void;
  /** Remove one secondary pane and collapse the grid back toward 1x1. */
  removeSecondaryMapView: (id: string) => void;
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
  setProcessingInitialTool: (toolId: string | null) => void;
  setConversionOpen: (kind: ConversionToolKind | null) => void;
  setVectorToolOpen: (kind: VectorToolKind | null) => void;
  setNetworkToolOpen: (kind: NetworkToolKind | null) => void;
  setStatisticsToolOpen: (kind: StatisticsToolKind | null) => void;
  setRasterToolOpen: (kind: RasterToolKind | null) => void;
  setSegmentationOpen: (open: boolean) => void;
  setGeocodeOpen: (open: boolean) => void;
  setSqlWorkspaceOpen: (open: boolean) => void;
  setLoadEditorFeaturesOpen: (open: boolean, layerId?: string | null) => void;
  setPythonConsoleOpen: (open: boolean) => void;
  setNotebookOpen: (open: boolean) => void;
  setAssistantOpen: (open: boolean) => void;
  setAttributeTableOpen: (open: boolean) => void;
  setDashboardOpen: (open: boolean) => void;
  setStorymapPanelOpen: (open: boolean) => void;
  setStorymapPresenting: (
    presenting: boolean,
    returnToEditor?: boolean,
  ) => void;
  setStorymapComposing: (chapterId: string | null) => void;
  setModelBuilderOpen: (open: boolean) => void;
  setCollaborateDialogOpen: (open: boolean) => void;
  setZoomToSelectedFeature: (enabled: boolean) => void;

  /** Insert a new model or replace an existing one matching by `id`. */
  saveModel: (model: ProcessingModel) => void;
  /** Remove a saved model by id. */
  deleteModel: (id: string) => void;

  /** Append a new dashboard widget. */
  addWidget: (widget: DashboardWidget) => void;
  /** Patch an existing dashboard widget by id (no-op if absent). */
  updateWidget: (id: string, patch: Partial<Omit<DashboardWidget, "id">>) => void;
  /** Remove a dashboard widget by id. */
  removeWidget: (id: string) => void;
  /** Move a widget to a new index, clamped into range, preserving the rest. */
  moveWidget: (id: string, toIndex: number) => void;
  /** Set the Dashboard widget-grid column count (clamped into range). */
  setDashboardColumns: (columns: number) => void;

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
  /**
   * Add a georeferenced image overlay (a MapLibre `image` source rendered as a
   * raster layer) from an image URL and its four corner coordinates, and return
   * its id. Used for KML/KMZ `<GroundOverlay>` imports; the layer persists and
   * renders exactly like a Raster Georeferencer overlay. Corners are `[lng,
   * lat]` in top-left, top-right, bottom-right, bottom-left order.
   */
  addImageOverlayLayer: (
    name: string,
    source: { url: string; coordinates: [number, number][] },
    options?: {
      opacity?: number;
      bounds?: [number, number, number, number];
      sourcePath?: string;
      /** Initial visibility (default true); a time-slider frame past the first
       * starts hidden. */
      visible?: boolean;
      /** Epoch-ms time bounds of a KML `<TimeSpan>`/`<TimeStamp>` frame; the
       * Time Slider toggles this frame's visibility by the current date. */
      timeSpan?: { begin: number | null; end: number | null };
    },
    beforeLayerId?: string | null
  ) => string;
  /**
   * Add a native raster tile layer (XYZ, WMS, or WMTS) from one or more tile
   * URL templates and return its id. The layer appears in the Layers panel and
   * persists with the project exactly like a layer added through the Add Data
   * dialog, so callers (e.g. an external plugin) do not have to touch MapLibre
   * directly. See {@link AddTileLayerOptions}.
   */
  addTileLayer: (
    name: string,
    options: AddTileLayerOptions,
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
  chat: Object.freeze([] as CollaborationChatMessage[]) as CollaborationChatMessage[],
  error: null,
});

// Cap the in-store chat log so a long session can't grow it without bound. This
// is intentionally larger than the relay's persisted history (50): the live
// session accumulates messages locally, while the relay only retains the tail
// for late joiners.
const MAX_COLLABORATION_CHAT = 200;

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
function fitGrid(
  total: number,
  preferredCols: number,
): { rows: number; cols: number } {
  if (total <= 1) return { rows: 1, cols: 1 };
  let best: { rows: number; cols: number; empty: number; score: number } | null =
    null;
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
          (score < best.score ||
            (score === best.score && cols > best.cols)));
      if (better) best = { rows, cols, empty, score };
    }
  }
  return best ? { rows: best.rows, cols: best.cols } : { rows: 1, cols: 1 };
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
      models: [],
      widgets: [],
      dashboardColumns: DEFAULT_DASHBOARD_COLUMNS,
      mapLayout: { ...DEFAULT_MAP_GRID_LAYOUT },
      secondaryMapViews: [],
      primaryMapLabel: "",
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
        processingInitialTool: null,
        conversionOpen: null,
        vectorToolOpen: null,
        networkToolOpen: null,
        statisticsToolOpen: null,
        rasterToolOpen: null,
        segmentationOpen: false,
        geocodeOpen: false,
        sqlWorkspaceOpen: false,
        loadEditorFeaturesOpen: false,
        loadEditorFeaturesLayerId: null,
        pythonConsoleOpen: false,
        notebookOpen: false,
        assistantOpen: false,
        attributeTableOpen: false,
        dashboardOpen: false,
        storymapPanelOpen: false,
        storymapPresenting: false,
        storymapReturnToEditor: false,
        storymapComposingId: null,
        modelBuilderOpen: false,
        zoomToSelectedFeature: false,
        collaborateDialogOpen: false,
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
      addCollaborationChat: (message) =>
        set((s) => {
          // Default to [] in case an older relay left the slice undefined.
          const current = s.collaboration.chat ?? [];
          // Ignore a duplicate id: the server broadcasts to the sender too, and a
          // reconnect can replay recent history, so de-dupe defensively.
          if (current.some((m) => m.id === message.id)) return s;
          const chat = [...current, message].slice(-MAX_COLLABORATION_CHAT);
          return { collaboration: { ...s.collaboration, chat } };
        }),
      resetCollaboration: () =>
        // Also close the Collaborate dialog: an unexpected disconnect resets the
        // slice without a user-initiated leave(), and leaving the dialog open
        // would drop the user onto the start/join form with no context.
        set((s) => ({
          collaboration: DEFAULT_COLLABORATION_STATE,
          ui: { ...s.ui, collaborateDialogOpen: false },
        })),
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
      setPrimaryMapLabel: (label) =>
        set({ primaryMapLabel: label, isDirty: true }),
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
          const secondaryMapViews = s.secondaryMapViews.filter(
            (pane) => pane.id !== id
          );
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
      setProcessingInitialTool: (toolId) =>
        set((s) => ({ ui: { ...s.ui, processingInitialTool: toolId } })),
      setConversionOpen: (kind) =>
        set((s) => ({ ui: { ...s.ui, conversionOpen: kind } })),
      setVectorToolOpen: (kind) =>
        set((s) => ({ ui: { ...s.ui, vectorToolOpen: kind } })),
      setNetworkToolOpen: (kind) =>
        set((s) => ({ ui: { ...s.ui, networkToolOpen: kind } })),
      setStatisticsToolOpen: (kind) =>
        set((s) => ({ ui: { ...s.ui, statisticsToolOpen: kind } })),
      setRasterToolOpen: (kind) =>
        set((s) => ({ ui: { ...s.ui, rasterToolOpen: kind } })),
      setSegmentationOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, segmentationOpen: open } })),
      setGeocodeOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, geocodeOpen: open } })),
      setSqlWorkspaceOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, sqlWorkspaceOpen: open } })),
      setLoadEditorFeaturesOpen: (open, layerId) =>
        set((s) => ({
          ui: {
            ...s.ui,
            loadEditorFeaturesOpen: open,
            loadEditorFeaturesLayerId: open ? (layerId ?? null) : null,
          },
        })),
      setPythonConsoleOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, pythonConsoleOpen: open } })),
      setNotebookOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, notebookOpen: open } })),
      setAssistantOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, assistantOpen: open } })),
      setAttributeTableOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, attributeTableOpen: open } })),
      setDashboardOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, dashboardOpen: open } })),
      setStorymapPanelOpen: (open) =>
        set((s) => ({
          ui: {
            ...s.ui,
            storymapPanelOpen: open,
            // Opening the editor must leave compose mode, or the menu item could
            // re-open the dialog while the compose bar is still active over a
            // now-hidden map (#775). Closing (entering compose) leaves it as-is.
            ...(open ? { storymapComposingId: null } : {}),
          },
        })),
      setStorymapPresenting: (presenting, returnToEditor = false) =>
        set((s) => ({
          ui: {
            ...s.ui,
            storymapPresenting: presenting,
            // Track whether exiting should reopen the editor; only meaningful
            // while presenting, so it clears once the presentation ends (#918).
            storymapReturnToEditor: presenting ? returnToEditor : false,
          },
        })),
      setStorymapComposing: (chapterId) =>
        set((s) => ({ ui: { ...s.ui, storymapComposingId: chapterId } })),
      setModelBuilderOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, modelBuilderOpen: open } })),
      setCollaborateDialogOpen: (open) =>
        set((s) => ({ ui: { ...s.ui, collaborateDialogOpen: open } })),
      setZoomToSelectedFeature: (enabled) =>
        set((s) => ({ ui: { ...s.ui, zoomToSelectedFeature: enabled } })),

      saveModel: (model) =>
        set((s) => {
          const exists = s.models.some((m) => m.id === model.id);
          const models = exists
            ? s.models.map((m) => (m.id === model.id ? model : m))
            : [...s.models, model];
          return { models, isDirty: true };
        }),
      deleteModel: (id) =>
        set((s) => ({
          models: s.models.filter((m) => m.id !== id),
          isDirty: true,
        })),

      addWidget: (widget) =>
        set((s) => {
          // Ignore a duplicate id so updateWidget/removeWidget stay unambiguous
          // and a later entry isn't silently dropped when normalized on save.
          if (s.widgets.some((w) => w.id === widget.id)) return s;
          return { widgets: [...s.widgets, widget], isDirty: true };
        }),
      updateWidget: (id, patch) =>
        set((s) => {
          const exists = s.widgets.some((w) => w.id === id);
          if (!exists) return s;
          return {
            widgets: s.widgets.map((w) =>
              w.id === id ? { ...w, ...patch, id: w.id } : w,
            ),
            isDirty: true,
          };
        }),
      removeWidget: (id) =>
        set((s) => ({
          widgets: s.widgets.filter((w) => w.id !== id),
          isDirty: true,
        })),
      moveWidget: (id, toIndex) =>
        set((s) => {
          const from = s.widgets.findIndex((w) => w.id === id);
          if (from < 0) return s;
          const target = Math.max(0, Math.min(s.widgets.length - 1, toIndex));
          if (target === from) return s;
          const widgets = [...s.widgets];
          const [moved] = widgets.splice(from, 1);
          widgets.splice(target, 0, moved);
          return { widgets, isDirty: true };
        }),
      setDashboardColumns: (columns) =>
        set((s) => {
          // Guard non-finite input so the clamp can't yield NaN columns.
          if (!Number.isFinite(columns)) return s;
          return {
            dashboardColumns: Math.max(
              MIN_DASHBOARD_COLUMNS,
              Math.min(MAX_DASHBOARD_COLUMNS, Math.trunc(columns)),
            ),
            isDirty: true,
          };
        }),

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
          // Drop any per-pane visibility override for the removed layer so stale
          // ids don't accumulate (and serialize) in secondary panes over time.
          secondaryMapViews: s.secondaryMapViews.map((pane) => {
            if (!(id in pane.layerVisibility)) return pane;
            const { [id]: _removed, ...rest } = pane.layerVisibility;
            return { ...pane, layerVisibility: rest };
          }),
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
          style: {
            ...DEFAULT_LAYER_STYLE,
            simpleStyleEnabled: hasSimpleStyleProperties(geojson),
          },
          metadata: {},
          geojson,
          sourcePath,
        };
        get().addLayer(layer, beforeLayerId);
        return id;
      },

      addImageOverlayLayer: (name, source, options, beforeLayerId = null) => {
        const id = uuidv4();
        const layer: GeoLibreLayer = {
          id,
          name,
          type: "image",
          source: { type: "image", url: source.url, coordinates: source.coordinates },
          visible: options?.visible ?? true,
          opacity: options?.opacity ?? 1,
          style: { ...DEFAULT_LAYER_STYLE },
          metadata: {
            sourceKind: "kml-ground-overlay",
            ...(options?.bounds ? { bounds: options.bounds } : {}),
            ...(options?.timeSpan ? { timeSpan: options.timeSpan } : {}),
          },
          ...(options?.sourcePath ? { sourcePath: options.sourcePath } : {}),
        };
        get().addLayer(layer, beforeLayerId);
        return id;
      },

      addTileLayer: (name, options, beforeLayerId = null) => {
        const id = uuidv4();
        // Trim each template and drop blanks, then reject a registration that
        // sanitizes down to nothing: syncRasterTileLayer returns early on an
        // empty tile list, so without this the store would persist and select a
        // layer that can never render.
        const tiles = options.tiles
          .filter((tile): tile is string => typeof tile === "string")
          .map((tile) => tile.trim())
          .filter((tile) => tile !== "");
        if (tiles.length === 0) {
          throw new Error(
            "addTileLayer requires at least one non-empty tile URL template."
          );
        }
        // MapLibre's addSource throws synchronously when maxzoom < minzoom, and
        // syncRasterTileLayer does not catch it, which would strand a layer in
        // the store with no rendered source. Reject the bad range up front.
        if (
          options.minzoom !== undefined &&
          options.maxzoom !== undefined &&
          options.minzoom > options.maxzoom
        ) {
          throw new Error(
            `addTileLayer: minzoom (${options.minzoom}) must be <= maxzoom (${options.maxzoom}).`
          );
        }
        const layer: GeoLibreLayer = {
          id,
          name,
          type: options.type ?? "xyz",
          source: {
            // Extra source fields (e.g. WMS layers/styles) merge first so the
            // required raster descriptor below always wins.
            ...(options.source ?? {}),
            type: "raster",
            tiles,
            tileSize: options.tileSize ?? 256,
            ...(options.url !== undefined ? { url: options.url } : {}),
            ...(options.attribution !== undefined
              ? { attribution: options.attribution }
              : {}),
            ...(options.bounds !== undefined ? { bounds: options.bounds } : {}),
            ...(options.minzoom !== undefined
              ? { minzoom: options.minzoom }
              : {}),
            ...(options.maxzoom !== undefined
              ? { maxzoom: options.maxzoom }
              : {}),
            ...(options.scheme !== undefined ? { scheme: options.scheme } : {}),
          },
          visible: options.visible ?? true,
          opacity: options.opacity ?? 1,
          style: { ...DEFAULT_LAYER_STYLE },
          metadata: { ...(options.metadata ?? {}) },
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
          ui: {
            ...s.ui,
            storymapPresenting: false,
            storymapReturnToEditor: false,
            storymapPanelOpen: false,
            storymapComposingId: null,
          },
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
            // A bundled story auto-presents for viewing, so exiting it should
            // not pop open the editor (#918).
            storymapReturnToEditor: false,
            storymapPanelOpen: false,
            storymapComposingId: null,
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

// Mirror the project's ellipsoid into the module-level singleton the
// measurement helpers read. One subscription covers every path that changes
// preferences (setPreferences, load/new project, undo/redo) without threading
// the value through each call site. The subscription runs on every store
// mutation (e.g. setPointerCoords on each mousemove), so guard on the id to skip
// the redundant work for a value that changes at most once per session.
let lastEllipsoidId = useAppStore.getState().preferences.map.ellipsoidId;
setActiveEllipsoidId(lastEllipsoidId);
useAppStore.subscribe((state) => {
  const id = state.preferences.map.ellipsoidId;
  if (id === lastEllipsoidId) return;
  lastEllipsoidId = id;
  setActiveEllipsoidId(id);
});

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
