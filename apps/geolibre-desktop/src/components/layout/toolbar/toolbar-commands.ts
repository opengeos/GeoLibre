import type { AppState } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import type { GeoLibrePlugin } from "@geolibre/plugins";
import type { TFunction } from "i18next";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  ClipboardList,
  Compass,
  Crosshair,
  Database,
  FilePen,
  FilePlus2,
  FolderGit2,
  FolderOpen,
  Globe,
  Grid2x2,
  Info,
  Keyboard,
  Layers,
  Link2,
  LocateFixed,
  MapPin,
  MessageSquare,
  Moon,
  Mountain,
  Palette,
  Printer,
  RefreshCw,
  Save,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Users,
  Workflow,
  Wrench,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { ProjectFileActions } from "../../../hooks/useProjectFileActions";
import type { ThemeMode } from "../../../hooks/useThemeMode";
import type { ToolbarPanels } from "../../../hooks/useToolbarPanels";
import type { ViewportHistory } from "../../../hooks/useViewportHistory";
import { IS_MAS_BUILD } from "../../../lib/build-flags";
import type { Command } from "../../../lib/commands";
import { masHidesDataSource } from "../../../lib/mas-build";
import { pluginDisplayName } from "../../../lib/plugin-display-name";
import { IS_STORE_BUILD } from "../../../lib/updates";
import type { AddDataKind } from "../AddDataDialog";
import {
  ADD_DATA_KIND_COMMANDS,
  type AddLayerHandlers,
  type AppApi,
  CONVERSION_COMMANDS,
  FEEDBACK_URL,
  GITHUB_URL,
  MAP_CONTROL_ITEMS,
  openExternalLink,
  RASTER_TOOL_COMMANDS,
  type ToolbarMapControl,
  VECTOR_TOOL_COMMANDS,
  WEBSITE_URL,
} from "./constants";

type SetOpen = Dispatch<SetStateAction<boolean>>;
type PluginRef = Pick<GeoLibrePlugin, "id" | "name" | "engines">;

/**
 * Everything the toolbar's command registry reads. The names match the
 * toolbar's own handlers and state so each command calls exactly what the
 * matching menu item calls.
 *
 * The plugins package is passed in (`isPluginEngineSupported`,
 * `openRightPanel`, the plugin ids, `earthEngineAvailable`) rather
 * than imported, so this module stays importable outside the browser: the
 * package's entry point loads every built-in plugin and its stylesheets.
 */
export interface ToolbarCommandContext {
  t: TFunction;
  themeMode: ThemeMode;
  /** Whether this deployment has a usable share host. */
  shareAvailable: boolean;
  collaboration: { enabled: boolean };
  capabilities: { nativeMapInstance: boolean };
  primaryRenderer: AppState["primaryRenderer"];
  plugins: ReadonlyArray<PluginRef>;
  /**
   * Plugins that get no "Toggle" command because the Controls and Add Data
   * menus surface them instead.
   */
  paletteExcludedPluginIds: ReadonlySet<string>;
  /** The Atmospheric Effects plugin, toggled from the Controls group. */
  effectsPluginId: string;
  isPluginEngineSupported: (plugin: PluginRef, engine: AppState["primaryRenderer"]) => boolean;
  openRightPanel: (id: string) => void;
  /** Whether Earth Engine sign-in is compiled into this build. */
  earthEngineAvailable: boolean;
  isActive: (id: string) => boolean;
  toggle: (id: string, appApi: AppApi) => void;
  appApi: AppApi;
  mapControllerRef: RefObject<MapEngine | null>;
  projectFiles: Pick<
    ProjectFileActions,
    "handleOpenFromFile" | "setProjectUrlDialogOpen" | "handleSave" | "handleSaveAs"
  >;
  addLayer: AddLayerHandlers;
  openAddDataKind: (kind: AddDataKind) => void;
  osmPbf: { setDialogOpen: (open: boolean) => void };
  handleOpenPlanetaryComputer: () => void;
  panels: ToolbarPanels;
  consent: { handleToggleDirections: () => void };
  viewportHistory: Pick<ViewportHistory, "goBack" | "goForward">;
  toggleMapControl: (control: ToolbarMapControl) => void;
  onAddComment: () => void;
  onOpenDiagnostics: () => void;
  onToggleThemeMode: () => void;
  setNewProjectDialogOpen: SetOpen;
  setShareDialogOpen: SetOpen;
  setPrintLayoutOpen: SetOpen;
  setGeoreferencerOpen: SetOpen;
  setFieldCollectionOpen: SetOpen;
  setGpsTrackingOpen: SetOpen;
  /** Open Settings → Interface, where the UI profiles live. */
  onSimplifyInterface: () => void;
  setSetViewOpen: SetOpen;
  setShortcutsOpen: SetOpen;
  setAboutOpen: SetOpen;
  setManagePluginsOpen: SetOpen;
  setCheckForUpdatesRequest: Dispatch<SetStateAction<number>>;
  setCollaborateDialogOpen: AppState["setCollaborateDialogOpen"];
  setProcessingOpen: AppState["setProcessingOpen"];
  setSqlWorkspaceOpen: AppState["setSqlWorkspaceOpen"];
  setPythonConsoleOpen: AppState["setPythonConsoleOpen"];
  setAssistantOpen: AppState["setAssistantOpen"];
  setGeocodeOpen: AppState["setGeocodeOpen"];
  setModelBuilderOpen: AppState["setModelBuilderOpen"];
  setBatchToolsOpen: AppState["setBatchToolsOpen"];
  setSegmentationOpen: AppState["setSegmentationOpen"];
  setObjectDetectionOpen: AppState["setObjectDetectionOpen"];
  setSegmentEverythingOpen: AppState["setSegmentEverythingOpen"];
  setConversionOpen: AppState["setConversionOpen"];
  setVectorToolOpen: AppState["setVectorToolOpen"];
  setRasterToolOpen: AppState["setRasterToolOpen"];
  setStyleManagerOpen: AppState["setStyleManagerOpen"];
}

/**
 * Builds the toolbar's command registry: the single source of truth shared by
 * the command palette, the global shortcut layer, and the keyboard cheat sheet.
 *
 * This is the unfiltered list; `useToolbarCommands` applies the renderer,
 * deployment, privilege, and viewer gates.
 *
 * @param context - The toolbar handlers and state the commands call and read.
 * @returns Every command the toolbar can offer in the current context.
 */
export function buildToolbarCommands(context: ToolbarCommandContext): Command[] {
  const {
    t,
    themeMode,
    shareAvailable,
    collaboration,
    capabilities,
    primaryRenderer,
    plugins,
    paletteExcludedPluginIds,
    effectsPluginId,
    isPluginEngineSupported,
    openRightPanel,
    earthEngineAvailable,
    isActive,
    toggle,
    appApi,
    mapControllerRef,
    projectFiles,
    addLayer,
    openAddDataKind,
    osmPbf,
    handleOpenPlanetaryComputer,
    panels,
    consent,
    viewportHistory,
    toggleMapControl,
    onAddComment,
    onOpenDiagnostics,
    onToggleThemeMode,
    setNewProjectDialogOpen,
    setShareDialogOpen,
    setPrintLayoutOpen,
    setGeoreferencerOpen,
    setFieldCollectionOpen,
    setGpsTrackingOpen,
    onSimplifyInterface,
    setSetViewOpen,
    setShortcutsOpen,
    setAboutOpen,
    setManagePluginsOpen,
    setCheckForUpdatesRequest,
    setCollaborateDialogOpen,
    setProcessingOpen,
    setSqlWorkspaceOpen,
    setPythonConsoleOpen,
    setAssistantOpen,
    setGeocodeOpen,
    setModelBuilderOpen,
    setBatchToolsOpen,
    setSegmentationOpen,
    setObjectDetectionOpen,
    setSegmentEverythingOpen,
    setConversionOpen,
    setVectorToolOpen,
    setRasterToolOpen,
    setStyleManagerOpen,
  } = context;

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
    // Only when the deployment has a usable share host; a command that always
    // failed would be worse than an absent one.
    ...(shareAvailable
      ? [
          {
            id: "project.share",
            title: t("toolbar.command.projectShare"),
            group: t("toolbar.commandGroup.project"),
            icon: Share2,
            run: () => setShareDialogOpen(true),
          },
        ]
      : []),
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
    // The composer captures through the engine's render surface, so it produces
    // a preview on every renderer (#2475); it was gated on a MapLibre map back
    // when it read that canvas directly (#2268 review), which left the menu item
    // working while the palette had no entry at all.
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
    // Sources the Mac App Store build hides in the Add Data menu must not be
    // reachable through the palette either.
    ...ADD_DATA_KIND_COMMANDS.filter(({ kind }) => !masHidesDataSource(kind)).map(
      ({ kind, titleKey }) => ({
        id: `add.${kind}`,
        title: t("toolbar.command.addLayer", { name: t(titleKey) }),
        group: t("toolbar.commandGroup.addData"),
        run: () => openAddDataKind(kind),
      }),
    ),
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
    {
      id: "add.comment",
      title: t("comments.addDialogTitle"),
      group: t("toolbar.commandGroup.addData"),
      keywords: "review note feedback",
      icon: MessageSquare,
      shortcut: { key: "c", shift: false },
      run: onAddComment,
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
      keywords: "model builder pipeline chain modeler workflow graph canvas node",
      icon: Workflow,
      run: () => setModelBuilderOpen(true),
    },
    {
      id: "proc.batchTools",
      title: t("toolbar.command.batchTools"),
      group: t("toolbar.commandGroup.processing"),
      keywords: "batch bulk many layers repeat vector tool",
      icon: Layers,
      run: () => setBatchToolsOpen(true),
    },
    // The Mac App Store build omits AI Segmentation: it is sidecar-only (the
    // App Sandbox forbids the sidecar) and has no client-side fallback.
    ...(IS_MAS_BUILD
      ? []
      : [
          {
            id: "proc.segmentation",
            title: t("toolbar.command.segmentation"),
            group: t("toolbar.commandGroup.processing"),
            keywords: "segmentation samgeo sam3 ai segment imagery",
            icon: Sparkles,
            run: () => setSegmentationOpen(true),
          },
        ]),
    // Both panels read pixels off the MapLibre canvas; the palette has no
    // disabled state, so drop the commands rather than offer two that silently
    // do nothing (#2217 review). Gated on the capability, not the engine name.
    ...(!capabilities.nativeMapInstance
      ? []
      : [
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
        ]),
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
    // The Georeferencer sits at the foot of the Processing menu's Raster
    // submenu; the palette hides it on mobile with the rest of that submenu.
    {
      id: "proc.georeferencer",
      title: t("toolbar.item.georeferencing"),
      group: t("toolbar.commandGroup.processing"),
      keywords: "georeference georeferencer control points gcp warp scanned map image raster",
      run: () => setGeoreferencerOpen(true),
    },
    {
      id: "proc.planetary-computer",
      title: t("toolbar.command.planetaryComputer"),
      group: t("toolbar.commandGroup.processing"),
      run: handleOpenPlanetaryComputer,
    },
    // Earth Engine sign-in needs the Rust loopback OAuth listener, which the
    // Apple App Store builds (Mac App Store and iOS) compile out so the app
    // claims no `com.apple.security.network.server` entitlement. Shares the
    // ProcessingMenu gate's module-level constant rather than recomputing it in
    // this array, which is rebuilt on every render.
    ...(earthEngineAvailable
      ? [
          {
            id: "proc.earth-engine",
            title: t("toolbar.command.earthEngine"),
            group: t("toolbar.commandGroup.processing"),
            run: panels.earthEngine.toggle,
          },
        ]
      : []),
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
      run: () => toggle(effectsPluginId, appApi),
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
    // Field Collection and GPS Tracking author the project, so like their
    // Controls-menu entries they stay out of the read-only viewer preset (which
    // mounts no palette at all).
    {
      id: "control.field-collection",
      title: t("toolbar.item.fieldCollection"),
      group: t("toolbar.commandGroup.controls"),
      keywords: "field collection survey form capture points mobile data entry",
      icon: ClipboardList,
      run: () => setFieldCollectionOpen(true),
    },
    {
      id: "control.gps-tracking",
      title: t("toolbar.item.gpsTracking"),
      group: t("toolbar.commandGroup.controls"),
      keywords: "gps tracking track location record position device",
      icon: LocateFixed,
      run: () => setGpsTrackingOpen(true),
    },
    // View
    // All eight drive the shared engine's camera, which every engine
    // implements — so they stay in the palette (and in the shortcut layer and
    // cheat sheet this array also feeds) whichever renderer is live. They were
    // dropped on the globe only because the ref was nulled there (#2217); it
    // now points at the `CesiumEngine` (#2260).
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
      keywords:
        "set view go to coordinates center zoom pitch bearing camera location longitude latitude",
      icon: Crosshair,
      run: () => setSetViewOpen(true),
    },
    {
      id: "view.comments",
      title: t("toolbar.command.viewComments"),
      group: t("toolbar.commandGroup.view"),
      keywords: "comments review threads notes annotations pins",
      icon: MessageSquare,
      run: () => openRightPanel("comments"),
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
      .filter((plugin) => !paletteExcludedPluginIds.has(plugin.id))
      .map((plugin) => ({
        id: `plugin.${plugin.id}`,
        title: t("toolbar.command.togglePlugin", {
          name: pluginDisplayName(t, plugin),
        }),
        group: t("toolbar.commandGroup.plugins"),
        keywords: isActive(plugin.id) ? "plugin deactivate" : "plugin activate",
        disabledReason:
          !isActive(plugin.id) && !isPluginEngineSupported(plugin, primaryRenderer)
            ? t("renderer.pluginUnsupported")
            : undefined,
        run: () => toggle(plugin.id, appApi),
      })),
    // Settings
    // The Mac App Store build omits the plugin marketplace: installing
    // external plugins is not allowed there, and bundled plugins need no
    // management. Same pattern as the Store build's update command above.
    ...(IS_MAS_BUILD
      ? []
      : [
          {
            id: "settings.manage-plugins",
            title: t("toolbar.command.managePlugins"),
            group: t("toolbar.commandGroup.settings"),
            keywords: "install external plugin marketplace",
            run: () => setManagePluginsOpen(true),
          },
        ]),
    {
      id: "settings.style-manager",
      title: t("toolbar.command.styleManager"),
      group: t("toolbar.commandGroup.settings"),
      keywords: "style manager saved styles symbol ramp label preset library",
      icon: Palette,
      run: () => setStyleManagerOpen(true),
    },
    // The Help menu's "Simplify Interface..." entry: the UI profiles that hide
    // menu items are otherwise only reachable from Settings → Interface.
    {
      id: "settings.simplify-interface",
      title: t("toolbar.item.simplifyInterface"),
      group: t("toolbar.commandGroup.settings"),
      keywords:
        "simplify interface ui profile beginner intermediate advanced hide menus clutter experience level",
      icon: SlidersHorizontal,
      run: onSimplifyInterface,
    },
  ];
  return commands;
}
