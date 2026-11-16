import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createTerrariumFallback,
  decodeTerrariumRgba,
  sampleAncestorTile,
} from "../packages/map/src/terrarium-fallback";
import {
  displayedTerrainFillOutside,
  resolveTerrainFillOutside,
} from "../apps/geolibre-desktop/src/lib/terrain-fill";

const SIZE = 256;

/** A Terrarium RGBA tile holding one elevation everywhere. */
function flatTile(metres: number): Uint8ClampedArray {
  const encoded = metres + 32_768;
  const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    rgba[i * 4] = Math.floor(encoded / 256);
    rgba[i * 4 + 1] = Math.floor(encoded % 256);
    rgba[i * 4 + 2] = Math.round((encoded % 1) * 256);
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

describe("decodeTerrariumRgba", () => {
  it("decodes metres and reads a transparent pixel as no data", () => {
    const rgba = new Uint8ClampedArray([128, 100, 128, 255, 0, 0, 0, 0]);
    const out = decodeTerrariumRgba(rgba);
    assert.equal(out[0], 100.5);
    assert.ok(Number.isNaN(out[1]));
  });
});

describe("sampleAncestorTile", () => {
  it("cuts the matching quarter of the ancestor one zoom deeper", () => {
    // Left half 0 m, right half 1000 m.
    const ancestor = new Float32Array(SIZE * SIZE);
    for (let row = 0; row < SIZE; row += 1) {
      for (let column = SIZE / 2; column < SIZE; column += 1) ancestor[row * SIZE + column] = 1000;
    }
    const left = sampleAncestorTile(ancestor, 1, 0, 0);
    const right = sampleAncestorTile(ancestor, 1, 1, 0);
    assert.equal(left[10], 0);
    assert.equal(right[SIZE * 10 + 200], 1000);
  });
});

describe("createTerrariumFallback", () => {
  it("reads the tile itself up to the source's max zoom", async () => {
    const urls: string[] = [];
    const fallback = createTerrariumFallback({
      template: "https://tiles.test/{z}/{x}/{y}.png",
      maxzoom: 15,
      loadRgba: async (url) => {
        urls.push(url);
        return flatTile(420);
      },
    });
    const tile = await fallback(12, 1100, 1600);
    assert.deepEqual(urls, ["https://tiles.test/12/1100/1600.png"]);
    assert.equal(tile?.[0], 420);
  });

  it("overzooms from the max-zoom ancestor and fetches it once", async () => {
    const urls: string[] = [];
    const fallback = createTerrariumFallback({
      template: "https://tiles.test/{z}/{x}/{y}.png",
      maxzoom: 15,
      loadRgba: async (url) => {
        urls.push(url);
        return flatTile(800);
      },
    });
    await fallback(17, 4 * 100 + 1, 4 * 200 + 3);
    const tile = await fallback(17, 4 * 100 + 2, 4 * 200);
    assert.deepEqual(urls, ["https://tiles.test/15/100/200.png"]);
    assert.equal(tile?.[SIZE * 128 + 128], 800);
  });

  it("resolves null for a missing tile and retries it only after a pause", async () => {
    let calls = 0;
    let clock = 0;
    const fallback = createTerrariumFallback({
      template: "{z}/{x}/{y}",
      maxzoom: 15,
      retryAfterMs: 1000,
      now: () => clock,
      loadRgba: async () => {
        calls += 1;
        return null;
      },
    });
    assert.equal(await fallback(3, 1, 1), null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Within the pause: no new request, so a dead source is not hammered.
    assert.equal(await fallback(3, 1, 1), null);
    assert.equal(calls, 1);
    clock = 1500;
    assert.equal(await fallback(3, 1, 1), null);
    assert.equal(calls, 2);
  });
});

describe("resolveTerrainFillOutside", () => {
  it("defaults on for a URL DEM and off for a local file (#3470)", () => {
    assert.equal(resolveTerrainFillOutside(undefined, "https://data.test/dem.tif"), true);
    assert.equal(resolveTerrainFillOutside(undefined, new Blob(["x"])), false);
    assert.equal(resolveTerrainFillOutside(undefined, "/home/me/dem.tif"), false);
  });

  it("follows an explicit choice either way", () => {
    assert.equal(resolveTerrainFillOutside(false, "https://data.test/dem.tif"), false);
    assert.equal(resolveTerrainFillOutside(true, new Blob(["x"])), true);
  });
});

describe("displayedTerrainFillOutside", () => {
  it("shows the engine's fill for the DEM on the map, else the saved or URL default", () => {
    assert.equal(displayedTerrainFillOutside(false, true), false);
    assert.equal(displayedTerrainFillOutside(null, false), false);
    assert.equal(displayedTerrainFillOutside(null, undefined), true);
  });
});
