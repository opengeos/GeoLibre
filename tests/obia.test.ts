import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { FeatureCollection } from "geojson";
import { writeArrayBuffer } from "geotiff";
import { featureSelectionId } from "@geolibre/core";
import { initTools } from "geolibre-wasm/tools";
import {
  collectSamples,
  labelObjects,
  renameObjectClass,
  stratifiedHoldout,
  type ObiaSample,
  addSpectralIndices,
  applyObjectFeatures,
  computeObjectFeatures,
  dissolveSegmentPolygons,
  parseObiaCsv,
  segmentImage,
  sourceBandColumn,
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

describe("OBIA feature tables", () => {
  it("parses the tools' plain CSV", () => {
    assert.deepEqual(parseObiaCsv("segment_id,count\n1,4\n2,9\n"), {
      headers: ["segment_id", "count"],
      rows: [
        ["1", "4"],
        ["2", "9"],
      ],
    });
  });

  it("renames band columns from tool input order to source band numbers", () => {
    assert.equal(sourceBandColumn("mean_b1", [2, 4]), "mean_b2");
    assert.equal(sourceBandColumn("std_b2", [2, 4]), "std_b4");
    assert.equal(sourceBandColumn("area_px", [2, 4]), "area_px");
  });

  it("derives brightness, NDVI and NDWI from the band means", () => {
    const table = {
      fields: ["mean_b1", "mean_b2", "mean_b4"],
      rows: new Map([
        [7, { mean_b1: 20, mean_b2: 40, mean_b4: 60 } as Record<string, number | null>],
      ]),
    };
    addSpectralIndices(table, [1, 2, 4], { red: 1, green: 2, nir: 4 });
    assert.deepEqual(table.fields.slice(3), ["brightness", "ndvi", "ndwi"]);
    assert.deepEqual(table.rows.get(7), {
      mean_b1: 20,
      mean_b2: 40,
      mean_b4: 60,
      brightness: 40,
      ndvi: 0.5,
      ndwi: -0.2,
    });
  });

  it("writes features onto objects, replacing an earlier run but keeping other properties", () => {
    const objects: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: 1,
          properties: { segment_id: 1, class: "water", old_feature: 3 },
          geometry: { type: "Point", coordinates: [0, 0] },
        },
        {
          type: "Feature",
          id: 2,
          properties: { segment_id: 2 },
          geometry: { type: "Point", coordinates: [1, 1] },
        },
      ],
    };
    const table = { fields: ["area_px"], rows: new Map([[1, { area_px: 12 }]]) };
    const out = applyObjectFeatures(objects, table, ["old_feature"]);
    assert.deepEqual(
      out.features.map((f) => f.properties),
      [
        { segment_id: 1, class: "water", area_px: 12 },
        { segment_id: 2, area_px: null },
      ],
    );
  });
});

/** A 2-band 40 x 40 image: a dark left half and a bright right half. */
function twoRegionTiff(): ArrayBuffer {
  const width = 40;
  const height = 40;
  const values = new Float32Array(width * height * 2);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const p = row * width + col;
      const noise = ((row * 7 + col * 3) % 5) * 0.5;
      values[p * 2] = (col < 20 ? 20 : 200) + noise;
      values[p * 2 + 1] = (col < 20 ? 60 : 30) + noise;
    }
  }
  return writeArrayBuffer(values, {
    width,
    height,
    ModelPixelScale: [10, 10, 0],
    ModelTiepoint: [0, 0, 0, 500000, 4000000, 0],
    ProjectedCSTypeGeoKey: 32617,
    GTModelTypeGeoKey: 1,
  } as Parameters<typeof writeArrayBuffer>[1]) as ArrayBuffer;
}

describe("OBIA on the WASM tool engine", () => {
  before(async () => {
    // Under node:test the runner falls back to running tools inline; feed it
    // the bundled wasm bytes (node's fetch has no file scheme).
    await initTools(
      readFileSync(
        fileURLToPath(new URL("../node_modules/geolibre-wasm/geolibre-cli.wasm", import.meta.url)),
      ),
    );
  });

  it("segments, polygonizes and measures a two-region image", async () => {
    const image = await splitImageBands(twoRegionTiff());
    const segmentation = await segmentImage(image, { threshold: 0.5, minArea: 20, steps: 10 });
    assert.equal(segmentation.objectCount, 2);
    assert.deepEqual(
      segmentation.objects.features.map((f) => f.id),
      [1, 2],
    );
    // WGS84 polygons near the UTM 17N origin of the test image.
    const [lng] = (segmentation.objects.features[0].geometry as { coordinates: number[][][] })
      .coordinates[0][0];
    assert.ok(lng > -84 && lng < -78, `longitude ${lng} should be in UTM zone 17`);

    const { table, calls } = await computeObjectFeatures(segmentation.labels, image, {
      spectral: true,
      shape: true,
      context: true,
      indices: { red: 1, nir: 2 },
    });
    assert.deepEqual(
      calls.map((call) => call.tool),
      [
        "object_features_spectral_basic",
        "object_features_shape_basic",
        "object_features_context_neighbors",
      ],
    );
    for (const field of ["mean_b1", "mean_b2", "area_px", "brightness", "ndvi", "neighbor_count"]) {
      assert.ok(table.fields.includes(field), `missing ${field}`);
    }
    const areas = [...table.rows.values()].map((row) => row.area_px);
    assert.deepEqual(areas, [800, 800]);
    const dark = [...table.rows.values()].find((row) => (row.mean_b1 ?? 0) < 100)!;
    assert.ok((dark.ndvi ?? 0) > 0.4, "the dark half is vegetation-like (NIR > red)");
  });
});

describe("OBIA training samples", () => {
  const objects = (n: number): FeatureCollection => ({
    type: "FeatureCollection",
    features: Array.from({ length: n }, (_, i) => ({
      type: "Feature" as const,
      id: i + 1,
      properties: { segment_id: i + 1, ndvi: i / n },
      geometry: { type: "Point" as const, coordinates: [i, 0] },
    })),
  });

  it("labels, renames, collects and clears samples", () => {
    let fc = labelObjects(objects(4), new Set([1, 2]), { className: "tree", role: "training" });
    fc = labelObjects(fc, new Set([3]), { className: "roof", role: "validation" });
    fc = renameObjectClass(fc, "tree", "vegetation");
    assert.deepEqual(collectSamples(fc), [
      { segmentId: 1, className: "vegetation", role: "training" },
      { segmentId: 2, className: "vegetation", role: "training" },
      { segmentId: 3, className: "roof", role: "validation" },
    ]);
    // Features are kept intact apart from the label fields.
    assert.equal(fc.features[0].properties?.ndvi, 0);
    fc = labelObjects(fc, new Set([1]), null);
    assert.deepEqual(
      collectSamples(fc).map((s) => s.segmentId),
      [2, 3],
    );
    assert.equal("obia_sample" in (fc.features[0].properties ?? {}), false);
  });

  it("ignores objects without a usable id", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { obia_class: "x" },
          geometry: { type: "Point", coordinates: [0, 0] },
        },
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [1, 1] } },
      ],
    };
    assert.deepEqual(collectSamples(fc), []);
    const labeled = labelObjects(fc, new Set([Number.NaN]), { className: "y", role: "training" });
    assert.equal(labeled.features[1].properties?.obia_class, undefined);
  });

  it("uses the map selection's ids as segment ids", () => {
    // GeoLibre's selection identifies a feature by featureSelectionId (its
    // feature id, else its index). Objects carry id = segment_id, so the ids
    // the Train step reads from the selection are the segment ids it labels,
    // even when the objects are not in segment order.
    const objects = dissolveSegmentPolygons({
      type: "FeatureCollection",
      features: [9, 4].map((value) => ({
        type: "Feature" as const,
        properties: { VALUE: value },
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [
              [value, 0],
              [value + 1, 0],
              [value + 1, 1],
              [value, 0],
            ],
          ],
        },
      })),
    });
    const selected = objects.features.map((f, i) => Number(featureSelectionId(f, i)));
    assert.deepEqual(selected, [4, 9]);
    const labeled = labelObjects(objects, new Set([9]), { className: "roof", role: "training" });
    assert.deepEqual(collectSamples(labeled), [
      { segmentId: 9, className: "roof", role: "training" },
    ]);
  });

  it("holds out a reproducible, stratified share of each class", () => {
    const samples: ObiaSample[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        segmentId: i + 1,
        className: "a",
        role: "training" as const,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        segmentId: i + 11,
        className: "b",
        role: "training" as const,
      })),
      { segmentId: 20, className: "c", role: "training" },
      { segmentId: 21, className: "a", role: "validation" },
    ];
    const held = stratifiedHoldout(samples, 0.3, 7);
    const inClass = (name: string) =>
      samples.filter((s) => s.className === name && held.has(s.segmentId)).length;
    assert.equal(inClass("a"), 3);
    assert.equal(inClass("b"), 1);
    // A class with one training sample keeps it; validation samples are not candidates.
    assert.equal(inClass("c"), 0);
    assert.equal(held.has(21), false);
    assert.deepEqual([...stratifiedHoldout(samples, 0.3, 7)].sort(), [...held].sort());
    assert.notDeepEqual([...stratifiedHoldout(samples, 0.3, 8)].sort(), [...held].sort());
  });
});
