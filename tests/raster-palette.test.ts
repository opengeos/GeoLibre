import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPaletteLegend,
  type PaletteLegendEntry,
} from "../packages/plugins/src/plugins/raster-palette";

// The color table stores 8-bit channels scaled to 16-bit (GDAL writes value *
// 257, so value >> 8 recovers the 8-bit channel). Build a 256-entry RGB table
// from a value -> [r, g, b] map the same way.
function colorMap(colors: Record<number, [number, number, number]>): Uint16Array {
  const n = 256;
  const cmap = new Uint16Array(n * 3);
  for (const [value, [r, g, b]] of Object.entries(colors)) {
    const v = Number(value);
    cmap[v] = r * 257;
    cmap[n + v] = g * 257;
    cmap[2 * n + v] = b * 257;
  }
  return cmap;
}

type TileArray =
  | {
      layout: "band-separate";
      bands: ArrayLike<number>[];
      width: number;
      height: number;
      mask: Uint8Array | null;
      count: number;
    }
  | {
      layout: "pixel-interleaved";
      data: ArrayLike<number>;
      width: number;
      height: number;
      mask: Uint8Array | null;
      count: number;
    };

// Minimal stand-in for maplibre-gl-raster's loaded GeoTIFF: one overview level
// whose single tile decodes to the given array. buildPaletteLegend only reads
// cachedTags, nodata, overviews, tileCount and fetchTile off it.
function fakeTiff(options: { colorMap?: Uint16Array; nodata?: number | null; tile?: TileArray }) {
  const level = {
    tileCount: { x: 1, y: 1 },
    fetchTile: async () => ({ array: options.tile }),
  };
  return {
    cachedTags:
      options.colorMap !== undefined
        ? { colorMap: options.colorMap, nodata: options.nodata ?? null }
        : { nodata: options.nodata ?? null },
    nodata: options.nodata ?? null,
    overviews: [level],
    tileCount: { x: 1, y: 1 },
    fetchTile: async () => ({ array: options.tile }),
  } as unknown as Parameters<typeof buildPaletteLegend>[0];
}

async function legendOf(
  tiff: Parameters<typeof buildPaletteLegend>[0],
): Promise<PaletteLegendEntry[] | null> {
  return await buildPaletteLegend(tiff);
}

describe("buildPaletteLegend", () => {
  it("returns null when the raster carries no color table", async () => {
    const tiff = fakeTiff({
      tile: {
        layout: "band-separate",
        bands: [new Uint8Array([10, 20])],
        width: 2,
        height: 1,
        mask: null,
        count: 1,
      },
    });
    assert.equal(await legendOf(tiff), null);
  });

  it("decodes 16-bit color-table entries to hex and lists only present values", async () => {
    const tiff = fakeTiff({
      colorMap: colorMap({
        10: [0, 100, 0],
        20: [255, 187, 34],
        30: [255, 255, 76], // in the table but never occurs in the data
      }),
      nodata: 0,
      tile: {
        layout: "band-separate",
        bands: [new Uint8Array([0, 20, 10, 10, 0])],
        width: 5,
        height: 1,
        mask: null,
        count: 1,
      },
    });
    assert.deepEqual(await legendOf(tiff), [
      { value: 10, color: "#006400" },
      { value: 20, color: "#ffbb22" },
    ]);
  });

  it("excludes the nodata value and mask-flagged pixels", async () => {
    const tiff = fakeTiff({
      colorMap: colorMap({ 10: [1, 2, 3], 20: [4, 5, 6], 30: [7, 8, 9] }),
      nodata: 0,
      tile: {
        layout: "band-separate",
        // 30 sits under a 0 mask entry, 0 is nodata; only 10 and 20 survive.
        bands: [new Uint8Array([0, 10, 20, 30])],
        width: 4,
        height: 1,
        mask: new Uint8Array([1, 1, 1, 0]),
        count: 1,
      },
    });
    assert.deepEqual(await legendOf(tiff), [
      { value: 10, color: "#010203" },
      { value: 20, color: "#040506" },
    ]);
  });

  it("reads band 0 from a pixel-interleaved tile with multiple bands", async () => {
    const tiff = fakeTiff({
      colorMap: colorMap({ 10: [10, 10, 10], 20: [20, 20, 20] }),
      nodata: 0,
      tile: {
        layout: "pixel-interleaved",
        // stride 2: band-0 values are 10, 20 (the 99s are band 1 and ignored).
        data: new Uint8Array([10, 99, 20, 99]),
        width: 2,
        height: 1,
        mask: null,
        count: 2,
      },
    });
    assert.deepEqual(await legendOf(tiff), [
      { value: 10, color: "#0a0a0a" },
      { value: 20, color: "#141414" },
    ]);
  });

  it("returns an empty legend when only nodata pixels are present", async () => {
    const tiff = fakeTiff({
      colorMap: colorMap({ 10: [1, 1, 1] }),
      nodata: 0,
      tile: {
        layout: "band-separate",
        bands: [new Uint8Array([0, 0, 0])],
        width: 3,
        height: 1,
        mask: null,
        count: 1,
      },
    });
    assert.deepEqual(await legendOf(tiff), []);
  });

  it("throws when the loaded object lacks the expected tiff shape", async () => {
    const broken = {
      cachedTags: { colorMap: colorMap({ 10: [1, 1, 1] }) },
      nodata: 0,
      // no overviews / fetchTile
    } as unknown as Parameters<typeof buildPaletteLegend>[0];
    await assert.rejects(() => buildPaletteLegend(broken), /unexpected shape/);
  });
});
