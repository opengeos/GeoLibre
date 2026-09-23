import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromArrayBuffer } from "geotiff";
import {
  aefBandName,
  aefHttpsUrl,
  aefTileFromHref,
  aefVrtUrl,
  dequantizeAef,
  dequantizeBand,
  flipRows,
  georefFromTags,
  groupRowRanges,
  lonLatBboxToUtm,
  planAefWindow,
  renderAefRgba,
  utmBoundsToCorners,
} from "../packages/plugins/src/plugins/satellite-embeddings-aef";
import {
  getSatelliteEmbeddingDataset,
  SATELLITE_EMBEDDING_DATASETS,
} from "../packages/plugins/src/plugins/satellite-embeddings-catalog";
import {
  earthIndexFileUrl,
  pcaColors,
  rgbHex,
} from "../packages/plugins/src/plugins/satellite-embeddings-earth-index";
import { encodeGeoTiff } from "../packages/plugins/src/plugins/satellite-embeddings-geotiff";
import {
  intersectBboxes,
  mgrsTileId,
  mgrsTilesForBbox,
  parseUtmEpsg,
  ringBbox,
  sentinel2TileRing,
  tesseraTilesForBbox,
  tesseraTileUrls,
} from "../packages/plugins/src/plugins/satellite-embeddings-grids";

const AEF_HREF =
  "s3://us-west-2.opendata.source.coop/tge-labs/aef/v1/annual/2024/17N/xs5hlzg8b1yjj29ta-0000000000-0000000000.tiff";

// The real georeferencing of that tile: a bottom-up 8192 px UTM 17N block.
const AEF_GEOREF = {
  originX: 172_320,
  originY: 3_932_160,
  resX: 10,
  resY: 10,
  width: 8192,
  height: 8192,
};
const AEF_LEVELS = [8192, 4096, 2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1];

describe("satellite embeddings catalog", () => {
  it("has unique ids and looks datasets up", () => {
    const ids = SATELLITE_EMBEDDING_DATASETS.map((dataset) => dataset.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(getSatelliteEmbeddingDataset("alphaearth").dimensions, 64);
    assert.throws(() => getSatelliteEmbeddingDataset("nope" as never));
  });

  it("links every dataset over https", () => {
    for (const dataset of SATELLITE_EMBEDDING_DATASETS) {
      assert.match(dataset.dataUrl, /^https:\/\//);
      if (dataset.paperUrl) assert.match(dataset.paperUrl, /^https:\/\//);
    }
  });
});

describe("satellite embeddings grids", () => {
  it("parses UTM EPSG codes", () => {
    assert.deepEqual(parseUtmEpsg("EPSG:32617"), { zone: 17, south: false });
    assert.deepEqual(parseUtmEpsg(32760), { zone: 60, south: true });
    assert.equal(parseUtmEpsg("EPSG:4326"), null);
    assert.equal(parseUtmEpsg("EPSG:32661"), null);
  });

  it("intersects boxes", () => {
    assert.deepEqual(intersectBboxes([0, 0, 2, 2], [1, 1, 3, 3]), [1, 1, 2, 2]);
    assert.equal(intersectBboxes([0, 0, 1, 1], [1, 0, 2, 1]), null);
  });

  it("enumerates Tessera 0.1° tiles by their centres", () => {
    const tiles = tesseraTilesForBbox([-0.1, 10.0, 0.1, 10.1]);
    assert.ok(tiles);
    assert.deepEqual(
      tiles.map((tile) => tile.name),
      ["grid_-0.05_10.05", "grid_0.05_10.05"],
    );
    assert.deepEqual(tiles[0].bbox, [-0.1, 10, 0, 10.1]);
    assert.equal(tesseraTilesForBbox([0, 0, 10, 10], 64), null);
  });

  it("builds Tessera URLs", () => {
    const urls = tesseraTileUrls("grid_-0.05_10.05", 2024);
    assert.equal(
      urls.embeddings,
      "https://s3.us-west-2.amazonaws.com/tessera-embeddings/v1/global_0.1_degree_representation/2024/grid_-0.05_10.05/grid_-0.05_10.05.npy",
    );
    assert.match(urls.scales, /grid_-0\.05_10\.05_scales\.npy$/);
  });

  it("finds Sentinel-2 MGRS tile ids", () => {
    // Barcelona is 31TDF, the Earth Index README's own example.
    assert.equal(mgrsTileId(2.17, 41.39), "31TDF");
    assert.equal(mgrsTileId(-83.9, 35.96), "17SKV");
    // Zones below 10 are zero-padded, matching Earth Index file names.
    assert.match(mgrsTileId(-177.5, -50) ?? "", /^01[A-Z]{3}$/);
    assert.equal(mgrsTileId(0, 85), null);
  });

  it("lists the MGRS tiles covering a box", () => {
    const tiles = mgrsTilesForBbox([-84.0, 35.9, -83.8, 36.0]);
    assert.ok(tiles?.includes("17SKV"));
    assert.equal(mgrsTilesForBbox([-180, -80, 180, 84]), null);
  });

  it("draws a Sentinel-2 tile footprint 109.8 km on a side", () => {
    const ring = sentinel2TileRing("17SKV");
    assert.ok(ring);
    const [west, south, east, north] = ringBbox(ring);
    // Earth Index's 17SKV points span roughly these bounds.
    assert.ok(Math.abs(west - -84.31) < 0.05, `west ${west}`);
    assert.ok(Math.abs(south - 35.11) < 0.05, `south ${south}`);
    assert.ok(Math.abs(east - -83.09) < 0.05, `east ${east}`);
    assert.ok(Math.abs(north - 36.12) < 0.05, `north ${north}`);
  });
});

describe("AlphaEarth helpers", () => {
  it("maps index hrefs to tiles", () => {
    const tile = aefTileFromHref(AEF_HREF, "EPSG:32617", [-84, 35.5, -83.7, 36.2]);
    assert.ok(tile);
    assert.equal(tile.url, aefHttpsUrl(AEF_HREF));
    assert.match(tile.url, /^https:\/\/data\.source\.coop\/tge-labs\/aef\//);
    assert.equal(tile.year, 2024);
    assert.equal(tile.utmZone, "17N");
    assert.equal(tile.epsg, 32617);
    assert.equal(tile.id, "2024/17N/xs5hlzg8b1yjj29ta-0000000000-0000000000");
    assert.match(aefVrtUrl(tile.url), /\.vrt$/);
    assert.equal(aefTileFromHref("s3://elsewhere/file.tif", "EPSG:32617", [0, 0, 1, 1]), null);
  });

  it("names bands", () => {
    assert.equal(aefBandName(0), "A00");
    assert.equal(aefBandName(63), "A63");
  });

  it("groups nearby rows into ranges", () => {
    assert.deepEqual(groupRowRanges([1, 2, 3, 10, 5000], 100), [
      [1, 11],
      [5000, 5001],
    ]);
    assert.deepEqual(groupRowRanges([]), []);
  });

  it("reads the georeferencing of a bottom-up COG", () => {
    const transform = [10, 0, 0, 172_320, 0, 10, 0, 3_932_160, 0, 0, 0, 0, 0, 0, 0, 1];
    assert.deepEqual(georefFromTags(8192, 8192, transform, undefined, undefined), AEF_GEOREF);
    const northUp = georefFromTags(100, 50, undefined, [0, 0, 0, 500, 1000, 0], [2, 2, 0]);
    assert.equal(northUp.resY, -2);
    assert.equal(northUp.originY, 1000);
    assert.throws(() => georefFromTags(1, 1, undefined, undefined, undefined));
  });

  it("plans a full-resolution window in a bottom-up raster", () => {
    // A 1 km box 10 km east and 20 km north of the south-west corner.
    const box: [number, number, number, number] = [182_320, 3_952_160, 183_320, 3_953_160];
    const plan = planAefWindow(AEF_GEOREF, box, AEF_LEVELS, 2048);
    assert.ok(plan);
    assert.equal(plan.level, 0);
    assert.deepEqual(plan.window, [1000, 2000, 1100, 2100]);
    assert.deepEqual(plan.bounds, box);
    assert.equal(plan.bottomUp, true);
  });

  it("drops to an overview when the window is too large", () => {
    const whole: [number, number, number, number] = [172_320, 3_932_160, 254_240, 4_014_080];
    const plan = planAefWindow(AEF_GEOREF, whole, AEF_LEVELS, 1024);
    assert.ok(plan);
    assert.equal(plan.level, 3);
    assert.deepEqual(plan.window, [0, 0, 1024, 1024]);
    assert.equal(planAefWindow(AEF_GEOREF, [0, 0, 10, 10], AEF_LEVELS), null);
  });

  it("round-trips a lon/lat box through UTM", () => {
    const utm = lonLatBboxToUtm([-83.95, 35.9, -83.85, 36.0], 32617);
    const corners = utmBoundsToCorners(utm, 32617);
    const lons = corners.map(([lon]) => lon);
    const lats = corners.map(([, lat]) => lat);
    // The UTM box contains the lon/lat box, so its corners sit just outside it.
    assert.ok(Math.min(...lons) <= -83.95 && Math.max(...lons) >= -83.85);
    assert.ok(Math.min(...lats) <= 35.9 && Math.max(...lats) >= 36.0);
    assert.ok(Math.max(...lons) - Math.min(...lons) < 0.12);
  });

  it("de-quantizes like the dataset README", () => {
    assert.ok(Number.isNaN(dequantizeAef(-128)));
    assert.equal(dequantizeAef(0), 0);
    assert.ok(Math.abs(dequantizeAef(127) - (127 / 127.5) ** 2) < 1e-12);
    assert.ok(Math.abs(dequantizeAef(-64) + (64 / 127.5) ** 2) < 1e-12);
    const band = dequantizeBand(new Int8Array([-128, 0, 127]));
    assert.ok(Number.isNaN(band[0]));
    assert.equal(band[1], 0);
  });

  it("renders RGBA with NoData transparent and rows flipped", () => {
    // 1 × 2 image; stored bottom-up, so row 0 is the south pixel.
    const red = new Int8Array([127, -128]);
    const green = new Int8Array([0, -128]);
    const blue = new Int8Array([-127, -128]);
    const rgba = renderAefRgba([red, green, blue], 1, 2, true, 0.3);
    // North pixel (output row 0) is NoData.
    assert.deepEqual([...rgba.slice(0, 4)], [0, 0, 0, 0]);
    // South pixel: saturated red, mid green, zero blue, opaque.
    assert.deepEqual([...rgba.slice(4, 8)], [255, 128, 0, 255]);
  });

  it("flips band rows in place", () => {
    const band = new Int8Array([1, 2, 3, 4, 5, 6]);
    flipRows(band, 2, 3);
    assert.deepEqual([...band], [5, 6, 3, 4, 1, 2]);
  });
});

describe("GeoTIFF encoder", () => {
  it("writes an int8 UTM GeoTIFF geotiff.js can read back", async () => {
    const bands = [new Int8Array([1, -2, 3, -128]), new Int8Array([10, 20, 30, 40])];
    const parts = encodeGeoTiff({
      width: 2,
      height: 2,
      bands,
      sampleType: "int8",
      epsg: 32617,
      originX: 172_320,
      originY: 4_014_080,
      pixelSizeX: 10,
      pixelSizeY: 10,
      nodata: "-128",
      bandNames: ["A00", "A01"],
    });
    const buffer = await new Blob(parts).arrayBuffer();
    const tiff = await fromArrayBuffer(buffer);
    const image = await tiff.getImage();
    assert.equal(image.getWidth(), 2);
    assert.equal(image.getHeight(), 2);
    assert.equal(image.getSamplesPerPixel(), 2);
    assert.deepEqual(image.getBoundingBox(), [172_320, 4_014_060, 172_340, 4_014_080]);
    assert.equal(image.getGeoKeys()?.ProjectedCSTypeGeoKey, 32617);
    assert.equal(image.getGDALNoData(), -128);
    const rasters = await image.readRasters({ interleave: false });
    assert.deepEqual([...(rasters[0] as Int8Array)], [1, -2, 3, -128]);
    assert.deepEqual([...(rasters[1] as Int8Array)], [10, 20, 30, 40]);
    const metadata = await image.getGDALMetadata(1);
    assert.equal(metadata?.DESCRIPTION, "A01");
  });

  it("writes float32 bands", async () => {
    const parts = encodeGeoTiff({
      width: 3,
      height: 1,
      bands: [new Float32Array([0.5, -0.25, Number.NaN])],
      sampleType: "float32",
      epsg: 4326,
      originX: -84,
      originY: 36,
      pixelSizeX: 0.1,
      pixelSizeY: 0.1,
      nodata: "nan",
    });
    const tiff = await fromArrayBuffer(await new Blob(parts).arrayBuffer());
    const image = await tiff.getImage();
    assert.equal(image.getGeoKeys()?.GeographicTypeGeoKey, 4326);
    const [band] = (await image.readRasters({ interleave: false })) as unknown as Float32Array[];
    assert.equal(band[0], 0.5);
    assert.equal(band[1], -0.25);
    assert.ok(Number.isNaN(band[2]));
  });

  it("rejects bands of the wrong size", () => {
    assert.throws(() =>
      encodeGeoTiff({
        width: 2,
        height: 2,
        bands: [new Int8Array(3)],
        sampleType: "int8",
        epsg: 32617,
        originX: 0,
        originY: 0,
        pixelSizeX: 1,
        pixelSizeY: 1,
      }),
    );
  });
});

describe("Earth Index helpers", () => {
  it("builds file URLs", () => {
    assert.equal(
      earthIndexFileUrl("31TDF"),
      "https://data.source.coop/earthgenome/earthindexembeddings/2024/31TDF_2024-01-01_2025-01-01.parquet",
    );
  });

  it("formats colors", () => {
    assert.equal(rgbHex(255, 0, 16), "#ff0010");
  });

  it("colors vectors by principal component", () => {
    // Points spread along one direction: the first component follows it, so
    // the extremes get the lowest and highest first channel.
    const vectors = Array.from({ length: 50 }, (_, index) => [index, index * 2, 0.5, 1]);
    const colors = pcaColors(vectors);
    assert.equal(colors.length, 50);
    const first = colors.map(([red]) => red);
    const increasing = first[49] > first[0];
    assert.equal(Math.min(first[0], first[49]), 0);
    assert.equal(Math.max(first[0], first[49]), 255);
    for (let index = 1; index < 50; index += 1) {
      if (increasing) assert.ok(first[index] >= first[index - 1]);
      else assert.ok(first[index] <= first[index - 1]);
    }
    assert.deepEqual(pcaColors([]), []);
  });
});
