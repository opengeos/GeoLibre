import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_FPS,
  END_HOLD_MS,
  estimateTourDurationMs,
  MAX_FPS,
  MAX_SEGMENT_SECONDS,
  MIN_FPS,
  MIN_SEGMENT_SECONDS,
  parseTourConfig,
  pickSupportedMimeType,
  serializeTourConfig,
  START_HOLD_MS,
  TOUR_CONFIG_TYPE,
  type TourKeyframe,
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

describe("serializeTourConfig / parseTourConfig", () => {
  const keyframes: TourKeyframe[] = [
    {
      id: "a",
      center: [-122.4194, 37.7749],
      zoom: 12.5,
      pitch: 30,
      bearing: 15,
      durationMs: 4000,
    },
    {
      id: "b",
      center: [-73.9857, 40.7484],
      zoom: 14,
      pitch: 0,
      bearing: 0,
      durationMs: 6000,
    },
  ];

  it("round-trips keyframes and fps, dropping the session-local ids", () => {
    const text = serializeTourConfig(keyframes, 30);
    const parsed = JSON.parse(text);
    assert.equal(parsed.type, TOUR_CONFIG_TYPE);
    assert.equal(parsed.fps, 30);
    // Ids are not persisted; they are regenerated on load.
    assert.ok(!("id" in parsed.keyframes[0]));

    const config = parseTourConfig(text);
    assert.equal(config.fps, 30);
    assert.equal(config.keyframes.length, 2);
    assert.deepEqual(config.keyframes[0].center, [-122.4194, 37.7749]);
    assert.equal(config.keyframes[1].durationMs, 6000);
  });

  it("clamps an out-of-range fps and segment durations", () => {
    const text = serializeTourConfig(
      [
        { ...keyframes[0], durationMs: 1 },
        { ...keyframes[1], durationMs: 999_999 },
      ],
      // Above MAX_FPS; serialize clamps on write.
      500,
    );
    const config = parseTourConfig(text);
    assert.equal(config.fps, MAX_FPS);
    assert.equal(config.keyframes[0].durationMs, MIN_SEGMENT_SECONDS * 1000);
    assert.equal(config.keyframes[1].durationMs, MAX_SEGMENT_SECONDS * 1000);
  });

  it("clamps zoom/pitch and wraps bearing into MapLibre's supported ranges", () => {
    const config = parseTourConfig(
      JSON.stringify({
        type: TOUR_CONFIG_TYPE,
        version: 1,
        fps: 30,
        keyframes: [
          { center: [0, 0], zoom: 200, pitch: 270, bearing: 999, durationMs: 2000 },
        ],
      }),
    );
    assert.equal(config.keyframes[0].zoom, 24);
    assert.equal(config.keyframes[0].pitch, 85);
    // Bearing wraps, not clamps: 999 mod 360 = 279 -> 279 - 360 = -81.
    assert.equal(config.keyframes[0].bearing, -81);
  });

  it("wraps a 270 bearing to -90 (west) rather than clamping to 180", () => {
    const config = parseTourConfig(
      JSON.stringify({
        type: TOUR_CONFIG_TYPE,
        version: 1,
        keyframes: [{ center: [0, 0], zoom: 1, pitch: 0, bearing: 270, durationMs: 2000 }],
      }),
    );
    assert.equal(config.keyframes[0].bearing, -90);
    // No fps key in the file, so it falls back to DEFAULT_FPS.
    assert.equal(config.fps, DEFAULT_FPS);
  });

  it("rejects a keyframe with an out-of-range latitude", () => {
    assert.throws(() =>
      parseTourConfig(
        JSON.stringify({
          type: TOUR_CONFIG_TYPE,
          version: 1,
          keyframes: [{ center: [0, 999], zoom: 1, pitch: 0, bearing: 0, durationMs: 2000 }],
        }),
      ),
    );
  });

  it("rejects a file with too many keyframes", () => {
    const keyframes = Array.from({ length: 501 }, () => ({
      center: [0, 0],
      zoom: 1,
      pitch: 0,
      bearing: 0,
      durationMs: 2000,
    }));
    assert.throws(() =>
      parseTourConfig(
        JSON.stringify({ type: TOUR_CONFIG_TYPE, version: 1, keyframes }),
      ),
    );
  });

  it("rejects a file from a newer, unsupported version", () => {
    assert.throws(() =>
      parseTourConfig(
        JSON.stringify({
          type: TOUR_CONFIG_TYPE,
          version: 999,
          keyframes: [{ center: [0, 0], zoom: 1, pitch: 0, bearing: 0, durationMs: 2000 }],
        }),
      ),
    );
  });

  it("rejects a malformed non-numeric version", () => {
    assert.throws(() =>
      parseTourConfig(
        JSON.stringify({
          type: TOUR_CONFIG_TYPE,
          version: "2",
          keyframes: [{ center: [0, 0], zoom: 1, pitch: 0, bearing: 0, durationMs: 2000 }],
        }),
      ),
    );
  });

  it("rejects an unrecognized version below 1", () => {
    assert.throws(() =>
      parseTourConfig(
        JSON.stringify({
          type: TOUR_CONFIG_TYPE,
          version: 0,
          keyframes: [{ center: [0, 0], zoom: 1, pitch: 0, bearing: 0, durationMs: 2000 }],
        }),
      ),
    );
  });

  it("accepts a file with no version field (legacy / hand-written)", () => {
    const config = parseTourConfig(
      JSON.stringify({
        type: TOUR_CONFIG_TYPE,
        keyframes: [{ center: [0, 0], zoom: 1, pitch: 0, bearing: 0, durationMs: 2000 }],
      }),
    );
    assert.equal(config.keyframes.length, 1);
  });

  it("clamps a too-low fps on parse", () => {
    const config = parseTourConfig(
      JSON.stringify({
        type: TOUR_CONFIG_TYPE,
        version: 1,
        fps: 1,
        keyframes: [{ center: [0, 0], zoom: 1, pitch: 0, bearing: 0, durationMs: 2000 }],
      }),
    );
    assert.equal(config.fps, MIN_FPS);
  });

  it("rejects non-JSON text", () => {
    assert.throws(() => parseTourConfig("not json"));
  });

  it("rejects an oversized config file before parsing", () => {
    assert.throws(() => parseTourConfig(" ".repeat(1_000_001)));
  });

  it("rejects a file without the tour marker", () => {
    assert.throws(() =>
      parseTourConfig(JSON.stringify({ keyframes: [], fps: 30 })),
    );
  });

  it("rejects a tour with no keyframes", () => {
    assert.throws(() =>
      parseTourConfig(
        JSON.stringify({ type: TOUR_CONFIG_TYPE, version: 1, keyframes: [] }),
      ),
    );
  });

  it("rejects a keyframe with an invalid center", () => {
    assert.throws(() =>
      parseTourConfig(
        JSON.stringify({
          type: TOUR_CONFIG_TYPE,
          version: 1,
          keyframes: [{ center: [0], zoom: 1, pitch: 0, bearing: 0, durationMs: 2000 }],
        }),
      ),
    );
  });
});
