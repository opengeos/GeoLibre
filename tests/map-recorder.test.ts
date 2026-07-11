import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeCaptureRect,
  MAP_RECORD_MIME_CANDIDATES,
  pickSupportedMimeType,
  videoExtensionForMime,
} from "../apps/geolibre-desktop/src/lib/map-recorder";

describe("pickSupportedMimeType", () => {
  it("returns the first candidate the browser supports", () => {
    // Only WebM/VP8 is supported here, so MP4 (earlier in the list) is skipped.
    const supported = new Set(["video/webm;codecs=vp8", "video/webm"]);
    const chosen = pickSupportedMimeType(MAP_RECORD_MIME_CANDIDATES, (t) =>
      supported.has(t),
    );
    assert.equal(chosen, "video/webm;codecs=vp8");
  });

  it("prefers MP4 when available", () => {
    const chosen = pickSupportedMimeType(
      MAP_RECORD_MIME_CANDIDATES,
      () => true,
    );
    assert.equal(chosen, "video/mp4;codecs=avc1.42E01E");
  });

  it("returns null when nothing is supported", () => {
    const chosen = pickSupportedMimeType(
      MAP_RECORD_MIME_CANDIDATES,
      () => false,
    );
    assert.equal(chosen, null);
  });
});

describe("videoExtensionForMime", () => {
  it("maps MP4 container types to mp4", () => {
    assert.equal(videoExtensionForMime("video/mp4;codecs=avc1"), "mp4");
    assert.equal(videoExtensionForMime("video/mp4"), "mp4");
  });

  it("maps everything else to webm", () => {
    assert.equal(videoExtensionForMime("video/webm;codecs=vp9"), "webm");
    assert.equal(videoExtensionForMime("video/webm"), "webm");
  });
});

describe("computeCaptureRect", () => {
  it("captures the whole canvas at device resolution when region is null", () => {
    const rect = computeCaptureRect(null, 800, 600, 400);
    assert.deepEqual(rect, {
      sx: 0,
      sy: 0,
      sw: 800,
      sh: 600,
      outW: 800,
      outH: 600,
    });
  });

  it("scales a CSS-pixel region to device pixels using the DPR", () => {
    // 2x DPR: canvas buffer is 800 device px across 400 CSS px.
    const rect = computeCaptureRect(
      { x: 50, y: 25, width: 100, height: 75 },
      800,
      600,
      400,
    );
    assert.ok(rect);
    assert.equal(rect.sx, 100); // 50 * 2
    assert.equal(rect.sy, 50); // 25 * 2
    assert.equal(rect.sw, 200); // 100 * 2
    assert.equal(rect.sh, 150); // 75 * 2
    assert.equal(rect.outW, 200);
    assert.equal(rect.outH, 150);
  });

  it("clamps a region that runs off the canvas edge to the visible part", () => {
    // 1:1 DPR. The region starts inside but extends past the right/bottom edge.
    const rect = computeCaptureRect(
      { x: 700, y: 500, width: 400, height: 400 },
      800,
      600,
      800,
    );
    assert.ok(rect);
    assert.equal(rect.sx, 700);
    assert.equal(rect.sy, 500);
    assert.equal(rect.sw, 100); // clamped 700..800
    assert.equal(rect.sh, 100); // clamped 500..600
  });

  it("forces the output frame to even dimensions for H.264", () => {
    // 1:1 DPR, odd-sized region → output rounded down to even.
    const rect = computeCaptureRect(
      { x: 0, y: 0, width: 101, height: 99 },
      800,
      600,
      800,
    );
    assert.ok(rect);
    assert.equal(rect.sw, 101);
    assert.equal(rect.sh, 99);
    assert.equal(rect.outW, 100);
    assert.equal(rect.outH, 98);
  });

  it("returns null for a degenerate canvas", () => {
    assert.equal(computeCaptureRect(null, 0, 0, 0), null);
    assert.equal(computeCaptureRect(null, 1, 1, 1), null);
  });

  it("returns null for a region smaller than a pixel-pair", () => {
    const rect = computeCaptureRect(
      { x: 10, y: 10, width: 1, height: 1 },
      800,
      600,
      800,
    );
    assert.equal(rect, null);
  });

  it("falls back to 1:1 scale when the CSS width is unknown", () => {
    const rect = computeCaptureRect(
      { x: 10, y: 20, width: 40, height: 30 },
      800,
      600,
      0,
    );
    assert.ok(rect);
    assert.equal(rect.sx, 10);
    assert.equal(rect.sy, 20);
    assert.equal(rect.sw, 40);
    assert.equal(rect.sh, 30);
  });
});
