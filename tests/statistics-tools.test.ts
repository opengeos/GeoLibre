import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
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
