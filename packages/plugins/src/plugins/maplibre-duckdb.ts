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

type DuckDBControlConstructor =
  (typeof import("maplibre-gl-duckdb"))["DuckDBControl"];

type DuckDBRendererLike = {
  clear?: () => void;
  createLayers?: (
    layerId: string,
    result: { geometryType?: string },
    index: number,
  ) => StyledDeckLayerLike[];
  __geolibreStylePatched?: boolean;
  __geolibreOriginalCreateLayers?: DuckDBRendererLike["createLayers"];
};

type MutableDuckDBControl = {
  beforeId?: string;
  layer?: {
    beforeId: string | null;
  } | null;
  renderLayer?: () => Promise<void>;
  renderer?: DuckDBRendererLike | null;
};

type StyledDeckLayerLike = {
  id?: string;
  clone?: (props: Record<string, unknown>) => StyledDeckLayerLike;
  props?: Record<string, unknown>;
};

interface DuckDBRenderedStyle {
  opacity: number;
  style: LayerStyle;
}

const duckdbControlPosition: GeoLibreMapControlPosition = "top-left";
const DUCKDB_SAMPLE_DATABASE_URL =
  "https://data.source.coop/giswqs/opengeos/nyc_data.db";
const DUCKDB_SAMPLE_QUERY = `SELECT BORONAME, NAME, ST_Transform(geom, 'EPSG:32618', 'EPSG:4326', true) AS geom
FROM data.main.nyc_neighborhoods
LIMIT 1000`;

const DUCKDB_OPTIONS = {
  className: "geolibre-duckdb-control",
  collapsed: false,
  geometryColumn: "geom",
  initialQuery: DUCKDB_SAMPLE_QUERY,
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
const duckdbRenderedStyles = new Map<string, DuckDBRenderedStyle>();

export function openDuckDBLayerPanel(app: GeoLibreAppAPI): void {
  void openStandaloneDuckDBControl(app);
}

async function openStandaloneDuckDBControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
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

    for (const layer of previous.layers) {
      if (!isDuckDBControlLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        removeDuckDBRenderedLayer(layer.id);
        continue;
      }

      if (!isDuckDBControlLayer(currentLayer)) continue;

      if (currentLayer.visible !== layer.visible) {
        setDuckDBRenderedLayerVisible(currentLayer.visible);
      }

      if (
        currentLayer.opacity !== layer.opacity ||
        currentLayer.style !== layer.style
      ) {
        setDuckDBRenderedLayerStyle(currentLayer);
      }

      if (currentLayer.beforeId !== layer.beforeId) {
        setDuckDBRenderedLayerBeforeId(currentLayer.beforeId ?? null);
      }
    }
  });

  return control;
}

function createDuckDBQueryHandler(): DuckDBControlEventHandler {
  return (event) => {
    const layerState = event.state.layer;
    if (!layerState) return;

    const store = useAppStore.getState();
    const existingLayer = store.layers.find((layer) => layer.id === layerState.id);
    const layer = createDuckDBStoreLayer(event.state, layerState, existingLayer);

    if (existingLayer) {
      store.updateLayer(layer.id, {
        metadata: layer.metadata,
        name: layer.name,
        source: layer.source,
        sourcePath: layer.sourcePath,
        style: layer.style,
      });
      setDuckDBRenderedLayerVisible(layer.visible);
      setDuckDBRenderedLayerBeforeId(layer.beforeId ?? null);
      setDuckDBRenderedLayerStyle(layer);
      return;
    }

    store.addLayer(layer);
    setDuckDBRenderedLayerVisible(layer.visible);
    setDuckDBRenderedLayerBeforeId(layer.beforeId ?? null);
    setDuckDBRenderedLayerStyle(layer);
  };
}

function createDuckDBStateChangeHandler(): DuckDBControlEventHandler {
  return (event) => {
    if (event.state.layer) return;

    const store = useAppStore.getState();
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
  existingLayer?: GeoLibreLayer,
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
    visible: existingLayer?.visible ?? true,
    opacity: existingLayer?.opacity ?? 1,
    style: existingLayer?.style ?? { ...DEFAULT_LAYER_STYLE },
    beforeId: layerState.beforeId ?? existingLayer?.beforeId,
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
  const stateLayerId = duckdbControl?.getState().layer?.id;
  if (stateLayerId !== layerId) return;
  duckdbRenderedStyles.delete(layerId);
  duckdbControl?.clear();
}

function setDuckDBRenderedLayerVisible(visible: boolean): void {
  const control = duckdbControl as unknown as MutableDuckDBControl | null;
  if (!control) return;

  if (!visible) {
    control.renderer?.clear?.();
    return;
  }

  void control.renderLayer?.();
}

function setDuckDBRenderedLayerStyle(layer: GeoLibreLayer): void {
  duckdbRenderedStyles.set(layer.id, {
    opacity: layer.opacity,
    style: layer.style,
  });
  void renderStyledDuckDBLayer();
}

async function renderStyledDuckDBLayer(): Promise<void> {
  const control = duckdbControl as unknown as MutableDuckDBControl | null;
  if (!control) return;

  if (!control.renderer) {
    await control.renderLayer?.();
  }
  patchDuckDBRenderer(control.renderer);
  await control.renderLayer?.();
}

function patchDuckDBRenderer(renderer: DuckDBRendererLike | null | undefined) {
  if (!renderer?.createLayers || renderer.__geolibreStylePatched) return;

  renderer.__geolibreOriginalCreateLayers = renderer.createLayers.bind(
    renderer,
  );
  renderer.createLayers = (
    layerId: string,
    result: { geometryType?: string },
    index: number,
  ) => {
    const originalLayers = renderer.__geolibreOriginalCreateLayers?.(
      layerId,
      result,
      index,
    );
    if (!originalLayers) return [];

    const renderedStyle = duckdbRenderedStyles.get(layerId);
    if (!renderedStyle) return originalLayers;

    return originalLayers.map((deckLayer) =>
      cloneStyledDeckLayer(deckLayer, result.geometryType, renderedStyle),
    );
  };
  renderer.__geolibreStylePatched = true;
}

function cloneStyledDeckLayer(
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
      radiusMaxPixels: Math.max(style.circleRadius * 2, style.circleRadius),
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
    getFillColor: fillColor,
    getLineColor: strokeColor,
    getLineWidth: style.strokeWidth,
    lineWidthMinPixels: Math.max(1, style.strokeWidth),
    updateTriggers: {
      ...asRecord(deckLayer.props?.updateTriggers),
      getFillColor: [style.fillColor, style.fillOpacity, opacity],
      getLineColor: [style.strokeColor, opacity],
      getLineWidth: [style.strokeWidth],
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function colorToRgba(color: string, alpha: number): [number, number, number, number] {
  const normalized = color.trim();
  const hex =
    normalized.length === 4 && normalized.startsWith("#")
      ? `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`
      : normalized;
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return [59, 130, 246, Math.round(clamp(alpha, 0, 1) * 255)];

  const value = Number.parseInt(match[1], 16);
  return [
    (value >> 16) & 255,
    (value >> 8) & 255,
    value & 255,
    Math.round(clamp(alpha, 0, 1) * 255),
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function setDuckDBRenderedLayerBeforeId(beforeId: string | null): void {
  const control = duckdbControl as unknown as MutableDuckDBControl | null;
  if (!control) return;

  control.beforeId = beforeId ?? "";
  if (control.layer) control.layer.beforeId = beforeId;
  void control.renderLayer?.();
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
