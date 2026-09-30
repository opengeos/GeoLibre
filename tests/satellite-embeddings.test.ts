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
import {
  lonLatBboxToTesseraUtm,
  mergeRanges,
  parseShardIndex,
  percentileRange,
  planTesseraWindow,
  readTesseraBands,
  TESSERA_ZARR_URL,
  tesseraZone,
  tesseraZoneGroup,
  tesseraZoneInfo,
} from "../packages/plugins/src/plugins/satellite-embeddings-tessera";

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

  it("writes a tiled float32 GeoTIFF, padding the edge tiles", async () => {
    const width = 20;
    const height = 18;
    const bands = [0, 1, 2].map((offset) =>
      Float32Array.from({ length: width * height }, (_, index) => index + offset * 1000),
    );
    const parts = encodeGeoTiff({
      width,
      height,
      bands,
      sampleType: "float32",
      epsg: 32633,
      originX: 500_000,
      originY: -1_000_000,
      pixelSizeX: 10,
      pixelSizeY: 10,
      nodata: "nan",
      tileSize: 16,
    });
    const image = await (await fromArrayBuffer(await new Blob(parts).arrayBuffer())).getImage();
    assert.equal(image.isTiled, true);
    assert.equal(image.getTileWidth(), 16);
    assert.deepEqual(image.getBoundingBox(), [500_000, -1_000_180, 500_200, -1_000_000]);
    const rasters = (await image.readRasters({ interleave: false })) as unknown as Float32Array[];
    for (let band = 0; band < 3; band += 1) assert.deepEqual([...rasters[band]], [...bands[band]]);
    assert.throws(() =>
      encodeGeoTiff({
        ...{
          width,
          height,
          bands,
          sampleType: "float32",
          epsg: 32633,
          originX: 0,
          originY: 0,
          pixelSizeX: 10,
          pixelSizeY: 10,
        },
        tileSize: 10,
      }),
    );
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

describe("Tessera v1.1 helpers", () => {
  // Zone 33's group, as the store publishes it.
  const transform = [10, 0, 163840, 0, -10, 9338880];
  const shape = [1826816, 69632];

  it("picks the nominal 6° zone and its group", () => {
    assert.equal(tesseraZone(14.42), 33);
    assert.equal(tesseraZone(-180), 1);
    assert.equal(tesseraZone(179.99), 60);
    assert.equal(tesseraZone(186), 2);
    assert.equal(tesseraZoneGroup(7), "utm07");
  });

  it("plans a window and counts the chunks it touches", () => {
    const plan = planTesseraWindow(transform, shape, [500000, 5540000, 500640, 5540320]);
    assert.ok(plan);
    assert.deepEqual(plan.window, [33616, 379856, 33680, 379888]);
    assert.equal(plan.width, 64);
    assert.equal(plan.height, 32);
    assert.deepEqual(plan.bounds, [500000, 5540000, 500640, 5540320]);
    // Columns 33616–33679 span chunks 1050–1052; rows 379856–379887 span 11870–11871.
    assert.equal(plan.chunkCount, 6);
    assert.equal(planTesseraWindow(transform, shape, [0, 0, 100, 100]), null);
  });

  it("projects south of the equator with negative northings", () => {
    const [, minY, , maxY] = lonLatBboxToTesseraUtm([14.9, -10.1, 15.1, -9.9], 33);
    assert.ok(maxY < 0 && minY < maxY);
  });

  it("reads years complete per hemisphere", () => {
    const info = tesseraZoneInfo(1, {
      "spatial:transform": transform,
      "spatial:shape": shape,
      "geotessera:source_groups": {
        "01N": { years_complete: [2024, 2025] },
        "01S": { years_complete: [2025] },
      },
    });
    assert.deepEqual(info.yearsComplete, { N: [2024, 2025], S: [2025] });
    assert.throws(() => tesseraZoneInfo(1, {}));
  });

  it("stretches each band to its 2nd and 98th percentiles", () => {
    const values = Float32Array.from({ length: 101 }, (_, index) => index);
    assert.deepEqual(percentileRange(values), [2, 98]);
    assert.deepEqual(percentileRange(Float32Array.of(Number.NaN, 5, 5)), [4, 6]);
    assert.equal(percentileRange(Float32Array.of(Number.NaN)), null);
  });

  it("merges shard byte ranges into few requests", () => {
    const ranges = [
      { offset: 300, length: 100, item: "c" },
      { offset: 0, length: 100, item: "a" },
      { offset: 100, length: 100, item: "b" },
      { offset: 10_000, length: 100, item: "d" },
    ];
    const merged = mergeRanges(ranges, 150, 1_000);
    assert.deepEqual(
      merged.map(({ offset, length, items }) => [offset, length, items.map((r) => r.item)]),
      [
        [0, 400, ["a", "b", "c"]],
        [10_000, 100, ["d"]],
      ],
    );
    // A size cap splits a run even without a gap.
    assert.equal(mergeRanges(ranges.slice(1, 3), 0, 150).length, 2);
  });

  it("parses a shard index with missing chunks", () => {
    const bytes = new Uint8Array(2 * 16 + 4);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(0, 42n, true);
    view.setBigUint64(8, 7n, true);
    view.setBigUint64(16, 0xffff_ffff_ffff_ffffn, true);
    view.setBigUint64(24, 0xffff_ffff_ffff_ffffn, true);
    assert.deepEqual(parseShardIndex(bytes), [{ offset: 42, length: 7 }, null]);
  });
});

describe("Tessera reader", () => {
  // A synthetic zone-33 store served from memory: values are a function of the
  // pixel, so the test can check the stride and de-quantization math exactly.
  const transform = [10, 0, 163840, 0, -10, 9338880];
  const shape = [1826816, 69632];
  const year = 2025;
  const time = year - 2017;
  const embedding = (band: number, row: number, col: number): number =>
    ((band * 7 + row * 3 + col) % 200) - 100;
  const scale = (row: number, col: number): number =>
    (row + col) % 11 === 0 ? Number.NaN : Math.fround(0.01 * (1 + ((row + col) % 5)));

  const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
  const arrayMeta = (dataType: string, fill: number | string, chunk: number[], dims: string[]) =>
    json({
      zarr_format: 3,
      node_type: "array",
      shape: dims.length === 4 ? [9, 128, ...shape] : [9, ...shape],
      data_type: dataType,
      chunk_grid: {
        name: "regular",
        configuration: { chunk_shape: chunk.map((d, i) => (i >= chunk.length - 2 ? 4096 : d)) },
      },
      chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
      fill_value: fill,
      codecs: [
        {
          name: "sharding_indexed",
          configuration: {
            chunk_shape: chunk,
            codecs: [{ name: "bytes", configuration: { endian: "little" } }],
            index_codecs: [
              { name: "bytes", configuration: { endian: "little" } },
              { name: "crc32c" },
            ],
            index_location: "end",
          },
        },
      ],
      dimension_names: dims,
    });

  /** A shard holding `chunks` (global chunk coords), back to back, then its index. */
  const shard = (
    chunks: [number, number][],
    encode: (cy: number, cx: number) => Uint8Array,
  ): Uint8Array => {
    const bodies = chunks.map(([cy, cx]) => encode(cy, cx));
    const dataBytes = bodies.reduce((sum, body) => sum + body.byteLength, 0);
    const out = new Uint8Array(dataBytes + 128 * 128 * 16 + 4);
    const view = new DataView(out.buffer);
    for (let index = 0; index < 128 * 128; index += 1) {
      view.setBigUint64(dataBytes + index * 16, 0xffff_ffff_ffff_ffffn, true);
      view.setBigUint64(dataBytes + index * 16 + 8, 0xffff_ffff_ffff_ffffn, true);
    }
    let offset = 0;
    chunks.forEach(([cy, cx], index) => {
      out.set(bodies[index], offset);
      const entry = dataBytes + ((cy % 128) * 128 + (cx % 128)) * 16;
      view.setBigUint64(entry, BigInt(offset), true);
      view.setBigUint64(entry + 8, BigInt(bodies[index].byteLength), true);
      offset += bodies[index].byteLength;
    });
    return out;
  };

  it("reads a window across chunks, de-quantized, in one merged request", async () => {
    const bbox: [number, number, number, number] = [14.997, 49.999, 15.003, 50.001];
    const plan = planTesseraWindow(transform, shape, lonLatBboxToTesseraUtm(bbox, 33))!;
    const [col0, row0, col1, row1] = plan.window;
    const chunks: [number, number][] = [];
    for (let cy = Math.floor(row0 / 32); cy * 32 < row1; cy += 1) {
      for (let cx = Math.floor(col0 / 32); cx * 32 < col1; cx += 1) chunks.push([cy, cx]);
    }
    assert.ok(chunks.length > 1);
    const shardY = Math.floor(chunks[0][0] / 128);
    const shardX = Math.floor(chunks[0][1] / 128);
    assert.ok(
      chunks.every(
        ([cy, cx]) => Math.floor(cy / 128) === shardY && Math.floor(cx / 128) === shardX,
      ),
    );

    const files = new Map<string, Uint8Array>([
      [
        "/utm33/zarr.json",
        json({
          zarr_format: 3,
          node_type: "group",
          attributes: {
            "spatial:transform": transform,
            "spatial:shape": shape,
            "geotessera:source_groups": { "33N": { years_complete: [year] } },
          },
        }),
      ],
      [
        "/utm33/embeddings/zarr.json",
        arrayMeta("int8", 0, [1, 128, 32, 32], ["time", "band", "y", "x"]),
      ],
      ["/utm33/scales/zarr.json", arrayMeta("float32", "NaN", [1, 32, 32], ["time", "y", "x"])],
      [
        `/utm33/embeddings/c/${time}/0/${shardY}/${shardX}`,
        shard(chunks, (cy, cx) => {
          const body = new Int8Array(128 * 32 * 32);
          for (let band = 0; band < 128; band += 1)
            for (let y = 0; y < 32; y += 1)
              for (let x = 0; x < 32; x += 1)
                body[band * 1024 + y * 32 + x] = embedding(band, cy * 32 + y, cx * 32 + x);
          return new Uint8Array(body.buffer);
        }),
      ],
      [
        `/utm33/scales/c/${time}/${shardY}/${shardX}`,
        shard(chunks, (cy, cx) => {
          const body = new Float32Array(32 * 32);
          for (let y = 0; y < 32; y += 1)
            for (let x = 0; x < 32; x += 1) body[y * 32 + x] = scale(cy * 32 + y, cx * 32 + x);
          return new Uint8Array(body.buffer);
        }),
      ],
    ]);

    const requests: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = request.url.slice(TESSERA_ZARR_URL.length);
      const range = request.headers.get("Range");
      requests.push(`${path} ${range ?? ""}`);
      const file = files.get(path);
      if (!file) return new Response(null, { status: 404 });
      if (!range) return new Response(file, { status: 200 });
      const suffix = /^bytes=-(\d+)$/.exec(range);
      const span = /^bytes=(\d+)-(\d+)$/.exec(range);
      const [start, end] = suffix
        ? [file.byteLength - Number(suffix[1]), file.byteLength - 1]
        : [Number(span![1]), Number(span![2])];
      return new Response(file.slice(start, end + 1), { status: 206 });
    }) as typeof fetch;
    try {
      const result = await readTesseraBands(bbox, year, [0, 5, 127]);
      assert.ok(result);
      assert.equal(result.zone, 33);
      assert.deepEqual(result.pixelSize, [10, 10]);
      assert.deepEqual(result.plan.window, plan.window);
      let nan = 0;
      for (let y = 0; y < plan.height; y += 1) {
        for (let x = 0; x < plan.width; x += 1) {
          const row = row0 + y;
          const col = col0 + x;
          const s = scale(row, col);
          [0, 5, 127].forEach((band, channel) => {
            const actual = result.bands[channel][y * plan.width + x];
            if (Number.isNaN(s)) assert.ok(Number.isNaN(actual));
            else assert.equal(actual, Math.fround(embedding(band, row, col) * s));
          });
          if (Number.isNaN(s)) nan += 1;
        }
      }
      assert.ok(nan > 0);
      // One suffix read per shard index, then every wanted chunk in one merged range.
      const embeddingRanges = requests.filter((entry) => /embeddings\/c\/.* bytes=\d/.test(entry));
      assert.equal(embeddingRanges.length, 1);
      assert.equal(requests.filter((entry) => / bytes=-/.test(entry)).length, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
