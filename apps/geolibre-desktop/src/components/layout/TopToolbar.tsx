import { projectFromStore, serializeProject, useAppStore } from "@geolibre/core";
import {
  type BuiltInMapControl,
  DEFAULT_BUILT_IN_CONTROL_VISIBILITY,
  type MapController,
} from "@geolibre/map";
import type { GeoLibreMapControlPosition } from "@geolibre/plugins";
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
  FileJson,
  FolderOpen,
  Layers,
  Map,
  Puzzle,
  Save,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { createAppAPI, usePluginRegistry } from "../../hooks/usePlugins";
import {
  openGeoJsonFileWithFallback,
  openProjectFile,
  saveProjectFile,
} from "../../lib/tauri-io";
import { NewProjectDialog } from "./NewProjectDialog";

interface TopToolbarProps {
  mapControllerRef: React.RefObject<MapController | null>;
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

export function TopToolbar({ mapControllerRef }: TopToolbarProps) {
  const loadProject = useAppStore((s) => s.loadProject);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
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

  const handleAddGeoJson = async () => {
    const result = await openGeoJsonFileWithFallback();
    if (!result) return;
    const name =
      result.path.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") ?? "Layer";
    addGeoJsonLayer(name, result.data, result.path);
    const layer = useAppStore
      .getState()
      .layers.find((l) => l.sourcePath === result.path);
    if (layer) mapControllerRef.current?.fitLayer(layer);
  };

  const {
    plugins,
    isActive,
    getMapControlPosition,
    toggle,
    setMapControlPosition,
  } = usePluginRegistry();
  const appApi = createAppAPI(mapControllerRef);
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
    <header className="flex h-11 shrink-0 items-center gap-1 border-b bg-card px-2">
      <span className="mr-2 flex items-center gap-1.5 text-sm font-semibold text-primary">
        <Map className="h-4 w-4" />
        GeoLibre Desktop
      </span>
      <NewProjectDialog onSaveCurrentProject={handleSave} />
      <Button variant="ghost" size="sm" onClick={handleOpen}>
        <FolderOpen className="mr-1 h-3.5 w-3.5" />
        Open
      </Button>
      <Button variant="ghost" size="sm" onClick={handleSave}>
        <Save className="mr-1 h-3.5 w-3.5" />
        Save
      </Button>
      <Button variant="ghost" size="sm" onClick={handleAddGeoJson}>
        <FileJson className="mr-1 h-3.5 w-3.5" />
        Add GeoJSON
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setProcessingOpen(true)}
      >
        <Wrench className="mr-1 h-3.5 w-3.5" />
        Processing
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">
            <SlidersHorizontal className="mr-1 h-3.5 w-3.5" />
            Controls
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
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm">
            <Puzzle className="mr-1 h-3.5 w-3.5" />
            Plugins
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
      <div className="ml-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Layers className="mr-1 inline h-3 w-3" />
        <Input
          aria-label="Project name"
          className="h-7 w-44 border-transparent px-2 text-xs shadow-none focus-visible:border-input"
          value={projectName}
          onChange={(event) => setProjectName(event.target.value)}
          onBlur={(event) => {
            const nextName = event.target.value.trim();
            if (!nextName) setProjectName("Untitled Project");
          }}
        />
        {projectPath ? (
          <span className="truncate">{projectPath}</span>
        ) : null}
      </div>
    </header>
  );
}
