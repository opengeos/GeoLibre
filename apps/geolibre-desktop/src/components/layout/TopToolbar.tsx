import { DEFAULT_PROJECT_NAME, useAppStore } from "@geolibre/core";
import {
  DEFAULT_BUILT_IN_CONTROL_VISIBILITY,
  type MapController,
} from "@geolibre/map";
import {
  closeDuckDBLayerPanel,
  closeEarthEnginePanel,
  closeMaplibreComponentControls,
  closePlanetaryComputerPanel,
  closeRasterLayerPanel,
  closeThreeDTilesLayerPanel,
  closeVectorLayerPanel,
  openFlatGeobufAddVectorLayerPanel,
  openDuckDBLayerPanel,
  openLidarLayerPanel,
  openPlanetaryComputerPanel,
  openPMTilesLayerPanel,
  openRasterLayerPanel,
  openSplattingLayerPanel,
  openStacSearchLayerPanel,
  openThreeDTilesLayerPanel,
  openVectorLayerPanel,
  openZarrLayerPanel,
  setAnnotationLabels,
  setBasemapControlLabels,
  setGraticuleLabels,
  setMapillaryLabels,
  setOpenAerialMapLabels,
  setSourceCoopLabels,
  setReverseGeocodeLabels,
  setTimelapseLabels,
  DECK_VIZ_PLUGIN_ID,
  DIRECTIONS_PLUGIN_ID,
  GRATICULE_PLUGIN_ID,
  CLOUDS_PLUGIN_ID,
  PRECIPITATION_PLUGIN_ID,
  REVERSE_GEOCODE_PLUGIN_ID,
  EFFECTS_PLUGIN_ID,
} from "@geolibre/plugins";
import { Button, cn, Input } from "@geolibre/ui";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Compass,
  Crosshair,
  Database,
  FilePen,
  Mountain,
  Share2,
  Users,
  FilePlus2,
  Folder,
  FolderGit2,
  FolderOpen,
  Globe,
  Grid2x2,
  Info,
  Keyboard,
  Link2,
  Map,
  MapPin,
  MessageSquare,
  Moon,
  Printer,
  RefreshCw,
  Save,
  Sparkles,
  Sun,
  Workflow,
  Wrench,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createAppAPI,
  getPluginManager,
  usePluginRegistry,
} from "../../hooks/usePlugins";
import { useConsentGatedActions } from "../../hooks/useConsentGatedActions";
import { useOsmPbfLoader } from "../../hooks/useOsmPbfLoader";
import type { ProjectFileActions } from "../../hooks/useProjectFileActions";
import { useToolbarPanels } from "../../hooks/useToolbarPanels";
import type { ThemeMode } from "../../hooks/useThemeMode";
import { isTauri } from "../../lib/tauri-io";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import {
  MENU_MANAGED_PLUGIN_IDS,
  isMenuVisible,
  isPluginVisible,
} from "../../lib/ui-profile";
import { CommandPalette } from "../command/CommandPalette";
import { KeyboardShortcutsDialog } from "../command/KeyboardShortcutsDialog";
import { useGlobalShortcuts } from "../../hooks/useGlobalShortcuts";
import { useViewportHistory } from "../../hooks/useViewportHistory";
import type { Command } from "../../lib/commands";
import { IS_STORE_BUILD } from "../../lib/updates";
import { AddDataDialog, type AddDataKind } from "./AddDataDialog";
import {
  OPEN_ADD_DATA_EVENT,
  type OpenAddDataDetail,
  type OpenAddDataPostgres,
} from "./add-data/open-add-data";
import { AddNetcdfDialog } from "./AddNetcdfDialog";
import { AboutDialog } from "./AboutDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { ManagePluginsDialog } from "./ManagePluginsDialog";
import { ProjectGalleryDialog } from "./ProjectGalleryDialog";
import { ShareProjectDialog } from "./ShareProjectDialog";
import type { CollaborationApi } from "../../hooks/useCollaboration";
import { SettingsDialog } from "./SettingsDialog";
import { SetViewDialog } from "./SetViewDialog";
import { PrintLayoutDialog } from "./PrintLayoutDialog";
import { LoadFeaturesIntoEditorDialog } from "./LoadFeaturesIntoEditorDialog";
import { FieldCollectionDialog } from "./FieldCollectionDialog";
import { RecordTourDialog } from "./RecordTourDialog";
import { RecordVideoDialog } from "./RecordVideoDialog";
import { GeoreferencerDialog } from "./GeoreferencerDialog";
import { AddDataMenu } from "./toolbar/AddDataMenu";
import { ConsentNoticeDialogs } from "./toolbar/ConsentNoticeDialogs";
import { ControlsMenu } from "./toolbar/ControlsMenu";
import { EditMenu } from "./toolbar/EditMenu";
import { ViewMenu } from "./toolbar/ViewMenu";
import { HelpMenu } from "./toolbar/HelpMenu";
import { OsmPbfDialogs } from "./toolbar/OsmPbfDialogs";
import { PluginsMenu } from "./toolbar/PluginsMenu";
import { PluginToolbarMenus } from "./toolbar/PluginToolbarMenus";
import { ProcessingMenu } from "./toolbar/ProcessingMenu";
import { ProjectFileDialogs } from "./toolbar/ProjectFileDialogs";
import { ProjectMenu } from "./toolbar/ProjectMenu";
import { googleEarthUrl, googleMapsUrl } from "../../lib/external-map-links";
import {
  ADD_DATA_KIND_COMMANDS,
  ALL_BUILT_IN_CONTROL_IDS,
  type AddLayerHandlers,
  CONVERSION_COMMANDS,
  FEEDBACK_URL,
  GITHUB_URL,
  MAP_CONTROL_ITEMS,
  NEW_PROJECT_VISIBLE_BUILT_IN_CONTROLS,
  newProjectToolbarControlVisibility,
  openExternalLink,
  RASTER_TOOL_COMMANDS,
  type ToolbarChrome,
  type ToolbarMapControl,
  VECTOR_TOOL_COMMANDS,
  WEBSITE_URL,
} from "./toolbar/constants";

interface TopToolbarProps {
  compact?: boolean;
  diagnosticsErrorCount: number;
  mapControllerRef: React.RefObject<MapController | null>;
  mapReadyGeneration: number;
  showLabels?: boolean;
  showProjectInfo?: boolean;
  themeMode: ThemeMode;
  // Lifted to DesktopShell so the on-canvas status badge can share one live
  // session (calling useCollaboration twice would open two sockets).
  collaboration: CollaborationApi;
  // Lifted to DesktopShell so the toolbar and the Browser panel share one
  // instance — two would not coordinate their in-flight "open recent" aborts.
  projectFiles: ProjectFileActions;
  onOpenDiagnostics: () => void;
  onToggleThemeMode: () => void;
  // Opens the Offline Basemap Extract panel, mounted in DesktopShell over the
  // map so it can stay non-modal (the map is interactive for drawing a bbox).
  onOpenBasemapExtract: () => void;
}

export function TopToolbar({
  compact = false,
  diagnosticsErrorCount,
  mapControllerRef,
  mapReadyGeneration,
  showLabels = true,
  showProjectInfo = true,
  themeMode,
  collaboration,
  projectFiles,
  onOpenDiagnostics,
  onToggleThemeMode,
  onOpenBasemapExtract,
}: TopToolbarProps) {
  const { t } = useTranslation();
  // The reverse-geocode plugin lives in the framework-agnostic plugins package
  // and cannot call t() itself, so push the translated popup strings into it
  // here and refresh them whenever the active language changes.
  useEffect(() => {
    setReverseGeocodeLabels({
      lookingUp: t("geocode.reverseLookingUp"),
      noAddress: t("geocode.reverseNoAddress"),
      copyAddress: t("geocode.reverseCopyAddress"),
      failed: t("geocode.reverseFailed"),
    });
    setBasemapControlLabels({
      confirmStyleReplace: (name, count) =>
        t("basemaps.confirmStyleReplace", { name, count }),
    });
    setAnnotationLabels({
      toolbar: t("annotations.toolbar"),
      layerName: t("annotations.layerName"),
      tools: {
        text: t("annotations.tools.text"),
        arrow: t("annotations.tools.arrow"),
        rectangle: t("annotations.tools.rectangle"),
        ellipse: t("annotations.tools.ellipse"),
        freehand: t("annotations.tools.freehand"),
      },
      color: t("annotations.color"),
      width: t("annotations.width"),
      widthOptions: {
        thin: t("annotations.widthOptions.thin"),
        medium: t("annotations.widthOptions.medium"),
        thick: t("annotations.widthOptions.thick"),
      },
      deleteLast: t("annotations.deleteLast"),
      clearAll: t("annotations.clearAll"),
      textPlaceholder: t("annotations.textPlaceholder"),
    });
    setMapillaryLabels({
      title: t("mapillary.title"),
      hint: t("mapillary.hint"),
      noToken: t("mapillary.noToken"),
      tokenPlaceholder: t("mapillary.tokenPlaceholder"),
      tokenSave: t("mapillary.tokenSave"),
      tokenHelp: t("mapillary.tokenHelp"),
      tokenLabel: t("mapillary.tokenLabel"),
      loading: t("mapillary.loading"),
      loadError: t("mapillary.loadError"),
      coverageLines: t("mapillary.coverageLines"),
      coveragePoints: t("mapillary.coveragePoints"),
    });
    setOpenAerialMapLabels({
      hint: t("openAerialMap.hint"),
      search: t("openAerialMap.search"),
      loadMore: t("openAerialMap.loadMore"),
      searching: t("openAerialMap.searching"),
      loadingMore: t("openAerialMap.loadingMore"),
      noResults: t("openAerialMap.noResults"),
      showing: (shown, total) => t("openAerialMap.showing", { shown, total }),
      searchError: (message) => t("openAerialMap.searchError", { message }),
      add: t("openAerialMap.add"),
      remove: t("openAerialMap.remove"),
      zoom: t("openAerialMap.zoom"),
      download: t("openAerialMap.download"),
      metadata: t("openAerialMap.metadata"),
      addTitle: t("openAerialMap.addTitle"),
      removeTitle: t("openAerialMap.removeTitle"),
      addUnavailableTitle: t("openAerialMap.addUnavailableTitle"),
      zoomTitle: t("openAerialMap.zoomTitle"),
      downloadTitle: t("openAerialMap.downloadTitle"),
      metadataTitle: t("openAerialMap.metadataTitle"),
      modeView: t("openAerialMap.modeView"),
      modeDraw: t("openAerialMap.modeDraw"),
      modeBbox: t("openAerialMap.modeBbox"),
      drawHint: t("openAerialMap.drawHint"),
      drawStart: t("openAerialMap.drawStart"),
      drawCancel: t("openAerialMap.drawCancel"),
      drawnBox: (box) => t("openAerialMap.drawnBox", { box }),
      coordWest: t("openAerialMap.coordWest"),
      coordSouth: t("openAerialMap.coordSouth"),
      coordEast: t("openAerialMap.coordEast"),
      coordNorth: t("openAerialMap.coordNorth"),
      coordSearch: t("openAerialMap.coordSearch"),
      bboxInvalid: t("openAerialMap.bboxInvalid"),
      footprintsLayer: t("openAerialMap.footprintsLayer"),
      footprintUnavailable: t("openAerialMap.footprintUnavailable"),
      metadataHeading: t("openAerialMap.metadataHeading"),
      close: t("openAerialMap.close"),
      metaTitle: t("openAerialMap.metaTitle"),
      metaProvider: t("openAerialMap.metaProvider"),
      metaPlatform: t("openAerialMap.metaPlatform"),
      metaResolution: t("openAerialMap.metaResolution"),
      metaAcquired: t("openAerialMap.metaAcquired"),
      metaBounds: t("openAerialMap.metaBounds"),
      metaSource: t("openAerialMap.metaSource"),
      metaRaw: t("openAerialMap.metaRaw"),
    });
    setSourceCoopLabels({
      hint: t("sourceCoop.hint"),
      searchPlaceholder: t("sourceCoop.searchPlaceholder"),
      search: t("sourceCoop.search"),
      searching: t("sourceCoop.searching"),
      loading: t("sourceCoop.loading"),
      loadError: (message) => t("sourceCoop.loadError", { message }),
      noResults: t("sourceCoop.noResults"),
      retry: t("sourceCoop.retry"),
      featured: t("sourceCoop.featured"),
      showing: (shown, total) => t("sourceCoop.showing", { shown, total }),
      browseAccount: (account) => t("sourceCoop.browseAccount", { account }),
      back: t("sourceCoop.back"),
      files: t("sourceCoop.files"),
      noFiles: t("sourceCoop.noFiles"),
      loadingFiles: t("sourceCoop.loadingFiles"),
      loadMore: t("sourceCoop.loadMore"),
      parent: t("sourceCoop.parent"),
      add: t("sourceCoop.add"),
      adding: t("sourceCoop.adding"),
      added: t("sourceCoop.added"),
      stream: t("sourceCoop.stream"),
      streaming: t("sourceCoop.streaming"),
      remove: t("sourceCoop.remove"),
      download: t("sourceCoop.download"),
      copyUrl: t("sourceCoop.copyUrl"),
      copied: t("sourceCoop.copied"),
      openProduct: t("sourceCoop.openProduct"),
      addTitle: t("sourceCoop.addTitle"),
      streamTitle: t("sourceCoop.streamTitle"),
      removeTitle: t("sourceCoop.removeTitle"),
      downloadTitle: t("sourceCoop.downloadTitle"),
      copyUrlTitle: t("sourceCoop.copyUrlTitle"),
      openProductTitle: t("sourceCoop.openProductTitle"),
      unsupportedTitle: t("sourceCoop.unsupportedTitle"),
      addError: (message) => t("sourceCoop.addError", { message }),
      largeFileWarning: (size) => t("sourceCoop.largeFileWarning", { size }),
      streamHint: (size) => t("sourceCoop.streamHint", { size }),
      tooLargeToOpen: (size, limit) =>
        t("sourceCoop.tooLargeToOpen", { size, limit }),
    });
    setGraticuleLabels({
      title: t("graticule.title"),
      controlTitle: t("graticule.controlTitle"),
      gridType: t("graticule.gridType"),
      typeGeographic: t("graticule.typeGeographic"),
      typeUtm: t("graticule.typeUtm"),
      spacing: t("graticule.spacing"),
      spacingAuto: t("graticule.spacingAuto"),
      spacingFixed: t("graticule.spacingFixed"),
      interval: t("graticule.interval"),
      intervalMeters: t("graticule.intervalMeters"),
      lineColor: t("graticule.lineColor"),
      lineWidth: t("graticule.lineWidth"),
      lineOpacity: t("graticule.lineOpacity"),
      dashedLines: t("graticule.dashedLines"),
      showLabels: t("graticule.showLabels"),
      labelFormat: t("graticule.labelFormat"),
      formatDecimal: t("graticule.formatDecimal"),
      formatDms: t("graticule.formatDms"),
      labelEdges: t("graticule.labelEdges"),
      edgesLeftBottom: t("graticule.edgesLeftBottom"),
      edgesAll: t("graticule.edgesAll"),
      labelColor: t("graticule.labelColor"),
      labelSize: t("graticule.labelSize"),
    });
    setTimelapseLabels({
      title: t("timelapse.title"),
      provider: t("timelapse.provider"),
      legend: t("timelapse.legend"),
      yearSlider: t("timelapse.yearSlider"),
      play: t("timelapse.play"),
      pause: t("timelapse.pause"),
      speed: t("timelapse.speed"),
      secondsPerYear: t("timelapse.secondsPerYear"),
      secondsPerYearSuffix: t("timelapse.secondsPerYearSuffix"),
      loop: t("timelapse.loop"),
      record: t("timelapse.record"),
      stopRecording: t("timelapse.stopRecording"),
      recording: t("timelapse.recording"),
      recordingFailed: t("timelapse.recordingFailed"),
      recordingUnsupported: t("timelapse.recordingUnsupported"),
      loadingTiles: t("timelapse.loadingTiles"),
    });
  }, [t]);

  const setProcessingOpen = useAppStore((s) => s.setProcessingOpen);
  const setConversionOpen = useAppStore((s) => s.setConversionOpen);
  const setVectorToolOpen = useAppStore((s) => s.setVectorToolOpen);
  const setGeocodeOpen = useAppStore((s) => s.setGeocodeOpen);
  const setModelBuilderOpen = useAppStore((s) => s.setModelBuilderOpen);
  const setRasterToolOpen = useAppStore((s) => s.setRasterToolOpen);
  const setSegmentationOpen = useAppStore((s) => s.setSegmentationOpen);
  const setObjectDetectionOpen = useAppStore((s) => s.setObjectDetectionOpen);
  const setSegmentEverythingOpen = useAppStore(
    (s) => s.setSegmentEverythingOpen,
  );
  const setSqlWorkspaceOpen = useAppStore((s) => s.setSqlWorkspaceOpen);
  const setLoadEditorFeaturesOpen = useAppStore(
    (s) => s.setLoadEditorFeaturesOpen,
  );
  const loadEditorFeaturesOpen = useAppStore(
    (s) => s.ui.loadEditorFeaturesOpen,
  );
  const loadEditorFeaturesLayerId = useAppStore(
    (s) => s.ui.loadEditorFeaturesLayerId,
  );
  const setPythonConsoleOpen = useAppStore((s) => s.setPythonConsoleOpen);
  const setAssistantOpen = useAppStore((s) => s.setAssistantOpen);
  const projectName = useAppStore((s) => s.projectName);
  const projectPath = useAppStore((s) => s.projectPath);
  const projectGeneration = useAppStore((s) => s.projectGeneration);
  const setProjectName = useAppStore((s) => s.setProjectName);
  // The Collaborate dialog's visibility lives in the store so the on-canvas
  // session-status badge can reopen it from outside this component tree (#754).
  // The dialog itself is rendered by DesktopShell (not here) so it survives
  // toolbar-hidden layouts; the toolbar only triggers it via this setter.
  const setCollaborateDialogOpen = useAppStore(
    (s) => s.setCollaborateDialogOpen,
  );

  const {
    plugins,
    isActive,
    getMapControlPosition,
    toggle,
    setMapControlPosition,
    getEffectsSettings,
    previewEffectsSettings,
    commitEffectsSettings,
  } = usePluginRegistry();
  // Plugin ids hidden by the active UI profile (issue #500). Recompute only when
  // the profile changes so the Plugins menu can drop them.
  const uiProfile = useDesktopSettingsStore(
    (state) => state.desktopSettings.uiProfile,
  );
  const hiddenPluginIds = useMemo(
    () =>
      new Set(
        plugins
          .filter((plugin) => !isPluginVisible(uiProfile, plugin.id))
          .map((plugin) => plugin.id),
      ),
    [plugins, uiProfile],
  );
  // Plugins the user can toggle from the Plugins menu, offered as visibility
  // checkboxes in Settings → Interface. Excludes the four plugins that are
  // toggled elsewhere (Effects/Directions/Reverse Geocode via Controls, deck.gl
  // viz via Add Data), matching PluginsMenu's skip list.
  const profilePlugins = useMemo(
    () =>
      plugins
        .filter((plugin) => !MENU_MANAGED_PLUGIN_IDS.has(plugin.id))
        .map((plugin) => ({ id: plugin.id, name: plugin.name })),
    [plugins],
  );
  // mapControllerRef is a stable ref object and createAppAPI dereferences
  // `.current` lazily, so memoizing on the ref keeps a single appApi identity
  // across renders without going stale.
  const appApi = useMemo(() => createAppAPI(mapControllerRef), [mapControllerRef]);

  const panels = useToolbarPanels(appApi);
  const osmPbf = useOsmPbfLoader(appApi, projectFiles.setActionError);
  const consent = useConsentGatedActions({ appApi, isActive, toggle });
  const viewportHistory = useViewportHistory(
    mapControllerRef,
    mapReadyGeneration,
    projectGeneration,
  );

  // Tracks an active IME composition so pressing Enter to confirm a CJK
  // candidate doesn't blur the project-name field mid-composition.
  const projectNameComposingRef = useRef(false);

  const [controlsVisible, setControlsVisible] = useState<
    Record<ToolbarMapControl, boolean>
  >(() =>
    MAP_CONTROL_ITEMS.reduce(
      (acc, { id }) => {
        acc[id] = DEFAULT_BUILT_IN_CONTROL_VISIBILITY[id];
        return acc;
      },
      {} as Record<ToolbarMapControl, boolean>,
    ),
  );
  const [addDataKind, setAddDataKind] = useState<AddDataKind | null>(null);
  // PostgreSQL prefill (saved connection / clicked table) from the Browser panel.
  const [addDataPostgres, setAddDataPostgres] = useState<
    OpenAddDataPostgres | undefined
  >(undefined);
  // Drop the prefill whenever the dialog isn't on the PostgreSQL source, so a
  // stale prefill can't leak into a later postgres open reached via a path that
  // sets addDataKind directly (command palette / menus) rather than through the
  // Browser-panel event that sets the prefill. The event sets the prefill and
  // kind together, so this never clears a freshly-set prefill.
  useEffect(() => {
    if (addDataKind !== "postgres") setAddDataPostgres(undefined);
  }, [addDataKind]);
  // Let any panel (e.g. the Browser panel's "New connection" action) open the
  // Add Data dialog at a given kind without prop-drilling, mirroring
  // openSettingsSection. This toolbar owns the dialog + its kind state.
  useEffect(() => {
    const onOpenAddData = (event: Event) => {
      const detail = (event as CustomEvent<OpenAddDataDetail>).detail;
      if (detail?.kind) {
        setAddDataPostgres(detail.postgres);
        setAddDataKind(detail.kind);
      }
    };
    window.addEventListener(OPEN_ADD_DATA_EVENT, onOpenAddData);
    return () => window.removeEventListener(OPEN_ADD_DATA_EVENT, onOpenAddData);
  }, []);
  // Deck.gl Layer kind the Add Data dialog opens on (e.g. the 3D-model entry
  // jumps straight to the scenegraph layer type).
  const [addDataDeckVizKind, setAddDataDeckVizKind] = useState<
    string | undefined
  >(undefined);
  const [netcdfDialogOpen, setNetcdfDialogOpen] = useState(false);
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);
  const [managePluginsOpen, setManagePluginsOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [galleryDialogOpen, setGalleryDialogOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [printLayoutOpen, setPrintLayoutOpen] = useState(false);
  const [fieldCollectionOpen, setFieldCollectionOpen] = useState(false);
  const [recordTourOpen, setRecordTourOpen] = useState(false);
  const [recordVideoOpen, setRecordVideoOpen] = useState(false);
  const [georeferencerOpen, setGeoreferencerOpen] = useState(false);
  const [setViewOpen, setSetViewOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [checkForUpdatesRequest, setCheckForUpdatesRequest] = useState(0);

  const resetRuntimeControlsForNewProject = () => {
    closeMaplibreComponentControls(appApi);
    closeRasterLayerPanel(appApi);
    closeVectorLayerPanel(appApi);
    closePlanetaryComputerPanel(appApi);
    closeEarthEnginePanel(appApi);
    closeThreeDTilesLayerPanel(appApi);
    closeDuckDBLayerPanel(appApi);
    getPluginManager().restoreProjectState(null, appApi, {
      resetMissingSettings: true,
    });

    for (const control of ALL_BUILT_IN_CONTROL_IDS) {
      mapControllerRef.current?.setBuiltInControlPosition(control, "top-right");
    }
    for (const control of ALL_BUILT_IN_CONTROL_IDS) {
      mapControllerRef.current?.setBuiltInControlVisible(
        control,
        NEW_PROJECT_VISIBLE_BUILT_IN_CONTROLS.has(control),
      );
    }
    setControlsVisible(newProjectToolbarControlVisibility());
  };

  // The appApi-backed "add layer" handlers shared by the Add Data menu and the
  // command palette so each panel opens identically from both.
  const addLayer: AddLayerHandlers = {
    vector: () => openVectorLayerPanel(appApi),
    raster: () => openRasterLayerPanel(appApi),
    stac: () => openStacSearchLayerPanel(appApi),
    flatGeobuf: () => openFlatGeobufAddVectorLayerPanel(appApi),
    pmtiles: () => openPMTilesLayerPanel(appApi),
    zarr: () => openZarrLayerPanel(appApi),
    netcdf: () => setNetcdfDialogOpen(true),
    lidar: () => openLidarLayerPanel(appApi),
    splatting: () => openSplattingLayerPanel(appApi),
    threeDTiles: () => openThreeDTilesLayerPanel(appApi),
    duckdb: () => openDuckDBLayerPanel(appApi),
  };
  const handleOpenPlanetaryComputer = () => openPlanetaryComputerPanel(appApi);

  const toggleMapControl = (control: ToolbarMapControl) => {
    setControlsVisible((current) => {
      const visible = !current[control];
      const updated =
        mapControllerRef.current?.setBuiltInControlVisible(control, visible) ??
        false;
      return updated ? { ...current, [control]: visible } : current;
    });
  };

  // The command registry: the single source of truth shared by the command
  // palette, the global shortcut layer, and the keyboard cheat sheet. Each
  // entry reuses the same handler the matching menu item calls, so behaviour is
  // defined once. Only file operations get global shortcuts to avoid clobbering
  // MapLibre or browser keys; everything else is reachable through the palette.
  const commands: Command[] = [
    // Project
    {
      id: "project.new",
      title: t("toolbar.command.projectNew"),
      group: t("toolbar.commandGroup.project"),
      keywords: "create",
      icon: FilePlus2,
      shortcut: { key: "n", mod: true, shift: false },
      run: () => setNewProjectDialogOpen(true),
    },
    {
      id: "project.open-file",
      title: t("toolbar.command.projectOpenFile"),
      group: t("toolbar.commandGroup.project"),
      keywords: "load",
      icon: FolderOpen,
      shortcut: { key: "o", mod: true, shift: false },
      run: () => void projectFiles.handleOpenFromFile(),
    },
    {
      id: "project.open-url",
      title: t("toolbar.command.projectOpenUrl"),
      group: t("toolbar.commandGroup.project"),
      keywords: "load",
      icon: Link2,
      run: () => projectFiles.setProjectUrlDialogOpen(true),
    },
    {
      id: "project.save",
      title: t("toolbar.command.projectSave"),
      group: t("toolbar.commandGroup.project"),
      icon: Save,
      shortcut: { key: "s", mod: true, shift: false },
      run: () => void projectFiles.handleSave(),
    },
    {
      id: "project.save-as",
      title: t("toolbar.command.projectSaveAs"),
      group: t("toolbar.commandGroup.project"),
      icon: FilePen,
      shortcut: { key: "s", mod: true, shift: true },
      run: () => void projectFiles.handleSaveAs(),
    },
    {
      id: "project.share",
      title: t("toolbar.command.projectShare"),
      group: t("toolbar.commandGroup.project"),
      icon: Share2,
      run: () => setShareDialogOpen(true),
    },
    // Only surfaced when live collaboration is configured (env flag).
    ...(collaboration.enabled
      ? [
          {
            id: "project.collaborate",
            title: t("toolbar.command.projectCollaborate"),
            group: t("toolbar.commandGroup.project"),
            icon: Users,
            run: () => setCollaborateDialogOpen(true),
          },
        ]
      : []),
    {
      id: "project.print-layout",
      title: t("toolbar.item.printLayoutEllipsis"),
      group: t("toolbar.commandGroup.project"),
      icon: Printer,
      run: () => setPrintLayoutOpen(true),
    },
    // Add Data
    {
      id: "add.vector",
      title: t("toolbar.command.addVectorLayer"),
      group: t("toolbar.commandGroup.addData"),
      icon: Database,
      run: addLayer.vector,
    },
    {
      id: "add.raster",
      title: t("toolbar.command.addRasterLayer"),
      group: t("toolbar.commandGroup.addData"),
      icon: Database,
      run: addLayer.raster,
    },
    {
      id: "add.osm-pbf",
      title: t("toolbar.command.addOsmPbfLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: () => osmPbf.setDialogOpen(true),
    },
    ...ADD_DATA_KIND_COMMANDS.map(({ kind, titleKey }) => ({
      id: `add.${kind}`,
      title: t("toolbar.command.addLayer", { name: t(titleKey) }),
      group: t("toolbar.commandGroup.addData"),
      run: () => setAddDataKind(kind),
    })),
    {
      id: "add.stac",
      title: t("toolbar.command.addStacLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.stac,
    },
    {
      id: "add.geoparquet",
      title: t("toolbar.command.addGeoparquetLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.vector,
    },
    {
      id: "add.flatgeobuf",
      title: t("toolbar.command.addFlatgeobufLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.flatGeobuf,
    },
    {
      id: "add.pmtiles",
      title: t("toolbar.command.addPmtilesLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.pmtiles,
    },
    {
      id: "add.zarr",
      title: t("toolbar.command.addZarrLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.zarr,
    },
    {
      id: "add.netcdf",
      title: t("toolbar.command.addNetcdfLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.netcdf,
    },
    {
      id: "add.lidar",
      title: t("toolbar.command.addLidarLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.lidar,
    },
    {
      id: "add.splatting",
      title: t("toolbar.command.addSplattingLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.splatting,
    },
    {
      id: "add.3d-tiles",
      title: t("toolbar.command.add3dTilesLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.threeDTiles,
    },
    {
      id: "add.duckdb",
      title: t("toolbar.command.addDuckdbLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: addLayer.duckdb,
    },
    // Processing
    {
      id: "proc.whitebox",
      title: t("toolbar.command.whiteboxTools"),
      group: t("toolbar.commandGroup.processing"),
      icon: Wrench,
      run: () => setProcessingOpen(true),
    },
    {
      id: "proc.sql",
      title: t("toolbar.command.sqlWorkspace"),
      group: t("toolbar.commandGroup.processing"),
      icon: Wrench,
      run: () => setSqlWorkspaceOpen(true),
    },
    {
      id: "proc.python",
      title: t("toolbar.command.pythonConsole"),
      group: t("toolbar.commandGroup.processing"),
      keywords: "python console pyodide script repl",
      icon: Wrench,
      run: () => setPythonConsoleOpen(true),
    },
    {
      id: "proc.assistant",
      title: t("toolbar.command.assistant"),
      group: t("toolbar.commandGroup.processing"),
      keywords: "assistant ai chat llm natural language gemini agent",
      icon: Sparkles,
      run: () => setAssistantOpen(true),
    },
    {
      id: "proc.geocode",
      title: t("toolbar.command.geocode"),
      group: t("toolbar.commandGroup.processing"),
      keywords: "geocode address csv nominatim",
      icon: MapPin,
      run: () => setGeocodeOpen(true),
    },
    {
      id: "proc.modelBuilder",
      title: t("toolbar.command.modelBuilder"),
      group: t("toolbar.commandGroup.processing"),
      keywords: "batch model pipeline chain modeler workflow graphical",
      icon: Workflow,
      run: () => setModelBuilderOpen(true),
    },
    {
      id: "proc.segmentation",
      title: t("toolbar.command.segmentation"),
      group: t("toolbar.commandGroup.processing"),
      keywords: "segmentation samgeo sam3 ai segment imagery",
      icon: Sparkles,
      run: () => setSegmentationOpen(true),
    },
    {
      id: "proc.objectDetection",
      title: t("toolbar.command.objectDetection"),
      group: t("toolbar.commandGroup.processing"),
      keywords: "object detection yolo onnx ai detect imagery boxes",
      icon: Sparkles,
      run: () => setObjectDetectionOpen(true),
    },
    {
      id: "proc.segmentEverything",
      title: t("toolbar.command.segmentEverything"),
      group: t("toolbar.commandGroup.processing"),
      keywords: "segment everything slimsam sam automatic mask imagery polygons",
      icon: Sparkles,
      run: () => setSegmentEverythingOpen(true),
    },
    ...CONVERSION_COMMANDS.map(({ kind, titleKey }) => ({
      id: `proc.conversion.${kind}`,
      title: t(titleKey),
      group: t("toolbar.commandGroup.processing"),
      keywords: "conversion convert",
      run: () => setConversionOpen(kind),
    })),
    ...VECTOR_TOOL_COMMANDS.map(({ kind, titleKey }) => ({
      id: `proc.vector.${kind}`,
      title: t(titleKey),
      group: t("toolbar.commandGroup.processing"),
      keywords: "vector tool",
      run: () => setVectorToolOpen(kind),
    })),
    ...RASTER_TOOL_COMMANDS.map(({ kind, titleKey }) => ({
      id: `proc.raster.${kind}`,
      title: t(titleKey),
      group: t("toolbar.commandGroup.processing"),
      keywords: "raster tool",
      run: () => setRasterToolOpen(kind),
    })),
    {
      id: "proc.planetary-computer",
      title: t("toolbar.command.planetaryComputer"),
      group: t("toolbar.commandGroup.processing"),
      run: handleOpenPlanetaryComputer,
    },
    {
      id: "proc.earth-engine",
      title: t("toolbar.command.earthEngine"),
      group: t("toolbar.commandGroup.processing"),
      run: panels.earthEngine.toggle,
    },
    // Controls
    ...MAP_CONTROL_ITEMS.map((control) => ({
      id: `control.${control.id}`,
      title: t("toolbar.command.toggleControl", {
        name: t(control.labelKey),
      }),
      group: t("toolbar.commandGroup.controls"),
      keywords: "control toggle map",
      run: () => toggleMapControl(control.id),
    })),
    {
      id: "control.effects",
      title: t("toolbar.command.toggleAtmosphereEffects"),
      group: t("toolbar.commandGroup.controls"),
      run: () => toggle(EFFECTS_PLUGIN_ID, appApi),
    },
    {
      id: "control.directions",
      title: t("toolbar.command.toggleDirections"),
      group: t("toolbar.commandGroup.controls"),
      run: consent.handleToggleDirections,
    },
    {
      id: "control.search",
      title: t("toolbar.command.toggleSearch"),
      group: t("toolbar.commandGroup.controls"),
      run: panels.searchPlaces.toggle,
    },
    {
      id: "control.colorbar",
      title: t("toolbar.command.toggleColorbar"),
      group: t("toolbar.commandGroup.controls"),
      run: panels.colorbar.toggle,
    },
    {
      id: "control.legend",
      title: t("toolbar.command.toggleLegend"),
      group: t("toolbar.commandGroup.controls"),
      run: panels.legend.toggle,
    },
    {
      id: "control.html",
      title: t("toolbar.command.toggleHtmlPanel"),
      group: t("toolbar.commandGroup.controls"),
      run: panels.html.toggle,
    },
    {
      id: "control.measure",
      title: t("toolbar.command.toggleMeasure"),
      group: t("toolbar.commandGroup.controls"),
      run: panels.measure.toggle,
    },
    {
      id: "control.bookmark",
      title: t("toolbar.command.toggleBookmark"),
      group: t("toolbar.commandGroup.controls"),
      run: panels.bookmark.toggle,
    },
    {
      id: "control.minimap",
      title: t("toolbar.command.toggleMinimap"),
      group: t("toolbar.commandGroup.controls"),
      run: panels.minimap.toggle,
    },
    {
      id: "control.view-state",
      title: t("toolbar.command.toggleViewState"),
      group: t("toolbar.commandGroup.controls"),
      run: panels.viewState.toggle,
    },
    // View
    {
      id: "view.zoom-in",
      title: t("toolbar.command.zoomIn"),
      group: t("toolbar.commandGroup.view"),
      keywords: "zoom in closer magnify scale",
      icon: ZoomIn,
      run: () => mapControllerRef.current?.zoomIn(),
    },
    {
      id: "view.zoom-out",
      title: t("toolbar.command.zoomOut"),
      group: t("toolbar.commandGroup.view"),
      keywords: "zoom out farther wider scale",
      icon: ZoomOut,
      run: () => mapControllerRef.current?.zoomOut(),
    },
    {
      id: "view.previous",
      title: t("toolbar.command.previousView"),
      group: t("toolbar.commandGroup.view"),
      keywords: "back history viewport extent previous undo pan zoom",
      icon: ArrowLeft,
      // "[" / "]" step through viewport history (unbound by MapLibre).
      shortcut: { key: "[" },
      run: viewportHistory.goBack,
    },
    {
      id: "view.next",
      title: t("toolbar.command.nextView"),
      group: t("toolbar.commandGroup.view"),
      keywords: "forward history viewport extent next redo pan zoom",
      icon: ArrowRight,
      shortcut: { key: "]" },
      run: viewportHistory.goForward,
    },
    {
      id: "view.reset-north",
      title: t("toolbar.command.resetNorth"),
      group: t("toolbar.commandGroup.view"),
      keywords: "north bearing rotation rotate compass orientation",
      icon: Compass,
      // Plain "N" (Google Earth Pro's north-up shortcut). No modifier, so it
      // never clashes with ⌘/Ctrl+N (New project) and leaves MapLibre's own
      // arrow/zoom keys untouched.
      shortcut: { key: "n" },
      run: () => mapControllerRef.current?.resetNorth(),
    },
    {
      id: "view.reset-pitch",
      title: t("toolbar.command.resetPitch"),
      group: t("toolbar.commandGroup.view"),
      keywords: "pitch tilt top down overhead flat level plan 2d reset",
      icon: Grid2x2,
      // Plain "U" resets pitch to a top-down view (Google Earth Pro's shortcut).
      shortcut: { key: "u" },
      run: () => mapControllerRef.current?.resetPitch(),
    },
    {
      id: "view.reset-pitch-bearing",
      title: t("toolbar.command.resetPitchBearing"),
      group: t("toolbar.commandGroup.view"),
      keywords: "pitch bearing tilt rotation north flat level 3d",
      icon: Mountain,
      // Plain "R" resets pitch and bearing (like Google Earth Pro's reset view).
      shortcut: { key: "r" },
      run: () => mapControllerRef.current?.resetNorthPitch(),
    },
    {
      id: "view.set-view",
      title: t("toolbar.command.setView"),
      group: t("toolbar.commandGroup.view"),
      keywords: "set view go to coordinates center zoom pitch bearing camera location longitude latitude",
      icon: Crosshair,
      run: () => setSetViewOpen(true),
    },
    {
      id: "view.theme",
      title:
        themeMode === "dark"
          ? t("toolbar.command.switchToLight")
          : t("toolbar.command.switchToDark"),
      group: t("toolbar.commandGroup.view"),
      keywords: "theme dark light appearance",
      icon: themeMode === "dark" ? Sun : Moon,
      run: onToggleThemeMode,
    },
    // Help
    {
      id: "help.shortcuts",
      title: t("toolbar.command.keyboardShortcuts"),
      group: t("toolbar.commandGroup.help"),
      keywords: "hotkeys cheat sheet",
      icon: Keyboard,
      run: () => setShortcutsOpen(true),
    },
    {
      id: "help.website",
      title: t("toolbar.command.website"),
      group: t("toolbar.commandGroup.help"),
      keywords: "home page site geolibre.app",
      icon: Globe,
      run: () => void openExternalLink(WEBSITE_URL),
    },
    {
      id: "help.github",
      title: t("toolbar.command.githubRepository"),
      group: t("toolbar.commandGroup.help"),
      keywords: "source code repo git opengeos",
      icon: FolderGit2,
      run: () => void openExternalLink(GITHUB_URL),
    },
    {
      id: "help.diagnostics",
      title: t("toolbar.command.diagnostics"),
      group: t("toolbar.commandGroup.help"),
      icon: Bug,
      run: onOpenDiagnostics,
    },
    {
      id: "help.feedback",
      title: t("toolbar.command.giveFeedback"),
      group: t("toolbar.commandGroup.help"),
      icon: MessageSquare,
      run: () => void openExternalLink(FEEDBACK_URL),
    },
    // The Microsoft Store build omits the "Check for updates" command so the app
    // updates only through the Store (policy 10.2.5).
    ...(IS_STORE_BUILD
      ? []
      : [
          {
            id: "help.updates",
            title: t("toolbar.command.checkForUpdates"),
            group: t("toolbar.commandGroup.help"),
            icon: RefreshCw,
            run: () => {
              setAboutOpen(true);
              setCheckForUpdatesRequest((value) => value + 1);
            },
          },
        ]),
    {
      id: "help.about",
      title: t("toolbar.command.about"),
      group: t("toolbar.commandGroup.help"),
      icon: Info,
      run: () => setAboutOpen(true),
    },
    // Plugins — one toggle per registered plugin. Atmospheric Effects,
    // Directions, Reverse Geocode, Gridlines, and the deck.gl viz renderer are
    // excluded here because they are surfaced under Controls / Add Data instead
    // (matching the menus).
    ...plugins
      .filter(
        (plugin) =>
          plugin.id !== EFFECTS_PLUGIN_ID &&
          plugin.id !== DIRECTIONS_PLUGIN_ID &&
          plugin.id !== REVERSE_GEOCODE_PLUGIN_ID &&
          plugin.id !== GRATICULE_PLUGIN_ID &&
          plugin.id !== CLOUDS_PLUGIN_ID &&
          plugin.id !== PRECIPITATION_PLUGIN_ID &&
          plugin.id !== DECK_VIZ_PLUGIN_ID,
      )
      .map((plugin) => ({
        id: `plugin.${plugin.id}`,
        title: t("toolbar.command.togglePlugin", { name: plugin.name }),
        group: t("toolbar.commandGroup.plugins"),
        keywords: isActive(plugin.id) ? "plugin deactivate" : "plugin activate",
        run: () => toggle(plugin.id, appApi),
      })),
    // Settings
    {
      id: "settings.manage-plugins",
      title: t("toolbar.command.managePlugins"),
      group: t("toolbar.commandGroup.settings"),
      keywords: "install external plugin marketplace",
      run: () => setManagePluginsOpen(true),
    },
  ];

  useGlobalShortcuts({
    commands,
    onOpenPalette: () => setCommandPaletteOpen(true),
    onOpenShortcuts: () => setShortcutsOpen(true),
  });

  const toolbarButtonSize = compact ? "icon" : "sm";
  const toolbarButtonClass = compact ? "h-8 w-8 shrink-0" : "shrink-0";
  // Class for "secondary" toolbar menus that may be hidden on narrow screens to
  // reduce toolbar wrapping. The menu stays reachable other ways (e.g. Edit's
  // actions also have keyboard shortcuts). To make a future menu hideable, give
  // its trigger Button this class instead of `toolbarButtonClass`.
  const toolbarSecondaryButtonClass = cn(
    toolbarButtonClass,
    "hidden md:inline-flex",
  );
  const toolbarIconClassName = cn("h-3.5 w-3.5", showLabels && "sm:me-1");
  const appTitle = isTauri() ? "GeoLibre Desktop" : "GeoLibre";
  const renderToolbarLabel = (label: string) =>
    showLabels ? <span className="hidden sm:inline">{label}</span> : null;
  const chrome: ToolbarChrome = {
    buttonClass: toolbarButtonClass,
    secondaryButtonClass: toolbarSecondaryButtonClass,
    buttonSize: toolbarButtonSize,
    iconClassName: toolbarIconClassName,
    renderLabel: renderToolbarLabel,
  };

  return (
    <header
      className={cn(
        "flex min-h-11 min-w-0 shrink-0 items-center gap-1 border-b bg-card py-1",
        compact
          ? "flex-nowrap overflow-x-auto px-1.5"
          : // Wrap below md; scroll a single row at md+ so tablets reach every menu (#871).
            "flex-wrap px-2 md:flex-nowrap md:overflow-x-auto",
      )}
    >
      <span className="me-1 flex shrink-0 items-center gap-1.5 text-sm font-semibold text-primary md:me-2">
        <Map className="h-4 w-4" />
        {showProjectInfo ? (
          <span className="hidden sm:inline">{appTitle}</span>
        ) : null}
      </span>
      {isMenuVisible(uiProfile, "project") && (
        <ProjectMenu
          chrome={chrome}
          collaborationEnabled={collaboration.enabled}
          onNewProject={() => setNewProjectDialogOpen(true)}
          onOpenFromFile={() => void projectFiles.handleOpenFromFile()}
          onOpenFromUrl={() => projectFiles.setProjectUrlDialogOpen(true)}
          onOpenGallery={() => setGalleryDialogOpen(true)}
          onOpenRecent={(path) => {
            void projectFiles.handleOpenRecent(path).then((error) => {
              if (error) projectFiles.setActionError(error);
            });
          }}
          onSave={() => void projectFiles.handleSave()}
          onSaveAs={() => void projectFiles.handleSaveAs()}
          onShare={() => setShareDialogOpen(true)}
          onExportHtml={() => void projectFiles.handleExportHtml()}
          onCollaborate={() => setCollaborateDialogOpen(true)}
          onPrintLayout={() => setPrintLayoutOpen(true)}
          onOpenOfflineBasemap={onOpenBasemapExtract}
        />
      )}
      {isMenuVisible(uiProfile, "edit") && <EditMenu chrome={chrome} />}
      {isMenuVisible(uiProfile, "view") && (
        <ViewMenu
          chrome={chrome}
          history={viewportHistory}
          getCamera={() => {
            const map = mapControllerRef.current?.getMap();
            if (!map) return null;
            return {
              zoom: map.getZoom(),
              bearing: map.getBearing(),
              pitch: map.getPitch(),
              minZoom: map.getMinZoom(),
              maxZoom: map.getMaxZoom(),
            };
          }}
          onResetNorth={() => mapControllerRef.current?.resetNorth()}
          onResetPitch={() => mapControllerRef.current?.resetPitch()}
          onResetPitchBearing={() =>
            mapControllerRef.current?.resetNorthPitch()
          }
          onSetView={() => setSetViewOpen(true)}
          onViewInGoogleEarth={() => {
            const map = mapControllerRef.current?.getMap();
            if (!map) return;
            const center = map.getCenter();
            void openExternalLink(
              googleEarthUrl(center.lat, center.lng, map.getZoom()),
            );
          }}
          onViewInGoogleMaps={() => {
            const map = mapControllerRef.current?.getMap();
            if (!map) return;
            const center = map.getCenter();
            void openExternalLink(
              googleMapsUrl(center.lat, center.lng, map.getZoom()),
            );
          }}
          onZoomIn={() => mapControllerRef.current?.zoomIn()}
          onZoomOut={() => mapControllerRef.current?.zoomOut()}
        />
      )}
      <NewProjectDialog
        open={newProjectDialogOpen}
        onOpenChange={setNewProjectDialogOpen}
        onSaveCurrentProject={projectFiles.handleSave}
        onProjectCreated={resetRuntimeControlsForNewProject}
      />
      {isMenuVisible(uiProfile, "addData") && (
        <AddDataMenu
          chrome={chrome}
          addLayer={addLayer}
          osmPbfBusy={osmPbf.busy}
          onSetAddDataKind={setAddDataKind}
          onAddGltfModel={() => {
            setAddDataDeckVizKind("scenegraph");
            setAddDataKind("deckgl-viz");
          }}
          onOpenOsmPbfDialog={() => osmPbf.setDialogOpen(true)}
        />
      )}
      {isMenuVisible(uiProfile, "processing") && (
        <ProcessingMenu
          chrome={chrome}
          earthEnginePanel={panels.earthEngine}
          onOpenNetworkTool={consent.openNetworkTool}
          onOpenPlanetaryComputer={handleOpenPlanetaryComputer}
          onOpenGeoreferencer={() => setGeoreferencerOpen(true)}
        />
      )}
      {isMenuVisible(uiProfile, "controls") && (
        <ControlsMenu
          chrome={chrome}
          controlsVisible={controlsVisible}
          panels={panels}
          effectsActive={isActive(EFFECTS_PLUGIN_ID)}
          directionsActive={isActive(DIRECTIONS_PLUGIN_ID)}
          reverseGeocodeActive={isActive(REVERSE_GEOCODE_PLUGIN_ID)}
          graticuleActive={isActive(GRATICULE_PLUGIN_ID)}
          cloudsActive={isActive(CLOUDS_PLUGIN_ID)}
          precipitationActive={isActive(PRECIPITATION_PLUGIN_ID)}
          onToggleMapControl={toggleMapControl}
          onToggleEffects={() => toggle(EFFECTS_PLUGIN_ID, appApi)}
          getEffectsSettings={getEffectsSettings}
          onPreviewEffectsSettings={previewEffectsSettings}
          onCommitEffectsSettings={commitEffectsSettings}
          onToggleDirections={consent.handleToggleDirections}
          onToggleReverseGeocode={consent.handleToggleReverseGeocode}
          onToggleGraticule={() => toggle(GRATICULE_PLUGIN_ID, appApi)}
          onToggleClouds={() => toggle(CLOUDS_PLUGIN_ID, appApi)}
          onTogglePrecipitation={() => toggle(PRECIPITATION_PLUGIN_ID, appApi)}
          onOpenFieldCollection={() => setFieldCollectionOpen(true)}
          onOpenRecordTour={() => setRecordTourOpen(true)}
          onOpenRecordVideo={() => setRecordVideoOpen(true)}
        />
      )}
      {isMenuVisible(uiProfile, "plugins") && (
        <PluginsMenu
          chrome={chrome}
          appApi={appApi}
          plugins={plugins}
          isActive={isActive}
          toggle={toggle}
          getMapControlPosition={getMapControlPosition}
          setMapControlPosition={setMapControlPosition}
          hiddenPluginIds={hiddenPluginIds}
        />
      )}
      {/* Top-level toolbar menus registered by built-in plugins via
          app.registerToolbarMenu(); external plugin menus render after Help
          (below). Renders nothing when none exist. */}
      <PluginToolbarMenus chrome={chrome} placement="builtin" />
      <SettingsDialog
        buttonClassName={toolbarButtonClass}
        buttonSize={toolbarButtonSize}
        iconClassName={toolbarIconClassName}
        mapControllerRef={mapControllerRef}
        showLabels={showLabels}
        onOpenManagePlugins={() => setManagePluginsOpen(true)}
        profilePlugins={profilePlugins}
        themeMode={themeMode}
        onToggleThemeMode={onToggleThemeMode}
      />
      <ManagePluginsDialog
        open={managePluginsOpen}
        onOpenChange={setManagePluginsOpen}
        mapControllerRef={mapControllerRef}
      />
      <PrintLayoutDialog
        open={printLayoutOpen}
        onOpenChange={setPrintLayoutOpen}
        mapControllerRef={mapControllerRef}
      />
      <FieldCollectionDialog
        open={fieldCollectionOpen}
        onOpenChange={setFieldCollectionOpen}
        mapControllerRef={mapControllerRef}
      />
      <RecordTourDialog
        open={recordTourOpen}
        onOpenChange={setRecordTourOpen}
        mapControllerRef={mapControllerRef}
      />
      <RecordVideoDialog
        open={recordVideoOpen}
        onOpenChange={setRecordVideoOpen}
        mapControllerRef={mapControllerRef}
      />
      <GeoreferencerDialog
        open={georeferencerOpen}
        onOpenChange={setGeoreferencerOpen}
        mapControllerRef={mapControllerRef}
      />
      <SetViewDialog
        open={setViewOpen}
        onOpenChange={setSetViewOpen}
        mapControllerRef={mapControllerRef}
      />
      <LoadFeaturesIntoEditorDialog
        open={loadEditorFeaturesOpen}
        onOpenChange={setLoadEditorFeaturesOpen}
        mapControllerRef={mapControllerRef}
        initialLayerId={loadEditorFeaturesLayerId}
      />
      <ShareProjectDialog
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        currentTitle={projectName}
        getProject={async (title) => {
          // Shared projects are opened on another machine where the local files
          // don't exist, so always embed the vector data (never file references).
          const { content, defaultProjectName } =
            await projectFiles.buildEmbeddedProject(title);
          // Strip path separators, control chars, and other characters that are
          // illegal in filenames so the server gets a predictable name.
          const safeName = defaultProjectName.replace(
            // Includes U+007F (DEL) alongside the C0 control range; both are
            // non-printing and rejected by some filesystems and HTTP servers.
            // eslint-disable-next-line no-control-regex
            /[\u0000-\u001f\u007f/\\:*?"<>|]/g,
            "_",
          );
          return { content, filename: `${safeName}.geolibre.json` };
        }}
      />
      <ProjectGalleryDialog
        open={galleryDialogOpen}
        onOpenChange={setGalleryDialogOpen}
        onOpenProject={(url, authToken) =>
          projectFiles.openProjectFromShareUrl(url, { authToken })
        }
      />
      {isMenuVisible(uiProfile, "help") && (
        <HelpMenu
          chrome={chrome}
          diagnosticsErrorCount={diagnosticsErrorCount}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onOpenDiagnostics={onOpenDiagnostics}
          onCheckForUpdates={() => {
            setAboutOpen(true);
            setCheckForUpdatesRequest((value) => value + 1);
          }}
          onAbout={() => setAboutOpen(true)}
        />
      )}
      {/* External plugin toolbar menus render after Help so third-party menus
          sit at the end of the banner, past the built-in menus. */}
      <PluginToolbarMenus chrome={chrome} placement="external" />
      <AddDataDialog
        kind={addDataKind}
        mapControllerRef={mapControllerRef}
        initialDeckVizKind={addDataDeckVizKind}
        initialPostgres={addDataPostgres}
        onOpenChange={(open: boolean) => {
          if (!open) {
            setAddDataKind(null);
            setAddDataDeckVizKind(undefined);
            setAddDataPostgres(undefined);
          }
        }}
      />
      <AddNetcdfDialog
        open={netcdfDialogOpen}
        appApi={appApi}
        onOpenChange={setNetcdfDialogOpen}
      />
      <ProjectFileDialogs projectFiles={projectFiles} />
      <ConsentNoticeDialogs consent={consent} />
      <OsmPbfDialogs osmPbf={osmPbf} />
      <AboutDialog
        checkForUpdatesRequest={checkForUpdatesRequest}
        open={aboutOpen}
        renderTrigger={false}
        onOpenChange={setAboutOpen}
      />
      <CommandPalette
        open={commandPaletteOpen}
        commands={commands}
        onOpenChange={setCommandPaletteOpen}
      />
      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        commands={commands}
        onOpenChange={setShortcutsOpen}
      />
      <div className="ms-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Button
          aria-label={
            themeMode === "dark"
              ? t("toolbar.command.switchToLight")
              : t("toolbar.command.switchToDark")
          }
          className="h-7 w-7 shrink-0"
          onClick={onToggleThemeMode}
          size="icon"
          title={
            themeMode === "dark"
              ? t("toolbar.command.switchToLight")
              : t("toolbar.command.switchToDark")
          }
          variant="ghost"
        >
          {themeMode === "dark" ? (
            <Sun className="h-3.5 w-3.5" />
          ) : (
            <Moon className="h-3.5 w-3.5" />
          )}
        </Button>
        {showProjectInfo ? (
          <>
            <Input
              aria-label={t("toolbar.item.projectName")}
              className="hidden h-7 w-44 border-transparent px-2 text-xs shadow-none focus-visible:border-input md:block"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !projectNameComposingRef.current &&
                  !event.nativeEvent.isComposing
                ) {
                  event.currentTarget.blur();
                }
              }}
              onCompositionStart={() => {
                projectNameComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                projectNameComposingRef.current = false;
              }}
              onBlur={(event) => {
                const nextName = event.target.value.trim();
                // Persist the canonical, locale-independent default name; a
                // translated string would otherwise be written into the saved
                // project file and vary by UI language.
                if (!nextName) setProjectName(DEFAULT_PROJECT_NAME);
              }}
            />
            {projectPath ? (
              <span className="hidden truncate lg:inline" title={projectPath}>
                {projectPath}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
    </header>
  );
}
