import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  geodesicDistance,
  setActiveEllipsoidId,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  type ProcessingAlgorithm,
  type ResultLayerOptions,
  STATISTICS_TOOLS,
  averageNearestNeighborTool,
  compositeScoreTool,
  computeCompositeScores,
  normalizeFieldValues,
  emergingHotSpotTool,
  emergingPattern,
  getStatisticsTool,
  getisOrdTool,
  globalMoransITool,
  kernelDensityTool,
  localMoransITool,
} from "@geolibre/processing";
import {
  buildNeighbors,
  meanNearestNeighborDistance,
} from "../packages/processing/src/statistics-tools";
import type { Feature, FeatureCollection, Point } from "geojson";

/** Build a point layer from [lon, lat, properties] tuples. */
function pointLayer(
  points: Array<[number, number, Record<string, unknown>]>,
  id = "layer-a",
): GeoLibreLayer {
  const features: Feature<Point>[] = points.map(([lon, lat, properties]) => ({
    type: "Feature",
    properties,
    geometry: { type: "Point", coordinates: [lon, lat] },
  }));
  return {
    id,
    name: "Layer A",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: { type: "FeatureCollection", features },
  };
}

interface RunOutcome {
  messages: string[];
  results: Array<{ name: string; geojson: FeatureCollection; options?: ResultLayerOptions }>;
}

/** Run a statistics tool against a single layer, capturing logs and outputs. */
function run(
  tool: ProcessingAlgorithm,
  layer: GeoLibreLayer,
  parameters: Record<string, unknown>,
): RunOutcome {
  const messages: string[] = [];
  const results: RunOutcome["results"] = [];
  tool.run({
    layers: [layer],
    // Every value-field tool here reads property "v"; ANN/KDE ignore "field".
    parameters: { layer: layer.id, field: "v", ...parameters },
    log: (message) => messages.push(message),
    addResultLayer: (name, geojson, options) => results.push({ name, geojson, options }),
  });
  return { messages, results };
}

/** Parse the numeric value off a logged "Label: 1.2345" line. */
function loggedNumber(messages: string[], needle: string): number {
  const line = messages.find((m) => m.includes(needle));
  assert.ok(line, `expected a log line containing "${needle}"`);
  const value = Number.parseFloat(line.slice(line.indexOf(needle) + needle.length));
  assert.ok(Number.isFinite(value), `could not parse a number from "${line}"`);
  return value;
}

/** A line of points with monotonically increasing values (strong + autocorrelation). */
function gradientLine(values: number[]): GeoLibreLayer {
  return pointLayer(
    values.map((v, i) => [i * 0.001, 0, { v }] as [number, number, Record<string, unknown>]),
  );
}

describe("statistics tools registry", () => {
  it("exposes all spatial-statistics tools", () => {
    // The sorted-id comparison below fully pins membership; no separate
    // (fragile) length assertion is needed.
    assert.deepEqual(STATISTICS_TOOLS.map((t) => t.id).sort(), [
      "average-nearest-neighbor",
      "composite-score",
      "emerging-hot-spot",
      "getis-ord-gi",
      "global-morans-i",
      "kernel-density",
      "local-morans-i",
    ]);
  });

  it("looks tools up by id", () => {
    assert.equal(getStatisticsTool("global-morans-i"), globalMoransITool);
    assert.equal(getStatisticsTool("getis-ord-gi"), getisOrdTool);
    assert.equal(getStatisticsTool("nope"), undefined);
  });
});

describe("global Moran's I", () => {
  it("reports strong positive autocorrelation for a smooth gradient", () => {
    const layer = gradientLine([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const { messages } = run(globalMoransITool, layer, { k: 2, permutations: 99 });
    const observed = loggedNumber(messages, "Moran's I:");
    // Neighbors share near-identical values, so I should be close to 1. The
    // observed statistic is deterministic; the pattern label depends on the
    // permutation p-value, so it is intentionally not asserted here.
    assert.ok(observed > 0.5, `expected I > 0.5, got ${observed}`);
  });

  it("reports negative autocorrelation for an alternating field", () => {
    const layer = gradientLine([0, 10, 0, 10, 0, 10, 0, 10, 0, 10]);
    const { messages } = run(globalMoransITool, layer, { k: 2, permutations: 99 });
    const observed = loggedNumber(messages, "Moran's I:");
    assert.ok(observed < 0, `expected I < 0, got ${observed}`);
  });

  it("errors on a constant field and on too few features", () => {
    const constant = run(globalMoransITool, gradientLine([5, 5, 5, 5]), {
      k: 2,
    });
    assert.ok(constant.messages.some((m) => m.includes("constant")));

    const tooFew = run(globalMoransITool, gradientLine([1, 2]), { k: 1 });
    assert.ok(tooFew.messages.some((m) => m.includes("at least 3")));
  });
});

describe("Getis-Ord Gi*", () => {
  it("flags the high cluster as hot and the low cluster as cold", () => {
    // Two well-separated clusters: high values left, low values right.
    const layer = pointLayer([
      [0, 0, { v: 100 }],
      [0.001, 0, { v: 98 }],
      [0, 0.001, { v: 102 }],
      [1, 0, { v: 1 }],
      [1.001, 0, { v: 2 }],
      [1, 0.001, { v: 1 }],
    ]);
    const { results } = run(getisOrdTool, layer, { k: 2 });
    assert.equal(results.length, 1);
    const z = results[0].geojson.features.map((f) => f.properties?.["v_gi_z"] as number);
    // Indices 0-2 are the high cluster, 3-5 the low cluster.
    assert.ok(
      z.slice(0, 3).every((value) => value > 0),
      `expected positive Gi* z in the high cluster, got ${z.slice(0, 3)}`,
    );
    assert.ok(
      z.slice(3).every((value) => value < 0),
      `expected negative Gi* z in the low cluster, got ${z.slice(3)}`,
    );
  });

  it("errors when the value field is constant", () => {
    const layer = pointLayer([
      [0, 0, { v: 5 }],
      [0.001, 0, { v: 5 }],
      [0, 0.001, { v: 5 }],
    ]);
    const { messages } = run(getisOrdTool, layer, { k: 2 });
    assert.ok(messages.some((m) => m.includes("constant")));
  });
});

describe("local Moran's I (LISA)", () => {
  it("classifies a high-value cluster as High-High (quadrant 1)", () => {
    const layer = pointLayer([
      [0, 0, { v: 100 }],
      [0.001, 0, { v: 98 }],
      [0, 0.001, { v: 102 }],
      [1, 0, { v: 1 }],
      [1.001, 0, { v: 2 }],
      [1, 0.001, { v: 1 }],
    ]);
    const { results } = run(localMoransITool, layer, { k: 2, permutations: 99 });
    assert.equal(results.length, 1);
    const features = results[0].geojson.features;
    // Select the high-value members by attribute rather than position, so the
    // assertion holds even if the tool ever reorders output features.
    const highFeatures = features.filter((f) => (f.properties?.["v"] as number) > 50);
    assert.equal(highFeatures.length, 3);
    // High-cluster members have a positive local I and sit in quadrant 1.
    for (const f of highFeatures) {
      assert.equal(f.properties?.["v_lisa_q"], 1);
      assert.ok((f.properties?.["v_lisa_I"] as number) > 0);
    }
  });

  it("finds a polygon's neighbors from its area centroid, not its vertex mean", () => {
    // A 10° square whose east edge is drawn with 201 vertices: the mean of its
    // vertices sits near that edge (9.9, 5), its centroid at (5, 5). Its nearest
    // neighbor is R (west, centre -1.5) from the centroid, but Q (east, centre
    // 13) from the vertex mean.
    const square = (x0: number, y0: number, x1: number, y1: number) => [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
      [x0, y0],
    ];
    const east = Array.from({ length: 199 }, (_, i) => [10, 0.05 * (i + 1)]);
    const p = [[0, 0], [10, 0], ...east, [10, 10], [0, 10], [0, 0]];
    const polygons: Array<[number[][], number]> = [
      [p, 10],
      [square(-2, 4.5, -1, 5.5), 10], // R
      [square(12.5, 4.5, 13.5, 5.5), 0], // Q
      [square(4.5, 39.5, 5.5, 40.5), 0],
    ];
    const layer = pointLayer([]);
    layer.geojson = {
      type: "FeatureCollection",
      features: polygons.map(([ring, v], i) => ({
        type: "Feature",
        properties: { v, i },
        geometry: { type: "Polygon", coordinates: [ring] },
      })),
    };
    const { results } = run(localMoransITool, layer, { k: 1, permutations: 99 });
    const square10 = results[0].geojson.features.find((f) => f.properties?.["i"] === 0);
    // High value with a high neighbor (R): High-High. From the vertex mean its
    // neighbor would be Q (low): High-Low.
    assert.equal(square10?.properties?.["v_lisa_q"], 1);
  });

  it("subtracts a hole from a polygon's area centroid", () => {
    // A 10° square with a 3°x2° hole on its west side: its area centroid
    // (5.16, 5) lies east of the hole, so its nearest neighbor is D (east, centre
    // 11.5). Adding the hole instead would put the centroid at (4.86, 5), making
    // B (west, centre -1.5) the nearest neighbor.
    const ring = (x0: number, y0: number, x1: number, y1: number) => [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
      [x0, y0],
    ];
    const layer = pointLayer([]);
    layer.geojson = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { v: 10, i: 0 },
          geometry: { type: "Polygon", coordinates: [ring(0, 0, 10, 10), ring(1, 4, 4, 6)] },
        },
        {
          type: "Feature",
          properties: { v: 10, i: 1 },
          geometry: { type: "Polygon", coordinates: [ring(-2, 4.5, -1, 5.5)] },
        },
        {
          type: "Feature",
          properties: { v: 0, i: 2 },
          geometry: { type: "Polygon", coordinates: [ring(11, 4.5, 12, 5.5)] },
        },
      ],
    };
    const { results } = run(localMoransITool, layer, { k: 1, permutations: 99 });
    const holed = results[0].geojson.features.find((f) => f.properties?.["i"] === 0);
    // High value with a low neighbor (D): High-Low.
    assert.equal(holed?.properties?.["v_lisa_q"], 4);
  });

  it("subtracts a clockwise hole from a polygon's area centroid", () => {
    // Same shape as the test above, but the hole is written clockwise, so its
    // shoelace sum has the opposite sign. It must still be subtracted.
    const ring = (x0: number, y0: number, x1: number, y1: number) => [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
      [x0, y0],
    ];
    const clockwiseHole = ring(1, 4, 4, 6).reverse();
    const layer = pointLayer([]);
    layer.geojson = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { v: 10, i: 0 },
          geometry: { type: "Polygon", coordinates: [ring(0, 0, 10, 10), clockwiseHole] },
        },
        {
          type: "Feature",
          properties: { v: 10, i: 1 },
          geometry: { type: "Polygon", coordinates: [ring(-2, 4.5, -1, 5.5)] },
        },
        {
          type: "Feature",
          properties: { v: 0, i: 2 },
          geometry: { type: "Polygon", coordinates: [ring(11, 4.5, 12, 5.5)] },
        },
      ],
    };
    const { results } = run(localMoransITool, layer, { k: 1, permutations: 99 });
    const holed = results[0].geojson.features.find((f) => f.properties?.["i"] === 0);
    // High value with a low neighbor (D), as in the counter-clockwise case.
    assert.equal(holed?.properties?.["v_lisa_q"], 4);
  });

  it("locates a MultiPolygon with an empty first part by its other parts", () => {
    // The empty first part must not drop the feature: its centroid comes from the
    // non-empty part centred at (10, 5), so its nearest neighbor is E (low, 7.5).
    const ring = (x0: number, y0: number, x1: number, y1: number) => [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
      [x0, y0],
    ];
    const layer = pointLayer([]);
    layer.geojson = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { v: 10, i: 0 },
          geometry: { type: "MultiPolygon", coordinates: [[], [ring(9, 4, 11, 6)]] },
        },
        {
          type: "Feature",
          properties: { v: 0, i: 1 },
          geometry: { type: "Polygon", coordinates: [ring(7, 4.5, 8, 5.5)] },
        },
        {
          type: "Feature",
          properties: { v: 10, i: 2 },
          geometry: { type: "Polygon", coordinates: [ring(3.5, 4.5, 4.5, 5.5)] },
        },
      ],
    };
    const { results } = run(localMoransITool, layer, { k: 1, permutations: 99 });
    const multi = results[0].geojson.features.find((f) => f.properties?.["i"] === 0);
    // High value with a low neighbor (E): High-Low, so the feature was located.
    assert.equal(multi?.properties?.["v_lisa_q"], 4);
  });

  it("weights a MultiPolygon's parts by area when finding its centroid", () => {
    // Parts of area 1 (centre x=0) and 4 (centre x=10) give an area-weighted
    // centroid at x=8, so its nearest neighbor is E (low, centre 7.5). The
    // unweighted mean of the part centres, x=5, would pick F (high, centre 4).
    const ring = (x0: number, y0: number, x1: number, y1: number) => [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
      [x0, y0],
    ];
    const layer = pointLayer([]);
    layer.geojson = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { v: 10, i: 0 },
          geometry: {
            type: "MultiPolygon",
            coordinates: [[ring(-0.5, 4.5, 0.5, 5.5)], [ring(9, 4, 11, 6)]],
          },
        },
        {
          type: "Feature",
          properties: { v: 0, i: 1 },
          geometry: { type: "Polygon", coordinates: [ring(7, 4.5, 8, 5.5)] },
        },
        {
          type: "Feature",
          properties: { v: 10, i: 2 },
          geometry: { type: "Polygon", coordinates: [ring(3.5, 4.5, 4.5, 5.5)] },
        },
      ],
    };
    const { results } = run(localMoransITool, layer, { k: 1, permutations: 99 });
    const multi = results[0].geojson.features.find((f) => f.properties?.["i"] === 0);
    // High value with a low neighbor (E): High-Low.
    assert.equal(multi?.properties?.["v_lisa_q"], 4);
  });
});

describe("average nearest neighbor", () => {
  it("returns a sub-1 ratio for clustered points and a larger ratio for a grid", () => {
    // Four tight knots at the corners of a ~1-degree extent: every point's
    // nearest neighbor sits inside its own knot, far below the expected random
    // spacing for the overall density -> a strongly clustered (<1) ratio.
    const clustered = pointLayer(
      (
        [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as Array<[number, number]>
      ).flatMap(
        ([lon, lat]) =>
          [
            [lon, lat, {}],
            [lon + 0.0005, lat, {}],
            [lon, lat + 0.0005, {}],
          ] as Array<[number, number, Record<string, unknown>]>,
      ),
    );
    const clusteredRatio = loggedNumber(
      run(averageNearestNeighborTool, clustered, {}).messages,
      "NN ratio:",
    );
    assert.ok(clusteredRatio < 1, `expected clustered ratio < 1, got ${clusteredRatio}`);

    // A 4x4 evenly spaced grid is close to a random/dispersed arrangement.
    const grid: Array<[number, number, Record<string, unknown>]> = [];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) grid.push([c * 0.01, r * 0.01, {}]);
    }
    const gridRatio = loggedNumber(
      run(averageNearestNeighborTool, pointLayer(grid), {}).messages,
      "NN ratio:",
    );
    assert.ok(
      gridRatio > clusteredRatio,
      `expected grid ratio (${gridRatio}) > clustered ratio (${clusteredRatio})`,
    );
  });

  it("errors with fewer than two points", () => {
    const { messages } = run(averageNearestNeighborTool, pointLayer([[0, 0, {}]]), {});
    assert.ok(messages.some((m) => m.includes("at least 2")));
  });

  it("ignores an elevation-carrying bbox when measuring the study area", () => {
    // A collection's own `bbox` member is taken verbatim, and RFC 7946 §5 lets
    // it hold six values. Read as four, the study area would be measured over
    // [west, south, minAltitude, east], so the same points would report a
    // different ratio depending on whether the file declared its elevation.
    const points: Array<[number, number, Record<string, unknown>]> = [];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) points.push([c * 0.01, r * 0.01, {}]);
    }
    const flat = pointLayer(points);
    const withElevation: GeoLibreLayer = {
      ...flat,
      geojson: {
        ...(flat.geojson as FeatureCollection),
        bbox: [0, 0, 120, 0.03, 0.03, 940],
      },
    };

    assert.equal(
      loggedNumber(run(averageNearestNeighborTool, withElevation, {}).messages, "NN ratio:"),
      loggedNumber(run(averageNearestNeighborTool, flat, {}).messages, "NN ratio:"),
    );
  });

  it("measures distances and the study area on the WGS 84 ellipsoid", () => {
    // The corners of a 1° box at 45–46° N. Expected values computed with
    // pyproj 3.8.0: Geod(ellps="WGS84").inv(...) (GeographicLib) for the
    // nearest-neighbour distances (the east-west sides), and for the box between
    // the parallels, 8,686,494,956.670 m², its area in the WGS 84 cylindrical
    // equal-area projection EPSG:6933, where it is a rectangle.
    const corners = pointLayer([
      [9, 45, {}],
      [10, 45, {}],
      [9, 46, {}],
      [10, 46, {}],
    ]);
    const { messages } = run(averageNearestNeighborTool, corners, {});
    assert.equal(loggedNumber(messages, "Observed mean distance:"), 78154.56);
    assert.equal(loggedNumber(messages, "Expected mean distance:"), 23300.34);
    assert.equal(loggedNumber(messages, "NN ratio:"), 3.3542);
  });

  it("measures a study area wider than 180° of longitude the long way round", () => {
    // Same references as above. A ring of geodesics through the four corners
    // would take the short way round: zero area for the whole globe, and a strip
    // about 2° wide for -179° to 179°.
    const globe = run(
      averageNearestNeighborTool,
      pointLayer([
        [-180, -60, {}],
        [180, 60, {}],
        [0, 0, {}],
        [90, 30, {}],
        [-90, -30, {}],
      ]),
      {},
    ).messages;
    // Study area 441,233,920,694,280.7 m² (-180..180, -60..60).
    assert.equal(loggedNumber(globe, "Observed mean distance:"), 7737790.92);
    assert.equal(loggedNumber(globe, "Expected mean distance:"), 4696987.97);
    assert.equal(loggedNumber(globe, "NN ratio:"), 1.6474);

    const wide = run(
      averageNearestNeighborTool,
      pointLayer([
        [-179, 10, {}],
        [179, 20, {}],
        [0, 15, {}],
      ]),
      {},
    ).messages;
    // Study area 42,550,157,488,306.9 m² (-179..179, 10..20).
    assert.equal(loggedNumber(wide, "Observed mean distance:"), 6128459.07);
    assert.equal(loggedNumber(wide, "Expected mean distance:"), 1883041.81);
    assert.equal(loggedNumber(wide, "NN ratio:"), 3.2546);
  });

  it("skips a point whose latitude is beyond the pole", () => {
    // GeographicLib has no distance to latitude 95°, so the point is left out
    // like any other unlocatable geometry.
    const corners: Array<[number, number, Record<string, unknown>]> = [
      [9, 45, {}],
      [10, 45, {}],
      [9, 46, {}],
      [10, 46, {}],
    ];
    const { messages } = run(
      averageNearestNeighborTool,
      pointLayer([...corners, [9.5, 95, {}]]),
      {},
    );
    assert.ok(messages.includes("Average nearest neighbor (n=4):"));
    assert.equal(loggedNumber(messages, "Observed mean distance:"), 78154.56);
    // The skipped point does not stretch the study area either.
    const without = run(averageNearestNeighborTool, pointLayer(corners), {});
    assert.equal(
      loggedNumber(messages, "Expected mean distance:"),
      loggedNumber(without.messages, "Expected mean distance:"),
    );
  });
});

describe("average nearest neighbor extent", () => {
  it("keeps a MultiPoint's full extent and leaves out one with a vertex beyond the pole", () => {
    const base = pointLayer([
      [9, 45, {}],
      [10, 45, {}],
      [9, 46, {}],
    ]);
    const withMulti = (coordinates: number[][]): GeoLibreLayer => ({
      ...base,
      geojson: {
        type: "FeatureCollection",
        features: [
          ...base.geojson!.features,
          { type: "Feature", properties: {}, geometry: { type: "MultiPoint", coordinates } },
        ],
      },
    });
    // A MultiPoint stretching north widens the box beyond its centroid.
    const near = run(
      averageNearestNeighborTool,
      withMulti([
        [10, 46],
        [10, 46.01],
      ]),
      {},
    );
    const far = run(
      averageNearestNeighborTool,
      withMulti([
        [10, 45.6],
        [10, 47],
      ]),
      {},
    );
    assert.ok(
      loggedNumber(far.messages, "Expected mean distance:") >
        loggedNumber(near.messages, "Expected mean distance:"),
    );
    // A MultiPoint with a vertex at 95° cannot be located, so the run is the
    // one without it.
    const withPole = run(
      averageNearestNeighborTool,
      withMulti([
        [10, 46],
        [10, 95],
      ]),
      {},
    );
    const without = run(averageNearestNeighborTool, base, {});
    assert.ok(withPole.messages.includes("Average nearest neighbor (n=3):"));
    // A malformed GeometryCollection is left out instead of failing the tool.
    const malformed: GeoLibreLayer = {
      ...base,
      geojson: {
        type: "FeatureCollection",
        features: [
          ...base.geojson!.features,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { type: "Feature", properties: {}, geometry: { type: "GeometryCollection" } as any },
        ],
      },
    };
    const run3 = run(averageNearestNeighborTool, malformed, {});
    assert.ok(run3.messages.includes("Average nearest neighbor (n=3):"));
    assert.equal(
      loggedNumber(withPole.messages, "Expected mean distance:"),
      loggedNumber(without.messages, "Expected mean distance:"),
    );
  });
});

describe("distance-band weights", () => {
  it("leaves out a point whose latitude is beyond the pole", () => {
    const valid: Array<[number, number, Record<string, unknown>]> = [
      [7.6869, 45.0703, { v: 1 }],
      [13.77, 45.65, { v: 2 }],
      [13.3615, 38.1157, { v: 3 }],
      [12.4964, 41.9028, { v: 5 }],
    ];
    const params = { weightsType: "knn", k: 2, permutations: 99 };
    const withInvalid = run(globalMoransITool, pointLayer([...valid, [10, 120, { v: 9 }]]), params);
    const without = run(globalMoransITool, pointLayer(valid), params);
    assert.ok(withInvalid.messages.some((m) => m.includes("(n=4)")));
    assert.equal(
      loggedNumber(withInvalid.messages, "Moran's I:"),
      loggedNumber(without.messages, "Moran's I:"),
    );
  });

  it("compares the band with the WGS 84 distance", () => {
    // Torino–Trieste is 480.833 km on WGS 84 (GeographicLib via pyproj 3.8.0)
    // and 479.510 km on the sphere of mean radius; Palermo is over 800 km from
    // both. So a 480 km band leaves every point without a neighbour.
    const layer = pointLayer([
      [7.6869, 45.0703, { v: 1 }],
      [13.77, 45.65, { v: 2 }],
      [13.3615, 38.1157, { v: 3 }],
    ]);
    const params = (threshold: number) => ({
      weightsType: "distance",
      threshold,
      permutations: 99,
    });
    const narrow = run(globalMoransITool, layer, params(480)).messages;
    assert.ok(narrow.some((m) => m.includes("no feature has any neighbor")));
    const wide = run(globalMoransITool, layer, params(481)).messages;
    assert.ok(wide.some((m) => m.includes("Moran's I:")));
  });
});

describe("kernel density", () => {
  it("produces a normalized density grid peaking at 1", () => {
    const layer = pointLayer([
      [0, 0, {}],
      [0.001, 0, {}],
      [0, 0.001, {}],
      [0.001, 0.001, {}],
    ]);
    const { results } = run(kernelDensityTool, layer, {
      bandwidth: 1,
      cellSize: 0.25,
    });
    assert.equal(results.length, 1);
    const cells = results[0].geojson.features;
    assert.ok(cells.length > 0);
    const norms = cells.map((f) => f.properties?.["density_norm"] as number);
    assert.ok(norms.every((value) => value > 0 && value <= 1));
    const maxNorm = Math.max(...norms);
    assert.ok(
      Math.abs(maxNorm - 1) < 1e-9,
      `the densest cell should normalize to 1 (got ${maxNorm})`,
    );
  });

  it("errors on a non-positive bandwidth", () => {
    const layer = pointLayer([
      [0, 0, {}],
      [0.001, 0, {}],
    ]);
    const { messages } = run(kernelDensityTool, layer, {
      bandwidth: 0,
      cellSize: 0.25,
    });
    assert.ok(messages.some((m) => m.includes("must be positive")));
  });
});

describe("emerging hot spot (space-time cube)", () => {
  const DAY_MS = 86_400_000;
  const BASE = 1_600_000_000_000; // fixed epoch (ms) so the cube is deterministic

  /**
   * A 5×5 fishnet of background cells (one point per cell per day, 5 days),
   * plus a corner cell at the origin that fills up on days 3 and 4 — a location
   * that becomes a hot spot only in the final time steps.
   */
  function spaceTimeLayer(): GeoLibreLayer {
    const pts: Array<[number, number, Record<string, unknown>]> = [];
    for (let day = 0; day < 5; day++) {
      const t = BASE + day * DAY_MS;
      for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 5; col++) {
          pts.push([col * 0.05, row * 0.05, { t }]);
        }
      }
    }
    // Pile events into the origin cell late in the series.
    for (let i = 0; i < 8; i++) pts.push([0.001, 0.001, { t: BASE + 3 * DAY_MS }]);
    for (let i = 0; i < 20; i++) pts.push([0.001, 0.001, { t: BASE + 4 * DAY_MS }]);
    return pointLayer(pts);
  }

  const cubeParams = {
    timeField: "t",
    cellSize: 5,
    timeStep: 1,
    timeStepUnit: "days",
    confidence: "95",
  };

  it("builds the cube and flags a late-emerging hot spot", () => {
    const { results } = run(emergingHotSpotTool, spaceTimeLayer(), cubeParams);
    assert.equal(results.length, 1);
    const fc = results[0].geojson;
    // One polygon per non-empty cell (the 5×5 background; the origin overlaps a
    // background cell, so it is not a 26th cell).
    assert.equal(fc.features.length, 25);
    const props = fc.features[0].properties ?? {};
    for (const key of ["pattern", "pattern_bin", "mk_z", "mk_p", "mk_tau", "total", "time_steps"]) {
      assert.ok(key in props, `expected property "${key}"`);
    }
    assert.equal(props.time_steps, 5);

    // Exactly one cell — the origin — turns hot, and it holds the most events.
    const hot = fc.features.filter((f) => (f.properties?.pattern_bin as number) > 0);
    assert.equal(hot.length, 1);
    assert.match(String(hot[0].properties?.pattern), /Hot Spot/);
    const totals = fc.features.map((f) => f.properties?.total as number);
    assert.equal(hot[0].properties?.total, Math.max(...totals));
  });

  it("sums a weight field per bin instead of counting", () => {
    const layer = spaceTimeLayer();
    // Tag every feature with weight 2; the hot cell's total should double.
    for (const f of layer.geojson!.features) (f.properties as Record<string, unknown>).w = 2;
    const { results } = run(emergingHotSpotTool, layer, { ...cubeParams, weightField: "w" });
    const fc = results[0].geojson;
    const totals = fc.features.map((f) => f.properties?.total as number);
    // 33 events in the origin cell × weight 2 = 66.
    assert.equal(Math.max(...totals), 66);
  });

  it("errors when the data spans fewer than two time steps", () => {
    const pts: Array<[number, number, Record<string, unknown>]> = [];
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 3; col++) pts.push([col * 0.05, row * 0.05, { t: BASE }]);
    const { messages, results } = run(emergingHotSpotTool, pointLayer(pts), cubeParams);
    assert.equal(results.length, 0);
    assert.ok(messages.some((m) => m.includes("fewer than 2 time steps")));
  });

  it("errors when every point shares one location", () => {
    const pts: Array<[number, number, Record<string, unknown>]> = [
      [0, 0, { t: BASE }],
      [0, 0, { t: BASE + DAY_MS }],
      [0, 0, { t: BASE + 2 * DAY_MS }],
    ];
    const { messages, results } = run(emergingHotSpotTool, pointLayer(pts), cubeParams);
    assert.equal(results.length, 0);
    assert.ok(messages.some((m) => m.includes("share one location")));
  });

  it("analyzes a collinear transect (1-D extent) instead of rejecting it", () => {
    // All points share a longitude but span latitude → a valid N×1 fishnet.
    const pts: Array<[number, number, Record<string, unknown>]> = [];
    for (let day = 0; day < 4; day++)
      for (let row = 0; row < 5; row++) pts.push([0, row * 0.05, { t: BASE + day * DAY_MS }]);
    const { results } = run(emergingHotSpotTool, pointLayer(pts), cubeParams);
    assert.equal(results.length, 1);
    assert.ok(results[0].geojson.features.length > 0);
  });

  it("keeps cells with net-negative summed weight (cold spots)", () => {
    // A signed weight field can sum to a negative total in a busy cell; the
    // cell recorded events and must not be dropped from the output.
    const layer = spaceTimeLayer();
    for (const f of layer.geojson!.features) (f.properties as Record<string, unknown>).w = -1;
    const { results } = run(emergingHotSpotTool, layer, { ...cubeParams, weightField: "w" });
    const fc = results[0].geojson;
    assert.equal(fc.features.length, 25);
    assert.ok(fc.features.every((f) => (f.properties?.total as number) < 0));
  });

  it("counts features dropped for a missing/invalid weight in the skip tally", () => {
    const layer = spaceTimeLayer();
    // Give only some features a numeric weight; the rest are dropped as skipped.
    layer.geojson!.features.forEach((f, i) => {
      (f.properties as Record<string, unknown>).w = i % 2 === 0 ? 1 : "n/a";
    });
    const { messages } = run(emergingHotSpotTool, layer, { ...cubeParams, weightField: "w" });
    assert.ok(messages.some((m) => /Skipped \d+ feature\(s\).*valid weight/.test(m)));
  });

  it("errors without a time field and on too few points", () => {
    const noTime = run(emergingHotSpotTool, spaceTimeLayer(), { ...cubeParams, timeField: "" });
    assert.ok(noTime.messages.some((m) => m.includes("time field is required")));

    const few = run(
      emergingHotSpotTool,
      pointLayer([
        [0, 0, { t: BASE }],
        [0.05, 0.05, { t: BASE + DAY_MS }],
      ]),
      cubeParams,
    );
    assert.ok(few.messages.some((m) => m.includes("at least 3 points")));
  });
});

describe("emerging pattern classification", () => {
  const CRIT = 1.96; // 95% two-sided threshold
  const NO_TREND = { s: 0, tau: 0, z: 0, p: 1 };

  it("prioritizes the >=90% persistent family over oscillating", () => {
    // 12 steps, hot in 11 (>=90%) with one earlier significant-cold bin and no
    // trend. ArcGIS classifies this as Persistent, not Oscillating.
    const z = new Array(12).fill(3);
    z[3] = -3;
    assert.equal(emergingPattern(z, CRIT, NO_TREND, 0.05).pattern, "Persistent Hot Spot");
  });

  it("classifies <90% hot with a prior cold bin as oscillating", () => {
    // Final step hot, only 2/12 hot (<90%), and a significant-cold bin earlier.
    const z = new Array(12).fill(0);
    z[3] = -3;
    z[10] = 3;
    z[11] = 3;
    assert.equal(emergingPattern(z, CRIT, NO_TREND, 0.05).pattern, "Oscillating Hot Spot");
  });

  it("mirrors the priority for the cold family", () => {
    const z = new Array(12).fill(-3);
    z[3] = 3;
    assert.equal(emergingPattern(z, CRIT, NO_TREND, 0.05).pattern, "Persistent Cold Spot");
  });
});

describe("composite score normalization", () => {
  it("min-max puts the extremes on 0 and 1", () => {
    assert.deepEqual(normalizeFieldValues([0, 5, 10], "min-max"), [0, 0.5, 1]);
  });

  it("flips the scale when lower is better", () => {
    assert.deepEqual(normalizeFieldValues([0, 5, 10], "min-max", "lower"), [1, 0.5, 0]);
  });

  it("gives a field with no spread the neutral 0.5", () => {
    assert.deepEqual(normalizeFieldValues([7, 7, 7], "min-max"), [0.5, 0.5, 0.5]);
    assert.deepEqual(normalizeFieldValues([7, 7, 7], "z-score"), [0.5, 0.5, 0.5]);
  });

  it("keeps missing values missing", () => {
    assert.deepEqual(normalizeFieldValues([0, null, 10], "min-max"), [0, null, 1]);
    assert.deepEqual(normalizeFieldValues([0, null, 10], "rank"), [0, null, 1]);
  });

  it("averages ranks across ties, so equal inputs score equally", () => {
    // Values 1, 2, 2, 4 → ranks 1, 2.5, 2.5, 4 → (r - 1) / (n - 1).
    assert.deepEqual(normalizeFieldValues([1, 2, 2, 4], "rank"), [0, 0.5, 0.5, 1]);
  });

  it("quantile uses the same mid-ranks but never reaches 0 or 1", () => {
    // (r - 0.5) / n for ranks 1, 2.5, 2.5, 4 over four values.
    assert.deepEqual(normalizeFieldValues([1, 2, 2, 4], "quantile"), [0.125, 0.5, 0.5, 0.875]);
  });

  it("z-score maps the mean onto 0.5 and stays monotonic", () => {
    const scores = normalizeFieldValues([1, 2, 3], "z-score") as number[];
    assert.ok(Math.abs(scores[1] - 0.5) < 1e-6);
    assert.ok(scores[0] < scores[1] && scores[1] < scores[2]);
    assert.ok(scores.every((value) => value > 0 && value < 1));
  });
});

describe("composite score aggregation", () => {
  const columns = new Map<string, (number | null)[]>([
    ["a", [0, 5, 10]],
    ["b", [10, 5, 0]],
  ]);
  const evenFields = [
    { field: "a", normalization: "min-max" as const, weight: 1, direction: "higher" as const },
    { field: "b", normalization: "min-max" as const, weight: 1, direction: "higher" as const },
  ];

  it("renormalizes the configured weights to sum to 1", () => {
    const { weights } = computeCompositeScores(columns, {
      fields: [
        { ...evenFields[0], weight: 3 },
        { ...evenFields[1], weight: 1 },
      ],
      aggregation: "weighted-mean",
      nullHandling: "drop",
      scale: 100,
    });
    assert.equal(weights.get("a"), 0.75);
    assert.equal(weights.get("b"), 0.25);
  });

  it("combines opposing fields into a flat weighted mean", () => {
    const { scores } = computeCompositeScores(columns, {
      fields: evenFields,
      aggregation: "weighted-mean",
      nullHandling: "drop",
      scale: 100,
    });
    assert.deepEqual(scores, [50, 50, 50]);
  });

  it("weights shift the score toward the heavier field", () => {
    const { scores } = computeCompositeScores(columns, {
      fields: [
        { ...evenFields[0], weight: 3 },
        { ...evenFields[1], weight: 1 },
      ],
      aggregation: "weighted-mean",
      nullHandling: "drop",
      scale: 100,
    });
    assert.deepEqual(scores, [25, 50, 75]);
  });

  it("scores a zero component near zero under the geometric mean", () => {
    const { scores } = computeCompositeScores(columns, {
      fields: evenFields,
      aggregation: "geometric-mean",
      nullHandling: "drop",
      scale: 100,
    });
    // The lowest feature in a field has a zero component, floored to 0.01: the
    // geometric mean stays above zero (sqrt(0.01 x 1) = 0.1) without the other
    // field, at a full 1, being able to rescue it.
    assert.equal(scores[0], 10);
    assert.equal(scores[1], 50);
  });

  it("drops a feature missing a field, or renormalizes over what it has", () => {
    const sparse = new Map<string, (number | null)[]>([
      ["a", [0, 8, 10]],
      ["b", [10, null, 0]],
    ]);
    const dropped = computeCompositeScores(sparse, {
      fields: evenFields,
      aggregation: "weighted-mean",
      nullHandling: "drop",
      scale: 100,
    });
    assert.deepEqual(dropped.scores, [50, null, 50]);
    assert.equal(dropped.unscored, 1);

    const renormalized = computeCompositeScores(sparse, {
      fields: evenFields,
      aggregation: "weighted-mean",
      nullHandling: "renormalize",
      scale: 100,
    });
    // With "b" absent the feature is scored on "a" alone: 8 of 0..10 → 80.
    assert.deepEqual(renormalized.scores, [50, 80, 50]);
    assert.equal(renormalized.unscored, 0);
  });

  it("keeps a zero-weight field out of the score instead of scoring it", () => {
    const { scores, weights } = computeCompositeScores(columns, {
      fields: [evenFields[0], { ...evenFields[1], weight: 0 }],
      aggregation: "weighted-mean",
      nullHandling: "drop",
      scale: 100,
    });
    assert.equal(weights.get("b"), 0);
    // "a" carries the whole index: 0, 5, 10 of 0..10.
    assert.deepEqual(scores, [0, 50, 100]);
  });

  it("does not drop a feature over a null in a zero-weight field", () => {
    const sparse = new Map<string, (number | null)[]>([
      ["a", [0, 5, 10]],
      ["b", [10, null, 0]],
    ]);
    const { scores, unscored } = computeCompositeScores(sparse, {
      fields: [evenFields[0], { ...evenFields[1], weight: 0 }],
      aggregation: "weighted-mean",
      nullHandling: "drop",
      scale: 100,
    });
    // "b" carries no share, so its gap is not a missing value: "a" alone still
    // scores every feature at 0, 5, 10 of 0..10.
    assert.deepEqual(scores, [0, 50, 100]);
    assert.equal(unscored, 0);
  });

  it("clamps a negative weight rather than scoring outside the range", () => {
    const { scores, weights } = computeCompositeScores(columns, {
      fields: [evenFields[0], { ...evenFields[1], weight: -1 }],
      aggregation: "weighted-mean",
      nullHandling: "drop",
      scale: 100,
    });
    // A negative share would drag the mean below zero; clamped, "b" simply
    // carries nothing and "a" is the whole index.
    assert.equal(weights.get("b"), 0);
    assert.deepEqual(scores, [0, 50, 100]);
  });

  it("leaves every feature unscored when no field carries weight", () => {
    const { scores, unscored } = computeCompositeScores(columns, {
      fields: evenFields.map((entry) => ({ ...entry, weight: 0 })),
      aggregation: "weighted-mean",
      nullHandling: "drop",
      scale: 100,
    });
    // Guarding the zero total is what keeps these null rather than NaN.
    assert.deepEqual(scores, [null, null, null]);
    assert.equal(unscored, 3);
  });

  it("reports components on the same scale as the score", () => {
    const { components } = computeCompositeScores(columns, {
      fields: evenFields,
      aggregation: "weighted-mean",
      nullHandling: "drop",
      scale: 100,
    });
    assert.deepEqual(components.get("a"), [0, 50, 100]);
    assert.deepEqual(components.get("b"), [100, 50, 0]);
  });
});

describe("composite score tool", () => {
  /** Three points carrying two numeric fields that run in opposite directions. */
  function scoreLayer(): GeoLibreLayer {
    return pointLayer([
      [0, 0, { pop: 0, rent: 10 }],
      [0.001, 0, { pop: 5, rent: 5 }],
      [0.002, 0, { pop: 10, rent: 0 }],
    ]);
  }

  const twoFields = [
    { field: "pop", normalization: "min-max", weight: 1, direction: "higher" },
    { field: "rent", normalization: "min-max", weight: 1, direction: "lower" },
  ];

  it("writes a 0-100 score and asks the host to style by it", () => {
    const { results, messages } = run(compositeScoreTool, scoreLayer(), {
      fields: twoFields,
      nullHandling: "drop",
      aggregation: "weighted-mean",
      scoreField: "score",
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].options?.graduatedField, "score");
    assert.deepEqual(
      results[0].geojson.features.map((f) => f.properties?.score),
      [0, 50, 100],
    );
    assert.ok(messages.some((m) => m.includes("Weights: pop 50%, rent 50% (lower is better)")));
    assert.ok(messages.some((m) => m.includes("Scored 3 of 3 features")));
  });

  it("honors a 0-1 range and a custom score field name", () => {
    const { results } = run(compositeScoreTool, scoreLayer(), {
      fields: twoFields,
      nullHandling: "drop",
      scoreRange: "0-1",
      scoreField: "suitability",
    });
    assert.deepEqual(
      results[0].geojson.features.map((f) => f.properties?.suitability),
      [0, 0.5, 1],
    );
    assert.equal(results[0].options?.graduatedField, "suitability");
  });

  it("keeps the normalized components when asked", () => {
    const { results } = run(compositeScoreTool, scoreLayer(), {
      fields: twoFields,
      nullHandling: "drop",
      keepComponents: true,
    });
    // The cheapest, most populous point scores 100 on both components; the
    // first feature is its opposite, so both of its components are 0.
    const first = results[0].geojson.features[0].properties as Record<string, number>;
    const last = results[0].geojson.features[2].properties as Record<string, number>;
    assert.equal(first.score_pop, 0);
    assert.equal(first.score_rent, 0);
    assert.equal(last.score_pop, 100);
    assert.equal(last.score_rent, 100);
  });

  it("drops features missing a value, and says how many", () => {
    const layer = pointLayer([
      [0, 0, { pop: 0, rent: 10 }],
      [0.001, 0, { pop: 5 }],
      [0.002, 0, { pop: 10, rent: 0 }],
    ]);
    const { results, messages } = run(compositeScoreTool, layer, {
      fields: twoFields,
      nullHandling: "drop",
    });
    assert.equal(results[0].geojson.features.length, 2);
    assert.ok(messages.some((m) => m.includes("1 feature(s) missing a value were dropped")));
  });

  it("renormalizes the weights over the fields a feature has", () => {
    const layer = pointLayer([
      [0, 0, { pop: 0, rent: 10 }],
      [0.001, 0, { pop: 8 }],
      [0.002, 0, { pop: 10, rent: 0 }],
    ]);
    const { results } = run(compositeScoreTool, layer, {
      fields: twoFields,
      nullHandling: "renormalize",
    });
    assert.deepEqual(
      results[0].geojson.features.map((f) => f.properties?.score),
      [0, 80, 100],
    );
  });

  it("requires two fields, distinct fields, and an explicit null rule", () => {
    const layer = scoreLayer();
    assert.ok(
      run(compositeScoreTool, layer, {
        fields: [twoFields[0]],
        nullHandling: "drop",
      }).messages.some((m) => m.includes("at least two numeric fields")),
    );
    assert.ok(
      run(compositeScoreTool, layer, {
        fields: [twoFields[0], { ...twoFields[0] }],
        nullHandling: "drop",
      }).messages.some((m) => m.includes("listed more than once")),
    );
    assert.ok(
      run(compositeScoreTool, layer, { fields: twoFields }).messages.some((m) =>
        m.includes("how features missing a value are handled"),
      ),
    );
  });

  it("honors a zero weight rather than quietly restoring it to one", () => {
    const { results } = run(compositeScoreTool, scoreLayer(), {
      fields: [twoFields[0], { ...twoFields[1], weight: 0 }],
      nullHandling: "drop",
    });
    // Only "pop" counts, so the score follows it: 0, 5, 10 of 0..10.
    assert.deepEqual(
      results[0].geojson.features.map((f) => f.properties?.score),
      [0, 50, 100],
    );
  });

  it("warns when the score field name already exists on the layer", () => {
    const layer = pointLayer([
      [0, 0, { pop: 0, rent: 10, score: 42 }],
      [0.001, 0, { pop: 10, rent: 0, score: 7 }],
    ]);
    const { messages, results } = run(compositeScoreTool, layer, {
      fields: twoFields,
      nullHandling: "drop",
    });
    assert.ok(messages.some((m) => m.includes('"score" already exists on this layer')));
    // The warning is a note, not a refusal: the run still produces the index.
    assert.deepEqual(
      results[0].geojson.features.map((f) => f.properties?.score),
      [0, 100],
    );
  });

  it("errors when every field's weight is zero", () => {
    const { messages, results } = run(compositeScoreTool, scoreLayer(), {
      fields: twoFields.map((entry) => ({ ...entry, weight: 0 })),
      nullHandling: "drop",
    });
    assert.equal(results.length, 0);
    assert.ok(messages.some((m) => m.includes("weight above zero")));
  });

  it("does not read a boolean field as numeric", () => {
    const layer = pointLayer([
      [0, 0, { pop: 0, park: true }],
      [0.001, 0, { pop: 10, park: false }],
    ]);
    const { messages } = run(compositeScoreTool, layer, {
      fields: [
        twoFields[0],
        { field: "park", normalization: "min-max", weight: 1, direction: "higher" },
      ],
      nullHandling: "drop",
    });
    assert.ok(messages.some((m) => m.includes('"park" has no numeric values')));
  });

  it("scores a field whose numbers arrive as strings", () => {
    const layer = pointLayer([
      [0, 0, { pop: "0", rent: "10" }],
      [0.001, 0, { pop: "10", rent: "0" }],
    ]);
    const { results } = run(compositeScoreTool, layer, {
      fields: twoFields,
      nullHandling: "drop",
    });
    assert.deepEqual(
      results[0].geojson.features.map((f) => f.properties?.score),
      [0, 100],
    );
  });

  it("errors when a chosen field holds no numeric values", () => {
    const layer = pointLayer([
      [0, 0, { pop: 1, label: "a" }],
      [0.001, 0, { pop: 2, label: "b" }],
    ]);
    const { messages } = run(compositeScoreTool, layer, {
      fields: [
        twoFields[0],
        { field: "label", normalization: "min-max", weight: 1, direction: "higher" },
      ],
      nullHandling: "drop",
    });
    assert.ok(messages.some((m) => m.includes('"label" has no numeric values')));
  });
});

describe("bounded neighbor search", () => {
  // buildNeighbors and meanNearestNeighborDistance skip the geodesic for pairs
  // their central-angle bounds already decide. Pin that the result is exactly
  // what measuring every pair gives.
  afterEach(() => setActiveEllipsoidId("earth"));

  /** Mulberry32: a small seeded generator, so the point sets are reproducible. */
  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Every pair measured: the reference the bounded search must match. */
  function bruteNeighbors(
    coords: [number, number][],
    type: string,
    k: number,
    thresholdKm: number,
  ): number[][] {
    return coords.map((p, i) => {
      const distances = coords
        .map((q, j) => ({ j, d: geodesicDistance(p, q) }))
        .filter((e) => e.j !== i);
      if (type === "distance") {
        return distances.filter((e) => e.d <= thresholdKm * 1000).map((e) => e.j);
      }
      return distances
        .sort((a, b) => a.d - b.d)
        .slice(0, k)
        .map((e) => e.j);
    });
  }

  function bruteMeanNearest(coords: [number, number][]): number {
    let sum = 0;
    coords.forEach((p, i) => {
      let nearest = Infinity;
      coords.forEach((q, j) => {
        if (j !== i) nearest = Math.min(nearest, geodesicDistance(p, q));
      });
      sum += nearest;
    });
    return sum / coords.length;
  }

  /**
   * 300 points: 200 over northern Italy, 90 anywhere on the globe, and pairs
   * that stress the bounds: duplicates (ties), short meridian steps at the
   * equator (where the lower bound is tight) and points around the pole and
   * across the antimeridian.
   */
  function pointSet(seed: number): [number, number][] {
    const random = seeded(seed);
    const coords: [number, number][] = [];
    for (let i = 0; i < 200; i++) coords.push([7 + random() * 6, 44 + random() * 3]);
    for (let i = 0; i < 90; i++) {
      coords.push([random() * 360 - 180, (Math.asin(2 * random() - 1) * 180) / Math.PI]);
    }
    coords.push([9.19, 45.4642], [9.19, 45.4642], [0, 0], [0, 0.001], [0, 0.002]);
    coords.push([179.999, 10], [-179.999, 10], [0, 89.9], [120, 89.9], [-120, 89.9]);
    return coords;
  }

  const cases: [string, number, number][] = [
    ["earth", 1, 25],
    ["earth", 8, 60],
    ["earth", 30, 3000],
    ["mars", 8, 40],
    ["moon", 8, 40],
  ];
  for (const [body, k, thresholdKm] of cases) {
    it(`matches every-pair KNN, distance bands and nearest distances on ${body} (k=${k}, ${thresholdKm} km)`, () => {
      setActiveEllipsoidId(body);
      const coords = pointSet(k * 7919 + thresholdKm);
      assert.deepEqual(buildNeighbors(coords, "knn", k, 0), bruteNeighbors(coords, "knn", k, 0));
      assert.deepEqual(
        buildNeighbors(coords, "distance", k, thresholdKm),
        bruteNeighbors(coords, "distance", k, thresholdKm),
      );
      assert.equal(meanNearestNeighborDistance(coords), bruteMeanNearest(coords));
    });
  }
});
