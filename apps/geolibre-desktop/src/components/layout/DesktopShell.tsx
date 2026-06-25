import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type { MapController, MapDiagnosticEvent } from "@geolibre/map";
import { MapCanvas, setExternalDeckLayerOrderHandler } from "@geolibre/map";
import { useTranslation } from "react-i18next";
import {
  addRasterToMap,
  applyRasterLayerOrder,
  DECK_VIZ_PLUGIN_ID,
  DIRECTIONS_PLUGIN_ID,
  EFFECTS_PLUGIN_ID,
  endLayerGeometryEdit,
  getGeometryEditTargetLayerId,
  openRasterLayerPanel,
  getRightPanel,
  restoreDeckViz,
  restoreDirections,
  restoreReverseGeocode,
  REVERSE_GEOCODE_PLUGIN_ID,
  restoreEffects,
  restoreLidarLayers,
  restoreRasterLayers,
  restoreThreeDTilesLayers,
  restoreVectorLayers,
  setBookmarkLabels,
  setNonTiledRasterHandler,
  setViewStateLabels,
  startLayerGeometryEdit,
  subscribeGeometryEdit,
} from "@geolibre/plugins";
import { convertGeoTiffToCog, readGeoTiffInfo } from "@geolibre/processing";
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
import {
  isTauri,
  loadDroppedPhotoFiles,
  loadDroppedPhotoPaths,
  loadDroppedRasterFiles,
  loadDroppedRasterPaths,
  loadDroppedVectorFiles,
  loadDroppedVectorPaths,
  type DroppedRaster,
} from "../../lib/tauri-io";
import {
  isPhotoDropFileName,
  type GeotaggedPhotoResult,
} from "../../lib/geotagged-photos";
import type { LargeVectorDataset } from "../../lib/duckdb-vector-guard";
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
  useSwipeSplitViewExclusivity,
} from "../../hooks/usePlugins";
import { registerMbtilesProtocol } from "../../lib/mbtiles";
import { hasReverseGeocodeConsent } from "../../lib/reverse-geocode-consent";
import { registerXyzTileProtocol } from "../../lib/xyz-url";
import { useEmbedBridge } from "../../hooks/useEmbedBridge";
import { useRasterIdentify } from "../../hooks/useRasterIdentify";
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
import { PixelTimeSeriesControl } from "./PixelTimeSeriesControl";
import { MapContextMenu } from "./MapContextMenu";
import { MapGrid } from "./MapGrid";
import { RemoteCursorsOverlay } from "./RemoteCursorsOverlay";
import { useCommandBridge } from "../../hooks/useCommandBridge";
import {
  appendDiagnostic,
  useDiagnosticsSnapshot,
} from "../../lib/diagnostics";
import {
  SectionErrorBoundary,
  SilentErrorBoundary,
} from "../common/error-boundaries";
import { AttributeTable } from "../panels/AttributeTable";
import { LayerPanel } from "../panels/LayerPanel";
import { FloatingPanels } from "../panels/FloatingPanels";
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

const SqlWorkspaceDialog = lazy(() =>
  import("../processing/SqlWorkspaceDialog")
    .then((module) => ({
      default: module.SqlWorkspaceDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load SqlWorkspaceDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/SqlWorkspaceDialog").SqlWorkspaceDialog;
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
  themeMode: ThemeMode;
  onToggleThemeMode: () => void;
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

type ImportedVectorLayer = Awaited<
  ReturnType<typeof loadDroppedVectorFiles>
>[number];

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
const PANEL_RESIZE_START_EVENT = "geolibre:panel-resize-start";
const PANEL_RESIZE_END_EVENT = "geolibre:panel-resize-end";

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
  Record<
    "--layer-panel-width" | "--style-panel-width" | "--notebook-panel-width",
    string
  >;

export function DesktopShell({
  layoutOptions,
  projectUrlLoadState,
  themeMode,
  onToggleThemeMode,
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
  const dragDepthRef = useRef(0);
  const dropMessageTimeoutRef = useRef<number | null>(null);
  const materializingRef = useRef(false);
  const togglingGeometryEditRef = useRef(false);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const projectGeneration = useAppStore((s) => s.projectGeneration);
  const pythonConsoleOpen = useAppStore((s) => s.ui.pythonConsoleOpen);
  const setPythonConsoleOpen = useAppStore((s) => s.setPythonConsoleOpen);
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
  const [pluginPanelWidth, setPluginPanelWidth] = useState(
    PLUGIN_PANEL_DEFAULT_WIDTH,
  );
  // The active plugin panel's content lives in this one host element (created
  // once per app instance). The active dock slot adopts it via appendChild, so
  // moving the panel between docks relocates the same DOM and preserves the
  // plugin's state. `contents` keeps it transparent to layout.
  const [pluginContentEl] = useState(() => {
    const el = document.createElement("div");
    el.className = "contents";
    return el;
  });
  const activePanelId = useRightPanelState().activeId;
  const activePanel = activePanelId ? getRightPanel(activePanelId) : undefined;
  // Render the active panel into the shared host once; re-run when its
  // registration is replaced (re-registration refresh) but not on dock/collapse
  // changes.
  useEffect(() => {
    const host = pluginContentEl;
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
  }, [activePanelId, activePanel, pluginContentEl]);
  // Reset the shared width to the panel's default when a new panel activates
  // (keyed on activePanelId only, so a user resize survives re-registration).
  useEffect(() => {
    if (!activePanel) return;
    setPluginPanelWidth(
      clampPluginPanelWidth(activePanel.defaultWidth ?? PLUGIN_PANEL_DEFAULT_WIDTH),
    );
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
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const diagnostics = useDiagnosticsSnapshot();
  const externalPluginsReady = useExternalPluginsReady(mapControllerRef);
  // Keep Layer Swipe and split view mutually exclusive (#844): entering a
  // multi-pane grid turns the swipe slider off.
  useSwipeSplitViewExclusivity(mapControllerRef);
  // Live-collaboration session. Owned here (rather than in TopToolbar) so both
  // the Collaborate dialog and the on-canvas status badge share one socket, and
  // so the dialog stays mounted in toolbar-hidden layouts.
  const collaboration = useCollaboration(mapControllerRef);
  const collaborateDialogOpen = useAppStore((s) => s.ui.collaborateDialogOpen);
  const setCollaborateDialogOpen = useAppStore(
    (s) => s.setCollaborateDialogOpen,
  );
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
  // Routes the Layers-panel Identify action to the raster pixel inspector for
  // COG layers (read band values on click). Inert until a COG is identified.
  useRasterIdentify();
  const [layerPanelWidth, setLayerPanelWidth] = useState(initialSidePanelWidth);
  const [stylePanelWidth, setStylePanelWidth] = useState(initialSidePanelWidth);
  const [notebookPanelWidth, setNotebookPanelWidth] = useState(
    DEFAULT_NOTEBOOK_PANEL_WIDTH,
  );
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
    const styleRailWidth = layoutOptions.stylePanelVisible
      ? COLLAPSED_PANEL_RAIL_WIDTH
      : 0;
    const half = Math.round((shellWidth - layerWidth - styleRailWidth) / 2);
    // Honor the same min/max bounds as the drag-resize handler so the auto-size
    // and manual-resize paths cannot diverge (an ultrawide shell would otherwise
    // initialize past MAX, a width the user could never drag back to).
    setNotebookPanelWidth(
      clamp(half, MIN_NOTEBOOK_PANEL_WIDTH, MAX_NOTEBOOK_PANEL_WIDTH),
    );
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
    const layer = useAppStore
      .getState()
      .layers.find((candidate) => candidate.id === layerId);
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
        useAppStore
          .getState()
          .updateLayer(layerId, { geojson: data as FeatureCollection });
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
        if (!manager.isActive("maplibre-gl-geo-editor")) {
          manager.activate("maplibre-gl-geo-editor", appAPI);
          if (!manager.isActive("maplibre-gl-geo-editor")) {
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
      const query =
        typeof layer.metadata.query === "string" ? layer.metadata.query : null;
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
        const created = useAppStore
          .getState()
          .layers.find((candidate) => candidate.id === id);
        if (created) mapControllerRef.current?.fitLayer(created);
        setDropMessage(
          `Materialized ${result.geojson.features.length.toLocaleString()} features.`,
        );
      } catch (error) {
        setDropMessage(null);
        setDropError(
          error instanceof Error
            ? error.message
            : "Could not materialize this layer.",
        );
      } finally {
        materializingRef.current = false;
        clearDropMessageLater();
      }
    },
    [addGeoJsonLayer, clearDropMessageLater],
  );

  useEffect(() => {
    if (isTauri()) {
      registerMbtilesProtocol();
      registerXyzTileProtocol();
    }
  }, []);

  // When a local GeoTIFF fails to load because it is striped (not a tiled COG),
  // offer to convert it to a COG in the browser and load the result. The raster
  // plugin detects the case and hands us the bytes; the conversion and the
  // prompt live here because this layer has i18n and the client-side converter.
  // See opengeos/GeoLibre#789.
  useEffect(() => {
    setNonTiledRasterHandler(async ({ name, readBytes, dismiss }) => {
      try {
        const bytes = await readBytes();
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
        const cog = await convertGeoTiffToCog(bytes);
        // The cast is required: TS types Uint8Array as Uint8Array<ArrayBufferLike>,
        // which is not directly assignable to BlobPart's ArrayBufferView.
        const file = new File([cog as BlobPart], name, { type: "image/tiff" });
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
    if (
      !externalPluginsReady ||
      !mapReadyGeneration ||
      !mapControllerRef.current
    )
      return;
    const appAPI = createAppAPI(mapControllerRef);
    const pluginManager = getPluginManager();
    pluginManager.restoreProjectState(
      useAppStore.getState().projectPlugins,
      appAPI,
    );
    restoreThreeDTilesLayers(appAPI);
    restoreRasterLayers(appAPI);
    restoreVectorLayers(appAPI);
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
    // Let layer-sync push the store-derived beforeId into the raster control so
    // deck.gl COG rasters interleave with vector layers instead of always
    // drawing on top.
    setExternalDeckLayerOrderHandler(applyRasterLayerOrder);
    // activeByDefault plugins are marked active without activate() being
    // called, so the effects engine must be kicked explicitly to match the
    // restored active state (idempotent).
    restoreEffects(
      appAPI,
      pluginManager.isActive(EFFECTS_PLUGIN_ID),
      useAppStore.getState().projectPlugins?.settings?.[EFFECTS_PLUGIN_ID],
    );
    // Rebind the directions tool to the (possibly new) map instance after a
    // map re-init, since restoreProjectState skips an already-active plugin.
    restoreDirections(appAPI, pluginManager.isActive(DIRECTIONS_PLUGIN_ID));
    // Reverse geocode sends clicked coordinates to a public geocoder. If a
    // restored project marks it active but this device never acknowledged the
    // privacy notice, deactivate it so no coordinates are sent without consent;
    // the user must re-enable it (which shows the notice). This makes the
    // consent gate cover every activation path, not just the toolbar toggle.
    if (
      pluginManager.isActive(REVERSE_GEOCODE_PLUGIN_ID) &&
      !hasReverseGeocodeConsent()
    ) {
      pluginManager.deactivate(REVERSE_GEOCODE_PLUGIN_ID, appAPI);
    }
    restoreReverseGeocode(
      appAPI,
      pluginManager.isActive(REVERSE_GEOCODE_PLUGIN_ID),
    );
    // Same contract for the deck.gl overlay: re-attach it to the current map
    // and re-render any deckgl-viz layers a restored project carries.
    restoreDeckViz(appAPI, pluginManager.isActive(DECK_VIZ_PLUGIN_ID));
    const search = window.location.search;
    void pluginManager
      .handleUrlParameters(
        new URLSearchParams(search),
        appAPI,
        `${projectGeneration}:${search}`,
      )
      .catch(console.error);
  }, [externalPluginsReady, mapReadyGeneration, projectGeneration]);

  useEffect(() => {
    return () => {
      if (dropMessageTimeoutRef.current !== null) {
        window.clearTimeout(dropMessageTimeoutRef.current);
      }
    };
  }, []);

  const handleMapControllerReady = useCallback(() => {
    setMapReadyGeneration((generation) => generation + 1);
  }, []);

  // Keep the on-map compass (reset pitch/bearing) control's tooltip translated.
  // Re-runs when the controller (re)initialises (mapReadyGeneration) and on
  // language change (t identity changes), since that native control lives
  // outside React.
  useEffect(() => {
    mapControllerRef.current?.setCompassLabel(
      t("toolbar.item.resetPitchBearing"),
    );
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
      for (const layer of importedLayers) {
        // `||` (not `??`) so an empty-string name falls back to the path, and
        // matches the name shown in the drop confirmation toast.
        lastLayerId = addGeoJsonLayer(
          layer.name || layerNameFromPath(layer.path),
          layer.data,
          layer.path,
        );
      }

      const importedLayer = useAppStore
        .getState()
        .layers.find((layer) => layer.id === lastLayerId);
      if (importedLayer) mapControllerRef.current?.fitLayer(importedLayer);
    },
    [addGeoJsonLayer],
  );

  const addDroppedPhotos = useCallback(
    (result: GeotaggedPhotoResult | null): number => {
      if (!result || result.located === 0) return 0;
      const layerId = addGeoJsonLayer(
        t("addData.photos.defaultName"),
        result.featureCollection,
      );
      const layer = useAppStore
        .getState()
        .layers.find((existing) => existing.id === layerId);
      if (layer) mapControllerRef.current?.fitLayer(layer);
      // Report skipped (no-GPS) photos too, mirroring the Add Data dialog's
      // summary, so a partially-skipped drop isn't silent.
      const summary = t("addData.photos.addedSummary", {
        count: result.located,
      });
      const skippedNote =
        result.skipped > 0
          ? ` ${t("addData.photos.skippedNote", { count: result.skipped })}`
          : "";
      setDropMessage(summary + skippedNote);
      return result.located;
    },
    [addGeoJsonLayer, t],
  );

  const addDroppedRasters = useCallback(
    async (rasters: DroppedRaster[]): Promise<number> => {
      if (!rasters.length) return 0;
      const appAPI = createAppAPI(mapControllerRef);
      for (const raster of rasters) {
        await addRasterToMap(appAPI, raster.source, { name: raster.name });
      }
      return rasters.length;
    },
    [],
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

  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | null = null;
    let disposed = false;

    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      if (disposed) return;
      void getCurrentWebview()
        .onDragDropEvent(async (event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setIsDraggingFiles(true);
            return;
          }

          if (event.payload.type === "leave") {
            setIsDraggingFiles(false);
            return;
          }

          setIsDraggingFiles(false);
          setDropError(null);
          setDropMessage("Importing data...");

          try {
            const paths = event.payload.paths;
            // OSM PBF files split into three layers, so they bypass the normal
            // single-FeatureCollection pipeline (which would otherwise route a
            // .pbf to DuckDB ST_Read and merge it).
            const pbfPaths = paths.filter((path) => isOsmPbfFileName(path));
            const otherPaths = paths.filter(
              (path) => !isOsmPbfFileName(path),
            );

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
                    bytes.byteOffset === 0 &&
                    bytes.byteLength === bytes.buffer.byteLength
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
              setDropError(
                t("addData.photos.errorNoGps", { count: photoResult.total }),
              );
            }
            const restPaths = otherPaths.filter(
              (path) => !isPhotoDropFileName(path),
            );

            if (restPaths.length > 0) {
              const rasterCount = await addDroppedRasters(
                await loadDroppedRasterPaths(restPaths),
              );
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
            setDropError(
              error instanceof Error
                ? error.message
                : "Could not import files.",
            );
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
  }, [clearDropMessageLater,
    finishDrop,
    addDroppedRasters,
    addDroppedPhotos,
    addGeoJsonLayer]);

  const handleDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFiles(false);
  }, []);

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      if (!hasDroppedFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDraggingFiles(false);
      setDropError(null);
      setDropMessage("Importing data...");

      try {
        const allFiles = Array.from(event.dataTransfer.files);
        // OSM PBF files produce three separate layers (points/lines/polygons),
        // so they bypass the single-FeatureCollection vector drop pipeline.
        // Handle them first, then run the rest through the normal pipeline —
        // finishDrop throws on an empty list, so only call it when non-PBF
        // files were dropped.
        const pbfFiles = allFiles.filter((file) => isOsmPbfFileName(file.name));
        const otherFiles = allFiles.filter(
          (file) => !isOsmPbfFileName(file.name),
        );

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
          setDropError(
            t("addData.photos.errorNoGps", { count: photoResult.total }),
          );
        }
        const restFiles = otherFiles.filter(
          (file) => !isPhotoDropFileName(file.name),
        );

        if (restFiles.length > 0) {
          const rasterCount = await addDroppedRasters(
            loadDroppedRasterFiles(restFiles),
          );
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
        setDropError(
          error instanceof Error ? error.message : "Could not import files.",
        );
      } finally {
        clearDropMessageLater();
      }
    },
    [clearDropMessageLater,
    finishDrop,
    addDroppedRasters,
    addDroppedPhotos,
    addGeoJsonLayer],
  );

  const startLayerPanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      // Route all pointer events for this drag to the handle, so a touch that
      // slides off it (or off-screen) still reaches the listeners below.
      event.currentTarget.setPointerCapture?.(event.pointerId);

      const startX = event.clientX;
      const startWidth = layerPanelWidth;
      const panelRect =
        event.currentTarget.parentElement?.getBoundingClientRect();
      let nextWidth = startWidth;
      let resizeFrame: number | null = null;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

      const onPointerMove = (moveEvent: PointerEvent) => {
        nextWidth = clamp(
          startWidth + moveEvent.clientX - startX,
          MIN_SIDE_PANEL_WIDTH,
          MAX_SIDE_PANEL_WIDTH,
        );
        if (resizeFrame !== null) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = null;
          if (deferPanelResize) {
            if (verticalResizeGuideRef.current && panelRect) {
              verticalResizeGuideRef.current.style.left = `${
                panelRect.left + nextWidth
              }px`;
              verticalResizeGuideRef.current.classList.remove("hidden");
            }
            return;
          }
          shellRef.current?.style.setProperty(
            "--layer-panel-width",
            `${nextWidth}px`,
          );
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
        shellRef.current?.style.setProperty(
          "--layer-panel-width",
          `${nextWidth}px`,
        );
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
      const panelRect =
        event.currentTarget.parentElement?.getBoundingClientRect();
      let nextWidth = startWidth;
      let resizeFrame: number | null = null;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

      const onPointerMove = (moveEvent: PointerEvent) => {
        nextWidth = clamp(
          startWidth + startX - moveEvent.clientX,
          MIN_SIDE_PANEL_WIDTH,
          MAX_SIDE_PANEL_WIDTH,
        );
        if (resizeFrame !== null) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = null;
          if (deferPanelResize) {
            if (verticalResizeGuideRef.current && panelRect) {
              verticalResizeGuideRef.current.style.left = `${
                panelRect.right - nextWidth
              }px`;
              verticalResizeGuideRef.current.classList.remove("hidden");
            }
            return;
          }
          shellRef.current?.style.setProperty(
            "--style-panel-width",
            `${nextWidth}px`,
          );
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
        shellRef.current?.style.setProperty(
          "--style-panel-width",
          `${nextWidth}px`,
        );
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

  // The notebook panel is right-docked like the Style panel, so its left-edge
  // handle widens the panel as the pointer moves left (mirrors
  // startStylePanelResize, with the notebook's own width constants/CSS var).
  const startNotebookPanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);

      const startX = event.clientX;
      const startWidth = notebookPanelWidth;
      const panelRect =
        event.currentTarget.parentElement?.getBoundingClientRect();
      let nextWidth = startWidth;
      let resizeFrame: number | null = null;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

      const onPointerMove = (moveEvent: PointerEvent) => {
        nextWidth = clamp(
          startWidth + startX - moveEvent.clientX,
          MIN_NOTEBOOK_PANEL_WIDTH,
          MAX_NOTEBOOK_PANEL_WIDTH,
        );
        if (resizeFrame !== null) return;
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = null;
          if (deferPanelResize) {
            if (verticalResizeGuideRef.current && panelRect) {
              verticalResizeGuideRef.current.style.left = `${
                panelRect.right - nextWidth
              }px`;
              verticalResizeGuideRef.current.classList.remove("hidden");
            }
            return;
          }
          shellRef.current?.style.setProperty(
            "--notebook-panel-width",
            `${nextWidth}px`,
          );
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
        shellRef.current?.style.setProperty(
          "--notebook-panel-width",
          `${nextWidth}px`,
        );
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
        <SectionErrorBoundary label="Toolbar">
          <TopToolbar
            compact={layoutOptions.compact}
            diagnosticsErrorCount={diagnostics.errorCount}
            mapControllerRef={mapControllerRef}
            mapReadyGeneration={mapReadyGeneration}
            showLabels={layoutOptions.toolbarLabels}
            showProjectInfo={layoutOptions.showProjectInfo}
            themeMode={themeMode}
            collaboration={collaboration}
            onOpenDiagnostics={() => setDiagnosticsOpen(true)}
            onToggleThemeMode={onToggleThemeMode}
          />
        </SectionErrorBoundary>
      ) : null}
      <div
        data-workspace-row=""
        className="relative flex min-h-0 flex-1 flex-col md:flex-row"
      >
        {replaceLayersPanelId ? (
          // Shared-rail mode on the Layers (left) side: the plugin panel shares
          // the Layers sidebar surface, so a single rail lists both the workbench
          // and Layers instead of the two positional plugin slots flanking it.
          <SectionErrorBoundary label="Shared left sidebar">
            <SharedSidebar
              key={replaceLayersPanelId}
              side="layers"
              pluginId={replaceLayersPanelId}
              pluginContentEl={pluginContentEl}
              pluginWidth={pluginPanelWidth}
              onPluginWidthChange={setPluginPanelWidth}
              builtinVisible={layoutOptions.layerPanelVisible}
              builtinTitle={t("sharedRail.layers")}
              builtinIcon={<Layers className="h-4 w-4" />}
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
                  collapsed={collapsed}
                  onCollapsedChange={onCollapsedChange}
                  hideOwnRail
                />
              )}
            />
          </SectionErrorBoundary>
        ) : (
          <>
            <SectionErrorBoundary label="Plugin panel (left of Layers)">
              <PluginRightPanel
                dock="left-of-layers"
                contentEl={pluginContentEl}
                width={pluginPanelWidth}
                onWidthChange={setPluginPanelWidth}
              />
            </SectionErrorBoundary>
            {layoutOptions.layerPanelVisible ? (
              <SectionErrorBoundary label="Layer panel">
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
                  autoCollapse={
                    storymapPresenting || autoCollapsedPanel === "layers"
                  }
                />
              </SectionErrorBoundary>
            ) : null}
            <SectionErrorBoundary label="Plugin panel (right of Layers)">
              <PluginRightPanel
                dock="right-of-layers"
                contentEl={pluginContentEl}
                width={pluginPanelWidth}
                onWidthChange={setPluginPanelWidth}
              />
            </SectionErrorBoundary>
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
          <h1 className="sr-only">GeoLibre map workspace</h1>
          <SectionErrorBoundary label="Map" fallbackClassName="h-full w-full">
            <MapGrid>
              <MapCanvas
                controllerRef={mapControllerRef}
                onMapDiagnosticEvent={handleMapDiagnosticEvent}
                onControllerReady={handleMapControllerReady}
              />
              <RemoteCursorsOverlay mapControllerRef={mapControllerRef} />
              <MapContextMenu
                mapControllerRef={mapControllerRef}
                mapReadyGeneration={mapReadyGeneration}
              />
              <BoundsRestrictionIndicator />
              {/* Isolate the collaboration badge in its own boundary: it renders
                  over the map, so a fault here must never take down the map
                  itself (it shares this subtree's error boundary otherwise). */}
              <SilentErrorBoundary label="Collaboration status">
                <CollaborationStatusBadge
                  api={collaboration}
                  mapControllerRef={mapControllerRef}
                />
              </SilentErrorBoundary>
              <MapModeBanner mapControllerRef={mapControllerRef} />
              <PixelTimeSeriesControl mapControllerRef={mapControllerRef} />
              <StoryMapComposeBar mapControllerRef={mapControllerRef} />
            </MapGrid>
          </SectionErrorBoundary>
          <SectionErrorBoundary label="Plugin floating panels">
            <FloatingPanels />
          </SectionErrorBoundary>
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
        {replaceStylePanelId ? (
          // Shared-rail mode (issue #765): the plugin panel shares the Style
          // sidebar surface, so a single rail lists both the workbench and Style
          // instead of the two positional plugin slots flanking the Style panel.
          <SectionErrorBoundary label="Shared right sidebar">
            <SharedSidebar
              // Key by the active panel id so switching between two replace-style
              // plugins remounts the sidebar, resetting its per-panel local state
              // (the Style opt-in) rather than carrying the previous plugin over.
              key={replaceStylePanelId}
              side="style"
              pluginId={replaceStylePanelId}
              pluginContentEl={pluginContentEl}
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
                  collapsed={collapsed}
                  onCollapsedChange={onCollapsedChange}
                  hideOwnRail
                />
              )}
            />
          </SectionErrorBoundary>
        ) : (
          <>
            <SectionErrorBoundary label="Plugin panel (left of Style)">
              <PluginRightPanel
                dock="left-of-style"
                contentEl={pluginContentEl}
                width={pluginPanelWidth}
                onWidthChange={setPluginPanelWidth}
              />
            </SectionErrorBoundary>
            {/* The notebook claims the workspace's right half, so the Style panel
                collapses to its rail while the notebook is open (Processing →
                Jupyter Notebook) rather than unmounting; the user can re-expand it.
                A story map presentation collapses it for the same reason. */}
            {layoutOptions.stylePanelVisible ? (
              <SectionErrorBoundary label="Style panel">
                <StylePanel
                  mapControllerRef={mapControllerRef}
                  onResizeStart={startStylePanelResize}
                  autoCollapse={
                    notebookOpen ||
                    storymapPresenting ||
                    autoCollapsedPanel === "style"
                  }
                />
              </SectionErrorBoundary>
            ) : null}
            <SectionErrorBoundary label="Plugin panel (right of Style)">
              <PluginRightPanel
                dock="right-of-style"
                contentEl={pluginContentEl}
                width={pluginPanelWidth}
                onWidthChange={setPluginPanelWidth}
              />
            </SectionErrorBoundary>
          </>
        )}
        {notebookOpen ? (
          <SectionErrorBoundary label="Notebook">
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
        <SectionErrorBoundary label="Attribute table">
          <AttributeTable mapControllerRef={mapControllerRef} />
        </SectionErrorBoundary>
      ) : null}
      {dashboardOpen ? (
        <SectionErrorBoundary label="Dashboard">
          <Suspense fallback={null}>
            <DashboardPanel />
          </Suspense>
        </SectionErrorBoundary>
      ) : null}
      {pythonConsoleOpen ? (
        <SectionErrorBoundary
          label="Python console"
          onClose={() => setPythonConsoleOpen(false)}
        >
          <Suspense fallback={null}>
            <PythonConsolePanel mapControllerRef={mapControllerRef} />
          </Suspense>
        </SectionErrorBoundary>
      ) : null}
      {assistantOpen ? (
        <SectionErrorBoundary label="Assistant">
          <Suspense fallback={null}>
            <AssistantPanel mapControllerRef={mapControllerRef} />
          </Suspense>
        </SectionErrorBoundary>
      ) : null}
      {layoutOptions.statusBarVisible ? (
        <SectionErrorBoundary label="Status bar">
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
      {/* Mounted in the always-rendered shell (not the toolbar) so the bookmark
          export name prompt works even when the toolbar is hidden (`?maponly`). */}
      <FileNamePromptDialog />
      <Suspense fallback={null}>
        <ProcessingDialog
          mapControllerRef={mapControllerRef}
          onAddRaster={async (bytes, name, fileName) => {
            // Cast required: TS types Uint8Array as Uint8Array<ArrayBufferLike>,
            // which is not directly assignable to BlobPart under this lib.
            // `fileName` (when given) becomes the layer's sourcePath while `name`
            // stays the human-readable display name; the control keeps them
            // separate (info.source.fileName vs info.name).
            const file = new File(
              [bytes as BlobPart],
              fileName ?? `${name}.tif`,
              { type: "image/tiff" },
            );
            await addRasterToMap(createAppAPI(mapControllerRef), file, { name });
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
        <RasterToolsDialog mapControllerRef={mapControllerRef} />
      </Suspense>
      <Suspense fallback={null}>
        <SegmentationDialog mapControllerRef={mapControllerRef} />
      </Suspense>
      <Suspense fallback={null}>
        <SqlWorkspaceDialog />
      </Suspense>
      <StoryMapPanel mapControllerRef={mapControllerRef} />
      <StoryMapPresenter mapControllerRef={mapControllerRef} />
      <div
        ref={verticalResizeGuideRef}
        className="pointer-events-none fixed bottom-7 top-11 z-50 hidden w-px bg-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.25)]"
      />
      {isDraggingFiles ? (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <div className="max-w-sm rounded-md border bg-background px-4 py-3 text-center shadow-lg">
            <p className="text-sm font-medium">
              {t("toolbar.fileDrop.overlayTitle")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("toolbar.fileDrop.overlaySubtext")}
            </p>
          </div>
        </div>
      ) : null}
      {projectUrlLoadState?.message || projectUrlLoadState?.error ? (
        <div
          aria-live="polite"
          className={`pointer-events-none absolute left-1/2 top-14 z-50 max-w-[min(90vw,32rem)] -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-center text-sm shadow-lg ${
            projectUrlLoadState.error ? "text-destructive" : "text-foreground"
          }`}
        >
          {projectUrlLoadState.error ?? projectUrlLoadState.message}
        </div>
      ) : null}
      {dropMessage || dropError ? (
        <div
          aria-live="polite"
          className={`pointer-events-none absolute bottom-10 left-1/2 z-50 -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-sm shadow-lg ${
            dropError ? "text-destructive" : "text-foreground"
          }`}
        >
          {dropError ?? dropMessage}
        </div>
      ) : null}
    </div>
  );
}
