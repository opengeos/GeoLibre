import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
  BLANK_BASEMAP,
  DEFAULT_LAYER_STYLE,
  useAppStore,
  type MapPreferences,
} from "@geolibre/core";
import {
  ArcgisEngine,
  bearingToRotation,
  geojsonToArcgisGeometry,
  rotationToBearing,
} from "../packages/map/src/arcgis-engine";
import type {
  ArcgisLayer,
  ArcgisMap,
  ArcgisMapView,
  ArcgisSdk,
} from "../packages/map/src/arcgis-sdk";
import { ARCGIS_ID_FIELD } from "../packages/map/src/arcgis-layers";
import { geojsonLayer } from "./helpers/layer-fixtures";

// The engine never loads the SDK here: `arcgis-sdk.ts` only describes its
// shape, and the fake below records the constructor calls and property writes
// the engine makes. What is exercised is the engine's own bookkeeping — which
// native layers it builds, rebuilds and removes across syncLayers calls, how it
// orders them, how camera state maps between MapLibre and SDK conventions, and
// how a hit test resolves back to the app's feature identity.

interface FakeLayer extends ArcgisLayer {
  kind: string;
  props: Record<string, unknown>;
  destroyed: boolean;
}

function makeSdk() {
  const created: FakeLayer[] = [];
  const widgets: { kind: string; props: Record<string, unknown>; destroyed: boolean }[] = [];
  const goTo: unknown[] = [];
  let watchers: (() => void)[] = [];
  const layerClass = (kind: string) =>
    class {
      kind = kind;
      props: Record<string, unknown>;
      id = `${kind}-${created.length}`;
      title: string | null;
      type = kind;
      opacity: number;
      visible: boolean;
      minScale: number;
      maxScale: number;
      loaded = true;
      loadStatus = "loaded" as const;
      loadError = null;
      fullExtent = null;
      destroyed = false;
      graphics = collection<unknown>();
      constructor(props: Record<string, unknown> = {}) {
        this.props = props;
        this.title = (props.title as string) ?? null;
        this.opacity = (props.opacity as number) ?? 1;
        this.visible = (props.visible as boolean) ?? true;
        this.minScale = (props.minScale as number) ?? 0;
        this.maxScale = (props.maxScale as number) ?? 0;
        if (Array.isArray(props.graphics)) this.graphics.addMany(props.graphics);
        created.push(this as unknown as FakeLayer);
      }
      load = () => Promise.resolve();
      when = () => Promise.resolve();
      destroy() {
        this.destroyed = true;
      }
    } as unknown as new (props?: Record<string, unknown>) => FakeLayer;
  const widgetClass = (kind: string) =>
    class {
      kind = kind;
      unit: unknown;
      label: unknown;
      destroyed = false;
      constructor(public props: Record<string, unknown> = {}) {
        this.unit = props.unit;
        this.label = props.label;
        widgets.push(this as never);
      }
      destroy() {
        this.destroyed = true;
      }
    };
  function collection<T>() {
    const items: T[] = [];
    return {
      items,
      get length() {
        return items.length;
      },
      add: (item: T, index?: number) => {
        if (index === undefined) items.push(item);
        else items.splice(index, 0, item);
      },
      addMany: (more: T[]) => items.push(...more),
      remove: (item: T) => {
        const i = items.indexOf(item);
        if (i >= 0) items.splice(i, 1);
      },
      removeAll: () => items.splice(0),
      removeMany: (more: T[]) => more.forEach((m) => items.splice(items.indexOf(m), 1)),
      reorder: (item: T, index: number) => {
        const i = items.indexOf(item);
        if (i < 0) return;
        items.splice(i, 1);
        items.splice(index, 0, item);
      },
      indexOf: (item: T) => items.indexOf(item),
      includes: (item: T) => items.includes(item),
      toArray: () => [...items],
      forEach: (cb: (item: T, index: number) => void) => items.forEach(cb),
      at: (i: number) => items[i],
      getItemAt: (i: number) => items[i],
    };
  }
  const layers = collection<FakeLayer>();
  const map = {
    basemap: null as unknown,
    layers,
    allLayers: layers,
    add: (layer: FakeLayer, index?: number) => layers.add(layer, index),
    remove: (layer: FakeLayer) => {
      layers.remove(layer);
      return layer;
    },
    destroy: () => {},
  };
  const uiAdds: { component: unknown; position: unknown }[] = [];
  const view = {
    type: "2d",
    container: null as HTMLElement | null,
    map,
    center: { longitude: 10, latitude: 20 },
    zoom: 5,
    scale: 0,
    rotation: 0,
    extent: { xmin: -10, ymin: -5, xmax: 10, ymax: 5 },
    spatialReference: { wkid: 4326 },
    stationary: true,
    updating: false,
    ready: true,
    attributionVisible: false,
    attributionItems: [] as { text: string; score?: number }[],
    interacting: false,
    animation: null,
    width: 800,
    height: 600,
    ui: {
      components: ["attribution", "zoom"],
      add: (component: unknown, position: unknown) => uiAdds.push({ component, position }),
      remove: (component: unknown) => {
        const i = uiAdds.findIndex((entry) => entry.component === component);
        if (i >= 0) uiAdds.splice(i, 1);
      },
      empty: () => {},
      find: () => null,
    },
    navigation: {
      browserTouchPanEnabled: true,
      mouseWheelZoomEnabled: true,
      momentumEnabled: true,
    },
    constraints: {} as Record<string, unknown>,
    background: null,
    popup: null,
    popupEnabled: false,
    destroyed: false,
    when: () => Promise.resolve(),
    goTo: (target: unknown, options: unknown) => {
      goTo.push({ target, options });
      const t = target as { center?: [number, number]; zoom?: number; rotation?: number };
      if (t && typeof t === "object" && !("xmin" in t)) {
        if (t.center) [view.center.longitude, view.center.latitude] = t.center;
        if (t.zoom !== undefined) view.zoom = t.zoom;
        if (t.rotation !== undefined) view.rotation = t.rotation;
      }
      return Promise.resolve();
    },
    toScreen: (p: { x?: number; longitude?: number; y?: number; latitude?: number }) => ({
      x: p.x ?? p.longitude ?? 0,
      y: p.y ?? p.latitude ?? 0,
    }),
    toMap: (p: { x: number; y: number }) => ({ longitude: p.x, latitude: p.y, x: p.x, y: p.y }),
    hitTest: async () => ({ results: hitResults, screenPoint: { x: 0, y: 0 } }),
    takeScreenshot: async () => ({ dataUrl: "data:image/png;base64,", data: {} as ImageData }),
    on: (_type: string, _handler: unknown) => ({ remove: () => {} }),
    destroy: () => {
      view.destroyed = true;
    },
  };
  let hitResults: unknown[] = [];
  const sdk = {
    config: {
      apiKey: null,
      assetsPath: "",
      request: { interceptors: [], trustedServers: [], useIdentity: true },
    },
    Map: class {},
    MapView: class {},
    Basemap: class {
      baseLayers = collection<FakeLayer>();
      referenceLayers = collection<FakeLayer>();
      constructor(props: { baseLayers?: FakeLayer[] } = {}) {
        if (props.baseLayers) this.baseLayers.addMany(props.baseLayers);
      }
      destroy() {}
      static fromId() {
        return null;
      }
    },
    Graphic: class {
      constructor(public props: Record<string, unknown> = {}) {}
      get geometry() {
        return this.props.geometry;
      }
      set geometry(value: unknown) {
        this.props.geometry = value;
      }
      get attributes() {
        return (this.props.attributes as Record<string, unknown>) ?? {};
      }
      get layer() {
        return null;
      }
      get symbol() {
        return this.props.symbol;
      }
    },
    Point: class {
      constructor(public props: Record<string, unknown> = {}) {}
      get longitude() {
        return this.props.longitude;
      }
      get latitude() {
        return this.props.latitude;
      }
    },
    Extent: class {
      constructor(public props: Record<string, unknown> = {}) {
        Object.assign(this, props);
      }
    },
    layers: {
      GeoJSONLayer: layerClass("geojson"),
      GraphicsLayer: layerClass("graphics"),
      WebTileLayer: layerClass("web-tile"),
      WMSLayer: layerClass("wms"),
      WMTSLayer: layerClass("wmts"),
      VectorTileLayer: layerClass("vector-tile"),
      FeatureLayer: layerClass("feature"),
      TileLayer: layerClass("tile"),
      MapImageLayer: layerClass("map-image"),
      ImageryLayer: layerClass("imagery"),
      ImageryTileLayer: layerClass("imagery-tile"),
      MediaLayer: layerClass("media"),
    },
    media: { ImageElement: class {}, ExtentAndRotationGeoreference: class {} },
    widgets: {
      Zoom: widgetClass("Zoom"),
      Compass: widgetClass("Compass"),
      ScaleBar: widgetClass("ScaleBar"),
      Fullscreen: widgetClass("Fullscreen"),
      Locate: widgetClass("Locate"),
    },
    reactiveUtils: {
      watch: (_get: unknown, cb: () => void) => {
        watchers.push(cb);
        return { remove: () => (watchers = watchers.filter((w) => w !== cb)) };
      },
      when: (_get: unknown, cb: () => void) => {
        watchers.push(cb);
        return { remove: () => (watchers = watchers.filter((w) => w !== cb)) };
      },
      on: () => ({ remove: () => {} }),
    },
    webMercatorUtils: {
      webMercatorToGeographic: <T>(g: T) => g,
      geographicToWebMercator: <T>(g: T) => g,
      canProject: () => true,
    },
  };
  return {
    sdk: sdk as unknown as ArcgisSdk,
    map: map as unknown as ArcgisMap,
    view: view as unknown as ArcgisMapView,
    created,
    widgets,
    goTo,
    uiAdds,
    layers,
    fireWatchers: () => watchers.forEach((w) => w()),
    setHitResults: (results: unknown[]) => {
      hitResults = results;
    },
    rawView: view,
  };
}

function makeEngine(options?: ConstructorParameters<typeof ArcgisEngine>[3]) {
  const fake = makeSdk();
  const engine = new ArcgisEngine(fake.sdk, fake.map, fake.view, options);
  return { engine, ...fake };
}

const SQUARE = geojsonLayer({
  geojson: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "sq",
        properties: { name: "Square" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
        },
      },
      {
        type: "Feature",
        properties: { name: "Dot" },
        geometry: { type: "Point", coordinates: [5, 5] },
      },
    ],
  },
});

describe("ArcgisEngine camera conventions", () => {
  it("maps MapLibre bearings to SDK rotations and back", () => {
    assert.equal(bearingToRotation(0), 0);
    assert.equal(bearingToRotation(90), 270);
    assert.equal(rotationToBearing(270), 90);
    assert.equal(rotationToBearing(bearingToRotation(-45)), 315);
  });
  it("reads the view in the store's shape and writes it back through goTo", () => {
    const { engine, goTo, rawView } = makeEngine();
    rawView.rotation = 270;
    const view = engine.readView();
    assert.deepEqual([view.center, view.zoom, view.bearing, view.pitch], [[10, 20], 5, 90, 0]);
    engine.applyView({ center: [1, 2], zoom: 7, bearing: 45, pitch: 30 });
    assert.equal(goTo.length, 1);
    const call = goTo[0] as {
      target: { center: [number, number]; zoom: number; rotation: number };
      options: { animate: boolean };
    };
    assert.deepEqual(call.target, { center: [1, 2], zoom: 7, rotation: 315 });
    assert.equal(call.options.animate, false);
    // An identical view is not re-applied.
    engine.applyView({ center: [1, 2], zoom: 7, bearing: 45, pitch: 0 });
    assert.equal(goTo.length, 1);
  });
  it("clamps saved views against the project preferences before the jump", () => {
    const { engine, goTo } = makeEngine();
    engine.applyMapPreferences({
      minZoom: 3,
      maxZoom: 10,
      maxPitch: 60,
      renderWorldCopies: false,
      restrictBounds: false,
      bounds: [-180, -85, 180, 85],
      projection: "mercator",
      scaleUnit: "imperial",
    } as MapPreferences);
    engine.applyView({ center: [200, 90], zoom: 15, bearing: 0, pitch: 0 });
    const call = goTo.at(-1) as { target: { center: [number, number]; zoom: number } };
    assert.deepEqual(call.target.center, [180, 85]);
    assert.equal(call.target.zoom, 10);
  });
  it("converts GeoJSON geometry to SDK geometry JSON", () => {
    assert.deepEqual(geojsonToArcgisGeometry({ type: "Point", coordinates: [1, 2] }), {
      type: "point",
      x: 1,
      y: 2,
      spatialReference: { wkid: 4326 },
    });
    const multi = geojsonToArcgisGeometry({
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
        [
          [
            [2, 2],
            [3, 2],
            [3, 3],
            [2, 2],
          ],
        ],
      ],
    });
    assert.equal((multi as { rings: unknown[] }).rings.length, 2);
    assert.equal(geojsonToArcgisGeometry({ type: "GeometryCollection", geometries: [] }), null);
  });
});

describe("ArcgisEngine controls", () => {
  it("replaces the SDK's default UI with the Controls menu's default set", () => {
    const { engine, widgets, uiAdds, rawView } = makeEngine();
    assert.deepEqual(rawView.ui.components, []);
    // Fullscreen, compass and scale are on by default; navigation (zoom) and
    // geolocate are off, as on MapLibre. Globe and terrain have no SDK
    // equivalent and are skipped. Attribution is the view's own rendering
    // (`attributionVisible`), not a widget, and can never be turned off.
    assert.equal(rawView.attributionVisible, true);
    assert.deepEqual(
      widgets.map((w) => w.kind),
      ["Fullscreen", "Compass", "ScaleBar"],
    );
    assert.deepEqual(
      uiAdds.map((entry) => entry.position),
      ["top-right", "top-right", "bottom-left"],
    );
    assert.equal(engine.setBuiltInControlVisible("navigation", true), true);
    assert.equal(widgets.at(-1)?.kind, "Zoom");
    assert.equal(engine.setBuiltInControlVisible("attribution", false), false);
    assert.equal(engine.setBuiltInControlVisible("globe", true), false);
    assert.equal(engine.setBuiltInControlVisible("layer-control", true), false);
    // Repositioning re-mounts into the new corner.
    assert.equal(engine.setBuiltInControlPosition("scale", "bottom-right"), true);
    assert.equal(engine.getBuiltInControlPosition("scale"), "bottom-right");
    assert.equal(uiAdds.at(-1)?.position, "bottom-right");
    // Plugin IControls have no host here.
    assert.equal(engine.addControl(), false);
    assert.equal(engine.capabilities.domControls, false);
  });
  it("forwards the scale unit and compass label to the widgets", () => {
    const { engine, widgets } = makeEngine();
    engine.applyMapPreferences({
      minZoom: 0,
      maxZoom: 24,
      maxPitch: 85,
      renderWorldCopies: true,
      restrictBounds: false,
      bounds: [-180, -85, 180, 85],
      projection: "mercator",
      scaleUnit: "imperial",
    } as MapPreferences);
    assert.equal(widgets.find((w) => w.kind === "ScaleBar")?.unit, "non-metric");
    engine.setCompassLabel("Reset");
    assert.equal(widgets.find((w) => w.kind === "Compass")?.label, "Reset");
  });
});

describe("ArcgisEngine layer sync", () => {
  beforeEach(() => {
    useAppStore.getState().newProject();
  });
  it("builds one SDK layer per geometry kind and stacks them in store order", () => {
    const { engine, layers, created } = makeEngine();
    const other = geojsonLayer({
      id: "layer-b",
      name: "Layer B",
      geojson: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
        ],
      },
    });
    // Store order is topmost first: A above B.
    engine.syncLayers([SQUARE, other]);
    const kinds = layers.items.map((l) => `${l.kind}:${l.title}`);
    assert.deepEqual(kinds, ["geojson:Layer B", "geojson:Layer A", "geojson:Layer A"]);
    const square = created.filter((l) => l.title === "Layer A");
    assert.deepEqual(
      square.map((l) => l.props.geometryType),
      ["polygon", "point"],
    );
    assert.ok(String(square[0].props.url).startsWith("blob:"));
    assert.equal((square[0].props.renderer as { type: string }).type, "simple");
    // Reordering the store reorders the map without rebuilding.
    engine.syncLayers([other, SQUARE]);
    assert.deepEqual(
      layers.items.map((l) => l.title),
      ["Layer A", "Layer A", "Layer B"],
    );
    assert.equal(created.length, 3);
  });
  it("applies visibility and opacity in place, rebuilds on a style change, removes on drop", () => {
    const { engine, layers, created } = makeEngine();
    engine.syncLayers([SQUARE]);
    const before = [...layers.items];
    engine.syncLayers([{ ...SQUARE, visible: false, opacity: 0.4 }]);
    assert.equal(created.length, 2);
    assert.ok(before.every((l) => l.visible === false && l.opacity === 0.4));
    engine.syncLayers([{ ...SQUARE, style: { ...DEFAULT_LAYER_STYLE, fillColor: "#ff0000" } }]);
    assert.equal(created.length, 4);
    assert.ok(before.every((l) => l.destroyed));
    const rebuilt = layers.items[0];
    const symbol = (rebuilt.props.renderer as { symbol: { color: number[] } }).symbol;
    assert.deepEqual(symbol.color.slice(0, 3), [255, 0, 0]);
    engine.syncLayers([]);
    assert.equal(layers.length, 0);
    assert.ok(created.every((l) => l.destroyed));
  });
  it("records a compile failure against the layer and clears it when the layer goes", () => {
    const { engine } = makeEngine();
    const archive = geojsonLayer({
      id: "pm",
      name: "Archive",
      geojson: undefined,
      type: "pmtiles",
      source: { url: "https://x/a.pmtiles" },
    });
    engine.syncLayers([archive]);
    assert.match(engine.getRenderStatus().errors.join(), /Archive: pmtiles archives/);
    engine.syncLayers([{ ...archive, visible: false }]);
    assert.deepEqual(engine.getRenderStatus().errors, []);
  });
  it("draws raster and service records through the SDK's layer classes", () => {
    const { engine, layers } = makeEngine();
    engine.syncLayers([
      {
        ...geojsonLayer({ id: "xyz", name: "Tiles", geojson: undefined }),
        type: "xyz",
        source: { type: "raster", tiles: ["https://t/{z}/{x}/{y}.png"], attribution: "© T" },
      },
      {
        ...geojsonLayer({ id: "fs", name: "Service", geojson: undefined }),
        type: "arcgis",
        source: { type: "geojson", url: "https://h/rest/services/X/FeatureServer/0" },
      },
    ]);
    assert.deepEqual(
      layers.items.map((l) => l.kind),
      ["feature", "web-tile"],
    );
    assert.equal(layers.items[1].props.urlTemplate, "https://t/{level}/{col}/{row}.png");
    assert.equal(layers.items[1].props.copyright, "© T");
    assert.deepEqual(engine.getLayerRasterSource("xyz"), {
      type: "raster",
      tiles: ["https://t/{level}/{col}/{row}.png"],
      attribution: "© T",
    });
  });
  it("recompiles zoom-dependent layers when the integer zoom changes", () => {
    const { engine, created, rawView, fireWatchers } = makeEngine();
    engine.syncLayers([
      { ...SQUARE, style: { ...DEFAULT_LAYER_STYLE, strokeWidthUnit: "meters", strokeWidth: 100 } },
    ]);
    const count = created.length;
    fireWatchers();
    assert.equal(created.length, count);
    rawView.zoom = 9;
    fireWatchers();
    assert.ok(created.length > count);
  });
});

describe("ArcgisEngine basemap", () => {
  it("swaps between an Esri style, translated tiles and nothing", () => {
    const { engine, map, created } = makeEngine({ hasApiKey: true });
    engine.setBasemap(undefined, "arcgis/streets");
    assert.equal(map.basemap as unknown, "arcgis/streets");
    engine.setBasemap("https://tiles.openfreemap.org/styles/liberty", undefined);
    const tiles = created.filter((l) => l.kind === "web-tile");
    assert.equal(tiles.length, 1);
    assert.ok(String(tiles[0].props.urlTemplate).includes("{level}"));
    engine.setBasemapOpacity(0.5);
    engine.setBasemapVisible(false);
    assert.equal(tiles[0].opacity, 0.5);
    assert.equal(tiles[0].visible, false);
    engine.setBasemap(BLANK_BASEMAP, undefined);
    assert.equal(map.basemap, null);
  });
  it("ignores the Esri style without an API key", () => {
    const { engine, map } = makeEngine({ hasApiKey: false });
    engine.setBasemap(undefined, "arcgis/streets");
    assert.notEqual(map.basemap as unknown, "arcgis/streets");
    assert.ok(map.basemap);
  });
});

describe("ArcgisEngine picking and highlight", () => {
  it("resolves hit graphics to the store's feature identity and answers the sync identify", async () => {
    const { engine, layers, setHitResults } = makeEngine();
    engine.syncLayers([SQUARE]);
    const polygonLayer = layers.items.find((l) => l.props.geometryType === "polygon")!;
    setHitResults([
      {
        type: "graphic",
        graphic: { attributes: { [ARCGIS_ID_FIELD]: "sq" }, layer: polygonLayer },
      },
      {
        type: "graphic",
        graphic: { attributes: { [ARCGIS_ID_FIELD]: "sq" }, layer: polygonLayer },
      },
    ]);
    const features = await engine.identifyFeaturesAt({ x: 0.5, y: 0.5 });
    assert.equal(features.length, 1);
    assert.equal(features[0].layerId, "layer-a");
    assert.equal(features[0].featureId, "sq");
    assert.deepEqual(features[0].properties, { name: "Square" });
    assert.equal(features[0].geometry?.type, "Polygon");
    assert.equal(engine.identifyFeatures([0.5, 0.5]).length, 1);
    assert.equal(engine.identifyFeatures([3, 3]).length, 0);
    assert.equal(engine.identifyFeatures([0.5, 0.5], "other").length, 0);
  });
  it("draws the selection as a graphics layer on top and clears it", () => {
    const { engine, layers } = makeEngine();
    engine.syncLayers([SQUARE]);
    engine.highlightFeature(SQUARE, "sq");
    assert.equal(layers.items.at(-1)?.kind, "graphics");
    assert.equal(layers.items.at(-1)?.graphics?.length, 1);
    engine.syncLayers([SQUARE]);
    assert.equal(layers.items.at(-1)?.kind, "graphics");
    engine.highlightFeature(SQUARE, null);
    assert.ok(layers.items.every((l) => l.kind !== "graphics"));
  });
  it("shows an extent as a rectangle graphic and disposes it", () => {
    const { engine, layers } = makeEngine();
    const dispose = engine.showExtent([0, 0, 1, 1]);
    assert.equal(layers.items.at(-1)?.kind, "graphics");
    dispose();
    assert.equal(layers.length, 0);
  });
});

describe("ArcgisEngine lifecycle", () => {
  it("destroys the view, the map layers and the widgets once", () => {
    const { engine, widgets, created, rawView } = makeEngine();
    engine.syncLayers([SQUARE]);
    engine.destroy();
    assert.ok(rawView.destroyed);
    assert.ok(created.every((l) => l.destroyed));
    assert.ok(widgets.every((w) => w.destroyed));
    assert.equal(engine.getView(), null);
    engine.destroy();
    assert.deepEqual(engine.readView(), { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 });
  });
  it("uses the document for the blank background colour", () => {
    const { document } = parseHTML("<html><body></body></html>");
    const previous = globalThis.document;
    (globalThis as { document: unknown }).document = document;
    try {
      const { engine, rawView } = makeEngine();
      engine.setBlankBackgroundColor("#123456");
      assert.deepEqual(rawView.background, { type: "color", color: "#123456" });
      engine.setBlankBackgroundColor(null);
      assert.deepEqual(rawView.background, { type: "color", color: "#ffffff" });
    } finally {
      (globalThis as { document: unknown }).document = previous;
    }
  });
});
