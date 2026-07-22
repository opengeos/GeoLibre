import type { ArcGISMapEngineModules } from "../packages/map/src/engine/arcgis-map-engine";
import type { ArcGISSceneEngineModules } from "../packages/map/src/engine/arcgis-scene-engine";

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

  remove(layer: FakeLayer): void {
    this.values = this.values.filter((candidate) => candidate !== layer);
    this.onAdd(this.values);
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
  readonly popup = { visible: false };
  popupOpenOptions: {
    readonly location: { readonly longitude: number; readonly latitude: number };
    readonly content: HTMLElement;
  } | null = null;
  closePopupCount = 0;
  screenshotOptions: unknown = null;
  screenshotSize = { width: 200, height: 100 };
  private stationaryValue = true;
  private readonly eventHandlers = new Map<
    string,
    Set<(event: { readonly x?: number; readonly y?: number }) => void>
  >();
  private readonly reactiveWatchers = new Set<{
    readonly getValue: () => boolean;
    readonly callback: (value: boolean) => void;
    value: boolean;
  }>();

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

  watch(getValue: () => boolean, callback: (value: boolean) => void): FakeHandle {
    const watcher = { getValue, callback, value: getValue() };
    this.reactiveWatchers.add(watcher);
    return new FakeHandle(() => this.reactiveWatchers.delete(watcher));
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

  async hitTest(): Promise<{
    readonly results: readonly {
      readonly type: "graphic";
      readonly layer: { readonly id: string };
      readonly graphic: { readonly attributes: Readonly<Record<string, unknown>> };
    }[];
  }> {
    return { results: this.onHitTest() };
  }

  async openPopup(options: {
    readonly location: { readonly longitude: number; readonly latitude: number };
    readonly content: HTMLElement;
  }): Promise<void> {
    this.popupOpenOptions = options;
    this.popup.visible = true;
    this.notifyReactiveWatchers();
  }

  closePopup(): void {
    this.closePopupCount += 1;
    this.popup.visible = false;
    this.notifyReactiveWatchers();
  }

  async takeScreenshot(options?: unknown): Promise<{ readonly data: ImageData }> {
    this.screenshotOptions = options ?? null;
    return {
      data: {
        width: this.screenshotSize.width,
        height: this.screenshotSize.height,
      } as ImageData,
    };
  }

  emitUserMove(): void {
    for (const handler of this.eventHandlers.get("mouse-wheel") ?? []) handler({});
    this.zoom += 1;
    this.setStationary(false);
    this.setStationary(true);
  }

  private setStationary(stationary: boolean): void {
    this.stationaryValue = stationary;
    this.notifyReactiveWatchers();
  }

  private notifyReactiveWatchers(): void {
    for (const watcher of this.reactiveWatchers) {
      const value = watcher.getValue();
      if (value === watcher.value) continue;
      watcher.value = value;
      watcher.callback(value);
    }
  }

  constructor(
    properties: Readonly<Record<string, unknown>>,
    container: HTMLElement,
    private readonly onDestroy: () => void,
    private readonly onResize: () => void,
    private readonly onHitTest: () => readonly {
      readonly type: "graphic";
      readonly layer: { readonly id: string };
      readonly graphic: { readonly attributes: Readonly<Record<string, unknown>> };
    }[],
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
  currentLayers: FakeLayer[];
  hitTestResults: Array<{
    readonly type: "graphic";
    readonly layer: { readonly id: string };
    readonly graphic: { readonly attributes: Readonly<Record<string, unknown>> };
  }>;
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
    currentLayers: [],
    hitTestResults: [],
    view: null,
  };

  class BasemapFake {
    constructor(properties: Readonly<{ baseLayers: readonly FakeLayer[] }>) {
      basemapLayers.push(...properties.baseLayers);
    }
  }

  class MapFake extends FakeMap {
    constructor(properties: Readonly<{ basemap: unknown }>) {
      super(properties, (layers) => {
        runtime.currentLayers = [...layers];
        layerOrders.push(layers.map((layer) => layer.id));
      });
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
        () => runtime.hitTestResults,
      );
      runtime.view = this;
    }
  }

  runtime.modules = {
    config,
    reactiveUtils: {
      watch: (_getValue, callback) =>
        runtime.view?.watch(_getValue, callback) ?? new FakeHandle(() => undefined),
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

export interface ArcGISSceneFakeRuntime {
  readonly modules: ArcGISSceneEngineModules;
  readonly config: { assetsPath: string };
  readonly layerOrders: string[][];
  readonly destroyed: { value: boolean };
  readonly basemapLayers: FakeLayer[];
  currentLayers: FakeLayer[];
  hitTestResults: Array<{
    readonly type: "graphic";
    readonly layer: { readonly id: string };
    readonly graphic: { readonly attributes: Readonly<Record<string, unknown>> };
  }>;
  view: FakeSceneView | null;
}

export class FakeSceneView extends FakeMapView {
  readonly camera: { heading: number; tilt: number };

  constructor(
    properties: Readonly<Record<string, unknown>>,
    container: HTMLElement,
    onDestroy: () => void,
    onHitTest: () => readonly {
      readonly type: "graphic";
      readonly layer: { readonly id: string };
      readonly graphic: { readonly attributes: Readonly<Record<string, unknown>> };
    }[],
  ) {
    super(properties, container, onDestroy, () => undefined, onHitTest);
    this.camera = {
      heading: typeof properties.heading === "number" ? properties.heading : 0,
      tilt: typeof properties.tilt === "number" ? properties.tilt : 0,
    };
  }

  override async goTo(target: Record<string, unknown>): Promise<void> {
    const applied = super.goTo(target);
    if (typeof target.heading === "number") this.camera.heading = target.heading;
    if (typeof target.tilt === "number") this.camera.tilt = target.tilt;
    await applied;
  }
}

/** Deterministic, SDK-free SceneView fake used by the 3D adapter tests. */
export function createArcGISSceneFakeRuntime(): ArcGISSceneFakeRuntime {
  const config = { assetsPath: "" };
  const layerOrders: string[][] = [];
  const destroyed = { value: false };
  const basemapLayers: FakeLayer[] = [];
  const runtime: ArcGISSceneFakeRuntime = {
    modules: undefined as unknown as ArcGISSceneEngineModules,
    config,
    layerOrders,
    destroyed,
    basemapLayers,
    currentLayers: [],
    hitTestResults: [],
    view: null,
  };

  class BasemapFake {
    constructor(properties: Readonly<{ baseLayers: readonly FakeLayer[] }>) {
      basemapLayers.push(...properties.baseLayers);
    }
  }

  class MapFake extends FakeMap {
    constructor(properties: Readonly<{ basemap: unknown }>) {
      super(properties, (layers) => {
        runtime.currentLayers = [...layers];
        layerOrders.push(layers.map((layer) => layer.id));
      });
    }
  }

  class SceneViewFake extends FakeSceneView {
    constructor(properties: Readonly<Record<string, unknown>>) {
      super(
        properties,
        properties.container as HTMLElement,
        () => {
          destroyed.value = true;
        },
        () => runtime.hitTestResults,
      );
      runtime.view = this;
    }
  }

  runtime.modules = {
    config,
    reactiveUtils: {
      watch: (_getValue, callback) =>
        runtime.view?.watch(_getValue, callback) ?? new FakeHandle(() => undefined),
    },
    Map: MapFake,
    Basemap: BasemapFake,
    SceneView: SceneViewFake,
    WebTileLayer: FakeLayer,
    GeoJSONLayer: FakeLayer,
    WMSLayer: FakeLayer,
    WMTSLayer: FakeLayer,
  };
  return runtime;
}
