import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type LayerStyle } from "@geolibre/core";
import { CesiumLayerSync } from "../packages/map/src/cesium-layer-sync";

// A golden call log for the globe's GeoJSON and imagery create paths. Every
// Cesium constructor and factory call, every viewer mutation and every
// property write on a loaded entity is recorded in order, so a refactor of
// `createGeoJson` / `createImagery` that reorders a step (or changes what it
// writes) fails here even when the finished scene would look the same.
//
// After an intentional change, regenerate the fixture with
//   UPDATE_CALL_LOGS=1 node --import tsx --test tests/cesium-layer-sync-call-log.test.ts
// then format it with
//   npx oxfmt --write tests/fixtures/cesium-layer-sync-call-log.json
// and review its diff.

const FIXTURE = new URL("./fixtures/cesium-layer-sync-call-log.json", import.meta.url);
const UPDATE = process.env.UPDATE_CALL_LOGS === "1";

type LogEntry = [event: string, ...args: unknown[]];

/**
 * Builds a fake Cesium namespace and viewer that append every call to one log.
 *
 * @returns The fakes, the shared log and a microtask flush helper.
 */
function makeRecordingCesium() {
  const log: LogEntry[] = [];

  /** A constructor that records `new Name(...args)` and keeps the args. */
  const recordingClass = (name: string) =>
    class {
      readonly __class = name;
      readonly args: unknown[];
      constructor(...args: unknown[]) {
        this.args = args;
        log.push([`new ${name}`, ...args]);
      }
    };

  /** A static factory that records its call and resolves to a tagged object. */
  const recordingFactory =
    (name: string) =>
    (...args: unknown[]) => {
      log.push([name, ...args]);
      return Promise.resolve({ __from: name, args });
    };

  const color = (css: string, alpha = 1) => ({
    css,
    alpha,
    withAlpha: (a: number) => color(css, a),
  });

  class Cartesian3 {
    constructor(
      public x = 0,
      public y = 0,
      public z = 0,
    ) {}
    static equals(a?: Cartesian3, b?: Cartesian3) {
      return Boolean(a && b && a.x === b.x && a.y === b.y && a.z === b.z);
    }
    static distance(a: Cartesian3, b: Cartesian3) {
      return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    }
    static lerp(a: Cartesian3, b: Cartesian3, t: number, out = new Cartesian3()) {
      return Object.assign(out, {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
      });
    }
    static clone(from?: Cartesian3, to?: Cartesian3) {
      const out = to ?? new Cartesian3();
      if (from) Object.assign(out, { x: from.x, y: from.y, z: from.z });
      return out;
    }
  }

  let entitySeq = 0;
  /** Wraps an entity graphics object so every property write is logged. */
  const watch = <T extends object>(path: string, target: T): T =>
    new Proxy(target, {
      set(obj, prop, value) {
        log.push(["set", `${path}.${String(prop)}`, value]);
        (obj as Record<string | symbol, unknown>)[prop] = value;
        return true;
      },
    });

  const makeEntity = (feature: Feature, index: number) => {
    const id = `e${entitySeq++}`;
    const base: Record<string, unknown> = {
      id,
      show: true,
      properties: {
        ...feature.properties,
        __geolibre_cesium_feature_index: { getValue: () => index },
      },
    };
    const type = feature.geometry?.type;
    if (type === "Polygon" || type === "MultiPolygon") {
      const ring =
        type === "Polygon"
          ? feature.geometry.coordinates[0]
          : (feature.geometry as { coordinates: number[][][][] }).coordinates[0][0];
      const hasZ = type === "Polygon" && (ring?.[0]?.length ?? 0) > 2;
      base.polygon = watch(`${id}.polygon`, {
        material: null,
        hierarchy: {
          getValue: () => ({ positions: ring.map(([x, y]) => new Cartesian3(x, y, 0)) }),
        },
        ...(hasZ ? { perPositionHeight: { getValue: () => true } } : {}),
      });
    } else if (type === "LineString") {
      base.polyline = watch(`${id}.polyline`, {
        material: null,
        positions: {
          getValue: () =>
            (feature.geometry as { coordinates: number[][] }).coordinates.map(
              ([x, y]) => new Cartesian3(x, y, 0),
            ),
        },
      });
    } else {
      const [x, y] = (feature.geometry as { coordinates: number[] }).coordinates;
      base.position = { getValue: () => new Cartesian3(x, y, 0) };
      base.billboard = watch(`${id}.billboard`, { color: undefined });
    }
    return watch(id, base);
  };

  const Cesium = {
    Cartesian2: recordingClass("Cartesian2"),
    Cartesian3,
    Color: {
      fromCssColorString: (css: string) => color(css),
      WHITE: color("WHITE"),
      BLACK: color("BLACK"),
      TRANSPARENT: color("TRANSPARENT", 0),
    },
    ConstantProperty: class {
      constructor(public value: unknown) {}
      getValue() {
        return this.value;
      }
    },
    ColorMaterialProperty: class {
      constructor(public color: unknown) {}
    },
    ImageMaterialProperty: recordingClass("ImageMaterialProperty"),
    CallbackProperty: recordingClass("CallbackProperty"),
    ConstantPositionProperty: recordingClass("ConstantPositionProperty"),
    Math: {
      toDegrees: (r: number) => (r * 180) / Math.PI,
      toRadians: (d: number) => (d * Math.PI) / 180,
    },
    DistanceDisplayCondition: recordingClass("DistanceDisplayCondition"),
    PointGraphics: recordingClass("PointGraphics"),
    LabelGraphics: recordingClass("LabelGraphics"),
    NearFarScalar: recordingClass("NearFarScalar"),
    HeightReference: { NONE: 0, CLAMP_TO_GROUND: 1, RELATIVE_TO_GROUND: 2 },
    HorizontalOrigin: { CENTER: 0, LEFT: 1, RIGHT: -1 },
    VerticalOrigin: { CENTER: 0, BOTTOM: 1, TOP: -1, BASELINE: 2 },
    LabelStyle: { FILL: 0, OUTLINE: 1, FILL_AND_OUTLINE: 2 },
    BoundingSphere: {
      fromPoints: (points: Cartesian3[]) => ({ center: points[0], radius: 1 }),
    },
    JulianDate: { fromDate: (d: Date) => d },
    Rectangle: {
      fromDegrees: (west: number, south: number, east: number, north: number) => {
        log.push(["Rectangle.fromDegrees", west, south, east, north]);
        return { west, south, east, north };
      },
    },
    Resource: recordingClass("Resource"),
    Credit: recordingClass("Credit"),
    Event: class {
      addEventListener() {}
      raiseEvent() {}
    },
    GeographicTilingScheme: recordingClass("GeographicTilingScheme"),
    WebMercatorTilingScheme: recordingClass("WebMercatorTilingScheme"),
    UrlTemplateImageryProvider: recordingClass("UrlTemplateImageryProvider"),
    WebMapServiceImageryProvider: recordingClass("WebMapServiceImageryProvider"),
    WebMapTileServiceImageryProvider: recordingClass("WebMapTileServiceImageryProvider"),
    ArcGisMapServerImageryProvider: {
      fromUrl: recordingFactory("ArcGisMapServerImageryProvider.fromUrl"),
    },
    SingleTileImageryProvider: {
      fromUrl: recordingFactory("SingleTileImageryProvider.fromUrl"),
    },
    IonImageryProvider: { fromAssetId: recordingFactory("IonImageryProvider.fromAssetId") },
    GeoJsonDataSource: {
      load: (data: FeatureCollection, options: Record<string, unknown>) => {
        log.push(["GeoJsonDataSource.load", data, options]);
        const values = data.features.flatMap((feature, index) => {
          // Cesium splits a MultiPolygon into one entity per part.
          if (feature.geometry?.type === "MultiPolygon") {
            return feature.geometry.coordinates.map((coordinates) =>
              makeEntity(
                { ...feature, geometry: { type: "MultiPolygon", coordinates: [coordinates] } },
                index,
              ),
            );
          }
          return [makeEntity(feature, index)];
        });
        return Promise.resolve({
          name: "geojson",
          show: true,
          isLoading: false,
          entities: {
            values,
            contains: (entity: unknown) => values.includes(entity as never),
            add: (spec: unknown) => {
              log.push(["entities.add", spec]);
              return spec;
            },
            suspendEvents: () => log.push(["entities.suspendEvents"]),
            resumeEvents: () => log.push(["entities.resumeEvents"]),
          },
          clustering: undefined,
        });
      },
    },
  };

  const cameraEvent = { addEventListener: () => {}, removeEventListener: () => {} };
  const viewer = {
    clock: { currentTime: { dayNumber: 0, secondsOfDay: 0 } },
    camera: {
      moveEnd: cameraEvent,
      changed: cameraEvent,
      positionWC: new Cartesian3(1, 2, 3),
      directionWC: new Cartesian3(0, 0, -1),
      frustum: { fovy: 1 },
    },
    scene: {
      mode: 3,
      canvas: { clientWidth: 800, clientHeight: 600, width: 800, height: 600 },
      globe: {
        ellipsoid: {
          scaleToGeodeticSurface: (p: Cartesian3) => p,
          cartesianToCartographic: (p: Cartesian3) => ({
            longitude: (p.x * Math.PI) / 180,
            latitude: (p.y * Math.PI) / 180,
            height: p.z,
          }),
        },
      },
      primitives: {
        add: (p: unknown) => log.push(["primitives.add", p]),
        remove: (p: unknown) => log.push(["primitives.remove", p]),
      },
      requestRender: () => log.push(["scene.requestRender"]),
    },
    imageryLayers: {
      addImageryProvider: (provider: unknown) => {
        log.push(["imageryLayers.addImageryProvider", provider]);
        return { provider, show: true, alpha: 1 };
      },
      remove: (layer: unknown, destroy?: boolean) =>
        log.push(["imageryLayers.remove", layer, destroy]),
      raiseToTop: (layer: unknown) => log.push(["imageryLayers.raiseToTop", layer]),
    },
    dataSources: {
      add: (ds: unknown) => {
        log.push(["dataSources.add"]);
        return Promise.resolve(ds);
      },
      remove: (_ds: unknown, destroy?: boolean) => log.push(["dataSources.remove", destroy]),
    },
  };

  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { Cesium, viewer, log, flush };
}

/**
 * Makes a log JSON-stable: functions become a marker, repeated objects a
 * back-reference marker, and non-finite numbers strings.
 *
 * @param log The recorded entries.
 * @returns A plain JSON value.
 */
function normalize(log: LogEntry[]): unknown {
  const seen = new WeakSet<object>();
  return JSON.parse(
    JSON.stringify(log, (_key, value: unknown) => {
      if (typeof value === "function") return "[function]";
      if (value === undefined) return "[undefined]";
      if (typeof value === "number" && !Number.isFinite(value)) return String(value);
      if (value && typeof value === "object") {
        if (seen.has(value)) return "[seen]";
        seen.add(value);
        if (value instanceof AbortController || value instanceof AbortSignal) return "[abort]";
        const name = (value as object).constructor?.name;
        if (name && name !== "Object" && name !== "Array" && !("__class" in value)) {
          if (name === "ProtocolImageryProvider") {
            // Only what shapes the Cesium calls: its private state and the
            // injected Cesium namespace would tie the golden to internals.
            const provider = value as Record<string, unknown>;
            return {
              __instance: name,
              template: provider.template,
              scheme: provider.scheme,
              rectangle: provider.rectangle,
              tileWidth: provider.tileWidth,
              tileHeight: provider.tileHeight,
              minimumLevel: provider.minimumLevel,
              maximumLevel: provider.maximumLevel,
              credit: provider.credit,
            };
          }
          return { __instance: name, ...(value as Record<string, unknown>) };
        }
      }
      return value;
    }),
  );
}

function feature(geometry: Feature["geometry"], properties: Record<string, unknown>): Feature {
  return { type: "Feature", properties, geometry };
}

function square(x: number, y: number, z?: number): number[][] {
  const at = (px: number, py: number) => (z === undefined ? [px, py] : [px, py, z]);
  return [at(x, y), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x, y)];
}

const collection = (features: Feature[]): FeatureCollection => ({
  type: "FeatureCollection",
  features,
});

const polygons = collection([
  feature({ type: "Polygon", coordinates: [square(0, 0)] }, { name: "A", kind: "a", h: 10 }),
  feature({ type: "Polygon", coordinates: [square(2, 0)] }, { name: "B", kind: "b", h: -5 }),
  feature(
    { type: "MultiPolygon", coordinates: [[square(4, 0)], [square(6, 0)]] },
    { name: "C", kind: "a", h: "30" },
  ),
]);

const zPolygons = collection([
  feature({ type: "Polygon", coordinates: [square(0, 0, 50)] }, { name: "Z", h: 20 }),
  feature({ type: "Polygon", coordinates: [square(2, 0)] }, { name: "flat", h: 20 }),
]);

const mixedZ = collection([
  feature({ type: "Polygon", coordinates: [square(0, 0)] }, { name: "poly", h: 5 }),
  feature(
    {
      type: "LineString",
      coordinates: [
        [0, 0, 5],
        [1, 1, 10],
      ],
    },
    { name: "line" },
  ),
  feature({ type: "Point", coordinates: [3, 3, 7] }, { name: "pt" }),
]);

const lineAndPoints = collection([
  feature(
    {
      type: "LineString",
      coordinates: [
        [0, 0],
        [2, 2],
      ],
    },
    { name: "road", kind: "a" },
  ),
  feature({ type: "Point", coordinates: [1, 1] }, { name: "P1", kind: "b" }),
]);

function layer(patch: Partial<GeoLibreLayer> & { style?: Partial<LayerStyle> }): GeoLibreLayer {
  return {
    id: "l1",
    name: "layer",
    type: "geojson",
    source: {},
    visible: true,
    opacity: 0.8,
    metadata: {},
    ...patch,
    style: patch.style as LayerStyle,
  } as GeoLibreLayer;
}

const withLabels = (patch: Partial<LayerStyle["labels"]> = {}): Partial<LayerStyle> => ({
  labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "name", ...patch },
});

const scenarios: Record<string, GeoLibreLayer> = {
  "geojson-flat": layer({
    geojson: polygons,
    style: { fillColor: "#ff0000", strokeColor: "#00ff00", fillOpacity: 0.5, strokeWidth: 3 },
  }),
  "geojson-categorized-labels": layer({
    geojson: polygons,
    style: {
      vectorStyleMode: "categorized",
      vectorStyleProperty: "kind",
      vectorStyleStops: [
        { value: "a", color: "#aa0000" },
        { value: "b", color: "#00aa00" },
      ],
      minZoom: 3,
      maxZoom: 15,
      ...withLabels(),
    },
  }),
  "geojson-extrusion": layer({
    geojson: polygons,
    style: {
      extrusionEnabled: true,
      extrusionHeightProperty: "h",
      extrusionHeightScale: 2,
      extrusionBase: 1,
      extrusionOpacity: 0.7,
    },
  }),
  "geojson-extrusion-expressions": layer({
    geojson: polygons,
    style: {
      extrusionEnabled: true,
      extrusionAdvancedStyleEnabled: true,
      extrusionHeightExpression: '["*", ["to-number", ["get", "h"]], 3]',
      extrusionColorExpression: '["match", ["get", "kind"], "a", "#ff00ff", "#00ffff"]',
    },
  }),
  "geojson-extrusion-z": layer({
    geojson: zPolygons,
    style: { extrusionEnabled: true, extrusionHeightProperty: "h" },
  }),
  "geojson-elevation-3d": layer({
    geojson: mixedZ,
    style: { elevation3dEnabled: true, elevation3dVerticalScale: 2, elevation3dOffset: 10 },
  }),
  "geojson-extrusion-and-z": layer({
    geojson: mixedZ,
    style: { extrusionEnabled: true, extrusionHeightProperty: "h" },
  }),
  "geojson-lines-points": layer({
    geojson: lineAndPoints,
    style: { circleRadius: 6, fillColor: "#123456", ...withLabels({ transform: "uppercase" }) },
  }),
  "imagery-xyz": layer({
    type: "xyz",
    source: {
      tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"],
      minzoom: 2,
      maxzoom: 18,
      tileSize: 512,
      bounds: [-10, -10, 10, 10],
      attribution: "Example",
    },
  }),
  "imagery-tms-headers": layer({
    type: "raster",
    source: {
      tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"],
      scheme: "tms",
      requestHeaders: { Authorization: "Bearer x" },
    },
  }),
  "imagery-insecure-headers": layer({
    type: "raster",
    source: {
      tiles: ["http://tiles.example.com/{z}/{x}/{y}.png"],
      requestHeaders: { Authorization: "Bearer x" },
    },
  }),
  "imagery-unregistered-protocol": layer({
    type: "raster",
    source: { tiles: ["nosuchproto://tiles/{z}/{x}/{y}"] },
  }),
  "imagery-wms": layer({
    type: "wms",
    source: {
      url: "https://wms.example.com/wms",
      layers: "a,b",
      format: "image/jpeg",
      transparent: false,
      version: "1.3.0",
    },
  }),
  "imagery-wmts": layer({
    type: "wmts",
    source: {
      url: "https://wmts.example.com/{TileMatrix}/{TileRow}/{TileCol}",
      layer: "roads",
      tileMatrixSetID: "EPSG:4326",
      tilingScheme: "GeographicTilingScheme",
      tileMatrixLabels: ["0", "1"],
      maxzoom: 12,
    },
  }),
  "imagery-wmts-bad-scheme": layer({
    type: "wmts",
    source: {
      url: "https://wmts.example.com/wmts",
      layer: "roads",
      tileMatrixSet: "custom",
      tilingScheme: "PolarTilingScheme",
    },
  }),
  "imagery-arcgis": layer({
    type: "raster",
    sourcePath: "https://services.example.com/arcgis/rest/services/X/MapServer",
    metadata: { sourceKind: "arcgis-map-service", arcgisSublayers: "show:0,2" },
    source: { tiles: ["https://services.example.com/tile/{z}/{y}/{x}?token=abc"] },
  }),
  "imagery-image": layer({
    type: "image",
    source: {
      url: "https://example.com/overlay.png",
      coordinates: [
        [0, 10],
        [10, 10],
        [10, 0],
        [0, 0],
      ],
    },
  }),
  "imagery-pmtiles": layer({
    type: "pmtiles",
    metadata: { tileType: "raster", sourceKind: "pmtiles-url" },
    source: { type: "raster", url: "pmtiles://https://example.com/a.pmtiles" },
  }),
  "imagery-ion": layer({
    type: "raster",
    metadata: { sourceKind: "cesium-ion" },
    source: { ionAssetId: 3954 },
  }),
};

async function runScenario(target: GeoLibreLayer): Promise<unknown> {
  const f = makeRecordingCesium();
  const sync = new CesiumLayerSync(f.Cesium as never, f.viewer as never, () => 6, {
    ionToken: () => "ion-token",
    readPMTilesHeader: async () =>
      ({
        minLon: -20,
        minLat: -20,
        maxLon: 20,
        maxLat: 20,
        minZoom: 1,
        maxZoom: 9,
      }) as never,
    renderMarker: async (_style, colour) => ({
      canvas: { sprite: colour ?? "base" } as unknown as HTMLCanvasElement,
      pixelRatio: 2,
    }),
    renderFillPattern: async () => null,
    onLayerError: (error) => f.log.push(["onLayerError", error]),
  });
  const warn = console.warn;
  console.warn = (...args: unknown[]) => f.log.push(["console.warn", ...args]);
  try {
    sync.sync([target]);
    await f.flush();
  } finally {
    console.warn = warn;
  }
  return normalize(f.log);
}

describe("cesium-layer-sync create call log", async () => {
  const actual: Record<string, unknown> = {};
  for (const [name, target] of Object.entries(scenarios)) {
    actual[name] = await runScenario(target);
  }

  if (UPDATE) writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
  const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;

  for (const name of Object.keys(actual)) {
    it(`replays the ${name} scenario call for call`, () => {
      assert.deepEqual(actual[name], expected[name]);
    });
  }
});
