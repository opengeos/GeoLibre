import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  type LayerStyle,
} from "../packages/core/src/types";
import {
  createFeatureStyleResolver,
  sameFeatureSymbol,
} from "../packages/map/src/cesium-feature-style";
import { CesiumLayerSync } from "../packages/map/src/cesium-layer-sync";

// The per-feature style resolver (issue #2278). The expressions it evaluates
// are the real ones `@geolibre/core` builds for the 2D map, compiled by the
// real style-spec engine; only the Cesium widget is faked, in the layer-sync
// half below, so the answers here are exactly what both renderers draw.

function feature(properties: Record<string, unknown>, type = "Point") {
  return {
    type: "Feature" as const,
    properties,
    geometry:
      type === "Point"
        ? { type: "Point" as const, coordinates: [0, 0] }
        : type === "LineString"
          ? {
              type: "LineString" as const,
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            }
          : {
              type: "Polygon" as const,
              coordinates: [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 0],
                ],
              ],
            },
  };
}

function style(patch: Partial<LayerStyle>): LayerStyle {
  return { ...DEFAULT_LAYER_STYLE, ...patch };
}

/** style-spec colours come back as `rgba(r,g,b,a)`; compare on the channels. */
function rgb(css: string): [number, number, number] {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const hex = css.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

describe("createFeatureStyleResolver", () => {
  it("resolves the flat layer style in single mode", () => {
    const resolver = createFeatureStyleResolver(
      style({ fillColor: "#ff0000", strokeColor: "#00ff00", strokeWidth: 3, circleRadius: 9 }),
    );
    assert.equal(resolver.zoomDependent, false);
    const symbol = resolver.resolve(feature({}), 5);
    assert.deepEqual(rgb(symbol.fill), [255, 0, 0]);
    assert.deepEqual(rgb(symbol.stroke), [0, 255, 0]);
    assert.deepEqual(rgb(symbol.outline), [0, 255, 0]);
    assert.equal(symbol.strokeWidth, 3);
    assert.equal(symbol.radius, 9);
    assert.equal(symbol.fillOpacity, DEFAULT_LAYER_STYLE.fillOpacity);
    assert.equal(symbol.markerScale, 1);
  });

  it("classifies by a categorical field, falling back for unlisted values", () => {
    const resolver = createFeatureStyleResolver(
      style({
        vectorStyleMode: "categorized",
        vectorStyleProperty: "kind",
        vectorStyleStops: [
          { value: "park", color: "#00aa00" },
          { value: "water", color: "#0000aa" },
        ],
        fillColor: "#999999",
      }),
    );
    assert.deepEqual(rgb(resolver.resolve(feature({ kind: "park" }), 0).fill), [0, 170, 0]);
    assert.deepEqual(rgb(resolver.resolve(feature({ kind: "water" }), 0).fill), [0, 0, 170]);
    assert.deepEqual(rgb(resolver.resolve(feature({ kind: "road" }), 0).fill), [153, 153, 153]);
    // Points and markers take the same classification.
    assert.deepEqual(rgb(resolver.resolve(feature({ kind: "park" }), 0).markerColor), [0, 170, 0]);
  });

  it("classifies a numeric field into graduated steps", () => {
    const resolver = createFeatureStyleResolver(
      style({
        vectorStyleMode: "graduated",
        vectorStyleProperty: "pop",
        vectorStyleStops: [
          { value: 0, color: "#111111" },
          { value: 100, color: "#555555" },
          { value: 1000, color: "#999999" },
        ],
      }),
    );
    assert.deepEqual(rgb(resolver.resolve(feature({ pop: 5 }), 0).fill), [17, 17, 17]);
    assert.deepEqual(rgb(resolver.resolve(feature({ pop: 500 }), 0).fill), [85, 85, 85]);
    assert.deepEqual(rgb(resolver.resolve(feature({ pop: 5000 }), 0).fill), [153, 153, 153]);
  });

  it("applies rule colours, per-rule symbol overrides, and the else rule", () => {
    const resolver = createFeatureStyleResolver(
      style({
        vectorStyleMode: "rule-based",
        vectorRules: [
          {
            id: "big",
            label: "Big",
            filter: JSON.stringify([">", ["get", "size"], 10]),
            color: "#ff0000",
            isElse: false,
            circleRadius: 14,
            strokeWidth: 5,
            strokeColor: "#0000ff",
            fillOpacity: 0.9,
          },
          { id: "else", label: "Other", filter: "", color: "#00ff00", isElse: true },
        ],
        circleRadius: 4,
        strokeWidth: 1,
      }),
    );
    const big = resolver.resolve(feature({ size: 20 }), 0);
    assert.deepEqual(rgb(big.fill), [255, 0, 0]);
    assert.equal(big.radius, 14);
    assert.equal(big.strokeWidth, 5);
    assert.deepEqual(rgb(big.outline), [0, 0, 255]);
    assert.equal(big.fillOpacity, 0.9);
    const small = resolver.resolve(feature({ size: 2 }), 0);
    assert.deepEqual(rgb(small.fill), [0, 255, 0]);
    assert.equal(small.radius, 4);
    assert.equal(small.strokeWidth, 1);
  });

  it("evaluates a user expression and falls back to the flat colour when it is invalid", () => {
    const ok = createFeatureStyleResolver(
      style({
        vectorStyleMode: "expression",
        vectorStyleExpression: JSON.stringify([
          "case",
          ["boolean", ["get", "flag"], false],
          "#ff00ff",
          "#00ffff",
        ]),
      }),
    );
    assert.deepEqual(rgb(ok.resolve(feature({ flag: true }), 0).fill), [255, 0, 255]);
    assert.deepEqual(rgb(ok.resolve(feature({ flag: false }), 0).fill), [0, 255, 255]);
    const broken = createFeatureStyleResolver(
      style({
        vectorStyleMode: "expression",
        vectorStyleExpression: JSON.stringify(["no-such-operator", 1]),
        fillColor: "#123456",
      }),
    );
    assert.deepEqual(rgb(broken.resolve(feature({}), 0).fill), [0x12, 0x34, 0x56]);
  });

  it("sizes circles and lines proportionally to a field, clamped to the range", () => {
    const resolver = createFeatureStyleResolver(
      style({
        proportionalSizeEnabled: true,
        proportionalSizeProperty: "mag",
        proportionalSizeMinValue: 0,
        proportionalSizeMaxValue: 10,
        proportionalSizeMinRadius: 2,
        proportionalSizeMaxRadius: 22,
      }),
    );
    assert.equal(resolver.resolve(feature({ mag: 0 }), 0).radius, 2);
    assert.equal(resolver.resolve(feature({ mag: 5 }), 0).radius, 12);
    assert.equal(resolver.resolve(feature({ mag: 50 }), 0).radius, 22);
    // Lines reuse the radius range as a width range, as the 2D map does.
    assert.equal(resolver.resolve(feature({ mag: 5 }, "LineString"), 0).strokeWidth, 12);
  });

  it("is zoom-dependent for metre-unit strokes and scales the width with zoom", () => {
    const resolver = createFeatureStyleResolver(
      style({ strokeWidthUnit: "meters", strokeWidth: 100 }),
    );
    assert.equal(resolver.zoomDependent, true);
    const line = feature({}, "LineString");
    const z10 = resolver.resolve(line, 10).strokeWidth;
    const z11 = resolver.resolve(line, 11).strokeWidth;
    assert.ok(z10 > 0);
    assert.ok(Math.abs(z11 / z10 - 2) < 1e-6, "one zoom level doubles the pixel width");
    // Polygon outlines are line layers too and scale the same way; circle
    // strokes stay pixel-based.
    assert.equal(resolver.resolve(feature({}, "Polygon"), 10).strokeWidth, z10);
    assert.equal(resolver.resolve(feature({}), 10).strokeWidth, 100);
  });

  it("honours simplestyle per-feature properties when the layer enables them", () => {
    const resolver = createFeatureStyleResolver(style({ simpleStyleEnabled: true }));
    const styled = resolver.resolve(
      feature(
        { fill: "#ff8800", stroke: "#0088ff", "stroke-width": 7, "fill-opacity": 0.25 },
        "Polygon",
      ),
      0,
    );
    assert.deepEqual(rgb(styled.fill), [255, 136, 0]);
    assert.deepEqual(rgb(styled.stroke), [0, 136, 255]);
    assert.equal(styled.strokeWidth, 7);
    assert.equal(styled.fillOpacity, 0.25);
  });

  it("compares symbols channel by channel", () => {
    const resolver = createFeatureStyleResolver(style({}));
    const a = resolver.resolve(feature({}), 0);
    assert.equal(sameFeatureSymbol(a, resolver.resolve(feature({}), 0)), true);
    assert.equal(sameFeatureSymbol(a, { ...a, radius: a.radius + 1 }), false);
  });
});

// ---------------------------------------------------------------------------
// Layer sync: the resolver's answers reach the entities.
// ---------------------------------------------------------------------------

function makeFakes() {
  const dataSources: Array<{ entities: { values: FakeEntity[] } }> = [];
  const cameraListeners = new Set<() => void>();
  interface FakeEntity {
    properties: Record<string, unknown>;
    show: boolean;
    polygon?: Record<string, unknown>;
    polyline?: Record<string, unknown>;
    billboard?: Record<string, unknown>;
    point?: Record<string, unknown>;
  }
  const viewer = {
    clock: { currentTime: { dayNumber: 0, secondsOfDay: 0 } },
    camera: {
      moveEnd: {
        addEventListener: (l: () => void) => cameraListeners.add(l),
        removeEventListener: (l: () => void) => cameraListeners.delete(l),
      },
      changed: {
        addEventListener: (l: () => void) => cameraListeners.add(l),
        removeEventListener: (l: () => void) => cameraListeners.delete(l),
      },
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600, width: 800, height: 600 },
      mode: 3,
      primitives: { add: () => {}, remove: () => {} },
      requestRender: () => {},
    },
    imageryLayers: { addImageryProvider: () => ({}), remove: () => {}, raiseToTop: () => {} },
    dataSources: {
      add: async (ds: unknown) => ds,
      remove: () => {},
    },
  };
  class ConstantProperty {
    constructor(public value: unknown) {}
    getValue() {
      return this.value;
    }
  }
  const Cesium = {
    GeoJsonDataSource: {
      load: (data: {
        features: Array<{ geometry?: { type?: string }; properties?: Record<string, unknown> }>;
      }) => {
        const values: FakeEntity[] = data.features.map((f, index) => {
          const base = {
            properties: {
              ...f.properties,
              __geolibre_cesium_feature_index: { getValue: () => index },
            },
            show: true,
          };
          const type = f.geometry?.type;
          if (type === "Polygon") return { ...base, polygon: { material: null } };
          if (type === "LineString") return { ...base, polyline: { material: null } };
          return { ...base, billboard: { color: undefined } };
        });
        const ds = {
          entities: { values, contains: (e: unknown) => values.includes(e as FakeEntity) },
          show: true,
          isLoading: false,
        };
        dataSources.push(ds);
        return Promise.resolve(ds);
      },
    },
    HeightReference: { NONE: 0, CLAMP_TO_GROUND: 1, RELATIVE_TO_GROUND: 2 },
    ColorMaterialProperty: class {
      constructor(public color: unknown) {}
    },
    ConstantProperty,
    Color: {
      fromCssColorString: (css: string) => ({
        css,
        alpha: 1,
        withAlpha: (alpha: number) => ({ css, alpha }),
      }),
      WHITE: { withAlpha: (alpha: number) => ({ css: "WHITE", alpha }) },
    },
    Rectangle: { fromDegrees: () => ({}) },
    JulianDate: { fromDate: (d: Date) => d },
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { viewer, Cesium, dataSources, flush, cameraListeners };
}

function geojsonLayer(features: unknown[], patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "l1",
    name: "layer",
    type: "geojson",
    source: {},
    visible: true,
    opacity: 1,
    style: {},
    metadata: {},
    geojson: { type: "FeatureCollection", features } as never,
    ...patch,
  };
}

describe("CesiumLayerSync per-feature symbology", () => {
  it("bakes a categorized colour into each polygon and draws points as circles", async () => {
    const f = makeFakes();
    const sync = new CesiumLayerSync(f.Cesium as never, f.viewer as never, () => 12);
    sync.sync([
      geojsonLayer(
        [
          feature({ kind: "park" }, "Polygon"),
          feature({ kind: "water" }, "Polygon"),
          feature({ kind: "park" }, "Point"),
        ],
        {
          opacity: 0.5,
          style: {
            vectorStyleMode: "categorized",
            vectorStyleProperty: "kind",
            vectorStyleStops: [
              { value: "park", color: "#00aa00" },
              { value: "water", color: "#0000aa" },
            ],
            fillOpacity: 0.8,
            circleRadius: 7,
            strokeWidth: 3,
          },
        },
      ),
    ]);
    await f.flush();
    await f.flush();
    const [park, water, point] = f.dataSources[0].entities.values;
    const material = (e: { polygon?: Record<string, unknown> }) =>
      (e.polygon?.material as { color: { css: string; alpha: number } }).color;
    assert.deepEqual(rgb(material(park).css), [0, 170, 0]);
    assert.deepEqual(rgb(material(water).css), [0, 0, 170]);
    assert.ok(Math.abs(material(park).alpha - 0.4) < 1e-9, "fill opacity × layer opacity");
    assert.equal((park.polygon?.outlineWidth as { value: number }).value, 3);
    // The point lost its pin billboard and became a circle of the classified colour.
    assert.equal(point.billboard, undefined);
    const circle = point.point as Record<string, { value: unknown }>;
    assert.equal(circle.pixelSize.value, 14);
    assert.deepEqual(rgb((circle.color.value as { css: string }).css), [0, 170, 0]);
    assert.equal(circle.heightReference as unknown as number, 1, "clamped to ground");
  });

  it("re-resolves widths when the camera crosses a zoom level for metre-unit strokes", async () => {
    const f = makeFakes();
    let zoom = 10;
    const sync = new CesiumLayerSync(f.Cesium as never, f.viewer as never, () => zoom);
    sync.sync([
      geojsonLayer([feature({}, "LineString")], {
        style: { strokeWidthUnit: "meters", strokeWidth: 100 },
      }),
    ]);
    await f.flush();
    await f.flush();
    const line = f.dataSources[0].entities.values[0];
    const width = () => (line.polyline?.width as { value: number }).value;
    const atZ10 = width();
    assert.ok(atZ10 > 0);
    assert.equal(f.cameraListeners.size > 0, true, "a zoom-dependent style watches the camera");
    zoom = 11;
    for (const listener of f.cameraListeners) listener();
    assert.ok(Math.abs(width() / atZ10 - 2) < 1e-6, "the width doubled with the zoom");
  });

  it("restyles in place when only the fill opacity changes", async () => {
    const f = makeFakes();
    const sync = new CesiumLayerSync(f.Cesium as never, f.viewer as never, () => 12);
    const layer = geojsonLayer([feature({}, "Polygon")], { style: { fillOpacity: 0.5 } });
    sync.sync([layer]);
    await f.flush();
    await f.flush();
    assert.equal(f.dataSources.length, 1);
    sync.sync([{ ...layer, style: { fillOpacity: 0.1 } }]);
    await f.flush();
    assert.equal(f.dataSources.length, 1, "no reload for an opacity-only edit");
    const polygon = f.dataSources[0].entities.values[0].polygon as {
      material: { color: { alpha: number } };
    };
    assert.ok(Math.abs(polygon.material.color.alpha - 0.1) < 1e-9);
    // A classification edit reloads.
    sync.sync([
      {
        ...layer,
        style: { fillOpacity: 0.1, vectorStyleMode: "categorized", vectorStyleProperty: "k" },
      },
    ]);
    await f.flush();
    await f.flush();
    assert.equal(f.dataSources.length, 2);
  });
});
