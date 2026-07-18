import { type GeoLibreLayer, lineWidthValue, styleValue, useAppStore } from "@geolibre/core";
import { Geoman, defaultLayerStyles } from "@geoman-io/maplibre-geoman-free";
import type { Feature, FeatureCollection } from "geojson";
import type maplibregl from "maplibre-gl";
import { GeoEditor, type GeoEditorOptions } from "maplibre-gl-geo-editor";
import {
  SKETCHES_SOURCE_KIND,
  canEditLayerGeometry,
  planGeoEditorOverlayOrder,
  reconcileEditedFeatures,
  tagFeatureKeys,
} from "./geo-editor-geometry";
import {
  type ViewImportBaseline,
  type ViewImportExport,
  buildChangedExport,
  buildFullExport,
  captureViewImportBaseline,
  tagViewFeaturesForImport,
} from "./geo-editor-view-import";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition, GeoLibrePlugin } from "../types";

export { canEditLayerGeometry, SKETCHES_SOURCE_KIND } from "./geo-editor-geometry";

const SKETCHES_LAYER_NAME = "Sketches";
const SKETCHES_SOURCE_PATH = "geoeditor://sketches";
const GEOMAN_TEXT_PROPERTY = "__gm_text";

let geoEditorPosition: GeoLibreMapControlPosition = "top-left";

const GEO_EDITOR_OPTIONS = {
  collapsed: false,
  toolbarOrientation: "vertical",
  columns: 2,
  drawModes: ["polygon", "line", "rectangle", "circle", "marker", "freehand", "text_marker"],
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

/**
 * Id of the store layer currently being geometry-edited in place, or null when
 * the editor is in its default "Sketches" mode. While set, the shared editor is
 * re-targeted at this layer: the sync/display helpers resolve to it instead of
 * the Sketches layer (see `activeEditableLayer`).
 */
let editTargetLayerId: string | null = null;
/** Sketches stashed out of the editor for the duration of an edit session. */
let savedSketchesCollection: FeatureCollection | null = null;
/** The live Geoman instance backing the editor, used for clean teardown. */
let geomanInstance: Geoman | null = null;
/** Target layer's store visibility captured at session start, restored on end. */
let editTargetOriginalVisible: boolean | null = null;
/** Listeners notified when a geometry edit session starts or ends. */
const geometryEditListeners = new Set<() => void>();

/**
 * Baseline of the features most recently loaded from a map view, keyed by their
 * view-import id and captured from the post-import (Geoman-normalized) geometry.
 * Used to compute the "changed only" export (added/modified/deleted). Null until
 * a view load happens, and cleared when the plugin deactivates.
 */
let viewImportBaseline: ViewImportBaseline | null = null;
/** Per-load id-prefix counter so appended loads cannot collide feature ids. */
let viewImportLoadCounter = 0;

const GEOMAN_EDIT_SYNC_EVENTS = ["gm:dragend", "gm:editend", "gm:rotateend"] as const;

export const GEO_EDITOR_PLUGIN_ID = "maplibre-gl-geo-editor";

export const maplibreGeoEditorPlugin: GeoLibrePlugin = {
  id: GEO_EDITOR_PLUGIN_ID,
  name: "GeoEditor",
  version: "0.9.0",
  activate: (app: GeoLibreAppAPI) => {
    pluginActive = true;
    appApi = app;

    if (!geoEditorControl) {
      geoEditorControl = new GeoEditor(getGeoEditorOptions());
      const map = app.getMap?.();
      if (map) {
        geomanInstance = new Geoman(map, {
          layerStyles: geomanLayerStylesForMap(map),
          settings: { useControlsUi: false },
        });
        geoEditorControl.setGeoman(geomanInstance);
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
    void restoreSketchesLayerToEditor();
    setTimeout(() => geoEditorControl?.expand(), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    // Persist any in-progress geometry edit and restore the editor to Sketches
    // mode before tearing the control down. The write-back is synchronous; only
    // the sketches restore is async, which is moot since the control is removed
    // below, so this need not be awaited.
    if (editTargetLayerId) void endLayerGeometryEdit(app, { save: true });
    pluginActive = false;
    viewImportBaseline = null;
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
    void geomanInstance?.destroy({ removeSources: true });
    geomanInstance = null;
  },
  getMapControlPosition: () => geoEditorPosition,
  setMapControlPosition: (app: GeoLibreAppAPI, position: GeoLibreMapControlPosition) => {
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

function findSketchesLayer(layers: GeoLibreLayer[]): GeoLibreLayer | undefined {
  if (sketchesLayerId) {
    const tracked = layers.find((layer) => layer.id === sketchesLayerId);
    if (tracked) return tracked;
  }
  return layers.find(isSketchesLayer);
}

/**
 * The store layer the shared editor is currently bound to: the geometry-edit
 * target when a session is active, otherwise the Sketches layer. The map-display
 * helpers resolve through this so they suppress/style whichever layer the editor
 * is showing, without duplicating the suppression logic per mode.
 */
function activeEditableLayer(layers: GeoLibreLayer[]): GeoLibreLayer | undefined {
  if (editTargetLayerId) {
    return layers.find((layer) => layer.id === editTargetLayerId);
  }
  return findSketchesLayer(layers);
}

function cloneFeatureCollection(collection: FeatureCollection): FeatureCollection {
  return structuredClone(collection);
}

function featureCollectionsEquivalent(a: FeatureCollection, b: FeatureCollection): boolean {
  if (a.features.length !== b.features.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function sketchFeatureKey(feature: Feature, index: number): string {
  const props = feature.properties as Record<string, unknown> | null;
  return String(feature.id ?? props?.__gm_id ?? `${JSON.stringify(feature)}@${index}`);
}

function unionFeatureCollections(...collections: FeatureCollection[]): FeatureCollection {
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

  // During a geometry-edit session edits live in the editor and are written
  // back only on save. Writing per operation would rebuild the target layer's
  // map source on every drag and disrupt Geoman's in-progress vertex editing,
  // so skip store writes here; `endLayerGeometryEdit` flushes the final state.
  if (editTargetLayerId) return;

  let collection = cloneFeatureCollection(geoEditorControl.getAllFeatureCollection());
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

      const id = store.addGeoJsonLayer(SKETCHES_LAYER_NAME, collection, SKETCHES_SOURCE_PATH);
      sketchesLayerId = id;
      store.updateLayer(id, {
        metadata: {
          ...useAppStore.getState().layers.find((layer) => layer.id === id)?.metadata,
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

// ---------------------------------------------------------------------------
// Loading map-view features into the editor (and exporting them)
// ---------------------------------------------------------------------------

/**
 * Whether the shared editor is ready to receive features loaded from a map view:
 * the plugin is active, the control exists, and no in-place geometry edit session
 * is holding the editor. Callers should activate the plugin first if this is
 * false because the editor was never created.
 */
export function isGeoEditorAvailableForImport(): boolean {
  return pluginActive && geoEditorControl != null && editTargetLayerId == null;
}

/** Number of features currently in the editor (for the load-confirm prompt). */
export function getGeoEditorFeatureCount(): number {
  if (!geoEditorControl) return 0;
  try {
    return geoEditorControl.getAllFeatureCollection().features.length;
  } catch {
    return 0;
  }
}

/** Whether a view-import baseline exists, so a "changed only" export is meaningful. */
export function hasViewImportBaseline(): boolean {
  return viewImportBaseline != null;
}

/**
 * Load features queried from a map layer in the current view into the shared
 * editor, so they become editable "Sketches". Features are normalized and tagged
 * (see `tagViewFeaturesForImport`); the editor's `loadGeoJson` fires the sketches
 * sync, so they also appear as the Sketches store layer. A baseline is captured
 * from the post-import geometry for later "changed only" export.
 *
 * @param features Plain features from `queryViewLayerFeatures`.
 * @param options `replace` clears the editor first; otherwise the features are
 *   appended to whatever is already loaded.
 * @returns How many features were imported and how many were dropped as
 *   un-editable, or throws when the editor is not available.
 */
export async function loadViewFeaturesIntoEditor(
  features: Feature[],
  { replace }: { replace: boolean },
): Promise<{ imported: number; dropped: number }> {
  if (!pluginActive || !geoEditorControl) {
    throw new Error("The GeoEditor is not active.");
  }
  if (editTargetLayerId) {
    throw new Error("Finish editing the current layer's geometry before loading view features.");
  }

  await ensureGeomanReady();
  if (!geoEditorControl) throw new Error("The GeoEditor is not active.");

  const idPrefix = `view${viewImportLoadCounter++}`;
  const tagged = tagViewFeaturesForImport(features, idPrefix);
  // Bail out before touching the editor: with `replace: true`, loading an empty
  // collection (every queried feature was un-editable) would wipe whatever the
  // user already had loaded/edited (and the persisted Sketches layer). Report
  // nothing imported instead.
  if (tagged.prepared === 0) {
    return { imported: 0, dropped: tagged.dropped };
  }
  const newIds = new Set(tagged.collection.features.map((feature) => String(feature.id)));

  let collectionToLoad = tagged.collection;
  if (!replace) {
    const existing = cloneFeatureCollection(geoEditorControl.getAllFeatureCollection());
    collectionToLoad = {
      type: "FeatureCollection",
      features: [...existing.features, ...tagged.collection.features],
    };
  }

  // loadGeoJson replaces the editor's collection and fires onGeoJsonLoad, which
  // (the restore guard being off here) syncs the loaded features to the Sketches
  // store layer so they render and stay editable.
  await geoEditorControl.loadGeoJson(collectionToLoad, SKETCHES_SOURCE_PATH);

  // Capture the baseline from the post-import geometry: Geoman normalizes
  // coordinates on load, so comparing against the loaded values (not the raw
  // source ones) means only genuine user edits later count as "modified".
  const afterLoad = geoEditorControl.getAllFeatureCollection();
  if (replace || !viewImportBaseline) {
    viewImportBaseline = captureViewImportBaseline(afterLoad);
  } else {
    const appended = captureViewImportBaseline(afterLoad, newIds);
    for (const [id, entry] of appended) viewImportBaseline.set(id, entry);
  }

  syncSketchesToStore();
  applySketchesMapDisplay();

  return { imported: tagged.prepared, dropped: tagged.dropped };
}

/**
 * Build a GeoJSON collection to export from the editor's current features.
 * `changedOnly` diffs against the view-import baseline and returns only the
 * added/modified/deleted features (each tagged); otherwise every feature is
 * returned with editor-internal properties stripped.
 *
 * @param options Whether to export only changes, plus the editor name and ISO
 *   timestamp stamped onto changed features.
 * @returns The export result, or null when the editor is unavailable or an
 *   in-place geometry-edit session has re-targeted the editor.
 */
export function buildEditorSaveCollection(options: {
  changedOnly: boolean;
  editorName?: string;
  now: string;
}): ViewImportExport | null {
  if (!geoEditorControl) return null;
  // During an in-place "Edit geometry" session the shared editor holds the
  // target layer's features, not the loaded view features, and the view-import
  // baseline is stale. Exporting now would produce a nonsensical diff, so refuse
  // (the dialog disables Save while such a session is active).
  if (editTargetLayerId) return null;
  const collection = cloneFeatureCollection(geoEditorControl.getAllFeatureCollection());

  if (!options.changedOnly) {
    return buildFullExport(collection);
  }
  if (!viewImportBaseline) {
    return {
      collection: { type: "FeatureCollection", features: [] },
      counts: { added: 0, modified: 0, deleted: 0 },
    };
  }
  return buildChangedExport(collection, viewImportBaseline, {
    editorName: options.editorName,
    now: options.now,
  });
}

// ---------------------------------------------------------------------------
// In-place geometry editing of an existing vector layer
// ---------------------------------------------------------------------------

/** Id of the layer being geometry-edited, or null when no session is active. */
export function getGeometryEditTargetLayerId(): string | null {
  return editTargetLayerId;
}

/** Subscribe to geometry-edit session changes (for `useSyncExternalStore`). */
export function subscribeGeometryEdit(listener: () => void): () => void {
  geometryEditListeners.add(listener);
  return () => {
    geometryEditListeners.delete(listener);
  };
}

function notifyGeometryEdit(): void {
  for (const listener of geometryEditListeners) listener();
}

/**
 * Write the editor's current features back to the target layer. Called only
 * when a session ends with save, so the target's map source is rebuilt once
 * rather than on every edit operation.
 */
function syncEditTargetToStore(): void {
  if (!geoEditorControl || !editTargetLayerId) return;

  const store = useAppStore.getState();
  const layer = store.layers.find((l) => l.id === editTargetLayerId);
  if (!layer) return;

  const edited = reconcileEditedFeatures(
    cloneFeatureCollection(geoEditorControl.getAllFeatureCollection()),
  );

  pushingSketchesToStore = true;
  try {
    store.updateLayer(editTargetLayerId, { geojson: edited });
  } finally {
    pushingSketchesToStore = false;
  }

  // Add Vector Layer control layers render from a MapLibre GeoJSON source they
  // own rather than from `layer.geojson`, so push the edits there too or the map
  // would keep showing the pre-edit geometry.
  writeBackToVectorSource(layer, edited);
}

/** Source id of an Add-Vector-Layer geojson-mode layer, or null. */
function vectorSourceIdForLayer(layer: GeoLibreLayer): string | null {
  if (layer.metadata.sourceKind !== "maplibre-gl-vector") return null;
  const sourceIds = layer.metadata.sourceIds;
  const sourceId = Array.isArray(sourceIds) ? sourceIds[0] : undefined;
  return typeof sourceId === "string" ? sourceId : null;
}

function writeBackToVectorSource(layer: GeoLibreLayer, collection: FeatureCollection): void {
  const sourceId = vectorSourceIdForLayer(layer);
  if (!sourceId) return;
  const source = appApi?.getMap?.()?.getSource(sourceId) as
    | { setData?: (data: FeatureCollection) => void }
    | undefined;
  if (source && typeof source.setData === "function") {
    source.setData(collection);
  }
}

/**
 * Wait until Geoman has finished its asynchronous initialization. Geoman creates
 * its feature sources during an async `init()`, so importing features before it
 * is loaded fails with "Missing source for feature creation" and the features
 * are silently dropped (they render but cannot be edited).
 */
async function ensureGeomanReady(): Promise<void> {
  const geoman = geomanInstance;
  if (!geoman || geoman.loaded) return;
  try {
    await geoman.waitForGeomanLoaded();
  } catch {
    // If readiness cannot be awaited, the caller's load will no-op safely.
  }
}

/**
 * Begin editing the geometry of an existing vector layer in place, reusing the
 * shared Geoman editor. Stashes any current sketches out of the editor, loads
 * the target layer's features (id-tagged), and re-targets the sync/display
 * helpers at the target layer. Returns false when the plugin is not active or
 * the layer is not editable.
 *
 * The target's features must already be in `layer.geojson`. Add-Vector-Layer
 * (`maplibre-gl-vector`) layers keep their features in a MapLibre source, so the
 * caller must hydrate `layer.geojson` from that source first (otherwise this
 * returns false); `canEditLayerGeometry` deliberately reports them editable
 * because that hydration is the caller's responsibility.
 *
 * `_app` is accepted for API symmetry with the other plugin entry points but is
 * not used: this function operates through the module-level `appApi`/store.
 */
export async function startLayerGeometryEdit(
  _app: GeoLibreAppAPI,
  layerId: string,
): Promise<boolean> {
  if (!pluginActive || !geoEditorControl) return false;

  // Only one session at a time; finish any open one first (saving its work).
  // Await it so its sketches restore completes before the new session starts.
  if (editTargetLayerId && editTargetLayerId !== layerId) {
    await endLayerGeometryEdit(_app, { save: true });
  }
  if (editTargetLayerId === layerId) return true;

  const layer = useAppStore.getState().layers.find((candidate) => candidate.id === layerId);
  if (!layer || !canEditLayerGeometry(layer) || !layer.geojson) return false;

  // Geoman may have only just been created (the plugin was activated for this
  // edit); wait for it to finish initializing so the import below succeeds.
  await ensureGeomanReady();
  if (!pluginActive || !geoEditorControl) return false;

  // Flush sketches to the store, stash them out of the editor, and restore the
  // Sketches store layer's normal rendering (it stays visible as a plain layer
  // during the target edit).
  syncSketchesToStore();
  savedSketchesCollection = cloneFeatureCollection(geoEditorControl.getAllFeatureCollection());
  await clearSketchesFromEditor();
  setSketchesMapLayerSuppressed(false);

  // The store layer is left untouched until save, so Cancel simply discards the
  // editor's copy and the original geojson is still in the store.
  editTargetLayerId = layerId;
  sketchesIdleDisplayOverride = false;
  unionSketchesWithStoreOnNextSync = false;

  // Hide the target's normal rendering through the store, not via a map-layer
  // visibility toggle: the store value is authoritative for the layer sync, so
  // it survives any re-render and the editable features are shown only once
  // (through Geoman), avoiding the double-render that left some features
  // appearing editable but not interactive.
  editTargetOriginalVisible = layer.visible;
  setEditTargetStoreVisible(layerId, false);

  let loaded = false;
  restoringSketchesToEditor = true;
  try {
    const tagged = tagFeatureKeys(cloneFeatureCollection(layer.geojson));
    await geoEditorControl.loadGeoJson(tagged, SKETCHES_SOURCE_PATH);
    loaded = true;
  } catch (error) {
    // A "Missing source" failure means Geoman is not ready yet (handled by the
    // rollback below). Log anything else so unexpected failures (e.g. malformed
    // geojson) are not silently swallowed.
    if (!(error instanceof Error) || !error.message.includes("Missing source")) {
      console.warn("startLayerGeometryEdit: loadGeoJson failed", error);
    }
  } finally {
    restoringSketchesToEditor = false;
  }

  // The target layer may have been removed while `loadGeoJson` was awaited; the
  // store subscription's `abortGeometryEditSession` then already tore the session
  // down (and restored sketches). Bail out without a second teardown.
  if (editTargetLayerId !== layerId) return false;

  // If the load failed the editor is empty; do NOT keep the session active or a
  // later Save would overwrite the layer with an empty collection. Roll back:
  // restore visibility and the stashed sketches and report failure.
  if (!loaded) {
    setEditTargetStoreVisible(layerId, editTargetOriginalVisible ?? true);
    editTargetOriginalVisible = null;
    editTargetLayerId = null;
    await restoreSketchesAfterSession();
    applySketchesMapDisplay();
    return false;
  }

  applySketchesMapDisplay();
  notifyGeometryEdit();
  return true;
}

/** Set the target layer's store visibility without provoking a sketches sync. */
function setEditTargetStoreVisible(layerId: string, visible: boolean): void {
  const state = useAppStore.getState();
  if (!state.layers.some((layer) => layer.id === layerId)) return;
  state.setLayerVisibility(layerId, visible);
}

/** Exit any active Geoman draw/edit mode so temporary edit features are cleared. */
function disableActiveEditModes(): void {
  // disableAllModes() is async; attach a catch so a rejection (e.g. Geoman
  // already torn down) does not surface as an unhandled promise rejection.
  geomanInstance?.disableAllModes()?.catch(() => {
    // Geoman may already be torn down.
  });
}

/**
 * Finish the active geometry edit session. With `save`, the editor's features
 * are written back to the target layer; otherwise they are discarded and the
 * layer keeps the geojson it had at session start (it was never modified). The
 * editor is returned to Sketches mode either way.
 */
export async function endLayerGeometryEdit(
  _app: GeoLibreAppAPI,
  { save }: { save: boolean },
): Promise<void> {
  if (!editTargetLayerId) return;

  // Defensive: if the control was torn down while a session id lingered, clear
  // the session state so the UI does not get stuck in the "editing" state.
  if (!geoEditorControl) {
    editTargetLayerId = null;
    editTargetOriginalVisible = null;
    sketchesIdleDisplayOverride = false;
    unionSketchesWithStoreOnNextSync = false;
    notifyGeometryEdit();
    return;
  }

  const targetId = editTargetLayerId;
  // Run the write-back in try/finally so a throw (e.g. from the store update)
  // cannot leave the session half-torn-down with the target layer still hidden
  // and the user unable to exit.
  try {
    if (save) syncEditTargetToStore();
  } finally {
    editTargetLayerId = null;
    sketchesIdleDisplayOverride = false;
    unionSketchesWithStoreOnNextSync = false;
    // Restore the target layer's normal rendering (it now reflects the saved
    // edits, or the untouched original on cancel).
    setEditTargetStoreVisible(targetId, editTargetOriginalVisible ?? true);
    editTargetOriginalVisible = null;
    // Await the sketches restore so a caller switching sessions does not start a
    // new edit while the previous restore is still clearing/loading the editor.
    await restoreSketchesAfterSession();
    applySketchesMapDisplay();
    notifyGeometryEdit();
  }
}

/**
 * Tear down a session whose target layer was removed from the store mid-edit:
 * drop the editor's copy and restore Sketches without writing back to the gone
 * layer.
 */
function abortGeometryEditSession(): void {
  console.warn(
    "Geometry edit session aborted: the target layer was removed; " +
      "in-progress geometry edits were discarded.",
  );
  // The layer is gone, so there is no visibility to restore; just drop the flag.
  // (restoreSketchesAfterSession exits Geoman edit modes.)
  editTargetOriginalVisible = null;
  editTargetLayerId = null;
  sketchesIdleDisplayOverride = false;
  unionSketchesWithStoreOnNextSync = false;
  void restoreSketchesAfterSession();
  applySketchesMapDisplay();
  notifyGeometryEdit();
}

/** Clear the editor and reload the sketches stashed at session start. */
async function restoreSketchesAfterSession(): Promise<void> {
  if (!geoEditorControl) {
    savedSketchesCollection = null;
    return;
  }
  disableActiveEditModes();
  await clearSketchesFromEditor();
  if (savedSketchesCollection?.features.length) {
    restoringSketchesToEditor = true;
    try {
      await geoEditorControl.loadGeoJson(savedSketchesCollection, SKETCHES_SOURCE_PATH);
    } catch {
      // Geoman may not be ready; the store subscription will re-restore.
    } finally {
      restoringSketchesToEditor = false;
    }
  }
  savedSketchesCollection = null;
}

async function restoreSketchesLayerToEditor(): Promise<void> {
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

  // `loadGeoJson` is async, so the guard is awaited through the load: it stays
  // set while Geoman imports and fires onGeoJsonLoad, then is cleared in
  // `finally`, preventing `syncSketchesToStore` from looping.
  restoringSketchesToEditor = true;
  try {
    await geoEditorControl.loadGeoJson(storeCollection, SKETCHES_SOURCE_PATH);
  } catch {
    // Geoman may not be ready until the map style finishes loading.
  } finally {
    restoringSketchesToEditor = false;
  }
  scheduleApplySketchesMapDisplay();
}

async function clearSketchesFromEditor(): Promise<void> {
  if (!geoEditorControl) return;
  // loadGeoJson is async (it awaits Geoman's import); keep the guard set for the
  // whole load so the onGeoJsonLoad callback it fires cannot re-enter the sync.
  restoringSketchesToEditor = true;
  try {
    await geoEditorControl.loadGeoJson(
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

    // During a geometry-edit session the editor holds the target layer's
    // features, not sketches. Skip the Sketches reconciliation entirely and
    // only watch the target: abort if it was removed, reflect display changes.
    if (editTargetLayerId) {
      const target = state.layers.find((layer) => layer.id === editTargetLayerId);
      if (!target) {
        abortGeometryEditSession();
        return;
      }
      const previousTarget = previous.layers.find((layer) => layer.id === editTargetLayerId);
      // If the user toggled the target layer back on while editing, re-hide it
      // so its stale normal rendering does not double-draw over Geoman.
      if (target.visible && previousTarget && !previousTarget.visible) {
        setEditTargetStoreVisible(editTargetLayerId, false);
      }
      // Any change to the layers array (this layer's visibility/opacity/style, or
      // another layer being added, removed, reordered, or toggled) re-runs
      // MapController.syncLayers, which reorders the map's style layers and can
      // push the editor's overlay below a layer stacked above the edited one
      // (issue #1015). Re-apply the edit display so the overlay returns to the
      // edited layer's slot in the stack.
      if (state.layers !== previous.layers) {
        scheduleApplySketchesMapDisplay();
      }
      return;
    }

    const sketches = findSketchesLayer(state.layers);
    const previousSketches = findSketchesLayer(previous.layers);

    if (previousSketches && !sketches) {
      sketchesLayerId = null;
      void clearSketchesFromEditor();
      return;
    }

    if (sketches && sketches.id !== sketchesLayerId && !pushingSketchesToStore) {
      sketchesLayerId = sketches.id;
      void restoreSketchesLayerToEditor();
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
      void restoreSketchesLayerToEditor();
      return;
    }

    if (
      sketches &&
      previousSketches &&
      sketches.id === previousSketches.id &&
      (sketches.visible !== previousSketches.visible ||
        sketches.opacity !== previousSketches.opacity ||
        sketches.style !== previousSketches.style)
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
 *
 * During a geometry-edit session the target layer is shown exclusively through
 * Geoman for the whole session: its normal rendering stays suppressed even when
 * idle, so the layer's edits are not also drawn by the (stale) store source.
 */
function applySketchesMapDisplay(): void {
  // During a geometry-edit session the target's normal rendering is hidden via
  // store visibility, so only Geoman needs to be shown here; toggling map-layer
  // visibility for the target is unnecessary and would race the layer sync.
  if (editTargetLayerId) {
    showGeomanDisplayLayers();
    positionGeoEditorOverlayLayers();
    scheduleShowGeomanDisplayLayersOnStyleData();
    return;
  }

  if (isGeoEditorInteractionMode()) {
    showGeomanDisplayLayers();
    positionGeoEditorOverlayLayers();
    scheduleShowGeomanDisplayLayersOnStyleData();
    setSketchesMapLayerSuppressed(true);
    return;
  }

  hideGeomanDisplayLayers();
  setSketchesMapLayerSuppressed(false);
}

// Coalesce flags so a burst of store updates (e.g. an opacity slider dragged on
// any layer while a geometry-edit session is active, each of which re-runs
// MapController.syncLayers and can disturb the overlay ordering) collapses to a
// single apply per phase instead of one apply per update. The two phases are
// kept: a microtask pass and a macrotask pass, so the display is re-applied both
// before and after the layer sync that the same update triggers.
let applyMicrotaskPending = false;
let applyMacrotaskPending = false;

function scheduleApplySketchesMapDisplay(): void {
  if (!applyMicrotaskPending) {
    applyMicrotaskPending = true;
    queueMicrotask(() => {
      applyMicrotaskPending = false;
      applySketchesMapDisplay();
    });
  }
  if (!applyMacrotaskPending) {
    applyMacrotaskPending = true;
    window.setTimeout(() => {
      applyMacrotaskPending = false;
      applySketchesMapDisplay();
    }, 0);
  }
}

function scheduleShowGeomanDisplayLayersOnStyleData(): void {
  const map = appApi?.getMap?.();
  if (!map || pendingStyleDataListener) return;

  pendingStyleDataListener = () => {
    pendingStyleDataListener = null;
    if (editTargetLayerId || isGeoEditorInteractionMode()) {
      showGeomanDisplayLayers();
      positionGeoEditorOverlayLayers();
    }
  };
  map.once("styledata", pendingStyleDataListener);
}

function setSketchesMapLayerSuppressed(suppress: boolean): void {
  const layer = activeEditableLayer(useAppStore.getState().layers);
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

  const visibility = layer.visible && !sketchesMapLayerSuppressed ? "visible" : "none";

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
  const sketchesLayer = activeEditableLayer(useAppStore.getState().layers);
  // In a session the target is intentionally store-hidden, so its `visible`
  // flag must not also hide the Geoman display layers that present the features
  // being edited.
  const effectiveVisibility =
    visibility === "visible" && !editTargetLayerId && sketchesLayer?.visible === false
      ? "none"
      : visibility;

  if (visibility === "visible" && sketchesLayer) {
    applyGeomanSketchesStyle(map, sketchesLayer);
  }

  const style = map.getStyle();
  if (!style?.layers) return;

  for (const layer of style.layers) {
    if (!isGeomanDisplayLayer(layer)) continue;
    try {
      map.setLayoutProperty(layer.id, "visibility", effectiveVisibility);
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

/**
 * The edited layer's own map layers, used as the z-anchor for the editor
 * overlay. Add-Vector-Layer layers carry their layer ids in
 * `metadata.nativeLayerIds`; plain geojson layers use the conventional
 * `layer-<id>-*` ids. Only ids that actually exist on the map are returned.
 */
function geoEditorTargetAnchorLayerIds(map: maplibregl.Map, layer: GeoLibreLayer): string[] {
  const nativeLayerIds = layer.metadata.nativeLayerIds;
  // Filter to strings first, then fall back: a non-empty `nativeLayerIds` that
  // holds only non-string entries must still fall back to the conventional ids.
  const stringIds = Array.isArray(nativeLayerIds)
    ? nativeLayerIds.filter((id): id is string => typeof id === "string")
    : [];
  const candidates = stringIds.length > 0 ? stringIds : sketchesMapLayerIds(layer.id);
  return candidates.filter((id) => map.getLayer(id));
}

/**
 * Move the editor's overlay layers (Geoman's `gm_*` display layers and the
 * GeoEditor selection layers) to sit immediately above the edited layer's own
 * (hidden) map layers, so the features being edited render at that layer's
 * position in the tree.
 *
 * `MapController.syncLayers` reorders the store's layers on every layers change
 * and has no knowledge of the overlay, so without this the overlay drifts below
 * any layer stacked above the edited one and the edit features disappear behind
 * it (issue #1015). Idempotent: `planGeoEditorOverlayOrder` returns `null` when
 * the overlay is already in place, so the `styledata` that `moveLayer` triggers
 * does not loop.
 */
function positionGeoEditorOverlayLayers(): void {
  const map = appApi?.getMap?.();
  if (!map) return;
  const styleLayers = map.getStyle()?.layers;
  if (!styleLayers || styleLayers.length === 0) return;

  const target = activeEditableLayer(useAppStore.getState().layers);
  if (!target) return;
  const anchorIds = new Set(geoEditorTargetAnchorLayerIds(map, target));
  // Without the edited layer on the map there is no anchor; leave the overlay
  // where Geoman placed it (on top) rather than guessing a position.
  if (anchorIds.size === 0) return;

  const plan = planGeoEditorOverlayOrder(
    styleLayers.map((layer) => ({
      id: layer.id,
      isOverlay: isGeoEditorOverlayLayer(layer),
      isAnchor: anchorIds.has(layer.id),
    })),
  );
  if (!plan) return;

  // Moving each id before the same anchor preserves the overlay's draw order.
  for (const id of plan.overlayIds) {
    try {
      map.moveLayer(id, plan.beforeId);
    } catch {
      // A layer may have been removed by a concurrent style change.
    }
  }
}

function applyGeomanSketchesStyle(map: maplibregl.Map, sketchesLayer: GeoLibreLayer): void {
  const style = map.getStyle();
  if (!style?.layers) return;

  for (const layer of style.layers) {
    if (!isGeomanDisplayLayer(layer)) continue;
    applyGeomanDisplayLayerOpacity(map, layer, sketchesLayer.opacity);
    applyGeomanDisplayLayerWidth(map, layer, sketchesLayer.style);
    if (!isGeomanTextMarkerLayer(layer)) continue;
    try {
      map.setLayoutProperty(
        layer.id,
        "text-size",
        Math.max(1, styleValue(sketchesLayer.style, "textSize")),
      );
      map.setPaintProperty(layer.id, "text-color", styleValue(sketchesLayer.style, "textColor"));
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
      map.setPaintProperty(layer.id, "text-opacity", sketchesLayer.opacity);
    } catch {
      // Geoman may rebuild its temporary layers while an interaction is active.
    }
  }
}

/**
 * Mirror the Sketches layer's stroke width onto Geoman's committed-feature
 * display line layers. While the draw/edit tools are active the store Sketches
 * layer is suppressed and Geoman renders the existing features instead; without
 * this, those features fall back to Geoman's fixed default width, so a custom
 * (or scale-proportional "meters") stroke width would visibly revert. The
 * transient drawing aids (in-progress `gm_temporary-*` geometry and snap
 * guides) keep Geoman's defaults so editing stays legible.
 */
function applyGeomanDisplayLayerWidth(
  map: maplibregl.Map,
  layer: maplibregl.LayerSpecification,
  style: GeoLibreLayer["style"],
): void {
  if (layer.type !== "line") return;
  const id = layer.id.toLowerCase();
  if (!id.startsWith("gm_main") || id.includes("snap")) return;
  setGeomanPaintProperty(map, layer.id, "line-width", lineWidthValue(style));
}

function applyGeomanDisplayLayerOpacity(
  map: maplibregl.Map,
  layer: maplibregl.LayerSpecification,
  opacity: number,
): void {
  if (layer.type === "circle") {
    setGeomanPaintProperty(map, layer.id, "circle-opacity", opacity);
    setGeomanPaintProperty(map, layer.id, "circle-stroke-opacity", opacity);
  } else if (layer.type === "line") {
    setGeomanPaintProperty(map, layer.id, "line-opacity", opacity);
  } else if (layer.type === "fill") {
    setGeomanPaintProperty(map, layer.id, "fill-opacity", opacity);
  } else if (layer.type === "fill-extrusion") {
    setGeomanPaintProperty(map, layer.id, "fill-extrusion-opacity", opacity);
  } else if (layer.type === "symbol") {
    setGeomanPaintProperty(map, layer.id, "icon-opacity", opacity);
    setGeomanPaintProperty(map, layer.id, "text-opacity", opacity);
  }
}

function setGeomanPaintProperty(
  map: maplibregl.Map,
  layerId: string,
  property: string,
  value: unknown,
): void {
  try {
    map.setPaintProperty(layerId, property, value);
  } catch {
    // Geoman layers are rebuilt often and may not support every paint property.
  }
}

/**
 * Every map layer that belongs to the editor overlay and must be kept above the
 * edited layer: Geoman's `gm_*` display layers plus the GeoEditor's own
 * selection layers. Used only for z-ordering, so it is broader than
 * `isGeomanDisplayLayer` (which drives show/hide of the Geoman layers).
 *
 * The `geo-editor` prefix matches the layers `maplibre-gl-geo-editor` adds for
 * its selection highlight (observed ids `geo-editor-selection-{fill,line,
 * circle}-layer` on the `geo-editor-selection-source` source). The library does
 * not export those ids, so this stays a prefix heuristic; if a future version
 * renames them the overlay would simply not be re-stacked (a safe degradation,
 * no error). The Geoman `gm_*` layers are matched by `isGeomanDisplayLayer`.
 */
function isGeoEditorOverlayLayer(layer: maplibregl.LayerSpecification): boolean {
  if (isGeomanDisplayLayer(layer)) return true;
  const id = layer.id.toLowerCase();
  if (id.startsWith("geo-editor")) return true;
  if (!("source" in layer)) return false;
  const source = layer.source;
  return typeof source === "string" && source.startsWith("geo-editor");
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
    (source.startsWith("gm_") || source.startsWith("gm-") || source.startsWith("geoman"))
  );
}

function isGeomanTextMarkerLayer(
  layer: maplibregl.LayerSpecification,
): layer is maplibregl.SymbolLayerSpecification {
  if (layer.type !== "symbol" || !isGeomanDisplayLayer(layer)) return false;
  return JSON.stringify(layer.layout?.["text-field"] ?? "").includes(GEOMAN_TEXT_PROPERTY);
}
