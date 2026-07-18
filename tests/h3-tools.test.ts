import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  H3_AVG_AREA_KM2,
  H3_HARD_CAP,
  bboxAreaKm2,
  bboxToWktPolygon,
  binPointsTool,
  buildBinSql,
  buildGridFromSourceSql,
  buildGridFromWktSql,
  createH3GridTool,
  estimateCellCount,
  getH3Tool,
  rowsToFeatureCollection,
  suggestResolution,
} from "../packages/processing/src/h3-tools";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { DuckDbCapability, ProcessingContext } from "../packages/processing/src/types";

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

  it("handles an antimeridian-crossing bbox without inflating the area", () => {
    // west=170, east=-170 is a 20deg span across the antimeridian, not 340deg.
    const wrapped = bboxAreaKm2([170, 0, -170, 1]);
    const equivalent = bboxAreaKm2([0, 0, 20, 1]);
    assert.ok(Math.abs(wrapped - equivalent) < 1, `${wrapped} vs ${equivalent}`);
  });

  it("fails safe (Infinity) for an out-of-range resolution so the cap trips", () => {
    const area = bboxAreaKm2([0, 0, 1, 1]);
    assert.equal(estimateCellCount(area, 16), Number.POSITIVE_INFINITY);
    assert.equal(estimateCellCount(area, -1), Number.POSITIVE_INFINITY);
    assert.ok(estimateCellCount(area, 16) > H3_HARD_CAP);
  });

  it("exposes a hard cap constant", () => {
    assert.equal(typeof H3_HARD_CAP, "number");
    assert.ok(H3_HARD_CAP > 10_000);
  });
});

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
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
                [0, 0],
              ],
            ],
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

/** Capability stub that records queries/releases and returns one canned hex row. */
function mockDuckDb(): DuckDbCapability & {
  queries: string[];
  released: number[];
} {
  const queries: string[] = [];
  const released: number[] = [];
  return {
    queries,
    released,
    ensureExtensions: async () => {},
    registerGeoJson: async () => ({
      sql: "ST_Read('mock.geojson')",
      release: async () => {
        released.push(1);
      },
    }),
    query: async (sql: string) => {
      queries.push(sql);
      return [
        {
          h3: "8928308280fffff",
          count: 1,
          geojson: '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}',
        },
      ];
    },
  };
}

function baseCtx(
  layers: GeoLibreLayer[],
  parameters: Record<string, unknown>,
): {
  ctx: ProcessingContext;
  logs: string[];
  added: string[];
  duckdb: ReturnType<typeof mockDuckDb>;
} {
  const logs: string[] = [];
  const added: string[] = [];
  const duckdb = mockDuckDb();
  const ctx: ProcessingContext = {
    layers,
    parameters,
    log: (m) => logs.push(m),
    addResultLayer: (name) => added.push(name),
    duckdb,
    viewportBounds: () => [0, 0, 1, 1],
  };
  return { ctx, logs, added, duckdb };
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

  it("rejects an antimeridian-crossing viewport", async () => {
    const { ctx, added, logs } = baseCtx([], {
      source: "viewport",
      resolution: 4,
    });
    ctx.viewportBounds = () => [170, 0, -170, 1]; // west >= east
    await createH3GridTool.run(ctx);
    assert.equal(added.length, 0);
    assert.ok(logs.some((l) => /antimeridian/i.test(l)));
  });

  it("creates a grid from a manual bounding box without a layer", async () => {
    const { ctx, added } = baseCtx([], {
      source: "bbox",
      west: 0,
      south: 0,
      east: 1,
      north: 1,
      resolution: 5,
    });
    await createH3GridTool.run(ctx);
    assert.equal(added.length, 1);
    assert.match(added[0], /res 5/);
  });

  it("rejects a degenerate manual bounding box", async () => {
    const { ctx, added, logs } = baseCtx([], {
      source: "bbox",
      west: 2,
      south: 0,
      east: 1,
      north: 1,
      resolution: 5,
    });
    await createH3GridTool.run(ctx);
    assert.equal(added.length, 0);
    assert.ok(logs.some((l) => /west < east/i.test(l)));
  });

  it("rejects a manual bounding box with missing values", async () => {
    const { ctx, added, logs } = baseCtx([], {
      source: "bbox",
      west: 0,
      south: 0,
      east: 1,
      resolution: 5,
    });
    await createH3GridTool.run(ctx);
    assert.equal(added.length, 0);
    assert.ok(logs.some((l) => /numeric/i.test(l)));
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

  it("polyfills a selected polygon layer and releases the registered source", async () => {
    const { ctx, added, duckdb } = baseCtx([polygonLayer()], {
      source: "polyfill",
      layer: "poly",
      resolution: 6,
    });
    await createH3GridTool.run(ctx);
    assert.equal(added.length, 1);
    // The registered temp GeoJSON source must be released after the run.
    assert.equal(duckdb.released.length, 1);
  });

  it("rejects polyfill of a non-polygon layer", async () => {
    const { ctx, added, logs } = baseCtx([pointLayer()], {
      source: "polyfill",
      layer: "pts",
      resolution: 6,
    });
    await createH3GridTool.run(ctx);
    assert.equal(added.length, 0);
    assert.ok(logs.some((l) => /polygon/i.test(l)));
  });

  it("fills the extent of a non-polygon layer", async () => {
    const { ctx, added } = baseCtx([pointLayer()], {
      source: "extent",
      layer: "pts",
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
    // The registered temp GeoJSON source must be released after the run.
    assert.equal(ok.duckdb.released.length, 1);
  });

  it("rejects an unknown aggregate operation", async () => {
    const { ctx, added, logs } = baseCtx([pointLayer()], {
      layer: "pts",
      aggOp: "median",
      resolution: 7,
    });
    await binPointsTool.run(ctx);
    assert.equal(added.length, 0);
    assert.ok(logs.some((l) => /unknown aggregate/i.test(l)));
  });

  it("logs a soft message and adds no layer when zero cells are produced", async () => {
    const logs: string[] = [];
    const added: string[] = [];
    const ctx: ProcessingContext = {
      layers: [],
      parameters: { source: "viewport", resolution: 5 },
      log: (m) => logs.push(m),
      addResultLayer: (name) => added.push(name),
      viewportBounds: () => [0, 0, 1, 1],
      duckdb: {
        ensureExtensions: async () => {},
        registerGeoJson: async () => ({
          sql: "ST_Read('mock.geojson')",
          release: async () => {},
        }),
        query: async () => [], // no cells
      },
    };
    await createH3GridTool.run(ctx);
    assert.equal(added.length, 0);
    assert.ok(logs.some((l) => /no h3 cells/i.test(l)));
  });
});

describe("h3 SQL + geometry builders", () => {
  it("builds a closed POLYGON WKT from a bbox", () => {
    assert.equal(bboxToWktPolygon([0, 1, 2, 3]), "POLYGON((0 1, 2 1, 2 3, 0 3, 0 1))");
  });

  it("builds grid SQL from a WKT literal, escaping single quotes", () => {
    // Include a single quote in the input so the test actually exercises the
    // doubling done by sqlStr (a malformed escape would break this assertion).
    const sql = buildGridFromWktSql("POLYGON((0 0, 1 0, 1 1, 0 0))'x", 7);
    assert.match(sql, /h3_polygon_wkt_to_cells\('POLYGON\(\(0 0, 1 0, 1 1, 0 0\)\)''x', 7\)/);
    assert.match(sql, /h3_h3_to_string\(cell\) AS h3/);
    assert.match(
      sql,
      /ST_AsGeoJSON\(ST_GeomFromText\(h3_cell_to_boundary_wkt\(cell\)\)\) AS geojson/,
    );
  });

  it("builds polyfill grid SQL that unions only polygon geometry and guards NULL", () => {
    const sql = buildGridFromSourceSql("ST_Read('a.geojson')", 8);
    assert.match(sql, /ST_Union_Agg\(geom\)/);
    // Only polygonal geometry is unioned (a mixed layer would otherwise produce
    // a GEOMETRYCOLLECTION that h3_polygon_wkt_to_cells rejects).
    assert.match(
      sql,
      /WHERE geom IS NOT NULL AND ST_GeometryType\(geom\) IN \('POLYGON', 'MULTIPOLYGON'\)/,
    );
    // A NULL union result (no polygons) is filtered before reaching the h3 fn.
    assert.match(sql, /h3_polygon_wkt_to_cells\(wkt, 8\)/);
    assert.match(sql, /FROM merged WHERE wkt IS NOT NULL/);
  });

  it("builds bin SQL for count (no field), binning POINT and MULTIPOINT by centroid", () => {
    const sql = buildBinSql("ST_Read('p.geojson')", 9, "count");
    assert.match(sql, /h3_latlng_to_cell\(ST_Y\(pt\), ST_X\(pt\), 9\)/);
    assert.match(sql, /ST_Centroid\(geom\) AS pt/);
    assert.match(sql, /count\(\*\) AS count/);
    assert.doesNotMatch(sql, /AS value/);
    assert.match(sql, /ST_GeometryType\(geom\) IN \('POINT', 'MULTIPOINT'\)/);
  });

  it("builds bin SQL for an aggregate, mapping mean->avg and quoting the field", () => {
    const sql = buildBinSql("ST_Read('p.geojson')", 9, "mean", "pop");
    assert.match(sql, /avg\(CAST\("pop" AS DOUBLE\)\) AS value/);
    assert.match(sql, /count, value,/);
    // The field must be in the SELECT list, not appended after the WHERE clause.
    assert.match(sql, /SELECT ST_Centroid\(geom\) AS pt, "pop" FROM/);
    assert.doesNotMatch(sql, /MULTIPOINT'\), "pop"/);
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
