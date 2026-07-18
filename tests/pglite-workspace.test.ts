import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature } from "geojson";
import {
  buildCreateTableStatement,
  buildInsertChunk,
  classifyColumnType,
  inferPropertyColumns,
  pickGeometryColumnName,
} from "../apps/geolibre-desktop/src/lib/pglite-sql";

function feature(
  properties: Record<string, unknown> | null,
  geometry: Feature["geometry"] = { type: "Point", coordinates: [0, 0] },
): Feature {
  return { type: "Feature", properties, geometry };
}

describe("classifyColumnType", () => {
  it("defaults an all-null property to text", () => {
    assert.equal(classifyColumnType([null, undefined]), "text");
    assert.equal(classifyColumnType([]), "text");
  });

  it("picks double precision only when every value is a finite number", () => {
    assert.equal(classifyColumnType([1, 2.5, null]), "double precision");
    assert.equal(classifyColumnType([1, "2"]), "text");
    assert.equal(classifyColumnType([1, Number.NaN]), "text");
  });

  it("picks boolean only when every value is boolean", () => {
    assert.equal(classifyColumnType([true, false, null]), "boolean");
    assert.equal(classifyColumnType([true, 1]), "text");
  });

  it("picks jsonb when any value is an object or array", () => {
    assert.equal(classifyColumnType([{ a: 1 }, null]), "jsonb");
    assert.equal(classifyColumnType([[1, 2], "x"]), "jsonb");
  });
});

describe("inferPropertyColumns", () => {
  it("keeps first-seen key order across features and infers per-key types", () => {
    const columns = inferPropertyColumns([
      feature({ name: "a", pop: 10, active: true }),
      feature({ name: "b", pop: 20, active: false, extra: { nested: 1 } }),
    ]);
    assert.deepEqual(columns, [
      { name: "name", type: "text" },
      { name: "pop", type: "double precision" },
      { name: "active", type: "boolean" },
      { name: "extra", type: "jsonb" },
    ]);
  });

  it("ignores features with null properties", () => {
    const columns = inferPropertyColumns([feature(null), feature({ id: 1 })]);
    assert.deepEqual(columns, [{ name: "id", type: "double precision" }]);
  });
});

describe("pickGeometryColumnName", () => {
  it("prefers geom when free", () => {
    assert.equal(pickGeometryColumnName(["name", "pop"]), "geom");
  });

  it("falls back when geom (and geometry) are taken", () => {
    assert.equal(pickGeometryColumnName(["geom"]), "geometry");
    assert.equal(pickGeometryColumnName(["geom", "geometry"]), "geom_2");
    assert.equal(pickGeometryColumnName(["geom", "geometry", "geom_2"]), "geom_3");
  });
});

describe("buildCreateTableStatement", () => {
  it("quotes identifiers and appends a 4326 geometry column", () => {
    const sql = buildCreateTableStatement(
      '"geolibre"."cities"',
      [
        { name: "name", type: "text" },
        { name: "pop", type: "double precision" },
      ],
      "geom",
    );
    assert.equal(
      sql,
      'CREATE TABLE "geolibre"."cities" ("name" text, "pop" double precision, ' +
        '"geom" geometry(Geometry, 4326))',
    );
  });

  it("escapes embedded double quotes in column names", () => {
    const sql = buildCreateTableStatement('"t"', [{ name: 'we"ird', type: "text" }], "geom");
    assert.match(sql, /"we""ird" text/);
  });
});

describe("buildInsertChunk", () => {
  it("binds property values and wraps geometry in ST_GeomFromGeoJSON", () => {
    const point = { type: "Point", coordinates: [1, 2] } as const;
    const { text, params } = buildInsertChunk(
      '"t"',
      [
        { name: "name", type: "text" },
        { name: "pop", type: "double precision" },
        { name: "tags", type: "jsonb" },
      ],
      "geom",
      [feature({ name: "a", pop: 5, tags: { x: 1 } }, point)],
    );
    assert.equal(
      text,
      'INSERT INTO "t" ("name", "pop", "tags", "geom") VALUES ' +
        "($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))",
    );
    assert.deepEqual(params, ["a", 5, '{"x":1}', JSON.stringify(point)]);
  });

  it("emits a null geometry parameter when a feature has no geometry", () => {
    const { params } = buildInsertChunk('"t"', [{ name: "id", type: "double precision" }], "geom", [
      feature({ id: 1 }, null),
    ]);
    assert.deepEqual(params, [1, null]);
  });

  it("renumbers placeholders across multiple rows", () => {
    const { text, params } = buildInsertChunk(
      '"t"',
      [{ name: "id", type: "double precision" }],
      "geom",
      [
        feature({ id: 1 }, { type: "Point", coordinates: [0, 0] }),
        feature({ id: 2 }, { type: "Point", coordinates: [1, 1] }),
      ],
    );
    assert.equal(
      text,
      'INSERT INTO "t" ("id", "geom") VALUES ' +
        "($1, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)), " +
        "($3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))",
    );
    assert.equal(params.length, 4);
  });

  it("stringifies non-string scalars for text columns", () => {
    const { params } = buildInsertChunk('"t"', [{ name: "mixed", type: "text" }], "geom", [
      feature({ mixed: 42 }, null),
    ]);
    assert.deepEqual(params, ["42", null]);
  });
});
