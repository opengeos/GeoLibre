import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  databaseBaselineKeys,
  databaseTableKey,
  databaseTableLabel,
  uniqueDatabaseTables,
} from "../apps/geolibre-desktop/src/lib/database-tables";

describe("database table selection", () => {
  it("distinguishes dotted identifiers that have the same display label", () => {
    const dottedSchema = { schema: "a.b", table: "c" };
    const dottedTable = { schema: "a", table: "b.c" };

    assert.equal(databaseTableLabel(dottedSchema), "a.b.c");
    assert.equal(databaseTableLabel(dottedTable), "a.b.c");
    assert.notEqual(databaseTableKey(dottedSchema), databaseTableKey(dottedTable));
  });

  it("keeps the first occurrence of each table in input order", () => {
    const first = { schema: "public", table: "roads", geometry: "geom" };
    const duplicate = { schema: "public", table: "roads", geometry: "shape" };
    const other = { schema: "public", table: "buildings", geometry: "geom" };

    assert.deepEqual(uniqueDatabaseTables([first, duplicate, other]), [first, other]);
  });

  it("reads typed baseline keys for either database engine", () => {
    const layer = {
      id: "baseline",
      metadata: {
        postgisBaselineKeys: [1, "two", null, { bad: true }, 3],
        mssqlBaselineKeys: ["mssql", false, 2],
      },
    } as unknown as GeoLibreLayer;

    assert.deepEqual(databaseBaselineKeys(layer, "postgisBaselineKeys"), [1, "two", 3]);
    assert.deepEqual(databaseBaselineKeys(layer, "mssqlBaselineKeys"), ["mssql", 2]);
    assert.equal(
      databaseBaselineKeys(
        { id: "missing", metadata: {} } as unknown as GeoLibreLayer,
        "postgisBaselineKeys",
      ),
      undefined,
    );
  });
});
