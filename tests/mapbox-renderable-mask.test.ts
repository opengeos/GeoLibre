import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection, Polygon } from "geojson";
import { buildInvertedMask, mapboxRenderableMask } from "../packages/map/src/derived-geometry";

// mapbox-gl drops a world ring reaching the poles and fills same-wound holes,
// which inverts turf's mask; the Mapbox paths (the inverted fill, the Print
// Layout atlas mask) reshape it first (#2475).
const signedArea = (ring: number[][]) => {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++)
    sum += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
  return Math.sign(sum);
};

describe("mapboxRenderableMask", () => {
  it("keeps the world ring inside Web Mercator and opposes the holes' winding", () => {
    const square: FeatureCollection<Polygon> = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [10, 0],
                [10, 10],
                [0, 10],
                [0, 0],
              ],
            ],
          },
        },
      ],
    };
    const mask = buildInvertedMask(square)!;
    const rings = (mask.features[0].geometry as Polygon).coordinates;
    assert.equal(signedArea(rings[1]), signedArea(rings[0]), "turf winds them alike");
    const fixed = mapboxRenderableMask(mask);
    const [outer, hole] = (fixed.features[0].geometry as Polygon).coordinates;
    assert.ok(outer.every(([, lat]) => Math.abs(lat) <= 85.0511));
    assert.ok(
      outer.some(([lng]) => Math.abs(lng) === 180),
      "longitude is left alone",
    );
    assert.notEqual(signedArea(hole), signedArea(outer));
    assert.equal(mapboxRenderableMask(mask), fixed, "memoized");
  });
});
