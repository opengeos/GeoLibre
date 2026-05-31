import {
  projectFromStore,
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
  openZarrLayerPanel,
  subscribeSearchPlacesPanel,
  type GeoLibreMapControlPosition,
} from "@geolibre/plugins";
import {
  Button,
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
} from "@geolibre/ui";
import {
  Database,
  FolderOpen,
  Layers,
  Map,
  Moon,
  Puzzle,
  Save,
  SlidersHorizontal,
  Sun,
  Wrench,
} from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { createAppAPI, usePluginRegistry } from "../../hooks/usePlugins";
import type { ThemeMode } from "../../hooks/useThemeMode";
import { openProjectFile, saveProjectFile } from "../../lib/tauri-io";
import { AddDataDialog, type AddDataKind } from "./AddDataDialog";
import { AboutDialog } from "./AboutDialog";
import { NewProjectDialog } from "./NewProjectDialog";

interface TopToolbarProps {
  mapControllerRef: React.RefObject<MapController | null>;
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

export function TopToolbar({
  mapControllerRef,
  themeMode,
  onToggleThemeMode,
}: TopToolbarProps) {
  const loadProject = useAppStore((s) => s.loadProject);
  const setProcessingOpen = useAppStore((s) => s.setProcessingOpen);
  const projectName = useAppStore((s) => s.projectName);
  const projectPath = useAppStore((s) => s.projectPath);
  const setProjectPath = useAppStore((s) => s.setProjectPath);
  const setProjectName = useAppStore((s) => s.setProjectName);
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

  const handleOpen = async () => {
    const result = await openProjectFile();
    if (result) loadProject(result.project, result.path);
  };

  const handleSave = async (): Promise<boolean> => {
    const state = useAppStore.getState();
    const defaultProjectName = state.projectName.trim() || "Untitled Project";
    const project = projectFromStore({
      projectName: defaultProjectName,
      mapView: mapControllerRef.current?.readView() ?? state.mapView,
      basemapStyleUrl: state.basemapStyleUrl,
      basemapVisible: state.basemapVisible,
      basemapOpacity: state.basemapOpacity,
      layers: state.layers,
      metadata: state.metadata,
    });
    const content = serializeProject(project);
    const path = await saveProjectFile(
      content,
      state.projectPath ?? `${defaultProjectName}.geolibre.json`,
    );
    if (!path) return false;
    setProjectPath(path);
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
  const toggleMapControl = (control: ToolbarMapControl) => {
    setControlsVisible((current) => {
      const visible = !current[control];
      const updated =
        mapControllerRef.current?.setBuiltInControlVisible(control, visible) ??
        false;
      return updated ? { ...current, [control]: visible } : current;
    });
  };

  return (
    <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-1 border-b bg-card px-2 py-1 md:flex-nowrap">
      <span className="mr-1 flex shrink-0 items-center gap-1.5 text-sm font-semibold text-primary md:mr-2">
        <Map className="h-4 w-4" />
        <span className="hidden sm:inline">GeoLibre Desktop</span>
      </span>
      <NewProjectDialog onSaveCurrentProject={handleSave} />
      <Button variant="ghost" size="sm" onClick={handleOpen} aria-label="Open">
        <FolderOpen className="h-3.5 w-3.5 sm:mr-1" />
        <span className="hidden sm:inline">Open</span>
      </Button>
      <Button variant="ghost" size="sm" onClick={handleSave} aria-label="Save">
        <Save className="h-3.5 w-3.5 sm:mr-1" />
        <span className="hidden sm:inline">Save</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Add Data">
            <Database className="h-3.5 w-3.5 sm:mr-1" />
            <span className="hidden sm:inline">Add Data</span>
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
          <DropdownMenuItem onSelect={handleAddStacLayer}>
            Add STAC Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddDuckDBLayer}>
            Add DuckDB Layer
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAddDataKind("postgres")}>
            Add PostgreSQL Layer
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setProcessingOpen(true)}
        aria-label="Processing"
      >
        <Wrench className="h-3.5 w-3.5 sm:mr-1" />
        <span className="hidden sm:inline">Processing</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Controls">
            <SlidersHorizontal className="h-3.5 w-3.5 sm:mr-1" />
            <span className="hidden sm:inline">Controls</span>
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
          <Button variant="ghost" size="sm" aria-label="Plugins">
            <Puzzle className="h-3.5 w-3.5 sm:mr-1" />
            <span className="hidden sm:inline">Plugins</span>
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
      <AddDataDialog
        kind={addDataKind}
        mapControllerRef={mapControllerRef}
        onOpenChange={(open) => {
          if (!open) setAddDataKind(null);
        }}
      />
      <AboutDialog />
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
      </div>
    </header>
  );
}
