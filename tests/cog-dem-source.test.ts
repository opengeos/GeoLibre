import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  demTilePlacement,
  encodeTerrariumDem,
  isDemOverviewIfd,
  normalizeNoData,
} from "../packages/map/src/cog-dem-source";

describe("COG DEM terrain encoding", () => {
  it("encodes metre and sub-metre elevations as Terrarium RGB", () => {
    assert.deepEqual(
      Array.from(encodeTerrariumDem([-32_768, 0, 1.5, 8_848])),
      [0, 0, 0, 255, 128, 0, 0, 255, 128, 1, 128, 255, 162, 144, 0, 255],
    );
  });

  it("fills nodata and non-finite cells with zero metres", () => {
    assert.deepEqual(
      Array.from(encodeTerrariumDem([-9999, Number.NaN, Number.POSITIVE_INFINITY], -9999)),
      [128, 0, 0, 255, 128, 0, 0, 255, 128, 0, 0, 255],
    );
  });

  it("matches a float32 sentinel against a short decimal GDAL_NODATA tag", () => {
    // The pixel holds float32 -3.4028235e38, i.e. -3.4028234663852886e38, while
    // the tag parses to a float64 that is close but not equal.
    const pixel = new Float32Array([-3.4028235e38])[0];
    const tag = normalizeNoData("-3.4028235e+38");
    assert.notEqual(pixel, tag);
    assert.deepEqual(Array.from(encodeTerrariumDem([pixel], tag)), [128, 0, 0, 255]);
  });

  it("still treats a distinct elevation as data", () => {
    assert.deepEqual(Array.from(encodeTerrariumDem([100], -9999)), [128, 100, 0, 255]);
  });

  it("clamps elevations to the representable Terrarium range", () => {
    assert.deepEqual(
      Array.from(encodeTerrariumDem([-100_000, 100_000])),
      [0, 0, 0, 255, 255, 255, 255, 255],
    );
  });
});

describe("GDAL_NODATA parsing", () => {
  it("reads the NUL-terminated ASCII tag GDAL actually writes", () => {
    // Number() returns NaN for this, which would silently disable nodata.
    assert.equal(normalizeNoData(`-9999${String.fromCharCode(0)}`), -9999);
  });

  it("reads a plain string and a numeric tag", () => {
    assert.equal(normalizeNoData("-3.4028235e+38"), -3.4028235e38);
    assert.equal(normalizeNoData(0), 0);
  });

  it("reports no sentinel for absent or unparsable tags", () => {
    assert.equal(normalizeNoData(undefined), null);
    assert.equal(normalizeNoData("nan"), null);
    assert.equal(normalizeNoData(Number.NaN), null);
  });
});

describe("overview IFD selection", () => {
  it("keeps only reduced-resolution IFDs after the base image", () => {
    // A second full-resolution IFD (0) must not pass as an overview (1).
    assert.deepEqual([0, 0, 1].map(isDemOverviewIfd), [false, false, true]);
  });

  it("rejects transparency masks, including reduced-resolution ones", () => {
    assert.equal(isDemOverviewIfd(0b100), false);
    assert.equal(isDemOverviewIfd(0b101), false);
  });

  it("treats an absent or unreadable tag as not an overview", () => {
    assert.equal(isDemOverviewIfd(undefined), false);
    assert.equal(isDemOverviewIfd("overview"), false);
  });
});

describe("terrain tile placement", () => {
  // A 1000 x 1000 image over a square extent, and the tile that covers it.
  const source = [0, 0, 1000, 1000];

  it("reads the whole image into the whole tile when the extents match", () => {
    assert.deepEqual(demTilePlacement(source, source, 1000, 1000), {
      window: [0, 0, 1000, 1000],
      destLeft: 0,
      destTop: 0,
      destWidth: 256,
      destHeight: 256,
    });
  });

  it("places a partial overlap in its own quadrant instead of stretching it", () => {
    // The tile extends past the DEM's north and east edges, so the DEM covers
    // the tile's lower-left quarter.
    const placement = demTilePlacement([0, 0, 2000, 2000], source, 1000, 1000);
    assert.deepEqual(placement, {
      window: [0, 0, 1000, 1000],
      destLeft: 0,
      destTop: 128,
      destWidth: 128,
      destHeight: 128,
    });
  });

  it("reads only the overlapping pixels of a tile inside the DEM", () => {
    // The tile's south-west quarter of the DEM: right/bottom half of the image.
    const placement = demTilePlacement([500, 0, 1000, 500], source, 1000, 1000);
    assert.deepEqual(placement, {
      window: [500, 500, 1000, 1000],
      destLeft: 0,
      destTop: 0,
      destWidth: 256,
      destHeight: 256,
    });
  });

  it("keeps the window at least one pixel on a coarse overview", () => {
    // A sliver of a 4 x 4 overview: floor and ceil would land on one boundary.
    const placement = demTilePlacement([0, 0, 1, 1], source, 4, 4);
    assert.equal(placement?.window[2], placement!.window[0] + 1);
    assert.equal(placement?.window[3], placement!.window[1] + 1);
    assert.ok(placement!.destWidth >= 1 && placement!.destHeight >= 1);
  });

  it("reports no placement for a tile that misses the DEM", () => {
    assert.equal(demTilePlacement([2000, 2000, 3000, 3000], source, 1000, 1000), null);
    // Touching along an edge is not an overlap either.
    assert.equal(demTilePlacement([1000, 0, 2000, 1000], source, 1000, 1000), null);
  });
});
