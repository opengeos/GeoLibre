import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  END_HOLD_MS,
  estimateTourDurationMs,
  pickSupportedMimeType,
  START_HOLD_MS,
  TOUR_MIME_CANDIDATES,
} from "../apps/geolibre-desktop/src/lib/tour-recorder";

describe("pickSupportedMimeType", () => {
  it("returns the first candidate the browser supports", () => {
    const supported = new Set(["video/webm;codecs=vp8", "video/webm"]);
    assert.equal(
      pickSupportedMimeType(TOUR_MIME_CANDIDATES, (t) => supported.has(t)),
      "video/webm;codecs=vp8",
    );
  });

  it("prefers vp9 when everything is supported", () => {
    assert.equal(
      pickSupportedMimeType(TOUR_MIME_CANDIDATES, () => true),
      "video/webm;codecs=vp9",
    );
  });

  it("returns null when nothing is supported", () => {
    assert.equal(
      pickSupportedMimeType(TOUR_MIME_CANDIDATES, () => false),
      null,
    );
  });
});

describe("estimateTourDurationMs", () => {
  it("is zero for fewer than two keyframes", () => {
    assert.equal(estimateTourDurationMs([]), 0);
    assert.equal(estimateTourDurationMs([{ durationMs: 4000 }]), 0);
  });

  it("sums the segments after the first plus the start/end holds", () => {
    // First keyframe's duration is ignored (the tour starts parked there).
    const total = estimateTourDurationMs([
      { durationMs: 9999 },
      { durationMs: 3000 },
      { durationMs: 2000 },
    ]);
    assert.equal(total, START_HOLD_MS + 5000 + END_HOLD_MS);
  });

  it("treats negative segment durations as zero", () => {
    const total = estimateTourDurationMs([
      { durationMs: 0 },
      { durationMs: -1000 },
    ]);
    assert.equal(total, START_HOLD_MS + END_HOLD_MS);
  });
});
