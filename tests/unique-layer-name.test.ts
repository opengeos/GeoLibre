import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { uniqueLayerName } from "../apps/geolibre-desktop/src/lib/unique-layer-name";

const named = (...names: string[]) => names.map((name) => ({ name }));

describe("uniqueLayerName (issue #3472)", () => {
  it("keeps a name nothing uses", () => {
    assert.equal(uniqueLayerName("Buffer", named("Roads")), "Buffer");
    assert.equal(uniqueLayerName(" Buffer ", named("Roads")), "Buffer");
  });

  it("suffixes a repeated output with the next free number", () => {
    assert.equal(uniqueLayerName("Buffer", named("Buffer")), "Buffer (2)");
    assert.equal(uniqueLayerName("Buffer", named("Buffer", "Buffer (2)")), "Buffer (3)");
    // A gap left by a removed layer is reused.
    assert.equal(uniqueLayerName("Buffer", named("Buffer", "Buffer (3)")), "Buffer (2)");
  });

  it("ignores surrounding whitespace when comparing", () => {
    assert.equal(
      uniqueLayerName("Select by value", named(" Select by value ")),
      "Select by value (2)",
    );
  });

  it("is case-sensitive", () => {
    assert.equal(uniqueLayerName("buffer", named("Buffer")), "buffer");
  });
});
