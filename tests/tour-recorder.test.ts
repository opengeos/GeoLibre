import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_FPS,
  DEFAULT_SEGMENT_SECONDS,
  END_HOLD_MS,
  estimateTourDurationMs,
  countPathCoordinates,
  generateTourKeyframesFromPath,
  MAX_FPS,
  MAX_HOLD_SECONDS,
  MAX_SEGMENT_SECONDS,
  MIN_FPS,
  MIN_HOLD_SECONDS,
  MIN_SEGMENT_SECONDS,
  parseTourConfig,
  pickSupportedMimeType,
  serializeTourConfig,
  START_HOLD_MS,
  TOUR_CONFIG_TYPE,
  TOUR_CONFIG_VERSION,
  type TourKeyframe,
  TOUR_MIME_CANDIDATES,
} from "../apps/geolibre-desktop/src/lib/tour-recorder";
import type { FeatureCollection } from "geojson";

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
  it("is zero with no keyframes", () => {
    assert.equal(estimateTourDurationMs([]), 0);
  });

  it("counts only the hold for a single keyframe (no transition yet)", () => {
    // One keyframe has no successor to transition to, so its transition is
    // ignored, but its hold is still meaningful.
    assert.equal(estimateTourDurationMs([{ holdMs: 1000, transitionMs: 4000 }]), 1000);
  });

  it("sums every hold plus the transition out of all but the last keyframe", () => {
    // The last keyframe's transition is ignored (there is no view after it).
    const total = estimateTourDurationMs([
      { holdMs: 1000, transitionMs: 3000 },
      { holdMs: 500, transitionMs: 2000 },
      { holdMs: 800, transitionMs: 9999 },
    ]);
    assert.equal(total, 1000 + 500 + 800 + 3000 + 2000);
  });

  it("treats negative hold and transition durations as zero", () => {
    const total = estimateTourDurationMs([
      { holdMs: -100, transitionMs: -1000 },
      { holdMs: 0, transitionMs: 0 },
    ]);
    assert.equal(total, 0);
  });
});

describe("generateTourKeyframesFromPath", () => {
  it("samples a LineString into evenly spaced keyframes with path bearings", () => {
    const geojson: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [10, 0],
            ],
          },
        },
      ],
    };

    assert.equal(countPathCoordinates(geojson), 2);
    const keyframes = generateTourKeyframesFromPath(geojson, {
      keyframeCount: 3,
      zoom: 12,
      pitch: 45,
      holdSeconds: 1,
      transitionSeconds: 2,
    });

    assert.equal(keyframes.length, 3);
    assert.deepEqual(
      keyframes.map((kf) => kf.center),
      [
        [0, 0],
        [5, 0],
        [10, 0],
      ],
    );
    assert.deepEqual(
      keyframes.map((kf) => kf.bearing),
      [90, 90, 90],
    );
    assert.equal(keyframes[0].zoom, 12);
    assert.equal(keyframes[0].pitch, 45);
    assert.equal(keyframes[0].holdMs, 1000);
    assert.equal(keyframes[0].transitionMs, 2000);
  });

  it("uses line and geometry collection members and ignores non-line geometry", () => {
    const geojson: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "MultiLineString",
            coordinates: [
              [
                [0, 0],
                [0, 1],
              ],
            ],
          },
        },
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "GeometryCollection",
            geometries: [
              { type: "Point", coordinates: [100, 0] },
              {
                type: "LineString",
                coordinates: [
                  [0, 1],
                  [0, 2],
                ],
              },
            ],
          },
        },
      ],
    };

    assert.equal(countPathCoordinates(geojson), 4);
    const keyframes = generateTourKeyframesFromPath(geojson, {
      keyframeCount: 3,
      zoom: 30,
      pitch: 100,
      holdSeconds: -1,
      transitionSeconds: 100,
    });

    assert.equal(keyframes.length, 3);
    assert.deepEqual(
      keyframes.map((kf) => kf.center),
      [
        [0, 0],
        [0, 1],
        [0, 2],
      ],
    );
    assert.deepEqual(
      keyframes.map((kf) => kf.bearing),
      [0, 0, 0],
    );
    assert.equal(keyframes[0].zoom, 24);
    assert.equal(keyframes[0].pitch, 85);
    assert.equal(keyframes[0].holdMs, MIN_HOLD_SECONDS * 1000);
    assert.equal(keyframes[0].transitionMs, MAX_SEGMENT_SECONDS * 1000);
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
      holdMs: 1000,
      transitionMs: 4000,
    },
    {
      id: "b",
      center: [-73.9857, 40.7484],
      zoom: 14,
      pitch: 0,
      bearing: 0,
      holdMs: 2000,
      transitionMs: 6000,
    },
  ];

  it("round-trips keyframes and fps, dropping the session-local ids", () => {
    const text = serializeTourConfig(keyframes, 30);
    const parsed = JSON.parse(text);
    assert.equal(parsed.type, TOUR_CONFIG_TYPE);
    assert.equal(parsed.version, TOUR_CONFIG_VERSION);
    assert.equal(parsed.fps, 30);
    // Ids are not persisted; they are regenerated on load.
    assert.ok(!("id" in parsed.keyframes[0]));

    const config = parseTourConfig(text);
    assert.equal(config.fps, 30);
    assert.equal(config.keyframes.length, 2);
    assert.deepEqual(config.keyframes[0].center, [-122.4194, 37.7749]);
    assert.equal(config.keyframes[0].holdMs, 1000);
    assert.equal(config.keyframes[1].holdMs, 2000);
    assert.equal(config.keyframes[1].transitionMs, 6000);
  });

  it("clamps an out-of-range fps, hold, and transition", () => {
    const text = serializeTourConfig(
      [
        { ...keyframes[0], holdMs: -500, transitionMs: 1 },
        { ...keyframes[1], holdMs: 999_999, transitionMs: 999_999 },
      ],
      // Above MAX_FPS; serialize clamps on write.
      500,
    );
    const config = parseTourConfig(text);
    assert.equal(config.fps, MAX_FPS);
    assert.equal(config.keyframes[0].holdMs, MIN_HOLD_SECONDS * 1000);
    assert.equal(config.keyframes[0].transitionMs, MIN_SEGMENT_SECONDS * 1000);
    assert.equal(config.keyframes[1].holdMs, MAX_HOLD_SECONDS * 1000);
    assert.equal(config.keyframes[1].transitionMs, MAX_SEGMENT_SECONDS * 1000);
  });

  it("defaults missing hold and transition fields in a v2 file", () => {
    const config = parseTourConfig(
      JSON.stringify({
        type: TOUR_CONFIG_TYPE,
        version: 2,
        keyframes: [{ center: [0, 0], zoom: 1, pitch: 0, bearing: 0 }],
      }),
    );
    assert.equal(config.keyframes[0].holdMs, MIN_HOLD_SECONDS * 1000);
    assert.equal(config.keyframes[0].transitionMs, DEFAULT_SEGMENT_SECONDS * 1000);
  });

  it("clamps zoom/pitch and wraps bearing into MapLibre's supported ranges", () => {
    const config = parseTourConfig(
      JSON.stringify({
        type: TOUR_CONFIG_TYPE,
        version: 2,
        fps: 30,
        keyframes: [
          {
            center: [0, 0],
            zoom: 200,
            pitch: 270,
            bearing: 999,
            holdMs: 0,
            transitionMs: 2000,
          },
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
        version: 2,
        keyframes: [
          {
            center: [0, 0],
            zoom: 1,
            pitch: 0,
            bearing: 270,
            holdMs: 0,
            transitionMs: 2000,
          },
        ],
      }),
    );
    assert.equal(config.keyframes[0].bearing, -90);
    // No fps key in the file, so it falls back to DEFAULT_FPS.
    assert.equal(config.fps, DEFAULT_FPS);
  });

  it("migrates a legacy v1 file (durationMs) to the hold/transition model", () => {
    const config = parseTourConfig(
      JSON.stringify({
        type: TOUR_CONFIG_TYPE,
        version: 1,
        fps: 30,
        keyframes: [
          // v1 durationMs is the time to animate INTO each keyframe.
          { center: [0, 0], zoom: 1, pitch: 0, bearing: 0, durationMs: 9999 },
          { center: [1, 1], zoom: 2, pitch: 0, bearing: 0, durationMs: 3000 },
          { center: [2, 2], zoom: 3, pitch: 0, bearing: 0, durationMs: 5000 },
        ],
      }),
    );
    assert.equal(config.keyframes.length, 3);
    // Outgoing transition of keyframe i = old incoming durationMs of keyframe i+1.
    assert.equal(config.keyframes[0].transitionMs, 3000);
    assert.equal(config.keyframes[1].transitionMs, 5000);
    // The last keyframe has no successor, so it gets the default transition.
    assert.equal(config.keyframes[2].transitionMs, DEFAULT_SEGMENT_SECONDS * 1000);
    // v1 had implicit holds only at the very start and end.
    assert.equal(config.keyframes[0].holdMs, START_HOLD_MS);
    assert.equal(config.keyframes[1].holdMs, 0);
    assert.equal(config.keyframes[2].holdMs, END_HOLD_MS);
  });

  it("migrates a single-keyframe legacy v1 file (both implicit holds)", () => {
    const config = parseTourConfig(
      JSON.stringify({
        type: TOUR_CONFIG_TYPE,
        version: 1,
        fps: 30,
        keyframes: [{ center: [0, 0], zoom: 1, pitch: 0, bearing: 0, durationMs: 9999 }],
      }),
    );
    assert.equal(config.keyframes.length, 1);
    // A lone keyframe is both first and last, so it inherits both implicit holds.
    assert.equal(config.keyframes[0].holdMs, START_HOLD_MS + END_HOLD_MS);
    // It has no successor, so the last-keyframe default transition is used.
    assert.equal(config.keyframes[0].transitionMs, DEFAULT_SEGMENT_SECONDS * 1000);
  });

  it("reads a versionless file with mixed legacy/v2 fields as v2", () => {
    // One keyframe has only durationMs, another has v2 fields. Because a v2
    // field is present somewhere, the file is read as v2 (not migrated), so the
    // persisted hold/transition survive and durationMs is simply ignored.
    const config = parseTourConfig(
      JSON.stringify({
        type: TOUR_CONFIG_TYPE,
        keyframes: [
          { center: [0, 0], zoom: 1, pitch: 0, bearing: 0, durationMs: 9999 },
          {
            center: [1, 1],
            zoom: 2,
            pitch: 0,
            bearing: 0,
            holdMs: 3000,
            transitionMs: 7000,
          },
        ],
      }),
    );
    assert.equal(config.keyframes[0].holdMs, MIN_HOLD_SECONDS * 1000);
    assert.equal(config.keyframes[0].transitionMs, DEFAULT_SEGMENT_SECONDS * 1000);
    assert.equal(config.keyframes[1].holdMs, 3000);
    assert.equal(config.keyframes[1].transitionMs, 7000);
  });

  it("infers the legacy format from durationMs when no version is present", () => {
    const config = parseTourConfig(
      JSON.stringify({
        type: TOUR_CONFIG_TYPE,
        keyframes: [
          { center: [0, 0], zoom: 1, pitch: 0, bearing: 0, durationMs: 2000 },
          { center: [1, 1], zoom: 2, pitch: 0, bearing: 0, durationMs: 7000 },
        ],
      }),
    );
    assert.equal(config.keyframes[0].transitionMs, 7000);
    assert.equal(config.keyframes[0].holdMs, START_HOLD_MS);
    assert.equal(config.keyframes[1].holdMs, END_HOLD_MS);
  });

  it("rejects a keyframe with an out-of-range latitude", () => {
    assert.throws(() =>
      parseTourConfig(
        JSON.stringify({
          type: TOUR_CONFIG_TYPE,
          version: 2,
          keyframes: [
            {
              center: [0, 999],
              zoom: 1,
              pitch: 0,
              bearing: 0,
              holdMs: 0,
              transitionMs: 2000,
            },
          ],
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
      holdMs: 0,
      transitionMs: 2000,
    }));
    assert.throws(() =>
      parseTourConfig(JSON.stringify({ type: TOUR_CONFIG_TYPE, version: 2, keyframes })),
    );
  });

  it("rejects a file from a newer, unsupported version", () => {
    assert.throws(() =>
      parseTourConfig(
        JSON.stringify({
          type: TOUR_CONFIG_TYPE,
          version: 999,
          keyframes: [{ center: [0, 0], zoom: 1, pitch: 0, bearing: 0, transitionMs: 2000 }],
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
          keyframes: [{ center: [0, 0], zoom: 1, pitch: 0, bearing: 0, transitionMs: 2000 }],
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
          keyframes: [{ center: [0, 0], zoom: 1, pitch: 0, bearing: 0, transitionMs: 2000 }],
        }),
      ),
    );
  });

  it("clamps a too-low fps on parse", () => {
    const config = parseTourConfig(
      JSON.stringify({
        type: TOUR_CONFIG_TYPE,
        version: 2,
        fps: 1,
        keyframes: [{ center: [0, 0], zoom: 1, pitch: 0, bearing: 0, transitionMs: 2000 }],
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
    assert.throws(() => parseTourConfig(JSON.stringify({ keyframes: [], fps: 30 })));
  });

  it("rejects a tour with no keyframes", () => {
    assert.throws(() =>
      parseTourConfig(JSON.stringify({ type: TOUR_CONFIG_TYPE, version: 2, keyframes: [] })),
    );
  });

  it("rejects a keyframe with an invalid center", () => {
    assert.throws(() =>
      parseTourConfig(
        JSON.stringify({
          type: TOUR_CONFIG_TYPE,
          version: 2,
          keyframes: [{ center: [0], zoom: 1, pitch: 0, bearing: 0, transitionMs: 2000 }],
        }),
      ),
    );
  });
});
