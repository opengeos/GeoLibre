import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearDirectionsWaypoints,
  DIRECTIONS_PLUGIN_ID,
  extractDirectionsRouteMetrics,
  getDirectionsRouteMetrics,
  getDirectionsWaypointCount,
  isDirectionsRemovalInFlight,
  isDirectionsRouteLoading,
  maplibreDirectionsPlugin,
  removeLastDirectionsWaypoint,
  subscribeDirectionsState,
} from "../packages/plugins/src/plugins/maplibre-directions";

type DirectionsResponse = Parameters<typeof extractDirectionsRouteMetrics>[0];

describe("maplibreDirectionsPlugin", () => {
  it("is a Controls toggle that is off by default", () => {
    assert.equal(maplibreDirectionsPlugin.id, DIRECTIONS_PLUGIN_ID);
    assert.equal(maplibreDirectionsPlugin.activeByDefault, undefined);
    assert.equal(typeof maplibreDirectionsPlugin.activate, "function");
    assert.equal(typeof maplibreDirectionsPlugin.deactivate, "function");
  });
});

// The mode banner reads these without knowing whether the lazy-loaded library
// has attached yet, so the inactive-state contract must be safe: a zero count
// and no-op mutators that never throw. The active path where removalInFlight is
// set true and then cleared by the removeWaypoint .finally needs a live routing
// instance, so it is covered by the Playwright verification rather than here.
describe("directions control surface (inactive)", () => {
  it("reports zero waypoints when the tool is inactive", () => {
    assert.equal(getDirectionsWaypointCount(), 0);
  });

  it("reports no route metrics when the tool is inactive", () => {
    assert.equal(getDirectionsRouteMetrics(), null);
    assert.equal(isDirectionsRouteLoading(), false);
  });

  it("treats remove-last and clear as no-ops when inactive", () => {
    assert.doesNotThrow(() => removeLastDirectionsWaypoint());
    assert.doesNotThrow(() => clearDirectionsWaypoints());
    assert.equal(getDirectionsWaypointCount(), 0);
    // A no-op removal must not leave the in-flight flag stuck on.
    assert.equal(isDirectionsRemovalInFlight(), false);
    assert.equal(getDirectionsRouteMetrics(), null);
    assert.equal(isDirectionsRouteLoading(), false);
  });

  it("returns an idempotent unsubscribe from subscribeDirectionsState", () => {
    // The notify path needs a live routing instance (created by the lazy
    // import on activate), which the Playwright verification exercises end to
    // end. Here we only assert the subscribe contract that is reachable without
    // one: unsubscribe is a function and can be called repeatedly without
    // throwing, so a teardown that double-unsubscribes is safe.
    const unsubscribe = subscribeDirectionsState(() => {});
    assert.equal(typeof unsubscribe, "function");
    assert.doesNotThrow(() => {
      unsubscribe();
      unsubscribe();
    });
  });
});

describe("directions route metrics extraction", () => {
  it("reads route totals and leg metrics from an OSRM response", () => {
    const metrics = extractDirectionsRouteMetrics({
      code: "Ok",
      routes: [
        {
          distance: 1234,
          duration: 456,
          geometry: "",
          legs: [
            { distance: 1000, duration: 300 },
            { distance: 234, duration: 156 },
          ],
        },
      ],
      waypoints: [],
    } as DirectionsResponse);

    assert.deepEqual(metrics, {
      totalDistanceMeters: 1234,
      totalDurationSeconds: 456,
      legs: [
        { distanceMeters: 1000, durationSeconds: 300 },
        { distanceMeters: 234, durationSeconds: 156 },
      ],
    });
  });

  it("falls back to complete leg totals when route totals are absent", () => {
    const metrics = extractDirectionsRouteMetrics({
      code: "Ok",
      routes: [
        {
          geometry: "",
          legs: [
            { distance: 1000, duration: 300 },
            { distance: 500, duration: 120 },
          ],
        },
      ],
      waypoints: [],
    } as DirectionsResponse);

    assert.deepEqual(metrics, {
      totalDistanceMeters: 1500,
      totalDurationSeconds: 420,
      legs: [
        { distanceMeters: 1000, durationSeconds: 300 },
        { distanceMeters: 500, durationSeconds: 120 },
      ],
    });
  });

  it("rejects incomplete leg fallback totals", () => {
    const metrics = extractDirectionsRouteMetrics({
      code: "Ok",
      routes: [
        {
          geometry: "",
          legs: [{ distance: 1000, duration: 300 }, { distance: 500 }],
        },
      ],
      waypoints: [],
    } as DirectionsResponse);

    assert.equal(metrics, null);
  });

  it("rejects degenerate zero route totals", () => {
    const zeroDistance = extractDirectionsRouteMetrics({
      code: "Ok",
      routes: [
        {
          distance: 0,
          duration: 30,
          geometry: "",
          legs: [{ distance: 0, duration: 30 }],
        },
      ],
      waypoints: [],
    } as DirectionsResponse);

    const zeroDuration = extractDirectionsRouteMetrics({
      code: "Ok",
      routes: [
        {
          distance: 30,
          duration: 0,
          geometry: "",
          legs: [{ distance: 30, duration: 0 }],
        },
      ],
      waypoints: [],
    } as DirectionsResponse);

    assert.equal(zeroDistance, null);
    assert.equal(zeroDuration, null);
  });
});
