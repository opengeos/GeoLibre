import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLayerDataError } from "../apps/geolibre-desktop/src/lib/sql-table-names";

// Registration errors that skip one layer must be about its data. An engine
// failure (the spatial extension missing, a poisoned instance) must still fail.
describe("isLayerDataError", () => {
  it("skips a layer whose data DuckDB rejects", () => {
    assert.equal(isLayerDataError(new Error("Binder Error: duplicate column name \"NAME\"")), true);
    assert.equal(isLayerDataError(new Error("Conversion Error: could not convert value")), true);
  });

  it("does not skip a missing st_read, which means the spatial extension failed", () => {
    const error = new Error(
      "Catalog Error: Table Function with name st_read does not exist!\nDid you mean ST_Read?",
    );
    assert.equal(isLayerDataError(error), false);
  });

  it("leaves the poisoned-instance stoi error for the retry", () => {
    assert.equal(isLayerDataError(new Error("Conversion Error: stoi: no conversion")), false);
  });

  it("does not skip errors that are not DuckDB error classes", () => {
    assert.equal(isLayerDataError(new Error("out of memory")), false);
  });
});
