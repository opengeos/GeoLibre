import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import {
  DEFAULT_ROUTE_ANIMATION_SETTINGS,
  ROUTE_ANIM_SPEED_MAX,
  ROUTE_ANIM_SPEED_MIN,
  ROUTE_FOLLOW_PITCH_MAX,
  ROUTE_FOLLOW_PITCH_MIN,
  ROUTE_FOLLOW_ZOOM_MAX,
  ROUTE_FOLLOW_ZOOM_MIN,
  ROUTE_VIDEO_MIME_CANDIDATES,
  advanceRouteProgress,
  getRouteAnimationDurationSeconds,
  getRouteAnimationSettings,
  isRouteAnimationPanelVisible,
  maplibreRouteAnimationPlugin,
  normalizeRouteAnimationSettings,
  pickVideoMimeType,
  restoreRouteAnimation,
  setRouteAnimationProgress,
  setRouteAnimationRoute,
  setRouteAnimationSettings,
  toggleRouteAnimationPlaying,
  videoExtensionForMime,
} from "../packages/plugins/src/plugins/maplibre-route-animation";
import {
  bearingBetween,
  flattenToLine,
  flattenToRoute,
  measureLine,
  pointAlongLine,
  sliceLineAtDistance,
  sliceRouteAtDistance,
  type LngLat,
} from "../packages/plugins/src/plugins/route-animation-geometry";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// A minimal app whose map is never available, so the module's store logic runs
// with the engine detached (engine stays null) — enough to exercise every store
// path without a DOM or a MapLibre instance.
const mapLessApp = { getMap: () => null } as unknown as GeoLibreAppAPI;

/** Reset the singleton store to defaults and a closed panel between cases. */
function resetStore(): void {
  restoreRouteAnimation(mapLessApp, undefined);
  setRouteAnimationSettings({ ...DEFAULT_ROUTE_ANIMATION_SETTINGS });
}

// A simple two-segment path: due east, then due north. Coordinates are chosen
// near the equator so the two legs are close to equal length in meters.
const EAST: LngLat = [1, 0];
const NORTH: LngLat = [1, 1];
const START: LngLat = [0, 0];
const LINE: LngLat[] = [START, EAST, NORTH];

describe("normalizeRouteAnimationSettings", () => {
  it("returns the defaults for undefined/empty input", () => {
    assert.deepEqual(normalizeRouteAnimationSettings(undefined), DEFAULT_ROUTE_ANIMATION_SETTINGS);
    assert.deepEqual(normalizeRouteAnimationSettings({}), DEFAULT_ROUTE_ANIMATION_SETTINGS);
  });

  it("clamps speed into its allowed range", () => {
    assert.equal(normalizeRouteAnimationSettings({ speedMps: -50 }).speedMps, ROUTE_ANIM_SPEED_MIN);
    assert.equal(
      normalizeRouteAnimationSettings({ speedMps: 999999 }).speedMps,
      ROUTE_ANIM_SPEED_MAX,
    );
  });

  it("clamps progress into [0, 1]", () => {
    assert.equal(normalizeRouteAnimationSettings({ progress: -1 }).progress, 0);
    assert.equal(normalizeRouteAnimationSettings({ progress: 5 }).progress, 1);
    assert.equal(normalizeRouteAnimationSettings({ progress: 0.42 }).progress, 0.42);
  });

  it("keeps a valid layerId and coerces empty/invalid ones to null", () => {
    assert.equal(normalizeRouteAnimationSettings({ layerId: "layer-1" }).layerId, "layer-1");
    assert.equal(normalizeRouteAnimationSettings({ layerId: "" }).layerId, null);
    assert.equal(
      normalizeRouteAnimationSettings({ layerId: 42 as unknown as string }).layerId,
      null,
    );
  });

  it("preserves boolean toggles", () => {
    const s = normalizeRouteAnimationSettings({
      loop: false,
      followCamera: true,
      followRotate: false,
      showTrail: false,
    });
    assert.equal(s.loop, false);
    assert.equal(s.followCamera, true);
    assert.equal(s.followRotate, false);
    assert.equal(s.showTrail, false);
  });

  it("clamps the follow-camera pitch and zoom into their ranges", () => {
    assert.equal(
      normalizeRouteAnimationSettings({ followPitch: -20 }).followPitch,
      ROUTE_FOLLOW_PITCH_MIN,
    );
    assert.equal(
      normalizeRouteAnimationSettings({ followPitch: 999 }).followPitch,
      ROUTE_FOLLOW_PITCH_MAX,
    );
    assert.equal(
      normalizeRouteAnimationSettings({ followZoom: 0 }).followZoom,
      ROUTE_FOLLOW_ZOOM_MIN,
    );
    assert.equal(
      normalizeRouteAnimationSettings({ followZoom: 99 }).followZoom,
      ROUTE_FOLLOW_ZOOM_MAX,
    );
    assert.equal(normalizeRouteAnimationSettings({ followPitch: 45 }).followPitch, 45);
  });

  it("accepts valid hex colors and rejects malformed ones", () => {
    assert.equal(normalizeRouteAnimationSettings({ color: "#ff0000" }).color, "#ff0000");
    assert.equal(normalizeRouteAnimationSettings({ color: "#abc" }).color, "#abc");
    assert.equal(
      normalizeRouteAnimationSettings({ color: "red" }).color,
      DEFAULT_ROUTE_ANIMATION_SETTINGS.color,
    );
    assert.equal(
      normalizeRouteAnimationSettings({ color: "#12" }).color,
      DEFAULT_ROUTE_ANIMATION_SETTINGS.color,
    );
  });

  it("accepts valid marker styles and falls back for invalid ones", () => {
    assert.equal(normalizeRouteAnimationSettings({ markerStyle: "point" }).markerStyle, "point");
    assert.equal(normalizeRouteAnimationSettings({ markerStyle: "none" }).markerStyle, "none");
    assert.equal(
      normalizeRouteAnimationSettings({
        markerStyle: "spaceship" as never,
      }).markerStyle,
      "arrow",
    );
  });
});

describe("bearingBetween", () => {
  it("is 90° due east and 0° due north", () => {
    assert.ok(Math.abs(bearingBetween([0, 0], [1, 0]) - 90) < 1e-6);
    assert.ok(Math.abs(bearingBetween([0, 0], [0, 1]) - 0) < 1e-6);
  });

  it("normalizes into [0, 360)", () => {
    const west = bearingBetween([0, 0], [-1, 0]);
    assert.ok(west >= 0 && west < 360);
    assert.ok(Math.abs(west - 270) < 1e-6);
  });
});

describe("flattenToLine", () => {
  it("returns a LineString's coordinates", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: LINE },
        },
      ],
    };
    assert.deepEqual(flattenToLine(fc), LINE);
  });

  it("concatenates MultiLineString segments", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "MultiLineString",
            coordinates: [
              [START, EAST],
              [EAST, NORTH],
            ],
          },
        },
      ],
    };
    assert.deepEqual(flattenToLine(fc), [START, EAST, EAST, NORTH]);
  });

  it("skips non-line features and returns [] when none present", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [0, 0] },
        },
      ],
    };
    assert.deepEqual(flattenToLine(fc), []);
    assert.deepEqual(flattenToLine(undefined), []);
    assert.deepEqual(flattenToLine(null), []);
  });
});

// A 3D LineString: due east then due north, climbing 0 → 100 → 250 meters.
const LINE_3D: number[][] = [
  [0, 0, 0],
  [1, 0, 100],
  [1, 1, 250],
];

describe("flattenToRoute", () => {
  it("returns coordinates and their aligned Z values", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: LINE_3D },
        },
      ],
    };
    const route = flattenToRoute(fc);
    assert.deepEqual(route.coords, [
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
    assert.deepEqual(route.elevations, [0, 100, 250]);
  });

  it("treats missing/non-finite Z as 0", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 0, Number.NaN],
              [1, 1, 42],
            ],
          },
        },
      ],
    };
    assert.deepEqual(flattenToRoute(fc).elevations, [0, 0, 42]);
  });

  it("returns empty arrays when there is no line", () => {
    assert.deepEqual(flattenToRoute(undefined), { coords: [], elevations: [] });
    assert.deepEqual(flattenToRoute(null), { coords: [], elevations: [] });
  });
});

describe("pointAlongLine", () => {
  const { cumulative, totalMeters } = measureLine(LINE);

  it("returns the first vertex at distance 0", () => {
    const p = pointAlongLine(LINE, cumulative, 0);
    assert.deepEqual(p.coord, START);
  });

  it("returns the last vertex at (and beyond) the total length", () => {
    assert.deepEqual(pointAlongLine(LINE, cumulative, totalMeters).coord, NORTH);
    assert.deepEqual(pointAlongLine(LINE, cumulative, totalMeters * 2).coord, NORTH);
  });

  it("interpolates the midpoint of the first segment", () => {
    const halfFirst = cumulative[1] / 2;
    const p = pointAlongLine(LINE, cumulative, halfFirst);
    assert.ok(Math.abs(p.coord[0] - 0.5) < 1e-6);
    assert.ok(Math.abs(p.coord[1] - 0) < 1e-6);
    // Heading along the first (eastbound) segment is due east.
    assert.ok(Math.abs(p.bearing - 90) < 1e-6);
  });

  it("reports the second segment's heading past the corner", () => {
    const intoSecond = cumulative[1] + (cumulative[2] - cumulative[1]) / 2;
    const p = pointAlongLine(LINE, cumulative, intoSecond);
    assert.ok(Math.abs(p.bearing - 0) < 1e-6);
  });

  it("interpolates the elevation when an elevations array is supplied", () => {
    const elevations = [0, 100, 250];
    const halfFirst = cumulative[1] / 2;
    // Halfway up the first segment (0 → 100 m) is 50 m.
    assert.ok(
      Math.abs(pointAlongLine(LINE, cumulative, halfFirst, elevations).elevation - 50) < 1e-6,
    );
    // At the far end the elevation is the last vertex's Z.
    assert.equal(pointAlongLine(LINE, cumulative, totalMeters, elevations).elevation, 250);
  });

  it("reports elevation 0 when no elevations array is supplied", () => {
    assert.equal(pointAlongLine(LINE, cumulative, totalMeters).elevation, 0);
  });
});

describe("sliceLineAtDistance", () => {
  const { cumulative, totalMeters } = measureLine(LINE);

  it("is empty at distance 0", () => {
    assert.deepEqual(sliceLineAtDistance(LINE, cumulative, 0), []);
  });

  it("returns the whole line at the total length", () => {
    assert.deepEqual(sliceLineAtDistance(LINE, cumulative, totalMeters), LINE);
  });

  it("ends exactly under the marker partway along", () => {
    const halfFirst = cumulative[1] / 2;
    const slice = sliceLineAtDistance(LINE, cumulative, halfFirst);
    assert.equal(slice.length, 2);
    assert.deepEqual(slice[0], START);
    assert.ok(Math.abs(slice[1][0] - 0.5) < 1e-6);
  });
});

describe("sliceRouteAtDistance", () => {
  const { cumulative, totalMeters } = measureLine(LINE);
  const elevations = [0, 100, 250];

  it("returns empty arrays at distance 0", () => {
    assert.deepEqual(sliceRouteAtDistance(LINE, cumulative, 0, elevations), {
      coords: [],
      elevations: [],
    });
  });

  it("returns the whole route with its elevations at the total length", () => {
    const route = sliceRouteAtDistance(LINE, cumulative, totalMeters, elevations);
    assert.deepEqual(route.coords, LINE);
    assert.deepEqual(route.elevations, elevations);
  });

  it("caps the trail with the interpolated elevation partway along", () => {
    const halfFirst = cumulative[1] / 2;
    const route = sliceRouteAtDistance(LINE, cumulative, halfFirst, elevations);
    assert.equal(route.coords.length, 2);
    assert.deepEqual(route.coords[0], START);
    assert.equal(route.elevations[0], 0);
    // The capped vertex sits at the interpolated midpoint elevation (50 m).
    assert.ok(Math.abs(route.elevations[1] - 50) < 1e-6);
  });

  it("keeps coords and elevations aligned when elevations is short", () => {
    // A malformed shorter elevations array must not desync the two outputs;
    // missing entries default to 0.
    const route = sliceRouteAtDistance(LINE, cumulative, totalMeters, []);
    assert.equal(route.coords.length, route.elevations.length);
    assert.deepEqual(route.elevations, [0, 0, 0]);
  });
});

describe("route-animation store", () => {
  it("toggles play and scrubs progress", () => {
    resetStore();
    assert.equal(getRouteAnimationSettings().playing, false);
    toggleRouteAnimationPlaying();
    assert.equal(getRouteAnimationSettings().playing, true);
    toggleRouteAnimationPlaying();
    assert.equal(getRouteAnimationSettings().playing, false);

    setRouteAnimationProgress(0.5);
    assert.equal(getRouteAnimationSettings().progress, 0.5);
    // Out-of-range scrubs clamp.
    setRouteAnimationProgress(2);
    assert.equal(getRouteAnimationSettings().progress, 1);
  });

  it("does not reset progress when the route is (re)set", () => {
    resetStore();
    setRouteAnimationProgress(0.5);
    // A fresh route mid-playback must not snap back to the start — the panel
    // owns the reset-on-selection, not the route setter.
    setRouteAnimationRoute([
      [0, 0],
      [1, 1],
    ]);
    assert.equal(getRouteAnimationSettings().progress, 0.5);
    // Re-setting the identical route is likewise a no-op for progress.
    setRouteAnimationRoute([
      [0, 0],
      [1, 1],
    ]);
    assert.equal(getRouteAnimationSettings().progress, 0.5);
  });

  it("stops playback when the route becomes unanimatable", () => {
    resetStore();
    setRouteAnimationRoute([
      [0, 0],
      [1, 1],
    ]);
    setRouteAnimationSettings({ playing: true });
    assert.equal(getRouteAnimationSettings().playing, true);
    // The selected layer disappears → empty route → playback must stop so the
    // panel doesn't show a stuck (disabled) Pause button.
    setRouteAnimationRoute([]);
    assert.equal(getRouteAnimationSettings().playing, false);
  });

  it("restarts from the top when replaying a finished (non-looping) route", () => {
    resetStore();
    setRouteAnimationSettings({ loop: false, progress: 0.9, playing: true });
    advanceRouteProgress(0.2);
    // Route reached the end and stopped.
    assert.equal(getRouteAnimationSettings().progress, 1);
    assert.equal(getRouteAnimationSettings().playing, false);
    // Pressing Play again rewinds to the start instead of silently re-stopping.
    toggleRouteAnimationPlaying();
    const replay = getRouteAnimationSettings();
    assert.equal(replay.playing, true);
    assert.equal(replay.progress, 0);
  });

  it("wraps progress when looping and stops at the end otherwise", () => {
    resetStore();
    setRouteAnimationSettings({ loop: true, progress: 0.9, playing: true });
    advanceRouteProgress(0.2);
    const looped = getRouteAnimationSettings();
    assert.ok(Math.abs(looped.progress - 0.1) < 1e-9);
    assert.equal(looped.playing, true);

    setRouteAnimationSettings({ loop: false, progress: 0.9, playing: true });
    advanceRouteProgress(0.2);
    const stopped = getRouteAnimationSettings();
    assert.equal(stopped.progress, 1);
    assert.equal(stopped.playing, false);
  });

  it("persists non-default state and reopens it, never auto-playing", () => {
    resetStore();
    // A clean, closed panel at defaults persists nothing.
    assert.equal(maplibreRouteAnimationPlugin.getProjectState?.(), undefined);

    restoreRouteAnimation(mapLessApp, {
      open: true,
      layerId: "track-1",
      speedMps: 120,
      playing: true,
    });
    assert.equal(isRouteAnimationPanelVisible(), true);
    const restored = getRouteAnimationSettings();
    assert.equal(restored.layerId, "track-1");
    assert.equal(restored.speedMps, 120);
    // Playback never auto-starts on load.
    assert.equal(restored.playing, false);

    const state = maplibreRouteAnimationPlugin.getProjectState?.() as {
      open: boolean;
      layerId: string;
      playing: boolean;
    };
    assert.equal(state.open, true);
    assert.equal(state.layerId, "track-1");
    assert.equal(state.playing, false);

    // Restoring an empty/closed project closes the panel again.
    restoreRouteAnimation(mapLessApp, undefined);
    assert.equal(isRouteAnimationPanelVisible(), false);
  });
});

describe("video export helpers", () => {
  it("maps a MIME type to the right file extension", () => {
    assert.equal(videoExtensionForMime("video/mp4"), "mp4");
    assert.equal(videoExtensionForMime("video/mp4;codecs=avc1.42E01E"), "mp4");
    assert.equal(videoExtensionForMime("video/webm;codecs=vp9"), "webm");
    assert.equal(videoExtensionForMime("video/webm"), "webm");
  });

  it("prefers MP4 over WebM when both are supported", () => {
    const mime = pickVideoMimeType(ROUTE_VIDEO_MIME_CANDIDATES, () => true);
    assert.ok(mime?.startsWith("video/mp4"));
    assert.equal(videoExtensionForMime(mime as string), "mp4");
  });

  it("falls back to WebM when MP4 is unsupported", () => {
    const mime = pickVideoMimeType(ROUTE_VIDEO_MIME_CANDIDATES, (type) =>
      type.startsWith("video/webm"),
    );
    assert.ok(mime?.startsWith("video/webm"));
    assert.equal(videoExtensionForMime(mime as string), "webm");
  });

  it("returns null when nothing is supported", () => {
    assert.equal(
      pickVideoMimeType(ROUTE_VIDEO_MIME_CANDIDATES, () => false),
      null,
    );
  });

  it("estimates the pass duration from route length and speed", () => {
    resetStore();
    // No route yet: nothing to record, so the duration is zero.
    assert.equal(getRouteAnimationDurationSeconds(), 0);

    setRouteAnimationRoute(LINE);
    const { totalMeters } = measureLine(LINE);
    setRouteAnimationSettings({ speedMps: 100 });
    assert.ok(Math.abs(getRouteAnimationDurationSeconds() - totalMeters / 100) < 1e-6);
    // Halving the speed doubles the estimated length.
    setRouteAnimationSettings({ speedMps: 50 });
    assert.ok(Math.abs(getRouteAnimationDurationSeconds() - totalMeters / 50) < 1e-6);
    resetStore();
  });
});
