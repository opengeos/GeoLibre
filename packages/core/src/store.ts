import type { FeatureCollection } from "geojson";
import { v4 as uuidv4 } from "uuid";
import { create } from "zustand";
import {
  applyProjectToStore,
  type CreateProjectOptions,
  createDefaultMapView,
  createEmptyProject,
} from "./project";
import {
  DEFAULT_BASEMAP,
  DEFAULT_LAYER_STYLE,
  DEFAULT_PROJECT_PREFERENCES,
  type GeoLibreLayer,
  type GeoLibreProject,
  type LayerStyle,
  type MapViewState,
  type ProjectPluginState,
  type ProjectPreferences,
  type RecentProjectEntry,
} from "./types";

export interface AppState {
  projectName: string;
  projectPath: string | null;
  projectGeneration: number;
  isDirty: boolean;
  mapView: MapViewState;
  basemapStyleUrl: string;
  basemapVisible: boolean;
  basemapOpacity: number;
  layers: GeoLibreLayer[];
  preferences: ProjectPreferences;
  projectPlugins: ProjectPluginState | null;
  selectedLayerId: string | null;
  selectedFeatureId: string | null;
  identifyLayerId: string | null;
  pointerCoords: [number, number] | null;
  metadata: Record<string, unknown>;
  recentProjects: RecentProjectEntry[];
  attributeFilter: string;
  ui: {
    processingOpen: boolean;
    attributeTableOpen: boolean;
    zoomToSelectedFeature: boolean;
  };

  setPointerCoords: (coords: [number, number] | null) => void;
  setMapView: (view: Partial<MapViewState>, markDirty?: boolean) => void;
  setBasemapStyleUrl: (url: string) => void;
  setBasemapVisible: (visible: boolean) => void;
  setBasemapOpacity: (opacity: number) => void;
  setPreferences: (preferences: ProjectPreferences) => void;
  setProjectPlugins: (
    projectPlugins: ProjectPluginState | null,
    shouldMarkDirty?: boolean,
  ) => void;
  selectLayer: (id: string | null) => void;
  selectFeature: (id: string | null) => void;
  setIdentifyLayer: (id: string | null) => void;
  setAttributeFilter: (filter: string) => void;
  setProcessingOpen: (open: boolean) => void;
  setAttributeTableOpen: (open: boolean) => void;
  setZoomToSelectedFeature: (enabled: boolean) => void;

  newProject: (options?: CreateProjectOptions & { name?: string }) => void;
  loadProject: (
    project: GeoLibreProject,
    path?: string | null,
    options?: { rememberRecent?: boolean },
  ) => void;
  setProjectPath: (path: string | null) => void;
  setProjectName: (name: string) => void;
  setRecentProjects: (projects: RecentProjectEntry[]) => void;
  rememberRecentProject: (entry: RecentProjectEntry) => void;
  forgetRecentProject: (path: string) => void;
  clearRecentProjects: () => void;
  markSaved: () => void;

  addLayer: (layer: GeoLibreLayer, beforeLayerId?: string | null) => void;
  removeLayer: (id: string) => void;
  updateLayer: (id: string, patch: Partial<GeoLibreLayer>) => void;
  setLayerVisibility: (id: string, visible: boolean) => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  setLayerStyle: (id: string, style: Partial<LayerStyle>) => void;
  reorderLayer: (id: string, direction: "up" | "down") => void;
  moveLayer: (id: string, targetIndex: number) => void;
  addGeoJsonLayer: (
    name: string,
    geojson: FeatureCollection,
    sourcePath?: string,
    beforeLayerId?: string | null,
  ) => string;
}

const MAX_RECENT_PROJECTS = 10;

/** Derive a human-friendly display name from a file path or URL. */
export function projectPathLabel(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function normalizeRecentProjects(
  projects: RecentProjectEntry[],
): RecentProjectEntry[] {
  const seen = new Set<string>();
  const normalized: RecentProjectEntry[] = [];

  for (const project of projects) {
    const path = project.path.trim();
    if (!path || seen.has(path)) continue;

    const name = project.name.trim() || projectPathLabel(path);
    normalized.push({
      path,
      name,
      openedAt: project.openedAt || new Date().toISOString(),
    });
    seen.add(path);
  }

  return normalized.slice(0, MAX_RECENT_PROJECTS);
}

export const useAppStore = create<AppState>((set, get) => ({
  projectName: "Untitled Project",
  projectPath: null,
  projectGeneration: 0,
  isDirty: false,
  mapView: createDefaultMapView(),
  basemapStyleUrl: DEFAULT_BASEMAP,
  basemapVisible: true,
  basemapOpacity: 1,
  layers: [],
  preferences: DEFAULT_PROJECT_PREFERENCES,
  projectPlugins: null,
  selectedLayerId: null,
  selectedFeatureId: null,
  identifyLayerId: null,
  pointerCoords: null,
  metadata: {},
  recentProjects: [],
  attributeFilter: "",
  ui: {
    processingOpen: false,
    attributeTableOpen: false,
    zoomToSelectedFeature: false,
  },

  setPointerCoords: (coords) => set({ pointerCoords: coords }),
  setMapView: (view, markDirty = false) =>
    set((s) => ({
      mapView: { ...s.mapView, ...view },
      isDirty: markDirty || s.isDirty,
    })),
  setBasemapStyleUrl: (url) => set({ basemapStyleUrl: url, isDirty: true }),
  setBasemapVisible: (visible) =>
    set({ basemapVisible: visible, isDirty: true }),
  setBasemapOpacity: (opacity) =>
    set({ basemapOpacity: opacity, isDirty: true }),
  setPreferences: (preferences) => set({ preferences, isDirty: true }),
  // When shouldMarkDirty is false the existing dirty flag is preserved rather
  // than set; it cannot clear the flag (only markSaved() does that).
  setProjectPlugins: (projectPlugins, shouldMarkDirty = true) =>
    set((s) => ({
      projectPlugins,
      isDirty: shouldMarkDirty || s.isDirty,
    })),
  selectLayer: (id) => set({ selectedLayerId: id, selectedFeatureId: null }),
  selectFeature: (id) => set({ selectedFeatureId: id }),
  setIdentifyLayer: (id) => set({ identifyLayerId: id }),
  setAttributeFilter: (filter) => set({ attributeFilter: filter }),
  setProcessingOpen: (open) =>
    set((s) => ({ ui: { ...s.ui, processingOpen: open } })),
  setAttributeTableOpen: (open) =>
    set((s) => ({ ui: { ...s.ui, attributeTableOpen: open } })),
  setZoomToSelectedFeature: (enabled) =>
    set((s) => ({ ui: { ...s.ui, zoomToSelectedFeature: enabled } })),

  newProject: (options = {}) => {
    const project = createEmptyProject(options.name, options);
    const applied = applyProjectToStore(project);
    set((s) => ({
      ...applied,
      projectPath: null,
      projectGeneration: s.projectGeneration + 1,
      isDirty: false,
      selectedLayerId: null,
      selectedFeatureId: null,
      identifyLayerId: null,
      pointerCoords: null,
      attributeFilter: "",
    }));
  },

  loadProject: (project, path = null, options = {}) => {
    const applied = applyProjectToStore(project);
    set((s) => ({
      ...applied,
      projectPath: path,
      projectGeneration: s.projectGeneration + 1,
      isDirty: false,
      selectedLayerId: applied.layers[0]?.id ?? null,
      selectedFeatureId: null,
      identifyLayerId: null,
    }));
    if (path && options.rememberRecent !== false) {
      get().rememberRecentProject({
        path,
        name: project.name,
        openedAt: new Date().toISOString(),
      });
    }
  },

  setProjectPath: (path) => set({ projectPath: path }),
  setProjectName: (name) => set({ projectName: name, isDirty: true }),
  setRecentProjects: (projects) =>
    set({ recentProjects: normalizeRecentProjects(projects) }),
  rememberRecentProject: (entry) =>
    set((s) => ({
      recentProjects: normalizeRecentProjects([entry, ...s.recentProjects]),
    })),
  forgetRecentProject: (path) => {
    // Compare with separators normalized so a backslash/forward-slash mismatch
    // on Windows does not leave a stale entry behind.
    const normalized = path.replace(/\\/g, "/");
    set((s) => ({
      recentProjects: s.recentProjects.filter(
        (project) => project.path.replace(/\\/g, "/") !== normalized,
      ),
    }));
  },
  clearRecentProjects: () => set({ recentProjects: [] }),
  markSaved: () => set({ isDirty: false }),

  addLayer: (layer, beforeLayerId = null) =>
    set((s) => {
      const layers = [...s.layers];
      const beforeIndex = beforeLayerId
        ? layers.findIndex((l) => l.id === beforeLayerId)
        : -1;
      const layerWithBeforeId =
        beforeLayerId && beforeIndex < 0
          ? { ...layer, beforeId: beforeLayerId }
          : { ...layer, beforeId: layer.beforeId };
      if (beforeIndex >= 0) {
        layers.splice(beforeIndex, 0, layerWithBeforeId);
      } else {
        layers.push(layerWithBeforeId);
      }
      return {
        layers,
        selectedLayerId: layer.id,
        isDirty: true,
      };
    }),

  removeLayer: (id) =>
    set((s) => ({
      layers: s.layers.filter((l) => l.id !== id),
      selectedLayerId:
        s.selectedLayerId === id
          ? (s.layers.find((l) => l.id !== id)?.id ?? null)
          : s.selectedLayerId,
      selectedFeatureId: s.selectedLayerId === id ? null : s.selectedFeatureId,
      identifyLayerId: s.identifyLayerId === id ? null : s.identifyLayerId,
      isDirty: true,
    })),

  updateLayer: (id, patch) =>
    set((s) => ({
      layers: s.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
      isDirty: true,
    })),

  setLayerVisibility: (id, visible) =>
    get().updateLayer(id, { visible }),

  setLayerOpacity: (id, opacity) =>
    get().updateLayer(id, { opacity }),

  setLayerStyle: (id, style) =>
    set((s) => ({
      layers: s.layers.map((l) =>
        l.id === id ? { ...l, style: { ...l.style, ...style } } : l,
      ),
      isDirty: true,
    })),

  reorderLayer: (id, direction) =>
    set((s) => {
      const idx = s.layers.findIndex((l) => l.id === id);
      if (idx < 0) return s;
      const target = direction === "up" ? idx + 1 : idx - 1;
      if (target < 0 || target >= s.layers.length) return s;
      const next = [...s.layers];
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return { layers: next, isDirty: true };
    }),

  moveLayer: (id, targetIndex) =>
    set((s) => {
      const currentIndex = s.layers.findIndex((layer) => layer.id === id);
      if (currentIndex < 0) return s;
      const next = [...s.layers];
      const [layer] = next.splice(currentIndex, 1);
      const nextIndex = Math.min(Math.max(targetIndex, 0), next.length);
      next.splice(nextIndex, 0, layer);
      if (next.every((item, index) => item.id === s.layers[index]?.id)) {
        return s;
      }
      return { layers: next, isDirty: true };
    }),

  addGeoJsonLayer: (name, geojson, sourcePath, beforeLayerId = null) => {
    const id = uuidv4();
    const layer: GeoLibreLayer = {
      id,
      name,
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
      geojson,
      sourcePath,
    };
    get().addLayer(layer, beforeLayerId);
    return id;
  },
}));
