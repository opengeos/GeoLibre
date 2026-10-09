import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pointBounds } from "../apps/geolibre-desktop/src/lib/point-bounds";

/** Point features at the given `[lon, lat]` pairs. */
function points(coords: Array<[number, number]>) {
  return coords.map((coordinates) => ({ geometry: { coordinates } }));
}

describe("pointBounds", () => {
  it("returns the plain extent for a track away from the antimeridian", () => {
    assert.deepEqual(
      pointBounds(
        points([
          [-84, 35],
          [-83, 36.5],
        ]),
      ),
      [-84, 35, -83, 36.5],
    );
  });

  it("unwraps a track that crosses the antimeridian", () => {
    assert.deepEqual(
      pointBounds(
        points([
          [179, -70],
          [-179, -71],
          [-178, -72],
        ]),
      ),
      [179, -72, 182, -70],
    );
  });

  it("returns null for no features", () => {
    assert.equal(pointBounds([]), null);
  });
});
