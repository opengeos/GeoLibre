import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import {
  detectGeometryColumn,
  geometryExpr,
  geometryGeoJsonSql,
  isGeometryColumnType,
  stripAutoFidColumn,
} from "../apps/geolibre-desktop/src/lib/duckdb-geometry";

function describeRow(name: string, type: string) {
  return { column_name: name, column_type: type };
}

describe("isGeometryColumnType", () => {
  it("matches plain and CRS-annotated GEOMETRY types", () => {
    assert.equal(isGeometryColumnType("GEOMETRY"), true);
    assert.equal(isGeometryColumnType("geometry"), true);
    assert.equal(isGeometryColumnType("GEOMETRY('EPSG:4326')"), true);
  });

  it("rejects non-geometry types", () => {
    assert.equal(isGeometryColumnType("BLOB"), false);
    assert.equal(isGeometryColumnType("VARCHAR"), false);
    assert.equal(isGeometryColumnType(undefined), false);
  });
});

describe("detectGeometryColumn", () => {
  it("prefers a native GEOMETRY column", () => {
    const detected = detectGeometryColumn([
      describeRow("id", "BIGINT"),
      describeRow("geom", "GEOMETRY"),
    ]);
    assert.deepEqual(detected, { column: "geom", isWkb: false });
  });

  it("prefers a native GEOMETRY column even when a WKB name exists", () => {
    const detected = detectGeometryColumn([
      describeRow("geometry_wkb", "BLOB"),
      describeRow("the_geom", "GEOMETRY('EPSG:4326')"),
    ]);
    assert.deepEqual(detected, { column: "the_geom", isWkb: false });
  });

  it("falls back to a geometry_wkb blob column (issue #336)", () => {
    const detected = detectGeometryColumn([
      describeRow("id", "VARCHAR"),
      describeRow("lat", "DOUBLE"),
      describeRow("lon", "DOUBLE"),
      describeRow("geometry_wkb", "BLOB"),
    ]);
    assert.deepEqual(detected, { column: "geometry_wkb", isWkb: true });
  });

  it("matches well-known WKB names case-insensitively", () => {
    for (const name of [
      "geometry",
      "geom",
      "wkb_geometry",
      "GEOMETRY_WKB",
      "Geom_WKB",
      "WKB",
    ]) {
      const detected = detectGeometryColumn([
        describeRow("id", "BIGINT"),
        describeRow(name, "BLOB"),
      ]);
      assert.deepEqual(detected, { column: name, isWkb: true });
    }
  });

  it("matches VARBINARY/BINARY WKB columns", () => {
    assert.deepEqual(
      detectGeometryColumn([describeRow("geom", "VARBINARY")]),
      { column: "geom", isWkb: true },
    );
    assert.deepEqual(detectGeometryColumn([describeRow("wkb", "BINARY")]), {
      column: "wkb",
      isWkb: true,
    });
  });

  it("falls back to a base64 string WKB column (issue #984)", () => {
    const detected = detectGeometryColumn([
      describeRow("id", "BIGINT"),
      describeRow("geometry", "VARCHAR"),
    ]);
    assert.deepEqual(detected, {
      column: "geometry",
      isWkb: true,
      isBase64Wkb: true,
      requiresBase64WkbValidation: true,
      base64WkbCandidates: ["geometry"],
    });
  });

  it("ranks multiple base64 string WKB candidates by well-known name", () => {
    const detected = detectGeometryColumn([
      describeRow("wkb", "VARCHAR"),
      describeRow("geometry", "VARCHAR"),
    ]);
    assert.deepEqual(detected, {
      column: "geometry",
      isWkb: true,
      isBase64Wkb: true,
      requiresBase64WkbValidation: true,
      base64WkbCandidates: ["geometry", "wkb"],
    });
  });

  it("ignores a WKB-named column that is neither binary nor string", () => {
    const detected = detectGeometryColumn([
      describeRow("id", "BIGINT"),
      describeRow("geometry", "INTEGER"),
    ]);
    assert.equal(detected, null);
  });

  it("returns null when no geometry column is present", () => {
    const detected = detectGeometryColumn([
      describeRow("id", "BIGINT"),
      describeRow("name", "VARCHAR"),
    ]);
    assert.equal(detected, null);
  });
});

describe("geometryExpr", () => {
  it("references a native geometry column directly", () => {
    assert.equal(geometryExpr({ column: "geom", isWkb: false }), '"geom"');
  });

  it("decodes a WKB blob column with ST_GeomFromWKB", () => {
    assert.equal(
      geometryExpr({ column: "geometry_wkb", isWkb: true }),
      'ST_GeomFromWKB("geometry_wkb")',
    );
  });

  it("decodes a base64 WKB string with from_base64", () => {
    assert.equal(
      geometryExpr({ column: "geometry", isWkb: true, isBase64Wkb: true }),
      'ST_GeomFromWKB(from_base64("geometry"))',
    );
  });

  it("rejects unvalidated base64 WKB candidates", () => {
    assert.throws(
      () =>
        geometryExpr({
          column: "geometry",
          isWkb: true,
          isBase64Wkb: true,
          requiresBase64WkbValidation: true,
        }),
      /must be validated/,
    );
  });

  it("quotes identifiers safely", () => {
    assert.equal(
      geometryExpr({ column: 'odd"name', isWkb: false }),
      '"odd""name"',
    );
  });
});

describe("geometryGeoJsonSql", () => {
  it("emits ST_AsGeoJSON without a CRS transform when unknown", () => {
    assert.equal(geometryGeoJsonSql('"geom"', null), 'ST_AsGeoJSON("geom")');
  });

  it("wraps the expression in ST_Transform when a source CRS is given", () => {
    assert.equal(
      geometryGeoJsonSql('ST_GeomFromWKB("geometry_wkb")', "EPSG:3857"),
      `ST_AsGeoJSON(ST_Transform(ST_GeomFromWKB("geometry_wkb"), 'EPSG:3857', 'EPSG:4326', true))`,
    );
  });
});

describe("stripAutoFidColumn", () => {
  function collection(
    properties: Record<string, unknown> | null,
  ): FeatureCollection {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties,
          geometry: { type: "Point", coordinates: [0, 0] },
        },
      ],
    };
  }

  it("removes the GDAL-synthesised OGC_FID property (issue #499)", () => {
    const out = stripAutoFidColumn(collection({ OGC_FID: 5, name: "a" }));
    assert.deepEqual(out.features[0].properties, { name: "a" });
    assert.equal(out.features[0].geometry?.type, "Point");
  });

  it("does not mutate the input collection", () => {
    const input = collection({ OGC_FID: 5, name: "a" });
    stripAutoFidColumn(input);
    assert.deepEqual(input.features[0].properties, { OGC_FID: 5, name: "a" });
  });

  it("returns the same object when no feature carries OGC_FID", () => {
    const input = collection({ name: "a" });
    assert.equal(stripAutoFidColumn(input), input);
  });

  it("tolerates features with null properties", () => {
    const out = stripAutoFidColumn(collection(null));
    assert.equal(out.features[0].properties, null);
  });

  it("returns the same object for an empty feature collection", () => {
    const input: FeatureCollection = { type: "FeatureCollection", features: [] };
    assert.equal(stripAutoFidColumn(input), input);
  });

  it("yields empty-object properties when OGC_FID is the only property", () => {
    const out = stripAutoFidColumn(collection({ OGC_FID: 7 }));
    assert.deepEqual(out.features[0].properties, {});
  });

  it("strips OGC_FID from every feature that has it", () => {
    const input: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { OGC_FID: 1, name: "a" },
          geometry: { type: "Point", coordinates: [0, 0] },
        },
        {
          type: "Feature",
          properties: { name: "b" },
          geometry: { type: "Point", coordinates: [1, 1] },
        },
        {
          type: "Feature",
          properties: { OGC_FID: 3, name: "c" },
          geometry: { type: "Point", coordinates: [2, 2] },
        },
      ],
    };
    const inputClone = JSON.parse(JSON.stringify(input));
    const out = stripAutoFidColumn(input);
    assert.deepEqual(
      out.features.map((f) => f.properties),
      [{ name: "a" }, { name: "b" }, { name: "c" }],
    );
    // The original multi-feature collection is left unmodified.
    assert.deepEqual(input, inputClone);
  });
});
