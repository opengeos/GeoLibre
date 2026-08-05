import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  H3_AVG_AREA_KM2,
  H3_HARD_CAP,
  bboxAreaKm2,
  bboxToWktPolygon,
  buildBinSql,
  buildGridFromBboxSql,
  buildGridFromSourceSql,
  buildGridFromWktSql,
  estimateCellCount,
  getH3Tool,
  normalizeLonLatBbox,
  rowsToFeatureCollection,
  suggestResolution,
} from "../packages/processing/src/h3-tools";
import { getVectorTool, resolveVectorRerun } from "../packages/processing/src/vector-tools";

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

describe("h3 tools registry", () => {
  it("no longer registers grid/bin tools under getH3Tool (moved to DGGS)", () => {
    assert.equal(getH3Tool("h3-bin-points"), undefined);
    assert.equal(getH3Tool("h3-grid"), undefined);
    assert.equal(getH3Tool("missing"), undefined);
  });
});

describe("resolveVectorRerun H3 aliases", () => {
  it("maps old H3 tool ids onto DGGS tools with dggsType h3", () => {
    const grid = resolveVectorRerun("h3-grid", { resolution: 5, source: "viewport" });
    assert.equal(grid.toolId, "dggs-grid");
    assert.equal(grid.parameters.dggsType, "h3");
    assert.equal(grid.parameters.resolution, 5);
    assert.ok(getVectorTool(grid.toolId));

    const bin = resolveVectorRerun("h3-bin-points", { aggOp: "count" });
    assert.equal(bin.toolId, "dggs-bin");
    assert.equal(bin.parameters.dggsType, "h3");
    assert.ok(getVectorTool(bin.toolId));

    // Existing dggsType is preserved; unknown ids pass through.
    const kept = resolveVectorRerun("h3-grid", { dggsType: "s2" });
    assert.equal(kept.parameters.dggsType, "s2");
    const passthrough = resolveVectorRerun("buffer", { distance: 1 });
    assert.equal(passthrough.toolId, "buffer");
    assert.deepEqual(passthrough.parameters, { distance: 1 });
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
    assert.match(
      sql,
      /h3_polygon_wkt_to_cells_experimental\('POLYGON\(\(0 0, 1 0, 1 1, 0 0\)\)''x', 7, 'overlap'\)/,
    );
    assert.match(sql, /h3_h3_to_string\(cell\) AS h3/);
    assert.match(
      sql,
      /ST_AsGeoJSON\(ST_GeomFromText\(h3_cell_to_boundary_wkt\(cell\)\)\) AS geojson/,
    );
  });

  it("normalizes bboxes wider than 180° of longitude to ±180", () => {
    assert.deepEqual(normalizeLonLatBbox([-200, -60, 200, 60]), [-180, -60, 180, 60]);
    assert.deepEqual(normalizeLonLatBbox([-100, -40, 100, 40]), [-180, -40, 180, 40]);
    assert.deepEqual(normalizeLonLatBbox([10, 20, 30, 40]), [10, 20, 30, 40]);
    assert.deepEqual(normalizeLonLatBbox([-190, -10, -10, 10]), [-180, -10, 180, 10]);
  });

  it("splits a full-world bbox into hemispheres for H3 polyfill", () => {
    const narrow = buildGridFromBboxSql([0, 0, 1, 1], 5);
    assert.match(narrow, /h3_polygon_wkt_to_cells_experimental/);
    assert.doesNotMatch(narrow, /UNION ALL/);

    const world = buildGridFromBboxSql([-180, -60, 180, 60], 2);
    assert.match(world, /UNION ALL/);
    assert.match(world, /SELECT DISTINCT cell/);
    assert.match(world, /POLYGON\(\(-180 -60, 0 -60, 0 60, -180 60, -180 -60\)\)/);
    assert.match(world, /POLYGON\(\(0 -60, 180 -60, 180 60, 0 60, 0 -60\)\)/);
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
    assert.match(sql, /WHERE wkt IS NOT NULL/);
    assert.match(sql, /h3_polygon_wkt_to_cells_experimental\(wkt, 8, 'overlap'\)/);
    assert.doesNotMatch(sql, /h3_compact_cells/);
  });

  it("optionally compacts H3 grid cells after polyfill", () => {
    const sql = buildGridFromBboxSql([0, 0, 1, 1], 5, true);
    assert.match(sql, /h3_compact_cells\(cells\)/);
    assert.match(sql, /h3_polygon_wkt_to_cells_experimental/);
  });

  it("builds bin SQL for count and for a named aggregate", () => {
    const countSql = buildBinSql("ST_Read('p.geojson')", 5, "count");
    assert.match(countSql, /h3_latlng_to_cell/);
    assert.match(countSql, /count\(\*\) AS count/);
    assert.doesNotMatch(countSql, / AS value/);

    const sumSql = buildBinSql("ST_Read('p.geojson')", 5, "sum", 'pop"x');
    // Field name is double-quote escaped.
    assert.match(sumSql, /sum\(CAST\("pop""x" AS DOUBLE\)\) AS value/);
  });

  it("converts result rows to a FeatureCollection with h3 props", () => {
    const fc = rowsToFeatureCollection([
      {
        h3: "abc",
        count: 3,
        value: 1.5,
        geojson: '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}',
      },
      { h3: "skip", geojson: 12 },
    ]);
    assert.equal(fc.features.length, 1);
    assert.equal(fc.features[0].properties?.h3, "abc");
    assert.equal(fc.features[0].properties?.count, 3);
    assert.equal(fc.features[0].properties?.value, 1.5);
  });

  it("unwraps antimeridian rings by default and can leave them wrapped", () => {
    const raw = [
      [170, 0],
      [-170, 0],
      [-170, 1],
      [170, 1],
      [170, 0],
    ];
    const fixed = rowsToFeatureCollection([
      { h3: "x", geojson: JSON.stringify({ type: "Polygon", coordinates: [raw] }) },
    ]);
    assert.deepEqual((fixed.features[0].geometry as { coordinates: number[][][] }).coordinates[0], [
      [170, 0],
      [190, 0],
      [190, 1],
      [170, 1],
      [170, 0],
    ]);

    const left = rowsToFeatureCollection(
      [{ h3: "x", geojson: JSON.stringify({ type: "Polygon", coordinates: [raw] }) }],
      false,
    );
    assert.deepEqual(
      (left.features[0].geometry as { coordinates: number[][][] }).coordinates[0],
      raw,
    );
  });
});
