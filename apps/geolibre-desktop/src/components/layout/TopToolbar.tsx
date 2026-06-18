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
  setReverseGeocodeLabels,
  DECK_VIZ_PLUGIN_ID,
  DIRECTIONS_PLUGIN_ID,
  REVERSE_GEOCODE_PLUGIN_ID,
  EFFECTS_PLUGIN_ID,
} from "@geolibre/plugins";
import { Button, cn, Input } from "@geolibre/ui";
import {
  Bug,
  Database,
  FilePen,
  Share2,
  Users,
  FilePlus2,
  Folder,
  FolderOpen,
  Info,
  Keyboard,
  Layers,
  Link2,
  Map,
  MapPin,
  MessageSquare,
  Moon,
  Printer,
  LayoutTemplate,
  RefreshCw,
  Save,
  Sparkles,
  Sun,
  Workflow,
  Wrench,
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
import { useProjectFileActions } from "../../hooks/useProjectFileActions";
import { useToolbarPanels } from "../../hooks/useToolbarPanels";
import type { ThemeMode } from "../../hooks/useThemeMode";
import { isTauri } from "../../lib/tauri-io";
import { CommandPalette } from "../command/CommandPalette";
import { KeyboardShortcutsDialog } from "../command/KeyboardShortcutsDialog";
import { useGlobalShortcuts } from "../../hooks/useGlobalShortcuts";
import type { Command } from "../../lib/commands";
import { AddDataDialog, type AddDataKind } from "./AddDataDialog";
import { AddNetcdfDialog } from "./AddNetcdfDialog";
import { AboutDialog } from "./AboutDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { ManagePluginsDialog } from "./ManagePluginsDialog";
import { ShareProjectDialog } from "./ShareProjectDialog";
import { CollaborateDialog } from "./CollaborateDialog";
import { useCollaboration } from "../../hooks/useCollaboration";
import { SettingsDialog } from "./SettingsDialog";
import { PrintLayoutDialog } from "./PrintLayoutDialog";
import { FieldCollectionDialog } from "./FieldCollectionDialog";
import { GeoreferencerDialog } from "./GeoreferencerDialog";
import { OfflineRegionDialog } from "./OfflineRegionDialog";
import { AddDataMenu } from "./toolbar/AddDataMenu";
import { ConsentNoticeDialogs } from "./toolbar/ConsentNoticeDialogs";
import { ControlsMenu } from "./toolbar/ControlsMenu";
import { EditMenu } from "./toolbar/EditMenu";
import { HelpMenu } from "./toolbar/HelpMenu";
import { OsmPbfDialogs } from "./toolbar/OsmPbfDialogs";
import { PluginsMenu } from "./toolbar/PluginsMenu";
import { ProcessingMenu } from "./toolbar/ProcessingMenu";
import { ProjectFileDialogs } from "./toolbar/ProjectFileDialogs";
import { ProjectMenu } from "./toolbar/ProjectMenu";
import {
  ADD_DATA_KIND_COMMANDS,
  ALL_BUILT_IN_CONTROL_IDS,
  type AddLayerHandlers,
  CONVERSION_COMMANDS,
  FEEDBACK_URL,
  MAP_CONTROL_ITEMS,
  NEW_PROJECT_VISIBLE_BUILT_IN_CONTROLS,
  newProjectToolbarControlVisibility,
  openExternalLink,
  RASTER_TOOL_COMMANDS,
  type ToolbarChrome,
  type ToolbarMapControl,
  VECTOR_TOOL_COMMANDS,
} from "./toolbar/constants";

interface TopToolbarProps {
  compact?: boolean;
  diagnosticsErrorCount: number;
  mapControllerRef: React.RefObject<MapController | null>;
  showLabels?: boolean;
  showProjectInfo?: boolean;
  themeMode: ThemeMode;
  onOpenDiagnostics: () => void;
  onToggleThemeMode: () => void;
}

export function TopToolbar({
  compact = false,
  diagnosticsErrorCount,
  mapControllerRef,
  showLabels = true,
  showProjectInfo = true,
  themeMode,
  onOpenDiagnostics,
  onToggleThemeMode,
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
  }, [t]);

  const setProcessingOpen = useAppStore((s) => s.setProcessingOpen);
  const setConversionOpen = useAppStore((s) => s.setConversionOpen);
  const setVectorToolOpen = useAppStore((s) => s.setVectorToolOpen);
  const setGeocodeOpen = useAppStore((s) => s.setGeocodeOpen);
  const setModelBuilderOpen = useAppStore((s) => s.setModelBuilderOpen);
  const setRasterToolOpen = useAppStore((s) => s.setRasterToolOpen);
  const setSegmentationOpen = useAppStore((s) => s.setSegmentationOpen);
  const setSqlWorkspaceOpen = useAppStore((s) => s.setSqlWorkspaceOpen);
  const setPythonConsoleOpen = useAppStore((s) => s.setPythonConsoleOpen);
  const setAssistantOpen = useAppStore((s) => s.setAssistantOpen);
  const projectName = useAppStore((s) => s.projectName);
  const projectPath = useAppStore((s) => s.projectPath);
  const setProjectName = useAppStore((s) => s.setProjectName);

  const {
    plugins,
    isActive,
    getMapControlPosition,
    toggle,
    setMapControlPosition,
  } = usePluginRegistry();
  // mapControllerRef is a stable ref object and createAppAPI dereferences
  // `.current` lazily, so memoizing on the ref keeps a single appApi identity
  // across renders without going stale.
  const appApi = useMemo(() => createAppAPI(mapControllerRef), [mapControllerRef]);

  const panels = useToolbarPanels(appApi);
  const projectFiles = useProjectFileActions(mapControllerRef);
  const osmPbf = useOsmPbfLoader(appApi, projectFiles.setActionError);
  const consent = useConsentGatedActions({ appApi, isActive, toggle });
  const collaboration = useCollaboration(mapControllerRef);

  // When opened via a `?collab=<code>` share link, auto-open the Collaborate
  // dialog (which prefills the code) so the recipient only picks a name and
  // joins, instead of having to find the Project menu first.
  useEffect(() => {
    if (!collaboration.enabled) return;
    if (new URLSearchParams(window.location.search).get("collab")) {
      setCollaborateDialogOpen(true);
    }
  }, [collaboration.enabled]);

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
  // Deck.gl Layer kind the Add Data dialog opens on (e.g. the 3D-model entry
  // jumps straight to the scenegraph layer type).
  const [addDataDeckVizKind, setAddDataDeckVizKind] = useState<
    string | undefined
  >(undefined);
  const [netcdfDialogOpen, setNetcdfDialogOpen] = useState(false);
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);
  const [managePluginsOpen, setManagePluginsOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [collaborateDialogOpen, setCollaborateDialogOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [printLayoutOpen, setPrintLayoutOpen] = useState(false);
  const [offlineRegionOpen, setOfflineRegionOpen] = useState(false);
  const [fieldCollectionOpen, setFieldCollectionOpen] = useState(false);
  const [georeferencerOpen, setGeoreferencerOpen] = useState(false);
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
      id: "project.print",
      title: t("toolbar.command.projectPrint"),
      group: t("toolbar.commandGroup.project"),
      icon: Printer,
      run: panels.print.toggle,
    },
    {
      id: "project.print-layout",
      title: t("toolbar.item.printLayoutEllipsis"),
      group: t("toolbar.commandGroup.project"),
      icon: LayoutTemplate,
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
    {
      id: "help.about",
      title: t("toolbar.command.about"),
      group: t("toolbar.commandGroup.help"),
      icon: Info,
      run: () => setAboutOpen(true),
    },
    // Plugins — one toggle per registered plugin. Atmosphere Effects,
    // Directions, Reverse Geocode, and the deck.gl viz renderer are excluded
    // here because they are surfaced under Controls / Add Data instead
    // (matching the menus).
    ...plugins
      .filter(
        (plugin) =>
          plugin.id !== EFFECTS_PLUGIN_ID &&
          plugin.id !== DIRECTIONS_PLUGIN_ID &&
          plugin.id !== REVERSE_GEOCODE_PLUGIN_ID &&
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
  const toolbarIconClassName = cn("h-3.5 w-3.5", showLabels && "sm:mr-1");
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
          : "flex-wrap px-2 md:flex-nowrap",
      )}
    >
      <span className="mr-1 flex shrink-0 items-center gap-1.5 text-sm font-semibold text-primary md:mr-2">
        <Map className="h-4 w-4" />
        {showProjectInfo ? (
          <span className="hidden sm:inline">{appTitle}</span>
        ) : null}
      </span>
      <ProjectMenu
        chrome={chrome}
        collaborationEnabled={collaboration.enabled}
        printPanel={panels.print}
        onNewProject={() => setNewProjectDialogOpen(true)}
        onOpenFromFile={() => void projectFiles.handleOpenFromFile()}
        onOpenFromUrl={() => projectFiles.setProjectUrlDialogOpen(true)}
        onOpenRecent={(path) => void projectFiles.handleOpenRecent(path)}
        onSave={() => void projectFiles.handleSave()}
        onSaveAs={() => void projectFiles.handleSaveAs()}
        onShare={() => setShareDialogOpen(true)}
        onCollaborate={() => setCollaborateDialogOpen(true)}
        onPrintLayout={() => setPrintLayoutOpen(true)}
        onDownloadOffline={() => setOfflineRegionOpen(true)}
      />
      <EditMenu chrome={chrome} />
      <NewProjectDialog
        open={newProjectDialogOpen}
        onOpenChange={setNewProjectDialogOpen}
        onSaveCurrentProject={projectFiles.handleSave}
        onProjectCreated={resetRuntimeControlsForNewProject}
      />
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
      <ProcessingMenu
        chrome={chrome}
        earthEnginePanel={panels.earthEngine}
        onOpenNetworkTool={consent.openNetworkTool}
        onOpenPlanetaryComputer={handleOpenPlanetaryComputer}
        onOpenGeoreferencer={() => setGeoreferencerOpen(true)}
      />
      <ControlsMenu
        chrome={chrome}
        controlsVisible={controlsVisible}
        panels={panels}
        effectsActive={isActive(EFFECTS_PLUGIN_ID)}
        directionsActive={isActive(DIRECTIONS_PLUGIN_ID)}
        reverseGeocodeActive={isActive(REVERSE_GEOCODE_PLUGIN_ID)}
        onToggleMapControl={toggleMapControl}
        onToggleEffects={() => toggle(EFFECTS_PLUGIN_ID, appApi)}
        onToggleDirections={consent.handleToggleDirections}
        onToggleReverseGeocode={consent.handleToggleReverseGeocode}
        onOpenFieldCollection={() => setFieldCollectionOpen(true)}
      />
      <PluginsMenu
        chrome={chrome}
        appApi={appApi}
        plugins={plugins}
        isActive={isActive}
        toggle={toggle}
        getMapControlPosition={getMapControlPosition}
        setMapControlPosition={setMapControlPosition}
      />
      <SettingsDialog
        buttonClassName={toolbarButtonClass}
        buttonSize={toolbarButtonSize}
        iconClassName={toolbarIconClassName}
        mapControllerRef={mapControllerRef}
        showLabels={showLabels}
        onOpenManagePlugins={() => setManagePluginsOpen(true)}
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
      <OfflineRegionDialog
        open={offlineRegionOpen}
        onOpenChange={setOfflineRegionOpen}
        mapControllerRef={mapControllerRef}
      />
      <FieldCollectionDialog
        open={fieldCollectionOpen}
        onOpenChange={setFieldCollectionOpen}
        mapControllerRef={mapControllerRef}
      />
      <GeoreferencerDialog
        open={georeferencerOpen}
        onOpenChange={setGeoreferencerOpen}
        mapControllerRef={mapControllerRef}
      />
      <ShareProjectDialog
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        currentTitle={projectName}
        getProject={(title) => {
          const { content, defaultProjectName } =
            projectFiles.buildCurrentProject(title);
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
      {collaboration.enabled && (
        <CollaborateDialog
          open={collaborateDialogOpen}
          onOpenChange={setCollaborateDialogOpen}
          api={collaboration}
        />
      )}
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
      <AddDataDialog
        kind={addDataKind}
        mapControllerRef={mapControllerRef}
        initialDeckVizKind={addDataDeckVizKind}
        onOpenChange={(open: boolean) => {
          if (!open) {
            setAddDataKind(null);
            setAddDataDeckVizKind(undefined);
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
      <div className="ml-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
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
            <Layers className="mr-1 hidden h-3 w-3 md:inline" />
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
