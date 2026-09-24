import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  BLANK_BASEMAP,
  DEFAULT_LAYER_STYLE,
  useAppStore,
  type MapPreferences,
} from "@geolibre/core";
import {
  ARCGIS_WORLD_ELEVATION_URL,
  ArcgisEngine,
  arcgisSceneMode,
  bearingToRotation,
  geojsonToArcgisGeometry,
  rotationToBearing,
} from "../packages/map/src/arcgis-engine";
import type {
  ArcgisLayer,
  ArcgisMap,
  ArcgisMapView,
  ArcgisSceneSdk,
  ArcgisSdk,
} from "../packages/map/src/arcgis-sdk";
import { ARCGIS_ID_FIELD, zoomToScale } from "../packages/map/src/arcgis-layers";
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
  const basemaps: { destroyed: boolean }[] = [];
  const widgets: { kind: string; props: Record<string, unknown>; destroyed: boolean }[] = [];
  const goTo: unknown[] = [];
  let watchers: (() => void)[] = [];
  const viewHandlers = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  const syncWatchers = new Set<() => void>();
  const layerClass = (kind: string) =>
    class {
      kind = kind;
      props: Record<string, unknown>;
      id = `${kind}-${created.length}`;
      title: string | null;
      type = kind;
      opacity: number;
      private visibility = true;
      get visible() {
        return this.visibility;
      }
      set visible(value: boolean) {
        this.visibility = value;
        for (const watch of syncWatchers) watch();
      }
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
    ground: { layers: collection<unknown>(), surfaceColor: null as unknown },
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
    type: "2d" as "2d" | "3d",
    viewingMode: "global" as "global" | "local",
    camera: null as null | { heading: number; tilt: number; position: { z: number } },
    environment: {} as Record<string, unknown>,
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
      const t = target as {
        center?: [number, number];
        zoom?: number;
        rotation?: number;
        heading?: number;
        tilt?: number;
      };
      if (t && typeof t === "object" && !("xmin" in t)) {
        if (t.center) [view.center.longitude, view.center.latitude] = t.center;
        if (t.zoom !== undefined) view.zoom = t.zoom;
        if (t.rotation !== undefined) view.rotation = t.rotation;
        if (view.camera && t.heading !== undefined) view.camera.heading = t.heading;
        if (view.camera && t.tilt !== undefined) view.camera.tilt = t.tilt;
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
    on: (type: string, handler: (event: Record<string, unknown>) => void) => {
      const handlers = viewHandlers.get(type) ?? new Set();
      handlers.add(handler);
      viewHandlers.set(type, handlers);
      return { remove: () => handlers.delete(handler) };
    },
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
      destroyed = false;
      constructor(props: { baseLayers?: FakeLayer[] } = {}) {
        if (props.baseLayers) this.baseLayers.addMany(props.baseLayers);
        basemaps.push(this as never);
      }
      destroy() {
        this.destroyed = true;
      }
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
      BaseTileLayer: { createSubclass: () => layerClass("template-tile") },
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
    media: {
      ImageElement: class {},
      ExtentAndRotationGeoreference: class {},
      ControlPointsGeoreference: class {},
    },
    widgets: {
      Zoom: widgetClass("Zoom"),
      Compass: widgetClass("Compass"),
      ScaleBar: widgetClass("ScaleBar"),
      Fullscreen: widgetClass("Fullscreen"),
      Locate: widgetClass("Locate"),
      LayerList: widgetClass("LayerList"),
      Expand: widgetClass("Expand"),
    },
    reactiveUtils: {
      watch: (get: () => unknown, cb: () => void, options?: { sync?: boolean }) => {
        let previous = get();
        const watch = options?.sync
          ? () => {
              const next = get();
              if (next === previous) return;
              previous = next;
              cb();
            }
          : cb;
        watchers.push(watch);
        if (options?.sync) syncWatchers.add(watch);
        return {
          remove: () => {
            watchers = watchers.filter((w) => w !== watch);
            syncWatchers.delete(watch);
          },
        };
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
    basemaps,
    widgets,
    goTo,
    uiAdds,
    layers,
    fireWatchers: () => watchers.forEach((w) => w()),
    fireViewEvent: (type: string, event: Record<string, unknown>) => {
      for (const handler of viewHandlers.get(type) ?? []) handler(event);
    },
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

/** The 3D modules, recording the elevation layers the engine builds. */
function makeSceneSdk() {
  const elevations: { props: Record<string, unknown>; destroyed: boolean; exaggerated: boolean }[] =
    [];
  const definitions: Record<string, unknown>[] = [];
  const elevationClass = (exaggerated: boolean) =>
    class {
      destroyed = false;
      exaggerated = exaggerated;
      constructor(public props: Record<string, unknown> = {}) {
        elevations.push(this);
      }
      destroy() {
        this.destroyed = true;
      }
    };
  const scene = {
    SceneView: class {},
    ElevationLayer: elevationClass(false),
    BaseElevationLayer: {
      createSubclass: (definition: Record<string, unknown>) => {
        definitions.push(definition);
        return elevationClass(true);
      },
    },
  };
  return { scene: scene as unknown as ArcgisSceneSdk, elevations, definitions };
}

/** An engine over a fake `SceneView` looking north-east at a 45 degree tilt. */
function makeSceneEngine(
  viewingMode: "global" | "local" = "global",
  options: ConstructorParameters<typeof ArcgisEngine>[3] = {},
) {
  const fake = makeSdk();
  const sceneSdk = makeSceneSdk();
  Object.assign(fake.rawView, {
    type: "3d",
    viewingMode,
    camera: { heading: 30, tilt: 45, position: { z: 1500 } },
    constraints: { tilt: { max: 80 } },
  });
  const engine = new ArcgisEngine(fake.sdk, fake.map, fake.view, {
    scene: sceneSdk.scene,
    ...options,
  });
  return { engine, ...fake, ...sceneSdk };
}

const PREFERENCES = {
  minZoom: 0,
  maxZoom: 24,
  maxPitch: 60,
  renderWorldCopies: true,
  restrictBounds: false,
  bounds: [-180, -85, 180, 85],
  projection: "globe",
  scaleUnit: "metric",
  terrainEnabled: false,
} as MapPreferences;

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

describe("ArcgisEngine camera moves", () => {
  it("frames an extent at the zoom that fits it, without a zoom-14 cap", async () => {
    const { engine, goTo } = makeEngine();
    engine.fitBounds([-0.001, -0.001, 0.001, 0.001]);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(goTo.length, 1);
    assert.ok("xmin" in (goTo[0] as { target: object }).target);
  });
  it("flies to a point-sized extent at zoom 14 or closer", () => {
    const { engine, goTo, rawView } = makeEngine();
    engine.fitBounds([3, 4, 3, 4]);
    assert.deepEqual((goTo[0] as { target: unknown }).target, { center: [3, 4], zoom: 14 });
    rawView.zoom = 17;
    engine.fitBounds([3, 4, 3, 4]);
    assert.deepEqual((goTo[1] as { target: unknown }).target, { center: [3, 4], zoom: 17 });
  });
  it("fits a tile layer at its minimum render zoom when its extent is wider", () => {
    const { engine, goTo } = makeEngine();
    const tiles = {
      ...geojsonLayer({ id: "t", geojson: undefined }),
      type: "vector-tiles" as const,
      source: { type: "vector", minzoom: 15, bounds: [-10, -10, 10, 10] },
    };
    engine.fitLayer(tiles);
    assert.deepEqual((goTo.at(-1) as { target: unknown }).target, { center: [0, 0], zoom: 15 });
    // A small enough extent is framed as usual.
    engine.fitLayer({ ...tiles, source: { ...tiles.source, bounds: [0, 0, 0.001, 0.001] } });
    assert.ok("xmin" in (goTo.at(-1) as { target: object }).target);
  });
  it("turns a story chapter once, and not when a later chapter superseded it", async () => {
    const { engine, goTo } = makeEngine();
    engine.applyStoryChapterCamera({ center: [1, 2], zoom: 5 }, "flyTo", true);
    engine.applyStoryChapterCamera({ center: [3, 4], zoom: 6 }, "flyTo", false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(goTo.length, 2);
    engine.applyStoryChapterCamera({ center: [3, 4], zoom: 6 }, "flyTo", true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const turns = goTo.filter((call) => "rotation" in (call as { target: object }).target);
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0], {
      target: { rotation: -180 },
      options: { duration: 30000, easing: "linear" },
    });
  });
  it("marks the settle that ends a story move as scripted", async () => {
    const { engine, fireWatchers, fireViewEvent } = makeEngine();
    const seen: (boolean | undefined)[] = [];
    engine.onCameraIdle((event) => seen.push(event?.storyCamera));
    fireWatchers();
    engine.applyStoryChapterCamera({ center: [1, 2], zoom: 5 });
    fireWatchers();
    await Promise.resolve();
    fireWatchers();
    // A drag during a story move makes the next settle the user's.
    engine.applyStoryChapterCamera({ center: [3, 4], zoom: 6 });
    fireViewEvent("drag", { x: 1, y: 1, action: "start" });
    fireWatchers();
    engine.destroy();
    assert.deepEqual(seen, [false, true, false, false]);
  });
  it("reads and steps the zoom of a view with no tiling scheme through its scale", () => {
    const { engine, goTo, rawView } = makeEngine();
    rawView.zoom = -1;
    rawView.scale = zoomToScale(3);
    assert.ok(Math.abs(engine.readView().zoom - 3) < 1e-9);
    // A view with no scale yet reads as zoom 0, never a non-finite level.
    rawView.scale = 0;
    assert.equal(engine.readView().zoom, 0);
    rawView.scale = zoomToScale(3);
    engine.zoomIn();
    const target = (goTo[0] as { target: { scale: number } }).target;
    assert.ok(Math.abs(target.scale - zoomToScale(4)) < 1e-6);
  });
});

describe("ArcgisEngine camera conventions", () => {
  it("publishes geographic map clicks and removes the listener on cleanup", () => {
    const { engine, fireViewEvent, rawView } = makeEngine();
    // Screen and geographic coordinates differ, so forwarding event.x/y fails.
    rawView.toMap = (p: { x: number; y: number }) => ({
      longitude: p.x / 10,
      latitude: p.y / 10,
      x: p.x,
      y: p.y,
    });
    const clicks: [number, number][] = [];
    const unsubscribe = engine.onMapClick((lngLat) => clicks.push(lngLat));

    fireViewEvent("click", { x: -765, y: 392.5 });
    assert.deepEqual(clicks, [[-76.5, 39.25]]);

    unsubscribe();
    fireViewEvent("click", { x: 10, y: 20 });
    assert.deepEqual(clicks, [[-76.5, 39.25]]);
  });

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
  it("returns no coordinate for a screen point that has no map location", () => {
    const { engine, rawView } = makeSceneEngine();
    rawView.toMap = () => null;
    assert.equal(engine.getRenderSurface()?.unproject([10, 20]), null);
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
  it("bridges native layer toggles to the store without feeding store updates back", () => {
    const changes: [string, boolean][] = [];
    const { engine, created, fireWatchers, widgets } = makeEngine({
      onLayerVisibilityChange: (id, visible) => changes.push([id, visible]),
    });
    const layer = geojsonLayer({
      geojson: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
          },
        ],
      },
    });
    engine.syncLayers([layer]);
    const native = created.find((item) => item.kind === "geojson")!;
    assert.equal(native.listMode, "hide-children");
    assert.equal(created.filter((item) => item.kind === "geojson")[1].listMode, "hide");
    assert.ok(widgets.some((widget) => widget.kind === "LayerList"));
    native.visible = false;
    fireWatchers();
    assert.deepEqual(changes, [[layer.id, false]]);
    engine.syncLayers([{ ...layer, visible: false }]);
    fireWatchers();
    assert.equal(changes.length, 1);
    engine.syncLayers([]);
    native.visible = true;
    fireWatchers();
    assert.equal(changes.length, 1);
    engine.destroy();
    assert.ok(widgets.every((widget) => widget.destroyed));
  });

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
    // Missing controls are rejected before consulting the plugin control host.
    assert.equal(engine.addControl(), false);
    assert.equal(engine.capabilities.domControls, true);
  });
  it("mounts moved controls in the corners an earlier view reported", () => {
    const moves: [string, string][] = [];
    const { engine, uiAdds } = makeEngine({
      controlPositions: { compass: "bottom-left" },
      onControlPositionChange: (control, position) => moves.push([control, position]),
    });
    // Fullscreen, compass, scale: the compass lands where it was moved to.
    assert.deepEqual(
      uiAdds.map((entry) => entry.position),
      ["top-right", "bottom-left", "bottom-left"],
    );
    engine.setBuiltInControlPosition("scale", "top-left");
    assert.deepEqual(moves, [["scale", "top-left"]]);
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
      source: { url: "https://x/a.pmtiles", encoding: "mlt" },
    });
    engine.syncLayers([archive]);
    assert.match(engine.getRenderStatus().errors.join(), /Archive: ArcGIS requires MVT/);
    engine.syncLayers([{ ...archive, visible: false }]);
    assert.deepEqual(engine.getRenderStatus().errors, []);
  });
  it("names a plugin-drawn layer it cannot show in the banner, while visible", () => {
    const { engine } = makeEngine();
    const mirror = {
      ...geojsonLayer({ id: "pc", name: "Sentinel-2", geojson: undefined }),
      type: "raster" as const,
      source: { sourceId: "pc" },
      metadata: { externalNativeLayer: true, nativeLayerIds: ["pc-layer"] },
    };
    engine.syncLayers([mirror]);
    assert.match(engine.getRenderStatus().errors.join(), /Sentinel-2: drawn by a plugin/);
    engine.syncLayers([{ ...mirror, visible: false }]);
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
    // Story exports rebuild the layer in MapLibre, so they get the store template.
    assert.deepEqual(engine.getLayerRasterSource("xyz"), {
      type: "raster",
      tiles: ["https://t/{z}/{x}/{y}.png"],
      attribution: "© T",
    });
  });
  it("draws TMS and bounding-box templates through a custom tile layer", () => {
    const { engine, layers } = makeEngine();
    engine.syncLayers([
      {
        ...geojsonLayer({ id: "tms", name: "TMS", geojson: undefined }),
        type: "xyz",
        source: { type: "raster", tiles: ["https://t/{z}/{x}/{y}.png"], scheme: "tms" },
      },
    ]);
    assert.deepEqual(
      layers.items.map((l) => l.kind),
      ["template-tile"],
    );
    assert.equal(engine.getRenderStatus().errors.length, 0);
    assert.deepEqual(engine.getLayerRasterSource("tms"), {
      type: "raster",
      tiles: ["https://t/{z}/{x}/{y}.png"],
      scheme: "tms",
      tileSize: 256,
      minzoom: 0,
      maxzoom: 22,
    });
  });
  it("applies the raster effect and blend mode in place, the effect to rasters only", () => {
    const { engine, created, layers } = makeEngine();
    const tiles = {
      ...geojsonLayer({ id: "xyz", name: "Tiles", geojson: undefined }),
      type: "xyz" as const,
      source: { type: "raster", tiles: ["https://t/{z}/{x}/{y}.png"] },
    };
    engine.syncLayers([tiles, SQUARE]);
    const count = created.length;
    engine.syncLayers([
      { ...tiles, style: { ...DEFAULT_LAYER_STYLE, rasterSaturation: -1, blendMode: "multiply" } },
      { ...SQUARE, style: { ...DEFAULT_LAYER_STYLE, rasterSaturation: -1 } },
    ]);
    const raster = layers.items.find((l) => l.kind === "web-tile")!;
    assert.equal(raster.effect, "brightness(1) contrast(1) saturate(0) hue-rotate(0deg)");
    assert.equal(raster.blendMode, "multiply");
    assert.ok(layers.items.filter((l) => l.kind === "geojson").every((l) => l.effect === null));
    // The tile layer was not rebuilt for a slider change.
    assert.ok(layers.items.includes(created.find((l) => l.kind === "web-tile")!));
    assert.ok(created.length >= count);
  });
  it("changes a GeoJSON layer's blend mode in place", () => {
    const { engine, created } = makeEngine();
    engine.syncLayers([SQUARE]);
    const count = created.length;
    engine.syncLayers([{ ...SQUARE, style: { ...DEFAULT_LAYER_STYLE, blendMode: "multiply" } }]);
    assert.equal(created.length, count, "no native layer was rebuilt");
    assert.ok(created.slice(-2).every((layer) => layer.blendMode === "multiply"));
  });
  it("hands story exports plain HTTP tile templates for service and desktop WMS layers", () => {
    const { engine } = makeEngine();
    const service = (id: string, url: string, metadata = {}) => ({
      ...geojsonLayer({ id, name: id, geojson: undefined }),
      type: "arcgis" as const,
      source: { url },
      metadata,
    });
    engine.syncLayers([
      service("tiled", "https://h/rest/services/A/MapServer/", { arcgisTiled: true }),
      service("dynamic", "https://h/rest/services/B/MapServer/3"),
      service("imagery", "https://h/rest/services/C/ImageServer"),
    ]);
    assert.deepEqual(engine.getLayerRasterSource("tiled")?.tiles, [
      "https://h/rest/services/A/MapServer/tile/{z}/{y}/{x}",
    ]);
    assert.match(
      String((engine.getLayerRasterSource("dynamic")?.tiles as string[])[0]),
      /^https:\/\/h\/rest\/services\/B\/MapServer\/export\?bbox=\{bbox-epsg-3857\}/,
    );
    assert.match(
      String((engine.getLayerRasterSource("imagery")?.tiles as string[])[0]),
      /ImageServer\/exportImage\?/,
    );
  });
  it("fades a story chapter's layer opacity over the transition", () => {
    const { engine, created } = makeEngine();
    const frames: FrameRequestCallback[] = [];
    const previous = {
      requestAnimationFrame: globalThis.requestAnimationFrame,
      cancelAnimationFrame: globalThis.cancelAnimationFrame,
    };
    Object.assign(globalThis, {
      requestAnimationFrame: (cb: FrameRequestCallback) => frames.push(cb),
      cancelAnimationFrame: () => {},
    });
    try {
      engine.syncLayers([SQUARE]);
      const native = created.at(-1)!;
      const start = performance.now();
      engine.setStoryLayerOpacity(SQUARE.id, 0, 1000);
      // Still where it was until frames run.
      assert.equal(native.opacity, 1);
      frames.shift()!(start + 500);
      assert.ok(native.opacity > 0.3 && native.opacity < 0.7, String(native.opacity));
      frames.shift()!(start + 2000);
      assert.equal(native.opacity, 0);
      assert.equal(frames.length, 0);
      // No duration applies at once.
      engine.setStoryLayerOpacity(SQUARE.id, 0.5);
      assert.equal(native.opacity, 0.5);
    } finally {
      Object.assign(globalThis, previous);
    }
  });
  it("reuses a GeoJSON plan across opacity, visibility and name changes", () => {
    const { engine, created } = makeEngine();
    engine.syncLayers([SQUARE]);
    const count = created.length;
    const native = created[count - 1];
    engine.syncLayers([{ ...SQUARE, opacity: 0.4, visible: false, name: "Renamed" }]);
    assert.equal(created.length, count);
    assert.equal(native.opacity, 0.4);
    assert.equal(native.visible, false);
    assert.equal(native.title, "Renamed");
    // A re-style still rebuilds.
    engine.syncLayers([{ ...SQUARE, style: { ...DEFAULT_LAYER_STYLE, fillColor: "#00ff00" } }]);
    assert.ok(created.length > count);
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
  it("destroys the outgoing custom basemap when switching to an Esri style", () => {
    const { engine, map, basemaps } = makeEngine({ hasApiKey: true });
    engine.setBasemap("https://tiles.openfreemap.org/styles/liberty", undefined);
    assert.equal(basemaps.length, 1);
    engine.setBasemap(undefined, "arcgis/streets");
    assert.equal(map.basemap as unknown, "arcgis/streets");
    assert.equal(basemaps[0].destroyed, true);
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
  it("skips cluster graphics instead of reporting their object id as a feature", async () => {
    const { engine, layers, setHitResults } = makeEngine();
    engine.syncLayers([SQUARE]);
    const pointLayer = layers.items.find((l) => l.props.geometryType === "point")!;
    setHitResults([
      {
        type: "graphic",
        graphic: {
          attributes: { OBJECTID: 1, cluster_count: 12 },
          layer: pointLayer,
          isAggregate: true,
        },
      },
    ]);
    assert.deepEqual(await engine.identifyFeaturesAt({ x: 5, y: 5 }), []);
  });
  it("answers an arbitrary coordinate synchronously from the store's geometry", () => {
    const { engine } = makeEngine();
    engine.syncLayers([SQUARE]);
    // Inside the polygon, without any prior hit test.
    const inside = engine.identifyFeatures([0.25, 0.75]);
    assert.equal(inside.length, 1);
    assert.equal(inside[0].featureId, "sq");
    assert.deepEqual(inside[0].properties, { name: "Square" });
    // The point feature, within the pixel tolerance at the fake view's zoom.
    const dot = engine.identifyFeatures([5.0001, 5]);
    assert.equal(dot.length, 1);
    assert.equal(dot[0].featureId, "1");
    assert.equal(engine.identifyFeatures([8, 8]).length, 0);
    assert.equal(engine.identifyFeatures([0.25, 0.75], "other").length, 0);
    // Hidden layers and filtered-out features are not picked.
    engine.syncLayers([{ ...SQUARE, visible: false }]);
    assert.equal(engine.identifyFeatures([0.25, 0.75]).length, 0);
    engine.syncLayers([{ ...SQUARE, embedFilter: ["==", ["get", "name"], "Dot"] }]);
    assert.equal(engine.identifyFeatures([0.25, 0.75]).length, 0);
  });
  it("takes a service feature's geometry and object id from the hit graphic", async () => {
    const { engine, layers, setHitResults } = makeEngine();
    engine.syncLayers([
      {
        ...geojsonLayer({ id: "fs", name: "Service", geojson: undefined }),
        type: "arcgis",
        source: { type: "geojson", url: "https://h/rest/services/X/FeatureServer/0" },
      },
    ]);
    const service = layers.items[0];
    setHitResults([
      {
        type: "graphic",
        graphic: {
          attributes: { OBJECTID: 7, NAME: "Parcel" },
          layer: service,
          geometry: {
            type: "polygon",
            rings: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
            spatialReference: { wkid: 4326 },
          },
        },
      },
    ]);
    const [feature] = await engine.identifyFeaturesAt({ x: 0, y: 0 });
    assert.equal(feature.layerId, "fs");
    assert.equal(feature.featureId, "7");
    assert.deepEqual(feature.properties, { OBJECTID: 7, NAME: "Parcel" });
    assert.equal(feature.geometry?.type, "Polygon");
  });
  it("keeps synchronous control results when a native hit test outlives the engine", async () => {
    const { setArcgisControlPicker } = await import("../packages/map/src/arcgis-control-adapters");
    const { engine, setHitResults } = makeEngine();
    const external = {
      layerId: "query",
      featureId: "12",
      properties: { NAME: "station" },
      geometry: null,
    };
    setArcgisControlPicker(engine.getView()!, () => [external]);
    engine.syncLayers([SQUARE]);
    setHitResults([
      { type: "graphic", graphic: { attributes: { [ARCGIS_ID_FIELD]: "sq" }, layer: null } },
    ]);
    const pending = engine.identifyFeaturesAt({ x: 0.5, y: 0.5 });
    engine.destroy();
    assert.deepEqual(await pending, [external]);
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
  it("keeps search graphics separate from feature selection and disposes only their owner", () => {
    const { engine, layers } = makeEngine();
    engine.syncLayers([SQUARE]);
    engine.highlightFeature(SQUARE, "sq");
    const selection = layers.items.at(-1);
    const clearPoint = engine.showSearchResult({ type: "Point", coordinates: [-77.0365, 38.8977] });
    const point = layers.items.at(-1)!;
    assert.deepEqual(point.graphics!.getItemAt(0).geometry, {
      type: "point",
      x: -77.0365,
      y: 38.8977,
      spatialReference: { wkid: 4326 },
    });
    const ring = [
      [179, 0],
      [181, 0],
      [181, 1],
      [179, 0],
    ];
    const clearCell = engine.showSearchResult({ type: "Polygon", coordinates: [ring] });
    const cell = layers.items.at(-1)!;
    assert.equal(cell.graphics!.getItemAt(0).geometry?.type, "polygon");
    clearPoint();
    clearPoint();
    assert.ok(point.destroyed);
    assert.ok(layers.items.includes(cell));
    assert.ok(layers.items.includes(selection!));
    engine.clearFeatureHighlight();
    assert.ok(layers.items.includes(cell));
    engine.destroy();
    assert.ok(cell.destroyed);
    assert.doesNotThrow(clearCell);
    assert.doesNotThrow(() => engine.showSearchResult({ type: "Point", coordinates: [0, 0] })());
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

describe("ArcgisEngine 3D scenes", () => {
  it("picks the view the projection and terrain need", () => {
    assert.equal(arcgisSceneMode("mercator", false), "2d");
    assert.equal(arcgisSceneMode("mercator", true), "local");
    assert.equal(arcgisSceneMode("globe", false), "global");
    assert.equal(arcgisSceneMode("globe", true), "global");
  });

  it("reads the camera's heading and tilt as bearing and pitch", () => {
    const { engine } = makeSceneEngine();
    const view = engine.readView();
    assert.deepEqual([view.center, view.zoom, view.bearing, view.pitch], [[10, 20], 5, 30, 45]);
    assert.equal(engine.readProjection(), "globe");
    assert.equal(engine.readCameraAltitude(), 1500);
    assert.equal(makeSceneEngine("local").engine.readProjection(), "mercator");
    // A MapView has no camera to report.
    assert.equal(makeEngine().engine.readCameraAltitude(), null);
    assert.equal(makeEngine().engine.readProjection(), "mercator");
  });

  it("writes heading and tilt through goTo, clamped to the project's pitch limit", () => {
    const { engine, goTo, rawView } = makeSceneEngine();
    engine.applyMapPreferences(PREFERENCES);
    assert.equal((rawView.constraints as { tilt: { max: number } }).tilt.max, 60);
    engine.applyView({ center: [1, 2], zoom: 7, bearing: 90, pitch: 75 });
    const call = goTo.at(-1) as { target: Record<string, unknown> };
    assert.deepEqual(call.target, { center: [1, 2], zoom: 7, heading: 90, tilt: 60 });
    // A pitch change alone moves the camera in a scene.
    const count = goTo.length;
    engine.applyView({ center: [1, 2], zoom: 7, bearing: 90, pitch: 20 });
    assert.equal(goTo.length, count + 1);
    engine.resetNorthPitch();
    assert.deepEqual((goTo.at(-1) as { target: unknown }).target, { heading: 0, tilt: 0 });
    engine.resetPitch();
    assert.deepEqual((goTo.at(-1) as { target: unknown }).target, { tilt: 0 });
    engine.flyTo({ bearing: 10, pitch: 30 });
    assert.deepEqual((goTo.at(-1) as { target: unknown }).target, { heading: 10, tilt: 30 });
  });

  it("drapes Esri's world elevation for terrain and exaggerates it", async () => {
    const { engine, map, elevations, definitions } = makeSceneEngine();
    const ground = (map as unknown as { ground: { layers: { items: unknown[] } } }).ground;
    assert.equal(engine.capabilities.terrain, true);
    assert.equal(engine.setTerrainEnabled(true), true);
    assert.equal(engine.isTerrainEnabled(), true);
    assert.equal(ground.layers.items.length, 1);
    assert.equal(elevations[0].props.url, ARCGIS_WORLD_ELEVATION_URL);
    // Re-applying the same preference does not rebuild the layer.
    engine.applyMapPreferences({ ...PREFERENCES, terrainEnabled: true });
    assert.equal(elevations.length, 1);

    engine.setTerrainExaggeration(2.5);
    assert.equal(engine.getTerrainExaggeration(), 2.5);
    assert.equal(elevations[0].destroyed, true);
    assert.deepEqual(ground.layers.items, [elevations[1]]);
    assert.equal(elevations[1].exaggerated, true);
    assert.equal(elevations[1].props.exaggeration, 2.5);

    // The subclass scales every height of the tile it fetched.
    const self = {
      exaggeration: 2.5,
      source: { fetchTile: async () => ({ values: new Float32Array([1, 2, 4]) }) },
    };
    const fetchTile = definitions[0].fetchTile as (
      this: unknown,
      ...args: number[]
    ) => Promise<{ values: Float32Array }>;
    assert.deepEqual([...(await fetchTile.call(self, 1, 2, 3)).values], [2.5, 5, 10]);

    // The layer the subclass loaded its tiles from goes with it.
    const source = { destroyed: false, destroy: () => (source.destroyed = true) };
    Object.assign(elevations[1], { source });
    engine.applyMapPreferences({ ...PREFERENCES, terrainEnabled: false });
    assert.equal(engine.isTerrainEnabled(), false);
    assert.deepEqual(ground.layers.items, []);
    assert.equal(elevations[1].destroyed, true);
    assert.equal(source.destroyed, true);
  });

  it("records terrain on a MapView without building elevation", () => {
    const { engine, map } = makeEngine();
    const ground = (map as unknown as { ground: { layers: { items: unknown[] } } }).ground;
    // Success lets the Controls menu write the preference that swaps in a scene.
    assert.equal(engine.setBuiltInControlVisible("terrain", true), true);
    assert.equal(engine.isTerrainEnabled(), true);
    assert.deepEqual(ground.layers.items, []);
  });

  it("extrudes polygons in a scene and passes their elevation info", () => {
    const { engine, created } = makeSceneEngine();
    engine.syncLayers([
      {
        ...SQUARE,
        style: { ...DEFAULT_LAYER_STYLE, extrusionEnabled: true, extrusionBase: 3 },
      },
    ]);
    const polygon = created.find((l) => l.props.geometryType === "polygon");
    const renderer = polygon?.props.renderer as {
      symbol: { type: string };
      visualVariables: unknown[];
    };
    assert.equal(renderer.symbol.type, "polygon-3d");
    assert.equal(renderer.visualVariables.length, 1);
    assert.deepEqual(polygon?.props.elevationInfo, { mode: "relative-to-ground", offset: 3 });
  });

  it("hosts the globe toggle only with a projection callback, and no scale bar in 3D", () => {
    const { document } = parseHTML("<html><body></body></html>");
    const previous = globalThis.document;
    (globalThis as { document: unknown }).document = document;
    try {
      const toggles: string[] = [];
      const { engine, widgets, uiAdds } = makeSceneEngine("global", {
        onProjectionToggle: (projection) => toggles.push(projection),
      });
      assert.deepEqual(
        widgets.map((w) => w.kind),
        ["Fullscreen", "Compass"],
      );
      assert.equal(engine.setBuiltInControlVisible("scale", true), false);
      const globe = uiAdds.find(
        (entry) => entry.component instanceof document.defaultView!.HTMLElement,
      )?.component as HTMLElement | undefined;
      const button = globe?.querySelector("button");
      assert.ok(button?.classList.contains("maplibregl-ctrl-globe-enabled"));
      button?.dispatchEvent(new document.defaultView!.Event("click"));
      assert.deepEqual(toggles, ["mercator"]);
      // The button repaints before the rebuilt view exists.
      assert.ok(button?.classList.contains("maplibregl-ctrl-globe"));
      assert.equal(button?.getAttribute("aria-label"), "Enable globe");
      assert.equal(engine.setBuiltInControlVisible("globe", false), true);
      assert.ok(!uiAdds.some((entry) => entry.component === globe));
      // Without a callback nothing could rebuild the view, so there is no toggle.
      assert.equal(makeSceneEngine().engine.setBuiltInControlVisible("globe", true), false);
    } finally {
      (globalThis as { document: unknown }).document = previous;
    }
  });
});

describe("ArcgisEngine native style plans", () => {
  it("hands heatmaps, clusters and elevated selections to the SDK", () => {
    const { engine, created, rawView } = makeEngine();
    const base = geojsonLayer({
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "high",
            properties: {},
            geometry: { type: "Point", coordinates: [10, 20, 100] },
          },
        ],
      },
    });
    engine.syncLayers([{ ...base, style: { ...base.style, pointRenderer: "heatmap" } }]);
    assert.equal((created.at(-1)!.props.renderer as { type: string }).type, "heatmap");
    assert.ok(
      (created.at(-1)!.props.fields as { name: string }[]).some(
        (field) => field.name === "gl__weight",
      ),
    );
    engine.syncLayers([{ ...base, style: { ...base.style, pointRenderer: "cluster" } }]);
    assert.equal((created.at(-1)!.props.featureReduction as { type: string }).type, "cluster");
    rawView.type = "3d";
    const elevated = {
      ...base,
      style: {
        ...base.style,
        elevation3dEnabled: true,
        elevation3dVerticalScale: 2,
        elevation3dOffset: 30,
      },
    };
    engine.syncLayers([elevated]);
    assert.equal(created.at(-1)!.props.hasZ, true);
    engine.highlightFeature(elevated, "high");
    const highlight = created.at(-1)!;
    assert.deepEqual(highlight.props.elevationInfo, { mode: "absolute-height" });
    const graphic = (
      highlight.props.graphics as { props?: unknown; geometry: { z: number; hasZ: boolean } }[]
    )[0];
    assert.equal(graphic.geometry.z, 230);
    assert.equal(graphic.geometry.hasZ, true);
    const flat = { ...base, style: { ...base.style, elevation3dEnabled: false } };
    engine.syncLayers([flat]);
    engine.highlightFeature(flat, "high");
    assert.deepEqual(created.at(-1)!.props.elevationInfo, { mode: "on-the-ground" });
    engine.destroy();
  });
});

it("identifies adapted controls when no native SDK layer is present and clears them on teardown", async () => {
  const { setArcgisControlPicker } = await import("../packages/map/src/arcgis-control-adapters");
  const { engine } = makeEngine();
  const feature = {
    layerId: "query",
    featureId: "12",
    properties: { NAME: "station" },
    geometry: null,
  };
  setArcgisControlPicker(engine.getView()!, (_point, layerId) =>
    !layerId || layerId === "query" ? [feature] : [],
  );
  assert.deepEqual(await engine.identifyFeaturesAt({ x: 1, y: 2 }, "query"), [feature]);
  assert.deepEqual(await engine.identifyFeaturesAt({ x: 1, y: 2 }, "other"), []);
  engine.destroy();
  assert.deepEqual(await engine.identifyFeaturesAt({ x: 1, y: 2 }, "query"), []);
});

it("commits native visibility before an unrelated store sync can overwrite the toggle", () => {
  let layer = SQUARE;
  const changes: boolean[] = [];
  const { engine, created } = makeEngine({
    onLayerVisibilityChange: (_id, visible) => {
      changes.push(visible);
      layer = { ...layer, visible };
      engine.syncLayers([layer]);
    },
  });
  engine.syncLayers([layer]);
  const native = created.find((item) => item.kind === "geojson")!;
  native.visible = false;
  // No asynchronous watcher flush between the user toggle and another update.
  engine.syncLayers([{ ...layer, opacity: 0.4 }]);
  assert.equal(native.visible, false);
  assert.deepEqual(changes, [false]);
  engine.destroy();
});

it("refreshes Zarr time slices without replacing the native layer", () => {
  const { engine, sdk, created } = makeEngine();
  let refreshes = 0;
  sdk.layers.BaseTileLayer = {
    createSubclass(definition: Record<string, unknown>) {
      class Native extends sdk.layers.WebTileLayer {
        refresh() {
          refreshes++;
        }
      }
      Object.assign(Native.prototype, definition);
      return Native;
    },
  } as unknown as ArcgisSdk["layers"]["BaseTileLayer"];
  const layer = geojsonLayer({
    type: "zarr",
    geojson: undefined,
    source: { url: "https://example.test/data.zarr", variable: "air", selector: { time: 0 } },
  });
  engine.syncLayers([layer]);
  const native = created.at(-1)!;
  assert.equal(refreshes, 0);
  const next = { ...layer, source: { ...layer.source, selector: { time: 1 } } };
  engine.syncLayers([next]);
  assert.equal(created.at(-1), native);
  assert.equal(native.destroyed, false);
  assert.equal(refreshes, 1);
  engine.syncLayers([next]);
  assert.equal(refreshes, 1, "unchanged selectors do not refresh");
  engine.syncLayers([{ ...next, source: { ...next.source, variable: "other" } }]);
  assert.equal(native.destroyed, true, "changing the variable rebuilds the grid");
  engine.destroy();
});

describe("ArcGIS custom terrain ownership", () => {
  function terrainHarness() {
    const { engine } = makeEngine();
    type Registration = Awaited<
      ReturnType<typeof import("../packages/map/src/cog-dem-source").registerCogDemSource>
    >;
    const pending = new Map<
      string,
      {
        resolve: (registration: Registration) => void;
        reject: (error: Error) => void;
      }
    >();
    (
      engine as unknown as {
        openCogDem: (source: string) => Promise<Registration>;
      }
    ).openCogDem = (source) =>
      new Promise((resolve, reject) => {
        pending.set(source, { resolve, reject });
      });
    const registration = (): Registration & { readonly disposals: number } => {
      let disposals = 0;
      return {
        tiles: ["unused"],
        renderTile: async () => new Uint8ClampedArray(256 * 256 * 4),
        dispose: () => {
          disposals++;
        },
        get disposals() {
          return disposals;
        },
      };
    };
    return { engine, pending, registration };
  }

  it("keeps the newest source and disposes a superseded pending source", async () => {
    const { engine, pending, registration } = terrainHarness();
    const first = engine.setTerrainCogSource("first");
    const second = engine.setTerrainCogSource("second");
    const old = registration(),
      latest = registration();
    pending.get("second")!.resolve(latest);
    assert.equal(await second, true);
    pending.get("first")!.resolve(old);
    assert.equal(await first, false);
    assert.equal(engine.getTerrainCogSource(), "second");
    assert.equal(old.disposals, 1);
    assert.equal(latest.disposals, 0);
    engine.destroy();
    assert.equal(latest.disposals, 1);
  });

  it("preserves working terrain after a failed replacement and disposes on clear", async () => {
    const { engine, pending, registration } = terrainHarness();
    const first = engine.setTerrainCogSource("working");
    const working = registration();
    pending.get("working")!.resolve(working);
    await first;
    const failed = engine.setTerrainCogSource("offline");
    pending.get("offline")!.reject(new Error("Network unavailable"));
    await assert.rejects(failed, /Network unavailable/);
    assert.equal(engine.getTerrainCogSource(), "working");
    assert.equal(working.disposals, 0);
    assert.equal(await engine.setTerrainCogSource(null), true);
    assert.equal(engine.hasCustomTerrainSource(), false);
    assert.equal(working.disposals, 1);
    engine.destroy();
    assert.equal(working.disposals, 1);
  });

  it("disposes a registration that completes after the view is destroyed", async () => {
    const { engine, pending, registration } = terrainHarness();
    const loading = engine.setTerrainCogSource("late");
    engine.destroy();
    const late = registration();
    pending.get("late")!.resolve(late);
    assert.equal(await loading, false);
    assert.equal(late.disposals, 1);
  });
});

describe("ArcGIS archive interceptor ownership", () => {
  const archive = () =>
    geojsonLayer({
      geojson: undefined,
      type: "pmtiles",
      source: {
        url: "https://example.test/archive.pmtiles",
        sourceLayers: ["buildings"],
        type: "vector",
      },
    });
  it("replaces interceptors on restyle and removes them with the layer", () => {
    const { engine, sdk, created } = makeEngine();
    const layer = archive();
    engine.syncLayers([layer]);
    assert.equal(sdk.config.request.interceptors.length, 1);
    const old = sdk.config.request.interceptors[0];
    const native = created.at(-1)!;
    engine.syncLayers([{ ...layer, style: { ...layer.style, fillColor: "#ff0000" } }]);
    assert.equal(sdk.config.request.interceptors.length, 1);
    assert.notEqual(sdk.config.request.interceptors[0], old);
    assert.equal(native.destroyed, true);
    engine.syncLayers([]);
    assert.equal(sdk.config.request.interceptors.length, 0);
    engine.destroy();
  });
  it("cleans up the interceptor when adding a constructed layer fails", () => {
    const { engine, sdk, map, created } = makeEngine();
    map.add = () => {
      throw new Error("SDK add failed");
    };
    engine.syncLayers([archive()]);
    assert.equal(sdk.config.request.interceptors.length, 0);
    assert.equal(created.at(-1)!.destroyed, true);
    assert.ok(engine.getRenderStatus().errors.some((error) => error.includes("SDK add failed")));
    engine.destroy();
  });
});

it("hosts DOM controls with instant jumps, navigation events and complete cleanup", () => {
  const { document, HTMLElement } = parseHTML("<html><body></body></html>").window;
  const previous = { document: globalThis.document, HTMLElement: globalThis.HTMLElement };
  Object.assign(globalThis, { document, HTMLElement });
  const { engine, rawView, goTo, uiAdds, fireWatchers, fireViewEvent } = makeEngine();
  rawView.container = document.body;
  const builtInCount = uiAdds.length;
  let facade!: MapLibreMap;
  let removed = 0;
  const control = {
    onAdd(map: MapLibreMap) {
      facade = map;
      return document.createElement("div");
    },
    onRemove() {
      removed++;
    },
  };
  try {
    assert.equal(engine.addControl(control, "bottom-right"), true);
    assert.equal(engine.addControl(control, "bottom-right"), true);
    assert.equal(uiAdds.length, builtInCount + 1);
    assert.equal(uiAdds.at(-1)!.position, "bottom-right");
    assert.ok(
      (uiAdds.at(-1)!.component as HTMLElement).classList.contains("maplibregl-ctrl-bottom-right"),
    );
    assert.equal(facade.hasControl(control), true);
    assert.deepEqual(facade.unproject([3, 4]).toArray(), [3, 4]);
    rawView.toMap = () => null;
    assert.deepEqual(facade.unproject([3, 4]).toArray(), engine.readView().center);
    facade.jumpTo({ center: { lng: 3, lat: 4 }, zoom: 9 });
    assert.deepEqual(goTo.at(-1), {
      target: { center: [3, 4], zoom: 9, rotation: 0 },
      options: { animate: false },
    });
    facade.easeTo({ zoom: 10 });
    assert.equal((goTo.at(-1) as { options: { duration: number } }).options.duration, 500);
    const events: string[] = [];
    for (const event of ["movestart", "moveend", "idle", "remove"])
      facade.on(event, () => events.push(event));
    rawView.stationary = false;
    fireWatchers();
    rawView.stationary = true;
    fireWatchers();
    assert.deepEqual(events, ["movestart", "moveend", "idle"]);
    // Camera frames and pointer events reach the facade as MapLibre's.
    const live: string[] = [];
    let clicked: number[] = [];
    facade.on("move", () => live.push("move"));
    facade.on("zoom", () => live.push("zoom"));
    facade.on("click", (event: { lngLat: { toArray(): number[] } }) => {
      clicked = event.lngLat.toArray();
    });
    rawView.toMap = (p: { x: number; y: number }) => ({ longitude: p.x, latitude: p.y }) as never;
    rawView.zoom = 11;
    fireWatchers();
    assert.ok(live.includes("move") && live.includes("zoom"));
    // The fake SDK re-runs every watcher, so the stationary one fired again.
    events.splice(3);
    fireViewEvent("click", { x: 5, y: 6 });
    assert.deepEqual(clicked, [5, 6]);
    engine.removeControl(control);
    assert.equal(facade.hasControl(control), false);
    assert.equal(removed, 1);
    assert.equal(uiAdds.length, builtInCount);
    let failedCleanup = 0;
    const broken = {
      onAdd(): HTMLElement {
        throw new Error("Control initialization failed");
      },
      onRemove() {
        failedCleanup++;
      },
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(engine.addControl(broken), false);
      assert.equal(failedCleanup, 1);
      assert.equal(facade.hasControl(broken), false);
      assert.equal(uiAdds.length, builtInCount);
    } finally {
      console.warn = warn;
    }
    engine.addControl(control);
    engine.destroy();
    assert.equal(removed, 2);
    assert.equal(uiAdds.length, builtInCount);
    assert.deepEqual(events, ["movestart", "moveend", "idle", "remove"]);
    fireWatchers();
    assert.equal(events.length, 4, "destroy removes the SDK event subscriptions");
  } finally {
    engine.destroy();
    Object.assign(globalThis, previous);
  }
});
