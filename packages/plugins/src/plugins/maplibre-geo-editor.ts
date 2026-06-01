import { type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { Feature, FeatureCollection } from "geojson";
import type maplibregl from "maplibre-gl";
import { GeoEditor, type GeoEditorOptions } from "maplibre-gl-geo-editor";
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
  // Avoid zoom/fit on Sketches restore — it retriggers style churn and races with draw.
  fitBoundsOnLoad: false,
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
  | "onSelectionChange"
>;

let geoEditorControl: GeoEditor | null = null;
let sketchesLayerId: string | null = null;
let geoEditorStoreUnsubscribe: (() => void) | null = null;
let pluginActive = false;
let restoringSketchesToEditor = false;
let pushingSketchesToStore = false;
let appApi: GeoLibreAppAPI | null = null;
/** Map-only hide of Sketches while GeoEditor interacts; does not touch store.visible. */
let sketchesMapLayerSuppressed = false;
/** After a draw completes, show Sketches even if draw mode stays active for another shape. */
let sketchesIdleDisplayOverride = false;
/** Union store + editor on the next sync so a partial getAll cannot drop prior sketches. */
let unionSketchesWithStoreOnNextSync = false;
/** Pending one-shot `styledata` listener, so repeated draw events don't pile up listeners. */
let pendingStyleDataListener: (() => void) | null = null;

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
      pluginActive = false;
      appApi = null;
      return false;
    }

    bindSketchesStoreSync();
    restoreSketchesLayerToEditor();
    setTimeout(() => geoEditorControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    pluginActive = false;
    sketchesIdleDisplayOverride = false;
    unionSketchesWithStoreOnNextSync = false;
    setSketchesMapLayerSuppressed(false);
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
    onFeatureCreate: () => {
      sketchesIdleDisplayOverride = true;
      unionSketchesWithStoreOnNextSync = true;
      // Defer until Geoman commits the new feature to its feature store.
      queueMicrotask(() => {
        syncSketchesToStore();
        applySketchesMapDisplay();
      });
    },
    onFeatureEdit: () => {
      syncSketchesToStore();
      applySketchesMapDisplay();
    },
    onFeatureDelete: () => {
      syncSketchesToStore();
      applySketchesMapDisplay();
    },
    onGeoJsonLoad: () => {
      if (!restoringSketchesToEditor) {
        syncSketchesToStore();
      }
    },
    onAttributeChange: () => syncSketchesToStore(),
    onHistoryChange: () => syncSketchesToStore(),
    onModeChange: () => {
      sketchesIdleDisplayOverride = false;
      applySketchesMapDisplay();
    },
    onSelectionChange: () => applySketchesMapDisplay(),
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

function featureCollectionsEquivalent(
  a: FeatureCollection,
  b: FeatureCollection,
): boolean {
  if (a.features.length !== b.features.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function sketchFeatureKey(feature: Feature, index: number): string {
  const props = feature.properties as Record<string, unknown> | null;
  return String(
    feature.id ?? props?.__gm_id ?? `${JSON.stringify(feature)}@${index}`,
  );
}

function unionFeatureCollections(
  ...collections: FeatureCollection[]
): FeatureCollection {
  const byKey = new Map<string, Feature>();
  for (const collection of collections) {
    collection.features.forEach((feature, index) => {
      byKey.set(sketchFeatureKey(feature, index), feature);
    });
  }
  return { type: "FeatureCollection", features: [...byKey.values()] };
}

function syncSketchesToStore(): void {
  if (!geoEditorControl || restoringSketchesToEditor) return;

  let collection = cloneFeatureCollection(
    geoEditorControl.getAllFeatureCollection(),
  );
  const store = useAppStore.getState();
  const existing = findSketchesLayer(store.layers);

  if (unionSketchesWithStoreOnNextSync && existing?.geojson) {
    collection = unionFeatureCollections(existing.geojson, collection);
    unionSketchesWithStoreOnNextSync = false;
  }

  pushingSketchesToStore = true;
  try {
    if (existing) {
      sketchesLayerId = existing.id;
      store.updateLayer(existing.id, { geojson: collection });
    } else {
      if (collection.features.length === 0) {
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
          ...useAppStore.getState().layers.find((layer) => layer.id === id)
            ?.metadata,
          sourceKind: SKETCHES_SOURCE_KIND,
        },
      });
    }
  } finally {
    pushingSketchesToStore = false;
  }

  if (!sketchesIdleDisplayOverride) {
    scheduleApplySketchesMapDisplay();
  }
}

function restoreSketchesLayerToEditor(): void {
  if (!geoEditorControl || !pluginActive) return;

  const layer = findSketchesLayer(useAppStore.getState().layers);
  if (!layer?.geojson?.features?.length) {
    if (layer) sketchesLayerId = layer.id;
    return;
  }

  sketchesLayerId = layer.id;
  const storeCollection = cloneFeatureCollection(layer.geojson);
  try {
    const editorCollection = geoEditorControl.getAllFeatureCollection();
    if (featureCollectionsEquivalent(editorCollection, storeCollection)) {
      scheduleApplySketchesMapDisplay();
      return;
    }
  } catch {
    // Geoman may not be ready yet.
  }

  // `loadGeoJson` invokes `onGeoJsonLoad` synchronously, so clearing the guard
  // in `finally` is safe; if it ever became async the guard would already be
  // false when the callback runs and `syncSketchesToStore` could loop.
  restoringSketchesToEditor = true;
  try {
    geoEditorControl.loadGeoJson(storeCollection, SKETCHES_SOURCE_PATH);
  } catch {
    // Geoman may not be ready until the map style finishes loading.
  } finally {
    restoringSketchesToEditor = false;
  }
  scheduleApplySketchesMapDisplay();
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

    if (sketches && sketches.id !== sketchesLayerId && !pushingSketchesToStore) {
      sketchesLayerId = sketches.id;
      restoreSketchesLayerToEditor();
      return;
    }

    if (
      sketches &&
      previousSketches &&
      sketches.id === previousSketches.id &&
      sketches.geojson !== previousSketches.geojson &&
      !restoringSketchesToEditor &&
      !pushingSketchesToStore
    ) {
      restoreSketchesLayerToEditor();
      return;
    }

    if (
      sketches &&
      previousSketches &&
      sketches.id === previousSketches.id &&
      sketches.visible !== previousSketches.visible
    ) {
      scheduleApplySketchesMapDisplay();
    }
  });
}

function teardownSketchesStoreSync(): void {
  geoEditorStoreUnsubscribe?.();
  geoEditorStoreUnsubscribe = null;
}

function isGeoEditorInteractionMode(): boolean {
  if (!geoEditorControl) return false;
  if (sketchesIdleDisplayOverride) return false;
  const { activeDrawMode, activeEditMode } = geoEditorControl.getState();
  return activeDrawMode !== null || activeEditMode !== null;
}

function sketchesMapLayerIds(layerId: string): string[] {
  return [
    `layer-${layerId}-fill`,
    `layer-${layerId}-extrusion`,
    `layer-${layerId}-line`,
    `layer-${layerId}-circle`,
  ];
}

/**
 * GeoEditor selection and edit handles use Geoman layers for hit-testing.
 * While interacting, show Geoman and hide the Sketches store layer on the map only.
 * When idle, hide Geoman and show Sketches according to the user's layer-panel toggle.
 */
function applySketchesMapDisplay(): void {
  if (isGeoEditorInteractionMode()) {
    showGeomanDisplayLayers();
    scheduleShowGeomanDisplayLayersOnStyleData();
    setSketchesMapLayerSuppressed(true);
    return;
  }

  hideGeomanDisplayLayers();
  setSketchesMapLayerSuppressed(false);
}

function scheduleApplySketchesMapDisplay(): void {
  queueMicrotask(() => applySketchesMapDisplay());
  window.setTimeout(() => applySketchesMapDisplay(), 0);
}

function scheduleShowGeomanDisplayLayersOnStyleData(): void {
  const map = appApi?.getMap?.();
  if (!map || pendingStyleDataListener) return;

  pendingStyleDataListener = () => {
    pendingStyleDataListener = null;
    if (isGeoEditorInteractionMode()) {
      showGeomanDisplayLayers();
    }
  };
  map.once("styledata", pendingStyleDataListener);
}

function setSketchesMapLayerSuppressed(suppress: boolean): void {
  const layer = findSketchesLayer(useAppStore.getState().layers);
  if (!layer) {
    sketchesMapLayerSuppressed = false;
    return;
  }

  sketchesMapLayerSuppressed = suppress;
  setSketchesMapLayersVisibility(layer);
}

function setSketchesMapLayersVisibility(layer: GeoLibreLayer): void {
  const map = appApi?.getMap?.();
  if (!map) return;

  const visibility =
    layer.visible && !sketchesMapLayerSuppressed ? "visible" : "none";

  for (const mapLayerId of sketchesMapLayerIds(layer.id)) {
    try {
      if (map.getLayer(mapLayerId)) {
        map.setLayoutProperty(mapLayerId, "visibility", visibility);
      }
    } catch {
      // Layer may not exist yet for this geometry profile.
    }
  }
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
  const id = layer.id.toLowerCase();
  if (id.startsWith("gm_") || id.startsWith("gm-")) {
    return true;
  }
  if (!("source" in layer)) return false;
  const source = layer.source;
  return (
    typeof source === "string" &&
    (source.startsWith("gm_") ||
      source.startsWith("gm-") ||
      source.startsWith("geoman"))
  );
}
