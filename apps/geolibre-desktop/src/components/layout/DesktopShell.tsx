// @refresh reset
import { useAppStore } from "@geolibre/core";
import type { MapDiagnosticEvent, MapEngine } from "@geolibre/map";
import { MapCanvas } from "@geolibre/map";
import { useTranslation } from "react-i18next";
import {
  addRasterToMap,
  getGeometryEditTargetLayerId,
  openRasterLayerPanel,
  subscribeGeometryEdit,
} from "@geolibre/plugins";
import { Suspense, useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { BROWSER_PANEL_ID, useRegisterBrowserPanel } from "../../hooks/useRegisterBrowserPanel";
import { COMMENTS_PANEL_ID, useRegisterCommentsPanel } from "../../hooks/useRegisterCommentsPanel";
import { UrlLoadErrorBanner } from "./UrlLoadErrorBanner";
import { MountWhenOpened } from "./MountWhenOpened";
import { CommentsPanel } from "../comments/CommentsPanel";
import { CommentMapOverlay } from "../comments/CommentMapOverlay";
import { useCommentTool } from "../comments/useCommentTool";
import { AddCommentDialog } from "../comments/AddCommentDialog";
import { openRightPanel } from "@geolibre/plugins";
import { getIsMobileViewport } from "../../hooks/useIsMobileViewport";
import { useProjectFileActions } from "../../hooks/useProjectFileActions";
import { useProjectHistory } from "../../hooks/useProjectHistory";
import { useScreenshotReadiness } from "../../hooks/useScreenshotReadiness";
import i18n from "../../i18n";
import {
  createAppAPI,
  useExternalPluginsReady,
  useProjectPluginTrust,
  useSwipeSplitViewExclusivity,
  useTimeSliderAutoClose,
} from "../../hooks/usePlugins";
import type { DataUrlLoadState } from "../../hooks/useDataUrlLoader";
import { wikipediaLang } from "../../lib/knowledge";
import { projectUrlFromLocation } from "../../lib/project-url";
import { useEmbedBridge } from "../../hooks/useEmbedBridge";
import { useRasterIdentify } from "../../hooks/useRasterIdentify";
import { useGlobalRasterIdentify } from "../../hooks/useGlobalRasterIdentify";
import { useNetcdfIdentify } from "../../hooks/useNetcdfIdentify";
import { useTerrainRestore } from "../../hooks/useTerrainRestore";
import { useScriptControlRestore } from "../../hooks/useScriptControlRestore";
import { useProjectInteractionRestore } from "../../hooks/useProjectInteractionRestore";
import { useCogSpectralIdentify } from "../../hooks/useCogSpectralIdentify";
import { useRasterViewportStretch } from "../../hooks/useRasterViewportStretch";
import {
  useAutoCollapsedPanel,
  useReplaceLayersPanelId,
  useReplaceStylePanelId,
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
import { KnowledgeCardPanel } from "./KnowledgeCardPanel";
import { KnowledgeCardConsentDialog } from "./KnowledgeCardConsentDialog";
import { MapGrid } from "./MapGrid";
import { PrimaryMapboxCanvas } from "./PrimaryMapboxCanvas";
import { PrimaryArcgisCanvas } from "./PrimaryArcgisCanvas";
import { PrimaryCesiumCanvas } from "./PrimaryCesiumCanvas";
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
import { PluginRightPanel } from "../panels/PluginRightPanel";
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
import {
  AssistantPanel,
  BatchToolsDialog,
  ConversionDialog,
  DashboardPanel,
  GeocodeDialog,
  ModelBuilderPanel,
  NetworkToolsDialog,
  NotebookPanel,
  ObjectDetectionDialog,
  ProcessingDialog,
  ProcessingHistoryDialog,
  PythonConsolePanel,
  RasterToolsDialog,
  SegmentationDialog,
  SegmentEverythingPanel,
  SelectByExpressionDialog,
  SelectByLocationDialog,
  SqlWorkspacePanel,
  StatisticsToolsDialog,
  StyleManagerPanel,
  VectorToolsDialog,
} from "./desktopShellLazyPanels";
import { useCollabShareLinkAutoOpen } from "../../hooks/desktop-shell/useCollabShareLinkAutoOpen";
import { useDataUrlFit } from "../../hooks/desktop-shell/useDataUrlFit";
import { useDropStatus } from "../../hooks/desktop-shell/useDropStatus";
import { useFileDrop } from "../../hooks/desktop-shell/useFileDrop";
import { useKnowledgeCard } from "../../hooks/desktop-shell/useKnowledgeCard";
import { useLayerEditActions } from "../../hooks/desktop-shell/useLayerEditActions";
import { useLayerImport } from "../../hooks/desktop-shell/useLayerImport";
import { useMapControlLabels } from "../../hooks/desktop-shell/useMapControlLabels";
import { useMapFullscreenAttribute } from "../../hooks/desktop-shell/useMapFullscreenAttribute";
import { useNativeProjectOpenListener } from "../../hooks/desktop-shell/useNativeProjectOpenListener";
import { usePanelResize } from "../../hooks/desktop-shell/usePanelResize";
import { usePluginStateRestore } from "../../hooks/desktop-shell/usePluginStateRestore";
import { usePluginDeepLink } from "../../hooks/desktop-shell/usePluginDeepLink";
import { useRasterFileHandlers } from "../../hooks/desktop-shell/useRasterFileHandlers";
import { useRasterSubsetLayer } from "../../hooks/desktop-shell/useRasterSubsetLayer";
import { useRendererHandoff } from "../../hooks/desktop-shell/useRendererHandoff";
import { useRightPanelHost } from "../../hooks/desktop-shell/useRightPanelHost";
import { useTileProtocols } from "../../hooks/desktop-shell/useTileProtocols";
import { useTranslatedPluginLabels } from "../../hooks/desktop-shell/useTranslatedPluginLabels";
import { useViewerPluginGuard } from "../../hooks/desktop-shell/useViewerPluginGuard";

interface DesktopShellProps {
  layoutOptions: LayoutOptions;
  projectUrlLoadState?: ProjectUrlLoadState;
  dataUrlLoadState?: DataUrlLoadState;
  mapAppAPI: ReturnType<typeof createAppAPI> | null;
  themeMode: ThemeMode;
  onToggleThemeMode: () => void;
  onMapReady?: (app: ReturnType<typeof createAppAPI>) => void;
}

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
  // Read once: whether the page opened with a `?url=` project to wait for.
  const hasProjectUrl = useMemo(() => projectUrlFromLocation() !== null, []);
  const identifyRasterLayerAt = useGlobalRasterIdentify();
  const identifyAllLabels = useMemo(
    () => ({
      title: (count: number) => t("map.identifyAll.title", { count }),
      resultCount: (count: number) => t("map.identifyAll.resultCount", { count }),
      featureFallback: (index: number) => t("map.identifyAll.featureFallback", { index }),
      pixel: t("map.identifyAll.pixel"),
      expandAll: t("map.identifyAll.expandAll"),
      collapseAll: t("map.identifyAll.collapseAll"),
      loadingTitle: t("map.identifyAll.loadingTitle"),
      loading: t("map.identifyAll.loading"),
      errorLabel: t("map.identifyAll.errorLabel"),
      error: t("map.identifyAll.error"),
      noData: t("map.identifyAll.noData"),
      pixelReadFailed: t("map.identifyAll.pixelReadFailed"),
      wmsFailed: t("map.identifyAll.wmsFailed"),
      photo: {
        photo: t("map.identifyAll.photo"),
        noPreview: t("map.identifyAll.photoNoPreview"),
        viewFullResolution: t("map.identifyAll.photoViewFullResolution"),
        viewFullscreen: t("map.identifyAll.photoViewFullscreen"),
        close: t("map.identifyAll.photoClose"),
      },
    }),
    [t],
  );
  const shellRef = useRef<HTMLDivElement>(null);
  const verticalResizeGuideRef = useRef<HTMLDivElement>(null);
  useTranslatedPluginLabels(t);
  useMapFullscreenAttribute(shellRef);
  const mapControllerRef = useRef<MapEngine | null>(null);

  useDataUrlFit(dataUrlLoadState, mapControllerRef);

  const projectHistory = useProjectHistory(mapControllerRef);
  const [projectHistoryOpen, setProjectHistoryOpen] = useState(false);
  const {
    knowledgePlace,
    setKnowledgePlace,
    setPendingKnowledgePlace,
    knowledgeNoticeOpen,
    setKnowledgeNoticeOpen,
    handleExplorePlace,
    confirmKnowledgeConsent,
    handleKnowledgeFlyTo,
  } = useKnowledgeCard(mapControllerRef);
  const [rasterSubsetLayer, setRasterSubsetLayer] = useRasterSubsetLayer();
  // The Offline Basemap Extract panel is a non-modal floating panel over the
  // map (so the map stays interactive for drawing a bbox), mounted here beside
  // the Raster Subset panel and opened from the Add Data menu in the toolbar.
  const [basemapExtractOpen, setBasemapExtractOpen] = useState(false);
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
  const projectFilesRef = useRef(projectFiles);
  projectFilesRef.current = projectFiles;
  useNativeProjectOpenListener(projectFilesRef);
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
  const enforceViewerPlugins = useViewerPluginGuard(layoutOptions, mapControllerRef);
  const {
    activePanelId,
    browserContentEl,
    commentsContentEl,
    dockContentEl,
    pluginPanelWidth,
    replaceLayersPanelIds,
    replaceStylePanelIds,
    setPluginPanelWidth,
  } = useRightPanelHost(layoutOptions);
  const assistantOpen = useAppStore((s) => s.ui.assistantOpen);
  const dashboardOpen = useAppStore((s) => s.ui.dashboardOpen);
  const geometryEditLayerId = useSyncExternalStore(
    subscribeGeometryEdit,
    getGeometryEditTargetLayerId,
  );
  const [mapReadyGeneration, setMapReadyGeneration] = useState(0);
  const {
    clearDropMessageLater,
    crsWarning,
    dropError,
    dropMessage,
    setCrsWarning,
    setDropError,
    setDropMessage,
  } = useDropStatus();
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
  const collaboration = useCollaboration(mapControllerRef, mapReadyGeneration);
  const commentTool = useCommentTool({
    mapControllerRef,
    collaboration,
    mapReadyGeneration,
  });
  const [showResolvedComments, setShowResolvedComments] = useState(false);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);
  const collaborateDialogOpen = useAppStore((s) => s.ui.collaborateDialogOpen);
  const setCollaborateDialogOpen = useAppStore((s) => s.setCollaborateDialogOpen);
  useCollabShareLinkAutoOpen(collaboration, setCollaborateDialogOpen);
  // Sync the project with an embedding host (the GeoLibre Jupyter widget) over
  // postMessage. Inert when the app is not embedded.
  useEmbedBridge(mapControllerRef);
  // Request/reply + event channel backing the Python scripting API (live
  // queries, processing, map events). Also inert when not embedded.
  useCommandBridge(mapControllerRef, mapReadyGeneration);
  // Runtime postMessage API for a third-party host page that frames the app
  // (fly to a record, highlight it, open a tool; selection/view/tool events back
  // out). Off unless the deployment configured GEOLIBRE_EMBED_ORIGINS.
  useEmbedApi(mapControllerRef, mapAppAPI, mapReadyGeneration);
  // Same scripting surface, reached over the desktop Jupyter server's relay, so
  // a kernel driven from an EXTERNAL client (VS Code's Jupyter extension) can
  // control the map too. Inert until that server is running.
  useJupyterRelay(mapControllerRef);
  // Routes the Layers-panel Identify action to the raster pixel inspector for
  // COG layers (read band values on click). Inert until a COG is identified.
  useRasterIdentify();
  useNetcdfIdentify(mapControllerRef, mapReadyGeneration);
  useCogSpectralIdentify(mapControllerRef, mapReadyGeneration);
  useRasterViewportStretch(mapControllerRef, mapReadyGeneration);
  useTerrainRestore(mapControllerRef, mapReadyGeneration, projectGeneration);
  useScriptControlRestore(mapControllerRef, mapReadyGeneration, projectGeneration);
  useProjectInteractionRestore(mapControllerRef, mapReadyGeneration, projectGeneration);
  const [stylePanelOpenRequest, setStylePanelOpenRequest] = useState(0);
  const openStylePanel = useCallback(() => {
    setStylePanelOpenRequest((request) => request + 1);
  }, []);
  const { shellStyle, startLayerPanelResize, startNotebookPanelResize, startStylePanelResize } =
    usePanelResize({ shellRef, verticalResizeGuideRef, layoutOptions, notebookOpen });
  const { handleCancelGeometryEdit, handleMaterializeDuckDBLayer, handleToggleGeometryEdit } =
    useLayerEditActions({
      mapControllerRef,
      setDropError,
      setDropMessage,
      clearDropMessageLater,
      t,
    });
  useTileProtocols();
  useRasterFileHandlers(mapControllerRef, t);
  usePluginStateRestore({
    mapControllerRef,
    enforceViewerPlugins,
    externalPluginsReady,
    mapReadyGeneration,
    projectGeneration,
  });
  // After the restore above, so a `?url=` project's plugin state cannot close
  // what the link opened.
  usePluginDeepLink({
    mapControllerRef,
    enforceViewerPlugins,
    viewer: layoutOptions.viewer,
    externalPluginsReady,
    mapReadyGeneration,
    projectUrlSettled:
      !hasProjectUrl ||
      projectUrlLoadState?.status === "loaded" ||
      projectUrlLoadState?.status === "error",
  });

  const handleMapControllerReady = useCallback(() => {
    setMapReadyGeneration((generation) => generation + 1);
    onMapReady?.(createAppAPI(mapControllerRef));
  }, [onMapReady]);

  /**
   * Which engine draws the primary map area (issue #2217). `"cesium"` unmounts
   * `MapCanvas` in favour of the globe, so no `MapController` exists while it is
   * selected.
   */
  const primaryRenderer = useAppStore((s) => s.primaryRenderer);
  const cesiumPrimary = primaryRenderer === "cesium";
  useScreenshotReadiness(
    mapControllerRef,
    mapReadyGeneration,
    externalPluginsReady,
    projectUrlLoadState?.status === "loading" || dataUrlLoadState?.status === "loading",
    projectUrlLoadState?.error ?? dataUrlLoadState?.error ?? null,
    primaryRenderer !== "maplibre",
  );
  useRendererHandoff({
    primaryRenderer,
    setMapReadyGeneration,
    setRasterSubsetLayer,
    setBasemapExtractOpen,
  });
  useMapControlLabels(mapControllerRef, mapReadyGeneration, t);

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

  const { addDroppedPhotos, addDroppedRasters, addFilePath, finishDrop } = useLayerImport({
    mapControllerRef,
    setDropError,
    setDropMessage,
    setCrsWarning,
    t,
  });
  const { handleDragEnter, handleDragLeave, handleDragOver, handleDrop, isDraggingFiles } =
    useFileDrop({
      layoutOptions,
      mapControllerRef,
      projectFilesRef,
      setDropError,
      setDropMessage,
      setCrsWarning,
      clearDropMessageLater,
      finishDrop,
      addDroppedRasters,
      addDroppedPhotos,
      t,
    });

  return (
    <div
      ref={shellRef}
      data-testid="desktop-shell"
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
                      themeMode={themeMode}
                      mapControllerRef={mapControllerRef}
                      collaborationApi={collaboration}
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
                  <ViewerLayerPanel
                    mapControllerRef={mapControllerRef}
                    mapReadyGeneration={mapReadyGeneration}
                  />
                ) : (
                  <LayerPanel
                    themeMode={themeMode}
                    mapControllerRef={mapControllerRef}
                    collaborationApi={collaboration}
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
              {/* The primary map area is one renderer or the other (#2217).
                  Everything below that takes `mapControllerRef` is MapLibre-only
                  — it drives a `MapController` that the globe does not have — so
                  it mounts with the 2D map and stays unmounted on the globe,
                  where `PrimaryCesiumCanvas` explains the absence. Renderer-
                  neutral, store-driven overlays sit outside the branch and are
                  available under either engine. */}
              {primaryRenderer === "mapbox" ? (
                <PrimaryMapboxCanvas
                  canUseRemoteElevation={hasElevationConsent}
                  engineRef={mapControllerRef}
                  identifyAllLabels={identifyAllLabels}
                  identifyRasterLayerAt={identifyRasterLayerAt}
                  onEngineReady={handleMapControllerReady}
                  onMapDiagnosticEvent={handleMapDiagnosticEvent}
                />
              ) : primaryRenderer === "arcgis" ? (
                <PrimaryArcgisCanvas
                  canUseRemoteElevation={hasElevationConsent}
                  engineRef={mapControllerRef}
                  identifyAllLabels={identifyAllLabels}
                  identifyRasterLayerAt={identifyRasterLayerAt}
                  onEngineReady={handleMapControllerReady}
                  onMapDiagnosticEvent={handleMapDiagnosticEvent}
                />
              ) : cesiumPrimary ? (
                <PrimaryCesiumCanvas
                  engineRef={mapControllerRef}
                  onEngineReady={handleMapControllerReady}
                  onMapDiagnosticEvent={handleMapDiagnosticEvent}
                />
              ) : (
                <>
                  <MapCanvas
                    canUseRemoteElevation={hasElevationConsent}
                    controllerRef={mapControllerRef}
                    identifyAllLabels={identifyAllLabels}
                    identifyRasterLayerAt={identifyRasterLayerAt}
                    onMapDiagnosticEvent={handleMapDiagnosticEvent}
                    onControllerReady={handleMapControllerReady}
                  />
                  <MountWhenOpened isOpen={(ui) => ui.objectDetectionOpen}>
                    <Suspense fallback={null}>
                      <ObjectDetectionDialog mapControllerRef={mapControllerRef} />
                    </Suspense>
                  </MountWhenOpened>
                  <MountWhenOpened isOpen={(ui) => ui.segmentEverythingOpen}>
                    <Suspense fallback={null}>
                      <SegmentEverythingPanel mapControllerRef={mapControllerRef} />
                    </Suspense>
                  </MountWhenOpened>
                </>
              )}
              {/* Renderer-neutral: these use the store or `MapEngine`, so they
                  stay available on every renderer. */}
              <MapModeBanner mapControllerRef={mapControllerRef} />
              <PixelTimeSeriesControl
                mapControllerRef={mapControllerRef}
                mapReadyGeneration={mapReadyGeneration}
              />
              <NetcdfSampleMarkers
                mapControllerRef={mapControllerRef}
                mapReadyGeneration={mapReadyGeneration}
              />
              {/* Its own boundary: the cube window builds a `WebGLRenderer`,
                  whose constructor throws outright when the browser or driver
                  gives it no context. Sharing the map's boundary would turn a
                  failure to draw one panel into the loss of the whole map. */}
              <SilentErrorBoundary label="NetCDF 3D cube">
                <NetcdfCubeWindow mapControllerRef={mapControllerRef} />
              </SilentErrorBoundary>
              <NetcdfCubeSetupDialog mapControllerRef={mapControllerRef} />
              <RemoteCursorsOverlay
                mapControllerRef={mapControllerRef}
                mapReadyGeneration={mapReadyGeneration}
              />
              <CommentMapOverlay
                mapControllerRef={mapControllerRef}
                mapReadyGeneration={mapReadyGeneration}
                onSelectComment={(commentId) => {
                  setSelectedCommentId(commentId);
                  openRightPanel(COMMENTS_PANEL_ID);
                }}
                showResolved={showResolvedComments}
              />
              {/* Isolate the collaboration badge in its own boundary: it renders
                  over the map, so a fault here must never take down the map. */}
              <SilentErrorBoundary label="Collaboration status">
                <CollaborationStatusBadge api={collaboration} mapControllerRef={mapControllerRef} />
              </SilentErrorBoundary>
              <MapLegendPanel
                mapControllerRef={mapControllerRef}
                mapReadyGeneration={mapReadyGeneration}
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
              <StoryMapComposeBar
                mapControllerRef={mapControllerRef}
                mapReadyGeneration={mapReadyGeneration}
              />
              <TerrainSettingsDialog mapControllerRef={mapControllerRef} />
              <RasterSubsetPanel
                layer={rasterSubsetLayer}
                onClose={() => setRasterSubsetLayer(null)}
                mapControllerRef={mapControllerRef}
                mapReadyGeneration={mapReadyGeneration}
              />
              <BasemapExtractPanel
                open={basemapExtractOpen}
                onClose={() => setBasemapExtractOpen(false)}
                mapControllerRef={mapControllerRef}
                mapReadyGeneration={mapReadyGeneration}
              />
              <BoundsRestrictionIndicator />
              <QuickAnalysisBanner />
              <NetcdfProfileWindow />
              <MountWhenOpened isOpen={(ui) => ui.styleManagerOpen}>
                <Suspense fallback={null}>
                  <StyleManagerPanel />
                </Suspense>
              </MountWhenOpened>
            </MapGrid>
          </SectionErrorBoundary>
          <SectionErrorBoundary
            label="Plugin floating panels"
            displayName={t("shell.section.pluginFloatingPanels")}
          >
            <FloatingPanels />
          </SectionErrorBoundary>
          {/* Mounted inside the map area (like FloatingPanels) so the canvas
              floats over the map and drag-clamps to it, not to the whole
              window — the user keeps their layers in view while building. */}
          <SectionErrorBoundary label="Model Builder" displayName={t("shell.section.modelBuilder")}>
            <MountWhenOpened isOpen={(ui) => ui.modelBuilderOpen}>
              <Suspense fallback={null}>
                <ModelBuilderPanel
                  mapControllerRef={mapControllerRef}
                  onAddRaster={async (bytes, name, fileName) => {
                    // Same Uint8Array -> BlobPart cast as ProcessingDialog below.
                    const file = new File([bytes as BlobPart], fileName ?? `${name}.tif`, {
                      type: "image/tiff",
                    });
                    await addRasterToMap(createAppAPI(mapControllerRef), file, {
                      name,
                    });
                  }}
                />
              </Suspense>
            </MountWhenOpened>
          </SectionErrorBoundary>
          {/* Mounted here (inside the map area, like FloatingPanels) so the
              selection panels anchor to the map canvas's top-left corner and
              drag-clamp to the map, not the whole window (#1314). */}
          <SectionErrorBoundary
            label="Selection panels"
            displayName={t("shell.section.selectionPanels")}
          >
            <MountWhenOpened isOpen={(ui) => ui.selectByExpressionOpen}>
              <Suspense fallback={null}>
                <SelectByExpressionDialog canEditLayer={collaboration.canEditLayer} />
              </Suspense>
            </MountWhenOpened>
            <MountWhenOpened isOpen={(ui) => ui.selectByLocationOpen}>
              <Suspense fallback={null}>
                <SelectByLocationDialog />
              </Suspense>
            </MountWhenOpened>
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
                      mapReadyGeneration={mapReadyGeneration}
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
                  mapReadyGeneration={mapReadyGeneration}
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
                mapReadyGeneration={mapReadyGeneration}
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
      <MountWhenOpened isOpen={(ui) => ui.processingOpen}>
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
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.conversionOpen}>
        <Suspense fallback={null}>
          <ConversionDialog />
        </Suspense>
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.vectorToolOpen}>
        <Suspense fallback={null}>
          <VectorToolsDialog mapControllerRef={mapControllerRef} />
        </Suspense>
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.networkToolOpen}>
        <Suspense fallback={null}>
          <NetworkToolsDialog mapControllerRef={mapControllerRef} />
        </Suspense>
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.batchToolsOpen}>
        <Suspense fallback={null}>
          <BatchToolsDialog mapControllerRef={mapControllerRef} />
        </Suspense>
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.statisticsToolOpen}>
        <Suspense fallback={null}>
          <StatisticsToolsDialog mapControllerRef={mapControllerRef} />
        </Suspense>
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.geocodeOpen}>
        <Suspense fallback={null}>
          <GeocodeDialog mapControllerRef={mapControllerRef} />
        </Suspense>
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.processingHistoryOpen}>
        <Suspense fallback={null}>
          <ProcessingHistoryDialog />
        </Suspense>
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.rasterToolOpen}>
        <Suspense fallback={null}>
          <RasterToolsDialog mapControllerRef={mapControllerRef} />
        </Suspense>
      </MountWhenOpened>
      <MountWhenOpened isOpen={(ui) => ui.segmentationOpen}>
        <Suspense fallback={null}>
          <SegmentationDialog mapControllerRef={mapControllerRef} />
        </Suspense>
      </MountWhenOpened>
      <StoryMapPanel mapControllerRef={mapControllerRef} />
      <StoryMapPresenter
        mapControllerRef={mapControllerRef}
        mapReadyGeneration={mapReadyGeneration}
      />
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
      <div className="pointer-events-none absolute left-1/2 top-14 z-50 flex w-max max-w-[min(90vw,32rem)] -translate-x-1/2 flex-col gap-2">
        {projectUrlLoadState?.error ? (
          <UrlLoadErrorBanner
            key={`project:${projectUrlLoadState.error}`}
            message={projectUrlLoadState.error}
          />
        ) : null}
        {dataUrlLoadState?.error ? (
          <UrlLoadErrorBanner
            key={`data:${dataUrlLoadState.error}`}
            message={dataUrlLoadState.error}
          />
        ) : null}
      </div>
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
