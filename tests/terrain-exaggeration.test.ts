import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampExaggeration,
  MAX_EXAGGERATION,
  MIN_EXAGGERATION,
} from "../apps/geolibre-desktop/src/lib/terrain-exaggeration";

describe("clampExaggeration", () => {
  it("passes through values already inside the display range", () => {
    assert.equal(clampExaggeration(0), 0);
    assert.equal(clampExaggeration(2.5), 2.5);
    assert.equal(clampExaggeration(5), 5);
  });

  it("clamps to the min and max bounds", () => {
    assert.equal(clampExaggeration(-3), MIN_EXAGGERATION);
    assert.equal(clampExaggeration(7), MAX_EXAGGERATION);
  });

  it("falls back to the min for non-finite input", () => {
    assert.equal(clampExaggeration(Number.NaN), MIN_EXAGGERATION);
    assert.equal(clampExaggeration(Number.POSITIVE_INFINITY), MIN_EXAGGERATION);
    assert.equal(clampExaggeration(Number.NEGATIVE_INFINITY), MIN_EXAGGERATION);
  });
});
