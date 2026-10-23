import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isCornerCoordinates } from "../packages/map/src/layer-sync";

/** Image-source corners (NW, NE, SE, SW) for a lng/lat box. */
function box(west: number, south: number, east: number, north: number) {
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}

describe("isCornerCoordinates", () => {
  it("accepts an ordinary in-range quad", () => {
    assert.equal(isCornerCoordinates(box(-172.5, 10, -47.5, 70)), true);
  });

  it("accepts a quad across the antimeridian whose centre is on the map", () => {
    // A NetCDF grid on 150E..250E, stored as 210W..110W (centre 160W). The
    // in-range check used to drop it, so the layer silently never drew.
    assert.equal(isCornerCoordinates(box(-222.5, 10, -97.5, 70)), true);
    assert.equal(isCornerCoordinates(box(160, 0, 200, 10)), true);
  });

  it("rejects a quad whose centre lies past 180", () => {
    // MapLibre throws "x=2, y=0, z=1 outside of bounds" for this one.
    assert.equal(isCornerCoordinates(box(137.5, 10, 262.5, 70)), false);
  });

  it("rejects malformed and out-of-range corners", () => {
    assert.equal(isCornerCoordinates(box(-10, -95, 10, 0)), false);
    assert.equal(isCornerCoordinates(box(-400, 0, -300, 10)), false);
    assert.equal(isCornerCoordinates([[0, 0]]), false);
    assert.equal(isCornerCoordinates(null), false);
  });
});
