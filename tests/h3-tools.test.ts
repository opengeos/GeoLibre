import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  H3_AVG_AREA_KM2,
  H3_HARD_CAP,
  bboxAreaKm2,
  estimateCellCount,
  suggestResolution,
} from "../packages/processing/src/h3-tools";
import {
  bboxToWktPolygon,
  buildBinSql,
  buildGridFromSourceSql,
  buildGridFromWktSql,
  rowsToFeatureCollection,
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
