import {
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
  closeSearchPlacesPanel,
  openFlatGeobufAddVectorLayerPanel,
  openDuckDBLayerPanel,
  openGeoParquetLayerPanel,
  isSearchPlacesPanelVisible,
  openLidarLayerPanel,
  openPMTilesLayerPanel,
  openSearchPlacesPanel,
  openSplattingLayerPanel,
  openStacSearchLayerPanel,
  openThreeDTilesLayerPanel,
  openZarrLayerPanel,
  subscribeSearchPlacesPanel,
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
  Database,
  FolderOpen,
  History,
  Layers,
  Link2,
  Map,
  Moon,
  Puzzle,
  Save,
  SlidersHorizontal,
  Sun,
  Wrench,
  X,
} from "lucide-react";
import { type FormEvent, useRef, useState, useSyncExternalStore } from "react";
import {
  createAppAPI,
  getPluginManager,
  usePluginRegistry,
} from "../../hooks/usePlugins";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import type { ThemeMode } from "../../hooks/useThemeMode";
import {
  isTauri,
  openProjectFile,
  openRecentProjectFile,
  RecentProjectGoneError,
  saveProjectFile,
} from "../../lib/tauri-io";
import { mergeStringLists } from "../../lib/string-lists";
import { normalizeProjectUrl } from "../../lib/urls";
import { resolveProjectXyzLayers } from "../../lib/xyz-url";
import { AddDataDialog, type AddDataKind } from "./AddDataDialog";
import { AboutDialog } from "./AboutDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { SettingsDialog } from "./SettingsDialog";

interface TopToolbarProps {
  compact?: boolean;
  mapControllerRef: React.RefObject<MapController | null>;
  showLabels?: boolean;
  showProjectInfo?: boolean;
  themeMode: ThemeMode;
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

const PLUGIN_POSITION_ITEMS: Array<{
  value: GeoLibreMapControlPosition;
  label: string;
}> = [
  { value: "top-left", label: "Top left" },
  { value: "top-right", label: "Top right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-right", label: "Bottom right" },
];

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

export function TopToolbar({
  compact = false,
  mapControllerRef,
  showLabels = true,
  showProjectInfo = true,
  themeMode,
  onToggleThemeMode,
}: TopToolbarProps) {
  const loadProject = useAppStore((s) => s.loadProject);
  const setProcessingOpen = useAppStore((s) => s.setProcessingOpen);
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
  const [projectUrlDialogOpen, setProjectUrlDialogOpen] = useState(false);
  const [projectUrl, setProjectUrl] = useState("");
  const [projectUrlError, setProjectUrlError] = useState<string | null>(null);
  const [projectUrlLoading, setProjectUrlLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
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

  const handleSave = async (): Promise<boolean> => {
    const state = useAppStore.getState();
    const defaultProjectName = state.projectName.trim() || "Untitled Project";
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
    const content = serializeProject(project);
    const path = await saveProjectFile(
      content,
      state.projectPath ?? `${defaultProjectName}.geolibre.json`,
    );
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

  const {
    plugins,
    isActive,
    getMapControlPosition,
    toggle,
    setMapControlPosition,
  } = usePluginRegistry();
  const appApi = createAppAPI(mapControllerRef);
  const handleAddFlatGeobufLayer = () => {
    openFlatGeobufAddVectorLayerPanel(appApi);
  };
  const handleAddDuckDBLayer = () => {
    openDuckDBLayerPanel(appApi);
  };
  const handleAddGeoParquetLayer = () => {
    openGeoParquetLayerPanel(appApi);
  };
  const handleAddPMTilesLayer = () => {
    openPMTilesLayerPanel(appApi);
  };
  const handleAddStacLayer = () => {
    openStacSearchLayerPanel(appApi);
  };
  const searchPlacesVisible = useSyncExternalStore(
    subscribeSearchPlacesPanel,
    isSearchPlacesPanelVisible,
    isSearchPlacesPanelVisible,
  );
  const handleToggleSearchPlaces = () => {
    if (searchPlacesVisible) {
      closeSearchPlacesPanel();
      return;
    }
    openSearchPlacesPanel(appApi);
  };
  const handleAddZarrLayer = () => {
    openZarrLayerPanel(appApi);
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
          <span className="hidden sm:inline">GeoLibre Desktop</span>
        ) : null}
      </span>
      <NewProjectDialog
        buttonClassName={toolbarButtonClass}
        buttonSize={toolbarButtonSize}
        iconClassName={toolbarIconClassName}
        showLabels={showLabels}
        onSaveCurrentProject={handleSave}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className={toolbarButtonClass}
            variant="ghost"
            size={toolbarButtonSize}
            aria-label="Open"
          >
            <FolderOpen className={toolbarIconClassName} />
            {renderToolbarLabel("Open")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          <DropdownMenuLabel>Project</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void handleOpenFromFile()}>
            <FolderOpen className="mr-2 h-3.5 w-3.5" />
            Open Project from File...
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setProjectUrlDialogOpen(true)}>
            <Link2 className="mr-2 h-3.5 w-3.5" />
            Open Project from URL...
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Recent projects</DropdownMenuLabel>
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
                >
                  <span className="flex min-w-0 flex-col items-start gap-0.5">
                    <span className="max-w-full truncate font-medium">
                      {label}
                    </span>
                    <span className="flex max-w-full items-center gap-1 text-xs text-muted-foreground">
                      <History className="h-3 w-3 shrink-0" />
                      <span className="truncate">
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
                      // Keep the menu open and prevent the row's onSelect (which
                      // would reopen the project) from firing.
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
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        className={toolbarButtonClass}
        variant="ghost"
        size={toolbarButtonSize}
        onClick={handleSave}
        aria-label="Save"
      >
        <Save className={toolbarIconClassName} />
        {renderToolbarLabel("Save")}
      </Button>
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
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Add data</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setAddDataKind("xyz")}>
            Add XYZ Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("wms")}>
            Add WMS Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("wfs")}>
            Add WFS Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("wmts")}>
            Add WMTS Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("vector")}>
            Add Vector Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("raster")}>
            Add Raster Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddGeoParquetLayer}>
            Add GeoParquet Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddFlatGeobufLayer}>
            Add FlatGeobuf Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddPMTilesLayer}>
            Add PMTiles Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("mbtiles")}>
            Add MBTiles Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("arcgis")}>
            Add ArcGIS Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddZarrLayer}>
            Add Zarr Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddLidarLayer}>
            Add LiDAR Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddSplattingLayer}>
            Add Splatting Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddThreeDTilesLayer}>
            Add 3D Tiles Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddStacLayer}>
            Add STAC Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddDuckDBLayer}>
            Add DuckDB Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("postgres")}>
            Add PostgreSQL Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("delimited-text")}>
            Add Delimited Text Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("gpx")}>
            Add GPX Layer
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
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Whitebox</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => setProcessingOpen(true)}>
                Toolbox
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
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
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleToggleSearchPlaces}>
            Search
            {searchPlacesVisible ? " ✓" : ""}
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
          {plugins.map((p) => {
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
                        onSelect={(event) => event.preventDefault()}
                      >
                        {position.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <SettingsDialog
        buttonClassName={toolbarButtonClass}
        buttonSize={toolbarButtonSize}
        iconClassName={toolbarIconClassName}
        mapControllerRef={mapControllerRef}
        showLabels={showLabels}
      />
      <AddDataDialog
        kind={addDataKind}
        mapControllerRef={mapControllerRef}
        onOpenChange={(open) => {
          if (!open) setAddDataKind(null);
        }}
      />
      <Dialog
        open={projectUrlDialogOpen}
        onOpenChange={(open) => {
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
        onOpenChange={(open) => {
          if (!open) setActionError(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Could not open project</DialogTitle>
            <DialogDescription>{actionError}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button onClick={() => setActionError(null)}>Dismiss</Button>
          </div>
        </DialogContent>
      </Dialog>
      <AboutDialog
        buttonClassName={toolbarButtonClass}
        buttonSize={toolbarButtonSize}
        iconClassName={toolbarIconClassName}
        showLabels={showLabels}
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
              <span className="hidden truncate lg:inline">{projectPath}</span>
            ) : null}
          </>
        ) : null}
      </div>
    </header>
  );
}
