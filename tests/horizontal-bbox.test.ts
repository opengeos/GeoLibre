import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { horizontalBbox } from "@geolibre/core";

describe("horizontalBbox", () => {
  it("passes a two-dimensional box through", () => {
    assert.deepEqual(horizontalBbox([-78, 35, -77, 36]), [-78, 35, -77, 36]);
  });

  it("drops the altitude pair from a six-element box", () => {
    // RFC 7946 §5: [west, south, minAltitude, east, north, maxAltitude].
    assert.deepEqual(
      horizontalBbox([-179.9224, -61.5305, -3.6, 179.7358, 66.921, 621.93]),
      [-179.9224, -61.5305, 179.7358, 66.921],
    );
  });

  it("returns null for a box carrying a non-finite value", () => {
    // What an empty collection, or one whose features all have a null
    // geometry, bboxes to.
    assert.equal(
      horizontalBbox([
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ]),
      null,
    );
    assert.equal(horizontalBbox([-78, Number.NaN, -77, 36]), null);
  });

  it("returns null when only the altitudes are non-finite", () => {
    // The horizontal values alone would pass, but a box whose altitudes are
    // not finite is not one to trust the rest of.
    assert.equal(horizontalBbox([-78, 35, Number.NaN, -77, 36, Number.POSITIVE_INFINITY]), null);
  });

  it("returns null for a box of any other length", () => {
    assert.equal(horizontalBbox([-78, 35, -77]), null);
    assert.equal(horizontalBbox([]), null);
  });

  it("returns null for a missing box", () => {
    assert.equal(horizontalBbox(null), null);
    assert.equal(horizontalBbox(undefined), null);
  });
});
