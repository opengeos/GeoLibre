import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import { writeArrayBuffer } from "geotiff";
import {
  dissolveSegmentPolygons,
  readImageSummary,
  regionGrowingArgs,
  splitImageBands,
  stageBands,
} from "@geolibre/processing";

/** A 3 x 2, 3-band Float32 GeoTIFF with band b holding values b*10 + pixel. */
function threeBandTiff(): ArrayBuffer {
  const width = 3;
  const height = 2;
  const bands = 3;
  const values = new Float32Array(width * height * bands);
  for (let p = 0; p < width * height; p += 1) {
    for (let b = 0; b < bands; b += 1) values[p * bands + b] = (b + 1) * 10 + p;
  }
  return writeArrayBuffer(values, {
    width,
    height,
    ModelPixelScale: [30, 30, 0],
    ModelTiepoint: [0, 0, 0, 500000, 4000000, 0],
    ProjectedCSTypeGeoKey: 32617,
    GTModelTypeGeoKey: 1,
  } as Parameters<typeof writeArrayBuffer>[1]) as ArrayBuffer;
}

describe("OBIA image bands", () => {
  it("reads the size and band count from the header", async () => {
    assert.deepEqual(await readImageSummary(threeBandTiff()), {
      width: 3,
      height: 2,
      bandCount: 3,
    });
  });

  it("splits the chosen bands into single-band GeoTIFFs in order", async () => {
    const image = await splitImageBands(threeBandTiff(), [3, 1]);
    assert.equal(image.bandCount, 3);
    assert.deepEqual(
      image.bands.map((band) => band.index),
      [3, 1],
    );
    const third = await readImageSummary(image.bands[0].bytes);
    assert.equal(third.bandCount, 1);
    assert.equal(third.width, 3);
  });

  it("rejects a band the image does not have", async () => {
    await assert.rejects(splitImageBands(threeBandTiff(), [4]), /no band 4/);
  });
});

describe("OBIA tool args", () => {
  it("stages bands under /work and passes them as a delimited list", () => {
    const { paths, input } = stageBands([
      { index: 2, bytes: new Uint8Array([1]) },
      { index: 4, bytes: new Uint8Array([2]) },
    ]);
    assert.deepEqual(paths, ["/work/band_2.tif", "/work/band_4.tif"]);
    assert.deepEqual(Object.keys(input), ["band_2.tif", "band_4.tif"]);
    assert.deepEqual(regionGrowingArgs(paths, { threshold: 0.8, minArea: 20.4, steps: 10 }), [
      "--inputs=/work/band_2.tif,/work/band_4.tif",
      "--threshold=0.8",
      "--steps=10",
      "--min_area=20",
      "--output=/work/segments.tif",
    ]);
  });
});

describe("dissolveSegmentPolygons", () => {
  const square = (x: number) => [
    [
      [x, 0],
      [x + 1, 0],
      [x + 1, 1],
      [x, 1],
      [x, 0],
    ],
  ];

  it("gives each segment one feature whose id is the segment label", () => {
    const pieces: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { FID: 1, VALUE: 7 },
          geometry: { type: "Polygon", coordinates: square(0) },
        },
        {
          type: "Feature",
          properties: { FID: 2, VALUE: 3 },
          geometry: { type: "Polygon", coordinates: square(2) },
        },
        // A diagonal-only piece of segment 7 comes back as its own polygon.
        {
          type: "Feature",
          properties: { FID: 3, VALUE: 7 },
          geometry: { type: "Polygon", coordinates: square(4) },
        },
        // NoData (label 0) is not an object.
        {
          type: "Feature",
          properties: { FID: 4, VALUE: 0 },
          geometry: { type: "Polygon", coordinates: square(6) },
        },
      ],
    };
    const objects = dissolveSegmentPolygons(pieces);
    assert.deepEqual(
      objects.features.map((f) => [f.id, f.properties?.segment_id, f.geometry.type]),
      [
        [3, 3, "Polygon"],
        [7, 7, "MultiPolygon"],
      ],
    );
  });
});
