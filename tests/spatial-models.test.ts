import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  type ProcessingAlgorithm,
  dbscanTool,
  gwrTool,
  hdbscanTool,
  krigingDiagnosticsTool,
  olsRegressionTool,
} from "@geolibre/processing";
import type { FeatureCollection } from "geojson";
import {
  DistanceMatrix,
  dbscan,
  empiricalVariogram,
  fUpperP,
  fitVariogram,
  gwr,
  hdbscan,
  invertMatrix,
  krigingLeaveOneOut,
  ols,
  searchGwrBandwidth,
  studentTTwoSidedP,
  variogramValue,
  type VariogramFit,
} from "../packages/processing/src/spatial-models";

function close(actual: number, expected: number, tol: number, label = ""): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label} expected ${expected} ± ${tol}, got ${actual}`,
  );
}

const georgia = JSON.parse(
  readFileSync(new URL("./fixtures/georgia-gwr.json", import.meta.url), "utf8"),
) as { columns: string[]; rows: number[][] };
// Columns: X, Y, PctBach, PctRural, PctPov, PctBlack.
const gY = georgia.rows.map((r) => r[2]);
const gX = georgia.rows.map((r) => [r[3], r[4], r[5]]);
const gDist = new DistanceMatrix(georgia.rows.length, (i, j) =>
  Math.hypot(georgia.rows[i][0] - georgia.rows[j][0], georgia.rows[i][1] - georgia.rows[j][1]),
);

describe("statistical review regressions", () => {
  it("fits full-rank predictors independently of their offset and units", () => {
    const x = Array.from({ length: 8 }, (_, i) => [1_000_000 + i]);
    const y = x.map((_, i) => 3 + 2 * i + (i % 2) * 0.1);
    const original = ols(x, y),
      centered = ols(
        x.map((row) => [row[0] - 1_000_000]),
        y,
      );
    assert.ok(original && centered);
    close(original.coefficients[1], centered.coefficients[1], 1e-10);
    original.fitted.forEach((value, i) => close(value, centered.fitted[i], 1e-9));
    const dm = new DistanceMatrix(8, (i, j) => Math.abs(i - j));
    const local = gwr(x, y, dm, 8, { kernel: "gaussian", adaptive: true });
    const shifted = gwr(
      x.map((row) => [row[0] - 1_000_000]),
      y,
      dm,
      8,
      { kernel: "gaussian", adaptive: true },
    );
    assert.ok(local && shifted);
    local.fitted.forEach((value, i) => close(value, shifted.fitted[i], 1e-9));
  });

  it("keeps undefined F probabilities unavailable and perfect-fit evidence finite", () => {
    assert.ok(Number.isNaN(fUpperP(NaN, 1, 3)));
    const fit = ols([[-1], [0], [1]], [-1, 0, 1]);
    assert.ok(fit);
    assert.equal(fit.fStatistic, Infinity);
    assert.equal(fit.fPValue, 0);
  });

  it("keeps the widest valid GWR bandwidth when interior fits are singular", () => {
    const sites = Array.from({ length: 100 }, (_, i) => (i < 85 ? 0 : i < 99 ? 1 : 10));
    const x = sites.map((site) => [site === 1 ? 1 : 0]);
    const dm = new DistanceMatrix(100, (i, j) => Math.abs(sites[i] - sites[j]));
    const result = searchGwrBandwidth(
      x,
      sites.map((site, i) => site + (i % 7)),
      dm,
      { kernel: "bisquare", adaptive: true },
    );
    assert.ok(Number.isFinite(result.aicc));
    assert.equal(result.bandwidth, 100);
  });

  it("does not count the same DBSCAN bucket repeatedly at tiny resolutions", () => {
    assert.deepEqual(dbscan([[6_371_000, 0, 0]], 1e-10, 3).labels, [-1]);
  });

  it("rejects excessive dense pair work without retaining all neighborhoods", () => {
    assert.throws(
      () =>
        dbscan(
          Array.from({ length: 5000 }, () => [0, 0]),
          1,
          2,
        ),
      /too dense/,
    );
  });

  it("keeps three stable coincident HDBSCAN pairs separate", () => {
    const locations = [0, 0, 1, 1, 10, 10];
    const result = hdbscan(6, (i, j) => Math.abs(locations[i] - locations[j]), 2, 2);
    assert.ok(result.labels.every((label) => label >= 0));
    for (let i = 0; i < 6; i += 2) assert.equal(result.labels[i], result.labels[i + 1]);
    assert.equal(new Set([result.labels[0], result.labels[2], result.labels[4]]).size, 3);
    assert.equal(result.probabilities.length, 6);
    assert.ok(result.probabilities.every(Number.isFinite));
  });
});

const clusters = JSON.parse(
  readFileSync(new URL("./fixtures/density-clusters.json", import.meta.url), "utf8"),
) as {
  points: number[][];
  dbscan: number[];
  dbscanCore: number[];
  hdbscan: number[];
  hdbscanProbabilities: number[];
  hdbscan15x5: number[];
  hdbscan15x5Probabilities: number[];
};

describe("distributions", () => {
  it("matches scipy's Student t and F tail probabilities", () => {
    close(studentTTwoSidedP(2.1213203435596424, 3), 0.1240270626575546, 1e-10);
    close(studentTTwoSidedP(1.96, 1000), 0.050273184955748736, 1e-10);
    close(studentTTwoSidedP(-0.5, 7), 0.6324071356892844, 1e-10);
    close(fUpperP(28.3856, 2, 46), 9.340869286306168e-9, 1e-14);
    close(fUpperP(48.71, 3, 155), 3.107176574403009e-22, 1e-27);
  });

  it("inverts a matrix and rejects a singular one", () => {
    const inv = invertMatrix([
      [4, 7],
      [2, 6],
    ]);
    assert.ok(inv);
    close(inv[0][0], 0.6, 1e-12);
    close(inv[0][1], -0.7, 1e-12);
    close(inv[1][0], -0.2, 1e-12);
    close(inv[1][1], 0.4, 1e-12);
    assert.equal(
      invertMatrix([
        [1, 2],
        [2, 4],
      ]),
      null,
    );
  });
});

describe("ols", () => {
  it("reproduces a hand-computed simple regression", () => {
    // y = 2.2 + 0.6 x; residuals -0.8, 0.6, 1, -0.6, -0.2; SSE 2.4, MSE 0.8.
    const fit = ols([[1], [2], [3], [4], [5]], [2, 4, 5, 4, 5]);
    assert.ok(fit);
    close(fit.coefficients[0], 2.2, 1e-12);
    close(fit.coefficients[1], 0.6, 1e-12);
    close(fit.rss, 2.4, 1e-12);
    close(fit.r2, 0.6, 1e-12);
    close(fit.standardErrors[1], Math.sqrt(0.08), 1e-12);
    close(fit.tValues[1], 2.1213203435596424, 1e-10);
    close(fit.pValues[1], 0.1240270626575546, 1e-9);
    assert.deepEqual(
      fit.residuals.map((r) => Math.round(r * 1e9) / 1e9),
      [-0.8, 0.6, 1, -0.6, -0.2],
    );
  });

  it("matches GWR4's global regression on the Georgia data", () => {
    const fit = ols(gX, gY);
    assert.ok(fit);
    const expected = [
      [23.854615, 1.173043, 20.335661],
      [-0.111395, 0.012878, -8.649661],
      [-0.345778, 0.070863, -4.87954],
      [0.058331, 0.029187, 1.998499],
    ];
    expected.forEach(([b, se, t], j) => {
      close(fit.coefficients[j], b, 5e-7, `b${j}`);
      close(fit.standardErrors[j], se, 5e-7, `se${j}`);
      close(fit.tValues[j], t, 5e-6, `t${j}`);
    });
    close(fit.rss, 2639.559476, 1e-5);
    close(fit.r2, 0.485273, 5e-7);
    // Standard adjusted R² with k = 4 coefficients (statsmodels, GeoDa). GWR4
    // prints 0.471903 because it divides by n - k - 1 instead of n - k.
    close(fit.adjR2, 1 - ((1 - fit.r2) * 158) / 155, 1e-12);
    close(1 - ((1 - fit.r2) * 158) / 154, 0.471903, 5e-7);
    close(-2 * fit.logLikelihood, 897.927089, 1e-5);
    close(fit.aic, 907.927089, 1e-5);
    close(fit.aicc, 908.319245, 1e-5);
  });

  it("returns null for perfectly collinear predictors", () => {
    assert.equal(
      ols(
        [
          [1, 2],
          [2, 4],
          [3, 6],
          [4, 8],
        ],
        [1, 2, 3, 5],
      ),
      null,
    );
  });
});

describe("gwr", () => {
  // GWR 4.0.90 reference diagnostics for the four kernel settings.
  const cases = [
    {
      label: "adaptive bisquare",
      options: { kernel: "bisquare", adaptive: true } as const,
      bandwidth: 90,
      rss: 2090.125305,
      traceS: 14.925095,
      aicc: 896.462831,
      r2: 0.592415,
    },
    {
      label: "fixed bisquare",
      options: { kernel: "bisquare", adaptive: false } as const,
      bandwidth: 209267.688808,
      rss: 2012.563924,
      traceS: 16.722876,
      aicc: 894.982602,
      r2: 0.60754,
    },
    {
      label: "fixed gaussian",
      options: { kernel: "gaussian", adaptive: false } as const,
      bandwidth: 87308.29847,
      rss: 2030.010213,
      traceS: 16.304601,
      aicc: 895.290158,
      r2: 0.604138,
    },
    {
      label: "adaptive gaussian",
      options: { kernel: "gaussian", adaptive: true } as const,
      bandwidth: 49,
      rss: 2312.592458,
      traceS: 8.033359,
      aicc: 896.184041,
      r2: 0.549033,
    },
  ];

  for (const c of cases) {
    it(`matches GWR4 diagnostics (${c.label})`, () => {
      const fit = gwr(gX, gY, gDist, c.bandwidth, c.options);
      assert.ok(fit);
      close(fit.rss, c.rss, 1e-3, "rss");
      close(fit.traceS, c.traceS, 1e-5, "tr(S)");
      close(fit.aicc, c.aicc, 1e-4, "AICc");
      close(fit.r2, c.r2, 5e-6, "R2");
    });
  }

  it("matches GWR4's local estimates for the first county (adaptive bisquare, 90)", () => {
    const fit = gwr(gX, gY, gDist, 90, { kernel: "bisquare", adaptive: true });
    assert.ok(fit);
    // From georgia_BS_NN_listwise.csv, row 0.
    const est = [18.375924, -0.087919, -0.218522, 0.069101];
    const se = [2.414905, 0.021113, 0.115485, 0.048422];
    est.forEach((b, j) => close(fit.coefficients[0][j], b, 5e-6, `b${j}`));
    se.forEach((s, j) => close(fit.standardErrors[0][j], s, 5e-6, `se${j}`));
    close(fit.tValues[0][0], 7.609379, 5e-5);
    close(fit.fitted[0], 8.815245, 5e-6);
    close(fit.standardizedResiduals[0], -0.162278, 5e-6);
    close(fit.localR2[0], 0.551117, 5e-6);
    close(fit.influence[0], 0.041718, 5e-6);
  });

  it("finds the AICc-optimal adaptive bandwidth by golden-section search", () => {
    const opts = { kernel: "bisquare", adaptive: true } as const;
    const found = searchGwrBandwidth(gX, gY, gDist, opts);
    // Exhaustive scan of GWR4's search range [48, 159].
    let best = { bw: 0, aicc: Infinity };
    for (let bw = 48; bw <= 159; bw++) {
      const fit = gwr(gX, gY, gDist, bw, opts, false);
      if (fit && fit.aicc < best.aicc) best = { bw, aicc: fit.aicc };
    }
    // GWR4's own golden-section search stopped at 90 (AICc 896.463); the
    // surface is bumpy and 93 is the true integer minimum.
    assert.equal(best.bw, 93);
    assert.equal(found.bandwidth, best.bw);
    close(found.aicc, best.aicc, 1e-9);
    assert.ok(found.aicc < 896.462831);
  });

  it("finds a fixed bisquare bandwidth at least as good as GWR4's", () => {
    const opts = { kernel: "bisquare", adaptive: false } as const;
    const found = searchGwrBandwidth(gX, gY, gDist, opts);
    assert.ok(found.aicc <= 894.982602 + 1e-6, `AICc ${found.aicc}`);
    // And it is a local minimum.
    for (const f of [0.98, 1.02]) {
      const fit = gwr(gX, gY, gDist, found.bandwidth * f, opts, false);
      assert.ok(fit && fit.aicc >= found.aicc - 1e-9);
    }
  });

  it("reports GWR4's adjusted R², tr(S'S) and sigma", () => {
    const fit = gwr(gX, gY, gDist, 90, { kernel: "bisquare", adaptive: true });
    assert.ok(fit);
    close(fit.adjR2, 0.534505, 5e-6);
    close(fit.traceSS, 10.193958, 1e-5);
    close(Math.sqrt(fit.sigma2), 3.872954, 5e-6);
  });
});

describe("dbscan", () => {
  it("matches scikit-learn labels and core samples", () => {
    const result = dbscan(clusters.points, 0.5, 5);
    assert.deepEqual(result.labels, clusters.dbscan);
    const core = result.core.flatMap((c, i) => (c ? [i] : []));
    assert.deepEqual(core, clusters.dbscanCore);
  });

  it("handles 3D points and a single dense group", () => {
    const pts = [
      [0, 0, 0],
      [0, 0, 0.1],
      [0, 0.1, 0],
      [5, 5, 5],
    ];
    const result = dbscan(pts, 0.2, 3);
    assert.deepEqual(result.labels, [0, 0, 0, -1]);
  });
});

describe("hdbscan", () => {
  const pts = clusters.points;
  const dist = (i: number, j: number): number =>
    Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);

  it("matches scikit-learn labels and probabilities (min_cluster_size=8)", () => {
    const result = hdbscan(pts.length, dist, 8);
    assert.deepEqual(result.labels, clusters.hdbscan);
    assert.equal(result.probabilities.length, pts.length);
    result.probabilities.forEach((p, i) =>
      close(p, clusters.hdbscanProbabilities[i], 1e-8, `p${i}`),
    );
  });

  it("matches scikit-learn with min_samples below min_cluster_size", () => {
    const result = hdbscan(pts.length, dist, 15, 5);
    assert.deepEqual(result.labels, clusters.hdbscan15x5);
    assert.equal(result.probabilities.length, pts.length);
    result.probabilities.forEach((p, i) =>
      close(p, clusters.hdbscan15x5Probabilities[i], 1e-8, `p${i}`),
    );
  });
});

describe("kriging diagnostics", () => {
  it("bins an empirical semivariogram", () => {
    // Points on a line at 0, 1, 2, 3 with values 0, 1, 0, 1.
    const x = [0, 1, 2, 3];
    const z = [0, 1, 0, 1];
    const { bins, maxLag } = empiricalVariogram(4, (i, j) => Math.abs(x[i] - x[j]), z, 3);
    assert.equal(maxLag, 3);
    // Width-1 bins, edges as numpy.digitize: lag 1 → bin 1, lags 2 and 3
    // (the max, clipped) → bin 2; bin 0 is empty and dropped.
    assert.equal(bins.length, 2);
    assert.deepEqual([bins[0].lag, bins[0].gamma, bins[0].pairs], [1.5, 0.5, 3]);
    assert.deepEqual([bins[1].lag, bins[1].pairs], [2.5, 3]);
    close(bins[1].gamma, 1 / 6, 1e-15);
  });

  it("recovers a spherical model from exact semivariances", () => {
    const truth: VariogramFit = { model: "spherical", nugget: 0.5, sill: 2, range: 60, sse: 0 };
    // Range 60 is one of the 25 trial ranges for maxLag 100 (0.1 + 1.4 * 4 / 24 = 0.333..).
    const trial = 100 * (0.1 + (1.4 * 4) / 24);
    truth.range = trial;
    const bins = Array.from({ length: 12 }, (_, b) => {
      const lag = (b + 0.5) * (100 / 12);
      return { lag, gamma: variogramValue(truth, lag), pairs: 10 };
    });
    const fit = fitVariogram(bins, "spherical", 100);
    assert.ok(fit);
    close(fit.range, trial, 1e-9);
    close(fit.nugget, 0.5, 1e-9);
    close(fit.sill, 2, 1e-9);
    close(fit.sse, 0, 1e-18);
  });

  it("computes the textbook 1D linear-variogram cross-validation", () => {
    // gamma(h) = h: the left-out middle point is the mean of its neighbors with
    // kriging variance 1; an end point extrapolates from its neighbor (variance 2).
    const x = [0, 1, 2];
    const cv = krigingLeaveOneOut(3, (i, j) => Math.abs(x[i] - x[j]), [1, 3, 2], {
      model: "linear",
      nugget: 0,
      sill: 100,
      range: 100,
      sse: 0,
    });
    assert.ok(cv);
    close(cv.predicted[1], 1.5, 1e-12);
    close(cv.variances[1], 1, 1e-12);
    close(cv.predicted[0], 3, 1e-12);
    close(cv.variances[0], 2, 1e-12);
  });

  it("agrees with brute-force leave-one-out refits", () => {
    const pts = clusters.points.slice(0, 40);
    const z = pts.map(([px, py], i) => Math.sin(px) + 0.3 * py + ((i * 37) % 11) / 20);
    const dist = (i: number, j: number): number =>
      Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
    const fit: VariogramFit = { model: "exponential", nugget: 0.05, sill: 1.2, range: 3, sse: 0 };
    const cv = krigingLeaveOneOut(pts.length, dist, z, fit);
    assert.ok(cv);
    for (const leave of [0, 7, 19, 39]) {
      const keep = pts.map((_, i) => i).filter((i) => i !== leave);
      const m = keep.length;
      const k = Array.from({ length: m + 1 }, () => new Array<number>(m + 1).fill(1));
      keep.forEach((a, r) =>
        keep.forEach((b, c) => {
          k[r][c] = variogramValue(fit, dist(a, b));
        }),
      );
      k[m][m] = 0;
      const rhs = [...keep.map((a) => variogramValue(fit, dist(a, leave))), 1];
      const inv = invertMatrix(k);
      assert.ok(inv);
      const w = inv.map((row) => row.reduce((s, v, j) => s + v * rhs[j], 0));
      const pred = keep.reduce((s, a, r) => s + w[r] * z[a], 0);
      const variance = w.reduce((s, v, j) => s + v * rhs[j], 0);
      close(cv.predicted[leave], pred, 1e-8, `pred ${leave}`);
      close(cv.variances[leave], variance, 1e-8, `var ${leave}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The processing tools that wrap these models.
// ---------------------------------------------------------------------------

function pointLayer(points: Array<[number, number, Record<string, unknown>]>): GeoLibreLayer {
  return {
    id: "pts",
    name: "Points",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: {
      type: "FeatureCollection",
      features: points.map(([lon, lat, properties]) => ({
        type: "Feature",
        properties,
        geometry: { type: "Point", coordinates: [lon, lat] },
      })),
    },
  };
}

async function runTool(
  tool: ProcessingAlgorithm,
  layer: GeoLibreLayer,
  parameters: Record<string, unknown>,
): Promise<{ messages: string[]; results: { name: string; geojson: FeatureCollection }[] }> {
  const messages: string[] = [];
  const results: { name: string; geojson: FeatureCollection }[] = [];
  await tool.run({
    layers: [layer],
    parameters: { layer: layer.id, ...parameters },
    log: (m) => messages.push(m),
    addResultLayer: (name, geojson) => results.push({ name, geojson }),
  });
  return { messages, results };
}

/** Georgia counties as rough lon/lat points (UTM 17N metres scaled to degrees). */
const georgiaLayer = pointLayer(
  georgia.rows.map((r) => [
    -81 + (r[0] - 500000) / 94500,
    r[1] / 110900,
    { PctBach: r[2], PctRural: r[3], PctPov: r[4], PctBlack: r[5] },
  ]),
);

describe("regression and clustering tools", () => {
  it("keeps complete OLS attribute rows without geometry", async () => {
    const layer = pointLayer(
      Array.from({ length: 5 }, (_, i) => [i, 0, { x: i, y: 2 * i + (i % 2) * 0.1 }]),
    );
    Reflect.set(layer.geojson!.features[0], "geometry", null);
    const result = await runTool(olsRegressionTool, layer, { dependent: "y", explanatory: "x" });
    assert.equal(result.results[0].geojson.features.length, 5);
    assert.equal(result.results[0].geojson.features[0].geometry, null);
  });

  it("keeps GWR coefficient columns distinct from diagnostics and t statistics", async () => {
    const layer = structuredClone(georgiaLayer);
    for (const feature of layer.geojson!.features) {
      feature.properties = {
        ...feature.properties,
        pred: feature.properties?.PctRural,
        t_pred: feature.properties?.PctPov,
      };
    }
    const result = await runTool(gwrTool, layer, {
      dependent: "PctBach",
      explanatory: "pred,t_pred",
      bandwidth: 100,
      kernel: "gaussian",
      adaptive: true,
    });
    assert.ok(result.results.length);
    const props = result.results[0].geojson.features[0].properties!;
    for (const key of ["gwr_pred", "gwr_pred_2", "gwr_t_pred", "gwr_t_pred_2", "gwr_t_t_pred"])
      assert.ok(Number.isFinite(props[key]), key);
  });

  it("rejects a missing kriging observation instead of treating it as zero", async () => {
    const layer = pointLayer([
      [0, 0, { z: 4 }],
      [1, 0, { z: 7 }],
      [2, 0, { z: 9 }],
      [3, 0, { z: null }],
    ]);
    const result = await runTool(krigingDiagnosticsTool, layer, { field: "z" });
    assert.equal(result.results.length, 0);
    assert.match(result.messages.join("\n"), /found 3/);
  });

  it("groups equivalent antimeridian sites for leave-one-site-out validation", async () => {
    const layer = pointLayer([
      [180, 0, { z: 4 }],
      [-180, 0, { z: 7 }],
      [170, 0, { z: 9 }],
      [160, 0, { z: 12 }],
      [150, 0, { z: 3 }],
    ]);
    const result = await runTool(krigingDiagnosticsTool, layer, { field: "z" });
    assert.match(result.messages.join("\n"), /Averaged 1 duplicate/);
  });

  it("rejects unknown variogram models and oversized minimum samples", async () => {
    const layer = pointLayer([
      [0, 0, { z: 4 }],
      [1, 0, { z: 7 }],
      [2, 0, { z: 9 }],
      [3, 0, { z: 3 }],
    ]);
    const kriging = await runTool(krigingDiagnosticsTool, layer, { field: "z", model: "sphericl" });
    assert.equal(kriging.results.length, 0);
    assert.match(kriging.messages.join("\n"), /supported variogram/);
    const clustering = await runTool(hdbscanTool, layer, { minClusterSize: 2, minSamples: 5 });
    assert.equal(clustering.results.length, 0);
    assert.match(clustering.messages.join("\n"), /minimum samples/);
  });
  it("OLS writes residual fields and logs the GWR4 coefficients", async () => {
    const { messages, results } = await runTool(olsRegressionTool, georgiaLayer, {
      dependent: "PctBach",
      explanatory: "PctRural, PctPov, PctBlack",
    });
    assert.equal(results.length, 1, messages.join("\n"));
    const props = results[0].geojson.features[0].properties ?? {};
    close((props.ols_pred as number) + (props.ols_resid as number), 8.2, 1e-9);
    assert.ok(Number.isFinite(props.ols_std_resid as number));
    assert.ok(
      messages.some((m) => m.includes("23.854615")),
      messages.join("\n"),
    );
  });

  it("GWR searches the bandwidth and writes local coefficients", async () => {
    const { messages, results } = await runTool(gwrTool, georgiaLayer, {
      dependent: "PctBach",
      explanatory: "PctRural,PctPov,PctBlack",
      kernel: "bisquare",
      bandwidthType: "adaptive",
      bandwidth: 0,
    });
    assert.equal(results.length, 1, messages.join("\n"));
    const props = results[0].geojson.features[0].properties ?? {};
    for (const key of [
      "gwr_intercept",
      "gwr_PctRural",
      "gwr_t_PctPov",
      "gwr_pred",
      "gwr_resid",
      "gwr_std_resid",
      "gwr_local_r2",
    ]) {
      assert.ok(Number.isFinite(props[key] as number), key);
    }
    assert.ok(messages.some((m) => m.includes("golden-section")));
  });

  it("GWR rejects an adaptive bandwidth smaller than the model", async () => {
    const { messages, results } = await runTool(gwrTool, georgiaLayer, {
      dependent: "PctBach",
      explanatory: "PctRural,PctPov,PctBlack",
      bandwidthType: "adaptive",
      bandwidth: 3,
    });
    assert.equal(results.length, 0);
    assert.ok(messages.some((m) => m.startsWith("Error:")));
  });

  it("DBSCAN measures the search distance in metres on the ground", async () => {
    // Two groups 1 km apart at 60°N plus a lone point. Points in group a are
    // 20 m apart east-west, which is 0.00036° of longitude there: a degree
    // metric scaled at the equator would have split the group.
    const m = 1 / 111195;
    const pts: Array<[number, number, Record<string, unknown>]> = [];
    for (let i = 0; i < 5; i++) pts.push([10 + (i * 20 * m) / 0.5, 60, {}]);
    for (let i = 0; i < 5; i++) pts.push([10, 60 + 1000 * m + i * 20 * m, {}]);
    pts.push([11, 61, {}]);
    const { results } = await runTool(dbscanTool, pointLayer(pts), { eps: 25, minPoints: 3 });
    const labels = results[0].geojson.features.map((f) => f.properties?.cluster);
    assert.deepEqual(labels, [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, -1]);
    assert.equal(results[0].geojson.features[10].properties?.cluster_type, "noise");
    // End points have one neighbor within 25 m (border); inner ones have two.
    assert.equal(results[0].geojson.features[0].properties?.cluster_type, "border");
    assert.equal(results[0].geojson.features[2].properties?.cluster_type, "core");
  });

  it("HDBSCAN on lon/lat points agrees with scikit-learn on the planar fixture", async () => {
    // A tiny extent at the equator, where great-circle distance is planar up
    // to a constant scale that HDBSCAN's labels do not depend on.
    const layer = pointLayer(
      clusters.points.map(
        ([x, y]) => [x * 0.001, y * 0.001, {}] as [number, number, Record<string, unknown>],
      ),
    );
    const { results, messages } = await runTool(hdbscanTool, layer, { minClusterSize: 8 });
    assert.equal(results.length, 1, messages.join("\n"));
    const labels = results[0].geojson.features.map((f) => f.properties?.cluster as number);
    assert.deepEqual(labels, clusters.hdbscan);
  });

  it("kriging diagnostics compares models and writes cross-validation fields", async () => {
    const pts: Array<[number, number, Record<string, unknown>]> = clusters.points
      .slice(0, 60)
      .map(([x, y], i) => [x * 0.01, y * 0.01, { v: Math.sin(x) + 0.5 * y + ((i * 13) % 7) / 10 }]);
    // A duplicate location is averaged rather than making the system singular.
    pts.push([pts[0][0], pts[0][1], { v: 1 }]);
    const { results, messages } = await runTool(krigingDiagnosticsTool, pointLayer(pts), {
      field: "v",
      model: "compare",
      lags: 10,
      maxLag: 0,
    });
    assert.equal(results.length, 1, messages.join("\n"));
    assert.ok(messages.some((m) => m.startsWith("Averaged 1 duplicate")));
    for (const model of ["spherical", "exponential", "gaussian", "linear"]) {
      assert.ok(
        messages.some((m) => m.trimStart().startsWith(model)),
        model,
      );
    }
    const props = results[0].geojson.features[5].properties ?? {};
    for (const key of ["cv_pred", "cv_error", "cv_variance", "cv_std_error"]) {
      assert.ok(Number.isFinite(props[key] as number), key);
    }
    assert.equal(results[0].geojson.features.length, 61);
  });
});

it("keeps adaptive bandwidth candidates inside caller bounds", () => {
  const found = searchGwrBandwidth(gX, gY, gDist, { kernel: "bisquare", adaptive: true }, [92, 92]);
  assert.equal(found.bandwidth, 92);
  assert.equal(found.evaluations, 1);
});

it("rejects GWR inference with no residual degrees of freedom", () => {
  const sites = [0, 0, 100, 100, 200, 200];
  const x = [[-1], [1], [-1], [1], [-1], [1]];
  const y = [1, 3, 2, 4, 3, 5];
  const dm = new DistanceMatrix(6, (i, j) => Math.abs(sites[i] - sites[j]));
  assert.equal(gwr(x, y, dm, 50, { kernel: "bisquare", adaptive: false }, true), null);
  assert.ok(gwr(x, y, dm, 500, { kernel: "bisquare", adaptive: false }, true));
});

it("keeps kriging predictions invariant under variogram rescaling", () => {
  const run = (sill: number) =>
    krigingLeaveOneOut(3, (i, j) => Math.abs(i - j), [1, 3, 2], {
      model: "linear",
      nugget: 0,
      sill,
      range: 100,
      sse: 0,
    });
  const base = run(100);
  const tiny = run(1e-12);
  assert.ok(base && tiny);
  base.predicted.forEach((value, i) => close(tiny.predicted[i], value, 1e-10));
  base.variances.forEach((value, i) => close(tiny.variances[i] / 1e-14, value, 1e-10));
});

it("preserves source attributes when regression output names collide", async () => {
  const layer = pointLayer(
    Array.from({ length: 5 }, (_, i) => [
      i,
      0,
      {
        x: i,
        " value ": i * 2 + (i % 2) * 0.1,
        ols_pred: "original",
        ols_pred_source: "existing alias",
      },
    ]),
  );
  const result = await runTool(olsRegressionTool, layer, {
    dependent: " value ",
    explanatory: "x",
  });
  assert.equal(result.results.length, 1, result.messages.join("\n"));
  const props = result.results[0].geojson.features[0].properties!;
  assert.equal(props.ols_pred_source_2, "original");
  assert.equal(props.ols_pred_source, "existing alias");
  assert.equal(typeof props.ols_pred, "number");
});

it("preserves finite inference with very small predictor units", () => {
  const x = Array.from({ length: 300 }, (_, i) => [((i % 3) - 1) * 1e-155]);
  const y = Array.from(
    { length: 300 },
    (_, i) => (i % 3) - 1 + (Math.floor(i / 3) % 2 ? 0.1 : -0.1),
  );
  const fit = ols(x, y);
  assert.ok(fit);
  assert.ok(Number.isFinite(fit.standardErrors[1]));
  assert.ok(fit.tValues[1] > 10);
  assert.ok(fit.pValues[1] < 0.01);
});

it("preserves DBSCAN source cluster_type attributes", async () => {
  const layer = pointLayer([
    [0, 0, { cluster_type: "source" }],
    [0.00001, 0, { cluster_type: "other" }],
  ]);
  const output = await runTool(dbscanTool, layer, { eps: 100, minPoints: 1 });
  assert.equal(output.results[0].geojson.features[0].properties?.cluster_type_source, "source");
  assert.equal(output.results[0].geojson.features[0].properties?.cluster_type, "core");
});

it("reports features excluded from GWR and kriging samples", async () => {
  const gwrLayer = structuredClone(georgiaLayer);
  gwrLayer.geojson!.features.push({
    type: "Feature",
    properties: { PctBach: "missing" },
    geometry: { type: "Point", coordinates: [0, 0] },
  });
  const local = await runTool(gwrTool, gwrLayer, {
    dependent: "PctBach",
    explanatory: "PctRural, PctPov, PctBlack",
    kernel: "gaussian",
    bandwidthType: "adaptive",
    bandwidth: 100,
  });
  assert.equal(local.results.length, 1, local.messages.join("\n"));
  assert.match(local.messages.join("\n"), /Skipped 1 feature/);
  const points = pointLayer(
    Array.from({ length: 12 }, (_, i) => [i % 4, Math.floor(i / 4), { z: i + Math.sin(i) }]),
  );
  points.geojson!.features.push({
    type: "Feature",
    properties: { z: "missing" },
    geometry: { type: "Point", coordinates: [0, 0] },
  });
  const diagnostic = await runTool(krigingDiagnosticsTool, points, { field: "z", model: "linear" });
  assert.equal(diagnostic.results.length, 1, diagnostic.messages.join("\n"));
  assert.match(diagnostic.messages.join("\n"), /Skipped 1 feature/);
});

it("reports unlocated features omitted by both clustering tools", async () => {
  const points = pointLayer([
    [0, 0, {}],
    [0.00001, 0, {}],
    [0.00002, 0, {}],
    [1, 0, {}],
    [1.00001, 0, {}],
    [1.00002, 0, {}],
  ]);
  points.geojson!.features.push({
    type: "Feature",
    properties: {},
    geometry: { type: "GeometryCollection", geometries: [] },
  });
  for (const tool of [dbscanTool, hdbscanTool]) {
    const output = await runTool(tool, points, {
      eps: 100,
      minPoints: 2,
      minClusterSize: 2,
      minSamples: 2,
    });
    assert.equal(output.results[0].geojson.features.length, 6);
    assert.match(output.messages.join("\n"), /Skipped 1 feature\(s\) without a location/);
  }
});
