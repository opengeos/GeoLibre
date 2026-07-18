import {
  DEFAULT_LAYER_STYLE,
  isDuckDBQueryLayer,
  type GeoLibreLayer,
  type LayerStyle,
  useAppStore,
} from "@geolibre/core";
import type {
  DuckDBControl,
  DuckDBControlEventHandler,
  DuckDBControlOptions,
  DuckDBLayerState,
  DuckDBState,
} from "maplibre-gl-duckdb";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../types";
import {
  asRecord,
  colorToRgba,
  pointRadiusMaxPixels,
  type StyledDeckLayerLike,
} from "./deck-style-utils";
import { ensureMercatorProjection } from "./map-projection-utils";

type DuckDBControlConstructor = (typeof import("maplibre-gl-duckdb"))["DuckDBControl"];

/**
 * Whether the app is running in a Vite dev build. `import.meta.env` is not part
 * of the base `ImportMeta` type, so it is read through a cast (mirroring the
 * accessor in earth-engine-auth) rather than referencing `vite/client`.
 *
 * @returns True only in a development build.
 */
function isDevEnv(): boolean {
  return (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
}

type DuckDBRendererLike = {
  clear?: () => void;
  createLayers?: (
    layerId: string,
    result: DuckDBResultLike,
    index: number,
  ) => StyledDeckLayerLike[];
  setData?: (layers: DuckDBRenderedLayerLike[]) => void;
  __geolibreOriginalSetData?: DuckDBRendererLike["setData"];
  __geolibreStylePatched?: boolean;
  __geolibreOriginalCreateLayers?: DuckDBRendererLike["createLayers"];
  overlay?: DuckDBDeckOverlayLike;
  setSelectedFeature?: (layerId: string | null, index: number | null) => void;
};

type DuckDBResultLike = {
  bounds?: [number, number, number, number];
  geometryType?: string;
  table?: DuckDBArrowTableLike;
};

type DuckDBRenderedLayerLike = {
  beforeId?: string | null;
  id: string;
  name?: string;
  results: DuckDBResultLike[];
};

type DuckDBInternalLayer = Omit<DuckDBRenderedLayerLike, "results"> & {
  // The control's internal layer stores its tables as geoArrowResults;
  // results only exists on the objects passed to the renderer.
  results?: DuckDBResultLike[];
  geoArrowResults?: DuckDBResultLike[];
  geometryColumn?: string | null;
  geometryFormat?: string | null;
  query?: string;
  rows?: Record<number, Record<string, unknown>>;
  schema?: DuckDBLayerState["schema"];
  totalRows?: number;
};

type DuckDBPickInfo = {
  coordinate: [number, number] | null;
  index: number;
  layerId: string;
};

type DuckDBSelection = {
  index: number;
  layerId: string;
  layerName: string;
  properties: Record<string, unknown>;
};

type MutableDuckDBControl = {
  beforeId?: string;
  handleMapSelect?: (selection: DuckDBPickInfo | null) => void;
  layer?: DuckDBInternalLayer | null;
  popup?: { remove?: () => void } | null;
  renderLayer?: () => Promise<void>;
  renderContent?: () => void;
  renderer?: DuckDBRendererLike | null;
  selectedFeature?: DuckDBSelection | null;
  setPickable?: (pickable: boolean) => void;
  showAttributePopup?: (coordinate: [number, number] | null) => void;
  __geolibreOriginalShowAttributePopup?: MutableDuckDBControl["showAttributePopup"];
  __geolibreSelectionPatched?: boolean;
};

interface DuckDBRenderedStyle {
  opacity: number;
  style: LayerStyle;
  visible: boolean;
}

export interface DuckDBAttributeRow {
  featureId: string;
  index: number;
  properties: Record<string, unknown>;
}

export interface DuckDBIdentifyResult {
  coordinate: [number, number] | null;
  featureId: string;
  index: number;
  properties: Record<string, unknown>;
}

type DuckDBPickingInfo = {
  coordinate?: number[];
  index?: number;
  layer?: { id?: string };
  object?: Record<string, unknown>;
  picked?: boolean;
};

type DuckDBDeckOverlayLike = {
  pickObject?: (options: {
    layerIds?: string[];
    radius?: number;
    x: number;
    y: number;
  }) => DuckDBPickingInfo | null;
};

type DuckDBArrowFieldLike = {
  name?: string;
};

type DuckDBArrowVectorLike = {
  get?: (index: number) => unknown;
  length?: number;
};

type DuckDBArrowTableLike = {
  getChild?: (name: string) => DuckDBArrowVectorLike | null;
  numRows?: number;
  schema?: {
    fields?: DuckDBArrowFieldLike[];
  };
};

type DuckDBGlobalBridge = {
  getFeatureBounds: typeof getDuckDBFeatureBounds;
  getLayerRows: typeof getDuckDBLayerRows;
  identifyLayerAtPoint: typeof identifyDuckDBLayerAtPoint;
  setSelectedFeature: typeof setDuckDBSelectedFeature;
  updateLayerRows: typeof updateDuckDBLayerRows;
};

const duckdbControlPosition: GeoLibreMapControlPosition = "top-left";
const DUCKDB_SAMPLE_DATABASE_URL = "https://data.source.coop/giswqs/opengeos/nyc_data.db";

const DUCKDB_OPTIONS = {
  className: "geolibre-duckdb-control",
  collapsed: false,
  geometryColumn: "geom",
  layerName: "DuckDB query",
  panelWidth: 365,
  pickable: true,
  // Empty input; the sample database is the explicit, opt-in way to load one.
  sampleData: [{ label: "NYC data", url: DUCKDB_SAMPLE_DATABASE_URL }],
  sourceCrs: "EPSG:32618",
  title: "Add DuckDB Layer",
} satisfies DuckDBControlOptions;

let duckdbControl: DuckDBControl | null = null;
let duckdbControlMounted = false;
let duckdbStoreUnsubscribe: (() => void) | null = null;
let duckdbConstructorsPromise: Promise<{
  DuckDBControl: DuckDBControlConstructor;
}> | null = null;
const duckdbLayerOrder = new Map<string, number>();
const duckdbRenderedLayers = new Map<string, DuckDBRenderedLayerLike>();
const duckdbRenderedRows = new Map<string, Record<number, Record<string, unknown>>>();
const duckdbRenderedStyles = new Map<string, DuckDBRenderedStyle>();
const warnedMissingRowsLayerIds = new Set<string>();
// Global row index → local Arrow row index, built lazily per result chunk.
// Keyed weakly so replaced query results release their maps automatically.
const duckdbResultRowIndexMaps = new WeakMap<DuckDBResultLike, Map<number, number>>();
const DUCKDB_SELECTED_FILL_COLOR: [number, number, number, number] = [250, 204, 21, 230];
const DUCKDB_SELECTED_STROKE_COLOR: [number, number, number, number] = [17, 24, 39, 255];

declare global {
  interface Window {
    __GEOLIBRE_DUCKDB__?: DuckDBGlobalBridge;
  }
}

if (typeof window !== "undefined") {
  // Bridge consumed only by @geolibre/map (MapCanvas), which cannot import
  // this package directly. Do not widen this API; frozen so its members
  // cannot be swapped out by other scripts after construction.
  window.__GEOLIBRE_DUCKDB__ = Object.freeze({
    getFeatureBounds: getDuckDBFeatureBounds,
    getLayerRows: getDuckDBLayerRows,
    identifyLayerAtPoint: identifyDuckDBLayerAtPoint,
    setSelectedFeature: setDuckDBSelectedFeature,
    updateLayerRows: updateDuckDBLayerRows,
  });
}

export function openDuckDBLayerPanel(app: GeoLibreAppAPI): void {
  void openStandaloneDuckDBControl(app);
}

export function closeDuckDBLayerPanel(app: GeoLibreAppAPI): void {
  duckdbStoreUnsubscribe?.();
  duckdbStoreUnsubscribe = null;
  clearDuckDBRenderedLayers();
  if (duckdbControl && duckdbControlMounted) {
    app.removeMapControl(duckdbControl);
  }
  duckdbControl = null;
  duckdbControlMounted = false;
}

export function getDuckDBLayerRows(layerId: string): DuckDBAttributeRow[] {
  return Object.entries(getDuckDBRenderedRows(layerId))
    .map(([key, properties]) => {
      const numericKey = Number(key);
      const rowIndex =
        Number.isFinite(numericKey) && Number.isInteger(numericKey)
          ? numericKey
          : (getRowIndexFromProperties(properties) ?? 0);
      return {
        featureId: String(rowIndex),
        index: rowIndex,
        properties: publicDuckDBProperties(properties),
      };
    })
    .sort((first, second) => first.index - second.index);
}

export function setDuckDBSelectedFeature(layerId: string, featureId: string | null): void {
  if (!isKnownDuckDBLayer(layerId)) return;

  // Row indices are integers; reject fractional or non-numeric ids outright
  // so a bad id clears the selection instead of silently matching nothing.
  const numericId = featureId === null ? null : Number(featureId);
  const index = numericId !== null && Number.isInteger(numericId) ? numericId : null;
  getMutableDuckDBControl()?.renderer?.setSelectedFeature?.(index === null ? null : layerId, index);
  syncDuckDBControlSelection(layerId, index);
  renderDuckDBCachedLayers();
}

export function getDuckDBFeatureBounds(
  layerId: string,
  featureId: string,
): [number, number, number, number] | null {
  const index = Number(featureId);
  if (!Number.isFinite(index)) return null;

  const renderedLayer = duckdbRenderedLayers.get(layerId);
  if (!renderedLayer) return null;

  for (const result of renderedLayer.results) {
    const localRowIndex = getDuckDBResultLocalRowIndex(
      result,
      index,
      renderedLayer.results.length === 1,
    );
    if (localRowIndex === null) continue;

    const geometry = result.table?.getChild?.("geometry")?.get?.(localRowIndex);
    const bounds = boundsFromDuckDBGeometryValue(geometry);
    if (bounds) return bounds;
  }

  return null;
}

export function updateDuckDBLayerRows(
  layerId: string,
  updates: Record<string, Record<string, unknown>>,
): void {
  const rows = getDuckDBRenderedRows(layerId);
  if (Object.keys(rows).length === 0) return;

  for (const [featureId, properties] of Object.entries(updates)) {
    const index = Number(featureId);
    if (!Number.isFinite(index)) continue;

    const current = rows[index];
    if (!current) continue;

    rows[index] = {
      ...current,
      ...properties,
    };
  }

  const control = getMutableDuckDBControl();
  if (control?.layer?.id === layerId) {
    control.layer.rows = rows;
    if (control.selectedFeature?.layerId === layerId && rows[control.selectedFeature.index]) {
      control.selectedFeature = {
        ...control.selectedFeature,
        properties: rows[control.selectedFeature.index],
      };
    }
    control.renderContent?.();
  }

  renderDuckDBCachedLayers();
}

export function identifyDuckDBLayerAtPoint(
  layerId: string,
  point: { x: number; y: number },
): DuckDBIdentifyResult | null {
  if (!isKnownDuckDBLayer(layerId)) return null;

  const overlay = getMutableDuckDBControl()?.renderer?.overlay;
  const deckLayerIds = getDuckDBDeckLayerIds(layerId);
  const picked = overlay?.pickObject?.({
    x: point.x,
    y: point.y,
    radius: 5,
    layerIds: deckLayerIds.length > 0 ? deckLayerIds : undefined,
  });
  if (!picked?.picked || !isDuckDBDeckLayerId(layerId, picked.layer?.id)) {
    return null;
  }

  const index =
    getRowIndexFromProperties(picked.object) ??
    (typeof picked.index === "number" && Number.isFinite(picked.index) && picked.index >= 0
      ? picked.index
      : null);
  if (index === null) return null;

  const properties = getDuckDBRenderedRows(layerId)[index] ?? picked.object ?? {};

  return {
    coordinate:
      picked.coordinate && picked.coordinate.length >= 2
        ? [picked.coordinate[0], picked.coordinate[1]]
        : null,
    featureId: String(index),
    index,
    properties: publicDuckDBProperties(properties),
  };
}

async function openStandaloneDuckDBControl(app: GeoLibreAppAPI): Promise<boolean> {
  ensureMercatorProjection(app.getMap?.());

  const { DuckDBControl: DuckDBControlClass } = await getDuckDBConstructors();

  duckdbControl ??= createDuckDBControl(DuckDBControlClass);

  if (!duckdbControlMounted) {
    const added = app.addMapControl(duckdbControl, duckdbControlPosition);
    if (!added) {
      duckdbControl = null;
      return false;
    }
    duckdbControlMounted = true;
  }

  setTimeout(() => {
    showDuckDBControl(duckdbControl);
    duckdbControl?.expand();
  }, 0);
  return true;
}

function getDuckDBConstructors(): Promise<{
  DuckDBControl: DuckDBControlConstructor;
}> {
  duckdbConstructorsPromise ??= import("maplibre-gl-duckdb").then(
    ({ DuckDBControl: DuckDBControlClass }) => ({
      DuckDBControl: DuckDBControlClass,
    }),
  );
  return duckdbConstructorsPromise;
}

function createDuckDBControl(DuckDBControlClass: DuckDBControlConstructor): DuckDBControl {
  const control = new DuckDBControlClass(DUCKDB_OPTIONS);
  patchDuckDBControlSelection(control);
  syncDuckDBPickableFromStore();
  control.on("collapse", () => hideDuckDBControl(control));
  control.on("query", createDuckDBQueryHandler());
  control.on("statechange", createDuckDBStateChangeHandler());

  duckdbStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    let shouldSyncControl = false;

    for (const layer of previous.layers) {
      if (!isDuckDBQueryLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        removeDuckDBRenderedLayer(layer.id);
        continue;
      }

      if (!isDuckDBQueryLayer(currentLayer)) continue;

      if (
        currentLayer.opacity !== layer.opacity ||
        currentLayer.style !== layer.style ||
        currentLayer.visible !== layer.visible ||
        currentLayer.beforeId !== layer.beforeId ||
        currentLayer.name !== layer.name
      ) {
        shouldSyncControl = true;
      }
    }

    if (
      !shouldSyncControl &&
      duckdbLayerOrderSignature(state.layers) !== duckdbLayerOrderSignature(previous.layers)
    ) {
      shouldSyncControl = true;
    }

    if (state.identifyLayerId !== previous.identifyLayerId) {
      syncDuckDBPickableFromStore(state.layers, state.identifyLayerId);
    }

    if (shouldSyncControl) {
      syncDuckDBRenderedLayersFromStore(state.layers);
    }
  });

  return control;
}

function createDuckDBQueryHandler(): DuckDBControlEventHandler {
  return (event) => {
    const layerState = event.state.layer;
    if (!layerState) return;

    const store = useAppStore.getState();
    const controlLayer = getMutableDuckDBControl()?.layer;
    if (!controlLayer) {
      // Without the control's layer there is no geometry to render; skip
      // adding a ghost entry to the store.
      console.warn(
        "DuckDB query completed before the control layer was ready; the result will not be added to the layer list.",
      );
      return;
    }

    const queryLayerId = createDuckDBQueryLayerId(layerState.id);
    const queryLayerName = createUniqueDuckDBLayerName(layerState.name, store.layers);
    const nextLayerState = {
      ...layerState,
      id: queryLayerId,
      name: queryLayerName,
    };
    const layer = createDuckDBStoreLayer(event.state, nextLayerState);

    // Rename the control's internal layer to the unique query layer id so
    // its own follow-up renders and feature-select calls stay keyed to the
    // same id as the cached layer below. Verified against
    // maplibre-gl-duckdb 0.2.0: the renderer rebuilds all deck layers from
    // scratch on every setData call and the control builds a fresh layer
    // object (with complete rows) before emitting "query", so the rename
    // and the by-reference caches are safe. Re-check on library upgrades.
    controlLayer.id = queryLayerId;
    controlLayer.name = queryLayerName;
    duckdbRenderedLayers.set(layer.id, {
      beforeId: controlLayer.beforeId ?? nextLayerState.beforeId ?? null,
      id: layer.id,
      name: layer.name,
      results: controlLayer.results ?? controlLayer.geoArrowResults ?? [],
    });
    if (controlLayer.rows) {
      duckdbRenderedRows.set(layer.id, controlLayer.rows);
    }

    // Seed the style before addLayer so the store subscription's sync render
    // already picks it up, avoiding a second back-to-back render.
    duckdbRenderedStyles.set(layer.id, {
      opacity: layer.opacity,
      style: layer.style,
      visible: layer.visible,
    });
    store.addLayer(layer);
  };
}

function createDuckDBStateChangeHandler(): DuckDBControlEventHandler {
  return (event) => {
    if (event.state.layer) return;

    const store = useAppStore.getState();
    // Clear the caches first so the per-removal subscription syncs render
    // an empty set instead of flashing the remaining layers n-1 times.
    clearDuckDBRenderedLayers();
    for (const layer of store.layers) {
      if (isDuckDBQueryLayer(layer)) {
        store.removeLayer(layer.id);
      }
    }
  };
}

function createDuckDBStoreLayer(state: DuckDBState, layerState: DuckDBLayerState): GeoLibreLayer {
  const controlLayer = getMutableDuckDBControl()?.layer;
  const results = controlLayer?.results ?? controlLayer?.geoArrowResults ?? [];
  const bounds = combineResultBounds(results);
  const geometryTypes = getDuckDBGeometryTypes(results);

  return {
    id: layerState.id,
    name: layerState.name,
    type: "duckdb-query",
    source: {
      bounds,
      databaseSource: state.databaseSource,
      displaySource: state.displaySource,
      query: layerState.query,
      type: "duckdb",
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    beforeId: layerState.beforeId ?? undefined,
    metadata: {
      bounds,
      columns: layerState.schema,
      customLayerType: getDuckDBCustomLayerType(geometryTypes),
      databaseSource: state.databaseSource,
      deckLayerId: layerState.id,
      displaySource: state.displaySource,
      externalDeckLayer: true,
      externalNativeLayer: true,
      geometryColumn: layerState.geometryColumn,
      geometryFormat: layerState.geometryFormat,
      geometryTypes,
      identifiable: true,
      loadedRows: layerState.loadedRows,
      pageSize: state.pageSize,
      query: layerState.query,
      sourceKind: "duckdb-query",
      totalRows: layerState.totalRows,
    },
    sourcePath: state.databaseSource ?? state.displaySource,
  };
}

function removeDuckDBRenderedLayer(layerId: string): void {
  duckdbRenderedLayers.delete(layerId);
  duckdbRenderedRows.delete(layerId);
  duckdbRenderedStyles.delete(layerId);
  duckdbLayerOrder.delete(layerId);
  warnedMissingRowsLayerIds.delete(layerId);
  // No render here: removals are only observed via the store subscription,
  // whose layer-order signature check follows up with
  // syncDuckDBRenderedLayersFromStore and a single render.
}

function clearDuckDBRenderedLayers(): void {
  duckdbLayerOrder.clear();
  duckdbRenderedLayers.clear();
  duckdbRenderedRows.clear();
  duckdbRenderedStyles.clear();
  warnedMissingRowsLayerIds.clear();
  getMutableDuckDBControl()?.renderer?.clear?.();
}

function syncDuckDBPickableFromStore(
  layers = useAppStore.getState().layers,
  identifyLayerId = useAppStore.getState().identifyLayerId,
): void {
  const identifyLayer = layers.find((layer) => layer.id === identifyLayerId);
  getMutableDuckDBControl()?.setPickable?.(
    Boolean(identifyLayer && isDuckDBQueryLayer(identifyLayer)),
  );
}

function patchDuckDBControlSelection(control: DuckDBControl): void {
  const mutableControl = getMutableDuckDBControl(control);
  if (!mutableControl || mutableControl.__geolibreSelectionPatched) return;

  const originalHandleMapSelect = mutableControl.handleMapSelect?.bind(mutableControl);
  // Keep the original around (matching the __geolibreOriginalSetData pattern)
  // so future patches can inspect or restore the library behavior.
  mutableControl.__geolibreOriginalShowAttributePopup =
    mutableControl.showAttributePopup?.bind(mutableControl);
  // While identify mode targets a DuckDB layer, MapCanvas already handles the
  // click via identifyDuckDBLayerAtPoint and the selection store; letting the
  // control's own callbacks run too would process the same click twice and
  // show a duplicate popup. The control is only pickable in that mode (see
  // syncDuckDBPickableFromStore), so outside it the originals run unchanged.
  mutableControl.showAttributePopup = (coordinate) => {
    if (isDuckDBIdentifyModeActive()) return;
    mutableControl.__geolibreOriginalShowAttributePopup?.(coordinate);
  };
  mutableControl.handleMapSelect = (selection) => {
    if (isDuckDBIdentifyModeActive()) return;
    originalHandleMapSelect?.(selection);
  };
  mutableControl.__geolibreSelectionPatched = true;
}

function isDuckDBIdentifyModeActive(): boolean {
  const { identifyLayerId, layers } = useAppStore.getState();
  const identifyLayer = layers.find((layer) => layer.id === identifyLayerId);
  return Boolean(identifyLayer && isDuckDBQueryLayer(identifyLayer));
}

// Mirror the store-driven selection into the control's own attribute pane so
// it stays consistent with the map highlight and the attribute table.
function syncDuckDBControlSelection(layerId: string, index: number | null): void {
  const control = getMutableDuckDBControl();
  if (!control) return;

  if (index === null) {
    if (control.selectedFeature?.layerId !== layerId) return;
    control.selectedFeature = null;
    control.renderContent?.();
    return;
  }

  const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
  control.selectedFeature = {
    index,
    layerId,
    layerName: layer?.name ?? layerId,
    properties: getDuckDBRenderedRows(layerId)[index] ?? { __index: index },
  };
  control.popup?.remove?.();
  control.popup = null;
  control.renderContent?.();
}

function syncDuckDBRenderedLayersFromStore(layers: GeoLibreLayer[]): void {
  duckdbLayerOrder.clear();
  layers
    .filter(isDuckDBQueryLayer)
    .forEach((layer, index) => duckdbLayerOrder.set(layer.id, index));

  for (const layer of layers) {
    if (!isDuckDBQueryLayer(layer)) continue;

    const renderedLayer = duckdbRenderedLayers.get(layer.id);
    if (!renderedLayer) continue;

    renderedLayer.name = layer.name;
    renderedLayer.beforeId = layer.beforeId ?? null;

    duckdbRenderedStyles.set(layer.id, {
      opacity: layer.opacity,
      style: layer.style,
      visible: layer.visible,
    });
  }

  renderDuckDBCachedLayers();
}

function renderDuckDBCachedLayers(): void {
  const control = duckdbControl as unknown as MutableDuckDBControl | null;
  const renderer = control?.renderer;
  if (!renderer) return;

  patchDuckDBRenderer(renderer);
  const orderedLayers = getOrderedDuckDBRenderedLayers();
  (renderer.__geolibreOriginalSetData ?? renderer.setData)?.(orderedLayers);
}

function getOrderedDuckDBRenderedLayers(): DuckDBRenderedLayerLike[] {
  return [...duckdbRenderedLayers.values()].sort(compareDuckDBLayerOrder);
}

function compareDuckDBLayerOrder(
  first: DuckDBRenderedLayerLike,
  second: DuckDBRenderedLayerLike,
): number {
  return (
    (duckdbLayerOrder.get(first.id) ?? Number.MAX_SAFE_INTEGER) -
    (duckdbLayerOrder.get(second.id) ?? Number.MAX_SAFE_INTEGER)
  );
}

function patchDuckDBRenderer(renderer: DuckDBRendererLike | null | undefined) {
  if (!renderer || renderer.__geolibreStylePatched) return;

  if (renderer.setData && !renderer.__geolibreOriginalSetData) {
    renderer.__geolibreOriginalSetData = renderer.setData.bind(renderer);
    renderer.setData = (layers: DuckDBRenderedLayerLike[]) => {
      // The control's own follow-up renders (feature select, pickable
      // toggle) pass only its current layer, which would wipe the other
      // cached layers. Fold the fresh results into the cache and always
      // render the full ordered set instead.
      for (const incoming of layers) {
        const cached = duckdbRenderedLayers.get(incoming.id);
        if (cached) cached.results = incoming.results;
      }
      renderer.__geolibreOriginalSetData?.(getOrderedDuckDBRenderedLayers());
    };
  }

  // Leave the patched flag unset until createLayers is available so a later
  // call can finish the patch; the setData guard above keeps that retry
  // idempotent.
  if (!renderer.createLayers) return;

  renderer.__geolibreOriginalCreateLayers = renderer.createLayers.bind(renderer);
  renderer.createLayers = (layerId: string, result: DuckDBResultLike, index: number) => {
    const renderedStyle = duckdbRenderedStyles.get(layerId);
    if (renderedStyle && !renderedStyle.visible) return [];

    const originalLayers = renderer.__geolibreOriginalCreateLayers?.(layerId, result, index);
    if (!originalLayers) return [];

    if (!renderedStyle) return originalLayers;

    return originalLayers.map((deckLayer) =>
      cloneStyledDeckLayer(layerId, deckLayer, result.geometryType, renderedStyle),
    );
  };
  renderer.__geolibreStylePatched = true;
}

function cloneStyledDeckLayer(
  layerId: string,
  deckLayer: StyledDeckLayerLike,
  geometryType: string | undefined,
  renderedStyle: DuckDBRenderedStyle,
): StyledDeckLayerLike {
  if (!deckLayer.clone) return deckLayer;

  const { style, opacity } = renderedStyle;
  const fillColor = colorToRgba(style.fillColor, opacity * style.fillOpacity);
  const strokeColor = colorToRgba(style.strokeColor, opacity);
  const geometry = geometryType?.toLowerCase() ?? "";
  // Captured once per clone; updateTriggers below include it, so deck.gl
  // re-creates the accessors on selection changes and the closures never
  // read the store per object.
  const selectedFeatureId = getSelectedDuckDBFeatureId(layerId);

  if (geometry.includes("point")) {
    const selectedRadius = selectedDuckDBPointRadius(style.circleRadius);
    return deckLayer.clone({
      getFillColor: createDuckDBColorAccessor(selectedFeatureId, fillColor),
      getRadius: createDuckDBRadiusAccessor(selectedFeatureId, style.circleRadius),
      radiusMaxPixels: Math.max(pointRadiusMaxPixels(style), selectedRadius),
      radiusMinPixels: Math.max(1, Math.min(style.circleRadius, 4)),
      updateTriggers: {
        ...asRecord(deckLayer.props?.updateTriggers),
        getFillColor: [style.fillColor, style.fillOpacity, opacity, selectedFeatureId],
        getRadius: [style.circleRadius, selectedFeatureId],
      },
    });
  }

  if (geometry.includes("line")) {
    return deckLayer.clone({
      getColor: createDuckDBColorAccessor(selectedFeatureId, strokeColor),
      getWidth: createDuckDBLineWidthAccessor(selectedFeatureId, style.strokeWidth),
      widthMinPixels: Math.max(1, style.strokeWidth),
      updateTriggers: {
        ...asRecord(deckLayer.props?.updateTriggers),
        getColor: [style.strokeColor, opacity, selectedFeatureId],
        getWidth: [style.strokeWidth, selectedFeatureId],
      },
    });
  }

  return deckLayer.clone({
    elevationScale: style.extrusionHeightScale,
    extruded: style.extrusionEnabled,
    getFillColor: createDuckDBColorAccessor(selectedFeatureId, fillColor),
    getElevation: createDuckDBElevationAccessor(layerId, renderedStyle),
    getLineColor: createDuckDBLineColorAccessor(selectedFeatureId, strokeColor),
    getLineWidth: createDuckDBLineWidthAccessor(selectedFeatureId, style.strokeWidth),
    lineWidthMinPixels: Math.max(1, style.strokeWidth),
    updateTriggers: {
      ...asRecord(deckLayer.props?.updateTriggers),
      getElevation: [
        style.extrusionBase,
        style.extrusionHeightProperty,
        style.extrusionHeightScale,
      ],
      getFillColor: [style.fillColor, style.fillOpacity, opacity, selectedFeatureId],
      getLineColor: [style.strokeColor, opacity, selectedFeatureId],
      getLineWidth: [style.strokeWidth, selectedFeatureId],
    },
  });
}

function createDuckDBColorAccessor(
  selectedFeatureId: string | null,
  fallbackColor: [number, number, number, number],
) {
  return (objectInfo: { data?: unknown; index?: number }) =>
    isSelectedDuckDBObject(selectedFeatureId, objectInfo)
      ? DUCKDB_SELECTED_FILL_COLOR
      : fallbackColor;
}

function createDuckDBLineColorAccessor(
  selectedFeatureId: string | null,
  fallbackColor: [number, number, number, number],
) {
  return (objectInfo: { data?: unknown; index?: number }) =>
    isSelectedDuckDBObject(selectedFeatureId, objectInfo)
      ? DUCKDB_SELECTED_STROKE_COLOR
      : fallbackColor;
}

function createDuckDBRadiusAccessor(selectedFeatureId: string | null, fallbackRadius: number) {
  return (objectInfo: { data?: unknown; index?: number }) =>
    isSelectedDuckDBObject(selectedFeatureId, objectInfo)
      ? selectedDuckDBPointRadius(fallbackRadius)
      : fallbackRadius;
}

function selectedDuckDBPointRadius(fallbackRadius: number): number {
  return Math.max(fallbackRadius + 3, fallbackRadius * 1.6);
}

function createDuckDBLineWidthAccessor(selectedFeatureId: string | null, fallbackWidth: number) {
  return (objectInfo: { data?: unknown; index?: number }) =>
    isSelectedDuckDBObject(selectedFeatureId, objectInfo)
      ? Math.max(fallbackWidth + 3, fallbackWidth * 2)
      : fallbackWidth;
}

function isSelectedDuckDBObject(
  selectedFeatureId: string | null,
  objectInfo: { data?: unknown; index?: number },
): boolean {
  if (selectedFeatureId === null) return false;

  const rowIndex = getGeoArrowRowIndex(objectInfo);
  return rowIndex !== null && String(rowIndex) === selectedFeatureId;
}

function getSelectedDuckDBFeatureId(layerId: string): string | null {
  const state = useAppStore.getState();
  return state.selectedLayerId === layerId ? state.selectedFeatureId : null;
}

function createDuckDBElevationAccessor(layerId: string, renderedStyle: DuckDBRenderedStyle) {
  return (objectInfo: { data?: unknown; index?: number }): number => {
    const { style } = renderedStyle;
    const fallbackHeight = style.extrusionBase ?? 100;
    const rowIndex = getGeoArrowRowIndex(objectInfo);
    const rows = getDuckDBRenderedRows(layerId);
    const row = rowIndex === null ? undefined : rows[rowIndex];
    const rawValue =
      row && style.extrusionHeightProperty ? row[style.extrusionHeightProperty] : undefined;
    const value = Number(rawValue);

    if (!Number.isFinite(value)) return fallbackHeight;
    return Math.max(0, value + style.extrusionBase);
  };
}

function getGeoArrowRowIndex(objectInfo: { data?: unknown; index?: number }): number | null {
  const table = (
    objectInfo.data as
      | {
          data?: {
            getChild?: (name: string) => { get?: (index: number) => unknown } | null;
          };
        }
      | undefined
  )?.data;
  const index = objectInfo.index;
  if (typeof index !== "number") return null;

  const rawIndex = table?.getChild?.("__index")?.get?.(index);
  if (typeof rawIndex === "number" && Number.isFinite(rawIndex)) {
    return rawIndex;
  }
  if (typeof rawIndex === "bigint") {
    return rawIndex >= BigInt(0) && rawIndex <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(rawIndex)
      : index;
  }
  return index;
}

function getDuckDBRenderedRows(layerId: string): Record<number, Record<string, unknown>> {
  const cachedRows = duckdbRenderedRows.get(layerId);
  if (cachedRows) return cachedRows;

  const control = duckdbControl as unknown as MutableDuckDBControl | null;
  const stateLayerId = duckdbControl?.getState().layer?.id;
  if (stateLayerId !== layerId) return {};
  const rows = control?.layer?.rows;
  if (!rows) {
    warnMissingDuckDBRows(layerId);
    return {};
  }
  return rows;
}

function combineResultBounds(
  results: DuckDBResultLike[] | undefined,
): [number, number, number, number] | undefined {
  const bounds = (results ?? []).map((result) => result.bounds).filter(isBounds);
  if (bounds.length === 0) return undefined;

  return [
    Math.min(...bounds.map((item) => item[0])),
    Math.min(...bounds.map((item) => item[1])),
    Math.max(...bounds.map((item) => item[2])),
    Math.max(...bounds.map((item) => item[3])),
  ];
}

function isBounds(value: unknown): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function getDuckDBGeometryTypes(results: DuckDBResultLike[]): string[] {
  return Array.from(
    new Set(
      results
        .map((result) => result.geometryType)
        .filter((item): item is string => typeof item === "string"),
    ),
  );
}

function getDuckDBCustomLayerType(geometryTypes: string[]): string {
  const normalized = geometryTypes.map((type) => type.toLowerCase());
  if (normalized.some((type) => type.includes("point"))) return "circle";
  if (normalized.some((type) => type.includes("line"))) return "line";
  if (normalized.some((type) => type.includes("polygon"))) return "fill";
  return "custom";
}

function getDuckDBDeckLayerIds(layerId: string): string[] {
  const renderedLayer = duckdbRenderedLayers.get(layerId);
  const results = renderedLayer?.results ?? [];
  // Mirrors the deck layer naming scheme of maplibre-gl-duckdb 0.2.0
  // (`duckdb-<layerId>-<geometryType>-<resultIndex>`); revisit on upgrades.
  const ids = results
    .map((result, index) =>
      result.geometryType ? `duckdb-${layerId}-${result.geometryType}-${index}` : null,
    )
    .filter((id): id is string => typeof id === "string");
  if (ids.length === 0 && results.length > 0 && isDevEnv()) {
    console.warn(
      `DuckDB layer ${layerId} has results without geometry types; identify picking may match nothing.`,
    );
  }
  return ids;
}

function getDuckDBResultLocalRowIndex(
  result: DuckDBResultLike,
  rowIndex: number,
  isOnlyResult: boolean,
): number | null {
  const indexVector = result.table?.getChild?.("__index");
  const rowCount =
    typeof result.table?.numRows === "number" ? result.table.numRows : indexVector?.length;
  if (typeof rowCount !== "number" || rowCount <= 0) return null;

  if (!indexVector?.get) {
    // Without an __index column a global row index cannot be attributed to
    // one chunk among several; only a lone chunk, whose rows are stored in
    // natural order, can be addressed directly.
    if (!isOnlyResult) return null;
    return rowIndex >= 0 && rowIndex < rowCount ? rowIndex : null;
  }

  let indexMap = duckdbResultRowIndexMaps.get(result);
  if (!indexMap) {
    // Build the global → local index map once per result so repeated lookups
    // (one per zoom-to-feature) do not rescan the Arrow column.
    indexMap = new Map();
    for (let localIndex = 0; localIndex < rowCount; localIndex += 1) {
      const value = indexVector.get(localIndex);
      if (typeof value === "number" && Number.isFinite(value)) {
        indexMap.set(value, localIndex);
      } else if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
        indexMap.set(Number(value), localIndex);
      }
    }
    duckdbResultRowIndexMaps.set(result, indexMap);
  }
  return indexMap.get(rowIndex) ?? null;
}

function boundsFromDuckDBGeometryValue(value: unknown): [number, number, number, number] | null {
  const bounds = createEmptyBounds();
  collectGeometryBounds(value, bounds);
  return isFiniteBounds(bounds) ? bounds : null;
}

function collectGeometryBounds(
  value: unknown,
  bounds: [number, number, number, number],
  depth = 0,
): void {
  // Well-formed GeoArrow geometries nest a handful of levels at most; the
  // cap keeps malformed data from recursing unboundedly.
  if (!value || depth > 10) return;

  if (Array.isArray(value)) {
    if (value.length >= 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1])) {
      extendBounds(bounds, value[0], value[1]);
      return;
    }
    for (const item of value) collectGeometryBounds(item, bounds, depth + 1);
    return;
  }

  const vector = value as DuckDBArrowVectorLike;
  if (typeof vector.get !== "function" || typeof vector.length !== "number") {
    return;
  }

  if (vector.length >= 2 && isFiniteNumber(vector.get(0)) && isFiniteNumber(vector.get(1))) {
    extendBounds(bounds, vector.get(0) as number, vector.get(1) as number);
    return;
  }

  for (let index = 0; index < vector.length; index += 1) {
    collectGeometryBounds(vector.get(index), bounds, depth + 1);
  }
}

function createEmptyBounds(): [number, number, number, number] {
  return [Infinity, Infinity, -Infinity, -Infinity];
}

function extendBounds(bounds: [number, number, number, number], x: number, y: number): void {
  bounds[0] = Math.min(bounds[0], x);
  bounds[1] = Math.min(bounds[1], y);
  bounds[2] = Math.max(bounds[2], x);
  bounds[3] = Math.max(bounds[3], y);
}

function isFiniteBounds(
  bounds: [number, number, number, number],
): bounds is [number, number, number, number] {
  return bounds.every((value) => Number.isFinite(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isDuckDBDeckLayerId(layerId: string, deckLayerId: string | undefined): boolean {
  return typeof deckLayerId === "string" && deckLayerId.startsWith(`duckdb-${layerId}-`);
}

function isKnownDuckDBLayer(layerId: string): boolean {
  return duckdbRenderedLayers.has(layerId) || duckdbRenderedRows.has(layerId);
}

function getRowIndexFromProperties(properties: Record<string, unknown> | undefined): number | null {
  const rawIndex = properties?.__index;
  if (typeof rawIndex === "number" && Number.isFinite(rawIndex)) return rawIndex;
  if (
    typeof rawIndex === "bigint" &&
    rawIndex >= BigInt(0) &&
    rawIndex <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(rawIndex);
  }
  return null;
}

function publicDuckDBProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).filter(([key]) => !key.startsWith("__")));
}

function warnMissingDuckDBRows(layerId: string): void {
  if (warnedMissingRowsLayerIds.has(layerId)) return;
  warnedMissingRowsLayerIds.add(layerId);

  if (isDevEnv()) {
    console.warn(`DuckDB layer ${layerId} did not expose row data for extrusion heights.`);
  }
}

function hideDuckDBControl(control: DuckDBControl | null): void {
  const container = control?.getContainer();
  if (container) container.style.display = "none";
}

function showDuckDBControl(control: DuckDBControl | null): void {
  const container = control?.getContainer();
  if (container) container.style.display = "";
}

function getMutableDuckDBControl(control = duckdbControl): MutableDuckDBControl | null {
  return control as unknown as MutableDuckDBControl | null;
}

function createDuckDBQueryLayerId(baseId: string): string {
  return `${baseId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createUniqueDuckDBLayerName(baseName: string, existingLayers: GeoLibreLayer[]): string {
  const trimmedBaseName = baseName.trim() || "DuckDB query";
  const existingNames = new Set(existingLayers.map((layer) => layer.name));
  if (!existingNames.has(trimmedBaseName)) return trimmedBaseName;

  for (let index = 2; ; index += 1) {
    const candidate = `${trimmedBaseName} ${index}`;
    if (!existingNames.has(candidate)) return candidate;
  }
}

function duckdbLayerOrderSignature(layers: GeoLibreLayer[]): string {
  return layers
    .filter(isDuckDBQueryLayer)
    .map((layer) => layer.id)
    .join("|");
}
