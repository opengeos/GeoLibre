import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectionPhotoMimeType,
  detectionsToPhotoFeatureCollection,
  isDetectionPhotoFileName,
} from "../apps/geolibre-desktop/src/lib/object-detection-photo";
import { rasterFromRgba } from "../packages/processing/src/object-detection";

describe("regular photo detection input", () => {
  it("recognizes only the browser-decodable photo formats", () => {
    for (const name of ["photo.jpg", "photo.JPEG", "photo.png", "photo.webp"]) {
      assert.equal(isDetectionPhotoFileName(name), true, name);
    }
    for (const name of ["raster.tif", "photo.heic", "model.onnx", "photo"]) {
      assert.equal(isDetectionPhotoFileName(name), false, name);
    }
    assert.equal(detectionPhotoMimeType("photo.jpeg"), "image/jpeg");
    assert.equal(detectionPhotoMimeType("photo.png"), "image/png");
    assert.equal(detectionPhotoMimeType("photo.webp"), "image/webp");
  });

  it("splits RGBA pixels into three RGB raster bands", () => {
    const raster = rasterFromRgba(2, 1, new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 128]));
    assert.deepEqual(
      raster.bands.map((band) => [...band]),
      [
        [10, 40],
        [20, 50],
        [30, 60],
      ],
    );
    assert.equal(raster.width, 2);
    assert.equal(raster.height, 1);
    assert.deepEqual(raster.geoKeys, {});
  });

  it("rejects an RGBA buffer that does not match its dimensions", () => {
    assert.throws(
      () => rasterFromRgba(2, 2, new Uint8ClampedArray(4)),
      /do not match its dimensions/,
    );
  });
});

describe("photo detection results", () => {
  it("stores detections as GPS points with their pixel boxes", () => {
    const collection = detectionsToPhotoFeatureCollection(
      [
        {
          bbox: [10.123, 20.456, 30.789, 40.987],
          classIndex: 1,
          score: 0.87654,
        },
      ],
      [-122.2585, 37.8719],
      ["person", "bicycle"],
      "campus.jpg",
    );

    assert.deepEqual(collection, {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            class: "bicycle",
            class_index: 1,
            score: 0.8765,
            image_name: "campus.jpg",
            bbox_min_x: 10.12,
            bbox_min_y: 20.46,
            bbox_max_x: 30.79,
            bbox_max_y: 40.99,
          },
          geometry: {
            type: "Point",
            coordinates: [-122.2585, 37.8719],
          },
        },
      ],
    });
  });

  it("falls back to a generated class name", () => {
    const collection = detectionsToPhotoFeatureCollection(
      [{ bbox: [0, 0, 1, 1], classIndex: 3, score: 1 }],
      [1, 2],
      [],
      "photo.png",
    );
    assert.equal(collection.features[0].properties?.class, "class_3");
  });
});
