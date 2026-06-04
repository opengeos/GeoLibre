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
import {
  asRecord,
  colorToRgba,
  pointRadiusMaxPixels,
  type StyledDeckLayerLike,
} from "./deck-style-utils";

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
  __geolibreOriginalSetData?: GeoParquetRendererLike["setData"];
  __geolibreStylePatched?: boolean;
  createLayers?: (
    layerId: string,
    result: GeoParquetResultLike,
    index: number,
  ) => StyledDeckLayerLike[];
  setData?: (layers: GeoParquetRenderedLayerLike[]) => void;
};

type GeoParquetRenderedLayerLike = {
  beforeId?: string | null;
  id: string;
  name?: string;
  results?: GeoParquetResultLike[];
};

const geoparquetControlPosition: GeoLibreMapControlPosition = "top-left";
const DEFAULT_GEOPARQUET_URL =
  "https://data.source.coop/giswqs/opengeos/countries.parquet";

const GEOPARQUET_OPTIONS = {
  className: "geolibre-geoparquet-control",
  collapsed: false,
  interleaved: true,
  panelWidth: 365,
  pickable: true,
  sampleUrl: DEFAULT_GEOPARQUET_URL,
  title: "Add GeoParquet Layer",
} satisfies GeoParquetControlOptions;

let geoparquetControl: GeoParquetControl | null = null;
let geoparquetControlMounted = false;
let geoparquetConstructorsPromise: Promise<{
  GeoParquetControl: GeoParquetControlConstructor;
}> | null = null;
let geoparquetStoreUnsubscribe: (() => void) | null = null;
const geoparquetRenderedStyles = new Map<string, GeoParquetRenderedStyle>();
let geoparquetLayerOrder = new Map<string, number>();

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
  patchGeoParquetControlOnRemove(control);
  control.on("collapse", () => hideGeoParquetControl(control));
  control.on("load", createGeoParquetStateChangeHandler(control));
  control.on("statechange", createGeoParquetStateChangeHandler(control));

  geoparquetStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));
    let shouldSyncControl = false;

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
        shouldSyncControl = true;
      }
    }

    if (geoparquetLayerOrderSignature(state.layers) !==
      geoparquetLayerOrderSignature(previous.layers)) {
      shouldSyncControl = true;
    }

    if (shouldSyncControl) {
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
  if (hasGeoParquetSourceChanged(existingLayer.source, nextLayer.source)) {
    patch.source = nextLayer.source;
  }
  if (
    hasGeoParquetMetadataChanged(existingLayer.metadata, nextLayer.metadata)
  ) {
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
  geoparquetLayerOrder = new Map(
    layers
      .filter(isGeoParquetControlLayer)
      .map((layer, index) => [layer.id, index]),
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
  if (!renderer || renderer.__geolibreStylePatched) return;

  if (renderer.setData) {
    renderer.__geolibreOriginalSetData = renderer.setData.bind(renderer);
    renderer.setData = (layers: GeoParquetRenderedLayerLike[]) => {
      renderer.__geolibreOriginalSetData?.(
        [...layers].sort(
          (first, second) =>
            (geoparquetLayerOrder.get(first.id) ?? Number.MAX_SAFE_INTEGER) -
            (geoparquetLayerOrder.get(second.id) ?? Number.MAX_SAFE_INTEGER),
        ),
      );
    };
  }

  if (!renderer.createLayers) {
    renderer.__geolibreStylePatched = true;
    return;
  }

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

function patchGeoParquetControlOnRemove(control: GeoParquetControl): void {
  const originalOnRemove = control.onRemove.bind(control);
  control.onRemove = () => {
    originalOnRemove();
    resetGeoParquetControl(control);
  };
}

function resetGeoParquetControl(control: GeoParquetControl): void {
  if (geoparquetControl !== control) return;

  geoparquetStoreUnsubscribe?.();
  geoparquetStoreUnsubscribe = null;
  geoparquetRenderedStyles.clear();
  geoparquetLayerOrder.clear();
  geoparquetControlMounted = false;
  geoparquetControl = null;
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

function hasGeoParquetSourceChanged(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  return (
    current.displaySource !== next.displaySource ||
    current.sourceId !== next.sourceId ||
    current.type !== next.type ||
    current.url !== next.url ||
    !boundsEqual(current.bounds, next.bounds)
  );
}

function hasGeoParquetMetadataChanged(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  return (
    current.customLayerType !== next.customLayerType ||
    current.deckLayerId !== next.deckLayerId ||
    current.externalDeckLayer !== next.externalDeckLayer ||
    current.fileInfo !== next.fileInfo ||
    current.geoMetadata !== next.geoMetadata ||
    current.identifiable !== next.identifiable ||
    current.loadedRows !== next.loadedRows ||
    current.pageSize !== next.pageSize ||
    current.primaryGeoColumn !== next.primaryGeoColumn ||
    current.sourceId !== next.sourceId ||
    current.sourceKind !== next.sourceKind ||
    current.totalRows !== next.totalRows ||
    !boundsEqual(current.bounds, next.bounds) ||
    !stringArrayEqual(current.geometryTypes, next.geometryTypes) ||
    !stringArrayEqual(current.selectedColumns, next.selectedColumns) ||
    !schemaEqual(current.columns, next.columns)
  );
}

function boundsEqual(first: unknown, second: unknown): boolean {
  if (first === second) return true;
  if (!isBounds(first) || !isBounds(second)) return false;
  return first.every((value, index) => value === second[index]);
}

function stringArrayEqual(first: unknown, second: unknown): boolean {
  if (first === second) return true;
  if (!Array.isArray(first) || !Array.isArray(second)) return false;
  if (first.length !== second.length) return false;
  return first.every((value, index) => value === second[index]);
}

function schemaEqual(first: unknown, second: unknown): boolean {
  if (first === second) return true;
  if (!Array.isArray(first) || !Array.isArray(second)) return false;
  if (first.length !== second.length) return false;

  return first.every((value, index) => {
    const currentColumn = value as Record<string, unknown>;
    const nextColumn = second[index] as Record<string, unknown>;
    return (
      currentColumn.name === nextColumn.name &&
      currentColumn.nullable === nextColumn.nullable &&
      currentColumn.type === nextColumn.type
    );
  });
}

function hideGeoParquetControl(control: GeoParquetControl | null): void {
  const container = control?.getContainer();
  if (container) container.style.display = "none";
}

function showGeoParquetControl(control: GeoParquetControl | null): void {
  const container = control?.getContainer();
  if (container) container.style.display = "";

  const panel = getGeoParquetPanel(control);
  if (!panel) return;

  updateGeoParquetPanelInset(control, panel);
  window.requestAnimationFrame(() => {
    updateGeoParquetPanelInset(control, panel);
  });
}

function getGeoParquetPanel(
  control: GeoParquetControl | null,
): HTMLElement | null {
  return (
    control
      ?.getMap()
      ?.getContainer()
      .querySelector<HTMLElement>(".geoparquet-control-panel") ?? null
  );
}

function updateGeoParquetPanelInset(
  control: GeoParquetControl | null,
  panel: HTMLElement,
): void {
  panel.style.setProperty(
    "--geolibre-geoparquet-panel-left",
    geoParquetPanelLeftOffset(control),
  );
}

function geoParquetPanelLeftOffset(control: GeoParquetControl | null): string {
  const mapContainer = control?.getMap()?.getContainer();
  const topLeftControls = mapContainer?.querySelector<HTMLElement>(
    ".maplibregl-ctrl-top-left",
  );
  if (!mapContainer || !topLeftControls) return "10px";

  // Measure the actual right edge of the other visible top-left controls
  // instead of assuming a fixed control width.
  const visibleControls = [
    ...topLeftControls.querySelectorAll<HTMLElement>(".maplibregl-ctrl"),
  ]
    .filter(
      (element) => !element.classList.contains("geolibre-geoparquet-control"),
    )
    .filter(isVisibleElement);
  if (visibleControls.length === 0) return "10px";

  const rightEdge = Math.max(
    ...visibleControls.map((element) => element.getBoundingClientRect().right),
  );
  const left = rightEdge - mapContainer.getBoundingClientRect().left + 10;
  return `${Math.max(Math.round(left), 10)}px`;
}

function isVisibleElement(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    rect.width > 0 &&
    rect.height > 0
  );
}
