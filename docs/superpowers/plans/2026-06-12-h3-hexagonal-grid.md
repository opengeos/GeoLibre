# H3 Hexagonal Grid Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two client-side processing tools — "Create H3 Grid" and "Bin Points to H3" — backed by the DuckDB-WASM `h3` + `spatial` extensions, surfaced in the existing Vector Tools dialog and Processing menu.

**Architecture:** The `@geolibre/processing` package stays framework-agnostic. It gains a new `h3-tools.ts` with two `ProcessingAlgorithm`s whose `run()` calls an injected `ctx.duckdb` capability (a small interface) plus a `ctx.viewportBounds()` accessor. The desktop app implements that capability over the existing `duckdb-vector-loader.ts` and wires both into the context built in `VectorToolsDialog`. All SQL/area/resolution logic lives in pure, unit-tested helpers; the DuckDB-coupled code (capability + extension loader) is thin and verified by build + manual test.

**Tech Stack:** TypeScript, DuckDB-WASM (`@duckdb/duckdb-wasm` 1.33.1-dev45 → DuckDB v1.5.1), DuckDB `h3` community extension, `@turf/bbox`, React, `node --test` (tsx).

**Verified feasibility (2026-06-12):** `INSTALL h3 FROM community; LOAD h3;` is valid for DuckDB v1.5.1 on all WASM platforms. Functions used: `h3_polygon_wkt_to_cells(wkt, res)`, `h3_cell_to_boundary_wkt(cell)`, `h3_h3_to_string(cell)`, `h3_latlng_to_cell(lat, lng, res)`.

---

## File Structure

- Create `packages/processing/src/h3-tools.ts` — pure helpers (area, resolution, WKT/SQL builders, row→FeatureCollection) + the two `ProcessingAlgorithm` objects + `H3_TOOLS`/`getH3Tool`.
- Modify `packages/processing/src/types.ts` — add `DuckDbCapability`, `DuckDbGeoJsonSource`, and `duckdb?` / `viewportBounds?` fields on `ProcessingContext`.
- Modify `packages/processing/src/vector-tools.ts` — append the two H3 tools to `VECTOR_TOOLS` so the dialog lists them.
- Modify `packages/processing/src/index.ts` — export the H3 tools.
- Modify `apps/geolibre-desktop/src/lib/duckdb-vector-loader.ts` — add `ensureH3Extension`.
- Create `apps/geolibre-desktop/src/lib/duckdb-processing.ts` — `createDuckDbCapability()` implementing `DuckDbCapability`.
- Modify `apps/geolibre-desktop/src/components/processing/VectorToolsDialog.tsx` — inject `duckdb` + `viewportBounds` into the client-engine context.
- Modify `apps/geolibre-desktop/src/components/layout/TopToolbar.tsx` — add menu entries.
- Create `tests/h3-tools.test.ts` — unit tests for helpers and tool `run()` against a mock capability.

---

## Task 1: H3 area constants + resolution math (pure)

**Files:**
- Create: `packages/processing/src/h3-tools.ts`
- Test: `tests/h3-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/h3-tools.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  H3_AVG_AREA_KM2,
  H3_HARD_CAP,
  bboxAreaKm2,
  estimateCellCount,
  suggestResolution,
} from "../packages/processing/src/h3-tools";

describe("h3 resolution math", () => {
  it("exposes 16 average-area entries (res 0..15), strictly decreasing", () => {
    assert.equal(H3_AVG_AREA_KM2.length, 16);
    for (let r = 1; r < 16; r += 1) {
      assert.ok(H3_AVG_AREA_KM2[r] < H3_AVG_AREA_KM2[r - 1]);
    }
  });

  it("computes an approximate bbox area in km^2", () => {
    // 1 deg x 1 deg near the equator is roughly 12,300 km^2.
    const area = bboxAreaKm2([0, 0, 1, 1]);
    assert.ok(area > 11_000 && area < 13_500, `got ${area}`);
  });

  it("suggests the finest resolution that stays under the target cell count", () => {
    // A large area should pick a coarse resolution.
    const big = bboxAreaKm2([-10, -10, 10, 10]);
    const rBig = suggestResolution(big);
    // A tiny area should pick the finest allowed (capped at 12).
    const tiny = bboxAreaKm2([0, 0, 0.001, 0.001]);
    const rTiny = suggestResolution(tiny);
    assert.ok(rBig < rTiny);
    assert.ok(rTiny <= 12);
    assert.ok(rBig >= 0);
    // Whatever it picks, the estimate must not exceed the 10k target.
    assert.ok(estimateCellCount(big, rBig) <= 10_000);
  });

  it("clamps an out-of-range resolution request via estimateCellCount monotonicity", () => {
    const area = bboxAreaKm2([0, 0, 1, 1]);
    assert.ok(estimateCellCount(area, 10) > estimateCellCount(area, 9));
  });

  it("exposes a hard cap constant", () => {
    assert.equal(typeof H3_HARD_CAP, "number");
    assert.ok(H3_HARD_CAP > 10_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/h3-tools.test.ts`
Expected: FAIL — cannot find module `../packages/processing/src/h3-tools`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/processing/src/h3-tools.ts`:

```ts
/** Average area (km^2) of an H3 cell at each resolution 0..15 (official values). */
export const H3_AVG_AREA_KM2: number[] = [
  4_357_449.416078381, 609_788.441794133, 86_801.780398997, 12_393.434655088,
  1_770.347654491, 252.903858182, 36.129062164, 5.16129336, 0.737327598,
  0.105332513, 0.015047502, 0.002149643, 0.000307092, 0.00004387, 0.000006267,
  0.000000895,
];

/** Soft target used when auto-suggesting a resolution. */
export const H3_TARGET_CELLS = 10_000;
/** Finest resolution the auto-suggester will pick. */
export const H3_MAX_SUGGESTED_RES = 12;
/** Hard ceiling: a grid larger than this aborts rather than running away. */
export const H3_HARD_CAP = 200_000;

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQ = 111.32;

/** Rough planar area (km^2) of a [west, south, east, north] bbox. */
export function bboxAreaKm2(bbox: [number, number, number, number]): number {
  const [w, s, e, n] = bbox;
  const midLat = (s + n) / 2;
  const kmPerDegLon = KM_PER_DEG_LON_EQ * Math.cos((midLat * Math.PI) / 180);
  const width = Math.abs(e - w) * kmPerDegLon;
  const height = Math.abs(n - s) * KM_PER_DEG_LAT;
  return Math.max(width * height, 0);
}

/** Estimated number of H3 cells covering `areaKm2` at `res`. */
export function estimateCellCount(areaKm2: number, res: number): number {
  return areaKm2 / H3_AVG_AREA_KM2[res];
}

/** Finest resolution whose estimated cell count stays <= the target. */
export function suggestResolution(
  areaKm2: number,
  targetCells = H3_TARGET_CELLS,
  maxRes = H3_MAX_SUGGESTED_RES,
): number {
  for (let res = maxRes; res >= 0; res -= 1) {
    if (estimateCellCount(areaKm2, res) <= targetCells) return res;
  }
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/h3-tools.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/processing/src/h3-tools.ts tests/h3-tools.test.ts
git commit -m "feat(h3): area + resolution helpers for H3 grid (#245)"
```

---

## Task 2: WKT + SQL builders + row→FeatureCollection (pure)

**Files:**
- Modify: `packages/processing/src/h3-tools.ts`
- Test: `tests/h3-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/h3-tools.test.ts`:

```ts
import {
  bboxToWktPolygon,
  buildBinSql,
  buildGridFromSourceSql,
  buildGridFromWktSql,
  rowsToFeatureCollection,
} from "../packages/processing/src/h3-tools";

describe("h3 SQL + geometry builders", () => {
  it("builds a closed POLYGON WKT from a bbox", () => {
    assert.equal(
      bboxToWktPolygon([0, 1, 2, 3]),
      "POLYGON((0 1, 2 1, 2 3, 0 3, 0 1))",
    );
  });

  it("builds grid SQL from a WKT literal, escaping quotes", () => {
    const sql = buildGridFromWktSql("POLYGON((0 0, 1 0, 1 1, 0 0))", 7);
    assert.match(sql, /h3_polygon_wkt_to_cells\('POLYGON\(\(0 0, 1 0, 1 1, 0 0\)\)', 7\)/);
    assert.match(sql, /h3_h3_to_string\(cell\) AS h3/);
    assert.match(sql, /ST_AsGeoJSON\(ST_GeomFromText\(h3_cell_to_boundary_wkt\(cell\)\)\) AS geojson/);
  });

  it("builds polyfill grid SQL that unions the source geometry", () => {
    const sql = buildGridFromSourceSql("ST_Read('a.geojson')", 8);
    assert.match(sql, /ST_Union_Agg\(geom\)/);
    assert.match(sql, /ST_Read\('a\.geojson'\)/);
    assert.match(sql, /h3_polygon_wkt_to_cells\(\(SELECT wkt FROM merged\), 8\)/);
  });

  it("builds bin SQL for count (no field)", () => {
    const sql = buildBinSql("ST_Read('p.geojson')", 9, "count");
    assert.match(sql, /h3_latlng_to_cell\(ST_Y\(geom\), ST_X\(geom\), 9\)/);
    assert.match(sql, /count\(\*\) AS count/);
    assert.doesNotMatch(sql, /AS value/);
    assert.match(sql, /ST_GeometryType\(geom\) = 'POINT'/);
  });

  it("builds bin SQL for an aggregate, mapping mean->avg and quoting the field", () => {
    const sql = buildBinSql("ST_Read('p.geojson')", 9, "mean", "pop");
    assert.match(sql, /avg\(CAST\("pop" AS DOUBLE\)\) AS value/);
    assert.match(sql, /count, value,/);
  });

  it("converts result rows to a FeatureCollection with h3/count/value props", () => {
    const fc = rowsToFeatureCollection([
      {
        h3: "8928308280fffff",
        count: 3n,
        value: 12.5,
        geojson: '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}',
      },
      { h3: "x", count: 1, geojson: null },
    ]);
    assert.equal(fc.features.length, 1);
    assert.equal(fc.features[0].properties?.h3, "8928308280fffff");
    assert.equal(fc.features[0].properties?.count, 3);
    assert.equal(fc.features[0].properties?.value, 12.5);
    assert.equal(fc.features[0].geometry?.type, "Polygon");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/h3-tools.test.ts`
Expected: FAIL — the builder exports do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/processing/src/h3-tools.ts`:

```ts
import type { FeatureCollection, Geometry } from "geojson";

function sqlStr(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** A closed POLYGON WKT ring for a [west, south, east, north] bbox. */
export function bboxToWktPolygon(bbox: [number, number, number, number]): string {
  const [w, s, e, n] = bbox;
  return `POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))`;
}

const GRID_SELECT =
  "SELECT h3_h3_to_string(cell) AS h3, " +
  "ST_AsGeoJSON(ST_GeomFromText(h3_cell_to_boundary_wkt(cell))) AS geojson FROM cells";

/** Grid SQL from a polygon WKT literal (used for bbox / viewport sources). */
export function buildGridFromWktSql(wkt: string, res: number): string {
  return (
    `WITH cells AS (SELECT unnest(h3_polygon_wkt_to_cells(${sqlStr(wkt)}, ${res})) AS cell) ` +
    GRID_SELECT
  );
}

/**
 * Grid SQL that unions all geometry from a registered source into one
 * (multi)polygon and fills it (used for the polyfill source). `sourceSql` is a
 * FROM-able expression whose geometry column is `geom` (DuckDB `ST_Read`).
 */
export function buildGridFromSourceSql(sourceSql: string, res: number): string {
  return (
    `WITH merged AS (SELECT ST_AsText(ST_Union_Agg(geom)) AS wkt FROM ${sourceSql}), ` +
    `cells AS (SELECT unnest(h3_polygon_wkt_to_cells((SELECT wkt FROM merged), ${res})) AS cell) ` +
    GRID_SELECT
  );
}

const AGG_FN: Record<string, string> = {
  sum: "sum",
  mean: "avg",
  min: "min",
  max: "max",
};

/**
 * Aggregate point geometry from `sourceSql` (geometry column `geom`) into H3
 * cells. `op` is one of count/sum/mean/min/max; a field is required for all but
 * count.
 */
export function buildBinSql(
  sourceSql: string,
  res: number,
  op: string,
  field?: string,
): string {
  const fn = AGG_FN[op];
  const aggSelect =
    fn && field ? `, ${fn}(CAST(${sqlIdent(field)} AS DOUBLE)) AS value` : "";
  const aggOut = fn && field ? ", value" : "";
  return (
    `WITH pts AS (SELECT * FROM ${sourceSql} ` +
    `WHERE geom IS NOT NULL AND ST_GeometryType(geom) = 'POINT'), ` +
    `binned AS (SELECT h3_latlng_to_cell(ST_Y(geom), ST_X(geom), ${res}) AS cell, ` +
    `count(*) AS count${aggSelect} FROM pts GROUP BY cell) ` +
    `SELECT h3_h3_to_string(cell) AS h3, count${aggOut}, ` +
    `ST_AsGeoJSON(ST_GeomFromText(h3_cell_to_boundary_wkt(cell))) AS geojson FROM binned`
  );
}

/** Build a FeatureCollection from rows carrying `h3`, optional `count`/`value`, and `geojson`. */
export function rowsToFeatureCollection(
  rows: Record<string, unknown>[],
): FeatureCollection {
  const features = [];
  for (const row of rows) {
    const raw = row.geojson;
    if (typeof raw !== "string") continue;
    const geometry = JSON.parse(raw) as Geometry;
    const properties: Record<string, unknown> = { h3: row.h3 };
    if (row.count !== undefined && row.count !== null) {
      properties.count = Number(row.count);
    }
    if (row.value !== undefined && row.value !== null) {
      properties.value = Number(row.value);
    }
    features.push({ type: "Feature" as const, geometry, properties });
  }
  return { type: "FeatureCollection", features };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/h3-tools.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/processing/src/h3-tools.ts tests/h3-tools.test.ts
git commit -m "feat(h3): WKT/SQL builders and row mapping for H3 tools (#245)"
```

---

## Task 3: ProcessingContext capability types + the two H3 tools

**Files:**
- Modify: `packages/processing/src/types.ts`
- Modify: `packages/processing/src/h3-tools.ts`
- Modify: `packages/processing/src/vector-tools.ts:_VECTOR_TOOLS_array_`
- Modify: `packages/processing/src/index.ts`
- Test: `tests/h3-tools.test.ts`

- [ ] **Step 1: Add capability types to `types.ts`**

In `packages/processing/src/types.ts`, replace the `ProcessingContext` interface (lines 55-62) with:

```ts
/** A GeoJSON FeatureCollection registered as a queryable DuckDB source. */
export interface DuckDbGeoJsonSource {
  /** FROM-able SQL expression; its geometry column is named `geom`. */
  sql: string;
  /** Drop the registered source. Safe to call once. */
  release: () => Promise<void>;
}

/** Minimal DuckDB-WASM surface a processing tool needs. Injected by the host. */
export interface DuckDbCapability {
  /** Install + load the named extensions (e.g. `["spatial", "h3"]`). */
  ensureExtensions: (names: string[]) => Promise<void>;
  /** Register a FeatureCollection and return a SQL source handle. */
  registerGeoJson: (geojson: FeatureCollection) => Promise<DuckDbGeoJsonSource>;
  /** Run a query and return plain rows. */
  query: (sql: string) => Promise<Record<string, unknown>[]>;
}

export interface ProcessingContext {
  layers: GeoLibreLayer[];
  parameters: Record<string, unknown>;
  log: (message: string) => void;
  fitBounds?: (bounds: [number, number, number, number]) => void;
  /** Add an algorithm result back to the map as a new GeoJSON layer. */
  addResultLayer?: (name: string, geojson: FeatureCollection) => void;
  /** DuckDB-WASM capability, when the host provides it (browser/desktop). */
  duckdb?: DuckDbCapability;
  /** Current map viewport as [west, south, east, north], when available. */
  viewportBounds?: () => [number, number, number, number] | null;
}
```

- [ ] **Step 2: Write the failing test**

Append to `tests/h3-tools.test.ts`:

```ts
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type {
  DuckDbCapability,
  ProcessingContext,
} from "../packages/processing/src/types";
import {
  binPointsTool,
  createH3GridTool,
  getH3Tool,
} from "../packages/processing/src/h3-tools";

function polygonLayer(): GeoLibreLayer {
  return {
    id: "poly",
    name: "Poly",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
          },
        },
      ],
    },
  };
}

function pointLayer(): GeoLibreLayer {
  return {
    ...polygonLayer(),
    id: "pts",
    name: "Pts",
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { pop: 5 },
          geometry: { type: "Point", coordinates: [0.5, 0.5] },
        },
      ],
    },
  };
}

/** Capability stub that records queries and returns one canned hex row. */
function mockDuckDb(): DuckDbCapability & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    ensureExtensions: async () => {},
    registerGeoJson: async () => ({
      sql: "ST_Read('mock.geojson')",
      release: async () => {},
    }),
    query: async (sql: string) => {
      queries.push(sql);
      return [
        {
          h3: "8928308280fffff",
          count: 1,
          geojson:
            '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}',
        },
      ];
    },
  };
}

function baseCtx(
  layers: GeoLibreLayer[],
  parameters: Record<string, unknown>,
): { ctx: ProcessingContext; logs: string[]; added: string[] } {
  const logs: string[] = [];
  const added: string[] = [];
  const ctx: ProcessingContext = {
    layers,
    parameters,
    log: (m) => logs.push(m),
    addResultLayer: (name) => added.push(name),
    duckdb: mockDuckDb(),
    viewportBounds: () => [0, 0, 1, 1],
  };
  return { ctx, logs, added };
}

describe("h3 tools", () => {
  it("registers both tools under getH3Tool", () => {
    assert.equal(getH3Tool("h3-grid"), createH3GridTool);
    assert.equal(getH3Tool("h3-bin-points"), binPointsTool);
    assert.equal(getH3Tool("missing"), undefined);
  });

  it("throws a clear error when duckdb is unavailable", async () => {
    await assert.rejects(
      () =>
        Promise.resolve(
          createH3GridTool.run({
            layers: [],
            parameters: { source: "viewport" },
            log: () => {},
          }),
        ),
      /requires DuckDB/,
    );
  });

  it("creates a grid from the map viewport", async () => {
    const { ctx, added } = baseCtx([], { source: "viewport", resolution: 5 });
    await createH3GridTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0], /res 5/);
  });

  it("auto-suggests a resolution when none is given", async () => {
    const { ctx, logs } = baseCtx([], { source: "viewport" });
    await createH3GridTool.run(ctx);
    assert.ok(logs.some((l) => /suggested resolution/i.test(l)));
  });

  it("aborts when the requested resolution exceeds the hard cap", async () => {
    const { ctx, added, logs } = baseCtx([polygonLayer()], {
      source: "extent",
      layer: "poly",
      resolution: 15,
    });
    await createH3GridTool.run(ctx);
    assert.equal(added.length, 0);
    assert.ok(logs.some((l) => /cap/i.test(l)));
  });

  it("polyfills a selected polygon layer", async () => {
    const { ctx, added } = baseCtx([polygonLayer()], {
      source: "polyfill",
      layer: "poly",
      resolution: 6,
    });
    await createH3GridTool.run(ctx);
    assert.equal(added.length, 1);
  });

  it("bins points and requires a field for non-count aggregates", async () => {
    const missing = baseCtx([pointLayer()], {
      layer: "pts",
      aggOp: "sum",
      resolution: 7,
    });
    await binPointsTool.run(missing.ctx);
    assert.equal(missing.added.length, 0);
    assert.ok(missing.logs.some((l) => /field/i.test(l)));

    const ok = baseCtx([pointLayer()], {
      layer: "pts",
      aggOp: "count",
      resolution: 7,
    });
    await binPointsTool.run(ok.ctx);
    assert.equal(ok.added.length, 1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --import tsx --test tests/h3-tools.test.ts`
Expected: FAIL — `createH3GridTool` / `binPointsTool` / `getH3Tool` not exported.

- [ ] **Step 4: Implement the tools**

Append to `packages/processing/src/h3-tools.ts`:

```ts
import bbox from "@turf/bbox";
import type { GeoLibreLayer } from "@geolibre/core";
import type {
  DuckDbCapability,
  DuckDbGeoJsonSource,
  ProcessingAlgorithm,
  ProcessingContext,
} from "./types";

const NO_DUCKDB =
  "This tool requires DuckDB-WASM, which is unavailable in this environment.";

function requireDuckDb(ctx: ProcessingContext): DuckDbCapability {
  if (!ctx.duckdb) throw new Error(NO_DUCKDB);
  return ctx.duckdb;
}

function getLayer(
  ctx: ProcessingContext,
  paramId = "layer",
): GeoLibreLayer | undefined {
  const id = ctx.parameters[paramId] as string | undefined;
  return ctx.layers.find((l) => l.id === id);
}

/** Parse the `resolution` param, or auto-suggest from area. Logs + returns null on bad input. */
function resolveResolution(
  ctx: ProcessingContext,
  areaKm2: number,
): number | null {
  const raw = ctx.parameters.resolution;
  if (raw === undefined || raw === null || raw === "") {
    const suggested = suggestResolution(areaKm2);
    ctx.log(`Using suggested resolution ${suggested}`);
    return suggested;
  }
  const res = typeof raw === "string" ? Number(raw) : (raw as number);
  if (!Number.isInteger(res) || res < 0 || res > 15) {
    ctx.log("Error: resolution must be an integer from 0 to 15");
    return null;
  }
  return res;
}

export const createH3GridTool: ProcessingAlgorithm = {
  id: "h3-grid",
  name: "Create H3 grid",
  description:
    "Fill an area with H3 hexagons (DuckDB h3 extension). Source: a layer's geometry, a layer's extent, or the current map view.",
  group: "H3",
  parameters: [
    {
      id: "source",
      label: "Area source",
      type: "select",
      default: "polyfill",
      options: [
        { value: "polyfill", label: "Layer geometry (polyfill)" },
        { value: "extent", label: "Layer extent (bbox)" },
        { value: "viewport", label: "Map viewport" },
      ],
    },
    {
      id: "layer",
      label: "Input layer",
      type: "layer",
      required: true,
      geometryFilter: ["polygon"],
      visibleWhen: { param: "source", in: ["polyfill", "extent"] },
    },
    {
      id: "resolution",
      label: "Resolution (0-15)",
      type: "number",
      min: 0,
      max: 15,
      step: 1,
      description: "Leave blank to auto-pick from the area.",
    },
  ],
  run: async (ctx) => {
    const duckdb = requireDuckDb(ctx);
    const source = (ctx.parameters.source as string) || "polyfill";

    let areaKm2: number;
    let wkt: string | null = null;
    if (source === "viewport") {
      const bounds = ctx.viewportBounds?.();
      if (!bounds) {
        ctx.log("Error: map viewport is unavailable");
        return;
      }
      areaKm2 = bboxAreaKm2(bounds);
      wkt = bboxToWktPolygon(bounds);
    } else {
      const layer = getLayer(ctx, "layer");
      if (!layer?.geojson?.features?.length) {
        ctx.log('Error: parameter "layer" has no GeoJSON features');
        return;
      }
      const bb = bbox(layer.geojson) as [number, number, number, number];
      areaKm2 = bboxAreaKm2(bb);
      if (source === "extent") wkt = bboxToWktPolygon(bb);
    }

    const res = resolveResolution(ctx, areaKm2);
    if (res === null) return;

    const estimate = estimateCellCount(areaKm2, res);
    if (estimate > H3_HARD_CAP) {
      ctx.log(
        `Error: resolution ${res} would generate about ${Math.round(
          estimate,
        ).toLocaleString()} cells (cap ${H3_HARD_CAP.toLocaleString()}). Choose a coarser resolution.`,
      );
      return;
    }

    await duckdb.ensureExtensions(["spatial", "h3"]);
    let registered: DuckDbGeoJsonSource | null = null;
    try {
      let sql: string;
      if (wkt) {
        sql = buildGridFromWktSql(wkt, res);
      } else {
        const layer = getLayer(ctx, "layer");
        registered = await duckdb.registerGeoJson(layer!.geojson!);
        sql = buildGridFromSourceSql(registered.sql, res);
      }
      const rows = await duckdb.query(sql);
      const fc = rowsToFeatureCollection(rows);
      ctx.log(`Created ${fc.features.length} H3 cell(s) at resolution ${res}`);
      ctx.addResultLayer?.(`H3 grid (res ${res})`, fc);
    } finally {
      await registered?.release();
    }
  },
};

export const binPointsTool: ProcessingAlgorithm = {
  id: "h3-bin-points",
  name: "Bin points to H3",
  description:
    "Aggregate a point layer into H3 cells (count, or sum/mean/min/max of a numeric field).",
  group: "H3",
  parameters: [
    {
      id: "layer",
      label: "Input point layer",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "aggOp",
      label: "Aggregate",
      type: "select",
      default: "count",
      options: [
        { value: "count", label: "Count" },
        { value: "sum", label: "Sum" },
        { value: "mean", label: "Mean" },
        { value: "min", label: "Min" },
        { value: "max", label: "Max" },
      ],
    },
    {
      id: "field",
      label: "Field",
      type: "field",
      fieldSource: "layer",
      required: true,
      visibleWhen: { param: "aggOp", notIn: ["count"] },
      description: "Numeric field to aggregate.",
    },
    {
      id: "resolution",
      label: "Resolution (0-15)",
      type: "number",
      min: 0,
      max: 15,
      step: 1,
      description: "Leave blank to auto-pick from the area.",
    },
  ],
  run: async (ctx) => {
    const duckdb = requireDuckDb(ctx);
    const layer = getLayer(ctx, "layer");
    if (!layer?.geojson?.features?.length) {
      ctx.log('Error: parameter "layer" has no GeoJSON features');
      return;
    }
    const op = (ctx.parameters.aggOp as string) || "count";
    const field = ctx.parameters.field as string | undefined;
    if (op !== "count" && !field) {
      ctx.log(`Error: select a numeric field to ${op}`);
      return;
    }

    const bb = bbox(layer.geojson) as [number, number, number, number];
    const res = resolveResolution(ctx, bboxAreaKm2(bb));
    if (res === null) return;

    await duckdb.ensureExtensions(["spatial", "h3"]);
    const registered = await duckdb.registerGeoJson(layer.geojson);
    try {
      const sql = buildBinSql(registered.sql, res, op, field);
      const rows = await duckdb.query(sql);
      const fc = rowsToFeatureCollection(rows);
      ctx.log(
        `Binned points into ${fc.features.length} H3 cell(s) at resolution ${res}`,
      );
      ctx.addResultLayer?.(`H3 bins (res ${res})`, fc);
    } finally {
      await registered.release();
    }
  },
};

export const H3_TOOLS: ProcessingAlgorithm[] = [createH3GridTool, binPointsTool];

export function getH3Tool(id: string): ProcessingAlgorithm | undefined {
  return H3_TOOLS.find((tool) => tool.id === id);
}
```

- [ ] **Step 5: Surface the tools in the registry and exports**

In `packages/processing/src/vector-tools.ts`, add an import near the top (after line 23):

```ts
import { createH3GridTool, binPointsTool } from "./h3-tools";
```

Then append the two tools to the `VECTOR_TOOLS` array (after `selectByLocationTool,`):

```ts
  selectByLocationTool,
  createH3GridTool,
  binPointsTool,
];
```

In `packages/processing/src/index.ts`, after the `VECTOR_TOOLS`/`getVectorTool` export line, add:

```ts
export {
  H3_TOOLS,
  getH3Tool,
  createH3GridTool,
  binPointsTool,
} from "./h3-tools";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --import tsx --test tests/h3-tools.test.ts`
Expected: PASS (all tests in the file).

Also run the existing processing test to confirm no regression:
Run: `node --import tsx --test tests/processing.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/processing/src/types.ts packages/processing/src/h3-tools.ts packages/processing/src/vector-tools.ts packages/processing/src/index.ts tests/h3-tools.test.ts
git commit -m "feat(h3): add Create H3 grid and Bin points to H3 tools (#245)"
```

---

## Task 4: `ensureH3Extension` in the DuckDB loader

**Files:**
- Modify: `apps/geolibre-desktop/src/lib/duckdb-vector-loader.ts:45-102`

(No node unit test: this module imports `*.wasm?url`, which only resolves under Vite. It is exercised by the build + manual verification. Its SQL is a two-line constant.)

- [ ] **Step 1: Add the loader**

In `apps/geolibre-desktop/src/lib/duckdb-vector-loader.ts`, immediately after the `ensureSpatialExtension` function (after line 102), add:

```ts
let h3ExtensionPromise: Promise<void> | null = null;

/**
 * Install and load the DuckDB `h3` community extension once per database
 * instance. Mirrors {@link ensureSpatialExtension}: memoized as a promise so
 * concurrent callers share one INSTALL/LOAD, and cleared on failure so a later
 * call can retry. `h3` is published for the bundled DuckDB version (v1.5.1) on
 * all WASM platforms.
 */
export async function ensureH3Extension(
  connection: duckdb.AsyncDuckDBConnection,
): Promise<void> {
  h3ExtensionPromise ??= (async () => {
    await connection.query("INSTALL h3 FROM community");
    await connection.query("LOAD h3");
  })();
  try {
    await h3ExtensionPromise;
  } catch (error) {
    h3ExtensionPromise = null;
    throw error;
  }
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run test:worker` is unrelated; instead verify the package compiles as part of Task 7's build. For a quick local check now:
Run: `npx tsc -p apps/geolibre-desktop/tsconfig.json --noEmit` (if a standalone tsconfig exists) — otherwise defer verification to the full build in Task 8.
Expected: no new type errors referencing `ensureH3Extension`.

- [ ] **Step 3: Commit**

```bash
git add apps/geolibre-desktop/src/lib/duckdb-vector-loader.ts
git commit -m "feat(h3): load the DuckDB h3 community extension in WASM (#245)"
```

---

## Task 5: `createDuckDbCapability` in the desktop app

**Files:**
- Create: `apps/geolibre-desktop/src/lib/duckdb-processing.ts`

(No node unit test: depends on the WASM loader. Its SQL-building logic lives in the already-tested `h3-tools` helpers; this file only wires DuckDB primitives.)

- [ ] **Step 1: Create the capability**

Create `apps/geolibre-desktop/src/lib/duckdb-processing.ts`:

```ts
import type {
  DuckDbCapability,
  DuckDbGeoJsonSource,
} from "@geolibre/processing";
import type { FeatureCollection } from "geojson";
import {
  ensureH3Extension,
  ensureSpatialExtension,
  getDatabase,
  quoteSqlString,
  rowsFromResult,
} from "./duckdb-vector-loader";

let counter = 0;

/**
 * A {@link DuckDbCapability} backed by the shared DuckDB-WASM instance. Each
 * call opens a short-lived connection; loaded extensions persist at the
 * database level, so `ensureExtensions` and `query` may use separate
 * connections safely.
 */
export function createDuckDbCapability(): DuckDbCapability {
  return {
    async ensureExtensions(names: string[]): Promise<void> {
      const db = await getDatabase();
      const connection = await db.connect();
      try {
        if (names.includes("spatial")) await ensureSpatialExtension(connection);
        if (names.includes("h3")) await ensureH3Extension(connection);
      } finally {
        await connection.close();
      }
    },

    async registerGeoJson(
      geojson: FeatureCollection,
    ): Promise<DuckDbGeoJsonSource> {
      const db = await getDatabase();
      counter += 1;
      const name = `__geolibre_h3_${Date.now()}_${counter}.geojson`;
      await db.registerFileText(name, JSON.stringify(geojson));
      return {
        sql: `ST_Read(${quoteSqlString(name)})`,
        async release(): Promise<void> {
          try {
            await db.dropFiles([name]);
          } catch {
            // File may already be gone; releasing twice is harmless.
          }
        },
      };
    },

    async query(sql: string): Promise<Record<string, unknown>[]> {
      const db = await getDatabase();
      const connection = await db.connect();
      try {
        return rowsFromResult(await connection.query(sql));
      } finally {
        await connection.close();
      }
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/geolibre-desktop/src/lib/duckdb-processing.ts
git commit -m "feat(h3): DuckDB processing capability for the H3 tools (#245)"
```

---

## Task 6: Wire the capability into `VectorToolsDialog`

**Files:**
- Modify: `apps/geolibre-desktop/src/components/processing/VectorToolsDialog.tsx`

- [ ] **Step 1: Import the capability and a memo hook**

In `VectorToolsDialog.tsx`, add to the existing import from `../../lib/...` (a new line near line 18):

```ts
import { createDuckDbCapability } from "../../lib/duckdb-processing";
```

`useMemo` is already imported (line 37).

- [ ] **Step 2: Create the capability once**

Inside the component, after the `tool` memo (after line 86), add:

```ts
  // One DuckDB capability per dialog instance; the H3 tools use it via ctx.
  const duckdb = useMemo(() => createDuckDbCapability(), []);
```

- [ ] **Step 3: Inject `duckdb` + `viewportBounds` into the client-engine context**

In `handleRun`, replace the client-engine `ctx` object (lines 307-313) with:

```ts
        const ctx: ProcessingContext = {
          layers,
          parameters: params,
          log: appendLog,
          fitBounds: (bounds) => mapControllerRef.current?.fitBounds(bounds),
          addResultLayer,
          duckdb,
          viewportBounds: () => {
            const map = mapControllerRef.current?.getMap();
            if (!map) return null;
            const b = map.getBounds();
            return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
          },
        };
        await tool.run(ctx);
```

- [ ] **Step 4: Add `duckdb` to the `handleRun` dependency array**

In the `useCallback` deps for `handleRun` (lines 321-331), add `duckdb`:

```ts
  }, [
    tool,
    params,
    engine,
    layers,
    appendLog,
    addResultLayer,
    runRemoteEngine,
    mapControllerRef,
    isParamVisible,
    duckdb,
  ]);
```

- [ ] **Step 5: Commit**

```bash
git add apps/geolibre-desktop/src/components/processing/VectorToolsDialog.tsx
git commit -m "feat(h3): provide DuckDB + viewport context to vector tools (#245)"
```

---

## Task 7: Add H3 entries to the Processing menu

**Files:**
- Modify: `apps/geolibre-desktop/src/components/layout/TopToolbar.tsx:1206-1216`

- [ ] **Step 1: Add an H3 group to the Vector submenu**

In `TopToolbar.tsx`, after the "Select by location" item and before the closing `</DropdownMenuSubContent>` (after line 1215), add:

```tsx
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                H3
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => setVectorToolOpen("h3-grid")}>
                Create H3 grid
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setVectorToolOpen("h3-bin-points")}
              >
                Bin points to H3
              </DropdownMenuItem>
```

- [ ] **Step 2: Commit**

```bash
git add apps/geolibre-desktop/src/components/layout/TopToolbar.tsx
git commit -m "feat(h3): add H3 tools to the Processing menu (#245)"
```

---

## Task 8: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Run the frontend test suite**

Run: `npm run test:frontend`
Expected: PASS, including `tests/h3-tools.test.ts` and `tests/processing.test.ts`.

- [ ] **Step 2: Type-check / build the app**

Run: `npm run build`
Expected: build succeeds with no type errors (this is the real type-check gate per CLAUDE.md).

- [ ] **Step 3: Pre-commit on changed files**

Run: `pre-commit run --files packages/processing/src/h3-tools.ts packages/processing/src/types.ts packages/processing/src/vector-tools.ts packages/processing/src/index.ts apps/geolibre-desktop/src/lib/duckdb-vector-loader.ts apps/geolibre-desktop/src/lib/duckdb-processing.ts apps/geolibre-desktop/src/components/processing/VectorToolsDialog.tsx apps/geolibre-desktop/src/components/layout/TopToolbar.tsx tests/h3-tools.test.ts`
Expected: all hooks pass (fix and re-run if any reformat).

- [ ] **Step 4: Manual verification (desktop dev)**

Run: `npm run tauri:dev`
Then:
1. Load a polygon layer. Processing → Vector → Create H3 grid. Try each source (Layer geometry, Layer extent, Map viewport), leave resolution blank once (confirm "Using suggested resolution N" log) and set it once. Confirm a hexagon layer is added and the map fits to it.
2. Load a point layer. Processing → Vector → Bin points to H3. Run with Count, then with Sum/Mean on a numeric field. Confirm cells carry `count`/`value` (check the attribute table or feature popup).
3. Confirm the first run logs the one-time `h3` extension fetch and that a deliberately too-fine resolution on a large area aborts with the cap message.

- [ ] **Step 5: Final commit (if pre-commit reformatted anything)**

```bash
git add -A
git commit -m "chore(h3): formatting from pre-commit (#245)"
```

---

## Self-Review

**Spec coverage:**
- Three area sources (polyfill / extent / viewport) → Task 3 `createH3GridTool` `source` param + `run` branches. ✓
- User-picked resolution 0-15 → `resolution` param + `resolveResolution`. ✓
- Auto-suggested resolution → `suggestResolution` (Task 1) wired via blank-resolution path (Task 3). ✓
- Bin/count points with sum/mean/min/max → `binPointsTool` + `buildBinSql` (Tasks 2-3). ✓
- DuckDB capability injected into `ProcessingContext` (Approach A) → Task 3 types + Task 5 impl + Task 6 wiring. ✓
- `INSTALL h3 FROM community; LOAD h3;` memoized → Task 4. ✓
- Safety cap + clear errors → `H3_HARD_CAP` check + `NO_DUCKDB`/validation messages (Tasks 1, 3). ✓
- Surfaced in UI (dialog auto-lists via `VECTOR_TOOLS`; menu entries) → Tasks 3, 7. ✓
- Testing of pure builders + mocked-capability `run` → Tasks 1-3 tests. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full content. ✓

**Type consistency:** `DuckDbCapability` (`ensureExtensions`, `registerGeoJson`, `query`) and `DuckDbGeoJsonSource` (`sql`, `release`) match across types.ts (Task 3), the mock (Task 3 test), and the impl (Task 5). Tool ids `h3-grid` / `h3-bin-points` match between `h3-tools.ts`, `getH3Tool` tests, and the menu `setVectorToolOpen` calls. Geometry column name `geom` (from `ST_Read`) is assumed consistently in `buildGridFromSourceSql` / `buildBinSql` and produced by `registerGeoJson`'s `ST_Read(...)`. ✓

**Known limitation (documented in spec):** `h3_cell_to_boundary_wkt` can emit antimeridian-spanning boundaries for cells crossing ±180°; rendered as-is in v1. Bin tool handles single-`POINT` geometries (MultiPoint excluded by the `ST_GeometryType = 'POINT'` filter).
