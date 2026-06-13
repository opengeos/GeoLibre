import {
  DEFAULT_PROJECT_NAME,
  projectFromStore,
  projectPathLabel,
  redo,
  serializeProject,
  undo,
  useAppStore,
} from "@geolibre/core";
import type {
  ConversionToolKind,
  RasterToolKind,
  VectorToolKind,
} from "@geolibre/core";
import {
  type BuiltInMapControl,
  DEFAULT_BUILT_IN_CONTROL_VISIBILITY,
  type MapController,
} from "@geolibre/map";
import {
  closeBookmarkPanel,
  closeColorbarPanel,
  closeDuckDBLayerPanel,
  closeEarthEnginePanel,
  closeHtmlPanel,
  closeLegendPanel,
  closeMaplibreComponentControls,
  closeMeasurePanel,
  closeMinimapPanel,
  closePlanetaryComputerPanel,
  closePrintPanel,
  closeRasterLayerPanel,
  closeSearchPlacesPanel,
  closeThreeDTilesLayerPanel,
  closeVectorLayerPanel,
  closeViewStatePanel,
  openFlatGeobufAddVectorLayerPanel,
  openDuckDBLayerPanel,
  isBookmarkPanelVisible,
  isEarthEnginePanelVisible,
  isColorbarPanelVisible,
  isHtmlPanelVisible,
  isLegendPanelVisible,
  isMeasurePanelVisible,
  isMinimapPanelVisible,
  isPrintPanelVisible,
  isSearchPlacesPanelVisible,
  isViewStatePanelVisible,
  openBookmarkPanel,
  openColorbarPanel,
  openHtmlPanel,
  openLegendPanel,
  openLidarLayerPanel,
  openMeasurePanel,
  openMinimapPanel,
  openPlanetaryComputerPanel,
  openPMTilesLayerPanel,
  openPrintPanel,
  openRasterLayerPanel,
  openSearchPlacesPanel,
  openSplattingLayerPanel,
  openStacSearchLayerPanel,
  openThreeDTilesLayerPanel,
  openVectorLayerPanel,
  openViewStatePanel,
  openZarrLayerPanel,
  subscribeBookmarkPanel,
  subscribeColorbarPanel,
  subscribeEarthEnginePanel,
  subscribeHtmlPanel,
  subscribeLegendPanel,
  subscribeMeasurePanel,
  subscribeMinimapPanel,
  subscribePrintPanel,
  subscribeSearchPlacesPanel,
  subscribeViewStatePanel,
  toggleEarthEnginePanel,
  DECK_VIZ_PLUGIN_ID,
  DIRECTIONS_PLUGIN_ID,
  EFFECTS_PLUGIN_ID,
  WEB_SERVICE_PLUGIN_IDS,
  type GeoLibreMapControlPosition,
} from "@geolibre/plugins";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
  Label,
} from "@geolibre/ui";
import {
  Bug,
  CircleHelp,
  Database,
  FilePen,
  Share2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  History,
  Info,
  Keyboard,
  Layers,
  Link2,
  Map,
  MessageSquare,
  Moon,
  Pencil,
  Printer,
  LayoutTemplate,
  Puzzle,
  Redo2,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Sun,
  Undo2,
  Wrench,
  X,
} from "lucide-react";
import { useStore } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type FormEvent, useRef, useState, useSyncExternalStore } from "react";
import type { ParseKeys } from "i18next";
import { useTranslation } from "react-i18next";
import {
  createAppAPI,
  getPluginManager,
  usePluginRegistry,
} from "../../hooks/usePlugins";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import type { ThemeMode } from "../../hooks/useThemeMode";
import {
  isHttpUrl,
  isTauri,
  openLocalDataFileWithFallback,
  openProjectFile,
  openRecentProjectFile,
  RecentProjectGoneError,
  saveProjectFile,
  saveProjectFileToPath,
} from "../../lib/tauri-io";
import {
  addOsmPbfLayers,
  loadOsmPbf,
  osmPbfBaseName,
  OSM_PBF_SIZE_WARN_BYTES,
} from "../../lib/osm-pbf-loader";
import { mergeStringLists } from "../../lib/string-lists";
import { normalizeProjectUrl } from "../../lib/urls";
import { resolveProjectXyzLayers } from "../../lib/xyz-url";
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
import { SettingsDialog } from "./SettingsDialog";
import { PrintLayoutDialog } from "./PrintLayoutDialog";

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

type ToolbarMapControl = Exclude<BuiltInMapControl, "layer-control">;

const MAP_CONTROL_ITEMS: Array<{
  id: ToolbarMapControl;
  labelKey: ParseKeys;
}> = [
  { id: "navigation", labelKey: "toolbar.mapControl.navigation" },
  { id: "fullscreen", labelKey: "toolbar.mapControl.fullscreen" },
  { id: "geolocate", labelKey: "toolbar.mapControl.geolocate" },
  { id: "globe", labelKey: "toolbar.mapControl.globe" },
  { id: "terrain", labelKey: "toolbar.mapControl.terrain" },
  { id: "scale", labelKey: "toolbar.mapControl.scale" },
  { id: "attribution", labelKey: "toolbar.mapControl.attribution" },
  { id: "logo", labelKey: "toolbar.mapControl.logo" },
];

const NEW_PROJECT_VISIBLE_BUILT_IN_CONTROLS = new Set<BuiltInMapControl>([
  "navigation",
  "fullscreen",
  "globe",
  "layer-control",
]);

const ALL_BUILT_IN_CONTROL_IDS: BuiltInMapControl[] = [
  ...MAP_CONTROL_ITEMS.map(({ id }) => id),
  "layer-control",
];

const PLUGIN_POSITION_ITEMS: Array<{
  value: GeoLibreMapControlPosition;
  labelKey: ParseKeys;
}> = [
  { value: "top-left", labelKey: "toolbar.position.topLeft" },
  { value: "top-right", labelKey: "toolbar.position.topRight" },
  { value: "bottom-left", labelKey: "toolbar.position.bottomLeft" },
  { value: "bottom-right", labelKey: "toolbar.position.bottomRight" },
];

// Plugins grouped under the "Web Services" submenu of the Plugins menu.
const WEB_SERVICE_PLUGIN_ID_SET = new Set<string>(WEB_SERVICE_PLUGIN_IDS);

const FEEDBACK_URL = "https://github.com/opengeos/GeoLibre/issues";
// A small (~350 KB) CORS-enabled Las Vegas Strip sample, so the URL field works
// out of the box on both the desktop and web builds.
const DEFAULT_OSM_PBF_URL =
  "https://data.source.coop/giswqs/opengeos/LasVegas.osm.pbf";

// Static command metadata for the menus that map a single id to a label. These
// drive the command palette so it stays in sync with the menus without each
// action being defined twice. The `run` closures are built in the component
// where the store setters are in scope.
const ADD_DATA_KIND_COMMANDS: Array<{ kind: AddDataKind; titleKey: ParseKeys }> = [
  { kind: "delimited-text", titleKey: "toolbar.layerType.delimitedText" },
  { kind: "gpx", titleKey: "toolbar.layerType.gpx" },
  { kind: "mbtiles", titleKey: "toolbar.layerType.mbtiles" },
  { kind: "xyz", titleKey: "toolbar.layerType.xyz" },
  { kind: "wms", titleKey: "toolbar.layerType.wms" },
  { kind: "wfs", titleKey: "toolbar.layerType.wfs" },
  { kind: "wmts", titleKey: "toolbar.layerType.wmts" },
  { kind: "arcgis", titleKey: "toolbar.layerType.arcgis" },
  { kind: "video", titleKey: "toolbar.layerType.video" },
  { kind: "deckgl-viz", titleKey: "toolbar.layerType.deckglViz" },
  { kind: "postgres", titleKey: "toolbar.layerType.postgres" },
];

const CONVERSION_COMMANDS: Array<{
  kind: ConversionToolKind;
  titleKey: ParseKeys;
}> = [
  {
    kind: "vector-to-geoparquet",
    titleKey: "toolbar.conversion.vectorToGeoparquet",
  },
  {
    kind: "vector-to-flatgeobuf",
    titleKey: "toolbar.conversion.vectorToFlatgeobuf",
  },
  { kind: "csv-to-geoparquet", titleKey: "toolbar.conversion.csvToGeoparquet" },
  { kind: "vector-to-pmtiles", titleKey: "toolbar.conversion.vectorToPmtiles" },
  { kind: "raster-to-cog", titleKey: "toolbar.conversion.rasterToCog" },
];

const VECTOR_TOOL_COMMANDS: Array<{ kind: VectorToolKind; titleKey: ParseKeys }> =
  [
    { kind: "buffer", titleKey: "toolbar.vectorTool.buffer" },
    { kind: "centroids", titleKey: "toolbar.vectorTool.centroids" },
    { kind: "convex-hull", titleKey: "toolbar.vectorTool.convexHull" },
    { kind: "dissolve", titleKey: "toolbar.vectorTool.dissolve" },
    { kind: "bounding-box", titleKey: "toolbar.vectorTool.boundingBox" },
    { kind: "simplify", titleKey: "toolbar.vectorTool.simplify" },
    { kind: "clip", titleKey: "toolbar.vectorTool.clip" },
    { kind: "intersection", titleKey: "toolbar.vectorTool.intersection" },
    { kind: "difference", titleKey: "toolbar.vectorTool.difference" },
    { kind: "union", titleKey: "toolbar.vectorTool.union" },
    { kind: "spatial-join", titleKey: "toolbar.vectorTool.spatialJoin" },
    { kind: "select-by-value", titleKey: "toolbar.vectorTool.selectByValue" },
    {
      kind: "select-by-location",
      titleKey: "toolbar.vectorTool.selectByLocation",
    },
    { kind: "reproject", titleKey: "toolbar.vectorTool.reproject" },
    { kind: "explode", titleKey: "toolbar.vectorTool.explode" },
    { kind: "aggregate", titleKey: "toolbar.vectorTool.aggregate" },
    { kind: "smooth", titleKey: "toolbar.vectorTool.smooth" },
    { kind: "grid", titleKey: "toolbar.vectorTool.grid" },
    { kind: "voronoi", titleKey: "toolbar.vectorTool.voronoi" },
    { kind: "h3-grid", titleKey: "toolbar.vectorTool.h3Grid" },
    { kind: "h3-bin-points", titleKey: "toolbar.vectorTool.h3BinPoints" },
  ];

const RASTER_TOOL_COMMANDS: Array<{ kind: RasterToolKind; titleKey: ParseKeys }> =
  [
    { kind: "hillshade", titleKey: "toolbar.rasterTool.hillshade" },
    { kind: "slope", titleKey: "toolbar.rasterTool.slope" },
    { kind: "aspect", titleKey: "toolbar.rasterTool.aspect" },
    { kind: "reproject", titleKey: "toolbar.rasterTool.reproject" },
    { kind: "resample", titleKey: "toolbar.rasterTool.resample" },
    { kind: "clip-extent", titleKey: "toolbar.rasterTool.clipExtent" },
    { kind: "clip-mask", titleKey: "toolbar.rasterTool.clipMask" },
    { kind: "polygonize", titleKey: "toolbar.rasterTool.polygonize" },
    { kind: "contour", titleKey: "toolbar.rasterTool.contour" },
    { kind: "interpolate", titleKey: "toolbar.rasterTool.interpolate" },
    { kind: "zonal", titleKey: "toolbar.rasterTool.zonal" },
    { kind: "raster-calc", titleKey: "toolbar.rasterTool.rasterCalc" },
    { kind: "reclassify", titleKey: "toolbar.rasterTool.reclassify" },
    { kind: "mosaic", titleKey: "toolbar.rasterTool.mosaic" },
    { kind: "focal", titleKey: "toolbar.rasterTool.focal" },
  ];

async function openExternalLink(url: string): Promise<void> {
  if (isTauri()) {
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function formatRecentProjectTime(openedAt: string): string {
  const openedDate = new Date(openedAt);
  if (Number.isNaN(openedDate.getTime())) return "";

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(openedDate);
}

function newProjectToolbarControlVisibility(): Record<
  ToolbarMapControl,
  boolean
> {
  return MAP_CONTROL_ITEMS.reduce(
    (acc, { id }) => {
      acc[id] = NEW_PROJECT_VISIBLE_BUILT_IN_CONTROLS.has(id);
      return acc;
    },
    {} as Record<ToolbarMapControl, boolean>,
  );
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
  const loadProject = useAppStore((s) => s.loadProject);
  const setProcessingOpen = useAppStore((s) => s.setProcessingOpen);
  const setConversionOpen = useAppStore((s) => s.setConversionOpen);
  const setVectorToolOpen = useAppStore((s) => s.setVectorToolOpen);
  const setRasterToolOpen = useAppStore((s) => s.setRasterToolOpen);
  const setSqlWorkspaceOpen = useAppStore((s) => s.setSqlWorkspaceOpen);
  const projectName = useAppStore((s) => s.projectName);
  const projectPath = useAppStore((s) => s.projectPath);
  const recentProjects = useAppStore((s) => s.recentProjects);
  const setProjectPath = useAppStore((s) => s.setProjectPath);
  const setProjectName = useAppStore((s) => s.setProjectName);
  const rememberRecentProject = useAppStore((s) => s.rememberRecentProject);
  const forgetRecentProject = useAppStore((s) => s.forgetRecentProject);
  const clearRecentProjects = useAppStore((s) => s.clearRecentProjects);
  const markSaved = useAppStore((s) => s.markSaved);
  const canUndo = useStore(
    useAppStore.temporal,
    (s) => s.pastStates.length > 0,
  );
  const canRedo = useStore(
    useAppStore.temporal,
    (s) => s.futureStates.length > 0,
  );
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
  const [netcdfDialogOpen, setNetcdfDialogOpen] = useState(false);
  const [newProjectDialogOpen, setNewProjectDialogOpen] = useState(false);
  const [projectUrlDialogOpen, setProjectUrlDialogOpen] = useState(false);
  const [managePluginsOpen, setManagePluginsOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [projectUrl, setProjectUrl] = useState("");
  const [projectUrlError, setProjectUrlError] = useState<string | null>(null);
  const [projectUrlLoading, setProjectUrlLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [directionsNoticeOpen, setDirectionsNoticeOpen] = useState(false);
  const [osmPbfLoading, setOsmPbfLoading] = useState(false);
  const osmPbfAbortRef = useRef<AbortController | null>(null);
  const [osmPbfDialogOpen, setOsmPbfDialogOpen] = useState(false);
  const [osmPbfUrl, setOsmPbfUrl] = useState(DEFAULT_OSM_PBF_URL);
  const [osmPbfConfirm, setOsmPbfConfirm] = useState<{
    data: ArrayBuffer;
    baseName: string;
    sourcePath: string;
    sizeMb: number;
  } | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [printLayoutOpen, setPrintLayoutOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [checkForUpdatesRequest, setCheckForUpdatesRequest] = useState(0);
  const projectUrlAbortRef = useRef<AbortController | null>(null);
  const recentAbortRef = useRef<AbortController | null>(null);

  const handleOpenFromFile = async () => {
    const result = await openProjectFile();
    if (result) {
      try {
        loadProject(
          await resolveProjectXyzLayers(result.project),
          result.path,
          { rememberRecent: isTauri() },
        );
      } catch (error) {
        console.error("Failed to open project", error);
        setActionError(
          error instanceof Error
            ? error.message
            : t("toolbar.error.couldNotOpenProject"),
        );
      }
    }
  };

  const handleOpenFromUrl = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedUrl = normalizeProjectUrl(projectUrl);
    if (!normalizedUrl) {
      setProjectUrlError(t("toolbar.error.invalidProjectUrl"));
      return;
    }

    projectUrlAbortRef.current?.abort();
    const controller = new AbortController();
    projectUrlAbortRef.current = controller;

    setProjectUrlLoading(true);
    setProjectUrlError(null);

    try {
      const result = await openRecentProjectFile(
        normalizedUrl,
        controller.signal,
      );
      const project = await resolveProjectXyzLayers(
        result.project,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      loadProject(project, result.path);
      setProjectUrl("");
      setProjectUrlDialogOpen(false);
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error("Failed to open project URL", error);
      setProjectUrlError(
        error instanceof Error
          ? error.message
          : t("toolbar.error.couldNotOpenProjectUrl"),
      );
    } finally {
      if (projectUrlAbortRef.current === controller) {
        projectUrlAbortRef.current = null;
      }
      setProjectUrlLoading(false);
    }
  };

  const handleOpenRecent = async (path: string) => {
    // Cancel any previous in-flight open so rapid clicks cannot race and let a
    // stale fetch win by resolving last.
    recentAbortRef.current?.abort();
    const controller = new AbortController();
    recentAbortRef.current = controller;

    let result: Awaited<ReturnType<typeof openRecentProjectFile>>;

    try {
      result = await openRecentProjectFile(path, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      // Only drop the entry when the project is permanently gone; preserve it
      // for transient failures (network timeout, 5xx, momentary IO error).
      if (error instanceof RecentProjectGoneError) {
        forgetRecentProject(path);
      }
      console.error("Failed to open recent project", error);
      setActionError(
        error instanceof Error
          ? error.message
          : t("toolbar.error.couldNotOpenRecentProject"),
      );
      return;
    }

    try {
      const project = await resolveProjectXyzLayers(
        result.project,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      loadProject(project, result.path);
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error("Failed to load recent project", error);
      setActionError(
        error instanceof Error
          ? error.message
          : t("toolbar.error.couldNotLoadRecentProject"),
      );
    } finally {
      if (recentAbortRef.current === controller) {
        recentAbortRef.current = null;
      }
    }
  };

  // Build the current project from live store + map state and serialize it.
  // Shared by Save/Save As and the Share action so they all capture identical
  // project content (including the current map view and plugin state).
  const buildCurrentProject = (nameOverride?: string) => {
    const state = useAppStore.getState();
    const defaultProjectName =
      nameOverride?.trim() || state.projectName.trim() || DEFAULT_PROJECT_NAME;
    const pluginManifestUrls = mergeStringLists(
      state.projectPlugins?.manifestUrls ?? [],
      useDesktopSettingsStore.getState().desktopSettings.pluginManifestUrls,
    );
    const project = projectFromStore({
      projectName: defaultProjectName,
      mapView: mapControllerRef.current?.readView() ?? state.mapView,
      basemapStyleUrl: state.basemapStyleUrl,
      basemapVisible: state.basemapVisible,
      basemapOpacity: state.basemapOpacity,
      layers: state.layers,
      preferences: state.preferences,
      plugins: {
        ...getPluginManager().getProjectState(),
        manifestUrls: pluginManifestUrls,
      },
      metadata: state.metadata,
    });
    return {
      project,
      defaultProjectName,
      content: serializeProject(project),
      // Expose the path read from this same snapshot so callers don't take a
      // second `getState()` read that could be misread as a separate instant.
      projectPath: state.projectPath,
    };
  };

  const saveProject = async (options?: {
    saveAs?: boolean;
  }): Promise<boolean> => {
    const { project, defaultProjectName, content, projectPath } =
      buildCurrentProject();
    // Projects opened from a URL have no writable path, so both Save and
    // Save As fall back to the save dialog for them.
    const existingLocalPath =
      projectPath && !isHttpUrl(projectPath) ? projectPath : null;
    let path: string | null;
    try {
      path =
        !options?.saveAs && existingLocalPath
          ? await saveProjectFileToPath(content, existingLocalPath)
          : await saveProjectFile(
              content,
              existingLocalPath ?? `${defaultProjectName}.geolibre.json`,
            );
    } catch (error) {
      console.error("Failed to save project", error);
      setActionError(
        error instanceof Error
          ? error.message
          : t("toolbar.error.couldNotSaveProject"),
      );
      return false;
    }
    if (!path) return false;
    setProjectPath(path);
    rememberRecentProject({
      path,
      name: project.name,
      openedAt: new Date().toISOString(),
    });
    markSaved();
    return true;
  };

  const handleSave = () => saveProject();
  const handleSaveAs = () => saveProject({ saveAs: true });

  const {
    plugins,
    isActive,
    getMapControlPosition,
    toggle,
    setMapControlPosition,
  } = usePluginRegistry();
  const appApi = createAppAPI(mapControllerRef);
  // Show a one-time consent notice the first time routing is enabled, since it
  // sends the user's waypoints to a public third-party server. A hover-only
  // tooltip is invisible on touch, so this is the real disclosure.
  const handleToggleDirections = () => {
    if (isActive(DIRECTIONS_PLUGIN_ID)) {
      toggle(DIRECTIONS_PLUGIN_ID, appApi);
      return;
    }
    let acknowledged = false;
    try {
      acknowledged =
        localStorage.getItem("geolibre:directions-osrm-notice") === "1";
    } catch {
      // localStorage unavailable (private mode): fall back to showing the notice.
    }
    if (acknowledged) toggle(DIRECTIONS_PLUGIN_ID, appApi);
    else setDirectionsNoticeOpen(true);
  };
  const confirmEnableDirections = () => {
    try {
      localStorage.setItem("geolibre:directions-osrm-notice", "1");
    } catch {
      // Ignore: the notice will simply show again next time.
    }
    setDirectionsNoticeOpen(false);
    toggle(DIRECTIONS_PLUGIN_ID, appApi);
  };
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
  const handleAddFlatGeobufLayer = () => {
    openFlatGeobufAddVectorLayerPanel(appApi);
  };
  const handleAddDuckDBLayer = () => {
    openDuckDBLayerPanel(appApi);
  };
  const handleAddPMTilesLayer = () => {
    openPMTilesLayerPanel(appApi);
  };
  const handleAddStacLayer = () => {
    openStacSearchLayerPanel(appApi);
  };
  const handleAddRasterLayer = () => {
    openRasterLayerPanel(appApi);
  };
  const handleAddVectorLayer = () => {
    openVectorLayerPanel(appApi);
  };
  const runOsmPbf = async (
    data: ArrayBuffer,
    baseName: string,
    sourcePath: string,
  ) => {
    // Reuse a controller already started for the URL fetch, else make one, so
    // the loading dialog's Cancel/dismiss can abort the in-flight parse.
    const controller = osmPbfAbortRef.current ?? new AbortController();
    osmPbfAbortRef.current = controller;
    if (controller.signal.aborted) {
      osmPbfAbortRef.current = null;
      setOsmPbfLoading(false);
      return;
    }
    setOsmPbfLoading(true);
    try {
      const layers = await loadOsmPbf(data, controller.signal);
      const added = addOsmPbfLayers(
        appApi.addGeoJsonLayer,
        baseName,
        sourcePath,
        layers,
      );
      if (added === 0) {
        setActionError(t("toolbar.error.osmPbfNoFeatures"));
      } else if (layers.bounds) {
        appApi.fitBounds?.(layers.bounds);
      }
    } catch (err) {
      // A user cancel (abort) is not an error.
      if (err instanceof DOMException && err.name === "AbortError") return;
      const base =
        err instanceof Error
          ? err.message
          : t("toolbar.error.couldNotLoadOsmPbf");
      // Bare .pbf is also the Mapbox Vector Tile extension; hint at it on
      // failure. The message + hint live in one catalog key so each locale
      // controls how the two sentences join (e.g. no space in CJK).
      setActionError(
        t("toolbar.error.osmPbfLoadFailedWithHint", { message: base }),
      );
    } finally {
      setOsmPbfLoading(false);
      if (osmPbfAbortRef.current === controller) osmPbfAbortRef.current = null;
    }
  };
  const cancelOsmPbf = () => {
    osmPbfAbortRef.current?.abort();
    osmPbfAbortRef.current = null;
    setOsmPbfLoading(false);
  };
  // Large extracts can exhaust browser memory; confirm before parsing.
  const startOsmPbf = (
    data: ArrayBuffer,
    baseName: string,
    sourcePath: string,
  ) => {
    if (data.byteLength >= OSM_PBF_SIZE_WARN_BYTES) {
      setOsmPbfConfirm({
        data,
        baseName,
        sourcePath,
        sizeMb: Math.round(data.byteLength / (1024 * 1024)),
      });
      return;
    }
    void runOsmPbf(data, baseName, sourcePath);
  };
  const handleChooseOsmPbfFile = async () => {
    setOsmPbfDialogOpen(false);
    try {
      const result = await openLocalDataFileWithFallback({
        filters: [{ name: "OSM PBF", extensions: ["pbf", "osm.pbf"] }],
        accept: ".pbf,.osm.pbf",
        readBinary: true,
      });
      if (!result?.data) return;
      const fileName = result.path.split(/[/\\]/).pop() || "osm";
      startOsmPbf(result.data, osmPbfBaseName(fileName), result.path);
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : t("toolbar.error.couldNotOpenOsmPbf"),
      );
    }
  };
  const handleLoadOsmPbfUrl = async () => {
    const url = osmPbfUrl.trim();
    if (!isHttpUrl(url)) {
      setActionError(t("toolbar.error.invalidOsmPbfUrl"));
      return;
    }
    setOsmPbfDialogOpen(false);
    // Start the controller before the fetch so a dismiss during download is
    // honored (the download itself isn't abortable through the shared fetcher,
    // but we drop the result instead of parsing/adding it).
    const controller = new AbortController();
    osmPbfAbortRef.current = controller;
    setOsmPbfLoading(true);
    try {
      const data = await appApi.fetchArrayBuffer?.(url);
      if (controller.signal.aborted) return;
      // Surface the user-facing message directly rather than throwing a
      // translated Error — Error.message also feeds error boundaries and logs,
      // which should stay locale-independent. The catch below still covers a
      // genuine fetch failure.
      if (!data) {
        setOsmPbfLoading(false);
        if (osmPbfAbortRef.current === controller) osmPbfAbortRef.current = null;
        setActionError(t("toolbar.error.couldNotDownloadOsmPbf"));
        return;
      }
      const fileName =
        url.split("/").pop()?.split("?")[0].split("#")[0] || "osm";
      // Keep the loading indicator up through the parse for small files
      // (runOsmPbf re-sets it and clears it in finally); only stop it here when
      // a large file will instead show the confirm dialog, to avoid a flicker.
      if (data.byteLength >= OSM_PBF_SIZE_WARN_BYTES) setOsmPbfLoading(false);
      startOsmPbf(data, osmPbfBaseName(fileName), url);
    } catch (err) {
      setOsmPbfLoading(false);
      if (osmPbfAbortRef.current === controller) osmPbfAbortRef.current = null;
      setActionError(
        err instanceof Error
          ? err.message
          : t("toolbar.error.couldNotDownloadOsmPbf"),
      );
    }
  };
  const searchPlacesVisible = useSyncExternalStore(
    subscribeSearchPlacesPanel,
    isSearchPlacesPanelVisible,
    isSearchPlacesPanelVisible,
  );
  const handleToggleSearchPlacesPanel = () => {
    if (searchPlacesVisible) {
      closeSearchPlacesPanel();
      return;
    }
    openSearchPlacesPanel(appApi);
  };
  const printPanelVisible = useSyncExternalStore(
    subscribePrintPanel,
    isPrintPanelVisible,
    isPrintPanelVisible,
  );
  const handleTogglePrintPanel = () => {
    if (printPanelVisible) {
      closePrintPanel();
      return;
    }
    openPrintPanel(appApi);
  };
  const colorbarPanelVisible = useSyncExternalStore(
    subscribeColorbarPanel,
    isColorbarPanelVisible,
    isColorbarPanelVisible,
  );
  const handleToggleColorbarPanel = () => {
    if (colorbarPanelVisible) {
      closeColorbarPanel(appApi);
      return;
    }
    openColorbarPanel(appApi);
  };
  const legendPanelVisible = useSyncExternalStore(
    subscribeLegendPanel,
    isLegendPanelVisible,
    isLegendPanelVisible,
  );
  const handleToggleLegendPanel = () => {
    if (legendPanelVisible) {
      closeLegendPanel(appApi);
      return;
    }
    openLegendPanel(appApi);
  };
  const htmlPanelVisible = useSyncExternalStore(
    subscribeHtmlPanel,
    isHtmlPanelVisible,
    isHtmlPanelVisible,
  );
  const handleToggleHtmlPanel = () => {
    if (htmlPanelVisible) {
      closeHtmlPanel(appApi);
      return;
    }
    openHtmlPanel(appApi);
  };
  const measurePanelVisible = useSyncExternalStore(
    subscribeMeasurePanel,
    isMeasurePanelVisible,
    isMeasurePanelVisible,
  );
  const handleToggleMeasurePanel = () => {
    if (measurePanelVisible) {
      closeMeasurePanel(appApi);
      return;
    }
    openMeasurePanel(appApi);
  };
  const bookmarkPanelVisible = useSyncExternalStore(
    subscribeBookmarkPanel,
    isBookmarkPanelVisible,
    isBookmarkPanelVisible,
  );
  const handleToggleBookmarkPanel = () => {
    if (bookmarkPanelVisible) {
      closeBookmarkPanel(appApi);
      return;
    }
    openBookmarkPanel(appApi);
  };
  const minimapPanelVisible = useSyncExternalStore(
    subscribeMinimapPanel,
    isMinimapPanelVisible,
    isMinimapPanelVisible,
  );
  const handleToggleMinimapPanel = () => {
    if (minimapPanelVisible) {
      closeMinimapPanel(appApi);
      return;
    }
    openMinimapPanel(appApi);
  };
  const viewStatePanelVisible = useSyncExternalStore(
    subscribeViewStatePanel,
    isViewStatePanelVisible,
    isViewStatePanelVisible,
  );
  const handleToggleViewStatePanel = () => {
    if (viewStatePanelVisible) {
      closeViewStatePanel(appApi);
      return;
    }
    openViewStatePanel(appApi);
  };
  const handleAddZarrLayer = () => {
    openZarrLayerPanel(appApi);
  };
  const handleAddNetcdfLayer = () => {
    setNetcdfDialogOpen(true);
  };
  const handleAddLidarLayer = () => {
    openLidarLayerPanel(appApi);
  };
  const handleAddSplattingLayer = () => {
    openSplattingLayerPanel(appApi);
  };
  const handleAddThreeDTilesLayer = () => {
    openThreeDTilesLayerPanel(appApi);
  };
  const handleOpenPlanetaryComputerPanel = () => {
    openPlanetaryComputerPanel(appApi);
  };
  const earthEnginePanelVisible = useSyncExternalStore(
    subscribeEarthEnginePanel,
    isEarthEnginePanelVisible,
    isEarthEnginePanelVisible,
  );
  const handleToggleEarthEnginePanel = () => {
    toggleEarthEnginePanel(appApi);
  };
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
      run: () => void handleOpenFromFile(),
    },
    {
      id: "project.open-url",
      title: t("toolbar.command.projectOpenUrl"),
      group: t("toolbar.commandGroup.project"),
      keywords: "load",
      icon: Link2,
      run: () => setProjectUrlDialogOpen(true),
    },
    {
      id: "project.save",
      title: t("toolbar.command.projectSave"),
      group: t("toolbar.commandGroup.project"),
      icon: Save,
      shortcut: { key: "s", mod: true, shift: false },
      run: () => void handleSave(),
    },
    {
      id: "project.save-as",
      title: t("toolbar.command.projectSaveAs"),
      group: t("toolbar.commandGroup.project"),
      icon: FilePen,
      shortcut: { key: "s", mod: true, shift: true },
      run: () => void handleSaveAs(),
    },
    {
      id: "project.share",
      title: t("toolbar.command.projectShare"),
      group: t("toolbar.commandGroup.project"),
      icon: Share2,
      run: () => setShareDialogOpen(true),
    },
    {
      id: "project.print",
      title: t("toolbar.command.projectPrint"),
      group: t("toolbar.commandGroup.project"),
      icon: Printer,
      run: handleTogglePrintPanel,
    },
    {
      id: "project.print-layout",
      title: "Print Layout…",
      group: "Project",
      icon: LayoutTemplate,
      run: () => setPrintLayoutOpen(true),
    },
    // Add Data
    {
      id: "add.vector",
      title: t("toolbar.command.addVectorLayer"),
      group: t("toolbar.commandGroup.addData"),
      icon: Database,
      run: handleAddVectorLayer,
    },
    {
      id: "add.raster",
      title: t("toolbar.command.addRasterLayer"),
      group: t("toolbar.commandGroup.addData"),
      icon: Database,
      run: handleAddRasterLayer,
    },
    {
      id: "add.osm-pbf",
      title: t("toolbar.command.addOsmPbfLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: () => setOsmPbfDialogOpen(true),
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
      run: handleAddStacLayer,
    },
    {
      id: "add.geoparquet",
      title: t("toolbar.command.addGeoparquetLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: handleAddVectorLayer,
    },
    {
      id: "add.flatgeobuf",
      title: t("toolbar.command.addFlatgeobufLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: handleAddFlatGeobufLayer,
    },
    {
      id: "add.pmtiles",
      title: t("toolbar.command.addPmtilesLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: handleAddPMTilesLayer,
    },
    {
      id: "add.zarr",
      title: t("toolbar.command.addZarrLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: handleAddZarrLayer,
    },
    {
      id: "add.netcdf",
      title: t("toolbar.command.addNetcdfLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: handleAddNetcdfLayer,
    },
    {
      id: "add.lidar",
      title: t("toolbar.command.addLidarLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: handleAddLidarLayer,
    },
    {
      id: "add.splatting",
      title: t("toolbar.command.addSplattingLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: handleAddSplattingLayer,
    },
    {
      id: "add.3d-tiles",
      title: t("toolbar.command.add3dTilesLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: handleAddThreeDTilesLayer,
    },
    {
      id: "add.duckdb",
      title: t("toolbar.command.addDuckdbLayer"),
      group: t("toolbar.commandGroup.addData"),
      run: handleAddDuckDBLayer,
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
      run: handleOpenPlanetaryComputerPanel,
    },
    {
      id: "proc.earth-engine",
      title: t("toolbar.command.earthEngine"),
      group: t("toolbar.commandGroup.processing"),
      run: handleToggleEarthEnginePanel,
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
      run: handleToggleDirections,
    },
    {
      id: "control.search",
      title: t("toolbar.command.toggleSearch"),
      group: t("toolbar.commandGroup.controls"),
      run: handleToggleSearchPlacesPanel,
    },
    {
      id: "control.colorbar",
      title: t("toolbar.command.toggleColorbar"),
      group: t("toolbar.commandGroup.controls"),
      run: handleToggleColorbarPanel,
    },
    {
      id: "control.legend",
      title: t("toolbar.command.toggleLegend"),
      group: t("toolbar.commandGroup.controls"),
      run: handleToggleLegendPanel,
    },
    {
      id: "control.html",
      title: t("toolbar.command.toggleHtmlPanel"),
      group: t("toolbar.commandGroup.controls"),
      run: handleToggleHtmlPanel,
    },
    {
      id: "control.measure",
      title: t("toolbar.command.toggleMeasure"),
      group: t("toolbar.commandGroup.controls"),
      run: handleToggleMeasurePanel,
    },
    {
      id: "control.bookmark",
      title: t("toolbar.command.toggleBookmark"),
      group: t("toolbar.commandGroup.controls"),
      run: handleToggleBookmarkPanel,
    },
    {
      id: "control.minimap",
      title: t("toolbar.command.toggleMinimap"),
      group: t("toolbar.commandGroup.controls"),
      run: handleToggleMinimapPanel,
    },
    {
      id: "control.view-state",
      title: t("toolbar.command.toggleViewState"),
      group: t("toolbar.commandGroup.controls"),
      run: handleToggleViewStatePanel,
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
    // Directions, and the deck.gl viz renderer are excluded here because they
    // are surfaced under Controls / Add Data instead (matching the menus).
    ...plugins
      .filter(
        (plugin) =>
          plugin.id !== EFFECTS_PLUGIN_ID &&
          plugin.id !== DIRECTIONS_PLUGIN_ID &&
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className={toolbarButtonClass}
            variant="ghost"
            size={toolbarButtonSize}
            aria-label={t("toolbar.menu.project")}
          >
            <Folder className={toolbarIconClassName} />
            {renderToolbarLabel(t("toolbar.menu.project"))}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>{t("toolbar.menu.project")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setNewProjectDialogOpen(true)}>
            <FilePlus2 className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.item.newEllipsis")}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderOpen className="mr-2 h-3.5 w-3.5" />
              {t("toolbar.item.openFrom")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => void handleOpenFromFile()}>
                <FileText className="mr-2 h-3.5 w-3.5" />
                {t("toolbar.item.fileEllipsis")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setProjectUrlDialogOpen(true)}>
                <Link2 className="mr-2 h-3.5 w-3.5" />
                {t("toolbar.item.urlEllipsis")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={recentProjects.length === 0}>
              <History className="mr-2 h-3.5 w-3.5" />
              {t("toolbar.item.openRecent")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-80">
              {recentProjects.length === 0 ? (
                <DropdownMenuItem disabled>
                  {t("toolbar.item.noRecentProjects")}
                </DropdownMenuItem>
              ) : (
                recentProjects.map((project) => {
                  const openedAt = formatRecentProjectTime(project.openedAt);
                  const label = project.name || projectPathLabel(project.path);
                  return (
                    <DropdownMenuItem
                      key={project.path}
                      className="flex items-start justify-between gap-2"
                      onSelect={() => void handleOpenRecent(project.path)}
                      title={project.path}
                    >
                      <span className="flex min-w-0 flex-col items-start gap-0.5">
                        <span
                          className="max-w-full truncate font-medium"
                          title={label}
                        >
                          {label}
                        </span>
                        <span className="flex max-w-full items-start gap-1 text-xs text-muted-foreground">
                          <History className="h-3 w-3 shrink-0" />
                          <span
                            className="break-all text-left leading-snug"
                            title={project.path}
                          >
                            {openedAt
                              ? `${openedAt} - ${project.path}`
                              : project.path}
                          </span>
                        </span>
                      </span>
                      <button
                        type="button"
                        aria-label={t("toolbar.item.removeFromRecent", {
                          name: label,
                        })}
                        className="mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                        onClick={(event) => {
                          // Keep the menu open and prevent the row's onSelect
                          // (which would reopen the project) from firing.
                          event.stopPropagation();
                          event.preventDefault();
                          forgetRecentProject(project.path);
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuItem>
                  );
                })
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={recentProjects.length === 0}
                onSelect={clearRecentProjects}
              >
                {t("toolbar.item.clearRecentProjects")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void handleSave()}>
            <Save className="mr-2 h-3.5 w-3.5" />
            {t("common.save")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void handleSaveAs()}>
            <FilePen className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.item.saveAsEllipsis")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setShareDialogOpen(true)}>
            <Share2 className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.item.shareEllipsis")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleTogglePrintPanel}>
            <Printer className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.item.printEllipsis")}
            {printPanelVisible ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setPrintLayoutOpen(true)}>
            <LayoutTemplate className="mr-2 h-3.5 w-3.5" />
            Print Layout...
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className={toolbarSecondaryButtonClass}
            variant="ghost"
            size={toolbarButtonSize}
            aria-label={t("toolbar.menu.edit")}
          >
            <Pencil className={toolbarIconClassName} />
            {renderToolbarLabel(t("toolbar.menu.edit"))}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>{t("toolbar.menu.edit")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!canUndo} onSelect={undo}>
            <Undo2 className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.item.undo")}
            <span className="ml-auto text-xs text-muted-foreground">
              Ctrl/Cmd+Z
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canRedo} onSelect={redo}>
            <Redo2 className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.item.redo")}
            <span className="ml-auto text-xs text-muted-foreground">
              Ctrl/Cmd+Shift+Z / Ctrl+Y
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NewProjectDialog
        open={newProjectDialogOpen}
        onOpenChange={setNewProjectDialogOpen}
        onSaveCurrentProject={handleSave}
        onProjectCreated={resetRuntimeControlsForNewProject}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className={toolbarButtonClass}
            variant="ghost"
            size={toolbarButtonSize}
            aria-label={t("toolbar.menu.addData")}
          >
            <Database className={toolbarIconClassName} />
            {renderToolbarLabel(t("toolbar.menu.addData"))}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>{t("toolbar.menu.addData")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {t("toolbar.item.sectionFiles")}
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={handleAddVectorLayer}>
            {t("toolbar.item.vectorLayer")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddRasterLayer}>
            {t("toolbar.item.rasterLayer")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("delimited-text")}>
            {t("toolbar.layerType.delimitedText")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("gpx")}>
            {t("toolbar.layerType.gpx")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("mbtiles")}>
            {t("toolbar.layerType.mbtiles")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={osmPbfLoading || osmPbfConfirm !== null}
            onSelect={() => setOsmPbfDialogOpen(true)}
          >
            {t("toolbar.item.osmPbfLayer")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {t("toolbar.item.sectionWebServices")}
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setAddDataKind("xyz")}>
            {t("toolbar.layerType.xyz")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("wms")}>
            {t("toolbar.layerType.wms")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("wfs")}>
            {t("toolbar.layerType.wfs")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("wmts")}>
            {t("toolbar.layerType.wmts")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("arcgis")}>
            {t("toolbar.layerType.arcgis")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddStacLayer}>
            {t("toolbar.item.stacLayer")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("video")}>
            {t("toolbar.layerType.video")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("deckgl-viz")}>
            {t("toolbar.layerType.deckglViz")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {t("toolbar.item.sectionCloudFormats")}
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={handleAddVectorLayer}>
            {t("toolbar.item.geoparquetLayer")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddFlatGeobufLayer}>
            {t("toolbar.item.flatgeobufLayer")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddPMTilesLayer}>
            {t("toolbar.item.pmtilesLayer")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddZarrLayer}>
            {t("toolbar.item.zarrLayer")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddNetcdfLayer}>
            {t("toolbar.item.netcdfHdf")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {t("toolbar.item.section3dLayers")}
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={handleAddLidarLayer}>
            {t("toolbar.item.lidarLayer")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddSplattingLayer}>
            {t("toolbar.item.splattingLayer")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddThreeDTilesLayer}>
            {t("toolbar.item.threeDTilesLayer")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {t("toolbar.item.sectionDatabases")}
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={handleAddDuckDBLayer}>
            {t("toolbar.item.duckdbLayer")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("postgres")}>
            {t("toolbar.layerType.postgres")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className={toolbarButtonClass}
            variant="ghost"
            size={toolbarButtonSize}
            aria-label={t("toolbar.menu.processing")}
          >
            <Wrench className={toolbarIconClassName} />
            {renderToolbarLabel(t("toolbar.menu.processing"))}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t("toolbar.menu.processing")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setProcessingOpen(true)}>
            {t("toolbar.item.whitebox")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setSqlWorkspaceOpen(true)}>
            {t("toolbar.command.sqlWorkspace")}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {t("toolbar.item.conversion")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem
                onSelect={() => setConversionOpen("vector-to-geoparquet")}
              >
                {t("toolbar.conversion.vectorToGeoparquet")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setConversionOpen("vector-to-flatgeobuf")}
              >
                {t("toolbar.conversion.vectorToFlatgeobuf")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setConversionOpen("csv-to-geoparquet")}
              >
                {t("toolbar.conversion.csvToGeoparquet")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setConversionOpen("vector-to-pmtiles")}
              >
                {t("toolbar.conversion.vectorToPmtiles")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setConversionOpen("raster-to-cog")}
              >
                {t("toolbar.conversion.rasterToCog")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {t("toolbar.item.vector")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("toolbar.item.subGroupGeometry")}
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("buffer")}>
                {t("toolbar.vectorTool.buffer")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("centroids")}>
                {t("toolbar.vectorTool.centroids")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setVectorToolOpen("convex-hull")}
              >
                {t("toolbar.vectorTool.convexHull")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("dissolve")}>
                {t("toolbar.vectorTool.dissolve")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setVectorToolOpen("bounding-box")}
              >
                {t("toolbar.vectorTool.boundingBox")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("simplify")}>
                {t("toolbar.vectorTool.simplify")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("reproject")}>
                {t("toolbar.vectorTool.reproject")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("explode")}>
                {t("toolbar.vectorTool.explode")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("aggregate")}>
                {t("toolbar.vectorTool.aggregate")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("smooth")}>
                {t("toolbar.vectorTool.smooth")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("grid")}>
                {t("toolbar.vectorTool.grid")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("voronoi")}>
                {t("toolbar.vectorTool.voronoi")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("toolbar.item.subGroupOverlay")}
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("clip")}>
                {t("toolbar.vectorTool.clip")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setVectorToolOpen("intersection")}
              >
                {t("toolbar.vectorTool.intersection")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setVectorToolOpen("difference")}
              >
                {t("toolbar.vectorTool.difference")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("union")}>
                {t("toolbar.vectorTool.union")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("toolbar.item.subGroupJoin")}
              </DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => setVectorToolOpen("spatial-join")}
              >
                {t("toolbar.vectorTool.spatialJoin")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("toolbar.item.subGroupSelect")}
              </DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => setVectorToolOpen("select-by-value")}
              >
                {t("toolbar.vectorTool.selectByValue")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setVectorToolOpen("select-by-location")}
              >
                {t("toolbar.vectorTool.selectByLocation")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("toolbar.item.subGroupH3")}
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("h3-grid")}>
                {t("toolbar.vectorTool.h3Grid")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setVectorToolOpen("h3-bin-points")}
              >
                {t("toolbar.vectorTool.h3BinPoints")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {t("toolbar.item.raster")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("toolbar.item.subGroupTerrain")}
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setRasterToolOpen("hillshade")}>
                {t("toolbar.rasterTool.hillshade")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRasterToolOpen("slope")}>
                {t("toolbar.rasterTool.slope")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRasterToolOpen("aspect")}>
                {t("toolbar.rasterTool.aspect")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("toolbar.item.subGroupReproject")}
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setRasterToolOpen("reproject")}>
                {t("toolbar.rasterTool.reproject")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRasterToolOpen("resample")}>
                {t("toolbar.rasterTool.resample")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("toolbar.item.subGroupClip")}
              </DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => setRasterToolOpen("clip-extent")}
              >
                {t("toolbar.rasterTool.clipExtent")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRasterToolOpen("clip-mask")}>
                {t("toolbar.rasterTool.clipMask")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("toolbar.item.subGroupRasterToVector")}
              </DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => setRasterToolOpen("polygonize")}
              >
                {t("toolbar.rasterTool.polygonize")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRasterToolOpen("contour")}>
                {t("toolbar.rasterTool.contour")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("toolbar.item.subGroupVectorToRaster")}
              </DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => setRasterToolOpen("interpolate")}
              >
                {t("toolbar.rasterTool.interpolate")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("toolbar.item.subGroupAnalysis")}
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setRasterToolOpen("zonal")}>
                {t("toolbar.rasterTool.zonal")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setRasterToolOpen("raster-calc")}
              >
                {t("toolbar.rasterTool.rasterCalc")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setRasterToolOpen("reclassify")}
              >
                {t("toolbar.rasterTool.reclassify")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRasterToolOpen("mosaic")}>
                {t("toolbar.rasterTool.mosaic")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRasterToolOpen("focal")}>
                {t("toolbar.rasterTool.focal")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={handleOpenPlanetaryComputerPanel}>
            {t("toolbar.command.planetaryComputer")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggleEarthEnginePanel}>
            {t("toolbar.command.earthEngine")}
            {earthEnginePanelVisible ? " ✓" : ""}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className={toolbarButtonClass}
            variant="ghost"
            size={toolbarButtonSize}
            aria-label={t("toolbar.menu.controls")}
          >
            <SlidersHorizontal className={toolbarIconClassName} />
            {renderToolbarLabel(t("toolbar.menu.controls"))}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t("toolbar.item.mapControls")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {MAP_CONTROL_ITEMS.map((control) => (
            <DropdownMenuItem
              key={control.id}
              onClick={() => toggleMapControl(control.id)}
            >
              {t(control.labelKey)}
              {controlsVisible[control.id] ? " ✓" : ""}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onClick={() => toggle(EFFECTS_PLUGIN_ID, appApi)}>
            {t("toolbar.item.atmosphereEffects")}
            {isActive(EFFECTS_PLUGIN_ID) ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem
            title={t("toolbar.item.directionsTooltip")}
            onClick={handleToggleDirections}
          >
            {t("toolbar.item.directions")}
            {isActive(DIRECTIONS_PLUGIN_ID) ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleToggleSearchPlacesPanel}>
            {t("toolbar.item.search")}
            {searchPlacesVisible ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggleColorbarPanel}>
            {t("toolbar.item.colorbar")}
            {colorbarPanelVisible ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggleLegendPanel}>
            {t("toolbar.item.legend")}
            {legendPanelVisible ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggleHtmlPanel}>
            {t("toolbar.item.html")}
            {htmlPanelVisible ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggleMeasurePanel}>
            {t("toolbar.item.measure")}
            {measurePanelVisible ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggleBookmarkPanel}>
            {t("toolbar.item.bookmark")}
            {bookmarkPanelVisible ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggleMinimapPanel}>
            {t("toolbar.item.minimap")}
            {minimapPanelVisible ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggleViewStatePanel}>
            {t("toolbar.item.viewState")}
            {viewStatePanelVisible ? " ✓" : ""}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className={toolbarButtonClass}
            variant="ghost"
            size={toolbarButtonSize}
            aria-label={t("toolbar.menu.plugins")}
          >
            <Puzzle className={toolbarIconClassName} />
            {renderToolbarLabel(t("toolbar.menu.plugins"))}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t("toolbar.item.activatePlugin")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {(() => {
            const renderPluginMenuItem = (p: (typeof plugins)[number]) => {
              const pluginPosition = getMapControlPosition(p.id);
              if (!pluginPosition) {
                return (
                  <DropdownMenuItem
                    key={p.id}
                    onClick={() => toggle(p.id, appApi)}
                  >
                    {p.name}
                    {isActive(p.id) ? " ✓" : ""}
                  </DropdownMenuItem>
                );
              }

              return (
                <DropdownMenuSub key={p.id}>
                  <DropdownMenuSubTrigger>
                    {p.name}
                    {isActive(p.id) ? " ✓" : ""}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem onClick={() => toggle(p.id, appApi)}>
                      {isActive(p.id)
                        ? t("toolbar.item.deactivate")
                        : t("toolbar.item.activate")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>
                      {t("toolbar.item.position")}
                    </DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={pluginPosition}
                      onValueChange={(position: string) =>
                        setMapControlPosition(
                          p.id,
                          appApi,
                          position as GeoLibreMapControlPosition,
                        )
                      }
                    >
                      {PLUGIN_POSITION_ITEMS.map((position) => (
                        <DropdownMenuRadioItem
                          key={position.value}
                          value={position.value}
                          onSelect={(event: Event) => event.preventDefault()}
                        >
                          {t(position.labelKey)}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              );
            };

            const webServicePlugins = plugins.filter((p) =>
              WEB_SERVICE_PLUGIN_ID_SET.has(p.id),
            );
            // The web service plugins render as one grouped submenu, placed
            // where the first of them appears in registration order (just
            // above Esri Wayback).
            let webServicesRendered = false;
            return plugins.map((p) => {
              // Atmosphere Effects and Directions are toggled from the Controls
              // menu instead, so they are omitted here to avoid a duplicate
              // toggle. The deck.gl viz overlay is an internal renderer driven
              // by the Add Data → "Deck.gl Layer" dialog, not a user-facing
              // toggle, so it is hidden here too.
              if (
                p.id === EFFECTS_PLUGIN_ID ||
                p.id === DIRECTIONS_PLUGIN_ID ||
                p.id === DECK_VIZ_PLUGIN_ID
              ) {
                return null;
              }
              if (!WEB_SERVICE_PLUGIN_ID_SET.has(p.id)) {
                return renderPluginMenuItem(p);
              }
              if (webServicesRendered) return null;
              webServicesRendered = true;
              return (
                <DropdownMenuSub key="web-services">
                  <DropdownMenuSubTrigger>
                    {t("toolbar.item.webServices")}
                    {webServicePlugins.some((plugin) => isActive(plugin.id))
                      ? " ✓"
                      : ""}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {webServicePlugins.map(renderPluginMenuItem)}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              );
            });
          })()}
        </DropdownMenuContent>
      </DropdownMenu>
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
      <ShareProjectDialog
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        currentTitle={projectName}
        getProject={(title) => {
          const { content, defaultProjectName } = buildCurrentProject(title);
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className={toolbarButtonClass}
            variant="ghost"
            size={toolbarButtonSize}
            aria-label={t("toolbar.menu.help")}
          >
            <CircleHelp className={toolbarIconClassName} />
            {renderToolbarLabel(t("toolbar.menu.help"))}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t("toolbar.menu.help")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCommandPaletteOpen(true)}>
            <Search className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.item.commandPalette")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setShortcutsOpen(true)}>
            <Keyboard className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.command.keyboardShortcuts")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onOpenDiagnostics}>
            <Bug className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.command.diagnostics")}
            {diagnosticsErrorCount > 0 ? (
              <span className="ml-2 rounded bg-destructive px-1.5 py-0.5 text-[10px] leading-none text-destructive-foreground">
                {diagnosticsErrorCount}
              </span>
            ) : null}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void openExternalLink(FEEDBACK_URL)}
          >
            <MessageSquare className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.command.giveFeedback")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setAboutOpen(true);
              setCheckForUpdatesRequest((value) => value + 1);
            }}
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.command.checkForUpdates")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAboutOpen(true)}>
            <Info className="mr-2 h-3.5 w-3.5" />
            {t("toolbar.command.about")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AddDataDialog
        kind={addDataKind}
        mapControllerRef={mapControllerRef}
        onOpenChange={(open: boolean) => {
          if (!open) setAddDataKind(null);
        }}
      />
      <AddNetcdfDialog
        open={netcdfDialogOpen}
        appApi={appApi}
        onOpenChange={setNetcdfDialogOpen}
      />
      <Dialog
        open={projectUrlDialogOpen}
        onOpenChange={(open: boolean) => {
          setProjectUrlDialogOpen(open);
          if (!open) {
            projectUrlAbortRef.current?.abort();
            projectUrlAbortRef.current = null;
            setProjectUrl("");
            setProjectUrlError(null);
            setProjectUrlLoading(false);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.openProjectFromUrl")}</DialogTitle>
            <DialogDescription>
              {t("toolbar.item.openProjectFromUrlDesc")}
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleOpenFromUrl}>
            <div className="space-y-2">
              <Label htmlFor="project-url">{t("toolbar.item.projectUrl")}</Label>
              <Input
                id="project-url"
                placeholder="https://example.com/project.geolibre.json"
                value={projectUrl}
                onChange={(event) => {
                  setProjectUrl(event.target.value);
                  setProjectUrlError(null);
                }}
              />
              {projectUrlError ? (
                <p className="text-xs text-destructive">{projectUrlError}</p>
              ) : null}
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setProjectUrlDialogOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={projectUrlLoading}>
                {projectUrlLoading
                  ? t("toolbar.item.opening")
                  : t("toolbar.item.open")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={actionError !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setActionError(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.somethingWentWrong")}</DialogTitle>
            <DialogDescription>{actionError}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button onClick={() => setActionError(null)}>
              {t("toolbar.item.dismiss")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={directionsNoticeOpen}
        onOpenChange={setDirectionsNoticeOpen}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t("toolbar.item.directionsNoticeTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("toolbar.item.directionsNoticeDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setDirectionsNoticeOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={confirmEnableDirections}>
              {t("toolbar.item.continue")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={osmPbfConfirm !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setOsmPbfConfirm(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.largeOsmPbfTitle")}</DialogTitle>
            <DialogDescription>
              {t("toolbar.item.largeOsmPbfDesc", {
                sizeMb: osmPbfConfirm?.sizeMb,
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOsmPbfConfirm(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                const pending = osmPbfConfirm;
                setOsmPbfConfirm(null);
                if (pending) {
                  void runOsmPbf(
                    pending.data,
                    pending.baseName,
                    pending.sourcePath,
                  );
                }
              }}
            >
              {t("toolbar.item.continue")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={osmPbfDialogOpen}
        onOpenChange={(open: boolean) => setOsmPbfDialogOpen(open)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.addOsmPbfLayerTitle")}</DialogTitle>
            <DialogDescription>
              {t("toolbar.item.addOsmPbfLayerDesc")}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void handleLoadOsmPbfUrl();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="osm-pbf-url">{t("toolbar.item.urlLabel")}</Label>
              <Input
                id="osm-pbf-url"
                type="url"
                placeholder={DEFAULT_OSM_PBF_URL}
                value={osmPbfUrl}
                onChange={(e) => setOsmPbfUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("toolbar.item.osmPbfUrlHint")}
              </p>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleChooseOsmPbfFile()}
              >
                {t("toolbar.item.chooseLocalFile")}
              </Button>
              <Button type="submit" disabled={!osmPbfUrl.trim()}>
                {t("toolbar.item.loadFromUrl")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={osmPbfLoading}
        onOpenChange={(open: boolean) => {
          // Dismissing (Escape/backdrop) cancels: abort the worker parse and
          // drop a pending fetch result so no layers are added after dismissal.
          if (!open) cancelOsmPbf();
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("toolbar.item.loadingOsmPbf")}</DialogTitle>
            <DialogDescription>
              {t("toolbar.item.loadingOsmPbfDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button variant="outline" onClick={cancelOsmPbf}>
              {t("common.cancel")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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
