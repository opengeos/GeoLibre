import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  type ProcessingAlgorithm,
  STATISTICS_TOOLS,
  averageNearestNeighborTool,
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
  results: Array<{ name: string; geojson: FeatureCollection }>;
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
    addResultLayer: (name, geojson) => results.push({ name, geojson }),
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
  it("exposes all five spatial-statistics tools", () => {
    // The sorted-id comparison below fully pins membership; no separate
    // (fragile) length assertion is needed.
    assert.deepEqual(STATISTICS_TOOLS.map((t) => t.id).sort(), [
      "average-nearest-neighbor",
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
