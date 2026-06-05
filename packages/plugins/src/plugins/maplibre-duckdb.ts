import {
  DEFAULT_LAYER_STYLE,
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

type DuckDBControlConstructor =
  (typeof import("maplibre-gl-duckdb"))["DuckDBControl"];

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
};

type DuckDBResultLike = {
  bounds?: [number, number, number, number];
  geometryType?: string;
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

type MutableDuckDBControl = {
  beforeId?: string;
  layer?: DuckDBInternalLayer | null;
  renderLayer?: () => Promise<void>;
  renderer?: DuckDBRendererLike | null;
};

interface DuckDBRenderedStyle {
  opacity: number;
  style: LayerStyle;
  visible: boolean;
}

const duckdbControlPosition: GeoLibreMapControlPosition = "top-left";
const DUCKDB_SAMPLE_DATABASE_URL =
  "https://data.source.coop/giswqs/opengeos/nyc_data.db";

const DUCKDB_OPTIONS = {
  className: "geolibre-duckdb-control",
  collapsed: false,
  geometryColumn: "geom",
  layerName: "DuckDB query",
  panelWidth: 365,
  pickable: true,
  sampleDatabaseUrl: DUCKDB_SAMPLE_DATABASE_URL,
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

export function openDuckDBLayerPanel(app: GeoLibreAppAPI): void {
  void openStandaloneDuckDBControl(app);
}

async function openStandaloneDuckDBControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
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

function createDuckDBControl(
  DuckDBControlClass: DuckDBControlConstructor,
): DuckDBControl {
  const control = new DuckDBControlClass(DUCKDB_OPTIONS);
  control.on("collapse", () => hideDuckDBControl(control));
  control.on("query", createDuckDBQueryHandler());
  control.on("statechange", createDuckDBStateChangeHandler());

  duckdbStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    let shouldSyncControl = false;

    for (const layer of previous.layers) {
      if (!isDuckDBControlLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        removeDuckDBRenderedLayer(layer.id);
        continue;
      }

      if (!isDuckDBControlLayer(currentLayer)) continue;

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
      duckdbLayerOrderSignature(state.layers) !==
        duckdbLayerOrderSignature(previous.layers)
    ) {
      shouldSyncControl = true;
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
    const queryLayerName = createUniqueDuckDBLayerName(
      layerState.name,
      store.layers,
    );
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
      if (isDuckDBControlLayer(layer)) {
        store.removeLayer(layer.id);
      }
    }
  };
}

function createDuckDBStoreLayer(
  state: DuckDBState,
  layerState: DuckDBLayerState,
): GeoLibreLayer {
  return {
    id: layerState.id,
    name: layerState.name,
    type: "duckdb-query",
    source: {
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
      columns: layerState.schema,
      databaseSource: state.databaseSource,
      deckLayerId: layerState.id,
      displaySource: state.displaySource,
      externalDeckLayer: true,
      externalNativeLayer: true,
      geometryColumn: layerState.geometryColumn,
      geometryFormat: layerState.geometryFormat,
      identifiable: false,
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

function syncDuckDBRenderedLayersFromStore(layers: GeoLibreLayer[]): void {
  duckdbLayerOrder.clear();
  layers
    .filter(isDuckDBControlLayer)
    .forEach((layer, index) => duckdbLayerOrder.set(layer.id, index));

  for (const layer of layers) {
    if (!isDuckDBControlLayer(layer)) continue;

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

  renderer.__geolibreOriginalCreateLayers = renderer.createLayers.bind(
    renderer,
  );
  renderer.createLayers = (
    layerId: string,
    result: DuckDBResultLike,
    index: number,
  ) => {
    const renderedStyle = duckdbRenderedStyles.get(layerId);
    if (renderedStyle && !renderedStyle.visible) return [];

    const originalLayers = renderer.__geolibreOriginalCreateLayers?.(
      layerId,
      result,
      index,
    );
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
  const fillColor = colorToRgba(
    style.fillColor,
    opacity * style.fillOpacity,
  );
  const strokeColor = colorToRgba(style.strokeColor, opacity);
  const geometry = geometryType?.toLowerCase() ?? "";

  if (geometry.includes("point")) {
    return deckLayer.clone({
      getFillColor: fillColor,
      getRadius: style.circleRadius,
      radiusMaxPixels: pointRadiusMaxPixels(style),
      radiusMinPixels: Math.max(1, Math.min(style.circleRadius, 4)),
      updateTriggers: {
        ...asRecord(deckLayer.props?.updateTriggers),
        getFillColor: [style.fillColor, style.fillOpacity, opacity],
        getRadius: [style.circleRadius],
      },
    });
  }

  if (geometry.includes("line")) {
    return deckLayer.clone({
      getColor: strokeColor,
      getWidth: style.strokeWidth,
      widthMinPixels: Math.max(1, style.strokeWidth),
      updateTriggers: {
        ...asRecord(deckLayer.props?.updateTriggers),
        getColor: [style.strokeColor, opacity],
        getWidth: [style.strokeWidth],
      },
    });
  }

  return deckLayer.clone({
    elevationScale: style.extrusionHeightScale,
    extruded: style.extrusionEnabled,
    getFillColor: fillColor,
    getElevation: createDuckDBElevationAccessor(layerId, renderedStyle),
    getLineColor: strokeColor,
    getLineWidth: style.strokeWidth,
    lineWidthMinPixels: Math.max(1, style.strokeWidth),
    updateTriggers: {
      ...asRecord(deckLayer.props?.updateTriggers),
      getElevation: [
        style.extrusionBase,
        style.extrusionHeightProperty,
        style.extrusionHeightScale,
      ],
      getFillColor: [style.fillColor, style.fillOpacity, opacity],
      getLineColor: [style.strokeColor, opacity],
      getLineWidth: [style.strokeWidth],
    },
  });
}

function createDuckDBElevationAccessor(
  layerId: string,
  renderedStyle: DuckDBRenderedStyle,
) {
  return (objectInfo: { data?: unknown; index?: number }): number => {
    const { style } = renderedStyle;
    const fallbackHeight = style.extrusionBase ?? 100;
    const rowIndex = getGeoArrowRowIndex(objectInfo);
    const rows = getDuckDBRenderedRows(layerId);
    const row = rowIndex === null ? undefined : rows[rowIndex];
    const rawValue =
      row && style.extrusionHeightProperty
        ? row[style.extrusionHeightProperty]
        : undefined;
    const value = Number(rawValue);

    if (!Number.isFinite(value)) return fallbackHeight;
    return Math.max(0, value + style.extrusionBase);
  };
}

function getGeoArrowRowIndex(objectInfo: {
  data?: unknown;
  index?: number;
}): number | null {
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
    return rawIndex <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rawIndex) : index;
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

function warnMissingDuckDBRows(layerId: string): void {
  if (warnedMissingRowsLayerIds.has(layerId)) return;
  warnedMissingRowsLayerIds.add(layerId);

  if (import.meta.env.DEV) {
    console.warn(
      `DuckDB layer ${layerId} did not expose row data for extrusion heights.`,
    );
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

function isDuckDBControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "duckdb-query" &&
    layer.metadata.sourceKind === "duckdb-query" &&
    layer.metadata.externalDeckLayer === true
  );
}

function getMutableDuckDBControl(
  control = duckdbControl,
): MutableDuckDBControl | null {
  return control as unknown as MutableDuckDBControl | null;
}

function createDuckDBQueryLayerId(baseId: string): string {
  return `${baseId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createUniqueDuckDBLayerName(
  baseName: string,
  existingLayers: GeoLibreLayer[],
): string {
  const trimmedBaseName = baseName.trim() || "DuckDB query";
  const existingNames = new Set(existingLayers.map((layer) => layer.name));
  if (!existingNames.has(trimmedBaseName)) return trimmedBaseName;

  for (let index = 2; ; index += 1) {
    const candidate = `${trimmedBaseName} ${index}`;
    if (!existingNames.has(candidate)) return candidate;
  }
}

function duckdbLayerOrderSignature(layers: GeoLibreLayer[]): string {
  return layers.filter(isDuckDBControlLayer).map((layer) => layer.id).join("|");
}
