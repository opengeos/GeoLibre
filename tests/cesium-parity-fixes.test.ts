import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  useAppStore,
  type GeoLibreLayer,
  type MapPreferences,
} from "../packages/core/src";
import { CesiumLayerSync, isCesiumSupportedLayerType } from "../packages/map/src/cesium-layer-sync";
import { CesiumEngine } from "../packages/map/src/cesium-engine";

function mkEvent(listeners: (() => void)[]) {
  return {
    addEventListener: (fn: () => void) => {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    removeEventListener: (fn: () => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
}

function makeFakes() {
  const calls = {
    urlProviders: [] as Record<string, unknown>[],
    wmsProviders: [] as Record<string, unknown>[],
    wmtsProviders: [] as Record<string, unknown>[],
    cameraListeners: [] as (() => void)[],
    postRenderListeners: [] as (() => void)[],
    morphListeners: [] as (() => void)[],
  };

  const canvas = {
    clientWidth: 800,
    clientHeight: 600,
    width: 800,
    height: 600,
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const viewer = {
    canvas,
    clock: { currentTime: { dayNumber: 0, secondsOfDay: 0 } },
    camera: {
      positionWC: { x: 0, y: 0, z: 1000 },
      positionCartographic: { longitude: 0, latitude: 0, height: 1000 },
      heading: 0,
      pitch: -Math.PI / 2,
      frustum: { fovy: Math.PI / 3 },
      moveEnd: mkEvent(calls.cameraListeners),
      moveStart: mkEvent([]),
      lookAt: () => {},
      lookAtTransform: () => {},
      flyTo: () => {},
      flyToBoundingSphere: () => {},
      getPickRay: () => ({ ray: true }),
      pickEllipsoid: () => ({ x: 0, y: 0, z: 0 }),
    },
    scene: {
      canvas,
      mode: 3, // SCENE3D
      morphTo2D: (d: number) => {
        viewer.scene.mode = 2; // SCENE2D
      },
      morphTo3D: (d: number) => {
        viewer.scene.mode = 3; // SCENE3D
      },
      morphComplete: mkEvent(calls.morphListeners),
      primitives: { add: () => {}, remove: () => {} },
      postRender: mkEvent(calls.postRenderListeners),
      requestRender: () => {
        for (const listener of [...calls.postRenderListeners]) listener();
      },
      screenSpaceCameraController: {
        minimumZoomDistance: 0,
        maximumZoomDistance: Infinity,
      },
      globe: {
        ellipsoid: {
          name: "wgs84",
          cartesianToCartographic: (c: { x: number; y: number; z: number }) => ({
            longitude: c.x,
            latitude: c.y,
            height: c.z,
          }),
        },
        tileLoadProgressEvent: mkEvent([]),
        getHeight: () => 0,
        pick: () => undefined,
      },
    },
    dataSourceDisplay: {
      ready: true,
      getBoundingSphere: () => 0,
    },
    imageryLayers: {
      addImageryProvider: (provider: unknown) => ({
        kind: "imagery",
        provider,
        show: true,
        alpha: 1,
      }),
      remove: () => {},
      raiseToTop: () => {},
    },
    dataSources: {
      add: (ds: unknown) => Promise.resolve(ds),
      remove: () => {},
    },
    isDestroyed: () => false,
  };

  const Cesium = {
    SceneMode: {
      SCENE2D: 2,
      SCENE3D: 3,
      COLUMBUS_VIEW: 1,
      MORPHING: 0,
    },
    GeographicTilingScheme: class {},
    WebMercatorTilingScheme: class {},
    Rectangle: {
      fromDegrees: (w: number, s: number, e: number, n: number) => ({ w, s, e, n }),
    },
    Color: {
      fromCssColorString: (s: string) => ({
        s,
        withAlpha: (a: number) => ({ s, a }),
      }),
      WHITE: { withAlpha: (a: number) => ({ s: "#ffffff", a }) },
    },
    ColorMaterialProperty: class {
      color: unknown;
      constructor(c: unknown) {
        this.color = c;
      }
    },
    ConstantProperty: class {
      val: unknown;
      constructor(v: unknown) {
        this.val = v;
      }
      getValue() {
        return this.val;
      }
    },
    Cartesian2: class {
      x: number;
      y: number;
      constructor(x = 0, y = 0) {
        this.x = x;
        this.y = y;
      }
    },
    HeadingPitchRange: class {
      constructor(
        public heading: number,
        public pitch: number,
        public range: number,
      ) {}
    },
    Matrix4: { IDENTITY: {} },
    Cartesian3: {
      fromDegrees: (x: number, y: number, z = 0) => ({ x, y, z }),
      distance: (
        a: { x?: number; y?: number; z?: number },
        b: { x?: number; y?: number; z?: number },
      ) => Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0), (a.z ?? 0) - (b.z ?? 0)),
    },
    Cartographic: {
      fromDegrees: (lng: number, lat: number, height = 0) => ({
        longitude: lng,
        latitude: lat,
        height,
      }),
      fromCartesian: (c: { x: number; y: number; z: number }) => ({
        longitude: c.x,
        latitude: c.y,
        height: c.z,
      }),
    },
    Math: {
      toDegrees: (r: number) => r * (180 / Math.PI),
      toRadians: (d: number) => d * (Math.PI / 180),
    },
    UrlTemplateImageryProvider: class {
      constructor(opts: Record<string, unknown>) {
        calls.urlProviders.push(opts);
      }
    },
    WebMapServiceImageryProvider: class {
      constructor(opts: Record<string, unknown>) {
        calls.wmsProviders.push(opts);
      }
    },
    WebMapTileServiceImageryProvider: class {
      constructor(opts: Record<string, unknown>) {
        calls.wmtsProviders.push(opts);
      }
    },
    GeoJsonDataSource: class {
      name = "";
      entities = { values: [] as unknown[], suspendEvents: () => {} };
      load() {
        return Promise.resolve(this);
      }
    },
    HeightReference: { NONE: 0, CLAMP_TO_GROUND: 1, RELATIVE_TO_GROUND: 2 },
  };

  return { calls, viewer, Cesium };
}

describe("Cesium Parity Fixes (#2476)", () => {
  beforeEach(() => {
    useAppStore.setState({
      cameraAltitude: null,
      ui: { ...useAppStore.getState().ui, storymapPresenting: false, zoomToSelectedFeature: false },
    });
  });

  it("UrlTemplateImageryProvider expands customTags, flips TMS, and preserves attribution", async () => {
    const { calls, viewer, Cesium } = makeFakes();
    const sync = new CesiumLayerSync(Cesium as never, viewer as never);

    const layer: GeoLibreLayer = {
      id: "xyz-1",
      name: "XYZ Layer",
      type: "raster",
      visible: true,
      opacity: 1,
      source: {
        type: "raster",
        tiles: ["https://example.com/{z}/{x}/{y}?bbox={bbox-epsg-3857}&q={quadkey}&ratio={ratio}"],
        attribution: "<b>OpenStreetMap</b> contributors",
        tileSize: 512,
        scheme: "tms",
        bounds: [-120, 30, -110, 40],
      },
      style: { ...DEFAULT_LAYER_STYLE },
    };

    sync.sync([layer]);
    assert.equal(calls.urlProviders.length, 1);
    const opts = calls.urlProviders[0];

    // TMS flips {y} to {-y}
    assert.ok(String(opts.url).includes("{-y}"));
    // Attribution is text, escaped before Cesium renders credits as HTML.
    assert.equal(opts.credit, "&lt;b&gt;OpenStreetMap&lt;/b&gt; contributors");
    assert.equal(opts.tileWidth, 512);
    assert.ok(opts.rectangle);

    // Custom tags expansion
    const tags = opts.customTags as Record<
      string,
      (p: unknown, x: number, y: number, level: number) => string
    >;
    assert.ok(tags["bbox-epsg-3857"]);
    assert.ok(tags["quadkey"]);
    assert.ok(tags["-y"]);
    assert.equal(tags["ratio"](null, 0, 0, 0), "");

    const bbox = tags["bbox-epsg-3857"](null, 1, 1, 1);
    assert.ok(bbox.includes(","));
    const qk = tags["quadkey"](null, 1, 1, 1);
    assert.equal(qk, "3");
    const yUp = tags["-y"](null, 1, 0, 1);
    assert.equal(yUp, "1");
  });

  it("WMS and WMTS providers receive attribution credit", async () => {
    const { calls, viewer, Cesium } = makeFakes();
    const sync = new CesiumLayerSync(Cesium as never, viewer as never);

    const wmsLayer: GeoLibreLayer = {
      id: "wms-1",
      name: "WMS Layer",
      type: "wms",
      visible: true,
      opacity: 1,
      source: {
        type: "wms",
        url: "https://example.com/wms",
        layers: "layer1",
        attribution: "USGS WMS",
      },
      style: { ...DEFAULT_LAYER_STYLE },
    };

    const wmtsLayer: GeoLibreLayer = {
      id: "wmts-1",
      name: "WMTS Layer",
      type: "wmts",
      visible: true,
      opacity: 1,
      source: {
        type: "wmts",
        url: "https://example.com/wmts",
        layer: "layer1",
        tileMatrixSetID: "default",
        attribution: "NASA WMTS",
      },
      style: { ...DEFAULT_LAYER_STYLE },
    };

    sync.sync([wmsLayer, wmtsLayer]);
    assert.equal(calls.wmsProviders[0]?.credit, "USGS WMS");
    assert.equal(calls.wmtsProviders[0]?.credit, "NASA WMTS");
  });

  it("isCesiumSupportedLayerType correctly identifies supported vs unsupported layer kinds", () => {
    assert.equal(
      isCesiumSupportedLayerType({
        id: "1",
        name: "1",
        type: "geojson",
        visible: true,
        opacity: 1,
        source: {},
        style: { ...DEFAULT_LAYER_STYLE },
      }),
      true,
    );
    assert.equal(
      isCesiumSupportedLayerType({
        id: "2",
        name: "2",
        type: "xyz",
        visible: true,
        opacity: 1,
        source: {},
        style: { ...DEFAULT_LAYER_STYLE },
      }),
      true,
    );
    assert.equal(
      isCesiumSupportedLayerType({
        id: "3",
        name: "3",
        type: "raster",
        visible: true,
        opacity: 1,
        source: {},
        style: { ...DEFAULT_LAYER_STYLE },
      }),
      true,
    );
    assert.equal(
      isCesiumSupportedLayerType({
        id: "4",
        name: "4",
        type: "deckgl-viz",
        visible: true,
        opacity: 1,
        source: {},
        style: { ...DEFAULT_LAYER_STYLE },
      }),
      false,
    );
    assert.equal(
      isCesiumSupportedLayerType({
        id: "5",
        name: "5",
        type: "zarr",
        visible: true,
        opacity: 1,
        source: {},
        style: { ...DEFAULT_LAYER_STYLE },
      }),
      // Drawn through zarr-cesium since opengeos/GeoLibre#2261.
      true,
    );
  });

  it("CesiumEngine.applyMapPreferences updates projection between mercator and globe", () => {
    const { viewer, Cesium } = makeFakes();
    const engine = new CesiumEngine(Cesium as never, viewer as never);

    assert.equal(viewer.scene.mode, 3); // 3D

    // Switch to mercator projection -> triggers morphTo2D
    engine.applyMapPreferences({
      projection: "mercator",
      minZoom: 0,
      maxZoom: 22,
    } as MapPreferences);
    assert.equal(viewer.scene.mode, 2); // 2D

    // Switch back to globe -> triggers morphTo3D
    engine.applyMapPreferences({
      projection: "globe",
      minZoom: 0,
      maxZoom: 22,
    } as MapPreferences);
    assert.equal(viewer.scene.mode, 3); // 3D

    // Columbus view (e.g. from the scene-mode picker) also returns to 2D.
    viewer.scene.mode = 1;
    engine.applyMapPreferences({
      projection: "mercator",
      minZoom: 0,
      maxZoom: 22,
    } as MapPreferences);
    assert.equal(viewer.scene.mode, 2); // 2D

    engine.destroy();
  });

  it("CesiumEngine.applyMapPreferences defers a projection change that lands mid-morph", () => {
    const { viewer, Cesium, calls } = makeFakes();
    const engine = new CesiumEngine(Cesium as never, viewer as never);
    const prefs = (projection: "mercator" | "globe") =>
      ({ projection, minZoom: 0, maxZoom: 22 }) as MapPreferences;

    viewer.scene.mode = 0; // MORPHING (e.g. a scene-mode picker morph)
    engine.applyMapPreferences(prefs("mercator"));
    assert.equal(viewer.scene.mode, 0, "no morph starts over a running one");

    // The running morph lands in 3D; the deferred preference is applied then.
    viewer.scene.mode = 3;
    for (const listener of [...calls.morphListeners]) listener();
    assert.equal(viewer.scene.mode, 2);

    // A picker morph with no deferred preference is left where it landed.
    viewer.scene.mode = 3;
    for (const listener of [...calls.morphListeners]) listener();
    assert.equal(viewer.scene.mode, 3);

    engine.destroy();
  });

  it("CesiumEngine publishes camera altitude on primary globe and respects story presentation guard", () => {
    const { viewer, Cesium, calls } = makeFakes();
    const engine = new CesiumEngine(Cesium as never, viewer as never, { isPrimary: true });

    // Initial camera applyView updates cameraAltitude in store
    engine.applyView({
      center: [0, 0],
      zoom: 10,
      bearing: 0,
      pitch: 0,
    });

    assert.equal(typeof useAppStore.getState().cameraAltitude, "number");

    // Story presentation guard: when storymapPresenting is true, camera moves are ignored
    useAppStore.setState({
      ui: { ...useAppStore.getState().ui, storymapPresenting: true },
    });

    const prevView = useAppStore.getState().mapView;
    for (const listener of calls.cameraListeners) listener();

    // MapView was not overwritten during story presentation
    assert.deepEqual(useAppStore.getState().mapView, prevView);

    engine.destroy();
  });
});
