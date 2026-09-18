/**
 * Tests for the interactive viewshed (issue #1815).
 *
 * A viewshed is easy to get plausibly wrong: a ridge that should block a view
 * still produces a green blob, just the wrong shape, and nobody notices without
 * ground truth. So the cases here are ones with an analytically known answer —
 * a flat plane, a single wall, a pit — rather than a real DEM.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assembleTerrainDem,
  computeViewshed,
  computeViewshedAsync,
  decodeTerrariumElevation,
  decodeTerrariumRgba,
  metersToLatDegrees,
  tileForLngLat,
  viewshedToRgba,
  zoomForRadius,
  type TerrainDem,
} from "../packages/processing/src/terrain-viewshed";

/** A DEM over a small square around (0, 0), with elevations from a callback. */
function demOf(
  width: number,
  height: number,
  elevation: (col: number, row: number) => number,
): TerrainDem {
  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      values[row * width + col] = elevation(col, row);
    }
  }
  // ~1 km square, so cells are a few metres across at these grid sizes.
  const d = metersToLatDegrees(500);
  return { width, height, values, bbox: [-d, -d, d, d] };
}

const CENTRE = { lng: 0, lat: 0, heightMeters: 2 };

describe("decodeTerrariumElevation", () => {
  it("decodes sea level and known offsets", () => {
    // Terrarium stores elevation + 32768, so 128,0,0 is exactly 0 m.
    assert.equal(decodeTerrariumElevation(128, 0, 0), 0);
    assert.equal(decodeTerrariumElevation(128, 100, 0), 100);
    assert.equal(decodeTerrariumElevation(127, 0, 0), -256);
  });

  it("uses the blue channel for sub-metre precision", () => {
    assert.equal(decodeTerrariumElevation(128, 0, 128), 0.5);
  });
});

describe("decodeTerrariumRgba", () => {
  it("decodes every pixel of a tile", () => {
    // Two pixels: sea level, then 100m. RGBA, so 4 bytes each.
    const data = new Uint8ClampedArray([128, 0, 0, 255, 128, 100, 0, 255]);
    assert.deepEqual(Array.from(decodeTerrariumRgba(data, 2, 1)), [0, 100]);
  });

  it("sizes the output from the dimensions it is given", () => {
    // Regression for a real failure: decodeTile read bitmap.width *after*
    // bitmap.close(), which zeroes it, so every tile decoded to 0x0 and was
    // then silently discarded by the assembly loop as the wrong size -- the
    // viewshed reported "no visible area" for every click. Taking the
    // dimensions as arguments is what makes that ordering hazard impossible.
    const data = new Uint8ClampedArray(4 * 4);
    data.fill(0);
    assert.equal(decodeTerrariumRgba(data, 0, 0).length, 0);
    assert.equal(decodeTerrariumRgba(data, 2, 2).length, 4);
  });
});

describe("zoomForRadius", () => {
  it("picks a deeper zoom for a smaller radius", () => {
    assert.ok(zoomForRadius(500, 0) > zoomForRadius(20000, 0));
  });

  it("never exceeds the Terrarium maximum", () => {
    assert.ok(zoomForRadius(10, 0) <= 15);
  });
});

describe("tileForLngLat", () => {
  it("puts the origin at the middle of the world at zoom 1", () => {
    assert.deepEqual(tileForLngLat(0.0001, 0.0001, 1), { x: 1, y: 0 });
  });

  it("puts the north-west corner at tile 0,0", () => {
    assert.deepEqual(tileForLngLat(-179.9, 85, 2), { x: 0, y: 0 });
  });
});

describe("computeViewshed", () => {
  it("sees everything from a flat plane", () => {
    const dem = demOf(21, 21, () => 100);
    const result = computeViewshed(dem, CENTRE);
    assert.equal(result.visibleCells, 21 * 21, "a flat plane hides nothing");
  });

  it("reports the ground elevation under the observer", () => {
    const dem = demOf(11, 11, () => 250);
    assert.equal(computeViewshed(dem, CENTRE).observerGroundMeters, 250);
  });

  it("hides the ground behind a wall", () => {
    // A tall north-south wall two cells east of centre. Everything beyond it on
    // that row must be hidden; the wall itself is visible.
    const mid = 10;
    const dem = demOf(21, 21, (col) => (col === mid + 2 ? 500 : 0));
    const result = computeViewshed(dem, CENTRE);
    const at = (col: number, row: number) => result.visible[row * 21 + col];

    assert.equal(at(mid + 2, mid), 1, "the wall itself is in view");
    assert.equal(at(mid + 5, mid), 0, "ground directly behind the wall is hidden");
    assert.equal(at(20, mid), 0, "ground at the far edge behind the wall is hidden");
    assert.equal(at(mid - 5, mid), 1, "ground on the observer's side stays visible");
  });

  it("sees over a wall from high enough up", () => {
    const mid = 10;
    const dem = demOf(21, 21, (col) => (col === mid + 2 ? 50 : 0));
    const low = computeViewshed(dem, { ...CENTRE, heightMeters: 2 });
    const high = computeViewshed(dem, { ...CENTRE, heightMeters: 2000 });
    assert.ok(
      high.visibleCells > low.visibleCells,
      "raising the observer must reveal ground the wall was hiding",
    );
  });

  it("hides the floor of a pit but not its rim", () => {
    // Observer on a peak; a depression beyond a raised lip.
    const mid = 10;
    const dem = demOf(21, 21, (col, row) => {
      if (col === mid && row === mid) return 100; // observer's peak
      if (col === mid + 3) return 60; // lip
      if (col > mid + 3) return 0; // pit floor beyond it
      return 0;
    });
    const result = computeViewshed(dem, { ...CENTRE, heightMeters: 1 });
    assert.equal(result.visible[mid * 21 + (mid + 3)], 1, "the lip is visible");
    assert.equal(result.visible[mid * 21 + (mid + 6)], 0, "the floor beyond it is not");
  });

  it("honours the radius limit", () => {
    const dem = demOf(41, 41, () => 0);
    const unlimited = computeViewshed(dem, CENTRE);
    const limited = computeViewshed(dem, CENTRE, 100);
    assert.ok(limited.visibleCells < unlimited.visibleCells, "a radius must exclude distant cells");
    assert.ok(limited.visibleCells > 0, "but not exclude everything");
  });

  it("always sees the observer's own cell", () => {
    const dem = demOf(11, 11, (col, row) => (col === 5 && row === 5 ? 0 : 900));
    const result = computeViewshed(dem, CENTRE);
    assert.equal(result.visible[5 * 11 + 5], 1);
  });
});

describe("assembleTerrainDem bounds", () => {
  it("rejects positions beyond the Web Mercator limit", async () => {
    // The tile grid is undefined past ~85 degrees; a request there would
    // otherwise be left to fail as 404s partway through the assembly.
    assert.equal(
      await assembleTerrainDem({ lng: 0, lat: 89, radiusMeters: 2000, tileUrl: "x/{z}/{x}/{y}" }),
      null,
    );
    assert.equal(
      await assembleTerrainDem({ lng: 0, lat: -89, radiusMeters: 2000, tileUrl: "x/{z}/{x}/{y}" }),
      null,
    );
  });

  it("rejects a square straddling the antimeridian", async () => {
    // Wrapping would produce a negative tile x.
    assert.equal(
      await assembleTerrainDem({
        lng: 179.99,
        lat: 0,
        radiusMeters: 50000,
        tileUrl: "x/{z}/{x}/{y}",
      }),
      null,
    );
  });
});

describe("computeViewshedAsync", () => {
  it("falls back to this thread where Workers are unavailable", async () => {
    // node:test has no Worker global, which is also the SSR / locked-down
    // webview case: the fallback must produce a real viewshed, not an error.
    const dem = demOf(11, 11, () => 0);
    const [sync, viaAsync] = [
      computeViewshed(dem, CENTRE),
      await computeViewshedAsync(dem, CENTRE),
    ];
    assert.equal(viaAsync.visibleCells, sync.visibleCells);
    assert.deepEqual(Array.from(viaAsync.visible), Array.from(sync.visible));
    assert.equal(viaAsync.observerGroundMeters, sync.observerGroundMeters);
  });

  it("honours the radius through the async path", async () => {
    const dem = demOf(41, 41, () => 0);
    const limited = await computeViewshedAsync(dem, CENTRE, 100);
    const unlimited = await computeViewshedAsync(dem, CENTRE);
    assert.ok(limited.visibleCells < unlimited.visibleCells);
  });
});

describe("viewshedToRgba", () => {
  it("paints visible cells and leaves the rest transparent", () => {
    const dem = demOf(3, 3, () => 0);
    const result = computeViewshed(dem, CENTRE);
    result.visible.fill(0);
    result.visible[4] = 1; // centre cell only
    const rgba = viewshedToRgba(result);
    assert.equal(rgba[4 * 4 + 3], 110, "visible cell carries the wash alpha");
    assert.equal(rgba[0 * 4 + 3], 0, "hidden cell stays fully transparent");
  });
});
