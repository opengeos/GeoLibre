import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import {
  DEFAULT_ROUTE_ANIMATION_SETTINGS,
  ROUTE_ANIM_SPEED_MAX,
  ROUTE_ANIM_SPEED_MIN,
  advanceRouteProgress,
  getRouteAnimationSettings,
  isRouteAnimationPanelVisible,
  maplibreRouteAnimationPlugin,
  normalizeRouteAnimationSettings,
  restoreRouteAnimation,
  setRouteAnimationProgress,
  setRouteAnimationSettings,
  toggleRouteAnimationPlaying,
} from "../packages/plugins/src/plugins/maplibre-route-animation";
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
import {
  bearingBetween,
  flattenToLine,
  measureLine,
  pointAlongLine,
  sliceLineAtDistance,
  type LngLat,
} from "../packages/plugins/src/plugins/route-animation-geometry";

// A simple two-segment path: due east, then due north. Coordinates are chosen
// near the equator so the two legs are close to equal length in meters.
const EAST: LngLat = [1, 0];
const NORTH: LngLat = [1, 1];
const START: LngLat = [0, 0];
const LINE: LngLat[] = [START, EAST, NORTH];

describe("normalizeRouteAnimationSettings", () => {
  it("returns the defaults for undefined/empty input", () => {
    assert.deepEqual(
      normalizeRouteAnimationSettings(undefined),
      DEFAULT_ROUTE_ANIMATION_SETTINGS,
    );
    assert.deepEqual(
      normalizeRouteAnimationSettings({}),
      DEFAULT_ROUTE_ANIMATION_SETTINGS,
    );
  });

  it("clamps speed into its allowed range", () => {
    assert.equal(
      normalizeRouteAnimationSettings({ speedMps: -50 }).speedMps,
      ROUTE_ANIM_SPEED_MIN,
    );
    assert.equal(
      normalizeRouteAnimationSettings({ speedMps: 999999 }).speedMps,
      ROUTE_ANIM_SPEED_MAX,
    );
  });

  it("clamps progress into [0, 1]", () => {
    assert.equal(normalizeRouteAnimationSettings({ progress: -1 }).progress, 0);
    assert.equal(normalizeRouteAnimationSettings({ progress: 5 }).progress, 1);
    assert.equal(
      normalizeRouteAnimationSettings({ progress: 0.42 }).progress,
      0.42,
    );
  });

  it("keeps a valid layerId and coerces empty/invalid ones to null", () => {
    assert.equal(
      normalizeRouteAnimationSettings({ layerId: "layer-1" }).layerId,
      "layer-1",
    );
    assert.equal(normalizeRouteAnimationSettings({ layerId: "" }).layerId, null);
    assert.equal(
      normalizeRouteAnimationSettings({ layerId: 42 as unknown as string })
        .layerId,
      null,
    );
  });

  it("preserves boolean toggles", () => {
    const s = normalizeRouteAnimationSettings({
      loop: false,
      followCamera: true,
      showTrail: false,
    });
    assert.equal(s.loop, false);
    assert.equal(s.followCamera, true);
    assert.equal(s.showTrail, false);
  });

  it("accepts valid marker styles and falls back for invalid ones", () => {
    assert.equal(
      normalizeRouteAnimationSettings({ markerStyle: "point" }).markerStyle,
      "point",
    );
    assert.equal(
      normalizeRouteAnimationSettings({ markerStyle: "none" }).markerStyle,
      "none",
    );
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

describe("pointAlongLine", () => {
  const { cumulative, totalMeters } = measureLine(LINE);

  it("returns the first vertex at distance 0", () => {
    const p = pointAlongLine(LINE, cumulative, 0);
    assert.deepEqual(p.coord, START);
  });

  it("returns the last vertex at (and beyond) the total length", () => {
    assert.deepEqual(pointAlongLine(LINE, cumulative, totalMeters).coord, NORTH);
    assert.deepEqual(
      pointAlongLine(LINE, cumulative, totalMeters * 2).coord,
      NORTH,
    );
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
});

describe("sliceLineAtDistance", () => {
  const { cumulative, totalMeters } = measureLine(LINE);

  it("is empty at distance 0", () => {
    assert.deepEqual(sliceLineAtDistance(LINE, cumulative, 0), []);
  });

  it("returns the whole line at the total length", () => {
    assert.deepEqual(
      sliceLineAtDistance(LINE, cumulative, totalMeters),
      LINE,
    );
  });

  it("ends exactly under the marker partway along", () => {
    const halfFirst = cumulative[1] / 2;
    const slice = sliceLineAtDistance(LINE, cumulative, halfFirst);
    assert.equal(slice.length, 2);
    assert.deepEqual(slice[0], START);
    assert.ok(Math.abs(slice[1][0] - 0.5) < 1e-6);
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
