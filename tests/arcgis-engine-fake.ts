import type { ArcGISMapEngineModules } from "../packages/map/src/engine/arcgis-map-engine";

type ArcGISLayerProperties = Readonly<Record<string, unknown>>;

class FakeHandle {
  constructor(private readonly dispose: () => void) {}

  remove(): void {
    this.dispose();
  }
}

export class FakeLayer {
  readonly id: string;
  visible: boolean;
  opacity: number;
  urlTemplate?: string | null;

  constructor(readonly properties: ArcGISLayerProperties) {
    this.id = String(properties.id ?? "layer");
    this.visible = properties.visible !== false;
    this.opacity = typeof properties.opacity === "number" ? properties.opacity : 1;
    this.urlTemplate = typeof properties.urlTemplate === "string" ? properties.urlTemplate : null;
  }
}

class FakeLayerCollection {
  private values: FakeLayer[] = [];

  constructor(private readonly onAdd: (layers: readonly FakeLayer[]) => void) {}

  addMany(layers: readonly FakeLayer[]): void {
    this.values.push(...layers);
    this.onAdd(this.values);
  }

  removeAll(): void {
    this.values = [];
  }
}

class FakeMap {
  readonly layers: FakeLayerCollection;

  constructor(
    readonly properties: Readonly<{ basemap: unknown }>,
    onLayersChange: (layers: readonly FakeLayer[]) => void,
  ) {
    this.layers = new FakeLayerCollection(onLayersChange);
  }
}

export class FakeMapView {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly container: HTMLElement;
  center: { longitude: number; latitude: number };
  zoom: number;
  rotation: number;
  private stationaryValue = true;
  private readonly eventHandlers = new Map<
    string,
    Set<(event: { readonly x?: number; readonly y?: number }) => void>
  >();
  private readonly stationaryHandlers = new Set<(stationary: boolean) => void>();

  get stationary(): boolean {
    return this.stationaryValue;
  }

  async when(): Promise<void> {
    return undefined;
  }

  destroy(): void {
    this.onDestroy();
  }

  resize(): void {
    this.onResize();
  }

  async goTo(target: Record<string, unknown>): Promise<void> {
    const center = target.center as readonly [number, number] | undefined;
    if (center) this.center = { longitude: center[0], latitude: center[1] };
    if (typeof target.zoom === "number") this.zoom = target.zoom;
    if (typeof target.rotation === "number") this.rotation = target.rotation;
    const extent = target.target as
      | {
          readonly type?: string;
          readonly xmin?: number;
          readonly ymin?: number;
          readonly xmax?: number;
          readonly ymax?: number;
        }
      | undefined;
    if (
      extent?.type === "extent" &&
      extent.xmin !== undefined &&
      extent.xmax !== undefined &&
      extent.ymin !== undefined &&
      extent.ymax !== undefined
    ) {
      this.center = {
        longitude: (extent.xmin + extent.xmax) / 2,
        latitude: (extent.ymin + extent.ymax) / 2,
      };
    }
  }

  on(
    event: string,
    handler: (event: { readonly x?: number; readonly y?: number }) => void,
  ): FakeHandle {
    const handlers = this.eventHandlers.get(event) ?? new Set();
    handlers.add(handler);
    this.eventHandlers.set(event, handlers);
    return new FakeHandle(() => handlers.delete(handler));
  }

  watch(_property: "stationary", handler: (stationary: boolean) => void): FakeHandle {
    this.stationaryHandlers.add(handler);
    return new FakeHandle(() => this.stationaryHandlers.delete(handler));
  }

  toScreen(point: { readonly longitude: number; readonly latitude: number }): {
    x: number;
    y: number;
  } {
    return { x: point.longitude, y: point.latitude };
  }

  toMap(point: { readonly x: number; readonly y: number }): {
    longitude: number;
    latitude: number;
  } {
    return { longitude: point.x, latitude: point.y };
  }

  emitUserMove(): void {
    for (const handler of this.eventHandlers.get("mouse-wheel") ?? []) handler({});
    this.zoom += 1;
    this.setStationary(false);
    this.setStationary(true);
  }

  private setStationary(stationary: boolean): void {
    this.stationaryValue = stationary;
    for (const handler of this.stationaryHandlers) handler(stationary);
  }

  constructor(
    properties: Readonly<Record<string, unknown>>,
    container: HTMLElement,
    private readonly onDestroy: () => void,
    private readonly onResize: () => void,
  ) {
    this.properties = properties;
    this.container = container;
    const center = properties.center as readonly [number, number] | undefined;
    this.center = { longitude: center?.[0] ?? 0, latitude: center?.[1] ?? 0 };
    this.zoom = typeof properties.zoom === "number" ? properties.zoom : 0;
    this.rotation = typeof properties.rotation === "number" ? properties.rotation : 0;
  }
}

export interface ArcGISFakeRuntime {
  readonly modules: ArcGISMapEngineModules;
  readonly config: { assetsPath: string };
  readonly layerOrders: string[][];
  readonly destroyed: { value: boolean };
  readonly resizeCount: { value: number };
  readonly basemapLayers: FakeLayer[];
  view: FakeMapView | null;
}

/** Deterministic, SDK-free MapView fake shared by ArcGIS adapter tests. */
export function createArcGISFakeRuntime(): ArcGISFakeRuntime {
  const config = { assetsPath: "" };
  const layerOrders: string[][] = [];
  const destroyed = { value: false };
  const resizeCount = { value: 0 };
  const basemapLayers: FakeLayer[] = [];
  const runtime: ArcGISFakeRuntime = {
    modules: undefined as unknown as ArcGISMapEngineModules,
    config,
    layerOrders,
    destroyed,
    resizeCount,
    basemapLayers,
    view: null,
  };

  class BasemapFake {
    constructor(properties: Readonly<{ baseLayers: readonly FakeLayer[] }>) {
      basemapLayers.push(...properties.baseLayers);
    }
  }

  class MapFake extends FakeMap {
    constructor(properties: Readonly<{ basemap: unknown }>) {
      super(properties, (layers) => layerOrders.push(layers.map((layer) => layer.id)));
    }
  }

  class MapViewFake extends FakeMapView {
    constructor(properties: Readonly<Record<string, unknown>>) {
      super(
        properties,
        properties.container as HTMLElement,
        () => {
          destroyed.value = true;
        },
        () => {
          resizeCount.value += 1;
        },
      );
      runtime.view = this;
    }
  }

  runtime.modules = {
    config,
    reactiveUtils: {
      watch: (_getValue, callback) =>
        runtime.view?.watch("stationary", callback) ?? new FakeHandle(() => undefined),
    },
    Map: MapFake,
    Basemap: BasemapFake,
    MapView: MapViewFake,
    WebTileLayer: FakeLayer,
    GeoJSONLayer: FakeLayer,
    WMSLayer: FakeLayer,
    WMTSLayer: FakeLayer,
  };
  return runtime;
}
