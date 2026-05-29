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
  type GeoLibreLayer,
  type GeoLibreProject,
  type LayerStyle,
  type MapViewState,
  type RecentProjectEntry,
} from "./types";

export interface AppState {
  projectName: string;
  projectPath: string | null;
  isDirty: boolean;
  mapView: MapViewState;
  basemapStyleUrl: string;
  layers: GeoLibreLayer[];
  selectedLayerId: string | null;
  selectedFeatureId: string | null;
  pointerCoords: [number, number] | null;
  metadata: Record<string, unknown>;
  recentProjects: RecentProjectEntry[];
  attributeFilter: string;
  ui: {
    processingOpen: boolean;
    attributeTableOpen: boolean;
  };

  setPointerCoords: (coords: [number, number] | null) => void;
  setMapView: (view: Partial<MapViewState>, markDirty?: boolean) => void;
  setBasemapStyleUrl: (url: string) => void;
  selectLayer: (id: string | null) => void;
  selectFeature: (id: string | null) => void;
  setAttributeFilter: (filter: string) => void;
  setProcessingOpen: (open: boolean) => void;
  setAttributeTableOpen: (open: boolean) => void;

  newProject: (options?: CreateProjectOptions & { name?: string }) => void;
  loadProject: (project: GeoLibreProject, path?: string | null) => void;
  setProjectPath: (path: string | null) => void;
  setProjectName: (name: string) => void;
  markSaved: () => void;

  addLayer: (layer: GeoLibreLayer) => void;
  removeLayer: (id: string) => void;
  updateLayer: (id: string, patch: Partial<GeoLibreLayer>) => void;
  setLayerVisibility: (id: string, visible: boolean) => void;
  setLayerOpacity: (id: string, opacity: number) => void;
  setLayerStyle: (id: string, style: Partial<LayerStyle>) => void;
  reorderLayer: (id: string, direction: "up" | "down") => void;
  addGeoJsonLayer: (
    name: string,
    geojson: FeatureCollection,
    sourcePath?: string,
  ) => string;
}

export const useAppStore = create<AppState>((set, get) => ({
  projectName: "Untitled Project",
  projectPath: null,
  isDirty: false,
  mapView: createDefaultMapView(),
  basemapStyleUrl: DEFAULT_BASEMAP,
  layers: [],
  selectedLayerId: null,
  selectedFeatureId: null,
  pointerCoords: null,
  metadata: {},
  recentProjects: [],
  attributeFilter: "",
  ui: {
    processingOpen: false,
    attributeTableOpen: false,
  },

  setPointerCoords: (coords) => set({ pointerCoords: coords }),
  setMapView: (view, markDirty = false) =>
    set((s) => ({
      mapView: { ...s.mapView, ...view },
      isDirty: markDirty || s.isDirty,
    })),
  setBasemapStyleUrl: (url) => set({ basemapStyleUrl: url, isDirty: true }),
  selectLayer: (id) => set({ selectedLayerId: id, selectedFeatureId: null }),
  selectFeature: (id) => set({ selectedFeatureId: id }),
  setAttributeFilter: (filter) => set({ attributeFilter: filter }),
  setProcessingOpen: (open) =>
    set((s) => ({ ui: { ...s.ui, processingOpen: open } })),
  setAttributeTableOpen: (open) =>
    set((s) => ({ ui: { ...s.ui, attributeTableOpen: open } })),

  newProject: (options = {}) => {
    const project = createEmptyProject(options.name, options);
    const applied = applyProjectToStore(project);
    set({
      ...applied,
      projectPath: null,
      isDirty: false,
      selectedLayerId: null,
      selectedFeatureId: null,
      pointerCoords: null,
      attributeFilter: "",
    });
  },

  loadProject: (project, path = null) => {
    const applied = applyProjectToStore(project);
    set({
      ...applied,
      projectPath: path,
      isDirty: false,
      selectedLayerId: applied.layers[0]?.id ?? null,
      selectedFeatureId: null,
    });
    if (path) {
      const entry: RecentProjectEntry = {
        path,
        name: project.name,
        openedAt: new Date().toISOString(),
      };
      set((s) => ({
        recentProjects: [
          entry,
          ...s.recentProjects.filter((r) => r.path !== path),
        ].slice(0, 10),
      }));
    }
  },

  setProjectPath: (path) => set({ projectPath: path }),
  setProjectName: (name) => set({ projectName: name, isDirty: true }),
  markSaved: () => set({ isDirty: false }),

  addLayer: (layer) =>
    set((s) => ({
      layers: [...s.layers, layer],
      selectedLayerId: layer.id,
      isDirty: true,
    })),

  removeLayer: (id) =>
    set((s) => ({
      layers: s.layers.filter((l) => l.id !== id),
      selectedLayerId:
        s.selectedLayerId === id
          ? (s.layers.find((l) => l.id !== id)?.id ?? null)
          : s.selectedLayerId,
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

  addGeoJsonLayer: (name, geojson, sourcePath) => {
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
    get().addLayer(layer);
    return id;
  },
}));
