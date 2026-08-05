import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_DGGRID_GRID_TYPE,
  DGGRID_AVG_AREA_KM2,
  DGGRID_GRID_PARAMS_SQL,
  DGGRID_GRID_TYPES,
  DGGRID_HARD_CAP,
  DGGRID_MAX_TOOL_RES,
  buildDggridBinSql,
  buildDggridGridFromSourceSql,
  buildDggridGridFromWktSql,
  dggridRowsToFeatureCollection,
  estimateDggridCellCount,
  maxResolutionForDggrid,
  resolveDggridGridType,
  suggestDggridResolution,
} from "../packages/processing/src/dggrid-tools";
import { bboxAreaKm2 } from "../packages/processing/src/h3-tools";

const ISEA4H_PARAMS = DGGRID_GRID_PARAMS_SQL.ISEA4H;
const ISEA3H_PARAMS = DGGRID_GRID_PARAMS_SQL.ISEA3H;

describe("dggrid resolution math", () => {
  it("exposes average-area entries through the finest DGGRID type (ISEA3H 35)", () => {
    assert.equal(DGGRID_AVG_AREA_KM2.length, DGGRID_MAX_TOOL_RES + 1);
    assert.equal(DGGRID_MAX_TOOL_RES, 35);
    for (let r = 1; r < DGGRID_AVG_AREA_KM2.length; r += 1) {
      assert.ok(DGGRID_AVG_AREA_KM2[r]! < DGGRID_AVG_AREA_KM2[r - 1]!);
    }
  });

  it("suggests a coarser resolution for larger areas", () => {
    const big = bboxAreaKm2([-10, -10, 10, 10]);
    const tiny = bboxAreaKm2([0, 0, 0.001, 0.001]);
    const rBig = suggestDggridResolution(big);
    const rTiny = suggestDggridResolution(tiny);
    assert.ok(rBig < rTiny);
    assert.ok(rTiny <= 12);
    assert.ok(estimateDggridCellCount(big, rBig) <= 10_000);
  });

  it("estimates fewer cells for aperture-3 than aperture-4 at the same res", () => {
    const area = bboxAreaKm2([0, 0, 1, 1]);
    // 3^res grows slower than 4^res, so ISEA3H cells are larger → lower count.
    assert.ok(
      estimateDggridCellCount(area, 5, "ISEA3H") < estimateDggridCellCount(area, 5, "ISEA4H"),
    );
  });

  it("fails safe (Infinity) for an out-of-range resolution", () => {
    const area = bboxAreaKm2([0, 0, 1, 1]);
    assert.equal(estimateDggridCellCount(area, 30, "ISEA4H"), Number.POSITIVE_INFINITY);
    assert.equal(estimateDggridCellCount(area, 36, "ISEA3H"), Number.POSITIVE_INFINITY);
    assert.ok(estimateDggridCellCount(area, 30, "ISEA4H") > DGGRID_HARD_CAP);
  });
});

describe("dggrid grid type presets", () => {
  it("lists all DGGRID named types with matching dggs_params SQL", () => {
    assert.deepEqual(
      [...DGGRID_GRID_TYPES],
      [
        "SUPERFUND",
        "PLANETRISK",
        "ISEA3H",
        "ISEA4H",
        "ISEA4T",
        "ISEA4D",
        "ISEA43H",
        "ISEA7H",
        "IGEO7",
        "FULLER3H",
        "FULLER4H",
        "FULLER4T",
        "FULLER4D",
        "FULLER43H",
        "FULLER7H",
      ],
    );
    assert.equal(DEFAULT_DGGRID_GRID_TYPE, "ISEA4H");
    assert.match(DGGRID_GRID_PARAMS_SQL.ISEA4H, /'ISEA', 4, 'HEXAGON'/);
    assert.match(DGGRID_GRID_PARAMS_SQL.ISEA3H, /'ISEA', 3, 'HEXAGON'/);
    assert.match(DGGRID_GRID_PARAMS_SQL.ISEA4T, /'ISEA', 4, 'TRIANGLE'/);
    assert.match(DGGRID_GRID_PARAMS_SQL.ISEA4D, /'ISEA', 4, 'DIAMOND'/);
    assert.match(DGGRID_GRID_PARAMS_SQL.ISEA7H, /'ISEA', 7, 'HEXAGON'/);
    assert.match(DGGRID_GRID_PARAMS_SQL.IGEO7, /'ISEA', 7, 'HEXAGON'/);
    assert.match(DGGRID_GRID_PARAMS_SQL.FULLER4H, /'FULLER', 4, 'HEXAGON'/);
    assert.match(DGGRID_GRID_PARAMS_SQL.FULLER3H, /'FULLER', 3, 'HEXAGON'/);
    assert.match(DGGRID_GRID_PARAMS_SQL.FULLER4T, /'FULLER', 4, 'TRIANGLE'/);
    assert.match(DGGRID_GRID_PARAMS_SQL.FULLER4D, /'FULLER', 4, 'DIAMOND'/);
    assert.match(DGGRID_GRID_PARAMS_SQL.FULLER7H, /'FULLER', 7, 'HEXAGON'/);
    assert.match(
      DGGRID_GRID_PARAMS_SQL.SUPERFUND,
      /'FULLER', 3, 'HEXAGON'.*true, '44333333333333333'/,
    );
    assert.match(
      DGGRID_GRID_PARAMS_SQL.PLANETRISK,
      /'ISEA', 7, 'HEXAGON'.*true, '43334777777777777777777'/,
    );
  });

  it("exposes per-type max resolutions from the DGGRID named-type table", () => {
    assert.equal(maxResolutionForDggrid("SUPERFUND"), 17);
    assert.equal(maxResolutionForDggrid("PLANETRISK"), 22);
    assert.equal(maxResolutionForDggrid("ISEA3H"), 35);
    assert.equal(maxResolutionForDggrid("ISEA4H"), 29);
    assert.equal(maxResolutionForDggrid("ISEA4T"), 29);
    assert.equal(maxResolutionForDggrid("ISEA4D"), 29);
    assert.equal(maxResolutionForDggrid("ISEA43H"), 18);
    assert.equal(maxResolutionForDggrid("ISEA7H"), 21);
    assert.equal(maxResolutionForDggrid("IGEO7"), 20);
    assert.equal(maxResolutionForDggrid("FULLER3H"), 35);
    assert.equal(maxResolutionForDggrid("FULLER4H"), 30);
    assert.equal(maxResolutionForDggrid("FULLER4T"), 29);
    assert.equal(maxResolutionForDggrid("FULLER4D"), 30);
    assert.equal(maxResolutionForDggrid("FULLER43H"), 18);
    assert.equal(maxResolutionForDggrid("FULLER7H"), 21);
  });

  it("resolves unknown values to ISEA4H", () => {
    assert.equal(resolveDggridGridType(undefined), "ISEA4H");
    assert.equal(resolveDggridGridType("nope"), "ISEA4H");
    assert.equal(resolveDggridGridType("ISEA3H"), "ISEA3H");
    assert.equal(resolveDggridGridType("PLANETRISK"), "PLANETRISK");
  });
});

describe("dggrid SQL builders", () => {
  it("builds sample-cover grid SQL from a WKT literal with default ISEA4H params", () => {
    const sql = buildDggridGridFromWktSql("POLYGON((0 0, 1 0, 1 1, 0 0))'x", 5);
    assert.match(sql, new RegExp(`geo_to_seqnum\\(pt, 5, ${escapeRegex(ISEA4H_PARAMS)}\\)`));
    assert.match(sql, new RegExp(`seqnum_to_boundary\\(cell, 5, ${escapeRegex(ISEA4H_PARAMS)}\\)`));
    assert.match(sql, new RegExp(`dggs_cls_km\\(5, ${escapeRegex(ISEA4H_PARAMS)}\\)`));
    assert.match(sql, /POLYGON\(\(0 0, 1 0, 1 1, 0 0\)\)''x/);
    assert.match(sql, /CAST\(cell AS VARCHAR\) AS dggrid/);
    assert.match(sql, /CAST\(ST_AsGeoJSON\(seqnum_to_boundary/);
    assert.doesNotMatch(sql, /LEAST\(/);
  });

  it("passes ISEA3H dggs_params into grid and bin SQL", () => {
    const grid = buildDggridGridFromWktSql("POLYGON((0 0, 1 0, 1 1, 0 0))", 4, "ISEA3H");
    assert.match(grid, new RegExp(escapeRegex(ISEA3H_PARAMS)));
    assert.doesNotMatch(grid, /TRIANGLE/);

    const bin = buildDggridBinSql("ST_Read('p.geojson')", 5, "count", undefined, "FULLER4H");
    assert.match(bin, /dggs_params\('FULLER', 4, 'HEXAGON'/);
  });

  it("builds polyfill grid SQL that unions polygons then sample-covers", () => {
    const sql = buildDggridGridFromSourceSql("ST_Read('x.geojson')", 6);
    assert.match(sql, /ST_Union_Agg\(geom\)/);
    assert.match(sql, /'POLYGON', 'MULTIPOLYGON'/);
    assert.match(sql, new RegExp(`geo_to_seqnum\\(pt, 6, ${escapeRegex(ISEA4H_PARAMS)}\\)`));
  });

  it("builds bin SQL with geo_to_seqnum and optional aggregates", () => {
    const countSql = buildDggridBinSql("ST_Read('p.geojson')", 5, "count");
    assert.match(countSql, new RegExp(`geo_to_seqnum\\(pt, 5, ${escapeRegex(ISEA4H_PARAMS)}\\)`));
    assert.match(
      countSql,
      new RegExp(`seqnum_to_boundary\\(cell, 5, ${escapeRegex(ISEA4H_PARAMS)}\\)`),
    );
    assert.doesNotMatch(countSql, / AS value/);

    const sumSql = buildDggridBinSql("ST_Read('p.geojson')", 5, "sum", 'pop"x');
    assert.match(sumSql, /sum\(CAST\("pop""x" AS DOUBLE\)\) AS value/);
  });

  it("converts result rows to a FeatureCollection with dggrid props", () => {
    const fc = dggridRowsToFeatureCollection([
      {
        dggrid: "2380",
        count: 3,
        geojson: '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}',
      },
      { dggrid: "skip", geojson: 12 },
    ]);
    assert.equal(fc.features.length, 1);
    assert.equal(fc.features[0].properties?.dggrid, "2380");
    assert.equal(fc.features[0].properties?.count, 3);
  });

  it("unwraps antimeridian-crossing cell rings for MapLibre by default", () => {
    // duck_dggs-style ring with longitudes clamped to [-180, 180].
    const fc = dggridRowsToFeatureCollection([
      {
        dggrid: "dateline",
        geojson: JSON.stringify({
          type: "Polygon",
          coordinates: [
            [
              [170, 0],
              [-170, 0],
              [-170, 1],
              [170, 1],
              [170, 0],
            ],
          ],
        }),
      },
    ]);
    const ring = (fc.features[0].geometry as { coordinates: number[][][] }).coordinates[0];
    assert.deepEqual(ring, [
      [170, 0],
      [190, 0],
      [190, 1],
      [170, 1],
      [170, 0],
    ]);
    // Contiguous: no edge jumps more than 180° of longitude.
    for (let i = 1; i < ring.length; i += 1) {
      assert.ok(Math.abs(ring[i]![0]! - ring[i - 1]![0]!) < 180);
    }
  });

  it("leaves wrapped rings alone when fixAntimeridian is false", () => {
    const raw = [
      [170, 0],
      [-170, 0],
      [-170, 1],
      [170, 1],
      [170, 0],
    ];
    const fc = dggridRowsToFeatureCollection(
      [
        {
          dggrid: "dateline",
          geojson: JSON.stringify({ type: "Polygon", coordinates: [raw] }),
        },
      ],
      false,
    );
    assert.deepEqual(
      (fc.features[0].geometry as { coordinates: number[][][] }).coordinates[0],
      raw,
    );
  });
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
