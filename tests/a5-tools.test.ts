import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  A5_AVG_AREA_KM2,
  A5_HARD_CAP,
  A5_MAX_TOOL_RES,
  a5CellsFromLayer,
  a5CellsToFeatureCollection,
  a5RowsToFeatureCollection,
  buildA5BinSql,
  buildA5GridFromBboxSql,
  buildA5GridFromBboxesSql,
  buildA5GridFromSourceSql,
  buildA5GridFromWktSql,
  compactA5Cells,
  estimateA5CellCount,
  estimateA5ExpandCount,
  expandA5Cells,
  migrateA5V0Hex,
  suggestA5Resolution,
} from "../packages/processing/src/a5-tools";
import {
  cellToChildren,
  getRes0Cells,
  getResolution,
  hexToU64,
  lonLatToCell,
  u64ToHex,
} from "a5-js";
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
    // The CTE body must be a query, not a bare unnest(...) expression.
    assert.match(narrow, /WITH cells AS \(SELECT unnest\(a5_uncompact/);

    const split = buildA5GridFromBboxesSql(
      [
        [177, -18, 180, -16],
        [-180, -18, -179, -16],
      ],
      5,
    );
    assert.match(split, /FROM \(SELECT unnest\(.+ AS cell UNION ALL SELECT unnest\(.+ AS cell\)/);

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
        a5: "2606000000000000",
        count: 2,
        value: 4.5,
        geojson: '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}',
      },
      {
        a5: "872f880000000000",
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
    // DuckDB's a5 extension emits v0 IDs; they come out in the v1 index.
    assert.equal(fc.features[0].properties?.a5, "2652000000000000");
    assert.equal(fc.features[0].properties?.count, 2);
    assert.equal(fc.features[0].properties?.value, 4.5);
    assert.equal(fc.features[1].properties?.a5, "872fb80000000000");
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
        a5: "9760000000000000",
        geojson: JSON.stringify({ type: "Polygon", coordinates: [raw] }),
      },
    ]);
    assert.deepEqual(
      (fc.features[0].geometry as { coordinates: number[][][] }).coordinates[0],
      raw,
    );
  });
});

describe("a5 v1 cell IDs", () => {
  // v0 → v1 pairs computed with a5-js 0.10.1 and 1.0.0 for the same point.
  it("migrates the DuckDB extension's v0 IDs to the v1 index", () => {
    assert.equal(migrateA5V0Hex("2606000000000000"), "2652000000000000"); // NYC, res 5
    assert.equal(migrateA5V0Hex("872f880000000000"), "872fb80000000000"); // Tokyo, res 8
    assert.equal(migrateA5V0Hex("9760000000000000"), "9360000000000000"); // Fiji, res 3
    assert.equal(
      migrateA5V0Hex("2606000000000000"),
      u64ToHex(lonLatToCell([-73.98, 40.75] as never, 5)),
    );
  });

  it("compacts a complete sibling set to its parent", () => {
    const parent = lonLatToCell([-73.98, 40.75] as never, 5);
    const children = cellToChildren(parent, 7);
    const out = compactA5Cells(children);
    assert.deepEqual(out, [parent]);
    assert.deepEqual(compactA5Cells([]), []);
  });

  it("expands to a uniform resolution and counts exactly", () => {
    const coarse = lonLatToCell([-73.98, 40.75] as never, 5);
    const fine = lonLatToCell([139.7, 35.7] as never, 6);
    assert.equal(estimateA5ExpandCount([coarse, fine], 7), 16 + 4);
    const out = expandA5Cells([coarse, fine], 7);
    assert.equal(out.length, 20);
    assert.ok(out.every((cell) => getResolution(cell) === 7));
    assert.equal(estimateA5ExpandCount([coarse], 4), 0);
    // A resolution-0 cell splits into 5, then 4 per level.
    const root = getRes0Cells()[0]!;
    assert.equal(estimateA5ExpandCount([root], 0), 1);
    assert.equal(estimateA5ExpandCount([root], 3), 80);
    assert.equal(expandA5Cells([root], 3).length, 80);
    assert.throws(() => expandA5Cells([coarse], 4), /finer than target resolution 4/);
  });

  it("reads v1 IDs from a layer and rejects non-A5 values", () => {
    const fc = a5CellsToFeatureCollection([hexToU64("2652000000000000")]);
    assert.equal(fc.features[0].properties?.a5, "2652000000000000");
    const ring = fc.features[0].geometry.coordinates[0];
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    assert.deepEqual(a5CellsFromLayer(fc), [hexToU64("2652000000000000")]);
    assert.throws(
      () =>
        a5CellsFromLayer({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [0, 0] },
              properties: { a5: "not-a-cell" },
            },
          ],
        }),
      /Feature 1: "not-a-cell" is not an A5 v1 cell ID.*v0 index/,
    );
  });

  it("keeps an antimeridian cell's ring on one world copy", () => {
    const cell = lonLatToCell([179.9, -16.5] as never, 3);
    const ring = a5CellsToFeatureCollection([cell]).features[0].geometry.coordinates[0];
    const lons = ring.map((p) => p[0]);
    assert.ok(Math.max(...lons) - Math.min(...lons) < 180);
  });
});
