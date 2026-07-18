import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FeatureCollection, Point } from "geojson";
import {
  base64FromBytes,
  buildPhotoProperties,
  createFullResolutionDataUrl,
  MAX_FULL_RESOLUTION_BYTES,
  isPhotoDropFileName,
  isPhotoFileName,
  isValidLngLat,
  loadPhotosAtLocation,
  PHOTO_IMAGE_EXTENSIONS,
  relocatePhotoFeatures,
} from "../apps/geolibre-desktop/src/lib/geotagged-photos";
import {
  PHOTO_FULL_PROPERTY,
  PHOTO_PROPERTY,
} from "../apps/geolibre-desktop/src/lib/field-collection";

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
  it("returns the narrowed pair for in-range coordinates", () => {
    assert.deepEqual(isValidLngLat(-122.4, 37.8), { lng: -122.4, lat: 37.8 });
    assert.deepEqual(isValidLngLat(0, 51.5), { lng: 0, lat: 51.5 });
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
    assert.ok(!(PHOTO_FULL_PROPERTY in props));
    assert.ok(!("timestamp" in props));
    assert.ok(!("altitude" in props));
    assert.ok(!("direction" in props));
    assert.ok(!("camera" in props));
  });

  it("stores the full-resolution image under its own key when provided", () => {
    const props = buildPhotoProperties(
      "big.jpg",
      { latitude: 1, longitude: 2 },
      "data:image/jpeg;base64,THUMB",
      "data:image/jpeg;base64,ORIGINAL",
    );
    assert.equal(props[PHOTO_PROPERTY], "data:image/jpeg;base64,THUMB");
    assert.equal(props[PHOTO_FULL_PROPERTY], "data:image/jpeg;base64,ORIGINAL");
  });

  it("omits the full-resolution key when only a thumbnail is given", () => {
    const props = buildPhotoProperties(
      "small.jpg",
      { latitude: 1, longitude: 2 },
      "data:image/jpeg;base64,THUMB",
    );
    assert.equal(props[PHOTO_PROPERTY], "data:image/jpeg;base64,THUMB");
    assert.ok(!(PHOTO_FULL_PROPERTY in props));
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

  it("negates altitude when the GPS altitude ref marks below sea level", () => {
    const numberRef = buildPhotoProperties(
      "below.jpg",
      { latitude: 36, longitude: -116.8, GPSAltitude: 85, GPSAltitudeRef: 1 },
      null,
    );
    assert.equal(numberRef.altitude, -85);

    // exifr can hand the ref back as a single-element byte array.
    const arrayRef = buildPhotoProperties(
      "below2.jpg",
      {
        latitude: 36,
        longitude: -116.8,
        GPSAltitude: 85,
        GPSAltitudeRef: new Uint8Array([1]),
      },
      null,
    );
    assert.equal(arrayRef.altitude, -85);
  });

  it("collapses internal whitespace in the camera string", () => {
    const props = buildPhotoProperties(
      "c.jpg",
      { latitude: 1, longitude: 2, Make: "Canon ", Model: " EOS R5" },
      null,
    );
    assert.equal(props.camera, "Canon EOS R5");
  });
});

describe("base64FromBytes", () => {
  it("encodes bytes the same as Buffer's base64, including chunk boundaries", () => {
    // A payload past the 0x8000 chunk size exercises the chunked loop.
    const bytes = new Uint8Array(0x8000 + 500);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31) & 0xff;
    assert.equal(base64FromBytes(bytes), Buffer.from(bytes).toString("base64"));
  });

  it("handles an empty input", () => {
    assert.equal(base64FromBytes(new Uint8Array(0)), "");
  });
});

describe("createFullResolutionDataUrl", () => {
  it("embeds the original bytes with the MIME from the magic bytes", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x42]);
    const url = await createFullResolutionDataUrl(new Blob([bytes]), "IMG_1234.JPG");
    assert.equal(url, `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`);
  });

  it("recognizes PNG and WebP signatures, case-insensitively", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(
      (await createFullResolutionDataUrl(new Blob([png]), "a.PNG"))?.startsWith(
        "data:image/png;base64,",
      ),
    );
    // "RIFF" + 4 size bytes + "WEBP".
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    assert.ok(
      (await createFullResolutionDataUrl(new Blob([webp]), "a.webp"))?.startsWith(
        "data:image/webp;base64,",
      ),
    );
  });

  it("derives the MIME from the bytes when the extension is mislabeled", async () => {
    // JPEG magic bytes (FF D8 FF) in a file named .png must yield image/jpeg,
    // not image/png, so the data URL stays decodable.
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const url = await createFullResolutionDataUrl(new Blob([jpegBytes]), "mislabeled.png");
    assert.ok(url?.startsWith("data:image/jpeg;base64,"), url ?? "null");
  });

  it("skips full-res for unrecognized bytes under a supported extension", async () => {
    // A GIF (magic GIF89a) saved as .jpg decodes for a thumbnail but must not be
    // embedded as image/jpeg, which would be undecodable.
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    assert.equal(await createFullResolutionDataUrl(new Blob([gif]), "actually-a.jpg"), null);
  });

  it("falls back to thumbnail-only for a pathologically large original", async () => {
    // A fake Blob reporting a size over the ceiling (no allocation) must be
    // skipped without reading its bytes.
    const oversize = {
      size: MAX_FULL_RESOLUTION_BYTES + 1,
      arrayBuffer: async () => {
        throw new Error("must not read bytes past the size ceiling");
      },
    } as unknown as Blob;
    assert.equal(await createFullResolutionDataUrl(oversize, "huge.jpg"), null);
  });

  it("returns null for formats a browser can't show at full size", async () => {
    const blob = new Blob([new Uint8Array([0])]);
    assert.equal(await createFullResolutionDataUrl(blob, "scene.tif"), null);
    assert.equal(await createFullResolutionDataUrl(blob, "photo.heic"), null);
    assert.equal(await createFullResolutionDataUrl(blob, "noext"), null);
  });
});

describe("relocatePhotoFeatures", () => {
  const collection: FeatureCollection<Point> = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-100, 40] },
        properties: { name: "a.jpg", [PHOTO_PROPERTY]: "data:image/jpeg;a" },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-100, 40] },
        properties: { name: "b.jpg", camera: "Canon" },
      },
    ],
  };

  it("moves every feature to the new position and keeps properties", () => {
    const moved = relocatePhotoFeatures(collection, [-122.4, 37.8]);
    assert.equal(moved.features.length, 2);
    for (const feature of moved.features) {
      assert.deepEqual(feature.geometry.coordinates, [-122.4, 37.8]);
    }
    assert.equal(moved.features[0].properties?.[PHOTO_PROPERTY], "data:image/jpeg;a");
    assert.equal(moved.features[1].properties?.camera, "Canon");
  });

  it("does not mutate the source collection", () => {
    relocatePhotoFeatures(collection, [0, 0]);
    assert.deepEqual(collection.features[0].geometry.coordinates, [-100, 40]);
    assert.deepEqual(collection.features[1].geometry.coordinates, [-100, 40]);
  });
});

describe("loadPhotosAtLocation", () => {
  it("places every photo at the center and never skips one", async () => {
    // A buffer with no EXIF: GPS is absent, so the GPS importer would skip it,
    // but manual placement must still produce a feature at the center. The
    // thumbnail is null here (no canvas decoder under node), which is fine.
    const files = [
      new File([new Uint8Array([0, 1, 2, 3])], "a.jpg", { type: "image/jpeg" }),
      new File([new Uint8Array([4, 5, 6, 7])], "b.jpg", { type: "image/jpeg" }),
    ];
    const result = await loadPhotosAtLocation(files, [-100, 40]);
    assert.equal(result.total, 2);
    assert.equal(result.located, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.featureCollection.features.length, 2);
    for (const feature of result.featureCollection.features) {
      assert.deepEqual(feature.geometry.coordinates, [-100, 40]);
    }
    assert.equal(result.featureCollection.features[0].properties?.name, "a.jpg");
    assert.equal(result.featureCollection.features[1].properties?.name, "b.jpg");
  });
});
