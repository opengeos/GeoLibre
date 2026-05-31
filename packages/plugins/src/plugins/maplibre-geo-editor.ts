import { type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type maplibregl from "maplibre-gl";
import {
  GeoEditor,
  type DrawMode,
  type EditMode,
  type GeoEditorOptions,
} from "maplibre-gl-geo-editor";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

const SKETCHES_LAYER_NAME = "Sketches";
const SKETCHES_SOURCE_KIND = "geoeditor-sketches";
const SKETCHES_SOURCE_PATH = "geoeditor://sketches";

let geoEditorPosition: GeoLibreMapControlPosition = "top-left";

const GEO_EDITOR_OPTIONS = {
  collapsed: false,
  toolbarOrientation: "vertical",
  columns: 2,
  drawModes: ["polygon", "line", "rectangle", "circle", "marker", "freehand"],
  editModes: [
    "select",
    "drag",
    "change",
    "rotate",
    "cut",
    "delete",
    "scale",
    "copy",
    "split",
    "union",
    "difference",
    "simplify",
    "lasso",
  ],
  fileModes: ["open", "save"],
  hideGeomanControl: true,
  showFeatureProperties: true,
  fitBoundsOnLoad: true,
} satisfies Omit<
  GeoEditorOptions,
  | "position"
  | "onFeatureCreate"
  | "onFeatureEdit"
  | "onFeatureDelete"
  | "onGeoJsonLoad"
  | "onAttributeChange"
  | "onHistoryChange"
  | "onModeChange"
>;

let geoEditorControl: GeoEditor | null = null;
let sketchesLayerId: string | null = null;
let geoEditorStoreUnsubscribe: (() => void) | null = null;
let pluginActive = false;
let restoringSketchesToEditor = false;
let appApi: GeoLibreAppAPI | null = null;
let currentGeoEditorMode: DrawMode | EditMode | null = null;
let sketchesLayerDisplaySuppressed = false;

export const maplibreGeoEditorPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-geo-editor",
  name: "GeoEditor",
  version: "0.7.3",
  activate: (app: GeoLibreAppAPI) => {
    pluginActive = true;
    appApi = app;

    if (!geoEditorControl) {
      geoEditorControl = new GeoEditor(getGeoEditorOptions());
    }

    const added = app.addMapControl(geoEditorControl, geoEditorPosition);
    if (!added) {
      geoEditorControl = null;
      return false;
    }

    bindSketchesStoreSync();
    restoreSketchesLayerToEditor();
    setTimeout(() => geoEditorControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    pluginActive = false;
    currentGeoEditorMode = null;
    setSketchesStoreLayerSuppressed(false);
    showGeomanDisplayLayers();
    appApi = null;
    teardownSketchesStoreSync();

    if (!geoEditorControl) return;
    app.removeMapControl(geoEditorControl);
    geoEditorControl = null;
  },
  getMapControlPosition: () => geoEditorPosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    geoEditorPosition = position;
    if (!geoEditorControl) return;
    app.removeMapControl(geoEditorControl);
    const added = app.addMapControl(geoEditorControl, geoEditorPosition);
    if (!added) return false;
    setTimeout(() => geoEditorControl?.expand(), 0);
  },
};

function getGeoEditorOptions(): GeoEditorOptions {
  return {
    ...GEO_EDITOR_OPTIONS,
    position: geoEditorPosition,
    onFeatureCreate: () => syncSketchesToStore(),
    onFeatureEdit: () => syncSketchesToStore(),
    onFeatureDelete: () => syncSketchesToStore(),
    onGeoJsonLoad: () => {
      if (!restoringSketchesToEditor) {
        syncSketchesToStore();
      }
    },
    onAttributeChange: () => syncSketchesToStore(),
    onHistoryChange: () => syncSketchesToStore(),
    onModeChange: (mode) => {
      currentGeoEditorMode = mode;
      updateSketchesDisplayForMode();
    },
  };
}

function isSketchesLayer(layer: GeoLibreLayer): boolean {
  return layer.metadata.sourceKind === SKETCHES_SOURCE_KIND;
}

function findSketchesLayer(
  layers: GeoLibreLayer[],
): GeoLibreLayer | undefined {
  if (sketchesLayerId) {
    const tracked = layers.find((layer) => layer.id === sketchesLayerId);
    if (tracked) return tracked;
  }
  return layers.find(isSketchesLayer);
}

function cloneFeatureCollection(
  collection: FeatureCollection,
): FeatureCollection {
  return structuredClone(collection);
}

function syncSketchesToStore(): void {
  if (!geoEditorControl || restoringSketchesToEditor) return;

  const collection = cloneFeatureCollection(
    geoEditorControl.getAllFeatureCollection(),
  );
  const store = useAppStore.getState();
  const existing = findSketchesLayer(store.layers);

  if (existing) {
    sketchesLayerId = existing.id;
    store.updateLayer(existing.id, { geojson: collection });
    updateSketchesDisplayForMode();
    return;
  }

  if (collection.features.length === 0) {
    updateSketchesDisplayForMode();
    return;
  }

  const id = store.addGeoJsonLayer(
    SKETCHES_LAYER_NAME,
    collection,
    SKETCHES_SOURCE_PATH,
  );
  sketchesLayerId = id;
  store.updateLayer(id, {
    metadata: {
      ...store.layers.find((layer) => layer.id === id)?.metadata,
      sourceKind: SKETCHES_SOURCE_KIND,
    },
  });
  updateSketchesDisplayForMode();
}

function restoreSketchesLayerToEditor(): void {
  if (!geoEditorControl || !pluginActive) return;

  const layer = findSketchesLayer(useAppStore.getState().layers);
  if (!layer?.geojson?.features?.length) {
    if (layer) sketchesLayerId = layer.id;
    return;
  }

  sketchesLayerId = layer.id;
  restoringSketchesToEditor = true;
  try {
    geoEditorControl.loadGeoJson(
      cloneFeatureCollection(layer.geojson),
      SKETCHES_SOURCE_PATH,
    );
  } catch {
    // Geoman may not be ready until the map style finishes loading.
  } finally {
    restoringSketchesToEditor = false;
  }
  updateSketchesDisplayForMode();
}

function clearSketchesFromEditor(): void {
  if (!geoEditorControl) return;
  restoringSketchesToEditor = true;
  try {
    geoEditorControl.loadGeoJson(
      { type: "FeatureCollection", features: [] },
      SKETCHES_SOURCE_PATH,
    );
  } catch {
    // Ignore when Geoman is not initialized yet.
  } finally {
    restoringSketchesToEditor = false;
  }
}

function bindSketchesStoreSync(): void {
  geoEditorStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    if (!pluginActive) return;

    const sketches = findSketchesLayer(state.layers);
    const previousSketches = findSketchesLayer(previous.layers);

    if (previousSketches && !sketches) {
      sketchesLayerId = null;
      clearSketchesFromEditor();
      return;
    }

    if (sketches && sketches.id !== sketchesLayerId) {
      sketchesLayerId = sketches.id;
      restoreSketchesLayerToEditor();
      return;
    }

    if (
      sketches &&
      previousSketches &&
      sketches.id === previousSketches.id &&
      sketches.geojson !== previousSketches.geojson &&
      !restoringSketchesToEditor
    ) {
      restoreSketchesLayerToEditor();
    }
  });
}

function teardownSketchesStoreSync(): void {
  geoEditorStoreUnsubscribe?.();
  geoEditorStoreUnsubscribe = null;
}

function isGeoEditorInteractionMode(): boolean {
  return currentGeoEditorMode !== null;
}

/**
 * While GeoEditor has an active draw/edit mode, Geoman layers must stay visible
 * for hit-testing and handles. When idle, hide Geoman and show the Sketches
 * store layer to avoid duplicate rendering (PR #77).
 */
function updateSketchesDisplayForMode(): void {
  if (isGeoEditorInteractionMode()) {
    showGeomanDisplayLayers();
    setSketchesStoreLayerSuppressed(true);
    return;
  }
  hideGeomanDisplayLayers();
  setSketchesStoreLayerSuppressed(false);
}

function setSketchesStoreLayerSuppressed(suppress: boolean): void {
  const layer = findSketchesLayer(useAppStore.getState().layers);
  if (!layer) {
    sketchesLayerDisplaySuppressed = false;
    return;
  }

  const store = useAppStore.getState();

  if (suppress) {
    if (sketchesLayerDisplaySuppressed || !layer.visible) return;
    store.setLayerVisibility(layer.id, false);
    sketchesLayerDisplaySuppressed = true;
    return;
  }

  if (!sketchesLayerDisplaySuppressed) return;
  store.setLayerVisibility(layer.id, true);
  sketchesLayerDisplaySuppressed = false;
}

function setGeomanDisplayLayersVisibility(visibility: "visible" | "none"): void {
  const map = appApi?.getMap?.();
  if (!map) return;

  const style = map.getStyle();
  if (!style?.layers) return;

  for (const layer of style.layers) {
    if (!isGeomanDisplayLayer(layer)) continue;
    try {
      map.setLayoutProperty(layer.id, "visibility", visibility);
    } catch {
      // Layer may have been removed with the current style.
    }
  }
}

function hideGeomanDisplayLayers(): void {
  setGeomanDisplayLayersVisibility("none");
}

function showGeomanDisplayLayers(): void {
  setGeomanDisplayLayersVisibility("visible");
}

function isGeomanDisplayLayer(layer: maplibregl.LayerSpecification): boolean {
  if (layer.id.startsWith("gm_")) return true;
  if (!("source" in layer)) return false;
  const source = layer.source;
  return typeof source === "string" && source.startsWith("geoman");
}
