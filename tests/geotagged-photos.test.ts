import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPhotoProperties,
  isPhotoDropFileName,
  isPhotoFileName,
  isValidLngLat,
  PHOTO_IMAGE_EXTENSIONS,
} from "../apps/geolibre-desktop/src/lib/geotagged-photos";
import { PHOTO_PROPERTY } from "../apps/geolibre-desktop/src/lib/field-collection";

describe("isPhotoFileName", () => {
  it("accepts the supported image extensions, case-insensitively", () => {
    for (const ext of PHOTO_IMAGE_EXTENSIONS) {
      assert.ok(isPhotoFileName(`photo.${ext}`), ext);
      assert.ok(isPhotoFileName(`PHOTO.${ext.toUpperCase()}`), ext);
    }
  });

  it("rejects non-image files", () => {
    assert.equal(isPhotoFileName("data.geojson"), false);
    assert.equal(isPhotoFileName("notes.txt"), false);
    assert.equal(isPhotoFileName("noextension"), false);
  });
});

describe("isPhotoDropFileName", () => {
  it("auto-detects unambiguous photo extensions on drop", () => {
    assert.ok(isPhotoDropFileName("a.jpg"));
    assert.ok(isPhotoDropFileName("a.jpeg"));
    assert.ok(isPhotoDropFileName("a.png"));
    assert.ok(isPhotoDropFileName("a.webp"));
    assert.ok(isPhotoDropFileName("a.heic"));
  });

  it("leaves TIFF to the raster drop path", () => {
    assert.equal(isPhotoDropFileName("scene.tif"), false);
    assert.equal(isPhotoDropFileName("scene.tiff"), false);
  });
});

describe("isValidLngLat", () => {
  it("accepts in-range coordinates", () => {
    assert.ok(isValidLngLat(-122.4, 37.8));
    assert.ok(isValidLngLat(0, 51.5));
  });

  it("rejects out-of-range, non-finite, and exact null-island values", () => {
    assert.equal(isValidLngLat(200, 10), false);
    assert.equal(isValidLngLat(10, 200), false);
    assert.equal(isValidLngLat(Number.NaN, 10), false);
    assert.equal(isValidLngLat(undefined, 10), false);
    assert.equal(isValidLngLat(0, 0), false);
  });
});

describe("buildPhotoProperties", () => {
  it("includes only the EXIF fields that are present", () => {
    const props = buildPhotoProperties(
      "IMG_0001.jpg",
      {
        latitude: 37.8,
        longitude: -122.4,
        GPSAltitude: 12.345,
        GPSImgDirection: 89.96,
        DateTimeOriginal: new Date("2026-06-24T10:00:00.000Z"),
        Make: "Canon",
        Model: "EOS R5",
      },
      "data:image/jpeg;base64,AAAA",
    );
    assert.equal(props.name, "IMG_0001.jpg");
    assert.equal(props[PHOTO_PROPERTY], "data:image/jpeg;base64,AAAA");
    assert.equal(props.timestamp, "2026-06-24T10:00:00.000Z");
    assert.equal(props.altitude, 12.35);
    assert.equal(props.direction, 90);
    assert.equal(props.camera, "Canon EOS R5");
  });

  it("omits the photo key and absent metadata", () => {
    const props = buildPhotoProperties("a.heic", { latitude: 1, longitude: 2 }, null);
    assert.equal(props.name, "a.heic");
    assert.ok(!(PHOTO_PROPERTY in props));
    assert.ok(!("timestamp" in props));
    assert.ok(!("altitude" in props));
    assert.ok(!("direction" in props));
    assert.ok(!("camera" in props));
  });

  it("falls back to CreateDate and trims a make-only camera", () => {
    const props = buildPhotoProperties(
      "b.jpg",
      { latitude: 1, longitude: 2, CreateDate: "2026:01:02 03:04:05", Make: "Sony" },
      null,
    );
    assert.equal(props.timestamp, "2026:01:02 03:04:05");
    assert.equal(props.camera, "Sony");
  });
});
