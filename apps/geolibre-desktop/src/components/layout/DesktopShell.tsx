// @refresh reset
import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type { MapController, MapDiagnosticEvent } from "@geolibre/map";
import { getLayerBounds, MapCanvas, setExternalDeckLayerOrderHandler } from "@geolibre/map";
import { useTranslation } from "react-i18next";
import {
  addRasterToMap,
  prepareRasterControl,
  applyRasterLayerOrder,
  applyStacSearchLayerOrder,
  DECK_VIZ_PLUGIN_ID,
  DIRECTIONS_PLUGIN_ID,
  EFFECTS_PLUGIN_ID,
  endLayerGeometryEdit,
  GEO_EDITOR_PLUGIN_ID,
  getGeometryEditTargetLayerId,
  openRasterLayerPanel,
  getRightPanel,
  restoreDeckViz,
  restoreDirections,
  restoreReverseGeocode,
  REVERSE_GEOCODE_PLUGIN_ID,
  restoreEffects,
  restoreLidarLayers,
  restorePlanetaryComputerLayers,
  reattachSun,
  reattachRouteAnimation,
  reattachFlightSimulator,
  restoreArcGISViewportLayers,
  restoreRasterLayers,
  restoreThreeDTilesLayers,
  restoreVectorLayers,
  setBookmarkLabels,
  setLocalRasterFileReader,
  setLocalRasterPicker,
  setNonTiledRasterHandler,
  setKmlFileImportHandler,
  setTerrainMeasureLabels,
  setViewStateLabels,
  startLayerGeometryEdit,
  subscribeGeometryEdit,
  TIME_SLIDER_PLUGIN_ID,
  VIEWER_BLOCKED_PLUGIN_IDS,
} from "@geolibre/plugins";
import { convertGeoTiffToCog, isTiff, readGeoTiffInfo } from "@geolibre/processing";
import {
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { BROWSER_PANEL_ID, useRegisterBrowserPanel } from "../../hooks/useRegisterBrowserPanel";
import { COMMENTS_PANEL_ID, useRegisterCommentsPanel } from "../../hooks/useRegisterCommentsPanel";
import { CommentsPanel } from "../comments/CommentsPanel";
import { CommentMapOverlay } from "../comments/CommentMapOverlay";
import { useCommentTool } from "../comments/useCommentTool";
import { AddCommentDialog } from "../comments/AddCommentDialog";
import { openRightPanel } from "@geolibre/plugins";
import { getIsMobileViewport } from "../../hooks/useIsMobileViewport";
import { useProjectFileActions } from "../../hooks/useProjectFileActions";
import { useProjectHistory } from "../../hooks/useProjectHistory";
import {
  isRasterFileName,
  isTauri,
  loadDroppedPhotoFiles,
  loadDroppedPhotoPaths,
  loadDroppedRasterFiles,
  loadDroppedRasterPaths,
  pickLocalRasterFiles,
  readRasterFileAtPath,
  isLoadedImageOverlay,
  isLoadedKmlSuperOverlay,
  isLoadedModel,
  loadDroppedVectorFiles,
  loadDroppedVectorPaths,
  type DroppedRaster,
} from "../../lib/tauri-io";
import { buildKmlModelLayer } from "../../lib/kml-model-layer";
import { isPhotoDropFileName, type GeotaggedPhotoResult } from "../../lib/geotagged-photos";
import type { LargeVectorDataset } from "../../lib/duckdb-vector-guard";
import { detectNonGeographicCoordinates } from "@geolibre/core";
import { PANEL_RESIZE_END_EVENT, PANEL_RESIZE_START_EVENT } from "../../lib/panel-resize";
import i18n from "../../i18n";
import {
  addOsmPbfLayers,
  isOsmPbfFileName,
  loadOsmPbf,
  osmPbfBaseName,
  OsmPbfTooLargeError,
  OSM_PBF_SIZE_WARN_BYTES,
} from "../../lib/osm-pbf-loader";
import { restoreLocalFileLayers } from "../../lib/restore-local-layers";
import {
  createAppAPI,
  getPluginManager,
  useExternalPluginsReady,
  usePluginRegistry,
  useProjectPluginTrust,
  useSwipeSplitViewExclusivity,
  useTimeSliderAutoClose,
} from "../../hooks/usePlugins";
import type { DataUrlLoadState } from "../../hooks/useDataUrlLoader";
import { registerKmlSuperOverlayProtocol } from "../../lib/kml-super-overlay";
import { registerMbtilesProtocol } from "../../lib/mbtiles";
import { hasReverseGeocodeConsent } from "../../lib/reverse-geocode-consent";
import { hasKnowledgeCardConsent, recordKnowledgeCardConsent } from "../../lib/knowledge-consent";
import { wikipediaLang } from "../../lib/knowledge";
import { registerXyzTileProtocol } from "../../lib/xyz-url";
import { useEmbedBridge } from "../../hooks/useEmbedBridge";
import { useRasterIdentify } from "../../hooks/useRasterIdentify";
import { useNetcdfIdentify } from "../../hooks/useNetcdfIdentify";
import { useCogSpectralIdentify } from "../../hooks/useCogSpectralIdentify";
import {
  useAutoCollapsedPanel,
  useReplaceLayersPanelId,
  useReplaceStylePanelId,
  useRightPanelState,
} from "../../hooks/useRightPanels";
import { BoundsRestrictionIndicator } from "./BoundsRestrictionIndicator";
import { CollaborationStatusBadge } from "./CollaborationStatusBadge";
import { CollaborateDialog } from "./CollaborateDialog";
import { useCollaboration } from "../../hooks/useCollaboration";
import { MapModeBanner } from "./MapModeBanner";
import { QuickAnalysisBanner } from "./QuickAnalysisBanner";
import { PixelTimeSeriesControl } from "./PixelTimeSeriesControl";
import { NetcdfSampleMarkers } from "./NetcdfSampleMarkers";
import { NetcdfCubeSetupDialog } from "./NetcdfCubeSetupDialog";
import { NetcdfCubeWindow } from "./NetcdfCubeWindow";
import { NetcdfProfileWindow } from "./NetcdfProfileWindow";
import { hasElevationConsent } from "../../lib/elevation-consent";
import { MapLegendPanel } from "../legend/MapLegendPanel";
import { RasterSubsetPanel } from "./RasterSubsetPanel";
import { BasemapExtractPanel } from "./BasemapExtractPanel";
import { TerrainSettingsDialog } from "./TerrainSettingsDialog";
import { MapContextMenu } from "./MapContextMenu";
import { KnowledgeCardPanel, type KnowledgePlace } from "./KnowledgeCardPanel";
import { KnowledgeCardConsentDialog } from "./KnowledgeCardConsentDialog";
import { MapGrid } from "./MapGrid";
import { RemoteCursorsOverlay } from "./RemoteCursorsOverlay";
import { useCommandBridge } from "../../hooks/useCommandBridge";
import { useEmbedApi } from "../../hooks/useEmbedApi";
import { useJupyterRelay } from "../../hooks/useJupyterRelay";
import { appendDiagnostic, useDiagnosticsSnapshot } from "../../lib/diagnostics";
import { SectionErrorBoundary, SilentErrorBoundary } from "../common/error-boundaries";
import { AttributeTable } from "../panels/AttributeTable";
import { RasterAttributeTable } from "../panels/RasterAttributeTable";
import { BrowserPanel } from "../panels/BrowserPanel";
import { LayerPanel } from "../panels/LayerPanel";
import { ViewerLayerPanel } from "../panels/ViewerLayerPanel";
import { FloatingPanels } from "../panels/FloatingPanels";
import { SunPanel } from "../panels/SunPanel";
import { RouteAnimationPanel } from "../panels/RouteAnimationPanel";
import { FlightSimulatorPanel } from "../panels/FlightSimulatorPanel";
import {
  PluginRightPanel,
  PLUGIN_PANEL_DEFAULT_WIDTH,
  clampPluginPanelWidth,
} from "../panels/PluginRightPanel";
import { StylePanel } from "../panels/StylePanel";
import { SharedSidebar } from "../panels/SharedSidebar";
import { Layers, SlidersHorizontal } from "lucide-react";
import { StoryMapComposeBar } from "../storymap/StoryMapComposeBar";
import { StoryMapPanel } from "../storymap/StoryMapPanel";
import { StoryMapPresenter } from "../storymap/StoryMapPresenter";
import { DiagnosticsDialog } from "./DiagnosticsDialog";
import { FileNamePromptDialog } from "./FileNamePromptDialog";
import { ProjectPluginTrustDialog } from "./ProjectPluginTrustDialog";
import { ProjectHistoryDialog } from "./ProjectHistoryDialog";
import { ProjectRecoveryDialog } from "./ProjectRecoveryDialog";
import { StatusBar } from "./StatusBar";
import { TopToolbar } from "./TopToolbar";
import type { LayoutOptions } from "../../hooks/useLayoutOptions";
import type { ThemeMode } from "../../hooks/useThemeMode";
import type { ProjectUrlLoadState } from "../../hooks/useProjectUrlLoader";

/**
 * Confirm loading a vector source whose feature count tripped the loader's
 * large-dataset guard. Mirrors the OSM PBF drop guard's blocking
 * `window.confirm` (see the handlers below): a `false` return aborts that one
 * file's load without affecting the rest of a multi-file drop.
 */
/**
 * Sample count (width × height × bands) above which in-browser COG conversion
 * gets an extra "this may be slow / memory-intensive" confirmation. The
 * converter reads the whole raster into memory as f64, so ~40M samples is
 * roughly where the transient allocation starts to be felt.
 */
const LARGE_RASTER_SAMPLE_LIMIT = 40_000_000;

function confirmLargeVectorDataset({ name, featureCount }: LargeVectorDataset) {
  return window.confirm(
    i18n.t("toolbar.item.largeVectorDesc", {
      name,
      count: featureCount.toLocaleString(),
    }),
  );
}

const ProcessingDialog = lazy(() =>
  import("../processing/ProcessingDialog")
    .then((module) => ({
      default: module.ProcessingDialog,
    }))
    .catch((error) => {
      // A failed chunk load (network error, corrupted bundle) would otherwise
      // throw during render and unmount the whole shell. Fall back to a
      // no-op component so the rest of the app stays interactive.
      console.error("Failed to load ProcessingDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/ProcessingDialog").ProcessingDialog;
      return { default: Fallback };
    }),
);

const ConversionDialog = lazy(() =>
  import("../processing/ConversionDialog")
    .then((module) => ({
      default: module.ConversionDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load ConversionDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/ConversionDialog").ConversionDialog;
      return { default: Fallback };
    }),
);

const StyleManagerPanel = lazy(() =>
  import("../panels/StyleManagerPanel")
    .then((module) => ({
      default: module.StyleManagerPanel,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load StyleManagerPanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../panels/StyleManagerPanel").StyleManagerPanel;
      return { default: Fallback };
    }),
);

const VectorToolsDialog = lazy(() =>
  import("../processing/VectorToolsDialog")
    .then((module) => ({
      default: module.VectorToolsDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load VectorToolsDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/VectorToolsDialog").VectorToolsDialog;
      return { default: Fallback };
    }),
);

const ModelBuilderDialog = lazy(() =>
  import("../processing/ModelBuilderDialog")
    .then((module) => ({
      default: module.ModelBuilderDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load ModelBuilderDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/ModelBuilderDialog").ModelBuilderDialog;
      return { default: Fallback };
    }),
);

const NetworkToolsDialog = lazy(() =>
  import("../processing/NetworkToolsDialog")
    .then((module) => ({
      default: module.NetworkToolsDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load NetworkToolsDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/NetworkToolsDialog").NetworkToolsDialog;
      return { default: Fallback };
    }),
);

const StatisticsToolsDialog = lazy(() =>
  import("../processing/StatisticsToolsDialog")
    .then((module) => ({
      default: module.StatisticsToolsDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load StatisticsToolsDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/StatisticsToolsDialog").StatisticsToolsDialog;
      return { default: Fallback };
    }),
);

const ProcessingHistoryDialog = lazy(() =>
  import("../processing/ProcessingHistoryDialog")
    .then((module) => ({
      default: module.ProcessingHistoryDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load ProcessingHistoryDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/ProcessingHistoryDialog").ProcessingHistoryDialog;
      return { default: Fallback };
    }),
);

const SelectByExpressionDialog = lazy(() =>
  import("../selection/SelectByExpressionDialog")
    .then((module) => ({
      default: module.SelectByExpressionDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load SelectByExpressionDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../selection/SelectByExpressionDialog").SelectByExpressionDialog;
      return { default: Fallback };
    }),
);

const SelectByLocationDialog = lazy(() =>
  import("../selection/SelectByLocationDialog")
    .then((module) => ({
      default: module.SelectByLocationDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load SelectByLocationDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../selection/SelectByLocationDialog").SelectByLocationDialog;
      return { default: Fallback };
    }),
);

const GeocodeDialog = lazy(() =>
  import("../processing/GeocodeDialog")
    .then((module) => ({
      default: module.GeocodeDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load GeocodeDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/GeocodeDialog").GeocodeDialog;
      return { default: Fallback };
    }),
);

const RasterToolsDialog = lazy(() =>
  import("../processing/RasterToolsDialog")
    .then((module) => ({
      default: module.RasterToolsDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load RasterToolsDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/RasterToolsDialog").RasterToolsDialog;
      return { default: Fallback };
    }),
);

const SegmentationDialog = lazy(() =>
  import("../processing/SegmentationDialog")
    .then((module) => ({
      default: module.SegmentationDialog,
    }))
    .catch((error) => {
      console.error("Failed to load SegmentationDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/SegmentationDialog").SegmentationDialog;
      return { default: Fallback };
    }),
);

const ObjectDetectionDialog = lazy(() =>
  import("../processing/ObjectDetectionDialog")
    .then((module) => ({
      default: module.ObjectDetectionDialog,
    }))
    .catch((error) => {
      console.error("Failed to load ObjectDetectionDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/ObjectDetectionDialog").ObjectDetectionDialog;
      return { default: Fallback };
    }),
);

const SegmentEverythingPanel = lazy(() =>
  import("../processing/SegmentEverythingPanel")
    .then((module) => ({
      default: module.SegmentEverythingPanel,
    }))
    .catch((error) => {
      console.error("Failed to load SegmentEverythingPanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/SegmentEverythingPanel").SegmentEverythingPanel;
      return { default: Fallback };
    }),
);

const SqlWorkspacePanel = lazy(() =>
  import("../panels/SqlWorkspacePanel")
    .then((module) => ({
      default: module.SqlWorkspacePanel,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load SqlWorkspacePanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../panels/SqlWorkspacePanel").SqlWorkspacePanel;
      return { default: Fallback };
    }),
);

const NotebookPanel = lazy(() =>
  import("../panels/NotebookPanel")
    .then((module) => ({
      default: module.NotebookPanel,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as the dialogs above.
      console.error("Failed to load NotebookPanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../panels/NotebookPanel").NotebookPanel;
      return { default: Fallback };
    }),
);

const AssistantPanel = lazy(() =>
  import("../panels/AssistantPanel")
    .then((module) => ({
      default: module.AssistantPanel,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as the dialogs above.
      console.error("Failed to load AssistantPanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../panels/AssistantPanel").AssistantPanel;
      return { default: Fallback };
    }),
);

const DashboardPanel = lazy(() =>
  import("../panels/DashboardPanel")
    .then((module) => ({
      default: module.DashboardPanel,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as the dialogs above.
      console.error("Failed to load DashboardPanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../panels/DashboardPanel").DashboardPanel;
      return { default: Fallback };
    }),
);

const PythonConsolePanel = lazy(() =>
  import("../panels/PythonConsolePanel")
    .then((module) => ({
      default: module.PythonConsolePanel,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as the dialogs above.
      console.error("Failed to load PythonConsolePanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../panels/PythonConsolePanel").PythonConsolePanel;
      return { default: Fallback };
    }),
);

interface DesktopShellProps {
  layoutOptions: LayoutOptions;
  projectUrlLoadState?: ProjectUrlLoadState;
  dataUrlLoadState?: DataUrlLoadState;
  mapAppAPI: ReturnType<typeof createAppAPI> | null;
  themeMode: ThemeMode;
  onToggleThemeMode: () => void;
  onMapReady?: (app: ReturnType<typeof createAppAPI>) => void;
}

function hasDroppedFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function layerNameFromPath(path: string): string {
  return fileNameFromPath(path).replace(/\.[^.]+$/, "") || "Vector Layer";
}

type ImportedVectorLayer = Awaited<ReturnType<typeof loadDroppedVectorFiles>>[number];

const DEFAULT_SIDE_PANEL_WIDTH = 320;
const MIN_SIDE_PANEL_WIDTH = 180;
const MAX_SIDE_PANEL_WIDTH = 560;
// Width of a side panel's collapsed rail (`md:w-11` = 2.75rem). The Style panel
// stays mounted (collapsed) beside the notebook, so its rail still occupies this
// much of the row when computing the map/notebook 50/50 split.
const COLLAPSED_PANEL_RAIL_WIDTH = 44;
// The notebook panel hosts a full Jupyter UI, so it needs far more room than
// the layer/style side panels.
const DEFAULT_NOTEBOOK_PANEL_WIDTH = 480;
const MIN_NOTEBOOK_PANEL_WIDTH = 320;
const MAX_NOTEBOOK_PANEL_WIDTH = 1100;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Seed width for the Layers/Style side panels. The full default would let two
// open panels crowd out the map on narrow desktop windows (two 320px panels
// leave only 128px at the 768px `md` breakpoint), so cap the initial width at
// ~30% of the viewport. The cap only lowers the width below ~1067px (where 30%
// of the viewport drops under the default); wider windows get the full default.
// Users can still drag up to MAX_SIDE_PANEL_WIDTH either way.
function initialSidePanelWidth(): number {
  if (typeof window === "undefined") return DEFAULT_SIDE_PANEL_WIDTH;
  const cap = Math.round(window.innerWidth * 0.3);
  return clamp(cap, MIN_SIDE_PANEL_WIDTH, DEFAULT_SIDE_PANEL_WIDTH);
}

type ShellStyle = CSSProperties &
  Record<"--layer-panel-width" | "--style-panel-width" | "--notebook-panel-width", string>;

export function DesktopShell({
  layoutOptions,
  projectUrlLoadState,
  dataUrlLoadState,
  mapAppAPI,
  themeMode,
  onToggleThemeMode,
  onMapReady,
}: DesktopShellProps) {
  const { t } = useTranslation();
  const shellRef = useRef<HTMLDivElement>(null);
  const verticalResizeGuideRef = useRef<HTMLDivElement>(null);
  // Push the translated bookmark labels into the framework-agnostic plugins
  // package (which can't call t() itself). Done here rather than in TopToolbar
  // so it still applies when the toolbar is hidden (e.g. `?maponly`), where the
  // BookmarkControl overlay is still present.
  useEffect(() => {
    setBookmarkLabels({
      captureStateLabel: t("bookmark.captureStateLabel"),
      captureStateTooltip: t("bookmark.captureStateTooltip"),
      exportLabel: t("bookmark.export"),
      exportSelectedLabel: t("bookmark.exportSelected"),
      exportAllLabel: t("bookmark.exportAll"),
      newFolderLabel: t("bookmark.newFolder"),
      defaultFolderName: t("bookmark.defaultFolderName"),
    });
    setViewStateLabels({ title: t("viewState.panelTitle") });
    setTerrainMeasureLabels({
      title: t("terrainMeasure.title"),
      surfaceDistance: t("terrainMeasure.surfaceDistance"),
      surfaceArea: t("terrainMeasure.surfaceArea"),
      elevationGainLoss: t("terrainMeasure.elevationGainLoss"),
      elevationRange: t("terrainMeasure.elevationRange"),
      meanSlope: t("terrainMeasure.meanSlope"),
      computing: t("terrainMeasure.computing"),
      partialData: t("terrainMeasure.partialData"),
      heading: t("terrainMeasure.heading"),
      finalHeading: t("terrainMeasure.finalHeading"),
    });
  }, [t]);
  // The map's Fullscreen control maximizes the map *canvas* (it calls
  // requestFullscreen on the map container). Chromium promotes that element to
  // the browser top layer, so the toolbar and side panels are hidden for free.
  // WebKit (the Tauri desktop webview) does not: it grows the map container to
  // fill the window but leaves the surrounding chrome painted around and on top
  // of it (opengeos/GeoLibre#611). Mirror the fullscreen state onto the shell as
  // `data-map-fullscreen` so CSS can hide that chrome on every engine, leaving a
  // clean map-only view. document.fullscreenElement is set even on WebKit.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const sync = () => {
      const fsEl =
        document.fullscreenElement ??
        (document as Document & { webkitFullscreenElement?: Element | null })
          .webkitFullscreenElement ??
        null;
      shell.toggleAttribute("data-map-fullscreen", !!fsEl && shell.contains(fsEl));
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    sync();
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);
  // Teardown for an in-progress panel resize, so a pointercancel or an unmount
  // mid-drag still detaches the global listeners and restores document.body.
  const activeResizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => activeResizeCleanupRef.current?.(), []);
  const mapControllerRef = useRef<MapController | null>(null);

  // Frame the GeoJSON layers a `?data=` deep link added. Only those are listed:
  // the raster, PMTiles, and GeoParquet loaders move the camera themselves. The
  // extent comes from the store's own GeoJSON, which is already in memory by the
  // time the hook publishes the ids, so this needs no wait for layer sync.
  useEffect(() => {
    const fitLayerIds = dataUrlLoadState?.fitLayerIds;
    if (dataUrlLoadState?.status !== "loaded" || !fitLayerIds?.length) return;
    const controller = mapControllerRef.current;
    if (!controller) return;
    const bounds = useAppStore
      .getState()
      .layers.filter((layer) => fitLayerIds.includes(layer.id))
      .map(getLayerBounds)
      .filter((value) => value !== null);
    if (!bounds.length) return;
    controller.fitBounds([
      Math.min(...bounds.map((value) => value[0])),
      Math.min(...bounds.map((value) => value[1])),
      Math.max(...bounds.map((value) => value[2])),
      Math.max(...bounds.map((value) => value[3])),
    ]);
  }, [dataUrlLoadState?.fitLayerIds, dataUrlLoadState?.status]);

  const projectHistory = useProjectHistory(mapControllerRef);
  const [projectHistoryOpen, setProjectHistoryOpen] = useState(false);
  // The place shown in the Wikipedia knowledge card, or null when it is closed.
  // `pendingKnowledgePlace` holds the target while the one-time consent notice
  // is open, so it can be applied only after the user acknowledges it.
  const [knowledgePlace, setKnowledgePlace] = useState<KnowledgePlace | null>(null);
  const [pendingKnowledgePlace, setPendingKnowledgePlace] = useState<KnowledgePlace | null>(null);
  const [knowledgeNoticeOpen, setKnowledgeNoticeOpen] = useState(false);
  // Open a knowledge card for a clicked point, gating the first lookup behind a
  // one-time privacy notice since it sends the coordinate to Wikipedia.
  const handleExplorePlace = useCallback((lat: number, lng: number) => {
    if (hasKnowledgeCardConsent()) {
      setKnowledgePlace({ lat, lng });
    } else {
      setPendingKnowledgePlace({ lat, lng });
      setKnowledgeNoticeOpen(true);
    }
  }, []);
  const confirmKnowledgeConsent = useCallback(() => {
    recordKnowledgeCardConsent();
    setKnowledgeNoticeOpen(false);
    setKnowledgePlace(pendingKnowledgePlace);
    setPendingKnowledgePlace(null);
  }, [pendingKnowledgePlace]);
  // Stable identity (mapControllerRef is a ref) so the card's openNearby
  // useCallback, which depends on this, keeps its memoization across renders.
  const handleKnowledgeFlyTo = useCallback((lat: number, lon: number) => {
    mapControllerRef.current?.flyTo({
      center: [lon, lat],
      zoom: Math.max(mapControllerRef.current?.getMap()?.getZoom() ?? 12, 14),
    });
  }, []);
  // The COG/WMS/XYZ layer whose bounding-box subset is being extracted in the
  // floating Extract Subset panel, or null when that panel is closed.
  const [rasterSubsetLayer, setRasterSubsetLayer] = useState<GeoLibreLayer | null>(null);
  // Whether that layer still exists in the store; subscribe to the derived
  // boolean (not the whole layers array) so this large component only re-renders
  // when it flips. Close the panel if its layer is removed, matching how
  // LayerPanel clears its own per-layer dialog state.
  const rasterSubsetLayerExists = useAppStore((s) =>
    rasterSubsetLayer ? s.layers.some((layer) => layer.id === rasterSubsetLayer.id) : true,
  );
  useEffect(() => {
    if (rasterSubsetLayer && !rasterSubsetLayerExists) {
      setRasterSubsetLayer(null);
    }
  }, [rasterSubsetLayer, rasterSubsetLayerExists]);
  // The Offline Basemap Extract panel is a non-modal floating panel over the
  // map (so the map stays interactive for drawing a bbox), mounted here beside
  // the Raster Subset panel and opened from the Add Data menu in the toolbar.
  const [basemapExtractOpen, setBasemapExtractOpen] = useState(false);
  const dragDepthRef = useRef(0);
  const dropMessageTimeoutRef = useRef<number | null>(null);
  const materializingRef = useRef(false);
  const togglingGeometryEditRef = useRef(false);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const addImageOverlayLayer = useAppStore((s) => s.addImageOverlayLayer);
  const addTileLayer = useAppStore((s) => s.addTileLayer);
  const addLayerGroup = useAppStore((s) => s.addLayerGroup);
  const { isActive: isPluginActive, toggle: togglePlugin } = usePluginRegistry();
  const addLayer = useAppStore((s) => s.addLayer);
  const projectGeneration = useAppStore((s) => s.projectGeneration);
  const pythonConsoleOpen = useAppStore((s) => s.ui.pythonConsoleOpen);
  const setPythonConsoleOpen = useAppStore((s) => s.setPythonConsoleOpen);
  const sqlWorkspaceOpen = useAppStore((s) => s.ui.sqlWorkspaceOpen);
  const setSqlWorkspaceOpen = useAppStore((s) => s.setSqlWorkspaceOpen);
  // Register the Browser as a movable/dockable right panel; its body is portaled
  // into a dedicated content host (below) that the dock slots adopt.
  useRegisterBrowserPanel();
  useRegisterCommentsPanel();
  // One shared project-file-actions instance for both the toolbar and the
  // Browser panel, so their "open recent" calls coordinate their aborts (two
  // instances would race). Lifted here for the same reason as `collaboration`.
  const projectFiles = useProjectFileActions(mapControllerRef);
  const notebookOpen = useAppStore((s) => s.ui.notebookOpen);
  const storymapPresenting = useAppStore((s) => s.ui.storymapPresenting);
  // A plugin panel docks at one of four positions beside the Layers/Style
  // panels and the user steps it between them; the built-in panel on the docked
  // side collapses to its rail while the plugin panel is expanded next to it
  // (issue #712). The panel's width is owned here (per app instance) and shared
  // across the dock slots, so a user resize survives moving the panel without a
  // module-level global (which would leak across embeds).
  const autoCollapsedPanel = useAutoCollapsedPanel();
  // When set, a plugin panel is docked in a shared-rail mode and takes over the
  // Style (right) or Layers (left) sidebar surface (issue #765).
  const replaceStylePanelId = useReplaceStylePanelId();
  const replaceLayersPanelId = useReplaceLayersPanelId();
  const [pluginPanelWidth, setPluginPanelWidth] = useState(PLUGIN_PANEL_DEFAULT_WIDTH);
  // The active plugin panel's content lives in this one host element (created
  // once per app instance). The active dock slot adopts it via appendChild, so
  // moving the panel between docks relocates the same DOM and preserves the
  // plugin's state. `contents` keeps it transparent to layout.
  const [pluginContentEl] = useState(() => {
    const el = document.createElement("div");
    el.className = "contents";
    return el;
  });
  // A second, dedicated host for the Browser panel's React portal (below). Kept
  // separate from pluginContentEl so the imperative plugin-render effect's
  // `replaceChildren` can never wipe the portal-managed DOM, and vice versa.
  const [browserContentEl] = useState(() => {
    const el = document.createElement("div");
    el.className = "contents";
    return el;
  });
  // A third, dedicated host for the Comments panel's React portal.
  const [commentsContentEl] = useState(() => {
    const el = document.createElement("div");
    el.className = "contents";
    return el;
  });
  const rightPanelState = useRightPanelState();
  const activePanelId = rightPanelState.activeId;
  const replaceStylePanelIds = rightPanelState.visibleIds.filter(
    (id) => rightPanelState.panelDocks[id] === "replace-style",
  );
  const replaceLayersPanelIds = rightPanelState.visibleIds.filter(
    (id) => rightPanelState.panelDocks[id] === "replace-layers",
  );
  const activePanel = activePanelId ? getRightPanel(activePanelId) : undefined;
  // The plugins in VIEWER_BLOCKED_PLUGIN_IDS paint drawing and editing controls
  // onto the map, which the read-only viewer preset cannot hide the way it
  // hides React chrome, so they are deactivated outright. This has to run more
  // than once: `restoreProjectState` activates whatever a loaded project lists
  // in `projectPlugins.activePluginIds` with no viewer awareness, so every
  // project load — the initial `?url=` one and any later `loadProject` embed
  // command — can put them back. It is a callback rather than an effect of its
  // own so the restore effect below can re-assert it *after* restoring, which
  // effect ordering alone would not guarantee.
  const enforceViewerPlugins = useCallback(() => {
    if (!layoutOptions.viewer) return;
    const manager = getPluginManager();
    for (const id of VIEWER_BLOCKED_PLUGIN_IDS) {
      if (!manager.isActive(id)) continue;
      // `isActive` is true from the moment activation starts, so a plugin that
      // mounts behind a dynamic import (GeoAgent) is "active" with no control
      // yet: deactivating now would tear down nothing and the mount would land
      // straight after. Wait for it, then re-check — a failed mount rolls the
      // active flag back on its own, so there is nothing left to do.
      const pending = manager.pendingActivation(id);
      if (pending) {
        void pending.then(() => {
          if (manager.isActive(id)) manager.deactivate(id, createAppAPI(mapControllerRef));
        });
        continue;
      }
      manager.deactivate(id, createAppAPI(mapControllerRef));
    }
  }, [layoutOptions.viewer, mapControllerRef]);

  useEffect(() => {
    enforceViewerPlugins();
  }, [enforceViewerPlugins]);
  // The dock slots adopt whichever host owns the active panel's content: the
  // Browser's dedicated portal host, the Comments dedicated portal host, or the shared imperative plugin host.
  const dockContentEl =
    activePanelId === BROWSER_PANEL_ID
      ? browserContentEl
      : activePanelId === COMMENTS_PANEL_ID
        ? commentsContentEl
        : pluginContentEl;
  // Render the active panel into the shared host once; re-run when its
  // registration is replaced (re-registration refresh) but not on dock/collapse
  // changes. Keyed on the render function identity so that a plugin
  // re-registering the same id with a new render function tears down the old
  // render and calls the new one, but title resolution (which returns a new
  // object each call) does not cause spurious re-runs.
  useEffect(() => {
    const host = pluginContentEl;
    if (layoutOptions.viewer) {
      host.replaceChildren();
      return;
    }
    if (!activePanelId || !activePanel) return;
    let cleanup: void | (() => void);
    try {
      cleanup = activePanel.render(host);
    } catch (error) {
      console.error(`Right panel "${activePanelId}" render() threw.`, error);
    }
    return () => {
      try {
        cleanup?.();
      } catch (error) {
        console.error(`Right panel "${activePanelId}" cleanup threw.`, error);
      }
      host.replaceChildren();
    };
    // `activePanel` is intentionally narrowed to `activePanel?.render`:
    // getRightPanel returns a fresh clone each call, so the whole object would
    // re-run this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanelId, activePanel?.render, layoutOptions.viewer, pluginContentEl]);
  // Reset the shared width to the panel's default when a new panel activates
  // (keyed on activePanelId only, so a user resize survives re-registration).
  useEffect(() => {
    const panel = activePanelId ? getRightPanel(activePanelId) : undefined;
    if (!panel) return;
    setPluginPanelWidth(clampPluginPanelWidth(panel.defaultWidth ?? PLUGIN_PANEL_DEFAULT_WIDTH));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePanelId]);
  const assistantOpen = useAppStore((s) => s.ui.assistantOpen);
  const dashboardOpen = useAppStore((s) => s.ui.dashboardOpen);
  const geometryEditLayerId = useSyncExternalStore(
    subscribeGeometryEdit,
    getGeometryEditTargetLayerId,
  );
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [mapReadyGeneration, setMapReadyGeneration] = useState(0);
  const [dropMessage, setDropMessage] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  // Kept out of `dropError` because the drop handler sets its own success
  // message after `addImportedVectorLayers` returns, which would clobber this
  // one. A mislabelled-CRS layer loads *successfully* and still renders
  // nowhere, so both messages are true at once and need separate slots.
  const [crsWarning, setCrsWarning] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const diagnostics = useDiagnosticsSnapshot();
  const externalPluginsReady = useExternalPluginsReady(mapControllerRef);
  // Gate plugin URLs carried inside an opened project behind an explicit trust
  // decision before any of their code is fetched or imported (#1062).
  const projectPluginTrust = useProjectPluginTrust();
  // Keep Layer Swipe and split view mutually exclusive (#844): entering a
  // multi-pane grid turns the swipe slider off.
  useSwipeSplitViewExclusivity(mapControllerRef);
  // Close a binding-opened Time Slider once the last temporal layer is gone
  // (#1512), so the dock does not linger over a map with no timeline.
  useTimeSliderAutoClose(mapControllerRef);
  // Live-collaboration session. Owned here (rather than in TopToolbar) so both
  // the Collaborate dialog and the on-canvas status badge share one socket, and
  // so the dialog stays mounted in toolbar-hidden layouts.
  const collaboration = useCollaboration(mapControllerRef);
  const commentTool = useCommentTool({ mapControllerRef, collaboration });
  const [showResolvedComments, setShowResolvedComments] = useState(false);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);
  const collaborateDialogOpen = useAppStore((s) => s.ui.collaborateDialogOpen);
  const setCollaborateDialogOpen = useAppStore((s) => s.setCollaborateDialogOpen);
  // When opened via a `?collab=<code>` share link, auto-open the Collaborate
  // dialog (which prefills the code) so the recipient only picks a name and
  // joins, instead of having to find the Project menu first.
  useEffect(() => {
    if (!collaboration.enabled) return;
    if (new URLSearchParams(window.location.search).get("collab")) {
      setCollaborateDialogOpen(true);
    }
  }, [collaboration.enabled, setCollaborateDialogOpen]);
  // Sync the project with an embedding host (the GeoLibre Jupyter widget) over
  // postMessage. Inert when the app is not embedded.
  useEmbedBridge(mapControllerRef);
  // Request/reply + event channel backing the Python scripting API (live
  // queries, processing, map events). Also inert when not embedded.
  useCommandBridge(mapControllerRef);
  // Runtime postMessage API for a third-party host page that frames the app
  // (fly to a record, highlight it, open a tool; selection/view/tool events back
  // out). Off unless the deployment configured GEOLIBRE_EMBED_ORIGINS.
  useEmbedApi(mapControllerRef, mapAppAPI);
  // Same scripting surface, reached over the desktop Jupyter server's relay, so
  // a kernel driven from an EXTERNAL client (VS Code's Jupyter extension) can
  // control the map too. Inert until that server is running.
  useJupyterRelay(mapControllerRef);
  // Routes the Layers-panel Identify action to the raster pixel inspector for
  // COG layers (read band values on click). Inert until a COG is identified.
  useRasterIdentify();
  useNetcdfIdentify(mapControllerRef, mapReadyGeneration);
  useCogSpectralIdentify(mapControllerRef, mapReadyGeneration);
  const [layerPanelWidth, setLayerPanelWidth] = useState(initialSidePanelWidth);
  const [stylePanelWidth, setStylePanelWidth] = useState(initialSidePanelWidth);
  const [stylePanelOpenRequest, setStylePanelOpenRequest] = useState(0);
  const openStylePanel = useCallback(() => {
    setStylePanelOpenRequest((request) => request + 1);
  }, []);
  const [notebookPanelWidth, setNotebookPanelWidth] = useState(DEFAULT_NOTEBOOK_PANEL_WIDTH);
  // Opening the notebook (Processing → Jupyter Notebook) splits the workspace
  // 50/50 between the map and the notebook: we size the notebook to half of the
  // space it shares with the map (the row width minus the layer panel and the
  // Style panel's collapsed rail, when shown), while the Style panel collapses
  // to that rail (see `autoCollapse` below). Fire only on the closed→open
  // transition so a later manual resize is preserved.
  const notebookWasOpenRef = useRef(notebookOpen);
  useEffect(() => {
    const wasOpen = notebookWasOpenRef.current;
    notebookWasOpenRef.current = notebookOpen;
    if (!notebookOpen || wasOpen) return;
    const shellWidth = shellRef.current?.getBoundingClientRect().width ?? 0;
    if (shellWidth <= 0) return;
    const layerWidth = layoutOptions.layerPanelVisible ? layerPanelWidth : 0;
    const styleRailWidth = layoutOptions.stylePanelVisible ? COLLAPSED_PANEL_RAIL_WIDTH : 0;
    const half = Math.round((shellWidth - layerWidth - styleRailWidth) / 2);
    // Honor the same min/max bounds as the drag-resize handler so the auto-size
    // and manual-resize paths cannot diverge (an ultrawide shell would otherwise
    // initialize past MAX, a width the user could never drag back to).
    setNotebookPanelWidth(clamp(half, MIN_NOTEBOOK_PANEL_WIDTH, MAX_NOTEBOOK_PANEL_WIDTH));
  }, [
    notebookOpen,
    layoutOptions.layerPanelVisible,
    layoutOptions.stylePanelVisible,
    layerPanelWidth,
  ]);
  const deferPanelResize = isTauri();
  const shellStyle: ShellStyle = {
    "--layer-panel-width": `${layerPanelWidth}px`,
    "--style-panel-width": `${stylePanelWidth}px`,
    "--notebook-panel-width": `${notebookPanelWidth}px`,
  };

  const clearDropMessageLater = useCallback(() => {
    if (dropMessageTimeoutRef.current !== null) {
      window.clearTimeout(dropMessageTimeoutRef.current);
    }
    dropMessageTimeoutRef.current = window.setTimeout(() => {
      dropMessageTimeoutRef.current = null;
      setDropMessage(null);
      setDropError(null);
    }, 4000);
  }, []);

  const ensureLayerGeojsonFromSource = useCallback(async (layerId: string) => {
    const layer = useAppStore.getState().layers.find((candidate) => candidate.id === layerId);
    if (!layer || layer.geojson) return;
    const sourceIds = layer.metadata.sourceIds;
    const sourceId = Array.isArray(sourceIds) ? sourceIds[0] : undefined;
    if (typeof sourceId !== "string") return;
    const source = mapControllerRef.current?.getMap()?.getSource(sourceId) as
      | { getData?: () => Promise<unknown> }
      | undefined;
    if (!source || typeof source.getData !== "function") return;
    try {
      const data = await source.getData();
      if (
        data &&
        typeof data === "object" &&
        (data as { type?: string }).type === "FeatureCollection"
      ) {
        useAppStore.getState().updateLayer(layerId, { geojson: data as FeatureCollection });
      }
    } catch {
      // Best effort; startLayerGeometryEdit will fail and surface an error.
    }
  }, []);

  const handleToggleGeometryEdit = useCallback(
    async (layerId: string) => {
      const appAPI = createAppAPI(mapControllerRef);
      if (getGeometryEditTargetLayerId() === layerId) {
        await endLayerGeometryEdit(appAPI, { save: true });
        return;
      }
      // Guard against concurrent invocations: this handler awaits before it sets
      // the session target, so two rapid clicks could otherwise both pass the
      // check above and race into startLayerGeometryEdit for different layers.
      if (togglingGeometryEditRef.current) return;
      togglingGeometryEditRef.current = true;
      // Clear any stale error from a previous failed attempt.
      setDropError(null);
      try {
        // Add Vector Layer (geojson-mode) layers keep their features in a
        // MapLibre source rather than in `layer.geojson`. Read them back once so
        // the editor has features to load. (Plain geojson layers already have
        // `geojson`.)
        await ensureLayerGeojsonFromSource(layerId);
        const manager = getPluginManager();
        if (!manager.isActive(GEO_EDITOR_PLUGIN_ID)) {
          manager.activate(GEO_EDITOR_PLUGIN_ID, appAPI);
          if (!manager.isActive(GEO_EDITOR_PLUGIN_ID)) {
            setDropError(
              "Could not activate the geometry editor. Try again once the map has fully loaded.",
            );
            clearDropMessageLater();
            return;
          }
        }
        const started = await startLayerGeometryEdit(appAPI, layerId);
        if (!started) {
          setDropError(
            "Could not start geometry editing for this layer. Its data may still be loading.",
          );
          clearDropMessageLater();
        }
      } finally {
        togglingGeometryEditRef.current = false;
      }
    },
    [clearDropMessageLater, ensureLayerGeojsonFromSource],
  );

  const handleCancelGeometryEdit = useCallback(() => {
    void endLayerGeometryEdit(createAppAPI(mapControllerRef), { save: false });
  }, []);

  const handleMaterializeDuckDBLayer = useCallback(
    async (layer: GeoLibreLayer) => {
      // Guard against concurrent triggers (double-click, or two layers in quick
      // succession) so we do not add duplicate materialized layers.
      if (materializingRef.current) return;
      const query = typeof layer.metadata.query === "string" ? layer.metadata.query : null;
      if (!query) {
        setDropError("This DuckDB layer has no stored query to materialize.");
        clearDropMessageLater();
        return;
      }
      materializingRef.current = true;
      setDropError(null);
      setDropMessage("Materializing DuckDB layer...");
      try {
        // The query is the layer's own stored SQL from the user's project; it is
        // intentionally run unrestricted against the in-memory DuckDB instance.
        // Import the DuckDB-WASM engine lazily here, not at module load: a static
        // import would pull the heavy `@duckdb/duckdb-wasm` chunk into the app's
        // boot graph (DesktopShell is eagerly imported by App), which then has to
        // load before the shell renders. That broke the offline cold boot — the
        // chunk is runtime-cached, not precached, so a cache miss failed the boot
        // and the map never mounted (see e2e/pwa.spec.ts). Loading it on first
        // materialize keeps DuckDB out of the offline-critical boot path.
        const { runSqlQuery } = await import("../../lib/sql-workspace");
        const result = await runSqlQuery(query, useAppStore.getState().layers);
        if (!result.geojson) {
          throw new Error("The query did not return a geometry column.");
        }
        const id = addGeoJsonLayer(`${layer.name} (editable)`, result.geojson);
        const created = useAppStore.getState().layers.find((candidate) => candidate.id === id);
        if (created) mapControllerRef.current?.fitLayer(created);
        setDropMessage(`Materialized ${result.geojson.features.length.toLocaleString()} features.`);
      } catch (error) {
        setDropMessage(null);
        setDropError(error instanceof Error ? error.message : "Could not materialize this layer.");
      } finally {
        materializingRef.current = false;
        clearDropMessageLater();
      }
    },
    [addGeoJsonLayer, clearDropMessageLater],
  );

  useEffect(() => {
    // Registered unconditionally, not on first import: a saved project's KML
    // Super-Overlay tile URLs must resolve in a session that only reopens it,
    // which is exactly when nothing has called registerKmlSuperOverlay yet.
    void registerKmlSuperOverlayProtocol();
    if (isTauri()) {
      registerMbtilesProtocol();
      registerXyzTileProtocol();
    }
  }, []);

  // Let the raster plugin reach the local filesystem on desktop: re-read a
  // raster a saved project references by path, and open the native file dialog
  // instead of the panel's own <input type="file"> (whose File carries no path,
  // so the raster could never be restored). Both stay unregistered in the
  // browser, where the plugin keeps its existing behavior. See issue #1463.
  useEffect(() => {
    if (!isTauri()) return;
    setLocalRasterFileReader(readRasterFileAtPath);
    setLocalRasterPicker(pickLocalRasterFiles);
    return () => {
      setLocalRasterFileReader(null);
      setLocalRasterPicker(null);
    };
  }, []);

  // When a GeoTIFF fails to load because it is striped (not a tiled COG), offer
  // to convert it to a COG in the browser and load the result. Works for both a
  // local file and a remote URL (issue #916). The raster plugin detects the case
  // and hands us the bytes; the conversion and the prompt live here because this
  // layer has i18n and the client-side converter. See opengeos/GeoLibre#789.
  useEffect(() => {
    setNonTiledRasterHandler(async ({ name, bytesAreRemote, readBytes, dismiss }) => {
      try {
        // A remote source gets a single up-front prompt that names the download:
        // its size is unknown until it has been fetched, so prompting again after
        // the download (with dimensions) would just risk discarding a large file
        // the user already agreed to download. A local file resolves instantly,
        // so it defers to the post-read prompt below, which can pick the
        // large-raster warning now that the dimensions are cheap to read. See #916.
        if (bytesAreRemote && !window.confirm(t("raster.cogConvertRemoteConfirm", { name }))) {
          return;
        }
        // Read the source bytes in their own try so a failure to obtain them
        // reports a read/download problem rather than the misleading "could not
        // convert" message below, which assumes a conversion was attempted. For
        // a remote URL this is a network/timeout error or a RangeError when the
        // download is too large to allocate (rasterDownloadFailed names both);
        // for a local file it is the rare case of the blob URL being revoked
        // (e.g. the layer removed) before the read, so fall back to the generic
        // convert-failed message rather than the server-oriented download one.
        let bytes: Uint8Array;
        try {
          bytes = await readBytes();
        } catch (error) {
          console.error("[GeoLibre] Failed to read raster for conversion", error);
          window.alert(
            bytesAreRemote
              ? t("raster.rasterDownloadFailed", { name })
              : t("raster.cogConvertFailed", { name }),
          );
          return;
        }
        // A URL can answer 200 with non-GeoTIFF content (an auth/login or error
        // page), which downloads fine but is not convertible. Sniff the TIFF
        // signature up front so that surfaces as a clear "not a GeoTIFF" message
        // instead of the misleading "could not convert" one the parser would
        // otherwise trigger. isTiff accepts BigTIFF too, matching the wasm
        // reader/converter, so a valid >4 GiB raster is not wrongly rejected.
        if (!isTiff(bytes)) {
          window.alert(t("raster.rasterNotGeotiff", { name }));
          return;
        }
        if (!bytesAreRemote) {
          // Local file: pick the prompt by size now that the header is cheap to
          // read, then confirm once. (A remote source already confirmed above.)
          const info = await readGeoTiffInfo(bytes);
          const samples = info.width * info.height * Math.max(info.bands, 1);
          const message =
            samples > LARGE_RASTER_SAMPLE_LIMIT
              ? t("raster.cogConvertLargeConfirm", {
                  name,
                  width: info.width,
                  height: info.height,
                })
              : t("raster.cogConvertConfirm", { name });
          if (!window.confirm(message)) return;
        }
        const cog = await convertGeoTiffToCog(bytes);
        // The cast is required: TS types Uint8Array as Uint8Array<ArrayBufferLike>,
        // which is not directly assignable to BlobPart's ArrayBufferView.
        const file = new File([cog as BlobPart], name, {
          type: "image/tiff",
        });
        await addRasterToMap(createAppAPI(mapControllerRef), file, { name });
        // Drop the failed layer only after the replacement is fully loaded, so
        // any failure above (conversion or re-add) leaves the original errored
        // layer (and its message) in place.
        dismiss();
      } catch (error) {
        console.error("[GeoLibre] Failed to convert GeoTIFF to COG", error);
        window.alert(t("raster.cogConvertFailed", { name }));
      }
    });
    return () => setNonTiledRasterHandler(null);
  }, [t]);

  useEffect(() => {
    // Restoration should run only when a project is loaded (projectGeneration)
    // or the map is reinitialised (mapReadyGeneration), not on every
    // incremental plugin write-back. projectPlugins is read from the store
    // snapshot at call time so it is always current without being a dependency.
    if (!externalPluginsReady || !mapReadyGeneration || !mapControllerRef.current) return;
    const appAPI = createAppAPI(mapControllerRef);
    const pluginManager = getPluginManager();
    pluginManager.restoreProjectState(useAppStore.getState().projectPlugins, appAPI);
    // Immediately after the restore, so a project that persisted the geo-editor
    // as active cannot re-arm editing inside a read-only viewer embed.
    enforceViewerPlugins();
    restoreThreeDTilesLayers(appAPI);
    restoreRasterLayers(appAPI);
    restorePlanetaryComputerLayers(appAPI);
    restoreVectorLayers(appAPI);
    // Re-bind saved ArcGIS feature layers to the viewport. Without this a
    // reopened project's layer stays frozen on the extent it was saved with.
    restoreArcGISViewportLayers(appAPI);
    // Re-stream saved LiDAR (COPC) point clouds. A `lidar-url` layer restores
    // into the store as inert metadata; the point cloud is loaded by the LiDAR
    // control, not the store, so without this the layer shows in the panel but
    // renders nothing.
    void restoreLidarLayers(appAPI).catch((error: unknown) => {
      console.warn("[lidar] failed to restore saved point clouds", error);
    });
    // Re-read drag-dropped / Add Data local-file GeoJSON layers from disk
    // (their data was saved as a path, not embedded).
    void restoreLocalFileLayers();
    // Let layer-sync push the store-derived beforeId into the control that owns
    // each deck.gl COG raster so it interleaves with vector layers instead of
    // always drawing on top. Two controls render such layers: the raster
    // control and the STAC Search control (#1718). The STAC one claims only its
    // own layer ids, so ask it first and fall through for everything else.
    setExternalDeckLayerOrderHandler((layerId, beforeId) => {
      if (applyStacSearchLayerOrder(layerId, beforeId)) return;
      applyRasterLayerOrder(layerId, beforeId);
    });
    // activeByDefault plugins are marked active without activate() being
    // called, so the effects engine must be kicked explicitly to match the
    // restored active state (idempotent).
    restoreEffects(
      appAPI,
      pluginManager.isActive(EFFECTS_PLUGIN_ID),
      useAppStore.getState().projectPlugins?.settings?.[EFFECTS_PLUGIN_ID],
    );
    // The sun simulation reads/writes native map layers, so it must re-bind to
    // the (possibly new) map instance after a map re-init or basemap change.
    // Reattach only — it must NOT derive open/closed state here, which would
    // reset a locally-opened panel on an unrelated basemap swap or remote edit.
    // Project loads open/close it via the plugin's applyProjectState (invoked by
    // restoreProjectState above).
    reattachSun(appAPI);
    // The route animation likewise owns native marker/trail layers, so rebind it
    // to the (possibly new) map after a re-init/basemap swap without deriving
    // open/closed state (project loads handle that via applyProjectState).
    reattachRouteAnimation(appAPI);
    // The flight simulator holds a reference to the live map (and suspends its
    // interaction handlers while flying), so rebind it after a map re-init too.
    reattachFlightSimulator(appAPI);
    // Rebind the directions tool to the (possibly new) map instance after a
    // map re-init, since restoreProjectState skips an already-active plugin.
    restoreDirections(appAPI, pluginManager.isActive(DIRECTIONS_PLUGIN_ID));
    // Reverse geocode sends clicked coordinates to a public geocoder. If a
    // restored project marks it active but this device never acknowledged the
    // privacy notice, deactivate it so no coordinates are sent without consent;
    // the user must re-enable it (which shows the notice). This makes the
    // consent gate cover every activation path, not just the toolbar toggle.
    if (pluginManager.isActive(REVERSE_GEOCODE_PLUGIN_ID) && !hasReverseGeocodeConsent()) {
      pluginManager.deactivate(REVERSE_GEOCODE_PLUGIN_ID, appAPI);
    }
    restoreReverseGeocode(appAPI, pluginManager.isActive(REVERSE_GEOCODE_PLUGIN_ID));
    // Same contract for the deck.gl overlay: re-attach it to the current map
    // and re-render any deckgl-viz layers a restored project carries.
    restoreDeckViz(appAPI, pluginManager.isActive(DECK_VIZ_PLUGIN_ID));
    const search = window.location.search;
    void pluginManager
      .handleUrlParameters(new URLSearchParams(search), appAPI, `${projectGeneration}:${search}`)
      // `handleUrlParameters` activates plugins asynchronously, so it can land
      // after the synchronous pass above. No blocked plugin registers a URL
      // handler today, but "every activation path is covered" is the whole
      // point of the guard, so re-assert it once this settles rather than
      // leaving the next one to notice.
      .catch(console.error)
      .finally(enforceViewerPlugins);
  }, [enforceViewerPlugins, externalPluginsReady, mapReadyGeneration, projectGeneration]);

  useEffect(() => {
    return () => {
      if (dropMessageTimeoutRef.current !== null) {
        window.clearTimeout(dropMessageTimeoutRef.current);
      }
    };
  }, []);

  const handleMapControllerReady = useCallback(() => {
    setMapReadyGeneration((generation) => generation + 1);
    onMapReady?.(createAppAPI(mapControllerRef));
  }, [onMapReady]);

  // Keep the on-map compass (reset pitch/bearing) control's tooltip translated.
  // Re-runs when the controller (re)initialises (mapReadyGeneration) and on
  // language change (t identity changes), since that native control lives
  // outside React.
  useEffect(() => {
    mapControllerRef.current?.setCompassLabel(t("toolbar.item.resetPitchBearing"));
  }, [t, mapReadyGeneration]);

  // Keep the on-map terrain control's tooltip translated (it lives outside
  // React). Re-runs on controller (re)init and language change.
  useEffect(() => {
    mapControllerRef.current?.setTerrainLabel(t("terrainSettings.controlLabel"));
  }, [t, mapReadyGeneration]);

  // Keep the Layer Swipe panel's grouped base-layer label translated. That
  // panel lives outside React and reads labels from the controller bridge, so
  // re-push on language change (t identity) and controller (re)init.
  useEffect(() => {
    mapControllerRef.current?.setBackgroundLabel(t("layers.background"));
  }, [t, mapReadyGeneration]);

  const handleMapDiagnosticEvent = useCallback((event: MapDiagnosticEvent) => {
    appendDiagnostic({
      category: "map",
      level: "error",
      message: event.message,
      detail: event.detail,
      source: event.source,
      status: event.status,
      url: event.url,
    });
  }, []);

  const addImportedVectorLayers = useCallback(
    (importedLayers: ImportedVectorLayer[]) => {
      let lastLayerId: string | null = null;
      // Layers whose coordinates cannot be WGS84; surfaced together after the
      // loop so a multi-file drop reports once rather than per file.
      const nonGeographic: string[] = [];
      // Frame ids for each time-animated overlay sequence (keyed by the loader's
      // group marker), so they can be gathered into one layer group afterward.
      const frameGroups = new Map<string, string[]>();
      for (const layer of importedLayers) {
        if (isLoadedKmlSuperOverlay(layer)) {
          lastLayerId = addTileLayer(layer.name || layerNameFromPath(layer.path), {
            tiles: [layer.url],
            type: "xyz",
            tileSize: layer.tileSize,
            bounds: layer.bounds,
            minzoom: layer.minzoom,
            maxzoom: layer.maxzoom,
            metadata: {
              sourceKind: "kml-super-overlay",
              bounds: layer.bounds,
            },
          });
          continue;
        }
        // A KML/KMZ ground overlay becomes an image layer, not a vector one.
        if (isLoadedImageOverlay(layer)) {
          lastLayerId = addImageOverlayLayer(
            // `||` (not `??`) so an empty name falls back to the path, matching
            // the vector branch and the drop toast.
            layer.name || layerNameFromPath(layer.path),
            { url: layer.url, coordinates: layer.coordinates },
            {
              opacity: layer.opacity,
              bounds: layer.bounds,
              sourcePath: layer.path,
              ...(layer.timeSpan ? { timeSpan: layer.timeSpan } : {}),
              ...(layer.visible === false ? { visible: false } : {}),
            },
          );
          if (layer.groupId) {
            const ids = frameGroups.get(layer.groupId) ?? [];
            ids.push(lastLayerId);
            frameGroups.set(layer.groupId, ids);
          }
          continue;
        }
        // A KML/KMZ <Model> becomes a deck.gl scenegraph layer.
        if (isLoadedModel(layer)) {
          const modelLayer = buildKmlModelLayer(layer);
          addLayer(modelLayer);
          lastLayerId = modelLayer.id;
          continue;
        }
        // `||` (not `??`) so an empty-string name falls back to the path, and
        // matches the name shown in the drop confirmation toast.
        const layerName = layer.name || layerNameFromPath(layer.path);
        // A file that declares WGS84 but holds projected coordinates loads
        // cleanly, lists in the Layers panel, and renders nowhere — the map
        // simply never moves. Warn rather than fail: the data is readable and
        // only the user knows its true CRS.
        const offRange = detectNonGeographicCoordinates(layer.data);
        if (offRange) {
          nonGeographic.push(layerName);
          console.warn(
            `[GeoLibre] "${layerName}" declares geographic coordinates but its values are out of range ` +
              `(max |x| ${Math.round(offRange.maxAbsX).toLocaleString()}, max |y| ${Math.round(offRange.maxAbsY).toLocaleString()} ` +
              `over ${offRange.sampled.toLocaleString()} sampled coordinates). The file's CRS is almost certainly ` +
              `mislabelled — reproject it, or correct its .prj/crs, and load it again.`,
          );
        }
        lastLayerId = addGeoJsonLayer(layerName, layer.data, layer.path);
      }

      setCrsWarning(
        nonGeographic.length > 0
          ? t("addData.nonGeographicCoordinates", { names: nonGeographic.join(", ") })
          : null,
      );

      // Gather each time-animated overlay's frames into one collapsible group so
      // the sequence reads as a single timeline entry, not N stacked layers.
      const sequences = [...frameGroups.values()].filter((ids) => ids.length > 1);
      sequences.forEach((ids, index) => {
        // Suffix when a single drop yields more than one sequence so the groups
        // are distinguishable in the panel (e.g. two independent radar loops).
        const name =
          sequences.length > 1
            ? `${t("kml.timeOverlayGroup")} ${index + 1}`
            : t("kml.timeOverlayGroup");
        addLayerGroup(name, ids);
      });
      const hasTimeAnimation = sequences.length > 0;
      // Auto-open the Time Slider so a time-animated overlay sequence can be
      // stepped through immediately, without the user hunting for the plugin.
      if (hasTimeAnimation && !isPluginActive(TIME_SLIDER_PLUGIN_ID)) {
        togglePlugin(TIME_SLIDER_PLUGIN_ID, createAppAPI(mapControllerRef));
      }

      const importedLayer = useAppStore.getState().layers.find((layer) => layer.id === lastLayerId);
      if (importedLayer) {
        // A deck.gl-backed layer (e.g. a KML <Model> scenegraph) mounts its
        // overlay on the next render; fitting synchronously here races that
        // mount and the camera move is lost. Defer the fit past the mount so
        // it frames the model. MapLibre-native layers fit synchronously.
        if (importedLayer.type === "deckgl-viz") {
          const layerId = importedLayer.id;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              window.setTimeout(() => {
                const current = useAppStore.getState().layers.find((layer) => layer.id === layerId);
                if (current) mapControllerRef.current?.fitLayer(current);
              }, 50);
            });
          });
        } else {
          mapControllerRef.current?.fitLayer(importedLayer);
        }
      }
    },
    [
      addGeoJsonLayer,
      addImageOverlayLayer,
      addTileLayer,
      addLayer,
      addLayerGroup,
      isPluginActive,
      togglePlugin,
      t,
    ],
  );

  useEffect(() => {
    setKmlFileImportHandler(async (imports) => {
      setDropError(null);
      // Matches the drop handlers: the catch below sets `dropError` without
      // reaching `addImportedVectorLayers`, so without this a previous file's
      // banner would sit beside the new error.
      setCrsWarning(null);
      try {
        const paths = imports
          .map(({ sourcePath }) => sourcePath)
          .filter((sourcePath): sourcePath is string => typeof sourcePath === "string");
        // Prefer the filesystem paths the desktop picker reports: a Super-Overlay
        // records its source in the tile URL so a saved project can re-read the
        // pyramid, which a path-less browser File cannot support.
        const layers =
          paths.length === imports.length
            ? await loadDroppedVectorPaths(paths, { onLargeDataset: confirmLargeVectorDataset })
            : await loadDroppedVectorFiles(
                imports.map(({ file }) => file),
                {
                  onLargeDataset: confirmLargeVectorDataset,
                },
              );
        addImportedVectorLayers(layers);
      } catch (error) {
        setDropError(error instanceof Error ? error.message : t("kml.importFailed"));
      }
    });
    return () => setKmlFileImportHandler(null);
  }, [addImportedVectorLayers, t]);

  const addDroppedPhotos = useCallback(
    (result: GeotaggedPhotoResult | null): number => {
      if (!result || result.located === 0) return 0;
      const layerId = addGeoJsonLayer(t("addData.photos.defaultName"), result.featureCollection);
      const layer = useAppStore.getState().layers.find((existing) => existing.id === layerId);
      if (layer) mapControllerRef.current?.fitLayer(layer);
      // Report skipped (no-GPS) photos too, mirroring the Add Data dialog's
      // summary, so a partially-skipped drop isn't silent.
      const summary = t("addData.photos.addedSummary", {
        count: result.located,
      });
      const skippedNote =
        result.skipped > 0 ? ` ${t("addData.photos.skippedNote", { count: result.skipped })}` : "";
      setDropMessage(summary + skippedNote);
      return result.located;
    },
    [addGeoJsonLayer, t],
  );

  const addDroppedRasters = useCallback(async (rasters: DroppedRaster[]): Promise<number> => {
    if (!rasters.length) return 0;
    const appAPI = createAppAPI(mapControllerRef);
    for (const raster of rasters) {
      // `path` is present only for a desktop pick/drop; it is what lets a saved
      // project reload the raster instead of dropping it (issue #1463).
      await addRasterToMap(appAPI, raster.source, {
        name: raster.name,
        ...(raster.path ? { localPath: raster.path } : {}),
      });
    }
    return rasters.length;
  }, []);

  // Add a single local file (clicked in the Browser panel's Files tree) as a
  // layer, reusing the same loaders + store dispatch as the drag-and-drop path.
  // Resolves to an inline error message, or null on success. Vector/raster only
  // (the Files tree filters to those); MBTiles go through the Add Data dialog.
  const addFilePath = useCallback(
    async (path: string): Promise<string | null> => {
      try {
        if (isRasterFileName(path)) {
          const count = await addDroppedRasters(await loadDroppedRasterPaths([path]));
          return count > 0 ? null : t("browser.addFileFailed");
        }
        let cancelled = false;
        const importedLayers = await loadDroppedVectorPaths([path], {
          // Same large-dataset confirmation the drag-and-drop / Open Vector File
          // paths use, so clicking a big file in the tree can't silently hang.
          onLargeDataset: (dataset) => {
            const accepted = confirmLargeVectorDataset(dataset);
            cancelled = !accepted;
            return accepted;
          },
        });
        // A declined large-file prompt is a cancellation, not a failure — but
        // loadDroppedVectorPaths can still return valid layers (e.g. KML ground
        // overlays / models) alongside a declined placemark-vector load, so only
        // treat an *empty* result as a cancel/no-op; otherwise add what loaded.
        if (!importedLayers.length) {
          return cancelled ? null : t("browser.addFileFailed");
        }
        addImportedVectorLayers(importedLayers);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : t("browser.addFileFailed");
      }
    },
    [addDroppedRasters, addImportedVectorLayers, t],
  );

  const finishDrop = useCallback(
    (importedLayers: ImportedVectorLayer[], rasterCount: number) => {
      if (!importedLayers.length && !rasterCount) {
        throw new Error("Drop a supported vector or raster file.");
      }
      if (importedLayers.length) addImportedVectorLayers(importedLayers);
      // Name the layer when a single vector file was dropped (the common case)
      // so the confirmation echoes what the user just added, instead of a bare
      // count that can read like "nothing happened" while the source panel
      // stays open (opengeos/GeoLibre#666).
      if (importedLayers.length === 1 && !rasterCount) {
        const only = importedLayers[0];
        // `||` (not `??`) so an empty-string name also falls back to the path.
        setDropMessage(
          t("toolbar.fileDrop.addedLayer", {
            name: only.name || layerNameFromPath(only.path),
          }),
        );
        return;
      }
      // Full-sentence keys (rather than a JS-assembled summary) keep word
      // order and the connector inside the translation catalog. The mixed
      // case composes two independently pluralized noun phrases into its
      // sentence, since one i18next key can pluralize only a single count.
      setDropMessage(
        importedLayers.length && rasterCount
          ? t("toolbar.fileDrop.addedBoth", {
              vector: t("toolbar.fileDrop.bothVectorLayers", {
                count: importedLayers.length,
              }),
              raster: t("toolbar.fileDrop.bothRasterLayers", {
                count: rasterCount,
              }),
            })
          : importedLayers.length
            ? t("toolbar.fileDrop.addedVectorLayers", {
                count: importedLayers.length,
              })
            : t("toolbar.fileDrop.addedRasterLayers", { count: rasterCount }),
      );
    },
    [addImportedVectorLayers, t],
  );

  // Dropping a file adds a layer to the project, so it belongs with the menus,
  // shortcuts, and command palette the viewer preset switches off — otherwise
  // drag and drop is a way back into authoring that the read-only chrome never
  // advertises. Both drop paths are gated: the Tauri native listener here and
  // the webview handlers below.
  const viewerReadOnly = layoutOptions.viewer;

  useEffect(() => {
    if (!isTauri() || viewerReadOnly) return;

    let unlisten: (() => void) | null = null;
    let disposed = false;

    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      if (disposed) return;
      void getCurrentWebview()
        .onDragDropEvent(async (event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setIsDraggingFiles(true);
            // Match the perceived speed of Add Raster Layer: that flow warms
            // the lazy raster control while its native picker is open. A map
            // drop otherwise starts all initialization only after release.
            // Fire-and-forget here so drag feedback never waits on imports.
            if (event.payload.type === "enter") {
              void prepareRasterControl(createAppAPI(mapControllerRef)).catch((error) => {
                console.warn("[GeoLibre] Could not prepare the raster drop handler", error);
              });
            }
            return;
          }

          if (event.payload.type === "leave") {
            setIsDraggingFiles(false);
            return;
          }

          setIsDraggingFiles(false);
          setDropError(null);
          // Matches the browser drop handler: a warning about a previous file
          // must not linger over an unrelated drop.
          setCrsWarning(null);
          setDropMessage("Importing data...");

          try {
            const paths = event.payload.paths;
            // OSM PBF files split into three layers, so they bypass the normal
            // single-FeatureCollection pipeline (which would otherwise route a
            // .pbf to DuckDB ST_Read and merge it).
            const pbfPaths = paths.filter((path) => isOsmPbfFileName(path));
            const otherPaths = paths.filter((path) => !isOsmPbfFileName(path));

            if (pbfPaths.length > 0) {
              const { readFile, stat } = await import("@tauri-apps/plugin-fs");
              for (const path of pbfPaths) {
                const name = path.split(/[/\\]/).pop() || "osm";
                try {
                  // Check the size via metadata before reading the file into
                  // memory, so the guard runs before a huge extract is loaded.
                  const { size } = await stat(path);
                  if (size >= OSM_PBF_SIZE_WARN_BYTES) {
                    const sizeMb = Math.round(size / (1024 * 1024));
                    // window.confirm is blocking and adequate here; note that a
                    // few webview builds may suppress JS dialogs, in which case
                    // it returns false and the file is skipped.
                    if (
                      !window.confirm(
                        `${name} is about ${sizeMb} MB. Parsing it may use a lot of memory. Continue?`,
                      )
                    ) {
                      continue;
                    }
                  }
                  setDropMessage(`Parsing ${name}…`);
                  const bytes = await readFile(path);
                  // Guard against a subview Uint8Array: .buffer would include
                  // extra bytes and corrupt the parse, so slice to the exact view.
                  const buffer =
                    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
                      ? (bytes.buffer as ArrayBuffer)
                      : (bytes.buffer.slice(
                          bytes.byteOffset,
                          bytes.byteOffset + bytes.byteLength,
                        ) as ArrayBuffer);
                  const layers = await loadOsmPbf(buffer);
                  const added = addOsmPbfLayers(
                    addGeoJsonLayer,
                    osmPbfBaseName(name),
                    path,
                    layers,
                  );
                  if (added > 0 && layers.bounds) {
                    mapControllerRef.current?.fitBounds(layers.bounds);
                  }
                  setDropMessage(
                    added > 0
                      ? `Added ${added} layer${added === 1 ? "" : "s"} from ${name}.`
                      : `No features found in ${name}.`,
                  );
                } catch (err) {
                  // Isolate per-file failures so one bad PBF doesn't abandon the
                  // rest of the drop.
                  setDropMessage(null);
                  setDropError(
                    err instanceof OsmPbfTooLargeError
                      ? t("toolbar.error.osmPbfTooLarge")
                      : `Could not parse ${name}: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }
            }

            // Geotagged photos become their own point layer; TIFF stays on the
            // raster path. Handle them before the vector/raster pipeline so a
            // dropped .jpg isn't routed to the DuckDB vector loader.
            const photoResult = await loadDroppedPhotoPaths(otherPaths);
            const photoCount = addDroppedPhotos(photoResult);
            // Surface a clear message when every dropped photo lacked GPS, so
            // the drop doesn't complete silently.
            if (photoResult && photoCount === 0 && photoResult.total > 0) {
              setDropError(t("addData.photos.errorNoGps", { count: photoResult.total }));
            }
            const restPaths = otherPaths.filter((path) => !isPhotoDropFileName(path));

            if (restPaths.length > 0) {
              const rasterCount = await addDroppedRasters(await loadDroppedRasterPaths(restPaths));
              const importedLayers = await loadDroppedVectorPaths(restPaths, {
                onLargeDataset: confirmLargeVectorDataset,
              });
              // See the browser handler: skip finishDrop's empty-input error
              // when PBF or photo files were present (even if rejected/failed).
              // See the browser handler: suppress the empty-input error when
              // photos were present so it can't clobber the GPS error above.
              if (
                importedLayers.length > 0 ||
                rasterCount > 0 ||
                (pbfPaths.length === 0 && photoResult === null)
              ) {
                finishDrop(importedLayers, rasterCount);
              }
            }
          } catch (error) {
            setDropMessage(null);
            setDropError(error instanceof Error ? error.message : "Could not import files.");
          } finally {
            clearDropMessageLater();
          }
        })
        .then((nextUnlisten) => {
          if (disposed) {
            nextUnlisten();
          } else {
            unlisten = nextUnlisten;
          }
        })
        .catch((error) => {
          console.warn("Could not attach Tauri drag and drop handler", error);
        });
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [
    clearDropMessageLater,
    finishDrop,
    addDroppedRasters,
    addDroppedPhotos,
    addGeoJsonLayer,
    viewerReadOnly,
  ]);

  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (viewerReadOnly || !hasDroppedFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDraggingFiles(true);
    },
    [viewerReadOnly],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      // Leaving the default action in place makes the browser refuse the drop,
      // so the overlay never appears and nothing is imported.
      if (viewerReadOnly || !hasDroppedFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [viewerReadOnly],
  );

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (viewerReadOnly || !hasDroppedFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setIsDraggingFiles(false);
    },
    [viewerReadOnly],
  );

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      if (viewerReadOnly || !hasDroppedFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDraggingFiles(false);
      setDropError(null);
      // Not auto-dismissed on the status timeout (it has its own Close button),
      // so it is cleared here instead: a warning about a previous file must not
      // linger over an unrelated drop.
      setCrsWarning(null);
      setDropMessage("Importing data...");

      try {
        const allFiles = Array.from(event.dataTransfer.files);
        // OSM PBF files produce three separate layers (points/lines/polygons),
        // so they bypass the single-FeatureCollection vector drop pipeline.
        // Handle them first, then run the rest through the normal pipeline —
        // finishDrop throws on an empty list, so only call it when non-PBF
        // files were dropped.
        const pbfFiles = allFiles.filter((file) => isOsmPbfFileName(file.name));
        const otherFiles = allFiles.filter((file) => !isOsmPbfFileName(file.name));

        for (const file of pbfFiles) {
          // Mirror the file-picker path's large-file guard (parsing a huge
          // extract can exhaust memory even off the main thread).
          if (file.size >= OSM_PBF_SIZE_WARN_BYTES) {
            const sizeMb = Math.round(file.size / (1024 * 1024));
            if (
              !window.confirm(
                `${file.name} is about ${sizeMb} MB. Parsing it may use a lot of memory. Continue?`,
              )
            ) {
              continue;
            }
          }
          setDropMessage(`Parsing ${file.name}…`);
          let layers;
          try {
            layers = await loadOsmPbf(await file.arrayBuffer());
          } catch (err) {
            // Isolate per-file failures so one bad PBF doesn't abandon the rest
            // of the drop (including any co-dropped non-PBF files).
            setDropMessage(null);
            setDropError(
              err instanceof OsmPbfTooLargeError
                ? t("toolbar.error.osmPbfTooLarge")
                : `Could not parse ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
          const added = addOsmPbfLayers(
            addGeoJsonLayer,
            osmPbfBaseName(file.name),
            file.name,
            layers,
          );
          if (added > 0 && layers.bounds) {
            mapControllerRef.current?.fitBounds(layers.bounds);
          }
          setDropMessage(
            added > 0
              ? `Added ${added} layer${added === 1 ? "" : "s"} from ${file.name}.`
              : `No features found in ${file.name}.`,
          );
        }

        // Geotagged photos (JPEG/PNG/WebP/HEIC) become a single point layer of
        // their own; TIFF is left to the raster path. Handle them before the
        // vector/raster pipeline so a .jpg isn't sent to the DuckDB vector
        // loader (which would fail).
        const photoResult = await loadDroppedPhotoFiles(otherFiles);
        const photoCount = addDroppedPhotos(photoResult);
        // Surface a clear message when every dropped photo lacked GPS, so the
        // drop doesn't complete silently.
        if (photoResult && photoCount === 0 && photoResult.total > 0) {
          setDropError(t("addData.photos.errorNoGps", { count: photoResult.total }));
        }
        const restFiles = otherFiles.filter((file) => !isPhotoDropFileName(file.name));

        if (restFiles.length > 0) {
          const rasterCount = await addDroppedRasters(loadDroppedRasterFiles(restFiles));
          const importedLayers = await loadDroppedVectorFiles(restFiles, {
            onLargeDataset: confirmLargeVectorDataset,
          });
          // Call finishDrop (which reports success or throws the empty-input
          // error) only when the other files produced something, or when the
          // drop contained no PBF/photo files at all. If those were present —
          // even if they were all rejected or failed — its empty-input error
          // would wrongly clobber their outcome.
          // Suppress finishDrop's empty-input error whenever photos were
          // present (photoResult !== null) — even if all lacked GPS — so its
          // generic message can't clobber the specific GPS error set above.
          if (
            importedLayers.length > 0 ||
            rasterCount > 0 ||
            (pbfFiles.length === 0 && photoResult === null)
          ) {
            finishDrop(importedLayers, rasterCount);
          }
        }
      } catch (error) {
        setDropMessage(null);
        setDropError(error instanceof Error ? error.message : "Could not import files.");
      } finally {
        clearDropMessageLater();
      }
    },
    [
      clearDropMessageLater,
      finishDrop,
      addDroppedRasters,
      addDroppedPhotos,
      addGeoJsonLayer,
      viewerReadOnly,
    ],
  );

  // Escape hatch for a drop overlay that outlived its drag (issue #1664).
  //
  // The overlay is driven by one boolean fed from two places: the webview drag
  // handlers above (balanced by dragDepthRef) and, on desktop, Tauri's native
  // onDragDropEvent (no counter at all, since the OS reports enter/leave/drop
  // directly). Either feed can strand it. A native "leave" that never arrives
  // — which is what a modal native file dialog opening mid-drag produces on
  // WebKitGTK — leaves the flag set with nothing left to clear it, and an
  // unbalanced webview enter/leave pair leaves dragDepthRef above zero, which
  // has the same effect. The result is an overlay covering the map until the
  // user happens to drag another file across the window.
  //
  // Rather than guess at every way the OS can swallow an event, recover on a
  // pointer button, which cannot occur while a real drag is in progress: HTML
  // drag-and-drop suppresses mouse events and a native drag holds an OS pointer
  // grab. Escape is a separate, conventional request to cancel either the
  // stranded overlay or a genuine drag.
  useEffect(() => {
    if (!isDraggingFiles) return;

    const clear = () => {
      dragDepthRef.current = 0;
      setIsDraggingFiles(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape is the one the reporter reached for first; any key would do, but
      // limiting it keeps typing in a panel from silently cancelling feedback
      // for a drag that is genuinely still running.
      if (event.key === "Escape") clear();
    };

    // Capture phase, not bubble: several controls in the app stop propagation
    // on these events before they reach window (startLayerPanelResize below is
    // one, and a focused Radix dialog handles its own Escape), which would
    // silently defeat the recovery for exactly the interaction the user is most
    // likely to try first. Capturing on window runs before any of them.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", clear, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", clear, true);
    };
  }, [isDraggingFiles]);

  const startLayerPanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      // Route all pointer events for this drag to the handle, so a touch that
      // slides off it (or off-screen) still reaches the listeners below.
      event.currentTarget.setPointerCapture?.(event.pointerId);

      const startX = event.clientX;
      const startWidth = layerPanelWidth;
      // In a right-to-left layout the panels are mirrored, so pointer deltas
      // (and the deferred-resize guide anchor) flip sign.
      const dirSign = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
      const panelRect = event.currentTarget.parentElement?.getBoundingClientRect();
      let nextWidth = startWidth;
      let resizeFrame: number | null = null;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

      const onPointerMove = (moveEvent: PointerEvent) => {
        nextWidth = clamp(
          startWidth + dirSign * (moveEvent.clientX - startX),
          MIN_SIDE_PANEL_WIDTH,
          MAX_SIDE_PANEL_WIDTH,
        );
        if (resizeFrame !== null) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = null;
          if (deferPanelResize) {
            if (verticalResizeGuideRef.current && panelRect) {
              verticalResizeGuideRef.current.style.left = `${
                dirSign === 1 ? panelRect.left + nextWidth : panelRect.right - nextWidth
              }px`;
              verticalResizeGuideRef.current.classList.remove("hidden");
            }
            return;
          }
          shellRef.current?.style.setProperty("--layer-panel-width", `${nextWidth}px`);
        });
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        activeResizeCleanupRef.current = null;
        if (resizeFrame !== null) {
          window.cancelAnimationFrame(resizeFrame);
          resizeFrame = null;
        }
        shellRef.current?.style.setProperty("--layer-panel-width", `${nextWidth}px`);
        verticalResizeGuideRef.current?.classList.add("hidden");
        setLayerPanelWidth(nextWidth);
        window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
      };

      // pointercancel fires when the gesture is interrupted (OS scroll, app
      // backgrounded); run the same teardown so styles/listeners don't stick.
      activeResizeCleanupRef.current = onPointerUp;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [deferPanelResize, layerPanelWidth],
  );

  const startStylePanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      // Route all pointer events for this drag to the handle, so a touch that
      // slides off it (or off-screen) still reaches the listeners below.
      event.currentTarget.setPointerCapture?.(event.pointerId);

      const startX = event.clientX;
      const startWidth = stylePanelWidth;
      const dirSign = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
      const panelRect = event.currentTarget.parentElement?.getBoundingClientRect();
      let nextWidth = startWidth;
      let resizeFrame: number | null = null;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

      const onPointerMove = (moveEvent: PointerEvent) => {
        nextWidth = clamp(
          startWidth + dirSign * (startX - moveEvent.clientX),
          MIN_SIDE_PANEL_WIDTH,
          MAX_SIDE_PANEL_WIDTH,
        );
        if (resizeFrame !== null) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = null;
          if (deferPanelResize) {
            if (verticalResizeGuideRef.current && panelRect) {
              verticalResizeGuideRef.current.style.left = `${
                dirSign === 1 ? panelRect.right - nextWidth : panelRect.left + nextWidth
              }px`;
              verticalResizeGuideRef.current.classList.remove("hidden");
            }
            return;
          }
          shellRef.current?.style.setProperty("--style-panel-width", `${nextWidth}px`);
        });
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        activeResizeCleanupRef.current = null;
        if (resizeFrame !== null) {
          window.cancelAnimationFrame(resizeFrame);
          resizeFrame = null;
        }
        shellRef.current?.style.setProperty("--style-panel-width", `${nextWidth}px`);
        verticalResizeGuideRef.current?.classList.add("hidden");
        setStylePanelWidth(nextWidth);
        window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
      };

      // pointercancel fires when the gesture is interrupted (OS scroll, app
      // backgrounded); run the same teardown so styles/listeners don't stick.
      activeResizeCleanupRef.current = onPointerUp;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [deferPanelResize, stylePanelWidth],
  );

  // The notebook panel is docked on the same side as the Style panel, so its
  // map-side handle widens the panel as the pointer moves toward the map
  // (mirrors startStylePanelResize, with the notebook's own constants/CSS var).
  const startNotebookPanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);

      const startX = event.clientX;
      const startWidth = notebookPanelWidth;
      const dirSign = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
      const panelRect = event.currentTarget.parentElement?.getBoundingClientRect();
      let nextWidth = startWidth;
      let resizeFrame: number | null = null;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

      const onPointerMove = (moveEvent: PointerEvent) => {
        nextWidth = clamp(
          startWidth + dirSign * (startX - moveEvent.clientX),
          MIN_NOTEBOOK_PANEL_WIDTH,
          MAX_NOTEBOOK_PANEL_WIDTH,
        );
        if (resizeFrame !== null) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = null;
          if (deferPanelResize) {
            if (verticalResizeGuideRef.current && panelRect) {
              verticalResizeGuideRef.current.style.left = `${
                dirSign === 1 ? panelRect.right - nextWidth : panelRect.left + nextWidth
              }px`;
              verticalResizeGuideRef.current.classList.remove("hidden");
            }
            return;
          }
          shellRef.current?.style.setProperty("--notebook-panel-width", `${nextWidth}px`);
        });
      };

      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        activeResizeCleanupRef.current = null;
        if (resizeFrame !== null) {
          window.cancelAnimationFrame(resizeFrame);
          resizeFrame = null;
        }
        shellRef.current?.style.setProperty("--notebook-panel-width", `${nextWidth}px`);
        verticalResizeGuideRef.current?.classList.add("hidden");
        setNotebookPanelWidth(nextWidth);
        window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
      };

      activeResizeCleanupRef.current = onPointerUp;
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [deferPanelResize, notebookPanelWidth],
  );

  return (
    <div
      ref={shellRef}
      className="relative flex h-full min-w-0 flex-col overflow-hidden bg-background"
      style={shellStyle}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {layoutOptions.toolbarVisible ? (
        <SectionErrorBoundary label="Toolbar" displayName={t("shell.section.toolbar")}>
          <TopToolbar
            compact={layoutOptions.compact}
            diagnosticsErrorCount={diagnostics.errorCount}
            mapControllerRef={mapControllerRef}
            mapReadyGeneration={mapReadyGeneration}
            showLabels={layoutOptions.toolbarLabels}
            showProjectInfo={layoutOptions.showProjectInfo}
            themeMode={themeMode}
            collaboration={collaboration}
            projectFiles={projectFiles}
            onOpenDiagnostics={() => setDiagnosticsOpen(true)}
            onOpenProjectHistory={() => {
              projectHistory.clearRestoreError();
              void projectHistory.refresh();
              setProjectHistoryOpen(true);
            }}
            onToggleThemeMode={onToggleThemeMode}
            onOpenBasemapExtract={() => setBasemapExtractOpen(true)}
            onAddComment={commentTool.toggleTool}
            viewer={layoutOptions.viewer}
          />
        </SectionErrorBoundary>
      ) : null}
      <div data-workspace-row="" className="relative flex min-h-0 flex-1 flex-col md:flex-row">
        {/* The Browser panel body is portaled into its dedicated content host
            (which the dock slots relocate between positions), so it shares the
            app's React context and the shell owns its dock chrome. */}
        {activePanelId === BROWSER_PANEL_ID && !layoutOptions.panelsHidden && !layoutOptions.viewer
          ? createPortal(
              <BrowserPanel
                mapControllerRef={mapControllerRef}
                onOpenRecentProject={projectFiles.handleOpenRecent}
                onAddFilePath={addFilePath}
              />,
              browserContentEl,
            )
          : null}
        {activePanelId === COMMENTS_PANEL_ID && !layoutOptions.panelsHidden
          ? createPortal(
              <CommentsPanel
                mapControllerRef={mapControllerRef}
                collaboration={collaboration}
                onActivateCommentTool={commentTool.toggleTool}
                isCommentToolActive={commentTool.isActive}
                onShowResolvedChange={setShowResolvedComments}
                selectedCommentId={selectedCommentId}
                onClearSelectedComment={() => setSelectedCommentId(null)}
              />,
              commentsContentEl,
            )
          : null}
        {/* Map-only / hidden-panels embeds show nothing but the map: skip the
            whole left side-dock (Layers, plugin panels, and the shared rail that
            hosts the Browser entry), not just the built-in Layers panel. */}
        {layoutOptions.panelsHidden ? null : (
          <>
            {/* The positional plugin docks flank whichever middle surface the
                Layers side shows (the shared rail or the standalone Layers
                panel): a panel moved to left/right-of-layers must stay
                reachable while a shared-rail panel such as the Browser is
                open. */}
            {!layoutOptions.viewer ? (
              <SectionErrorBoundary
                label="Plugin panel (left of Layers)"
                displayName={t("shell.section.pluginPanelLeftOfLayers")}
              >
                <PluginRightPanel
                  dock="left-of-layers"
                  contentEl={dockContentEl}
                  width={pluginPanelWidth}
                  onWidthChange={setPluginPanelWidth}
                />
              </SectionErrorBoundary>
            ) : null}
            {replaceLayersPanelId && !layoutOptions.viewer ? (
              // Shared-rail mode on the Layers (left) side: the plugin panel shares
              // the Layers sidebar surface, so a single rail lists both the workbench
              // and Layers instead of the built-in panel standing on its own.
              <SectionErrorBoundary
                label="Shared left sidebar"
                displayName={t("shell.section.sharedLeftSidebar")}
              >
                <SharedSidebar
                  key={replaceLayersPanelId}
                  side="layers"
                  pluginId={replaceLayersPanelId}
                  additionalPanelIds={replaceLayersPanelIds}
                  pluginContentEl={dockContentEl}
                  pluginWidth={pluginPanelWidth}
                  onPluginWidthChange={setPluginPanelWidth}
                  builtinVisible={layoutOptions.layerPanelVisible}
                  builtinTitle={t("sharedRail.layers")}
                  builtinIcon={<Layers className="h-4 w-4" />}
                  // The Browser docks here on by default but must not bury Layers:
                  // start with Layers expanded and Browser a collapsed rail entry.
                  // On a phone-width viewport both start collapsed (panels overlay
                  // there), matching the mobile "panels default collapsed" behavior.
                  initialBuiltinExpanded={
                    replaceLayersPanelId === BROWSER_PANEL_ID &&
                    !getIsMobileViewport() &&
                    !layoutOptions.panelsCollapsed
                  }
                  // The story-map presentation is the only standalone Layers
                  // autoCollapse trigger (the notebook collapses Style, not Layers).
                  forceBuiltinCollapsed={storymapPresenting}
                  renderBuiltin={({ collapsed, onCollapsedChange }) => (
                    <LayerPanel
                      mapControllerRef={mapControllerRef}
                      onResizeStart={startLayerPanelResize}
                      geometryEditLayerId={geometryEditLayerId}
                      onToggleGeometryEdit={handleToggleGeometryEdit}
                      onCancelGeometryEdit={handleCancelGeometryEdit}
                      onMaterializeDuckDBLayer={handleMaterializeDuckDBLayer}
                      onOpenRasterStylePanel={() =>
                        openRasterLayerPanel(createAppAPI(mapControllerRef))
                      }
                      onOpenStylePanel={
                        layoutOptions.stylePanelVisible ? openStylePanel : undefined
                      }
                      onOpenRasterSubset={setRasterSubsetLayer}
                      collapsed={collapsed}
                      onCollapsedChange={onCollapsedChange}
                      hideOwnRail
                    />
                  )}
                />
              </SectionErrorBoundary>
            ) : layoutOptions.layerPanelVisible ? (
              <SectionErrorBoundary label="Layer panel" displayName={t("shell.section.layerPanel")}>
                {layoutOptions.viewer ? (
                  <ViewerLayerPanel />
                ) : (
                  <LayerPanel
                    mapControllerRef={mapControllerRef}
                    onResizeStart={startLayerPanelResize}
                    geometryEditLayerId={geometryEditLayerId}
                    onToggleGeometryEdit={handleToggleGeometryEdit}
                    onCancelGeometryEdit={handleCancelGeometryEdit}
                    onMaterializeDuckDBLayer={handleMaterializeDuckDBLayer}
                    onOpenRasterStylePanel={() =>
                      openRasterLayerPanel(createAppAPI(mapControllerRef))
                    }
                    onOpenStylePanel={layoutOptions.stylePanelVisible ? openStylePanel : undefined}
                    onOpenRasterSubset={setRasterSubsetLayer}
                    autoCollapse={
                      storymapPresenting ||
                      layoutOptions.panelsCollapsed ||
                      autoCollapsedPanel === "layers"
                    }
                  />
                )}
              </SectionErrorBoundary>
            ) : null}
            {!layoutOptions.viewer ? (
              <SectionErrorBoundary
                label="Plugin panel (right of Layers)"
                displayName={t("shell.section.pluginPanelRightOfLayers")}
              >
                <PluginRightPanel
                  dock="right-of-layers"
                  contentEl={dockContentEl}
                  width={pluginPanelWidth}
                  onWidthChange={setPluginPanelWidth}
                />
              </SectionErrorBoundary>
            ) : null}
          </>
        )}
        <main
          // `isolate` creates a stacking context so map-panel z-indexes (up to 10000) stay below body-portaled dialogs. See #451.
          className={`relative isolate min-w-0 flex-1 overflow-hidden ${
            layoutOptions.compact ? "min-h-0" : "min-h-72 md:min-h-0"
          }`}
        >
          {/* Visually-hidden page title: gives the document the single
              top-level heading that assistive tech (and the axe
              `page-has-heading-one` check) expect, without altering the
              chrome-free visual layout. Placed inside the main landmark so it
              is not flagged as content outside a landmark. */}
          <h1 className="sr-only">{t("shell.workspaceTitle")}</h1>
          <SectionErrorBoundary
            label="Map"
            displayName={t("shell.section.map")}
            fallbackClassName="h-full w-full"
          >
            <MapGrid>
              <MapCanvas
                canUseRemoteElevation={hasElevationConsent}
                controllerRef={mapControllerRef}
                onMapDiagnosticEvent={handleMapDiagnosticEvent}
                onControllerReady={handleMapControllerReady}
              />
              <RemoteCursorsOverlay mapControllerRef={mapControllerRef} />
              <CommentMapOverlay
                mapControllerRef={mapControllerRef}
                onSelectComment={(commentId) => {
                  setSelectedCommentId(commentId);
                  openRightPanel(COMMENTS_PANEL_ID);
                }}
                showResolved={showResolvedComments}
              />
              <MapContextMenu
                mapControllerRef={mapControllerRef}
                mapReadyGeneration={mapReadyGeneration}
                onExplorePlace={handleExplorePlace}
              />
              <KnowledgeCardPanel
                place={knowledgePlace}
                lang={wikipediaLang(i18n.language)}
                onClose={() => setKnowledgePlace(null)}
                onFlyTo={handleKnowledgeFlyTo}
              />
              <BoundsRestrictionIndicator />
              {/* Isolate the collaboration badge in its own boundary: it renders
                  over the map, so a fault here must never take down the map
                  itself (it shares this subtree's error boundary otherwise). */}
              <SilentErrorBoundary label="Collaboration status">
                <CollaborationStatusBadge api={collaboration} mapControllerRef={mapControllerRef} />
              </SilentErrorBoundary>
              <MapModeBanner mapControllerRef={mapControllerRef} />
              <QuickAnalysisBanner />
              <PixelTimeSeriesControl mapControllerRef={mapControllerRef} />
              <NetcdfSampleMarkers
                mapControllerRef={mapControllerRef}
                mapReadyGeneration={mapReadyGeneration}
              />
              <NetcdfProfileWindow />
              {/* Its own boundary: the cube window builds a `WebGLRenderer`,
                  whose constructor throws outright when the browser or driver
                  gives it no context. Sharing the map's boundary would turn a
                  failure to draw one panel into the loss of the whole map. */}
              <SilentErrorBoundary label="NetCDF 3D cube">
                <NetcdfCubeWindow mapControllerRef={mapControllerRef} />
              </SilentErrorBoundary>
              <NetcdfCubeSetupDialog mapControllerRef={mapControllerRef} />
              <MapLegendPanel
                mapControllerRef={mapControllerRef}
                mapReadyGeneration={mapReadyGeneration}
              />
              <RasterSubsetPanel
                layer={rasterSubsetLayer}
                onClose={() => setRasterSubsetLayer(null)}
                mapControllerRef={mapControllerRef}
              />
              <BasemapExtractPanel
                open={basemapExtractOpen}
                onClose={() => setBasemapExtractOpen(false)}
                mapControllerRef={mapControllerRef}
              />
              <Suspense fallback={null}>
                <StyleManagerPanel />
              </Suspense>
              <Suspense fallback={null}>
                <ObjectDetectionDialog mapControllerRef={mapControllerRef} />
              </Suspense>
              <Suspense fallback={null}>
                <SegmentEverythingPanel mapControllerRef={mapControllerRef} />
              </Suspense>
              <TerrainSettingsDialog mapControllerRef={mapControllerRef} />
              <StoryMapComposeBar mapControllerRef={mapControllerRef} />
            </MapGrid>
          </SectionErrorBoundary>
          <SectionErrorBoundary
            label="Plugin floating panels"
            displayName={t("shell.section.pluginFloatingPanels")}
          >
            <FloatingPanels />
          </SectionErrorBoundary>
          {/* Mounted here (inside the map area, like FloatingPanels) so the
              selection panels anchor to the map canvas's top-left corner and
              drag-clamp to the map, not the whole window (#1314). */}
          <SectionErrorBoundary
            label="Selection panels"
            displayName={t("shell.section.selectionPanels")}
          >
            <Suspense fallback={null}>
              <SelectByExpressionDialog />
            </Suspense>
            <Suspense fallback={null}>
              <SelectByLocationDialog />
            </Suspense>
          </SectionErrorBoundary>
          <SectionErrorBoundary
            label="Sun simulation panel"
            displayName={t("shell.section.sunSimulationPanel")}
          >
            <SunPanel />
          </SectionErrorBoundary>
          <SectionErrorBoundary
            label="Route animation panel"
            displayName={t("shell.section.routeAnimationPanel")}
          >
            <RouteAnimationPanel mapControllerRef={mapControllerRef} />
          </SectionErrorBoundary>
          <SectionErrorBoundary
            label="Flight simulator panel"
            displayName={t("shell.section.flightSimulatorPanel")}
          >
            <FlightSimulatorPanel />
          </SectionErrorBoundary>
          <KnowledgeCardConsentDialog
            open={knowledgeNoticeOpen}
            onOpenChange={(open) => {
              setKnowledgeNoticeOpen(open);
              // Clear the paired pending place when the notice is dismissed
              // (Cancel/Escape/overlay), mirroring dismissRoutingNotice so no
              // stale target lingers. Confirm sets the place before this runs.
              if (!open) setPendingKnowledgePlace(null);
            }}
            onConfirm={confirmKnowledgeConsent}
          />
          {/* Rendered here (not in TopToolbar) so the dialog the status badge
              reopens stays mounted even in toolbar-hidden layouts (#754). */}
          {collaboration.enabled && (
            <CollaborateDialog
              open={collaborateDialogOpen}
              onOpenChange={setCollaborateDialogOpen}
              api={collaboration}
            />
          )}
        </main>
        {/* Same as the left dock: a map-only / hidden-panels embed skips the
            entire right side-dock (Style, plugin panels, and their shared rail). */}
        {layoutOptions.panelsHidden || layoutOptions.viewer ? null : (
          <>
            {/* Shared-rail panels such as Comments must not remove the ordinary
                positional docks: enabled Web Services panels still live in
                left/right-of-style and need their vertical rail entries. Both
                flank whichever middle surface applies, so they are rendered
                once here rather than duplicated per branch. */}
            <SectionErrorBoundary
              label="Plugin panel (left of Style)"
              displayName={t("shell.section.pluginPanelLeftOfStyle")}
            >
              <PluginRightPanel
                dock="left-of-style"
                contentEl={dockContentEl}
                width={pluginPanelWidth}
                onWidthChange={setPluginPanelWidth}
              />
            </SectionErrorBoundary>
            {replaceStylePanelId ? (
              <SectionErrorBoundary
                label="Shared right sidebar"
                displayName={t("shell.section.sharedRightSidebar")}
              >
                <SharedSidebar
                  // Key by the active panel id so switching between two replace-style
                  // plugins remounts the sidebar, resetting its per-panel local state
                  // (the Style opt-in) rather than carrying the previous plugin over.
                  key={replaceStylePanelId}
                  side="style"
                  pluginId={replaceStylePanelId}
                  additionalPanelIds={replaceStylePanelIds}
                  pluginContentEl={dockContentEl}
                  pluginWidth={pluginPanelWidth}
                  onPluginWidthChange={setPluginPanelWidth}
                  builtinVisible={layoutOptions.stylePanelVisible}
                  builtinTitle={t("sharedRail.style")}
                  builtinIcon={<SlidersHorizontal className="h-4 w-4" />}
                  // Mirror the standalone Style panel's autoCollapse triggers so the
                  // notebook / story-map presentation collapses Style here too.
                  // `autoCollapsedPanel` is omitted because it is always null in a
                  // shared-rail mode (the panel is the sole active one).
                  forceBuiltinCollapsed={notebookOpen || storymapPresenting}
                  renderBuiltin={({ collapsed, onCollapsedChange }) => (
                    <StylePanel
                      mapControllerRef={mapControllerRef}
                      onResizeStart={startStylePanelResize}
                      openRequest={stylePanelOpenRequest}
                      collapsed={collapsed}
                      onCollapsedChange={onCollapsedChange}
                      // Controlled mode ignores autoCollapse for collapsing (the
                      // rail owns that via forceBuiltinCollapsed); it is passed so
                      // a layer selection cannot expand Style over the notebook.
                      autoCollapse={notebookOpen || storymapPresenting}
                      hideOwnRail
                    />
                  )}
                />
              </SectionErrorBoundary>
            ) : /* The notebook claims the workspace's right half, so the Style panel
                collapses to its rail while the notebook is open (Processing →
                Jupyter Notebook) rather than unmounting; the user can re-expand it.
                A story map presentation collapses it for the same reason. */
            layoutOptions.stylePanelVisible ? (
              <SectionErrorBoundary label="Style panel" displayName={t("shell.section.stylePanel")}>
                <StylePanel
                  mapControllerRef={mapControllerRef}
                  onResizeStart={startStylePanelResize}
                  openRequest={stylePanelOpenRequest}
                  autoCollapse={
                    notebookOpen ||
                    storymapPresenting ||
                    layoutOptions.panelsCollapsed ||
                    autoCollapsedPanel === "style"
                  }
                />
              </SectionErrorBoundary>
            ) : null}
            <SectionErrorBoundary
              label="Plugin panel (right of Style)"
              displayName={t("shell.section.pluginPanelRightOfStyle")}
            >
              <PluginRightPanel
                dock="right-of-style"
                contentEl={dockContentEl}
                width={pluginPanelWidth}
                onWidthChange={setPluginPanelWidth}
              />
            </SectionErrorBoundary>
          </>
        )}
        {notebookOpen ? (
          <SectionErrorBoundary label="Notebook" displayName={t("shell.section.notebook")}>
            <Suspense fallback={null}>
              <NotebookPanel
                onResizeStart={startNotebookPanelResize}
                mapControllerRef={mapControllerRef}
                themeMode={themeMode}
              />
            </Suspense>
          </SectionErrorBoundary>
        ) : null}
      </div>
      {layoutOptions.attributePanelVisible ? (
        <SectionErrorBoundary
          label="Attribute table"
          displayName={t("shell.section.attributeTable")}
        >
          <AttributeTable mapControllerRef={mapControllerRef} />
        </SectionErrorBoundary>
      ) : null}
      {layoutOptions.attributePanelVisible ? (
        <SectionErrorBoundary
          label="Raster attribute table"
          displayName={t("shell.section.rasterAttributeTable")}
        >
          <RasterAttributeTable />
        </SectionErrorBoundary>
      ) : null}
      {dashboardOpen ? (
        <SectionErrorBoundary label="Dashboard" displayName={t("shell.section.dashboard")}>
          <Suspense fallback={null}>
            <DashboardPanel />
          </Suspense>
        </SectionErrorBoundary>
      ) : null}
      {pythonConsoleOpen ? (
        <SectionErrorBoundary
          label="Python console"
          displayName={t("shell.section.pythonConsole")}
          onClose={() => setPythonConsoleOpen(false)}
        >
          <Suspense fallback={null}>
            <PythonConsolePanel mapControllerRef={mapControllerRef} />
          </Suspense>
        </SectionErrorBoundary>
      ) : null}
      {sqlWorkspaceOpen ? (
        <SectionErrorBoundary
          label="SQL workspace"
          displayName={t("shell.section.sqlWorkspace")}
          onClose={() => setSqlWorkspaceOpen(false)}
        >
          <Suspense fallback={null}>
            <SqlWorkspacePanel />
          </Suspense>
        </SectionErrorBoundary>
      ) : null}
      {assistantOpen ? (
        <SectionErrorBoundary label="Assistant" displayName={t("shell.section.assistant")}>
          <Suspense fallback={null}>
            <AssistantPanel mapControllerRef={mapControllerRef} />
          </Suspense>
        </SectionErrorBoundary>
      ) : null}
      {layoutOptions.statusBarVisible ? (
        <SectionErrorBoundary label="Status bar" displayName={t("shell.section.statusBar")}>
          <StatusBar
            compact={layoutOptions.compact}
            diagnosticsErrorCount={diagnostics.errorCount}
            diagnosticsWarningCount={diagnostics.warningCount}
            onOpenDiagnostics={() => setDiagnosticsOpen(true)}
          />
        </SectionErrorBoundary>
      ) : null}
      <DiagnosticsDialog
        diagnostics={diagnostics}
        open={diagnosticsOpen}
        onOpenChange={setDiagnosticsOpen}
      />
      <ProjectHistoryDialog
        open={projectHistoryOpen}
        onOpenChange={(open) => {
          setProjectHistoryOpen(open);
          if (!open) projectHistory.clearRestoreError();
        }}
        snapshots={projectHistory.snapshots}
        restoreError={projectHistory.restoreError}
        onRestore={projectHistory.restore}
      />
      <ProjectRecoveryDialog
        snapshot={projectHistory.recoverySnapshot}
        restoreError={projectHistory.restoreError}
        onRestore={projectHistory.restore}
        onDiscard={() => {
          projectHistory.clearRestoreError();
          projectHistory.discardRecovery();
        }}
        onDismiss={() => {
          projectHistory.clearRestoreError();
          projectHistory.dismissRecovery();
        }}
      />
      {/* Mounted in the always-rendered shell (not the toolbar) so the bookmark
          export name prompt works even when the toolbar is hidden (`?maponly`). */}
      <FileNamePromptDialog />
      {/* Trust prompt for plugin URLs carried by an opened project (#1062);
          inert unless the project references an untrusted plugin URL. */}
      <ProjectPluginTrustDialog trust={projectPluginTrust} />
      <Suspense fallback={null}>
        <ProcessingDialog
          mapControllerRef={mapControllerRef}
          onAddRaster={async (bytes, name, fileName) => {
            // Cast required: TS types Uint8Array as Uint8Array<ArrayBufferLike>,
            // which is not directly assignable to BlobPart under this lib.
            // `fileName` (when given) becomes the layer's sourcePath while `name`
            // stays the human-readable display name; the control keeps them
            // separate (info.source.fileName vs info.name).
            const file = new File([bytes as BlobPart], fileName ?? `${name}.tif`, {
              type: "image/tiff",
            });
            await addRasterToMap(createAppAPI(mapControllerRef), file, {
              name,
            });
          }}
        />
      </Suspense>
      <Suspense fallback={null}>
        <ConversionDialog />
      </Suspense>
      <Suspense fallback={null}>
        <VectorToolsDialog mapControllerRef={mapControllerRef} />
      </Suspense>
      <Suspense fallback={null}>
        <NetworkToolsDialog mapControllerRef={mapControllerRef} />
      </Suspense>
      <Suspense fallback={null}>
        <ModelBuilderDialog mapControllerRef={mapControllerRef} />
      </Suspense>
      <Suspense fallback={null}>
        <StatisticsToolsDialog mapControllerRef={mapControllerRef} />
      </Suspense>
      <Suspense fallback={null}>
        <GeocodeDialog mapControllerRef={mapControllerRef} />
      </Suspense>
      <Suspense fallback={null}>
        <ProcessingHistoryDialog />
      </Suspense>
      <Suspense fallback={null}>
        <RasterToolsDialog mapControllerRef={mapControllerRef} />
      </Suspense>
      <Suspense fallback={null}>
        <SegmentationDialog mapControllerRef={mapControllerRef} />
      </Suspense>
      <StoryMapPanel mapControllerRef={mapControllerRef} />
      <StoryMapPresenter mapControllerRef={mapControllerRef} />
      <div
        ref={verticalResizeGuideRef}
        className="pointer-events-none fixed bottom-7 top-11 z-50 hidden w-px bg-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.25)]"
      />
      {isDraggingFiles ? (
        <div
          data-testid="file-drop-overlay"
          className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
        >
          <div className="max-w-sm rounded-md border bg-background px-4 py-3 text-center shadow-lg">
            <p className="text-sm font-medium">{t("toolbar.fileDrop.overlayTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("toolbar.fileDrop.overlaySubtext")}
            </p>
          </div>
        </div>
      ) : null}
      {projectUrlLoadState?.error ? (
        <div
          aria-live="assertive"
          className="pointer-events-none absolute left-1/2 top-14 z-50 max-w-[min(90vw,32rem)] -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-center text-sm text-destructive shadow-lg"
        >
          {projectUrlLoadState.error}
        </div>
      ) : null}
      {dataUrlLoadState?.error ? (
        // A link can carry both `url=` and `data=`, and both loaders can fail.
        // Drop below the project banner so neither message is covered.
        <div
          aria-live="assertive"
          className={`pointer-events-none absolute left-1/2 z-50 max-w-[min(90vw,32rem)] -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-center text-sm text-destructive shadow-lg ${
            projectUrlLoadState?.error ? "top-28" : "top-14"
          }`}
        >
          {dataUrlLoadState.error}
        </div>
      ) : null}
      {crsWarning ? (
        <div
          data-testid="crs-warning"
          role="status"
          aria-live="polite"
          className="absolute bottom-24 left-1/2 z-50 max-w-[min(90vw,36rem)] -translate-x-1/2 rounded-md border border-destructive/40 bg-background px-3 py-2 text-center text-sm text-destructive shadow-lg"
        >
          {crsWarning}
          <button
            type="button"
            onClick={() => setCrsWarning(null)}
            className="ms-2 underline underline-offset-2"
          >
            {t("common.close")}
          </button>
        </div>
      ) : null}
      {dropMessage || dropError ? (
        <div
          data-testid="drop-status"
          data-drop-error={dropError ? "true" : undefined}
          aria-live="polite"
          className={`pointer-events-none absolute bottom-10 left-1/2 z-50 -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-sm shadow-lg ${
            dropError ? "text-destructive" : "text-foreground"
          }`}
        >
          {dropError ?? dropMessage}
        </div>
      ) : null}
      {commentTool.pendingComment && (
        <AddCommentDialog
          pendingComment={commentTool.pendingComment}
          onSubmit={commentTool.submitComment}
          onCancel={commentTool.cancelPendingComment}
        />
      )}
    </div>
  );
}
