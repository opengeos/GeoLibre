import {
  DEFAULT_PROJECT_NAME,
  projectFromStore,
  projectPathLabel,
  serializeProject,
  useAppStore,
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
  Layers,
  Link2,
  Map,
  MessageSquare,
  Moon,
  Printer,
  Puzzle,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Sun,
  Wrench,
  X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type FormEvent, useRef, useState, useSyncExternalStore } from "react";
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
import { AddDataDialog, type AddDataKind } from "./AddDataDialog";
import { AddNetcdfDialog } from "./AddNetcdfDialog";
import { AboutDialog } from "./AboutDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { ManagePluginsDialog } from "./ManagePluginsDialog";
import { ShareProjectDialog } from "./ShareProjectDialog";
import { SettingsDialog } from "./SettingsDialog";

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
  label: string;
}> = [
  { id: "navigation", label: "Navigation" },
  { id: "fullscreen", label: "Fullscreen" },
  { id: "geolocate", label: "Geolocate" },
  { id: "globe", label: "Globe" },
  { id: "terrain", label: "Terrain" },
  { id: "scale", label: "Scale" },
  { id: "attribution", label: "Attribution" },
  { id: "logo", label: "MapLibre logo" },
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
  label: string;
}> = [
  { value: "top-left", label: "Top left" },
  { value: "top-right", label: "Top right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-right", label: "Bottom right" },
];

// Plugins grouped under the "Web Services" submenu of the Plugins menu.
const WEB_SERVICE_PLUGIN_ID_SET = new Set<string>(WEB_SERVICE_PLUGIN_IDS);

const FEEDBACK_URL = "https://github.com/opengeos/GeoLibre/issues";
// A small (~350 KB) CORS-enabled Las Vegas Strip sample, so the URL field works
// out of the box on both the desktop and web builds.
const DEFAULT_OSM_PBF_URL =
  "https://data.source.coop/giswqs/opengeos/LasVegas.osm.pbf";

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
          error instanceof Error ? error.message : "Could not open project.",
        );
      }
    }
  };

  const handleOpenFromUrl = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedUrl = normalizeProjectUrl(projectUrl);
    if (!normalizedUrl) {
      setProjectUrlError("Enter a valid HTTP or HTTPS project URL.");
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
        error instanceof Error ? error.message : "Could not open project URL.",
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
          : "Could not open the recent project.",
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
          : "Could not load the recent project.",
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
        error instanceof Error ? error.message : "Could not save the project.",
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
        setActionError(
          "No point, line, or polygon features were found in this OSM PBF file.",
        );
      } else if (layers.bounds) {
        appApi.fitBounds?.(layers.bounds);
      }
    } catch (err) {
      // A user cancel (abort) is not an error.
      if (err instanceof DOMException && err.name === "AbortError") return;
      const base =
        err instanceof Error ? err.message : "Could not load the OSM PBF file.";
      // Bare .pbf is also the Mapbox Vector Tile extension; hint at it on failure.
      setActionError(
        `${base} If this is a Mapbox Vector Tile (.pbf), it cannot be loaded as an OSM extract.`,
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
        err instanceof Error ? err.message : "Could not open the OSM PBF file.",
      );
    }
  };
  const handleLoadOsmPbfUrl = async () => {
    const url = osmPbfUrl.trim();
    if (!isHttpUrl(url)) {
      setActionError("Enter a valid http(s) URL to an .osm.pbf file.");
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
      if (!data) throw new Error("Could not download the OSM PBF file.");
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
          : "Could not download the OSM PBF file.",
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
  const toolbarButtonSize = compact ? "icon" : "sm";
  const toolbarButtonClass = compact ? "h-8 w-8 shrink-0" : "shrink-0";
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
            aria-label="Project"
          >
            <Folder className={toolbarIconClassName} />
            {renderToolbarLabel("Project")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Project</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setNewProjectDialogOpen(true)}>
            <FilePlus2 className="mr-2 h-3.5 w-3.5" />
            New...
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderOpen className="mr-2 h-3.5 w-3.5" />
              Open From
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => void handleOpenFromFile()}>
                <FileText className="mr-2 h-3.5 w-3.5" />
                File...
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setProjectUrlDialogOpen(true)}>
                <Link2 className="mr-2 h-3.5 w-3.5" />
                URL...
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={recentProjects.length === 0}>
              <History className="mr-2 h-3.5 w-3.5" />
              Open Recent
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-80">
              {recentProjects.length === 0 ? (
                <DropdownMenuItem disabled>No recent projects</DropdownMenuItem>
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
                        aria-label={`Remove ${label} from recent projects`}
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
                Clear Recent Projects
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void handleSave()}>
            <Save className="mr-2 h-3.5 w-3.5" />
            Save
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void handleSaveAs()}>
            <FilePen className="mr-2 h-3.5 w-3.5" />
            Save As...
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setShareDialogOpen(true)}>
            <Share2 className="mr-2 h-3.5 w-3.5" />
            Share...
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleTogglePrintPanel}>
            <Printer className="mr-2 h-3.5 w-3.5" />
            Print...
            {printPanelVisible ? " ✓" : ""}
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
            aria-label="Add Data"
          >
            <Database className={toolbarIconClassName} />
            {renderToolbarLabel("Add Data")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Add data</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Files
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={handleAddVectorLayer}>
            Vector Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddRasterLayer}>
            Raster Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("delimited-text")}>
            Delimited Text Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("gpx")}>
            GPX Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("mbtiles")}>
            MBTiles Layer
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={osmPbfLoading || osmPbfConfirm !== null}
            onSelect={() => setOsmPbfDialogOpen(true)}
          >
            OSM PBF Layer
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Web services
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setAddDataKind("xyz")}>
            XYZ Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("wms")}>
            WMS Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("wfs")}>
            WFS Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("wmts")}>
            WMTS Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("arcgis")}>
            ArcGIS Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddStacLayer}>
            STAC Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("video")}>
            Video Layer
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Cloud formats
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={handleAddVectorLayer}>
            GeoParquet Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddFlatGeobufLayer}>
            FlatGeobuf Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddPMTilesLayer}>
            PMTiles Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddZarrLayer}>
            Zarr Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddNetcdfLayer}>
            NetCDF / HDF
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            3D layers
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={handleAddLidarLayer}>
            LiDAR Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddSplattingLayer}>
            Splatting Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddThreeDTilesLayer}>
            3D Tiles Layer
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Databases
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={handleAddDuckDBLayer}>
            DuckDB Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("postgres")}>
            PostgreSQL Layer
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className={toolbarButtonClass}
            variant="ghost"
            size={toolbarButtonSize}
            aria-label="Processing"
          >
            <Wrench className={toolbarIconClassName} />
            {renderToolbarLabel("Processing")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Processing</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setProcessingOpen(true)}>
            Whitebox
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setSqlWorkspaceOpen(true)}>
            SQL Workspace
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Conversion</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem
                onSelect={() => setConversionOpen("vector-to-geoparquet")}
              >
                Vector to GeoParquet
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setConversionOpen("vector-to-flatgeobuf")}
              >
                Vector to FlatGeobuf
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setConversionOpen("csv-to-geoparquet")}
              >
                CSV to GeoParquet
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setConversionOpen("vector-to-pmtiles")}
              >
                Vector to PMTiles
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setConversionOpen("raster-to-cog")}
              >
                Raster to COG
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Vector</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Geometry
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("buffer")}>
                Buffer
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("centroids")}>
                Centroids
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setVectorToolOpen("convex-hull")}
              >
                Convex hull
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("dissolve")}>
                Dissolve
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setVectorToolOpen("bounding-box")}
              >
                Bounding box
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("simplify")}>
                Simplify
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Overlay
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("clip")}>
                Clip
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setVectorToolOpen("intersection")}
              >
                Intersection
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setVectorToolOpen("difference")}
              >
                Difference
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("union")}>
                Union
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Raster</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Terrain
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setRasterToolOpen("hillshade")}>
                Hillshade
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRasterToolOpen("slope")}>
                Slope
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRasterToolOpen("aspect")}>
                Aspect
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Reproject
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setRasterToolOpen("reproject")}>
                Reproject
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRasterToolOpen("resample")}>
                Resample
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Clip
              </DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => setRasterToolOpen("clip-extent")}
              >
                Clip by extent
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRasterToolOpen("clip-mask")}>
                Clip by mask layer
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Raster to Vector
              </DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => setRasterToolOpen("polygonize")}
              >
                Polygonize
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setRasterToolOpen("contour")}>
                Contour
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={handleOpenPlanetaryComputerPanel}>
            Planetary Computer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggleEarthEnginePanel}>
            Earth Engine
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
            aria-label="Controls"
          >
            <SlidersHorizontal className={toolbarIconClassName} />
            {renderToolbarLabel("Controls")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Map controls</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {MAP_CONTROL_ITEMS.map((control) => (
            <DropdownMenuItem
              key={control.id}
              onClick={() => toggleMapControl(control.id)}
            >
              {control.label}
              {controlsVisible[control.id] ? " ✓" : ""}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem
            onClick={() => toggle(EFFECTS_PLUGIN_ID, appApi)}
          >
            Atmosphere Effects
            {isActive(EFFECTS_PLUGIN_ID) ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem
            title="Routing sends your waypoints to the public OSRM demo server (router.project-osrm.org)."
            onClick={handleToggleDirections}
          >
            Directions
            {isActive(DIRECTIONS_PLUGIN_ID) ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleToggleSearchPlacesPanel}>
            Search
            {searchPlacesVisible ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggleColorbarPanel}>
            Colorbar
            {colorbarPanelVisible ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggleLegendPanel}>
            Legend
            {legendPanelVisible ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggleHtmlPanel}>
            HTML
            {htmlPanelVisible ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggleMeasurePanel}>
            Measure
            {measurePanelVisible ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggleBookmarkPanel}>
            Bookmark
            {bookmarkPanelVisible ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggleMinimapPanel}>
            Minimap
            {minimapPanelVisible ? " ✓" : ""}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleToggleViewStatePanel}>
            View State
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
            aria-label="Plugins"
          >
            <Puzzle className={toolbarIconClassName} />
            {renderToolbarLabel("Plugins")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Activate plugin</DropdownMenuLabel>
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
                      {isActive(p.id) ? "Deactivate" : "Activate"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Position</DropdownMenuLabel>
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
                          {position.label}
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
              // toggle.
              if (p.id === EFFECTS_PLUGIN_ID || p.id === DIRECTIONS_PLUGIN_ID) {
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
                    Web Services
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
            aria-label="Help"
          >
            <CircleHelp className={toolbarIconClassName} />
            {renderToolbarLabel("Help")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Help</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onOpenDiagnostics}>
            <Bug className="mr-2 h-3.5 w-3.5" />
            Diagnostics
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
            Give feedback
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setAboutOpen(true);
              setCheckForUpdatesRequest((value) => value + 1);
            }}
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            Check for updates
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAboutOpen(true)}>
            <Info className="mr-2 h-3.5 w-3.5" />
            About
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
            <DialogTitle>Open project from URL</DialogTitle>
            <DialogDescription>
              Load a public `.geolibre.json` project and add it to recent
              projects.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={handleOpenFromUrl}>
            <div className="space-y-2">
              <Label htmlFor="project-url">Project URL</Label>
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
                Cancel
              </Button>
              <Button type="submit" disabled={projectUrlLoading}>
                {projectUrlLoading ? "Opening..." : "Open"}
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
            <DialogTitle>Something went wrong</DialogTitle>
            <DialogDescription>{actionError}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button onClick={() => setActionError(null)}>Dismiss</Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={directionsNoticeOpen}
        onOpenChange={setDirectionsNoticeOpen}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Directions uses a public routing server</DialogTitle>
            <DialogDescription>
              Turning on Directions sends the waypoints you place to the public
              OSRM demo server (router.project-osrm.org) to calculate routes —
              your coordinates leave your device for those requests. The demo
              server is rate-limited and supports driving only.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setDirectionsNoticeOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={confirmEnableDirections}>Continue</Button>
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
            <DialogTitle>Large OSM PBF file</DialogTitle>
            <DialogDescription>
              {`This file is about ${osmPbfConfirm?.sizeMb} MB. Parsing it converts every feature to GeoJSON in memory, which can be slow and may use a lot of memory in the browser. Continue?`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOsmPbfConfirm(null)}>
              Cancel
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
              Continue
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
            <DialogTitle>Add OSM PBF Layer</DialogTitle>
            <DialogDescription>
              Load an OpenStreetMap .osm.pbf file. It is parsed in your browser
              and split into separate point, line, and polygon layers.
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
              <Label htmlFor="osm-pbf-url">URL</Label>
              <Input
                id="osm-pbf-url"
                type="url"
                placeholder={DEFAULT_OSM_PBF_URL}
                value={osmPbfUrl}
                onChange={(e) => setOsmPbfUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Remote URLs load in the desktop app; in the browser the server
                must allow cross-origin requests (CORS).
              </p>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleChooseOsmPbfFile()}
              >
                Choose local file…
              </Button>
              <Button type="submit" disabled={!osmPbfUrl.trim()}>
                Load from URL
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
            <DialogTitle>Loading OSM PBF…</DialogTitle>
            <DialogDescription>
              Parsing the file and converting features to GeoJSON. This runs in
              the background and may take a moment for large extracts.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button variant="outline" onClick={cancelOsmPbf}>
              Cancel
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
      <div className="ml-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Button
          aria-label={
            themeMode === "dark"
              ? "Switch to light mode"
              : "Switch to dark mode"
          }
          className="h-7 w-7 shrink-0"
          onClick={onToggleThemeMode}
          size="icon"
          title={
            themeMode === "dark"
              ? "Switch to light mode"
              : "Switch to dark mode"
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
              aria-label="Project name"
              className="hidden h-7 w-44 border-transparent px-2 text-xs shadow-none focus-visible:border-input md:block"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              onBlur={(event) => {
                const nextName = event.target.value.trim();
                if (!nextName) setProjectName("Untitled Project");
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
