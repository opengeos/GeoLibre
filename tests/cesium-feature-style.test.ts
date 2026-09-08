import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  type LayerStyle,
} from "../packages/core/src/types";
import { createFeatureStyleResolver } from "../packages/map/src/cesium-feature-style";
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

  it("fills circles from marker-color and marker-opacity, as the 2D circle layer does", () => {
    const resolver = createFeatureStyleResolver(
      style({ simpleStyleEnabled: true, fillColor: "#999999", fillOpacity: 0.5 }),
    );
    const styled = resolver.resolve(
      feature({ "marker-color": "#ff8800", "marker-opacity": 0.25, fill: "#00ff00" }),
      0,
    );
    assert.deepEqual(rgb(styled.pointFill), [255, 136, 0], "the point ignores the polygon fill");
    assert.equal(styled.pointFillOpacity, 0.25);
    assert.deepEqual(rgb(styled.fill), [0, 255, 0], "the polygon channel keeps simplestyle fill");
    // Without simplestyle both channels agree with the classified colour.
    const plain = createFeatureStyleResolver(style({ fillColor: "#123456", fillOpacity: 0.7 }));
    const symbol = plain.resolve(feature({}), 0);
    assert.deepEqual(rgb(symbol.pointFill), [0x12, 0x34, 0x56]);
    assert.equal(symbol.pointFillOpacity, 0.7);
  });

  it("answers geometry-type with the vector-tile kind, so a MultiPolygon is a Polygon", () => {
    const resolver = createFeatureStyleResolver(
      style({
        vectorStyleMode: "expression",
        vectorStyleExpression: JSON.stringify([
          "case",
          ["==", ["geometry-type"], "Polygon"],
          "#ff0000",
          "#0000ff",
        ]),
      }),
    );
    const multi = {
      type: "Feature" as const,
      properties: {},
      geometry: {
        type: "MultiPolygon" as const,
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        ],
      },
    };
    assert.deepEqual(rgb(resolver.resolve(multi, 0).fill), [255, 0, 0]);
    assert.deepEqual(rgb(resolver.resolve(feature({}, "Polygon"), 0).fill), [255, 0, 0]);
    assert.deepEqual(rgb(resolver.resolve(feature({}, "LineString"), 0).fill), [0, 0, 255]);
  });

  it("reads the marker colour channel on its own", () => {
    const resolver = createFeatureStyleResolver(
      style({
        vectorStyleMode: "categorized",
        vectorStyleProperty: "kind",
        vectorStyleStops: [{ value: "park", color: "#00aa00" }],
        markerColor: "#123456",
      }),
    );
    assert.deepEqual(rgb(resolver.resolveMarkerColor(feature({ kind: "park" }), 0)), [0, 170, 0]);
    assert.deepEqual(
      rgb(resolver.resolveMarkerColor(feature({ kind: "x" }), 0)),
      [0x12, 0x34, 0x56],
    );
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
          if (type === "Polygon")
            return {
              ...base,
              polygon: { material: null, hierarchy: { getValue: () => ({ positions: [{}, {}] }) } },
            };
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
    BoundingSphere: {
      fromPoints: () => {
        counters.spheres++;
        return { radius: 500 };
      },
    },
    Cartesian2: class {
      constructor(
        public x: number,
        public y: number,
      ) {}
    },
    ImageMaterialProperty: class {
      constructor(public options: Record<string, unknown>) {}
    },
  };
  const counters = { spheres: 0 };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { viewer, Cesium, dataSources, flush, cameraListeners, counters };
}

/** A marker renderer that records the colours it baked and can refuse some. */
function fakeMarkerRenderer(refuse: string[] = []) {
  const baked: string[] = [];
  const render = async (_style: LayerStyle, colour?: string) => {
    baked.push(colour ?? "");
    if (colour && refuse.some((r) => rgb(colour).join() === rgb(r).join())) return null;
    return { canvas: { sprite: colour ?? "base" } as unknown as HTMLCanvasElement, pixelRatio: 2 };
  };
  return { baked, render };
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

describe("CesiumLayerSync channel routing", () => {
  it("outlines polygons with the line colour and fills circles from marker-color", async () => {
    const f = makeFakes();
    const sync = new CesiumLayerSync(f.Cesium as never, f.viewer as never, () => 12);
    sync.sync([
      geojsonLayer(
        [
          feature({ stroke: "#0088ff" }, "Polygon"),
          feature({ "marker-color": "#ff8800", "marker-opacity": 0.5 }),
        ],
        { opacity: 0.5, style: { simpleStyleEnabled: true, strokeColor: "#ff0000" } },
      ),
    ]);
    await f.flush();
    await f.flush();
    const [polygon, point] = f.dataSources[0].entities.values;
    const outline = (polygon.polygon?.outlineColor as { value: { css: string } }).value;
    assert.deepEqual(rgb(outline.css), [0, 136, 255], "simplestyle stroke reaches the outline");
    const circle = point.point as Record<string, { value: { css: string; alpha: number } }>;
    assert.deepEqual(rgb(circle.color.value.css), [255, 136, 0]);
    assert.ok(Math.abs(circle.color.value.alpha - 0.25) < 1e-9, "marker-opacity × layer opacity");
  });

  it("does not reload the data source for a style field the globe never reads", async () => {
    const f = makeFakes();
    const sync = new CesiumLayerSync(f.Cesium as never, f.viewer as never, () => 12);
    const layer = geojsonLayer([feature({}, "Polygon")], { style: { heatmapRadius: 20 } });
    sync.sync([layer]);
    await f.flush();
    await f.flush();
    assert.equal(f.dataSources.length, 1);
    sync.sync([
      {
        ...layer,
        style: {
          heatmapRadius: 50,
          pointRenderer: "heatmap",
          diagramSize: 30,
          blendMode: "multiply",
        },
      },
    ]);
    await f.flush();
    await f.flush();
    assert.equal(f.dataSources.length, 1, "2D-only fields leave the globe alone");
    sync.sync([{ ...layer, style: { heatmapRadius: 50, strokeWidth: 4 } }]);
    await f.flush();
    await f.flush();
    assert.equal(f.dataSources.length, 2, "a field the globe bakes still rebuilds");
  });
});

describe("CesiumLayerSync marker sprites", () => {
  const sprite = (e: { billboard?: Record<string, unknown> }) =>
    (e.billboard?.image as { value: { sprite: string } } | undefined)?.value.sprite;

  it("bakes one sprite per classified colour in parallel, with the base marker as fallback", async () => {
    const f = makeFakes();
    const renderer = fakeMarkerRenderer(["#0000aa"]);
    const sync = new CesiumLayerSync(f.Cesium as never, f.viewer as never, () => 12, {
      renderMarker: renderer.render,
    });
    sync.sync([
      geojsonLayer([feature({ kind: "park" }), feature({ kind: "water" })], {
        style: {
          markerEnabled: true,
          vectorStyleMode: "categorized",
          vectorStyleProperty: "kind",
          vectorStyleStops: [
            { value: "park", color: "#00aa00" },
            { value: "water", color: "#0000aa" },
          ],
        },
      }),
    ]);
    await f.flush();
    await f.flush();
    // The base marker is always baked, not only past the sprite cap.
    assert.equal(renderer.baked.length, 3);
    assert.ok(renderer.baked.includes(""), "base marker baked");
    const [park, water] = f.dataSources[0].entities.values;
    assert.equal(
      sprite(park),
      renderer.baked.find((c) => c && rgb(c).join() === "0,170,0"),
    );
    assert.equal(sprite(water), "base", "a colour whose sprite failed falls back to the base");
    assert.equal(
      (water.billboard?.scale as { value: number }).value,
      0.5,
      "scale divides by the sprite's pixel ratio",
    );
  });

  it("bakes the colours a zoom-dependent rule activates when the camera crosses its zoom", async () => {
    const f = makeFakes();
    const renderer = fakeMarkerRenderer();
    let zoom = 10;
    const sync = new CesiumLayerSync(f.Cesium as never, f.viewer as never, () => zoom, {
      renderMarker: renderer.render,
    });
    sync.sync([
      geojsonLayer([feature({ kind: "a" })], {
        style: {
          markerEnabled: true,
          vectorStyleMode: "rule-based",
          vectorRules: [
            {
              id: "close",
              label: "Close",
              filter: JSON.stringify(["==", ["get", "kind"], "a"]),
              color: "#ff0000",
              isElse: false,
              minZoom: 12,
            },
            { id: "else", label: "Other", filter: "", color: "#00ff00", isElse: true },
          ],
        },
      }),
    ]);
    await f.flush();
    await f.flush();
    const [point] = f.dataSources[0].entities.values;
    const isRed = (c: string) => Boolean(c) && rgb(c).join() === "255,0,0";
    assert.ok(!renderer.baked.some(isRed), "the rule is inactive at z10, so no red sprite yet");
    assert.ok(sprite(point) && rgb(sprite(point)!).join() === "0,255,0");
    zoom = 12;
    for (const listener of f.cameraListeners) listener();
    await f.flush();
    await f.flush();
    assert.ok(renderer.baked.some(isRed), "the zoom step baked the newly active colour");
    assert.ok(isRed(sprite(point)!), "and the marker switched to it");
    // Another crossing back and forth reuses what is baked.
    const bakedBefore = renderer.baked.length;
    zoom = 10;
    for (const listener of f.cameraListeners) listener();
    await f.flush();
    zoom = 12;
    for (const listener of f.cameraListeners) listener();
    await f.flush();
    assert.equal(renderer.baked.length, bakedBefore, "no sprite is baked twice");
  });

  it("computes a fill pattern's repeat count once per polygon, not per restyle", async () => {
    const f = makeFakes();
    const sync = new CesiumLayerSync(f.Cesium as never, f.viewer as never, () => 12, {
      renderFillPattern: async () => ({
        canvas: { tile: true } as unknown as HTMLCanvasElement,
        pixelRatio: 1,
      }),
    });
    const layer = geojsonLayer([feature({}, "Polygon"), feature({}, "Polygon")], {
      style: { fillPattern: "hatch", fillOpacity: 0.5 },
    });
    sync.sync([layer]);
    await f.flush();
    await f.flush();
    const polygon = f.dataSources[0].entities.values[0].polygon as {
      material: { options: { repeat: { x: number }; color: { alpha: number } } };
    };
    assert.equal(polygon.material.options.repeat.x, 50, "2 × 500 m radius / 20 m per tile");
    assert.equal(f.counters.spheres, 2, "one bounding sphere per polygon");
    sync.sync([{ ...layer, opacity: 0.4 }]);
    await f.flush();
    assert.ok(Math.abs(polygon.material.options.color.alpha - 0.2) < 1e-9, "restyled in place");
    assert.equal(f.counters.spheres, 2, "the restyle reused the cached repeat counts");
  });

  it("bakes a flat marker colour once and aliases the base fallback to it", async () => {
    const f = makeFakes();
    const renderer = fakeMarkerRenderer();
    const sync = new CesiumLayerSync(f.Cesium as never, f.viewer as never, () => 12, {
      renderMarker: renderer.render,
    });
    sync.sync([
      geojsonLayer([feature({}), feature({})], {
        style: { markerEnabled: true, markerColor: "#ff8800" },
      }),
    ]);
    await f.flush();
    await f.flush();
    assert.equal(renderer.baked.length, 1, "one render for the one colour");
    assert.deepEqual(rgb(renderer.baked[0]), [255, 136, 0]);
    const [a, b] = f.dataSources[0].entities.values;
    assert.equal(sprite(a), renderer.baked[0]);
    assert.equal(sprite(b), renderer.baked[0]);
  });

  it("holds at most MAX_MARKER_SPRITES sprites, base included", async () => {
    const f = makeFakes();
    const renderer = fakeMarkerRenderer();
    const sync = new CesiumLayerSync(f.Cesium as never, f.viewer as never, () => 12, {
      renderMarker: renderer.render,
    });
    const count = 80;
    const stops = Array.from({ length: count }, (_, i) => ({
      value: `c${i}`,
      color: `#${(0x100000 + i * 0x0137).toString(16).padStart(6, "0")}`,
    }));
    sync.sync([
      geojsonLayer(
        stops.map((stop) => feature({ kind: stop.value })),
        {
          style: {
            markerEnabled: true,
            vectorStyleMode: "categorized",
            vectorStyleProperty: "kind",
            vectorStyleStops: stops,
          },
        },
      ),
    ]);
    await f.flush();
    await f.flush();
    assert.equal(renderer.baked.length, 64);
    assert.ok(renderer.baked.includes(""), "the base fallback is one of them");
    // A point past the cap draws the base sprite rather than nothing.
    const last = f.dataSources[0].entities.values[count - 1];
    assert.equal(sprite(last), "base");
  });

  it("serialises overlapping zoom bakes so a colour is rasterised once", async () => {
    const f = makeFakes();
    // Colour renders wait on a gate the test opens; the load-time bake runs
    // through an open gate, the zoom-step bakes through a closed one.
    let gate = Promise.resolve();
    let release: () => void = () => {};
    const baked: string[] = [];
    const renderer = async (_style: LayerStyle, colour?: string) => {
      baked.push(colour ?? "");
      if (colour) await gate;
      return {
        canvas: { sprite: colour ?? "base" } as unknown as HTMLCanvasElement,
        pixelRatio: 1,
      };
    };
    let zoom = 10;
    let renders = 0;
    f.viewer.scene.requestRender = () => {
      renders++;
    };
    const sync = new CesiumLayerSync(f.Cesium as never, f.viewer as never, () => zoom, {
      renderMarker: renderer,
    });
    const rule = (id: string, color: string, minZoom: number) => ({
      id,
      label: id,
      filter: JSON.stringify(["==", ["get", "kind"], "a"]),
      color,
      isElse: false,
      minZoom,
      maxZoom: minZoom + 1,
    });
    sync.sync([
      geojsonLayer([feature({ kind: "a" })], {
        style: {
          markerEnabled: true,
          vectorStyleMode: "rule-based",
          vectorRules: [
            rule("z12", "#ff0000", 12),
            rule("z13", "#0000ff", 13),
            { id: "else", label: "Other", filter: "", color: "#00ff00", isElse: true },
          ],
        },
      }),
    ]);
    await f.flush();
    await f.flush();
    gate = new Promise<void>((r) => (release = r));
    const isRed = (c: string) => Boolean(c) && rgb(c).join() === "255,0,0";
    const isBlue = (c: string) => Boolean(c) && rgb(c).join() === "0,0,255";
    // Two zoom steps in quick succession, each firing both camera events,
    // while the first bake is still rendering.
    zoom = 12;
    for (const listener of f.cameraListeners) listener();
    zoom = 13;
    for (const listener of f.cameraListeners) listener();
    await f.flush();
    assert.equal(baked.filter(isRed).length, 1, "red requested once for the z12 step");
    assert.equal(baked.filter(isBlue).length, 0, "the z13 bake waits for the z12 bake");
    release();
    await f.flush();
    await f.flush();
    await f.flush();
    assert.equal(baked.filter(isBlue).length, 1, "then blue is baked exactly once");
    assert.equal(baked.filter(isRed).length, 1);
    const [point] = f.dataSources[0].entities.values;
    assert.ok(isBlue(sprite(point)!), "the marker ends on the z13 colour");
    assert.ok(renders >= 1);
  });
});
