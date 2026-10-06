import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MARKER_IMAGE_MAX_SIDE,
  markerImageKind,
  markerImageOutputType,
  markerImageTargetSize,
} from "../apps/geolibre-desktop/src/lib/marker-image";

describe("markerImageKind", () => {
  it("classifies by MIME type first", () => {
    assert.equal(markerImageKind("icon", "image/png"), "png");
    assert.equal(markerImageKind("x.png", "image/svg+xml"), "svg");
    assert.equal(markerImageKind("photo", "image/jpeg"), "jpeg");
    assert.equal(markerImageKind("anim", "image/gif"), "gif");
  });

  it("falls back to the extension when the type is empty", () => {
    assert.equal(markerImageKind("Sign.SVG", ""), "svg");
    assert.equal(markerImageKind("photo.jpg", ""), "jpeg");
    assert.equal(markerImageKind("photo.jpeg", ""), "jpeg");
    assert.equal(markerImageKind("logo.png", ""), "png");
  });

  it("rejects unsupported files", () => {
    assert.equal(markerImageKind("map.tif", "image/tiff"), null);
    assert.equal(markerImageKind("notes.txt", "text/plain"), null);
    assert.equal(markerImageKind("noext", ""), null);
  });
});

describe("markerImageTargetSize", () => {
  it("downscales the longest side to the cap, keeping the aspect ratio", () => {
    assert.deepEqual(markerImageTargetSize(1024, 512), {
      width: MARKER_IMAGE_MAX_SIDE,
      height: MARKER_IMAGE_MAX_SIDE / 2,
    });
    assert.deepEqual(markerImageTargetSize(300, 1200, 128), { width: 32, height: 128 });
  });

  it("never upscales a small image", () => {
    assert.deepEqual(markerImageTargetSize(24, 32), { width: 24, height: 32 });
  });

  it("keeps a sliver at least one pixel wide", () => {
    assert.deepEqual(markerImageTargetSize(4000, 1, 128), { width: 128, height: 1 });
  });
});

describe("markerImageOutputType", () => {
  it("keeps JPEG photos as JPEG and stores the rest as PNG", () => {
    assert.equal(markerImageOutputType("jpeg"), "image/jpeg");
    assert.equal(markerImageOutputType("png"), "image/png");
    assert.equal(markerImageOutputType("gif"), "image/png");
  });
});
