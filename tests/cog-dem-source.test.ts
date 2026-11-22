import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ImageFileDirectory } from "geotiff";
import {
  demTilePlacement,
  encodeTerrariumDem,
  fileDirectoryValue,
  fillMissingElevations,
  isDemOverviewIfd,
  normalizeNoData,
  projectedBoundsFromTransform,
  projectionFromGeoKeys,
  resampleProjectedTile,
} from "../packages/map/src/cog-dem-source";
import { resolveEpsgProjection } from "../packages/map/src/epsg-proj4";

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

describe("fileDirectoryValue", () => {
  it("reads tags from a geotiff.js 3 ImageFileDirectory", () => {
    // geotiff.js 3 keys actualized fields by numeric tag id behind getValue;
    // indexing the object like a record finds nothing.
    const NEW_SUBFILE_TYPE = 254;
    const GDAL_NODATA = 42113;
    const directory = new ImageFileDirectory(
      new Map<number, number | string>([
        [NEW_SUBFILE_TYPE, 1],
        [GDAL_NODATA, "-9999\0"],
      ]),
      new Map(),
      new Map(),
      0,
    );
    assert.equal((directory as unknown as Record<string, unknown>).GDAL_NODATA, undefined);
    assert.equal(isDemOverviewIfd(fileDirectoryValue(directory, "NewSubfileType")), true);
    assert.equal(normalizeNoData(fileDirectoryValue(directory, "GDAL_NODATA")), -9999);
  });

  it("still reads a plain tag record", () => {
    assert.equal(fileDirectoryValue({ GDAL_NODATA: "0" }, "GDAL_NODATA"), "0");
    assert.equal(fileDirectoryValue(undefined, "GDAL_NODATA"), undefined);
  });
});

describe("fillMissingElevations", () => {
  it("fills NaN and nodata pixels from the fallback and keeps the DEM's own (#3470)", () => {
    const tile = Float64Array.from([100, Number.NaN, -9999, 200]);
    fillMissingElevations(tile, -9999, [1, 2, 3, 4]);
    assert.deepEqual([...tile], [100, 2, 3, 200]);
  });

  it("leaves a pixel missing where the fallback has nothing either", () => {
    const tile = Float64Array.from([Number.NaN]);
    fillMissingElevations(tile, null, [Number.NaN]);
    assert.ok(Number.isNaN(tile[0]));
  });
});

describe("projectionFromGeoKeys", () => {
  it("resolves projected EPSG codes and never misclassifies user-defined projected DEMs as EPSG:4326", () => {
    assert.equal(
      projectionFromGeoKeys({
        GTModelTypeGeoKey: 1,
        ProjectedCSTypeGeoKey: 32617,
        GeographicTypeGeoKey: 4326,
      }),
      "EPSG:32617",
    );
    assert.equal(
      projectionFromGeoKeys({
        GTModelTypeGeoKey: 1,
        ProjectedCSTypeGeoKey: 32767,
        GeographicTypeGeoKey: 4326,
      }),
      null,
    );
    assert.equal(
      projectionFromGeoKeys({
        GTModelTypeGeoKey: 1,
        ProjectedCSTypeGeoKey: 3857,
        GeographicTypeGeoKey: 4326,
      }),
      "EPSG:3857",
    );
    assert.equal(
      projectionFromGeoKeys({
        GTModelTypeGeoKey: 2,
        GeographicTypeGeoKey: 4326,
      }),
      "EPSG:4326",
    );
    assert.equal(
      projectionFromGeoKeys({
        GTModelTypeGeoKey: 2,
        GeographicTypeGeoKey: 4269,
      }),
      "EPSG:4269",
    );
  });
});

describe("projected COG DEM warping", () => {
  it("projects UTM 17N DEM bounds to WGS84 and resamples elevation into Web Mercator tiles", async () => {
    const utm17n = await resolveEpsgProjection(32617);
    assert.ok(utm17n, "EPSG:32617 should resolve from bundled EPSG tables");
    const toWgs84 = utm17n.proj4(utm17n.definition, "EPSG:4326");
    const mercToUtm = utm17n.proj4("EPSG:3857", utm17n.definition);
    const utmToMerc = utm17n.proj4(utm17n.definition, "EPSG:3857");

    // A 10 km x 10 km UTM 17N DEM around Knoxville, TN (~83.9°W, 35.9°N).
    const utmBounds: [number, number, number, number] = [230_000, 3_970_000, 240_000, 3_980_000];
    const wgs = projectedBoundsFromTransform(utmBounds, (c) => toWgs84.forward(c));
    assert.ok(wgs);
    assert.ok(wgs[0] > -85 && wgs[2] < -83, `unexpected lon bounds: ${wgs}`);
    assert.ok(wgs[1] > 35 && wgs[3] < 37, `unexpected lat bounds: ${wgs}`);

    // Build a synthetic 64x64 ramp DEM in UTM meters: elevation = 500 + 2 * col.
    const width = 64;
    const height = 64;
    const dem = new Float32Array(width * height);
    for (let r = 0; r < height; r += 1) {
      for (let c = 0; c < width; c += 1) {
        dem[r * width + c] = 500 + c * 2;
      }
    }
    const mercCenter = utmToMerc.forward([235_000, 3_975_000]);
    const halfSpan = 2_000;
    const mercBounds: [number, number, number, number] = [
      mercCenter[0] - halfSpan,
      mercCenter[1] - halfSpan,
      mercCenter[0] + halfSpan,
      mercCenter[1] + halfSpan,
    ];
    const tile = resampleProjectedTile(dem, width, height, utmBounds, mercBounds, (c) =>
      mercToUtm.forward(c),
    );
    assert.equal(tile.length, 256 * 256);
    // Center pixel maps to UTM x=235,000 -> halfway across the 64-col ramp (~564 m).
    const centerElev = tile[128 * 256 + 128];
    assert.ok(
      Number.isFinite(centerElev) && Math.abs(centerElev - 564) <= 6,
      `expected ~564 m at center, got ${centerElev}`,
    );
    // East edge of the Mercator tile must be higher than west edge.
    const westElev = tile[128 * 256 + 16];
    const eastElev = tile[128 * 256 + 240];
    assert.ok(eastElev > westElev + 20, `expected east (${eastElev}) > west (${westElev})`);
  });
});
