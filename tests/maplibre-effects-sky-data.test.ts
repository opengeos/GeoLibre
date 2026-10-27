import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FIGURES,
  MILKY_WAY,
  STARS,
} from "../packages/plugins/src/plugins/maplibre-effects-sky-data";

const inSky = (ra: number, dec: number): boolean => ra >= 0 && ra <= 360 && dec >= -90 && dec <= 90;

describe("night-sky data", () => {
  it("lists naked-eye stars brightest first with in-range coordinates", () => {
    assert.ok(STARS.length > 4000);
    // Sirius leads the list.
    assert.deepEqual(STARS[0].slice(0, 2), [101.3, -16.7]);
    let prevMag = -Infinity;
    for (const [ra, dec, mag10] of STARS) {
      assert.ok(inSky(ra, dec), `star at ${ra}, ${dec}`);
      assert.ok(mag10 >= prevMag, "stars are sorted brightest first");
      assert.ok(mag10 < 65, "every star is brighter than magnitude 6.5");
      prevMag = mag10;
    }
  });

  it("stores constellation figures and Milky Way rings as ra/dec pairs", () => {
    assert.ok(FIGURES.length > 0);
    assert.equal(MILKY_WAY.length, 5);
    const paths = [...FIGURES, ...MILKY_WAY.flat()];
    for (const path of paths) {
      assert.equal(path.length % 2, 0);
      assert.ok(path.length >= 4);
      for (let i = 0; i < path.length; i += 2) {
        assert.ok(inSky(path[i], path[i + 1]), `vertex at ${path[i]}, ${path[i + 1]}`);
      }
    }
  });
});
