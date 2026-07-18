import area from "@turf/area";
import bbox from "@turf/bbox";
import centroid from "@turf/centroid";
import { featureCollection, polygon as turfPolygon } from "@turf/helpers";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";
import { getActiveMeanRadiusMeters } from "@geolibre/core";
import type { ProcessingAlgorithm, ProcessingContext } from "./types";

/**
 * Spatial Statistics processing tools (issue #342): global and local Moran's I
 * (LISA), Getis-Ord Gi* hotspot analysis, kernel density estimation, and
 * average nearest neighbor. These run entirely client-side in TypeScript — the
 * spatial-weights matrices and statistics are implemented here, with
 * conditional-permutation inference for the autocorrelation measures (matching
 * PySAL's pseudo p-value convention). They are NOT sidecar-capable.
 */

/** O(n²)-bounded tools (weights/nearest-neighbor) cap features to stay snappy. */
const MAX_WEIGHTS_FEATURES = 5000;
/** Hard cap on KDE grid cells so a tiny cell size can't allocate forever. */
const MAX_KDE_CELLS = 40000;
/**
 * Mean radius of the project's active body in kilometres, for the haversine
 * helper. Read lazily so spatial-stats distances (KDE bandwidth, distance-band
 * weights) are correct on the Moon/Mars, not just Earth.
 */
function activeMeanRadiusKm(): number {
  return getActiveMeanRadiusMeters() / 1000;
}

const WEIGHTS_TYPE_OPTIONS = [
  { value: "knn", label: "K nearest neighbors" },
  { value: "distance", label: "Distance band" },
];

function getLayer(ctx: ProcessingContext, paramId = "layer"): GeoLibreLayer | undefined {
  const layerId = ctx.parameters[paramId] as string | undefined;
  return ctx.layers.find((layer) => layer.id === layerId);
}

/** Great-circle distance between two lon/lat points, in kilometres. */
function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * activeMeanRadiusKm() * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Standard-normal CDF via an Abramowitz-Stegun erf approximation. */
function normalCdf(z: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  const cdfAbs = 0.5 * (1 + y);
  return z >= 0 ? cdfAbs : 1 - cdfAbs;
}

/** Two-sided normal p-value for a z-score. */
function twoSidedP(z: number): number {
  return 2 * (1 - normalCdf(Math.abs(z)));
}

/**
 * Representative lon/lat for each feature (centroid for non-point geometries).
 * Returns null entries for features whose geometry can't be located.
 */
function featureCoords(features: Feature[]): ([number, number] | null)[] {
  return features.map((feature) => {
    const geometry = feature.geometry;
    if (!geometry) return null;
    if (geometry.type === "Point") {
      const [lon, lat] = geometry.coordinates;
      return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
    }
    try {
      const [lon, lat] = centroid(feature).geometry.coordinates;
      return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
    } catch {
      return null;
    }
  });
}

/**
 * The subset of features that have both a locatable position and a finite
 * numeric value for `field`, plus the aligned coordinate and value arrays.
 */
interface NumericSample {
  features: Feature[];
  coords: [number, number][];
  values: number[];
}

function collectNumericSample(features: Feature[], field: string): NumericSample {
  const coords = featureCoords(features);
  const out: NumericSample = { features: [], coords: [], values: [] };
  features.forEach((feature, index) => {
    const position = coords[index];
    if (!position) return;
    const raw = feature.properties?.[field];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value)) return;
    out.features.push(feature);
    out.coords.push(position);
    out.values.push(value);
  });
  return out;
}

/** Neighbor index lists for a set of points (excludes self). */
function buildNeighbors(
  coords: [number, number][],
  type: string,
  k: number,
  thresholdKm: number,
): number[][] {
  const n = coords.length;
  const neighbors: number[][] = [];
  for (let i = 0; i < n; i++) {
    const distances: { j: number; d: number }[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const d = haversineKm(coords[i][0], coords[i][1], coords[j][0], coords[j][1]);
      distances.push({ j, d });
    }
    if (type === "distance") {
      neighbors.push(distances.filter((entry) => entry.d <= thresholdKm).map((e) => e.j));
    } else {
      distances.sort((a, b) => a.d - b.d);
      neighbors.push(distances.slice(0, k).map((e) => e.j));
    }
  }
  return neighbors;
}

/** Fisher-Yates in place; uses Math.random (browser runtime, deterministic seeding not required). */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function clone(features: Feature[]): Feature[] {
  return features.map((feature) => ({
    ...feature,
    properties: { ...(feature.properties ?? {}) },
  }));
}

// -- shared parameter fragments ----------------------------------------------

const WEIGHTS_PARAMS = [
  {
    id: "weightsType",
    label: "Spatial weights",
    type: "select" as const,
    default: "knn",
    options: WEIGHTS_TYPE_OPTIONS,
    description: "How neighbors are defined for each feature.",
  },
  {
    id: "k",
    label: "Neighbors (k)",
    type: "number" as const,
    default: 8,
    min: 1,
    step: 1,
    visibleWhen: { param: "weightsType", in: ["knn"] },
  },
  {
    id: "threshold",
    label: "Distance band (km)",
    type: "number" as const,
    default: 10,
    min: 0,
    step: 1,
    visibleWhen: { param: "weightsType", in: ["distance"] },
  },
];

const PERMUTATIONS_PARAM = {
  id: "permutations",
  label: "Permutations",
  type: "number" as const,
  default: 999,
  min: 99,
  max: 9999,
  step: 1,
  description: "Random permutations for the pseudo p-value.",
};

/** Pull and sanitize the weights/permutation parameters shared by tools. */
function readWeightsParams(ctx: ProcessingContext): {
  type: string;
  k: number;
  threshold: number;
  permutations: number;
} {
  const type = (ctx.parameters.weightsType as string) || "knn";
  const k = Math.max(1, Math.round(Number(ctx.parameters.k) || 8));
  // Fall back to the declared tool default (10 km) only when the value is
  // missing/non-numeric — an explicit 0 is preserved (the parameter allows
  // min: 0). Clamp permutations to the declared [99, 9999] bounds, since
  // scripting callers can bypass the UI's input constraints.
  const thresholdRaw = Number(ctx.parameters.threshold);
  const threshold = Number.isFinite(thresholdRaw) ? Math.max(0, thresholdRaw) : 10;
  const permutations = Math.min(
    9999,
    Math.max(99, Math.round(Number(ctx.parameters.permutations) || 999)),
  );
  return { type, k, threshold, permutations };
}

// -- Global Moran's I --------------------------------------------------------

export const globalMoransITool: ProcessingAlgorithm = {
  id: "global-morans-i",
  name: "Global Moran's I",
  description:
    "Measure overall spatial autocorrelation of a numeric attribute across the whole layer.",
  group: "Spatial Statistics",
  parameters: [
    {
      id: "layer",
      label: "Layer",
      type: "layer",
      required: true,
      geometryFilter: ["point", "polygon"],
    },
    { id: "field", label: "Value field", type: "field", required: true },
    ...WEIGHTS_PARAMS,
    PERMUTATIONS_PARAM,
  ],
  run: (ctx) => {
    const layer = getLayer(ctx);
    const field = ctx.parameters.field as string;
    if (!layer?.geojson) {
      ctx.log("Error: layer has no GeoJSON data");
      return;
    }
    const sample = collectNumericSample(layer.geojson.features, field);
    const n = sample.values.length;
    if (n < 3) {
      ctx.log(`Error: need at least 3 features with a numeric "${field}".`);
      return;
    }
    if (n > MAX_WEIGHTS_FEATURES) {
      ctx.log(
        `Error: ${n} features exceeds the ${MAX_WEIGHTS_FEATURES}-feature limit for weights.`,
      );
      return;
    }
    const { type, k, threshold, permutations } = readWeightsParams(ctx);
    const neighbors = buildNeighbors(sample.coords, type, k, threshold);

    const mean = sample.values.reduce((a, b) => a + b, 0) / n;
    const z = sample.values.map((v) => v - mean);
    const m2 = z.reduce((acc, zi) => acc + zi * zi, 0);
    if (m2 === 0) {
      ctx.log("Error: the value field is constant; Moran's I is undefined.");
      return;
    }

    // Row-standardized weights: numerator = Σ_i z_i * mean(neighbor z); islands
    // (no neighbors) contribute 0 and are excluded from S0.
    const moran = (zArr: number[]): number => {
      let numerator = 0;
      let s0 = 0;
      for (let i = 0; i < n; i++) {
        const nb = neighbors[i];
        if (!nb.length) continue;
        let lag = 0;
        for (const j of nb) lag += zArr[j];
        lag /= nb.length;
        numerator += zArr[i] * lag;
        s0 += 1;
      }
      return s0 === 0 ? Number.NaN : (n / s0) * (numerator / m2);
    };

    const observed = moran(z);
    if (!Number.isFinite(observed)) {
      ctx.log("Error: no feature has any neighbor under these weights.");
      return;
    }
    const expected = -1 / (n - 1);

    // Standard (unconditional) permutation test: freely shuffle all values and
    // recompute I. (The conditional variant — holding z_i fixed — is used for
    // the per-feature local statistic below.)
    let ge = 0;
    const permValues = z.slice();
    for (let p = 0; p < permutations; p++) {
      shuffle(permValues);
      if (moran(permValues) >= observed) ge++;
    }
    let larger = ge;
    if (permutations - larger < larger) larger = permutations - larger;
    const pSim = (larger + 1) / (permutations + 1);
    const pattern =
      pSim > 0.05
        ? "no significant spatial autocorrelation"
        : observed > expected
          ? "clustered (positive autocorrelation)"
          : "dispersed (negative autocorrelation)";

    ctx.log(`Global Moran's I for "${field}" (n=${n}):`);
    ctx.log(`  Moran's I:   ${observed.toFixed(4)}`);
    ctx.log(`  Expected I:  ${expected.toFixed(4)}`);
    ctx.log(`  p (sim):     ${pSim.toFixed(4)} (${permutations} permutations)`);
    ctx.log(`  Pattern:     ${pattern}`);
  },
};

// -- Local Moran's I (LISA) --------------------------------------------------

const QUADRANT_LABEL: Record<number, string> = {
  1: "High-High",
  2: "Low-High",
  3: "Low-Low",
  4: "High-Low",
};

export const localMoransITool: ProcessingAlgorithm = {
  id: "local-morans-i",
  name: "Local Moran's I (LISA)",
  description:
    "Per-feature clusters and outliers (High-High, Low-Low, High-Low, Low-High) with pseudo significance.",
  group: "Spatial Statistics",
  parameters: [
    {
      id: "layer",
      label: "Layer",
      type: "layer",
      required: true,
      geometryFilter: ["point", "polygon"],
    },
    { id: "field", label: "Value field", type: "field", required: true },
    ...WEIGHTS_PARAMS,
    PERMUTATIONS_PARAM,
  ],
  run: (ctx) => {
    const layer = getLayer(ctx);
    const field = ctx.parameters.field as string;
    if (!layer?.geojson) {
      ctx.log("Error: layer has no GeoJSON data");
      return;
    }
    const sample = collectNumericSample(layer.geojson.features, field);
    const n = sample.values.length;
    if (n < 3) {
      ctx.log(`Error: need at least 3 features with a numeric "${field}".`);
      return;
    }
    if (n > MAX_WEIGHTS_FEATURES) {
      ctx.log(
        `Error: ${n} features exceeds the ${MAX_WEIGHTS_FEATURES}-feature limit for weights.`,
      );
      return;
    }
    const { type, k, threshold, permutations } = readWeightsParams(ctx);
    const neighbors = buildNeighbors(sample.coords, type, k, threshold);

    const mean = sample.values.reduce((a, b) => a + b, 0) / n;
    const z = sample.values.map((v) => v - mean);
    const m2 = z.reduce((acc, zi) => acc + zi * zi, 0) / n;
    if (m2 === 0) {
      ctx.log("Error: the value field is constant; LISA is undefined.");
      return;
    }

    const out = clone(sample.features);
    let significant = 0;
    // Index pool reused for conditional permutation (sample neighbors from the
    // other n-1 values, holding z_i fixed).
    const pool: number[] = [];
    for (let i = 0; i < n; i++) {
      const nb = neighbors[i];
      const props = out[i].properties as Record<string, unknown>;
      if (!nb.length) {
        props[`${field}_lisa_I`] = null;
        props[`${field}_lisa_p`] = null;
        props[`${field}_lisa_q`] = null;
        props[`${field}_lisa_cluster`] = "Not significant";
        continue;
      }
      let lagSum = 0;
      for (const j of nb) lagSum += z[j];
      const lag = lagSum / nb.length;
      const localI = (z[i] / m2) * lag;

      // Conditional permutation of the neighbor set.
      pool.length = 0;
      for (let j = 0; j < n; j++) if (j !== i) pool.push(j);
      let ge = 0;
      const deg = nb.length;
      for (let p = 0; p < permutations; p++) {
        // Partial Fisher-Yates: draw `deg` indices from the pool.
        let permLagSum = 0;
        for (let s = 0; s < deg; s++) {
          const r = s + Math.floor(Math.random() * (pool.length - s));
          [pool[s], pool[r]] = [pool[r], pool[s]];
          permLagSum += z[pool[s]];
        }
        const permI = (z[i] / m2) * (permLagSum / deg);
        if (permI >= localI) ge++;
      }
      let larger = ge;
      if (permutations - larger < larger) larger = permutations - larger;
      const pSim = (larger + 1) / (permutations + 1);

      const quadrant = z[i] > 0 ? (lag > 0 ? 1 : 4) : lag > 0 ? 2 : 3;
      const isSig = pSim <= 0.05;
      if (isSig) significant++;

      props[`${field}_lisa_I`] = Number(localI.toFixed(6));
      props[`${field}_lisa_p`] = Number(pSim.toFixed(4));
      props[`${field}_lisa_q`] = quadrant;
      props[`${field}_lisa_cluster`] = isSig ? QUADRANT_LABEL[quadrant] : "Not significant";
    }

    ctx.log(
      `Local Moran's I for "${field}": ${significant} of ${n} features significant (p ≤ 0.05).`,
    );
    ctx.addResultLayer?.(`${layer.name} — LISA (${field})`, featureCollection(out));
  },
};

// -- Getis-Ord Gi* -----------------------------------------------------------

/** ArcGIS-style Gi_Bin: signed confidence level (-3..3, 0 = not significant). */
function giBin(zScore: number): { bin: number; label: string } {
  const abs = Math.abs(zScore);
  const sign = zScore >= 0 ? "Hot spot" : "Cold spot";
  if (abs >= 2.576) return { bin: zScore >= 0 ? 3 : -3, label: `${sign} 99%` };
  if (abs >= 1.96) return { bin: zScore >= 0 ? 2 : -2, label: `${sign} 95%` };
  if (abs >= 1.645) return { bin: zScore >= 0 ? 1 : -1, label: `${sign} 90%` };
  return { bin: 0, label: "Not significant" };
}

export const getisOrdTool: ProcessingAlgorithm = {
  id: "getis-ord-gi",
  name: "Getis-Ord Gi* hotspots",
  description:
    "Identify statistically significant hot spots and cold spots of a numeric attribute.",
  group: "Spatial Statistics",
  parameters: [
    {
      id: "layer",
      label: "Layer",
      type: "layer",
      required: true,
      geometryFilter: ["point", "polygon"],
    },
    { id: "field", label: "Value field", type: "field", required: true },
    ...WEIGHTS_PARAMS,
  ],
  run: (ctx) => {
    const layer = getLayer(ctx);
    const field = ctx.parameters.field as string;
    if (!layer?.geojson) {
      ctx.log("Error: layer has no GeoJSON data");
      return;
    }
    const sample = collectNumericSample(layer.geojson.features, field);
    const n = sample.values.length;
    if (n < 3) {
      ctx.log(`Error: need at least 3 features with a numeric "${field}".`);
      return;
    }
    if (n > MAX_WEIGHTS_FEATURES) {
      ctx.log(
        `Error: ${n} features exceeds the ${MAX_WEIGHTS_FEATURES}-feature limit for weights.`,
      );
      return;
    }
    const { type, k, threshold } = readWeightsParams(ctx);
    const neighbors = buildNeighbors(sample.coords, type, k, threshold);

    const x = sample.values;
    const mean = x.reduce((a, b) => a + b, 0) / n;
    const variance = x.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
    const s = Math.sqrt(variance);
    if (s === 0) {
      ctx.log("Error: the value field is constant; Gi* is undefined.");
      return;
    }

    const out = clone(sample.features);
    const counts = { hot: 0, cold: 0 };
    for (let i = 0; i < n; i++) {
      // Gi* includes the focal feature itself (binary weights).
      const members = [i, ...neighbors[i]];
      const w = members.length;
      let sumWx = 0;
      for (const j of members) sumWx += x[j];
      const numerator = sumWx - mean * w;
      const denominator = s * Math.sqrt((n * w - w * w) / (n - 1)) || Number.NaN;
      const zScore = numerator / denominator;
      const props = out[i].properties as Record<string, unknown>;
      if (!Number.isFinite(zScore)) {
        props[`${field}_gi_z`] = null;
        props[`${field}_gi_p`] = null;
        props[`${field}_gi_bin`] = 0;
        props[`${field}_gi_class`] = "Not significant";
        continue;
      }
      const p = twoSidedP(zScore);
      const { bin, label } = giBin(zScore);
      if (bin > 0) counts.hot++;
      else if (bin < 0) counts.cold++;
      props[`${field}_gi_z`] = Number(zScore.toFixed(4));
      props[`${field}_gi_p`] = Number(p.toFixed(4));
      props[`${field}_gi_bin`] = bin;
      props[`${field}_gi_class`] = label;
    }

    ctx.log(
      `Getis-Ord Gi* for "${field}": ${counts.hot} hot-spot, ${counts.cold} cold-spot features (n=${n}).`,
    );
    ctx.addResultLayer?.(`${layer.name} — Gi* (${field})`, featureCollection(out));
  },
};

// -- Average nearest neighbor ------------------------------------------------

export const averageNearestNeighborTool: ProcessingAlgorithm = {
  id: "average-nearest-neighbor",
  name: "Average nearest neighbor",
  description:
    "Test whether points are clustered, dispersed, or randomly distributed (ANN ratio + z-score).",
  group: "Spatial Statistics",
  parameters: [
    {
      id: "layer",
      label: "Point layer",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
  ],
  run: (ctx) => {
    const layer = getLayer(ctx);
    if (!layer?.geojson) {
      ctx.log("Error: layer has no GeoJSON data");
      return;
    }
    const coords = featureCoords(layer.geojson.features).filter(
      (c): c is [number, number] => c !== null,
    );
    const n = coords.length;
    if (n < 2) {
      ctx.log("Error: need at least 2 points.");
      return;
    }
    if (n > MAX_WEIGHTS_FEATURES) {
      ctx.log(`Error: ${n} points exceeds the ${MAX_WEIGHTS_FEATURES}-point limit.`);
      return;
    }

    // Mean observed nearest-neighbor distance (metres).
    let sumNn = 0;
    for (let i = 0; i < n; i++) {
      let nearest = Infinity;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const d = haversineKm(coords[i][0], coords[i][1], coords[j][0], coords[j][1]);
        if (d < nearest) nearest = d;
      }
      sumNn += nearest * 1000;
    }
    const observedMean = sumNn / n;

    // Study area = bounding-box area (m²) of the input extent.
    const [west, south, east, north] = bbox(layer.geojson);
    const extent = turfPolygon([
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ]);
    const studyArea = area(extent);
    if (!(studyArea > 0)) {
      ctx.log("Error: the point extent has zero area (all points coincide).");
      return;
    }
    const density = n / studyArea;
    const expectedMean = 0.5 / Math.sqrt(density);
    const ratio = observedMean / expectedMean;
    const se = 0.26136 / Math.sqrt(n * density);
    const zScore = (observedMean - expectedMean) / se;
    const p = twoSidedP(zScore);
    const pattern =
      p > 0.05 ? "random (no significant pattern)" : ratio < 1 ? "clustered" : "dispersed";

    ctx.log(`Average nearest neighbor (n=${n}):`);
    ctx.log(`  Observed mean distance: ${observedMean.toFixed(2)} m`);
    ctx.log(`  Expected mean distance: ${expectedMean.toFixed(2)} m`);
    ctx.log(`  NN ratio:               ${ratio.toFixed(4)}`);
    ctx.log(`  z-score:                ${zScore.toFixed(4)}`);
    ctx.log(`  p-value:                ${p.toFixed(4)}`);
    ctx.log(`  Pattern:                ${pattern}`);
  },
};

// -- Kernel density estimation ----------------------------------------------

export const kernelDensityTool: ProcessingAlgorithm = {
  id: "kernel-density",
  name: "Kernel density (heatmap)",
  description: "Estimate a density surface from points as a grid of cells, using a quartic kernel.",
  group: "Spatial Statistics",
  parameters: [
    {
      id: "layer",
      label: "Point layer",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "weightField",
      label: "Weight field (optional)",
      type: "field",
      description: "Numeric field weighting each point; blank = equal weight.",
    },
    {
      id: "bandwidth",
      label: "Search radius / bandwidth (km)",
      type: "number",
      default: 5,
      min: 0,
      step: 0.5,
      required: true,
    },
    {
      id: "cellSize",
      label: "Cell size (km)",
      type: "number",
      default: 1,
      min: 0,
      step: 0.5,
      required: true,
    },
  ],
  run: (ctx) => {
    const layer = getLayer(ctx);
    if (!layer?.geojson) {
      ctx.log("Error: layer has no GeoJSON data");
      return;
    }
    const weightField = (ctx.parameters.weightField as string) || "";
    const bandwidth = Number(ctx.parameters.bandwidth);
    const cellSize = Number(ctx.parameters.cellSize);
    if (!(bandwidth > 0) || !(cellSize > 0)) {
      ctx.log("Error: bandwidth and cell size must be positive.");
      return;
    }

    const allCoords = featureCoords(layer.geojson.features);
    const points: { lon: number; lat: number; weight: number }[] = [];
    layer.geojson.features.forEach((feature, index) => {
      const position = allCoords[index];
      if (!position) return;
      let weight = 1;
      if (weightField) {
        const raw = feature.properties?.[weightField];
        const value = typeof raw === "number" ? raw : Number(raw);
        // Skip non-finite and negative weights: a negative kernel contribution
        // would cancel density and could silently zero out a cell.
        if (!Number.isFinite(value) || value < 0) return;
        weight = value;
      }
      points.push({ lon: position[0], lat: position[1], weight });
    });
    if (points.length > MAX_WEIGHTS_FEATURES) {
      ctx.log(
        `Error: ${points.length} points exceeds the ${MAX_WEIGHTS_FEATURES}-point limit. The grid loop is O(cells × points); reduce the input size.`,
      );
      return;
    }
    if (!points.length) {
      ctx.log("Error: no usable points in the layer.");
      return;
    }

    // Build a grid over the point extent, padded by one bandwidth so the
    // kernel tails near the edges are represented.
    const [west, south, east, north] = bbox(layer.geojson);
    const midLat = (south + north) / 2;
    const kmPerDegLat = 111.32;
    const kmPerDegLon = 111.32 * Math.cos((midLat * Math.PI) / 180) || 1e-6;
    const padLon = bandwidth / kmPerDegLon;
    const padLat = bandwidth / kmPerDegLat;
    const minLon = west - padLon;
    const maxLon = east + padLon;
    const minLat = south - padLat;
    const maxLat = north + padLat;
    const cellLon = cellSize / kmPerDegLon;
    const cellLat = cellSize / kmPerDegLat;
    const cols = Math.max(1, Math.ceil((maxLon - minLon) / cellLon));
    const rows = Math.max(1, Math.ceil((maxLat - minLat) / cellLat));
    if (cols * rows > MAX_KDE_CELLS) {
      ctx.log(
        `Error: ${cols}×${rows} = ${cols * rows} cells exceeds the ${MAX_KDE_CELLS}-cell limit. Increase the cell size or reduce the bandwidth.`,
      );
      return;
    }

    // Quartic (biweight) kernel; the 3/(π h²) factor makes it a proper 2D
    // density that integrates to the point weight.
    const norm = 3 / (Math.PI * bandwidth * bandwidth);
    const cells: Feature<Geometry>[] = [];
    let maxDensity = 0;
    for (let r = 0; r < rows; r++) {
      const cellSouth = minLat + r * cellLat;
      const cellNorth = cellSouth + cellLat;
      const centerLat = (cellSouth + cellNorth) / 2;
      for (let c = 0; c < cols; c++) {
        const cellWest = minLon + c * cellLon;
        const cellEast = cellWest + cellLon;
        const centerLon = (cellWest + cellEast) / 2;
        let density = 0;
        for (const point of points) {
          const d = haversineKm(centerLon, centerLat, point.lon, point.lat);
          if (d >= bandwidth) continue;
          const u = d / bandwidth;
          density += point.weight * norm * (1 - u * u) ** 2;
        }
        if (density <= 0) continue;
        if (density > maxDensity) maxDensity = density;
        cells.push(
          turfPolygon(
            [
              [
                [cellWest, cellSouth],
                [cellEast, cellSouth],
                [cellEast, cellNorth],
                [cellWest, cellNorth],
                [cellWest, cellSouth],
              ],
            ],
            { density },
          ),
        );
      }
    }

    if (!cells.length) {
      ctx.log("No density produced — every cell is empty. Increase the bandwidth.");
      return;
    }
    // Add a normalized 0..1 density for easy styling.
    for (const cell of cells) {
      const props = cell.properties as Record<string, number>;
      props.density = Number(props.density.toFixed(6));
      props.density_norm = Number((props.density / maxDensity).toFixed(6));
    }

    ctx.log(
      `Kernel density: ${cells.length} non-empty cells over a ${cols}×${rows} grid (${points.length} points).`,
    );
    ctx.addResultLayer?.(
      `${layer.name} — Kernel density`,
      featureCollection(cells) as FeatureCollection,
    );
  },
};

export const STATISTICS_TOOLS: ProcessingAlgorithm[] = [
  globalMoransITool,
  localMoransITool,
  getisOrdTool,
  averageNearestNeighborTool,
  kernelDensityTool,
];

export function getStatisticsTool(id: string): ProcessingAlgorithm | undefined {
  return STATISTICS_TOOLS.find((tool) => tool.id === id);
}
