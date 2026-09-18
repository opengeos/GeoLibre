import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  postgisTableKey,
  postgisTableLabel,
} from "../apps/geolibre-desktop/src/lib/postgis-table-selection";

describe("PostGIS table selection", () => {
  it("distinguishes dotted identifiers that have the same display label", () => {
    const dottedSchema = { schema: "a.b", table: "c" };
    const dottedTable = { schema: "a", table: "b.c" };

    assert.equal(postgisTableLabel(dottedSchema), "a.b.c");
    assert.equal(postgisTableLabel(dottedTable), "a.b.c");
    assert.notEqual(postgisTableKey(dottedSchema), postgisTableKey(dottedTable));
  });
});
