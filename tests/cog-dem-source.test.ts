import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ImageFileDirectory, writeArrayBuffer } from "geotiff";
import {
  demTilePlacement,
  encodeTerrariumDem,
  fileDirectoryValue,
  fillMissingElevations,
  isDemOverviewIfd,
  normalizeNoData,
  projectedBoundsFromTransform,
  projectionFromGeoKeys,
  readProjectedWindowBounded,
  registerCogDemSource,
  resampleProjectedTile,
} from "../packages/map/src/cog-dem-source";
import { resolveEpsgProjection } from "../packages/map/src/epsg-proj4";

describe("COG DEM terrain encoding", () => {
  it("encodes metre and sub-metre elevations as Terrarium RGB", () => {
    assert.deepEqual(
      Array.from(encodeTerrariumDem([-32_768, 0, 1.5, 8_848])),
      [0, 0, 0, 255, 128, 0, 0, 255, 128, 1, 128, 255, 162, 144, 0, 255]
    );
  });

  it("fills nodata and non-finite cells with zero metres", () => {
    assert.deepEqual(
      Array.from(
        encodeTerrariumDem([-9999, Number.NaN, Number.POSITIVE_INFINITY], -9999)
      ),
      [128, 0, 0, 255, 128, 0, 0, 255, 128, 0, 0, 255]
    );
  });

  it("matches a float32 sentinel against a short decimal GDAL_NODATA tag", () => {
    // The pixel holds float32 -3.4028235e38, i.e. -3.4028234663852886e38, while
    // the tag parses to a float64 that is close but not equal.
    const pixel = new Float32Array([-3.4028235e38])[0];
    const tag = normalizeNoData("-3.4028235e+38");
    assert.notEqual(pixel, tag);
    assert.deepEqual(
      Array.from(encodeTerrariumDem([pixel], tag)),
      [128, 0, 0, 255]
    );
  });

  it("still treats a distinct elevation as data", () => {
    assert.deepEqual(
      Array.from(encodeTerrariumDem([100], -9999)),
      [128, 100, 0, 255]
    );
  });

  it("clamps elevations to the representable Terrarium range", () => {
    assert.deepEqual(
      Array.from(encodeTerrariumDem([-100_000, 100_000])),
      [0, 0, 0, 255, 255, 255, 255, 255]
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
    assert.equal(
      demTilePlacement([2000, 2000, 3000, 3000], source, 1000, 1000),
      null
    );
    // Touching along an edge is not an overlap either.
    assert.equal(
      demTilePlacement([1000, 0, 2000, 1000], source, 1000, 1000),
      null
    );
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
      0
    );
    assert.equal(
      (directory as unknown as Record<string, unknown>).GDAL_NODATA,
      undefined
    );
    assert.equal(
      isDemOverviewIfd(fileDirectoryValue(directory, "NewSubfileType")),
      true
    );
    assert.equal(
      normalizeNoData(fileDirectoryValue(directory, "GDAL_NODATA")),
      -9999
    );
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
      "EPSG:32617"
    );
    assert.equal(
      projectionFromGeoKeys({
        GTModelTypeGeoKey: 1,
        ProjectedCSTypeGeoKey: 32767,
        GeographicTypeGeoKey: 4326,
      }),
      null
    );
    assert.equal(
      projectionFromGeoKeys({
        GTModelTypeGeoKey: 1,
        ProjectedCSTypeGeoKey: 3857,
        GeographicTypeGeoKey: 4326,
      }),
      "EPSG:3857"
    );
    assert.equal(
      projectionFromGeoKeys({
        GTModelTypeGeoKey: 2,
        GeographicTypeGeoKey: 4326,
      }),
      "EPSG:4326"
    );
    assert.equal(
      projectionFromGeoKeys({
        GTModelTypeGeoKey: 2,
        GeographicTypeGeoKey: 4269,
      }),
      "EPSG:4269"
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
    const utmBounds: [number, number, number, number] = [
      230_000, 3_970_000, 240_000, 3_980_000,
    ];
    const wgs = projectedBoundsFromTransform(utmBounds, (c) =>
      toWgs84.forward(c)
    );
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
    const tile = resampleProjectedTile(
      dem,
      width,
      height,
      utmBounds,
      mercBounds,
      (c) => mercToUtm.forward(c)
    );
    assert.equal(tile.length, 256 * 256);
    // Center pixel maps to UTM x=235,000 -> halfway across the 64-col ramp (~564 m).
    const centerElev = tile[128 * 256 + 128];
    assert.ok(
      Number.isFinite(centerElev) && Math.abs(centerElev - 564) <= 6,
      `expected ~564 m at center, got ${centerElev}`
    );
    // East edge of the Mercator tile must be higher than west edge.
    const westElev = tile[128 * 256 + 16];
    const eastElev = tile[128 * 256 + 240];
    assert.ok(
      eastElev > westElev + 20,
      `expected east (${eastElev}) > west (${westElev})`
    );
  });

  it("preserves south-up orientation and RasterPixelIsPoint half-pixel alignment", () => {
    // South-up 2x2 grid: row 0 is south (100 m), row 1 is north (300 m).
    const southUp = new Float32Array([100, 110, 300, 310]);
    const mercBounds: [number, number, number, number] = [0, 0, 20, 20];
    const tile = resampleProjectedTile(
      southUp,
      2,
      2,
      mercBounds,
      mercBounds,
      (c) => c,
      {
        originX: 0,
        originY: 0,
        resX: 10,
        resY: 10,
      }
    );
    // Row 0 of the Mercator tile is north (y ≈ 20) -> must sample south-up row 1 (300 m).
    assert.equal(tile[10 * 256 + 10], 300);
    // Row 245 of the Mercator tile is south (y ≈ 0) -> must sample south-up row 0 (100 m).
    assert.equal(tile[245 * 256 + 10], 100);

    // RasterPixelIsPoint: postings at x=0 (10 m) and x=10 (20 m); x=7 belongs to posting 1 (20 m).
    const pointGrid = new Float32Array([10, 20]);
    const ptTile = resampleProjectedTile(
      pointGrid,
      2,
      1,
      [-5, 0, 15, 10],
      [0, 0, 10, 10],
      (c) => c,
      {
        originX: -5,
        originY: 10,
        resX: 10,
        resY: -10,
      }
    );
    // col 179 of 256 spans x ≈ 7.0 -> must pick posting 1 (20 m); col 50 spans x ≈ 2.0 -> posting 0 (10 m).
    assert.equal(ptTile[128 * 256 + 50], 10);
    assert.equal(ptTile[128 * 256 + 179], 20);
  });

  it("registers a north-up UTM GeoTIFF via registerCogDemSource and renders a partially overlapping tile with fallback", async () => {
    const width = 16;
    const height = 16;
    const scale = 500; // 500 m pixels -> 8 km x 8 km
    const originX = 230_000;
    const originY = 3_980_000;
    const values = new Float32Array(width * height);
    for (let r = 0; r < height; r += 1) {
      for (let c = 0; c < width; c += 1) {
        values[r * width + c] = 200 + r * 20 + c * 5;
      }
    }
    const tiffBuffer = await writeArrayBuffer(values, {
      width,
      height,
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
      ProjectedCSTypeGeoKey: 32617,
      ModelTiepoint: [0, 0, 0, originX, originY, 0],
      ModelPixelScale: [scale, scale, 0],
    });
    const reg = await registerCogDemSource(new Blob([tiffBuffer]));
    try {
      assert.ok(reg.bounds);
      // Fill outside-DEM pixels with a known 42 m fallback elevation.
      reg.setFallback?.(async () => new Float64Array(256 * 256).fill(42));
      // Zoom 11 tile covering Knoxville (~-83.95°, 35.9°) partially overlaps the 8 km DEM.
      const z = 11;
      const lon = (reg.bounds[0] + reg.bounds[2]) / 2;
      const lat = (reg.bounds[1] + reg.bounds[3]) / 2;
      const n = 2 ** z;
      const tileX = Math.floor(((lon + 180) / 360) * n);
      const latRad = (lat * Math.PI) / 180;
      const tileY = Math.floor(
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) /
          2) *
          n
      );
      const rgba = await reg.renderTile(z, tileX, tileY);
      const decodeTerrarium = (idx: number) =>
        rgba[idx * 4] * 256 +
        rgba[idx * 4 + 1] +
        rgba[idx * 4 + 2] / 256 -
        32768;

      let insideCount = 0;
      let fallbackCount = 0;
      for (let i = 0; i < 256 * 256; i += 1) {
        const elev = decodeTerrarium(i);
        if (Math.abs(elev - 42) < 0.05) fallbackCount += 1;
        else if (elev >= 199 && elev <= 600) insideCount += 1;
      }
      assert.ok(
        insideCount > 100,
        `expected >100 DEM pixels inside overlap, got ${insideCount}`
      );
      assert.ok(
        fallbackCount > 100,
        `expected >100 fallback pixels outside overlap, got ${fallbackCount}`
      );
    } finally {
      reg.dispose();
    }
  });

  it("reads signed ModelTransformation north-up DEMs and rejects rotated/sheared transforms", async () => {
    const width = 8;
    const height = 8;
    const values = new Float32Array(width * height);
    for (let r = 0; r < height; r += 1) {
      for (let c = 0; c < width; c += 1) {
        values[r * width + c] = 300 + r * 15 + c * 5;
      }
    }
    // North-up UTM 17N DEM encoded via 4x4 ModelTransformation with negative Y scale (-500).
    const northUpMatrixBuffer = await writeArrayBuffer(values, {
      width,
      height,
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
      ProjectedCSTypeGeoKey: 32617,
      ModelTransformation: [
        500, 0, 0, 230_000, 0, -500, 0, 3_980_000, 0, 0, 0, 0, 0, 0, 0, 1,
      ],
    });
    const reg = await registerCogDemSource(new Blob([northUpMatrixBuffer]));
    try {
      assert.ok(reg.bounds);
      const z = 12;
      const lon = (reg.bounds[0] + reg.bounds[2]) / 2;
      const lat = (reg.bounds[1] + reg.bounds[3]) / 2;
      const n = 2 ** z;
      const tileX = Math.floor(((lon + 180) / 360) * n);
      const latRad = (lat * Math.PI) / 180;
      const tileY = Math.floor(
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) /
          2) *
          n
      );
      const rgba = await reg.renderTile(z, tileX, tileY);
      const decodeTerrarium = (idx: number) =>
        rgba[idx * 4] * 256 +
        rgba[idx * 4 + 1] +
        rgba[idx * 4 + 2] / 256 -
        32768;
      let valid = 0;
      for (let i = 0; i < 256 * 256; i += 1) {
        const elev = decodeTerrarium(i);
        if (elev >= 299 && elev <= 500) valid += 1;
      }
      assert.ok(
        valid > 100,
        `expected >100 DEM pixels from ModelTransformation, got ${valid}`
      );
    } finally {
      reg.dispose();
    }

    // Rotated/sheared ModelTransformation (off-diagonal terms != 0) must be rejected.
    const rotatedBuffer = await writeArrayBuffer(values, {
      width,
      height,
      GTModelTypeGeoKey: 1,
      GTRasterTypeGeoKey: 1,
      ProjectedCSTypeGeoKey: 32617,
      ModelTransformation: [
        500, 50, 0, 230_000, 50, -500, 0, 3_980_000, 0, 0, 0, 0, 0, 0, 0, 1,
      ],
    });
    await assert.rejects(
      () => registerCogDemSource(new Blob([rotatedBuffer])),
      /without rotation or shear/
    );
  });

  it("preserves native unit conversion factors (e.g. EPSG:4807 grads) in bounds and tile resampling", async () => {
    const resolved = await resolveEpsgProjection(4807);
    assert.ok(resolved);
    assert.equal(resolved.conversionFactors.x, 0.9);
    assert.equal(resolved.conversionFactors.y, 0.9);

    // 4x4 DEM in EPSG:4807 (NTF Paris, grads): lon 0..2 grads (near Paris ~2.337°E),
    // lat 50..52 grads (45.0°N..46.8°N). Without the 0.9 factor, lat would land at 50..52°N.
    const width = 4;
    const height = 4;
    const values = new Float32Array(width * height).fill(250);
    const tiffBuffer = await writeArrayBuffer(values, {
      width,
      height,
      GTModelTypeGeoKey: 2,
      GTRasterTypeGeoKey: 1,
      GeographicTypeGeoKey: 4807,
      ModelTiepoint: [0, 0, 0, 0, 52, 0],
      ModelPixelScale: [0.5, 0.5, 0],
    });
    const reg = await registerCogDemSource(new Blob([tiffBuffer]));
    try {
      assert.ok(reg.bounds);
      // 50 grads = 45.0 deg, 52 grads = 46.8 deg
      assert.ok(
        reg.bounds[1] > 44.5 && reg.bounds[1] < 45.5,
        `expected south bound near 45°N, got ${reg.bounds[1]}`
      );
      assert.ok(
        reg.bounds[3] > 46.3 && reg.bounds[3] < 47.3,
        `expected north bound near 46.8°N, got ${reg.bounds[3]}`
      );
      // Sample a tile near the center (~3.2°E, 45.9°N) and confirm DEM pixels are read.
      const z = 8;
      const lon = (reg.bounds[0] + reg.bounds[2]) / 2;
      const lat = (reg.bounds[1] + reg.bounds[3]) / 2;
      const n = 2 ** z;
      const tileX = Math.floor(((lon + 180) / 360) * n);
      const latRad = (lat * Math.PI) / 180;
      const tileY = Math.floor(
        ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) /
          2) *
          n
      );
      const rgba = await reg.renderTile(z, tileX, tileY);
      const decodeTerrarium = (idx: number) =>
        rgba[idx * 4] * 256 +
        rgba[idx * 4 + 1] +
        rgba[idx * 4 + 2] / 256 -
        32768;
      let matching = 0;
      for (let i = 0; i < 256 * 256; i += 1) {
        if (Math.abs(decodeTerrarium(i) - 250) < 0.5) matching += 1;
      }
      assert.ok(
        matching > 1000,
        `expected >1000 DEM pixels near 250 m, got ${matching}`
      );
    } finally {
      reg.dispose();
    }
  });

  it("groups chunked DEM reads by storage block and samples exact centred columns without resize bias", async () => {
    const imgW = 32;
    const imgH = 16;
    const calls: Array<{
      window: [number, number, number, number];
      width?: number;
      height?: number;
    }> = [];
    const fakeImage = {
      getTileHeight: () => 4,
      getTileWidth: () => 8,
      readRasters: async (opts: {
        window: [number, number, number, number];
        width?: number;
        height?: number;
      }) => {
        calls.push({
          window: opts.window,
          width: opts.width,
          height: opts.height,
        });
        const [l, t, r, b] = opts.window;
        const w = r - l;
        const h = b - t;
        const out = new Float32Array(w * h);
        for (let row = 0; row < h; row += 1) {
          for (let col = 0; col < w; col += 1) {
            // Encode exact native (row, col) into value: row * 1000 + col.
            out[row * w + col] = (t + row) * 1000 + (l + col);
          }
        }
        return out;
      },
    };

    // Budget = 256 native pixels -> for winW=32, maxChunkRows=8 (2 storage blocks of height 4).
    // Reading 32x16 -> 4x4 should take 2 storage-block-aligned chunk reads, NOT 4 row reads,
    // and never request geotiff horizontal/vertical resize.
    const out = await readProjectedWindowBounded(
      fakeImage as never,
      [0, 0, imgW, imgH],
      4,
      4,
      0,
      256
    );
    assert.equal(
      calls.length,
      2,
      `expected 2 block-aligned chunk reads, got ${calls.length}`
    );
    for (const c of calls) {
      assert.equal(
        c.width,
        undefined,
        "must read native resolution without geotiff horizontal resize"
      );
      assert.equal(
        c.height,
        undefined,
        "must read native resolution without geotiff vertical resize"
      );
      const [l, t, r, b] = c.window;
      assert.ok(
        (r - l) * (b - t) <= 256,
        "each read must stay within native pixel budget"
      );
    }
    // Cell (0, 0) centre is at native col floor(0.5/4 * 32)=4, native row floor(0.5/4 * 16)=2 -> 2004.
    assert.equal(out[0], 2004);
    // Cell (0, 1) centre is at native col floor(1.5/4 * 32)=12, native row 2 -> 2012.
    assert.equal(out[1], 2012);
    // Cell (3, 3) centre is at native col floor(3.5/4 * 32)=28, native row floor(3.5/4 * 16)=14 -> 14028.
    assert.equal(out[15], 14028);
  });
});
