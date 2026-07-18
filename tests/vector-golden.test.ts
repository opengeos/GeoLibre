import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { getVectorTool, runAlgorithmCapture } from "@geolibre/processing";
import type { Feature, FeatureCollection, Geometry } from "geojson";

/**
 * Run the shared vector-tool golden fixtures against the TypeScript/Turf.js
 * client engine. The fixtures in `tests/fixtures/vector/cases` are a
 * language-neutral contract shared with the Python/GeoPandas sidecar engine
 * (driven by `backend/geolibre_server/tests/test_vector_golden.py`). Both
 * engines must satisfy the same cases, so divergence between the two
 * hand-synced implementations is caught here in CI.
 *
 * See `tests/fixtures/vector/SPEC.md` for the case schema and the two tiers of
 * agreement. The matcher below mirrors the one in the Python harness; keep the
 * two in sync.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(here, "fixtures", "vector", "cases");

interface Expectation {
  error?: boolean;
  featureCount?: number | null;
  geometryTypes?: string[] | null;
  properties?: Record<string, unknown>[] | null;
  geometry?: Geometry[] | null;
  bbox?: [number, number, number, number] | null;
  tolerance?: number | null;
}

interface GoldenCase {
  name: string;
  tool: string;
  description?: string;
  input?: FeatureCollection;
  overlay?: FeatureCollection | null;
  parameters?: Record<string, unknown>;
  expect?: Expectation;
}

function loadCases(): GoldenCase[] {
  let files: string[];
  try {
    files = readdirSync(CASES_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.sort().map((file) => {
    const data = JSON.parse(readFileSync(join(CASES_DIR, file), "utf8"));
    data.name ??= file.replace(/\.json$/, "");
    return data as GoldenCase;
  });
}

// --- matcher (mirror of the Python harness) -------------------------------

function almostEqual(a: unknown, b: unknown, tol: number): boolean {
  // Booleans compare strictly (a bool only equals an equal bool); the Python
  // harness mirrors this even though Python's `bool` subclasses `int`.
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return Math.abs(a - b) <= tol;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => almostEqual(x, b[i], tol));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length || !ak.every((k) => bk.includes(k))) return false;
    return ak.every((k) =>
      almostEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tol),
    );
  }
  return a === b;
}

/** Compare two lists ignoring order, matching each element within `tol`. */
function multisetEqual(actual: unknown[], expected: unknown[], tol: number): boolean {
  if (actual.length !== expected.length) return false;
  const remaining = [...actual];
  for (const want of expected) {
    const i = remaining.findIndex((have) => almostEqual(have, want, tol));
    if (i === -1) return false;
    remaining.splice(i, 1);
  }
  return true;
}

function geometriesEqual(a: Geometry | null, b: Geometry | null, tol: number): boolean {
  if (!a || !b) return a === b;
  if (a.type !== b.type) return false;
  // A GeometryCollection has no `coordinates` — recurse into its `geometries`
  // so nested parts are compared with tolerance too. Mirrors the Python harness.
  if (a.type === "GeometryCollection") {
    const subB = (b as typeof a).geometries;
    return (
      a.geometries.length === subB.length &&
      a.geometries.every((g, i) => geometriesEqual(g, subB[i], tol))
    );
  }
  return almostEqual(a.coordinates, b.coordinates, tol);
}

function bboxOf(features: Feature[]): [number, number, number, number] | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const walk = (coords: unknown): void => {
    if (
      Array.isArray(coords) &&
      coords.length >= 2 &&
      typeof coords[0] === "number" &&
      typeof coords[1] === "number"
    ) {
      xs.push(coords[0]);
      ys.push(coords[1]);
    } else if (Array.isArray(coords)) {
      for (const c of coords) walk(c);
    }
  };
  for (const f of features) {
    if (f.geometry && "coordinates" in f.geometry) walk(f.geometry.coordinates);
  }
  if (!xs.length) return null;
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function assertMatch(name: string, result: FeatureCollection, expect: Expectation): void {
  const tol = expect.tolerance ?? 1e-9;
  const features = result.features ?? [];

  if (expect.featureCount != null) {
    assert.equal(
      features.length,
      expect.featureCount,
      `${name}: featureCount ${features.length} != ${expect.featureCount}`,
    );
  }

  if (expect.geometryTypes != null) {
    const actual = features.map((f) => f.geometry?.type ?? "null").sort();
    assert.deepEqual(actual, [...expect.geometryTypes].sort(), `${name}: geometryTypes mismatch`);
  }

  if (expect.properties != null) {
    const actual = features.map((f) => f.properties ?? {});
    assert.ok(
      multisetEqual(actual, expect.properties, tol),
      `${name}: properties mismatch\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expect.properties)}`,
    );
  }

  if (expect.geometry != null) {
    assert.equal(features.length, expect.geometry.length, `${name}: geometry length mismatch`);
    expect.geometry.forEach((geom, i) => {
      assert.ok(
        geometriesEqual(features[i].geometry, geom, tol),
        `${name}: geometry[${i}] mismatch\n  actual:   ${JSON.stringify(features[i].geometry)}\n  expected: ${JSON.stringify(geom)}`,
      );
    });
  }

  if (expect.bbox != null) {
    const actual = bboxOf(features);
    assert.ok(actual, `${name}: expected a bbox but output is empty`);
    actual.forEach((v, i) => {
      assert.ok(
        Math.abs(v - expect.bbox![i]) <= tol,
        `${name}: bbox ${JSON.stringify(actual)} != ${JSON.stringify(expect.bbox)} (tol ${tol})`,
      );
    });
  }
}

// --- the test -------------------------------------------------------------

function makeLayer(id: string, geojson: FeatureCollection): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson,
  };
}

const cases = loadCases();

describe("vector golden fixtures (client engine)", () => {
  for (const testCase of cases) {
    const tool = getVectorTool(testCase.tool);

    // reproject's client run defers to the Python engine (requiresSidecar), so
    // the client engine produces nothing — that tool is asserted by the Python
    // harness only.
    const clientDefers = tool?.requiresSidecar === true;

    it(testCase.name, { skip: clientDefers }, async () => {
      assert.ok(tool, `${testCase.name}: unknown tool ${testCase.tool}`);
      const layers: GeoLibreLayer[] = [];
      if (testCase.input) layers.push(makeLayer("input", testCase.input));
      if (testCase.overlay) layers.push(makeLayer("overlay", testCase.overlay));

      const parameters: Record<string, unknown> = {
        layer: "input",
        ...(testCase.overlay ? { overlay: "overlay" } : {}),
        ...(testCase.parameters ?? {}),
      };

      const output = await runAlgorithmCapture(tool, parameters, {
        layers,
        log: () => {},
      });

      const expect = testCase.expect ?? {};
      if (expect.error) {
        // The client engine logs an error and adds no result layer rather than
        // throwing, so a null capture is the rejection signal.
        assert.equal(output, null, `${testCase.name}: expected no result layer`);
        return;
      }

      assert.ok(output, `${testCase.name}: tool produced no result layer`);
      assertMatch(testCase.name, output, expect);
    });
  }
});
