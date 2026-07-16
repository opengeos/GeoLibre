import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CAPTION_POSITIONS,
  captionBoxOrigin,
  captionMetrics,
  computeCaptureRect,
  hasCaptionText,
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

describe("hasCaptionText", () => {
  it("is false for no options, blank, or whitespace-only text", () => {
    assert.equal(hasCaptionText(null), false);
    assert.equal(hasCaptionText(undefined), false);
    assert.equal(
      hasCaptionText({ title: "", caption: "", position: "bottom-left" }),
      false,
    );
    assert.equal(
      hasCaptionText({ title: "  ", caption: "\t", position: "bottom-left" }),
      false,
    );
  });

  it("is true when either the title or the caption has non-blank text", () => {
    assert.equal(
      hasCaptionText({ title: "Hello", caption: "", position: "top-left" }),
      true,
    );
    assert.equal(
      hasCaptionText({ title: " ", caption: "Source", position: "top-left" }),
      true,
    );
  });
});

describe("captionMetrics", () => {
  it("scales the title with the frame height", () => {
    // ~1080p and ~2160p frames get proportionally larger, capped title text.
    assert.ok(captionMetrics(2160).titlePx > captionMetrics(1080).titlePx);
  });

  it("clamps the title size for tiny and huge frames", () => {
    assert.equal(captionMetrics(100).titlePx, 14); // floor
    assert.equal(captionMetrics(100_000).titlePx, 48); // ceiling
  });

  it("derives paddings and the caption line from the title size", () => {
    const m = captionMetrics(1000);
    assert.ok(m.captionPx > 0 && m.captionPx < m.titlePx);
    assert.ok(m.padX > 0 && m.padY > 0 && m.margin > 0);
  });
});

describe("captionBoxOrigin", () => {
  const W = 1920;
  const H = 1080;
  const box = { w: 400, h: 120 };
  const margin = 24;

  it("anchors each corner with the margin inset", () => {
    assert.deepEqual(
      captionBoxOrigin("top-left", box.w, box.h, W, H, margin),
      { x: 24, y: 24 },
    );
    assert.deepEqual(
      captionBoxOrigin("bottom-right", box.w, box.h, W, H, margin),
      { x: W - margin - box.w, y: H - margin - box.h },
    );
  });

  it("centers horizontally for the center positions", () => {
    const top = captionBoxOrigin("top-center", box.w, box.h, W, H, margin);
    assert.equal(top.x, Math.round((W - box.w) / 2));
    assert.equal(top.y, margin);
    const bottom = captionBoxOrigin(
      "bottom-center",
      box.w,
      box.h,
      W,
      H,
      margin,
    );
    assert.equal(bottom.x, Math.round((W - box.w) / 2));
    assert.equal(bottom.y, H - margin - box.h);
  });

  it("pins an over-wide box to the near margin instead of off-canvas", () => {
    // A box wider than the frame can't fit; it stays at the left margin rather
    // than getting a negative x that would float it off-screen.
    const origin = captionBoxOrigin("top-right", 5000, box.h, W, H, margin);
    assert.equal(origin.x, margin);
  });

  it("covers every selectable position without going off-canvas", () => {
    for (const position of CAPTION_POSITIONS) {
      const { x, y } = captionBoxOrigin(position, box.w, box.h, W, H, margin);
      assert.ok(x >= 0 && x + box.w <= W, `${position} x in bounds`);
      assert.ok(y >= 0 && y + box.h <= H, `${position} y in bounds`);
    }
  });
});
