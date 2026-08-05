import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  A5_AVG_AREA_KM2,
  A5_HARD_CAP,
  A5_MAX_TOOL_RES,
  a5RowsToFeatureCollection,
  buildA5BinSql,
  buildA5GridFromBboxSql,
  buildA5GridFromSourceSql,
  buildA5GridFromWktSql,
  estimateA5CellCount,
  suggestA5Resolution,
} from "../packages/processing/src/a5-tools";
import { bboxAreaKm2 } from "../packages/processing/src/h3-tools";

describe("a5 resolution math", () => {
  it("exposes 31 average-area entries (res 0..30), strictly decreasing", () => {
    assert.equal(A5_AVG_AREA_KM2.length, 31);
    assert.equal(A5_MAX_TOOL_RES, 30);
    for (let r = 1; r < 31; r += 1) {
      assert.ok(A5_AVG_AREA_KM2[r] < A5_AVG_AREA_KM2[r - 1]);
    }
  });

  it("suggests a coarser resolution for larger areas", () => {
    const big = bboxAreaKm2([-10, -10, 10, 10]);
    const tiny = bboxAreaKm2([0, 0, 0.001, 0.001]);
    const rBig = suggestA5Resolution(big);
    const rTiny = suggestA5Resolution(tiny);
    assert.ok(rBig < rTiny);
    assert.ok(rTiny <= 12);
    assert.ok(estimateA5CellCount(big, rBig) <= 10_000);
  });

  it("fails safe (Infinity) for an out-of-range resolution", () => {
    const area = bboxAreaKm2([0, 0, 1, 1]);
    assert.equal(estimateA5CellCount(area, 31), Number.POSITIVE_INFINITY);
    assert.equal(estimateA5CellCount(area, -1), Number.POSITIVE_INFINITY);
    assert.ok(estimateA5CellCount(area, 31) > A5_HARD_CAP);
    // Res 16 is in range for A5 (0–30).
    assert.ok(Number.isFinite(estimateA5CellCount(area, 16)));
  });
});

describe("a5 SQL builders", () => {
  it("builds grid SQL from a WKT literal, escaping single quotes", () => {
    const sql = buildA5GridFromWktSql("POLYGON((0 0, 1 0, 1 1, 0 0))'x", 7);
    assert.match(
      sql,
      /a5_uncompact\(a5_geometry_to_cells\(ST_GeomFromText\('POLYGON\(\(0 0, 1 0, 1 1, 0 0\)\)''x'\), 7\), 7\)/,
    );
    assert.match(sql, /a5_u64_to_hex\(cell\) AS a5/);
    assert.match(sql, /a5_cell_to_geometry\(cell\)/);
  });

  it("enumerates full-longitude A5 bboxes from res0 cells", () => {
    const narrow = buildA5GridFromBboxSql([0, 0, 1, 1], 5);
    assert.doesNotMatch(narrow, /UNION ALL/);
    assert.doesNotMatch(narrow, /a5_get_res0_cells/);

    const world = buildA5GridFromBboxSql([-180, -90, 180, 90], 4);
    assert.match(world, /a5_uncompact\(a5_get_res0_cells\(\), 4\)/);
    assert.doesNotMatch(world, /a5_geometry_to_cells/);
    assert.doesNotMatch(world, /list_extract/);

    const band = buildA5GridFromBboxSql([-180, -60, 180, 60], 2);
    assert.match(band, /a5_get_res0_cells\(\)/);
    assert.match(band, /list_extract\(a5_cell_to_lonlat\(cell\), 2\) BETWEEN -60 AND 60/);

    const wide = buildA5GridFromBboxSql([-100, -10, 20, 10], 3);
    // 120° span → two 60° strips (still under the full-lon res0 path)
    assert.match(wide, /UNION ALL/);
    assert.equal((wide.match(/a5_geometry_to_cells/g) ?? []).length, 2);
  });

  it("builds polyfill grid SQL that unions only polygon geometry", () => {
    const sql = buildA5GridFromSourceSql("ST_Read('x.geojson')", 8);
    assert.match(sql, /ST_Union_Agg\(geom\)/);
    assert.match(sql, /'POLYGON', 'MULTIPOLYGON'/);
    assert.match(sql, /a5_uncompact\(a5_geometry_to_cells\(g, 8\), 8\)/);
    assert.doesNotMatch(sql, /a5_compact\(cells\)/);
  });

  it("optionally compacts A5 grid cells after polyfill", () => {
    const sql = buildA5GridFromBboxSql([0, 0, 1, 1], 5, true);
    assert.match(sql, /a5_compact\(cells\)/);
    assert.match(sql, /a5_uncompact\(a5_geometry_to_cells/);
  });

  it("builds bin SQL with lon/lat cell lookup and optional aggregates", () => {
    const countSql = buildA5BinSql("ST_Read('p.geojson')", 5, "count");
    assert.match(countSql, /a5_lonlat_to_cell\(ST_X\(pt\), ST_Y\(pt\), 5\)/);
    assert.match(countSql, /a5_u64_to_hex\(cell\) AS a5/);
    assert.doesNotMatch(countSql, / AS value/);

    const sumSql = buildA5BinSql("ST_Read('p.geojson')", 5, "sum", 'pop"x');
    assert.match(sumSql, /sum\(CAST\("pop""x" AS DOUBLE\)\) AS value/);
  });

  it("converts result rows to a FeatureCollection with a5 props", () => {
    const fc = a5RowsToFeatureCollection([
      {
        a5: "abc",
        count: 2,
        value: 4.5,
        geojson: '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}',
      },
      {
        a5: "obj",
        geojson: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
      },
      { a5: "skip", geojson: 12 },
    ]);
    assert.equal(fc.features.length, 2);
    assert.equal(fc.features[0].properties?.a5, "abc");
    assert.equal(fc.features[0].properties?.count, 2);
    assert.equal(fc.features[0].properties?.value, 4.5);
    assert.equal(fc.features[1].properties?.a5, "obj");
  });

  it("leaves A5 cell geometry unchanged (native dateline handling)", () => {
    const raw = [
      [170, 0],
      [-170, 0],
      [-170, 1],
      [170, 1],
      [170, 0],
    ];
    const fc = a5RowsToFeatureCollection([
      {
        a5: "x",
        geojson: JSON.stringify({ type: "Polygon", coordinates: [raw] }),
      },
    ]);
    assert.deepEqual(
      (fc.features[0].geometry as { coordinates: number[][][] }).coordinates[0],
      raw,
    );
  });
});
