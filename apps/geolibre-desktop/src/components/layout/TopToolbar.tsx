import { projectFromStore, serializeProject, useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import {
  FileJson,
  FolderOpen,
  Layers,
  Map,
  Puzzle,
  Save,
  Wrench,
} from "lucide-react";
import { createAppAPI, getPluginManager } from "../../hooks/usePlugins";
import {
  openGeoJsonFileWithFallback,
  openProjectFile,
  saveProjectFile,
} from "../../lib/tauri-io";

interface TopToolbarProps {
  mapControllerRef: React.RefObject<MapController | null>;
}

export function TopToolbar({ mapControllerRef }: TopToolbarProps) {
  const newProject = useAppStore((s) => s.newProject);
  const loadProject = useAppStore((s) => s.loadProject);
  const addGeoJsonLayer = useAppStore((s) => s.addGeoJsonLayer);
  const setProcessingOpen = useAppStore((s) => s.setProcessingOpen);
  const projectName = useAppStore((s) => s.projectName);
  const projectPath = useAppStore((s) => s.projectPath);
  const setProjectPath = useAppStore((s) => s.setProjectPath);

  const handleNew = () => newProject();

  const handleOpen = async () => {
    const result = await openProjectFile();
    if (result) loadProject(result.project, result.path);
  };

  const handleSave = async () => {
    const state = useAppStore.getState();
    const project = projectFromStore({
      projectName: state.projectName,
      mapView: mapControllerRef.current?.readView() ?? state.mapView,
      basemapStyleUrl: state.basemapStyleUrl,
      layers: state.layers,
      metadata: state.metadata,
    });
    const content = serializeProject(project);
    const path = await saveProjectFile(
      content,
      projectPath ?? `${projectName}.geolibre.json`,
    );
    if (path) setProjectPath(path);
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

  const plugins = getPluginManager().list();
  const appApi = createAppAPI();

  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b bg-card px-2">
      <span className="mr-2 flex items-center gap-1.5 text-sm font-semibold text-primary">
        <Map className="h-4 w-4" />
        GeoLibre Desktop
      </span>
      <Button variant="ghost" size="sm" onClick={handleNew}>
        New
      </Button>
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
            <Puzzle className="mr-1 h-3.5 w-3.5" />
            Plugins
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Activate plugin</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {plugins.map((p) => (
            <DropdownMenuItem
              key={p.id}
              onClick={() => getPluginManager().toggle(p.id, appApi)}
            >
              {p.name}
              {getPluginManager().isActive(p.id) ? " ✓" : ""}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="ml-auto truncate text-xs text-muted-foreground">
        <Layers className="mr-1 inline h-3 w-3" />
        {projectName}
        {projectPath ? ` — ${projectPath}` : ""}
      </span>
    </header>
  );
}
