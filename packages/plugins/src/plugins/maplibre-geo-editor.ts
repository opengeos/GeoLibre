import { type GeoLibreLayer, styleValue, useAppStore } from "@geolibre/core";
import { Geoman, defaultLayerStyles } from "@geoman-io/maplibre-geoman-free";
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
const GEOMAN_TEXT_PROPERTY = "__gm_text";

let geoEditorPosition: GeoLibreMapControlPosition = "top-left";

const GEO_EDITOR_OPTIONS = {
  collapsed: false,
  toolbarOrientation: "vertical",
  columns: 2,
  drawModes: [
    "polygon",
    "line",
    "rectangle",
    "circle",
    "marker",
    "freehand",
    "text_marker",
  ],
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
let geomanEditSyncMap: maplibregl.Map | null = null;

const GEOMAN_EDIT_SYNC_EVENTS = [
  "gm:dragend",
  "gm:editend",
  "gm:rotateend",
] as const;

export const maplibreGeoEditorPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-geo-editor",
  name: "GeoEditor",
  version: "0.7.3",
  activate: (app: GeoLibreAppAPI) => {
    pluginActive = true;
    appApi = app;

    if (!geoEditorControl) {
      geoEditorControl = new GeoEditor(getGeoEditorOptions());
      const map = app.getMap?.();
      if (map) {
        geoEditorControl.setGeoman(
          new Geoman(map, {
            layerStyles: geomanLayerStylesForMap(map),
            settings: { useControlsUi: false },
          }),
        );
        bindGeomanEditSync(map);
      }
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
    unbindGeomanEditSync();

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

function handleGeomanEditSync(): void {
  queueMicrotask(() => {
    syncSketchesToStore();
    applySketchesMapDisplay();
  });
}

function bindGeomanEditSync(map: maplibregl.Map): void {
  if (geomanEditSyncMap === map) return;
  unbindGeomanEditSync();
  geomanEditSyncMap = map;
  for (const eventName of GEOMAN_EDIT_SYNC_EVENTS) {
    map.on(eventName, handleGeomanEditSync);
  }
}

function unbindGeomanEditSync(): void {
  if (!geomanEditSyncMap) return;
  for (const eventName of GEOMAN_EDIT_SYNC_EVENTS) {
    geomanEditSyncMap.off(eventName, handleGeomanEditSync);
  }
  geomanEditSyncMap = null;
}

function geomanLayerStylesForMap(map: maplibregl.Map) {
  const layerStyles = structuredClone(defaultLayerStyles);

  for (const sourceLayers of Object.values(layerStyles.text_marker ?? {})) {
    for (const layer of sourceLayers) {
      if (layer.type !== "symbol") continue;
      layer.layout = {
        ...layer.layout,
        "text-font": textFontForMapStyle(map),
      };
    }
  }

  return layerStyles;
}

// Operators that can start a data-driven text-font expression. A bare
// ["get", "font"] is all strings, so an every(typeof === "string") check
// alone would mistake it for a font stack.
const FONT_EXPRESSION_OPERATORS = new Set([
  "literal",
  "get",
  "has",
  "at",
  "in",
  "case",
  "match",
  "coalesce",
  "step",
  "interpolate",
  "let",
  "var",
  "concat",
  "to-string",
  "string",
  "array",
  "format",
]);

function textFontForMapStyle(map: maplibregl.Map): string[] {
  for (const styleLayer of map.getStyle().layers ?? []) {
    if (styleLayer.type !== "symbol") continue;
    // Icon-only symbol layers may carry a glyph/sprite font unsuited to text.
    if (!styleLayer.layout?.["text-field"]) continue;
    const textFont = styleLayer.layout?.["text-font"];
    if (!Array.isArray(textFont)) continue;
    // Unwrap the ["literal", ["Font A", "Font B"]] expression form used by
    // many popular styles.
    const fonts =
      textFont[0] === "literal" && Array.isArray(textFont[1])
        ? (textFont[1] as unknown[])
        : (textFont as unknown[]);
    if (
      fonts.length > 0 &&
      fonts.every((font) => typeof font === "string") &&
      !FONT_EXPRESSION_OPERATORS.has(fonts[0] as string)
    ) {
      return fonts as string[];
    }
  }
  return ["Noto Sans Regular"];
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
    `layer-${layerId}-text`,
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

  if (visibility === "visible") {
    applyGeomanTextMarkerStyle(map);
  }

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

function applyGeomanTextMarkerStyle(map: maplibregl.Map): void {
  const sketchesLayer = findSketchesLayer(useAppStore.getState().layers);
  if (!sketchesLayer) return;

  const style = map.getStyle();
  if (!style?.layers) return;

  for (const layer of style.layers) {
    if (!isGeomanTextMarkerLayer(layer)) continue;
    try {
      map.setLayoutProperty(
        layer.id,
        "text-size",
        Math.max(1, styleValue(sketchesLayer.style, "textSize")),
      );
      map.setPaintProperty(
        layer.id,
        "text-color",
        styleValue(sketchesLayer.style, "textColor"),
      );
      map.setPaintProperty(
        layer.id,
        "text-halo-color",
        styleValue(sketchesLayer.style, "textHaloColor"),
      );
      map.setPaintProperty(
        layer.id,
        "text-halo-width",
        Math.max(0, styleValue(sketchesLayer.style, "textHaloWidth")),
      );
    } catch {
      // Geoman may rebuild its temporary layers while an interaction is active.
    }
  }
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

function isGeomanTextMarkerLayer(
  layer: maplibregl.LayerSpecification,
): layer is maplibregl.SymbolLayerSpecification {
  if (layer.type !== "symbol" || !isGeomanDisplayLayer(layer)) return false;
  return JSON.stringify(layer.layout?.["text-field"] ?? "").includes(
    GEOMAN_TEXT_PROPERTY,
  );
}
