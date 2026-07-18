import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import {
  detectGeometryColumn,
  geometryExpr,
  geometryGeoJsonSql,
  isGenericUnsupportedWkbError,
  isGeometryColumnType,
  isUnsupportedSurfaceWkbError,
  normalizePropertyValue,
  stripAutoFidColumn,
  wkbRowsToFeatureCollection,
} from "../apps/geolibre-desktop/src/lib/duckdb-geometry";
import { encodeWkb } from "../apps/geolibre-desktop/src/lib/geometry-wkb";

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
    for (const name of ["geometry", "geom", "wkb_geometry", "GEOMETRY_WKB", "Geom_WKB", "WKB"]) {
      const detected = detectGeometryColumn([
        describeRow("id", "BIGINT"),
        describeRow(name, "BLOB"),
      ]);
      assert.deepEqual(detected, { column: name, isWkb: true });
    }
  });

  it("matches VARBINARY/BINARY WKB columns", () => {
    assert.deepEqual(detectGeometryColumn([describeRow("geom", "VARBINARY")]), {
      column: "geom",
      isWkb: true,
    });
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
    assert.equal(geometryExpr({ column: 'odd"name', isWkb: false }), '"odd""name"');
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
  function collection(properties: Record<string, unknown> | null): FeatureCollection {
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

describe("isUnsupportedSurfaceWkbError", () => {
  // The surfaces the raw-WKB fallback can decode must trigger it.
  it("matches TIN / PolyhedralSurface / Triangle by type id", () => {
    for (const id of [1016, 1015, 1017, 16, 2015, 3017]) {
      const error = new Error(
        `Could not parse WKB input: WKB type 'Surface' is not supported! (type id: ${id}, SRID: 0)`,
      );
      assert.equal(isUnsupportedSurfaceWkbError(error), true, `id ${id}`);
    }
  });

  it("matches by surface type name when no id is present", () => {
    for (const name of ["TIN Z", "PolyhedralSurface", "Triangle"]) {
      const error = new Error(`WKB type '${name}' is not supported!`);
      assert.equal(isUnsupportedSurfaceWkbError(error), true, name);
    }
  });

  // Curved geometries share the error template but decodeWkb still cannot decode
  // them, so they must NOT trigger the fallback (else the layer loads empty).
  it("does not match curved geometries (codes 8-12)", () => {
    for (const id of [8, 9, 10, 11, 12]) {
      const error = new Error(
        `Could not parse WKB input: WKB type 'CircularString' is not supported! (type id: ${id}, SRID: 0)`,
      );
      assert.equal(isUnsupportedSurfaceWkbError(error), false, `id ${id}`);
    }
    // Curved type named but no id, and no surface keyword: also excluded.
    assert.equal(
      isUnsupportedSurfaceWkbError(new Error("WKB type 'CircularString' is not supported!")),
      false,
    );
  });

  // The generic, type-less message is matched by isGenericUnsupportedWkbError,
  // NOT the surface matcher (which needs a type name/id to exclude curves).
  it("does not match the generic 'Unsupported geometry type in WKB' message", () => {
    assert.equal(
      isUnsupportedSurfaceWkbError(
        new Error("Invalid Input Error: Unsupported geometry type in WKB"),
      ),
      false,
    );
  });

  it("ignores unrelated errors", () => {
    assert.equal(isUnsupportedSurfaceWkbError(new Error("stoi: no conversion")), false);
    assert.equal(isUnsupportedSurfaceWkbError("TIN"), false);
  });
});

describe("isGenericUnsupportedWkbError", () => {
  it("matches the generic type-less message", () => {
    assert.equal(
      isGenericUnsupportedWkbError(
        new Error("Invalid Input Error: Unsupported geometry type in WKB"),
      ),
      true,
    );
  });

  it("does not match the detailed surface or unrelated messages", () => {
    assert.equal(
      isGenericUnsupportedWkbError(new Error("WKB type 'TIN Z' is not supported! (type id: 1016)")),
      false,
    );
    assert.equal(isGenericUnsupportedWkbError(new Error("stoi: no conversion")), false);
  });
});

describe("normalizePropertyValue", () => {
  it("converts a safe BigInt to a number and a huge one to a string", () => {
    assert.equal(normalizePropertyValue(42n), 42);
    assert.equal(
      normalizePropertyValue(123456789012345678901234567890n),
      "123456789012345678901234567890",
    );
  });

  it("serializes Dates and recurses into arrays and objects", () => {
    const date = new Date("2020-01-02T03:04:05.000Z");
    assert.equal(normalizePropertyValue(date), "2020-01-02T03:04:05.000Z");
    assert.deepEqual(normalizePropertyValue([1n, { a: 2n }]), [1, { a: 2 }]);
  });
});

describe("wkbRowsToFeatureCollection", () => {
  it("decodes the WKB column and drops it (and blobs) from properties", () => {
    const wkb = encodeWkb({
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    });
    const out = wkbRowsToFeatureCollection(
      [{ name: "a", extra: new Uint8Array([1, 2]), wkb_geometry: wkb }],
      "wkb_geometry",
    );
    assert.deepEqual(out.features[0].geometry, {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    });
    // The WKB geometry column and any other blob columns are excluded.
    assert.deepEqual(out.features[0].properties, { name: "a" });
  });

  it("decodes a base64-encoded WKB string column", () => {
    const wkb = encodeWkb({ type: "Point", coordinates: [3, 4] });
    const base64 = Buffer.from(wkb).toString("base64");
    const out = wkbRowsToFeatureCollection([{ wkb_geometry: base64 }], "wkb_geometry");
    assert.deepEqual(out.features[0].geometry, {
      type: "Point",
      coordinates: [3, 4],
    });
  });

  it("yields a null geometry when a blob cannot be decoded", () => {
    // Type code 8 = CircularString, which decodeWkb throws on.
    const undecodable = new Uint8Array([0x01, 0x08, 0x00, 0x00, 0x00]);
    const out = wkbRowsToFeatureCollection([{ id: 1, wkb_geometry: undecodable }], "wkb_geometry");
    assert.equal(out.features[0].geometry, null);
    assert.deepEqual(out.features[0].properties, { id: 1 });
  });

  it("treats a missing or empty geometry blob as null", () => {
    const out = wkbRowsToFeatureCollection(
      [
        { id: 1, wkb_geometry: null },
        { id: 2, wkb_geometry: new Uint8Array() },
      ],
      "wkb_geometry",
    );
    assert.equal(out.features[0].geometry, null);
    assert.equal(out.features[1].geometry, null);
  });
});
