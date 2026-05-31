import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  type LayerStyle,
  useAppStore,
} from "@geolibre/core";
import type {
  GeoParquetControl,
  GeoParquetControlEventHandler,
  GeoParquetControlOptions,
  GeoParquetLayerState,
} from "maplibre-gl-geoparquet";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../types";

type GeoParquetControlConstructor =
  (typeof import("maplibre-gl-geoparquet"))["GeoParquetControl"];

type GeoParquetRenderedStyle = {
  opacity: number;
  style: LayerStyle;
  visible: boolean;
};

type GeoParquetResultLike = {
  bounds?: [number, number, number, number];
  geometryType?: string;
};

type GeoParquetInternalLayer = {
  beforeId?: string | null;
  displaySource: string;
  geoArrowResults?: GeoParquetResultLike[];
  id: string;
  name: string;
  rows?: Record<number, Record<string, unknown>>;
};

type MutableGeoParquetControl = {
  activeLayerId?: string | null;
  layers?: GeoParquetInternalLayer[];
  renderAllLayers?: () => void;
  renderer?: GeoParquetRendererLike | null;
};

type GeoParquetRendererLike = {
  __geolibreOriginalCreateLayers?: GeoParquetRendererLike["createLayers"];
  __geolibreStylePatched?: boolean;
  createLayers?: (
    layerId: string,
    result: GeoParquetResultLike,
    index: number,
  ) => StyledDeckLayerLike[];
};

type StyledDeckLayerLike = {
  clone?: (props: Record<string, unknown>) => StyledDeckLayerLike;
  props?: Record<string, unknown>;
};

const geoparquetControlPosition: GeoLibreMapControlPosition = "top-left";

const GEOPARQUET_OPTIONS = {
  className: "geolibre-geoparquet-control",
  collapsed: false,
  interleaved: true,
  panelWidth: 365,
  pickable: true,
  title: "Add GeoParquet Layer",
} satisfies GeoParquetControlOptions;

let geoparquetControl: GeoParquetControl | null = null;
let geoparquetControlMounted = false;
let geoparquetConstructorsPromise: Promise<{
  GeoParquetControl: GeoParquetControlConstructor;
}> | null = null;
let geoparquetStoreUnsubscribe: (() => void) | null = null;
const geoparquetRenderedStyles = new Map<string, GeoParquetRenderedStyle>();

export function openGeoParquetLayerPanel(app: GeoLibreAppAPI): void {
  void openStandaloneGeoParquetControl(app);
}

async function openStandaloneGeoParquetControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
  const { GeoParquetControl: GeoParquetControlClass } =
    await getGeoParquetConstructors();

  geoparquetControl ??= createGeoParquetControl(GeoParquetControlClass);

  if (!geoparquetControlMounted) {
    const added = app.addMapControl(
      geoparquetControl,
      geoparquetControlPosition,
    );
    if (!added) {
      geoparquetControl = null;
      return false;
    }
    geoparquetControlMounted = true;
    patchGeoParquetRenderer(getMutableGeoParquetControl().renderer);
  }

  setTimeout(() => {
    showGeoParquetControl(geoparquetControl);
    geoparquetControl?.expand();
    patchGeoParquetRenderer(getMutableGeoParquetControl().renderer);
  }, 0);
  return true;
}

function getGeoParquetConstructors(): Promise<{
  GeoParquetControl: GeoParquetControlConstructor;
}> {
  geoparquetConstructorsPromise ??= import("maplibre-gl-geoparquet").then(
    ({ GeoParquetControl: GeoParquetControlClass }) => ({
      GeoParquetControl: GeoParquetControlClass,
    }),
  );
  return geoparquetConstructorsPromise;
}

function createGeoParquetControl(
  GeoParquetControlClass: GeoParquetControlConstructor,
): GeoParquetControl {
  const control = new GeoParquetControlClass(GEOPARQUET_OPTIONS);
  control.on("collapse", () => hideGeoParquetControl(control));
  control.on("load", createGeoParquetStateChangeHandler(control));
  control.on("statechange", createGeoParquetStateChangeHandler(control));

  geoparquetStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    for (const layer of previous.layers) {
      if (!isGeoParquetControlLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        geoparquetControl?.removeLayer(layer.id);
        geoparquetRenderedStyles.delete(layer.id);
        continue;
      }

      if (!isGeoParquetControlLayer(currentLayer)) continue;

      if (
        currentLayer.visible !== layer.visible ||
        currentLayer.opacity !== layer.opacity ||
        currentLayer.style !== layer.style ||
        currentLayer.beforeId !== layer.beforeId ||
        currentLayer.name !== layer.name
      ) {
        syncGeoParquetControlFromStore(state.layers);
      }
    }

    if (geoparquetLayerOrderSignature(state.layers) !==
      geoparquetLayerOrderSignature(previous.layers)) {
      syncGeoParquetControlFromStore(state.layers);
    }
  });

  return control;
}

function createGeoParquetStateChangeHandler(
  control: GeoParquetControl,
): GeoParquetControlEventHandler {
  return (event) => {
    patchGeoParquetRenderer(getMutableGeoParquetControl(control).renderer);

    const store = useAppStore.getState();
    const controlLayerIds = new Set(
      event.state.layers.map((layer) => layer.id),
    );

    for (const existingLayer of store.layers) {
      if (!isGeoParquetControlLayer(existingLayer)) continue;
      if (!controlLayerIds.has(existingLayer.id)) {
        store.removeLayer(existingLayer.id);
      }
    }

    for (const layerState of event.state.layers) {
      const existingLayer = store.layers.find(
        (layer) => layer.id === layerState.id,
      );
      const layer = createGeoParquetStoreLayer(layerState, existingLayer);
      geoparquetRenderedStyles.set(layer.id, {
        opacity: layer.opacity,
        style: layer.style,
        visible: layer.visible,
      });

      if (existingLayer) {
        const patch = createGeoParquetLayerPatch(existingLayer, layer);
        if (patch) store.updateLayer(layer.id, patch);
        continue;
      }

      store.addLayer(layer);
    }

    syncGeoParquetControlFromStore(useAppStore.getState().layers);
  };
}

function createGeoParquetStoreLayer(
  layerState: GeoParquetLayerState,
  existingLayer?: GeoLibreLayer,
): GeoLibreLayer {
  const bounds = getGeoParquetLayerBounds(layerState);
  const geometryTypes = getGeoParquetGeometryTypes(layerState);
  const sourcePath = layerState.displaySource || layerState.source;

  return {
    id: layerState.id,
    name: layerState.name || layerNameFromUrl(sourcePath, layerState.id),
    type: "geoparquet",
    source: {
      bounds,
      displaySource: layerState.displaySource,
      sourceId: layerState.id,
      type: "geoparquet",
      url: layerState.source,
    },
    visible: existingLayer?.visible ?? true,
    opacity: existingLayer?.opacity ?? 1,
    style: existingLayer?.style ?? { ...DEFAULT_LAYER_STYLE },
    beforeId: existingLayer?.beforeId ?? layerState.beforeId ?? undefined,
    metadata: {
      bounds,
      columns: layerState.schema,
      customLayerType: getGeoParquetCustomLayerType(geometryTypes),
      deckLayerId: layerState.id,
      externalDeckLayer: true,
      fileInfo: layerState.metadata?.fileInfo ?? null,
      geoMetadata: layerState.metadata?.geoMetadata ?? null,
      geometryTypes,
      identifiable: false,
      loadedRows: layerState.loadedRows,
      pageSize: layerState.pageSize,
      primaryGeoColumn: layerState.primaryGeoColumn,
      selectedColumns: layerState.selectedColumns,
      sourceId: layerState.id,
      sourceKind: "geoparquet-url",
      totalRows: layerState.totalRows,
    },
    sourcePath,
  };
}

function createGeoParquetLayerPatch(
  existingLayer: GeoLibreLayer,
  nextLayer: GeoLibreLayer,
): Partial<GeoLibreLayer> | null {
  const patch: Partial<GeoLibreLayer> = {};

  if (existingLayer.name !== nextLayer.name) patch.name = nextLayer.name;
  if (existingLayer.beforeId !== nextLayer.beforeId) {
    patch.beforeId = nextLayer.beforeId;
  }
  if (!shallowEqualRecord(existingLayer.source, nextLayer.source)) {
    patch.source = nextLayer.source;
  }
  if (!shallowEqualRecord(existingLayer.metadata, nextLayer.metadata)) {
    patch.metadata = nextLayer.metadata;
  }
  if (existingLayer.sourcePath !== nextLayer.sourcePath) {
    patch.sourcePath = nextLayer.sourcePath;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function syncGeoParquetControlFromStore(layers: GeoLibreLayer[]): void {
  const mutableControl = getMutableGeoParquetControl();
  const controlLayers = mutableControl.layers;
  if (!controlLayers) return;

  const storeLayerById = new Map(layers.map((layer) => [layer.id, layer]));
  const storeOrder = new Map(layers.map((layer, index) => [layer.id, index]));

  controlLayers.sort(
    (a, b) =>
      (storeOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (storeOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );

  for (const controlLayer of controlLayers) {
    const storeLayer = storeLayerById.get(controlLayer.id);
    if (!storeLayer || !isGeoParquetControlLayer(storeLayer)) continue;
    controlLayer.name = storeLayer.name;
    controlLayer.beforeId = storeLayer.beforeId ?? null;
    geoparquetRenderedStyles.set(storeLayer.id, {
      opacity: storeLayer.opacity,
      style: storeLayer.style,
      visible: storeLayer.visible,
    });
  }

  patchGeoParquetRenderer(mutableControl.renderer);
  mutableControl.renderAllLayers?.();
}

function patchGeoParquetRenderer(
  renderer: GeoParquetRendererLike | null | undefined,
): void {
  if (!renderer?.createLayers || renderer.__geolibreStylePatched) return;

  renderer.__geolibreOriginalCreateLayers = renderer.createLayers.bind(
    renderer,
  );
  renderer.createLayers = (
    layerId: string,
    result: GeoParquetResultLike,
    index: number,
  ) => {
    const renderedStyle = geoparquetRenderedStyles.get(layerId);
    if (renderedStyle && !renderedStyle.visible) return [];

    const originalLayers = renderer.__geolibreOriginalCreateLayers?.(
      layerId,
      result,
      index,
    );
    if (!originalLayers || !renderedStyle) return originalLayers ?? [];

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
  renderedStyle: GeoParquetRenderedStyle,
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
    elevationScale: style.extrusionHeightScale,
    extruded: style.extrusionEnabled,
    getElevation: createGeoParquetElevationAccessor(layerId, renderedStyle),
    getFillColor: fillColor,
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

function createGeoParquetElevationAccessor(
  layerId: string,
  renderedStyle: GeoParquetRenderedStyle,
) {
  return (objectInfo: { index?: number; object?: Record<string, unknown> }): number => {
    const { style } = renderedStyle;
    const fallbackHeight = style.extrusionBase ?? 100;
    const rowIndex = getGeoParquetRowIndex(objectInfo);
    const rows = getGeoParquetRenderedRows(layerId);
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

function getGeoParquetRowIndex(objectInfo: {
  index?: number;
  object?: Record<string, unknown>;
}): number | null {
  const rawIndex = objectInfo.object?.__index;
  if (typeof rawIndex === "number" && Number.isFinite(rawIndex)) {
    return rawIndex;
  }
  if (typeof rawIndex === "bigint") {
    return rawIndex <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(rawIndex)
      : (objectInfo.index ?? null);
  }
  return typeof objectInfo.index === "number" ? objectInfo.index : null;
}

function getGeoParquetRenderedRows(
  layerId: string,
): Record<number, Record<string, unknown>> {
  const controlLayer = getMutableGeoParquetControl().layers?.find(
    (layer) => layer.id === layerId,
  );
  return controlLayer?.rows ?? {};
}

function getMutableGeoParquetControl(
  control = geoparquetControl,
): MutableGeoParquetControl {
  return control as unknown as MutableGeoParquetControl;
}

function getGeoParquetLayerBounds(
  layer: GeoParquetLayerState,
): [number, number, number, number] | undefined {
  const primaryColumn = layer.primaryGeoColumn;
  const bounds =
    primaryColumn && layer.metadata?.geoMetadata?.columns?.[primaryColumn]?.bbox;
  if (isBounds(bounds)) return bounds;

  const mutableLayer = getMutableGeoParquetControl().layers?.find(
    (item) => item.id === layer.id,
  );
  return combineResultBounds(mutableLayer?.geoArrowResults);
}

function combineResultBounds(
  results: GeoParquetResultLike[] | undefined,
): [number, number, number, number] | undefined {
  const bounds = (results ?? [])
    .map((result) => result.bounds)
    .filter(isBounds);
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

function getGeoParquetGeometryTypes(layer: GeoParquetLayerState): string[] {
  const primaryColumn = layer.primaryGeoColumn;
  const types =
    primaryColumn &&
    layer.metadata?.geoMetadata?.columns?.[primaryColumn]?.geometry_types;
  if (Array.isArray(types) && types.length > 0) {
    return types.filter((item): item is string => typeof item === "string");
  }

  const mutableLayer = getMutableGeoParquetControl().layers?.find(
    (item) => item.id === layer.id,
  );
  return Array.from(
    new Set(
      (mutableLayer?.geoArrowResults ?? [])
        .map((result) => result.geometryType)
        .filter((item): item is string => typeof item === "string"),
    ),
  );
}

function getGeoParquetCustomLayerType(geometryTypes: string[]): string {
  const normalized = geometryTypes.map((type) => type.toLowerCase());
  if (normalized.some((type) => type.includes("point"))) return "circle";
  if (normalized.some((type) => type.includes("line"))) return "line";
  if (normalized.some((type) => type.includes("polygon"))) return "fill";
  return "custom";
}

function geoparquetLayerOrderSignature(layers: GeoLibreLayer[]): string {
  return layers
    .filter(isGeoParquetControlLayer)
    .map((layer) => layer.id)
    .join("|");
}

function isGeoParquetControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "geoparquet" &&
    layer.metadata.sourceKind === "geoparquet-url" &&
    layer.metadata.externalDeckLayer === true
  );
}

function layerNameFromUrl(url: string, fallback: string): string {
  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split("/").filter(Boolean).pop();
    return name || fallback;
  } catch {
    return url.split("/").filter(Boolean).pop() || fallback;
  }
}

function shallowEqualRecord(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
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

function hideGeoParquetControl(control: GeoParquetControl | null): void {
  const container = control?.getContainer();
  if (container) container.style.display = "none";
}

function showGeoParquetControl(control: GeoParquetControl | null): void {
  const container = control?.getContainer();
  if (container) container.style.display = "";
}
