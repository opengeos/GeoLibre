import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferColumnTypes } from "../apps/geolibre-desktop/src/lib/attribute-columns";

/**
 * A cell that is empty says nothing about its column's type. Typing into one
 * used to store a string, quietly making a number column mixed — locally that
 * only skews sorting and styling, but a dataset with a real schema behind it
 * rejects the write outright ("a value is incompatible with a column's type").
 */
describe("inferColumnTypes", () => {
  it("takes each column's type from the first feature that has a value", () => {
    const types = inferColumnTypes([
      { id: null, height: null, name: "a" },
      { id: "abc", height: 2.6, name: "b" },
    ]);
    assert.equal(types.get("id"), "string");
    assert.equal(types.get("height"), "number");
    assert.equal(types.get("name"), "string");
  });

  it("reports nothing for a column that is empty everywhere", () => {
    const types = inferColumnTypes([{ note: null }, { note: null }]);
    assert.equal(types.has("note"), false);
  });

  it("ignores missing property bags", () => {
    const types = inferColumnTypes([null, undefined, { flag: true }]);
    assert.equal(types.get("flag"), "boolean");
  });
});
