/**
 * UI-only state: which dialogs and panels are open, and the one-shot requests
 * they consume. Lives in the `ui` sub-state, which the undo history never
 * tracks (see `undo-history.ts`), so opening or closing a dialog never records
 * an undo step and undo/redo never toggles one.
 */
import type { ProcessingRerunRequest } from "../types";
import type { SliceCreator } from "./types";

export type ConversionToolKind =
  | "vector-to-vector"
  | "vector-to-geoparquet"
  | "vector-to-flatgeobuf"
  | "vector-to-shapefile"
  | "vector-to-geopackage"
  | "csv-to-geoparquet"
  | "vector-to-pmtiles"
  | "raster-to-pmtiles"
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
  | "random-extract"
  | "reproject"
  | "explode"
  | "aggregate"
  | "smooth"
  | "extract-vertices"
  | "points-along-geometry"
  | "grid"
  | "voronoi"
  | "cell-sectors"
  | "dggs-grid"
  | "dggs-bin"
  | "dggs-compact"
  | "trajectory-speed"
  | "detect-stops"
  | "space-time-proximity"
  | "decode-polyline"
  | "encode-polyline"
  | "merge-layers"
  | "check-validity"
  | "fix-geometries"
  | "check-topology-rules"
  | "fix-topology";

/** Identifiers of the network-analysis tools (`NETWORK_TOOLS` ids). */
export type NetworkToolKind = "isochrone" | "od-matrix" | "sequential-route";

/** Identifiers of the spatial-statistics tools (`STATISTICS_TOOLS` ids). */
export type StatisticsToolKind =
  | "global-morans-i"
  | "local-morans-i"
  | "getis-ord-gi"
  | "average-nearest-neighbor"
  | "kernel-density"
  | "emerging-hot-spot"
  | "composite-score";

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

export interface UiSlice {
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
    objectDetectionOpen: boolean;
    segmentEverythingOpen: boolean;
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
    /** Whether the Raster Attribute Table bottom panel is open (issue #1307). */
    rasterAttributeTableOpen: boolean;
    dashboardOpen: boolean;
    storymapPanelOpen: boolean;
    storymapPresenting: boolean;
    // True when the active presentation was launched from the editor, so exiting
    // it reopens the Story Map editor instead of dropping to the bare map
    // (#918). Auto-presented projects (opened for viewing) leave this false.
    storymapReturnToEditor: boolean;
    /**
     * Layer opacities the active story presentation has applied so far, keyed
     * by store layer id. Playback fades layers by writing MapLibre paint
     * properties directly (never the persisted `layers[].opacity`), so this is
     * how renderers outside MapLibre's paint model (deck.gl diagrams, 3D
     * Z-value geometry) and the on-map Legend follow a chapter's fades. Empty
     * while not presenting; never saved with the project.
     */
    storymapLayerOpacity: Record<string, number>;
    // Id of the chapter currently being composed on the live map. When set, the
    // Story Map dialog is hidden so the user can pan/zoom/tilt the real map and
    // save the resulting camera back into this chapter (issue #775).
    storymapComposingId: string | null;
    /** The Batch tools dialog (run one tool across many layers). */
    batchToolsOpen: boolean;
    /** The Model Builder canvas panel (author a processing graph). */
    modelBuilderOpen: boolean;
    /** One-shot request for Model Builder to load a saved model. */
    modelBuilderRequestedModelId: string | null;
    /** Style Manager dialog visibility (issue #1294). */
    styleManagerOpen: boolean;
    /** Processing History panel visibility (#1292). */
    processingHistoryOpen: boolean;
    /** Select by Expression dialog visibility (#1314). */
    selectByExpressionOpen: boolean;
    // Layer preselected in the Select by Expression dialog when it is opened
    // from a layer's context menu, or null when opened without a target.
    // Deliberately not selectLayer(): that would clear the live selection the
    // dialog's add/remove/intersect modes need to combine with.
    selectByExpressionLayerId: string | null;
    /** Select by Location dialog visibility (#1314). */
    selectByLocationOpen: boolean;
    /** Same contract as `selectByExpressionLayerId`, for Select by Location. */
    selectByLocationLayerId: string | null;
    /**
     * Pending "re-run from History" request. Written by the History panel just
     * before it opens the target processing dialog; consumed and cleared by
     * that dialog once it has pre-filled its parameter form. Null when idle.
     */
    processingRerun: ProcessingRerunRequest | null;
    zoomToSelectedFeature: boolean;
    // Live-collaboration dialog visibility. Lifted into the store (rather than
    // local toolbar state) so the on-canvas session-status badge can reopen the
    // Collaborate dialog from outside the toolbar's component tree (#754).
    collaborateDialogOpen: boolean;
  };

  setProcessingOpen: (open: boolean) => void;
  setProcessingInitialTool: (toolId: string | null) => void;
  setConversionOpen: (kind: ConversionToolKind | null) => void;
  setVectorToolOpen: (kind: VectorToolKind | null) => void;
  setNetworkToolOpen: (kind: NetworkToolKind | null) => void;
  setStatisticsToolOpen: (kind: StatisticsToolKind | null) => void;
  setRasterToolOpen: (kind: RasterToolKind | null) => void;
  setSegmentationOpen: (open: boolean) => void;
  setObjectDetectionOpen: (open: boolean) => void;
  setSegmentEverythingOpen: (open: boolean) => void;
  setGeocodeOpen: (open: boolean) => void;
  setSqlWorkspaceOpen: (open: boolean) => void;
  setLoadEditorFeaturesOpen: (open: boolean, layerId?: string | null) => void;
  setPythonConsoleOpen: (open: boolean) => void;
  setNotebookOpen: (open: boolean) => void;
  setAssistantOpen: (open: boolean) => void;
  setAttributeTableOpen: (open: boolean) => void;
  setRasterAttributeTableOpen: (open: boolean) => void;
  setDashboardOpen: (open: boolean) => void;
  setStorymapPanelOpen: (open: boolean) => void;
  setStorymapPresenting: (presenting: boolean, returnToEditor?: boolean) => void;
  /**
   * Record the layer opacities a story chapter applied, merging into the
   * presentation's running map (see `ui.storymapLayerOpacity`).
   */
  setStorymapLayerOpacity: (changes: Record<string, number>) => void;
  setStorymapComposing: (chapterId: string | null) => void;
  setBatchToolsOpen: (open: boolean) => void;
  setModelBuilderOpen: (open: boolean) => void;
  setModelBuilderRequestedModelId: (id: string | null) => void;
  setProcessingHistoryOpen: (open: boolean) => void;
  /** Open/close Select by Expression, optionally preselecting a target layer. */
  setSelectByExpressionOpen: (open: boolean, layerId?: string | null) => void;
  /** Open/close Select by Location, optionally preselecting a target layer. */
  setSelectByLocationOpen: (open: boolean, layerId?: string | null) => void;
  setProcessingRerun: (request: ProcessingRerunRequest | null) => void;
  setCollaborateDialogOpen: (open: boolean) => void;
  setZoomToSelectedFeature: (enabled: boolean) => void;
  setStyleManagerOpen: (open: boolean) => void;
}

export const createUiSlice: SliceCreator<UiSlice> = (set) => ({
  ui: {
    processingOpen: false,
    processingInitialTool: null,
    conversionOpen: null,
    vectorToolOpen: null,
    networkToolOpen: null,
    statisticsToolOpen: null,
    rasterToolOpen: null,
    segmentationOpen: false,
    objectDetectionOpen: false,
    segmentEverythingOpen: false,
    geocodeOpen: false,
    sqlWorkspaceOpen: false,
    loadEditorFeaturesOpen: false,
    loadEditorFeaturesLayerId: null,
    pythonConsoleOpen: false,
    notebookOpen: false,
    assistantOpen: false,
    attributeTableOpen: false,
    rasterAttributeTableOpen: false,
    dashboardOpen: false,
    storymapPanelOpen: false,
    storymapPresenting: false,
    storymapReturnToEditor: false,
    storymapLayerOpacity: {},
    storymapComposingId: null,
    batchToolsOpen: false,
    modelBuilderOpen: false,
    modelBuilderRequestedModelId: null,
    styleManagerOpen: false,
    processingHistoryOpen: false,
    selectByExpressionOpen: false,
    selectByExpressionLayerId: null,
    selectByLocationOpen: false,
    selectByLocationLayerId: null,
    processingRerun: null,
    zoomToSelectedFeature: false,
    collaborateDialogOpen: false,
  },

  setProcessingOpen: (open) => set((s) => ({ ui: { ...s.ui, processingOpen: open } })),
  setProcessingInitialTool: (toolId) =>
    set((s) => ({ ui: { ...s.ui, processingInitialTool: toolId } })),
  setConversionOpen: (kind) => set((s) => ({ ui: { ...s.ui, conversionOpen: kind } })),
  setVectorToolOpen: (kind) =>
    set((s) => ({
      ui: {
        ...s.ui,
        // Pre-DGGS projects / callers may still pass h3-grid / h3-bin-points.
        vectorToolOpen:
          (kind as string | null) === "h3-grid"
            ? "dggs-grid"
            : (kind as string | null) === "h3-bin-points"
              ? "dggs-bin"
              : kind,
      },
    })),
  setNetworkToolOpen: (kind) => set((s) => ({ ui: { ...s.ui, networkToolOpen: kind } })),
  setStatisticsToolOpen: (kind) => set((s) => ({ ui: { ...s.ui, statisticsToolOpen: kind } })),
  setRasterToolOpen: (kind) => set((s) => ({ ui: { ...s.ui, rasterToolOpen: kind } })),
  setSegmentationOpen: (open) => set((s) => ({ ui: { ...s.ui, segmentationOpen: open } })),
  setObjectDetectionOpen: (open) => set((s) => ({ ui: { ...s.ui, objectDetectionOpen: open } })),
  setSegmentEverythingOpen: (open) =>
    set((s) => ({ ui: { ...s.ui, segmentEverythingOpen: open } })),
  setGeocodeOpen: (open) => set((s) => ({ ui: { ...s.ui, geocodeOpen: open } })),
  setSqlWorkspaceOpen: (open) => set((s) => ({ ui: { ...s.ui, sqlWorkspaceOpen: open } })),
  setLoadEditorFeaturesOpen: (open, layerId) =>
    set((s) => ({
      ui: {
        ...s.ui,
        loadEditorFeaturesOpen: open,
        loadEditorFeaturesLayerId: open ? (layerId ?? null) : null,
      },
    })),
  setPythonConsoleOpen: (open) => set((s) => ({ ui: { ...s.ui, pythonConsoleOpen: open } })),
  setNotebookOpen: (open) => set((s) => ({ ui: { ...s.ui, notebookOpen: open } })),
  setAssistantOpen: (open) => set((s) => ({ ui: { ...s.ui, assistantOpen: open } })),
  setAttributeTableOpen: (open) => set((s) => ({ ui: { ...s.ui, attributeTableOpen: open } })),
  setRasterAttributeTableOpen: (open) =>
    set((s) => ({ ui: { ...s.ui, rasterAttributeTableOpen: open } })),
  setDashboardOpen: (open) => set((s) => ({ ui: { ...s.ui, dashboardOpen: open } })),
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
        // A presentation starts from (and leaves behind) a clean slate; the
        // fades it applies are replayed from chapter 0 on the next run.
        storymapLayerOpacity: {},
      },
    })),
  setStorymapLayerOpacity: (changes) =>
    set((s) => {
      const next = { ...s.ui.storymapLayerOpacity };
      let changed = false;
      for (const [layerId, opacity] of Object.entries(changes)) {
        const clamped = Math.min(1, Math.max(0, opacity));
        if (next[layerId] === clamped) continue;
        next[layerId] = clamped;
        changed = true;
      }
      // Return the current state untouched when nothing moved: Zustand only
      // skips the listener broadcast for the same state reference, and a
      // chapter re-entering the same opacities would otherwise rebuild
      // every store subscriber's view.
      return changed ? { ui: { ...s.ui, storymapLayerOpacity: next } } : s;
    }),
  setStorymapComposing: (chapterId) =>
    set((s) => ({ ui: { ...s.ui, storymapComposingId: chapterId } })),
  setBatchToolsOpen: (open) => set((s) => ({ ui: { ...s.ui, batchToolsOpen: open } })),
  setModelBuilderOpen: (open) => set((s) => ({ ui: { ...s.ui, modelBuilderOpen: open } })),
  setModelBuilderRequestedModelId: (id) =>
    set((s) => ({ ui: { ...s.ui, modelBuilderRequestedModelId: id } })),
  setProcessingHistoryOpen: (open) =>
    set((s) => ({ ui: { ...s.ui, processingHistoryOpen: open } })),
  setProcessingRerun: (request) => set((s) => ({ ui: { ...s.ui, processingRerun: request } })),
  setSelectByExpressionOpen: (open, layerId) =>
    set((s) => ({
      ui: {
        ...s.ui,
        selectByExpressionOpen: open,
        selectByExpressionLayerId: open ? (layerId ?? null) : null,
      },
    })),
  setSelectByLocationOpen: (open, layerId) =>
    set((s) => ({
      ui: {
        ...s.ui,
        selectByLocationOpen: open,
        selectByLocationLayerId: open ? (layerId ?? null) : null,
      },
    })),
  setCollaborateDialogOpen: (open) =>
    set((s) => ({ ui: { ...s.ui, collaborateDialogOpen: open } })),
  setZoomToSelectedFeature: (enabled) =>
    set((s) => ({ ui: { ...s.ui, zoomToSelectedFeature: enabled } })),

  setStyleManagerOpen: (open) => set((s) => ({ ui: { ...s.ui, styleManagerOpen: open } })),
});
