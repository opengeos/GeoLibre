import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_FLIGHT_SIMULATOR_SETTINGS,
  FLIGHT_CAMERA_TOKEN,
  FLIGHT_MAX_SPEED_MAX,
  FLIGHT_MAX_SPEED_MIN,
  FLIGHT_MIN_AGL_MAX,
  FLIGHT_MIN_AGL_MIN,
  LEVEL_CAMERA_PITCH,
  MAX_CAMERA_PITCH,
  MIN_CAMERA_PITCH,
  closeFlightSimulatorPanel,
  flightSimulatorPlugin,
  getFlightHudSnapshot,
  getFlightSimulatorSettings,
  isFlightSimulatorPanelVisible,
  isFlying,
  normalizeFlightSimulatorSettings,
  openFlightSimulatorPanel,
  reattachFlightSimulator,
  restoreFlightSimulator,
  setFlightSimulatorSettings,
  startFlying,
  stopFlying,
  subscribeFlightHud,
} from "../packages/plugins/src/plugins/flight-simulator";
import {
  DEFAULT_FLIGHT_MODEL,
  MAX_FLIGHT_LATITUDE,
  type AircraftState,
  type FlightControls,
  altitudeAboveGround,
  altitudeForZoom,
  approach,
  compassPoint,
  constrainToTerrain,
  normalizeHeading,
  normalizeLongitude,
  offsetPosition,
  stepFlight,
  turnRateDegPerSec,
} from "../packages/plugins/src/plugins/flight-simulator-physics";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// The engine only attaches when a map exists, so a map-less app exercises every
// store path (panel visibility, settings, project state) without a DOM, a
// MapLibre instance, or a `window` — mirroring the route-animation tests.
const mapLessApp = { getMap: () => null } as unknown as GeoLibreAppAPI;

/** Reset the singleton store between cases. */
function resetStore(): void {
  restoreFlightSimulator(mapLessApp, undefined);
}

/** Straight and level at the equator, heading due north at 100 m/s. */
function levelFlight(overrides: Partial<AircraftState> = {}): AircraftState {
  return {
    lng: 0,
    lat: 0,
    altitude: 1000,
    heading: 0,
    pitch: 0,
    roll: 0,
    airspeed: 100,
    ...overrides,
  };
}

/** Neutral stick at the given throttle. */
function controls(overrides: Partial<FlightControls> = {}): FlightControls {
  return { elevator: 0, aileron: 0, throttle: 0.5, ...overrides };
}

describe("normalizeLongitude", () => {
  it("leaves in-range values alone", () => {
    assert.equal(normalizeLongitude(0), 0);
    assert.equal(normalizeLongitude(179), 179);
    assert.equal(normalizeLongitude(-179), -179);
  });

  it("wraps past the antimeridian in both directions", () => {
    assert.equal(normalizeLongitude(181), -179);
    assert.equal(normalizeLongitude(-181), 179);
    // A flight that keeps going east must keep wrapping, not run away.
    assert.equal(normalizeLongitude(721), 1);
    assert.equal(normalizeLongitude(-721), -1);
  });

  it("falls back to 0 for non-finite input", () => {
    assert.equal(normalizeLongitude(Number.NaN), 0);
    assert.equal(normalizeLongitude(Number.POSITIVE_INFINITY), 0);
  });
});

describe("normalizeHeading", () => {
  it("folds any angle into [0, 360)", () => {
    assert.equal(normalizeHeading(0), 0);
    assert.equal(normalizeHeading(360), 0);
    assert.equal(normalizeHeading(370), 10);
    assert.equal(normalizeHeading(-10), 350);
    assert.equal(normalizeHeading(-370), 350);
  });

  it("falls back to 0 for non-finite input", () => {
    assert.equal(normalizeHeading(Number.NaN), 0);
  });
});

describe("approach", () => {
  it("moves toward the target by at most the step", () => {
    assert.equal(approach(0, 10, 3), 3);
    assert.equal(approach(10, 0, 3), 7);
  });

  it("lands exactly on the target rather than overshooting", () => {
    assert.equal(approach(0, 10, 100), 10);
    assert.equal(approach(10, 0, 100), 0);
    assert.equal(approach(5, 5, 1), 5);
  });
});

describe("turnRateDegPerSec", () => {
  it("does not turn with the wings level", () => {
    assert.equal(turnRateDegPerSec(0, 100), 0);
  });

  it("turns right when banked right and left when banked left", () => {
    assert.ok(turnRateDegPerSec(30, 100) > 0);
    assert.ok(turnRateDegPerSec(-30, 100) < 0);
  });

  it("turns tighter when banked more steeply", () => {
    assert.ok(turnRateDegPerSec(45, 100) > turnRateDegPerSec(20, 100));
  });

  it("turns more slowly the faster the aircraft flies", () => {
    assert.ok(turnRateDegPerSec(30, 200) < turnRateDegPerSec(30, 100));
  });

  it("refuses to spin on the spot at a standstill", () => {
    // Guards the `g·tan(φ)/V` divide-by-zero as much as the physics.
    assert.equal(turnRateDegPerSec(45, 0), 0);
    assert.equal(turnRateDegPerSec(45, 0.5), 0);
  });
});

describe("offsetPosition", () => {
  it("moves north and east by the expected number of degrees", () => {
    const moved = offsetPosition(0, 0, 0, 111_320);
    assert.ok(Math.abs(moved.lat - 1) < 1e-9);
    assert.equal(moved.lng, 0);

    const east = offsetPosition(0, 0, 111_320, 0);
    assert.ok(Math.abs(east.lng - 1) < 1e-9);
  });

  it("needs fewer meters per degree of longitude at higher latitude", () => {
    const atEquator = offsetPosition(0, 0, 100_000, 0).lng;
    const atSixty = offsetPosition(0, 60, 100_000, 0).lng;
    // cos(60°) = 0.5, so the same easting spans about twice the longitude.
    assert.ok(atSixty > atEquator * 1.9 && atSixty < atEquator * 2.1);
  });

  it("wraps longitude across the antimeridian", () => {
    const wrapped = offsetPosition(179.99, 0, 5_000, 0);
    assert.ok(wrapped.lng < 0, `expected a wrap to negative, got ${wrapped.lng}`);
  });

  it("clamps latitude to the Mercator limit instead of passing the pole", () => {
    const north = offsetPosition(0, 84, 0, 1_000_000);
    assert.equal(north.lat, MAX_FLIGHT_LATITUDE);
    const south = offsetPosition(0, -84, 0, -1_000_000);
    assert.equal(south.lat, -MAX_FLIGHT_LATITUDE);
  });

  it("keeps the longitude step finite near the pole", () => {
    const polar = offsetPosition(0, MAX_FLIGHT_LATITUDE, 100_000, 0);
    assert.ok(Number.isFinite(polar.lng));
    assert.ok(polar.lng >= -180 && polar.lng <= 180);
  });
});

describe("stepFlight", () => {
  it("does not move on a zero, negative, or non-finite time step", () => {
    const start = levelFlight();
    for (const dt of [0, -1, Number.NaN]) {
      const result = stepFlight(start, controls(), DEFAULT_FLIGHT_MODEL, dt, 0);
      assert.equal(result.state, start, `dt=${dt} should return the same state`);
      assert.equal(result.grounded, false);
    }
  });

  it("flies north when heading north", () => {
    const { state } = stepFlight(levelFlight(), controls(), DEFAULT_FLIGHT_MODEL, 1, 0);
    assert.ok(state.lat > 0, "should have moved north");
    assert.ok(Math.abs(state.lng) < 1e-9, "should not have drifted east or west");
  });

  it("flies east when heading east", () => {
    const { state } = stepFlight(
      levelFlight({ heading: 90 }),
      controls(),
      DEFAULT_FLIGHT_MODEL,
      1,
      0,
    );
    assert.ok(state.lng > 0, "should have moved east");
    assert.ok(Math.abs(state.lat) < 1e-9, "should not have drifted north or south");
  });

  it("lags airspeed toward the throttle setting instead of snapping", () => {
    const start = levelFlight({ airspeed: DEFAULT_FLIGHT_MODEL.minSpeedMps });
    const { state } = stepFlight(start, controls({ throttle: 1 }), DEFAULT_FLIGHT_MODEL, 0.1, 0);
    assert.ok(state.airspeed > start.airspeed, "should accelerate");
    assert.ok(
      state.airspeed < DEFAULT_FLIGHT_MODEL.maxSpeedMps,
      "should not reach top speed in one 100 ms frame",
    );
  });

  // The cases below start from a non-level attitude with the stick released, so
  // they use a single realistic frame (100 ms). Over a full second the model's
  // self-leveling would return the aircraft to level before it had flown
  // anywhere, which is correct behavior but tests nothing.
  it("climbs with the nose up and descends with the nose down", () => {
    const up = stepFlight(levelFlight({ pitch: 20 }), controls(), DEFAULT_FLIGHT_MODEL, 0.1, 0);
    assert.ok(up.state.altitude > 1000);
    const down = stepFlight(levelFlight({ pitch: -20 }), controls(), DEFAULT_FLIGHT_MODEL, 0.1, 0);
    assert.ok(down.state.altitude < 1000);
  });

  it("covers less ground while climbing steeply than while level", () => {
    const level = stepFlight(levelFlight(), controls(), DEFAULT_FLIGHT_MODEL, 0.1, 0);
    const climbing = stepFlight(
      levelFlight({ pitch: 40 }),
      controls(),
      DEFAULT_FLIGHT_MODEL,
      0.1,
      0,
    );
    assert.ok(climbing.state.lat < level.state.lat);
  });

  it("raises the nose with up elevator and clamps at the pitch limit", () => {
    const { state } = stepFlight(
      levelFlight(),
      controls({ elevator: 1 }),
      DEFAULT_FLIGHT_MODEL,
      1,
      0,
    );
    assert.ok(state.pitch > 0);
    const pinned = stepFlight(
      levelFlight({ pitch: DEFAULT_FLIGHT_MODEL.maxPitchDeg - 1 }),
      controls({ elevator: 1 }),
      DEFAULT_FLIGHT_MODEL,
      1,
      0,
    );
    assert.equal(pinned.state.pitch, DEFAULT_FLIGHT_MODEL.maxPitchDeg);
  });

  it("banks with aileron and clamps at the roll limit", () => {
    const { state } = stepFlight(
      levelFlight(),
      controls({ aileron: 1 }),
      DEFAULT_FLIGHT_MODEL,
      1,
      0,
    );
    assert.ok(state.roll > 0);
    const pinned = stepFlight(
      levelFlight({ roll: DEFAULT_FLIGHT_MODEL.maxRollDeg - 1 }),
      controls({ aileron: 1 }),
      DEFAULT_FLIGHT_MODEL,
      1,
      0,
    );
    assert.equal(pinned.state.roll, DEFAULT_FLIGHT_MODEL.maxRollDeg);
  });

  it("turns the heading when already banked", () => {
    const right = stepFlight(levelFlight({ roll: 30 }), controls(), DEFAULT_FLIGHT_MODEL, 0.1, 0);
    assert.ok(right.state.heading > 0 && right.state.heading < 90, "a right bank turns east");
    const left = stepFlight(levelFlight({ roll: -30 }), controls(), DEFAULT_FLIGHT_MODEL, 0.1, 0);
    assert.ok(left.state.heading > 270, "a left bank turns west (wrapping below 360)");
  });

  it("keeps turning for as long as the aileron is held", () => {
    // The sustained case: holding bank in should accumulate heading change
    // rather than being cancelled by the self-leveling.
    let state = levelFlight();
    for (let i = 0; i < 20; i += 1) {
      state = stepFlight(state, controls({ aileron: 1 }), DEFAULT_FLIGHT_MODEL, 0.1, 0).state;
    }
    assert.ok(state.roll > 30, "should have rolled into a sustained bank");
    assert.ok(state.heading > 1, `should have turned measurably, got ${state.heading}`);
  });

  it("self-levels pitch and roll when the stick is released", () => {
    const { state } = stepFlight(
      levelFlight({ pitch: 20, roll: 20 }),
      controls(),
      DEFAULT_FLIGHT_MODEL,
      0.1,
      0,
    );
    assert.ok(state.pitch < 20 && state.pitch > 0, "pitch should relax toward level");
    assert.ok(state.roll < 20 && state.roll > 0, "roll should relax toward level");
  });

  it("holds the aircraft above the terrain and reports it as grounded", () => {
    const result = stepFlight(
      levelFlight({ altitude: 100, pitch: -30 }),
      controls(),
      DEFAULT_FLIGHT_MODEL,
      1,
      500,
    );
    assert.equal(result.grounded, true);
    assert.equal(result.state.altitude, 500 + DEFAULT_FLIGHT_MODEL.minAltitudeAglMeters);
  });

  it("is not grounded in clear air well above the terrain", () => {
    const result = stepFlight(
      levelFlight({ altitude: 3000 }),
      controls(),
      DEFAULT_FLIGHT_MODEL,
      1,
      500,
    );
    assert.equal(result.grounded, false);
  });

  it("never produces a non-finite position", () => {
    let state = levelFlight({ lat: 84.9, heading: 0, airspeed: 250 });
    for (let i = 0; i < 200; i += 1) {
      state = stepFlight(state, controls({ throttle: 1 }), DEFAULT_FLIGHT_MODEL, 0.1, 0).state;
    }
    assert.ok(Number.isFinite(state.lat) && Number.isFinite(state.lng));
    assert.ok(state.lat <= MAX_FLIGHT_LATITUDE);
  });
});

describe("constrainToTerrain", () => {
  it("uses the arrival terrain to keep the aircraft out of a hillside", () => {
    const state = levelFlight({ altitude: 100 });
    const result = constrainToTerrain(state, 120, 25);
    assert.equal(result.grounded, true);
    assert.equal(result.state.altitude, 145);
  });

  it("ignores invalid terrain samples without corrupting the aircraft", () => {
    const state = levelFlight({ altitude: 100 });
    const expectedState = { ...state };
    const result = constrainToTerrain(state, Number.NaN, 25);
    assert.equal(result.grounded, false);
    assert.deepEqual(result.state, expectedState);
  });
});

describe("altitudeAboveGround", () => {
  it("reports the height above the terrain, never negative", () => {
    assert.equal(altitudeAboveGround(1500, 500), 1000);
    assert.equal(altitudeAboveGround(300, 500), 0);
  });
});

describe("altitudeForZoom", () => {
  it("returns a positive altitude that shrinks as zoom increases", () => {
    const low = altitudeForZoom(0, 8, 800);
    const high = altitudeForZoom(0, 14, 800);
    assert.ok(low > 0 && high > 0);
    assert.ok(high < low, "zooming in should seed a lower altitude");
  });

  it("stays finite at the poles and for a degenerate viewport", () => {
    assert.ok(Number.isFinite(altitudeForZoom(89, 10, 800)));
    assert.ok(altitudeForZoom(0, 10, 0) > 0);
  });
});

describe("compassPoint", () => {
  it("names the cardinal and intercardinal points", () => {
    assert.equal(compassPoint(0), "N");
    assert.equal(compassPoint(90), "E");
    assert.equal(compassPoint(180), "S");
    assert.equal(compassPoint(270), "W");
    assert.equal(compassPoint(45), "NE");
  });

  it("wraps at the top of the rose rather than running off the array", () => {
    assert.equal(compassPoint(359), "N");
    assert.equal(compassPoint(360), "N");
    assert.equal(compassPoint(-90), "W");
  });
});

describe("camera pitch limits", () => {
  it("keeps level flight and its limits short of the 90° singularity", () => {
    // `calculateCameraOptionsFromCameraLngLatAltRotation` divides by cos(pitch),
    // so a camera pitch of exactly 90 sends the derived center and zoom to
    // infinity. Every value the engine can produce must stay below it.
    assert.ok(MAX_CAMERA_PITCH < 90);
    assert.ok(LEVEL_CAMERA_PITCH <= MAX_CAMERA_PITCH);
    assert.ok(MIN_CAMERA_PITCH >= 0 && MIN_CAMERA_PITCH < LEVEL_CAMERA_PITCH);
  });
});

describe("normalizeFlightSimulatorSettings", () => {
  it("returns the defaults for undefined or empty input", () => {
    assert.deepEqual(
      normalizeFlightSimulatorSettings(undefined),
      DEFAULT_FLIGHT_SIMULATOR_SETTINGS,
    );
    assert.deepEqual(normalizeFlightSimulatorSettings({}), DEFAULT_FLIGHT_SIMULATOR_SETTINGS);
  });

  it("clamps the numeric ranges", () => {
    const low = normalizeFlightSimulatorSettings({ maxSpeedMps: 1, minAltitudeAglMeters: 0 });
    assert.equal(low.maxSpeedMps, FLIGHT_MAX_SPEED_MIN);
    assert.equal(low.minAltitudeAglMeters, FLIGHT_MIN_AGL_MIN);

    const high = normalizeFlightSimulatorSettings({
      maxSpeedMps: 99_999,
      minAltitudeAglMeters: 99_999,
    });
    assert.equal(high.maxSpeedMps, FLIGHT_MAX_SPEED_MAX);
    assert.equal(high.minAltitudeAglMeters, FLIGHT_MIN_AGL_MAX);
  });

  it("rejects junk values in favor of the defaults", () => {
    const settings = normalizeFlightSimulatorSettings({
      maxSpeedMps: "fast",
      minAltitudeAglMeters: Number.NaN,
      bankCamera: "yes",
      invertPitch: 1,
      units: "furlongs",
    });
    assert.deepEqual(settings, DEFAULT_FLIGHT_SIMULATOR_SETTINGS);
  });

  it("falls back to the defaults for values that coerce to zero", () => {
    // `Number(null)`, `Number("")` and `Number([])` are all 0 — finite, so a
    // bare `Number()` would clamp these to the range minimum (30 m/s, 5 m)
    // rather than restoring the documented default.
    for (const junk of [null, "", [], "   "]) {
      const settings = normalizeFlightSimulatorSettings({
        maxSpeedMps: junk,
        minAltitudeAglMeters: junk,
      });
      assert.equal(
        settings.maxSpeedMps,
        DEFAULT_FLIGHT_SIMULATOR_SETTINGS.maxSpeedMps,
        `${JSON.stringify(junk)} should fall back, not clamp`,
      );
      assert.equal(
        settings.minAltitudeAglMeters,
        DEFAULT_FLIGHT_SIMULATOR_SETTINGS.minAltitudeAglMeters,
      );
    }
  });

  it("still accepts a numeric string", () => {
    assert.equal(normalizeFlightSimulatorSettings({ maxSpeedMps: "120" }).maxSpeedMps, 120);
  });

  it("keeps valid non-default choices", () => {
    const settings = normalizeFlightSimulatorSettings({
      units: "metric",
      bankCamera: false,
      invertPitch: true,
    });
    assert.equal(settings.units, "metric");
    assert.equal(settings.bankCamera, false);
    assert.equal(settings.invertPitch, true);
  });
});

describe("flight simulator store", () => {
  it("opens and closes the panel", () => {
    resetStore();
    assert.equal(isFlightSimulatorPanelVisible(), false);
    openFlightSimulatorPanel(mapLessApp);
    assert.equal(isFlightSimulatorPanelVisible(), true);
    closeFlightSimulatorPanel(mapLessApp);
    assert.equal(isFlightSimulatorPanelVisible(), false);
  });

  it("cannot fly without a map, and says so", () => {
    resetStore();
    openFlightSimulatorPanel(mapLessApp);
    assert.equal(startFlying(), false);
    assert.equal(isFlying(), false);
    // Stopping when nothing is flying must be a safe no-op.
    stopFlying();
    assert.equal(isFlying(), false);
  });

  it("reports an idle HUD while not flying", () => {
    resetStore();
    const hud = getFlightHudSnapshot();
    assert.equal(hud.flying, false);
    assert.equal(hud.airspeedMps, 0);
  });

  it("merges and normalizes settings patches", () => {
    resetStore();
    setFlightSimulatorSettings({ units: "metric" });
    assert.equal(getFlightSimulatorSettings().units, "metric");
    // Out-of-range values are clamped rather than stored raw.
    setFlightSimulatorSettings({ maxSpeedMps: 99_999 });
    assert.equal(getFlightSimulatorSettings().maxSpeedMps, FLIGHT_MAX_SPEED_MAX);
    // Untouched fields survive a partial patch.
    assert.equal(getFlightSimulatorSettings().units, "metric");
    resetStore();
  });
});

describe("flight simulator project state", () => {
  it("stores nothing while closed and at defaults", () => {
    resetStore();
    assert.equal(flightSimulatorPlugin.getProjectState?.(), undefined);
  });

  it("stores the open flag and settings once the panel is open", () => {
    resetStore();
    openFlightSimulatorPanel(mapLessApp);
    setFlightSimulatorSettings({ units: "metric", bankCamera: false });
    const state = flightSimulatorPlugin.getProjectState?.() as Record<string, unknown>;
    assert.equal(state.open, true);
    assert.equal(state.units, "metric");
    assert.equal(state.bankCamera, false);
    resetStore();
  });

  it("stores non-default settings even while the panel is closed", () => {
    resetStore();
    setFlightSimulatorSettings({ invertPitch: true });
    const state = flightSimulatorPlugin.getProjectState?.() as Record<string, unknown>;
    assert.equal(state.open, false);
    assert.equal(state.invertPitch, true);
    resetStore();
  });

  it("round-trips through applyProjectState", () => {
    resetStore();
    openFlightSimulatorPanel(mapLessApp);
    setFlightSimulatorSettings({ units: "metric", maxSpeedMps: 120, invertPitch: true });
    const saved = flightSimulatorPlugin.getProjectState?.();

    resetStore();
    assert.equal(isFlightSimulatorPanelVisible(), false);
    assert.equal(getFlightSimulatorSettings().units, "imperial");

    flightSimulatorPlugin.applyProjectState?.(mapLessApp, saved);
    assert.equal(isFlightSimulatorPanelVisible(), true);
    const restored = getFlightSimulatorSettings();
    assert.equal(restored.units, "metric");
    assert.equal(restored.maxSpeedMps, 120);
    assert.equal(restored.invertPitch, true);
    resetStore();
  });

  it("never restores a project into an in-flight state", () => {
    resetStore();
    // Even if a hand-edited project claims the simulator was flying, reopening
    // it must not seize the camera and the keyboard.
    flightSimulatorPlugin.applyProjectState?.(mapLessApp, { open: true, flying: true });
    assert.equal(isFlightSimulatorPanelVisible(), true);
    assert.equal(isFlying(), false);
    resetStore();
  });

  it("resets to defaults for missing or malformed state", () => {
    resetStore();
    openFlightSimulatorPanel(mapLessApp);
    setFlightSimulatorSettings({ units: "metric" });

    assert.equal(restoreFlightSimulator(mapLessApp, undefined), false);
    assert.equal(isFlightSimulatorPanelVisible(), false);
    assert.deepEqual(getFlightSimulatorSettings(), DEFAULT_FLIGHT_SIMULATOR_SETTINGS);

    assert.equal(restoreFlightSimulator(mapLessApp, "not an object"), false);
    assert.equal(isFlightSimulatorPanelVisible(), false);
  });

  it("closes the panel when the saved state says it was closed", () => {
    resetStore();
    openFlightSimulatorPanel(mapLessApp);
    flightSimulatorPlugin.applyProjectState?.(mapLessApp, { open: false, units: "metric" });
    assert.equal(isFlightSimulatorPanelVisible(), false);
    assert.equal(getFlightSimulatorSettings().units, "metric");
    resetStore();
  });
});

// ---------------------------------------------------------------------------
// Engine lifecycle against a stubbed map.
//
// These cover what the map-less cases above cannot reach: taking over the map
// and handing it back. The `flying` case is a regression test — the engine
// originally derived "am I flying?" from its `requestAnimationFrame` handle,
// which `tick()` nulls on entry, so the HUD reported `flying: false` for the
// whole body of every frame. That left the panel button stuck on "Start flying"
// and silently suppressed the terrain warning.
// ---------------------------------------------------------------------------

interface StubHandler {
  enabled: boolean;
  isEnabled: () => boolean;
  enable: () => void;
  disable: () => void;
}

function stubHandler(enabled = true): StubHandler {
  const handler: StubHandler = {
    enabled,
    isEnabled: () => handler.enabled,
    enable: () => {
      handler.enabled = true;
    },
    disable: () => {
      handler.enabled = false;
    },
  };
  return handler;
}

/** The slice of the MapLibre API the flight engine actually touches. */
function stubMap() {
  const handlers: Record<string, StubHandler> = {};
  for (const key of [
    "dragPan",
    "scrollZoom",
    "boxZoom",
    "dragRotate",
    "keyboard",
    "doubleClickZoom",
    "touchZoomRotate",
    "touchPitch",
  ]) {
    handlers[key] = stubHandler();
  }
  const state = {
    maxPitch: 85,
    pitch: 30,
    centerClamped: true,
    jumps: [] as Array<{ options: Record<string, unknown>; eventData?: Record<string, unknown> }>,
  };
  return {
    ...handlers,
    state,
    getCenter: () => ({ lng: -121.76, lat: 46.85 }),
    getZoom: () => 14,
    getBearing: () => 0,
    getPitch: () => state.pitch,
    getCanvas: () => ({ clientHeight: 648 }),
    getMaxPitch: () => state.maxPitch,
    setMaxPitch: (value: number) => {
      state.maxPitch = value;
    },
    getCenterClampedToGround: () => state.centerClamped,
    setCenterClampedToGround: (value: boolean) => {
      state.centerClamped = value;
    },
    // A flat 1000 m plateau, so altitude-above-ground math is checkable.
    queryTerrainElevation: () => 1000,
    calculateCameraOptionsFromCameraLngLatAltRotation: (
      lngLat: [number, number],
      alt: number,
      bearing: number,
      pitch: number,
      roll?: number,
    ) => ({ center: lngLat, zoom: 12, bearing, pitch, roll, elevation: alt }),
    jumpTo: (options: Record<string, unknown>, eventData?: Record<string, unknown>) => {
      state.jumps.push({ options, eventData });
    },
  };
}

/** What {@link withStubWindow} hands the test: frame stepping plus key input. */
interface StubWindow {
  /** Advance one 60 Hz frame and run whatever the engine scheduled. */
  pump: () => void;
  /** Press a physical key code (e.g. "PageUp"), as the engine's listener sees it. */
  hold: (code: string) => void;
  /** Release a physical key code. */
  release: (code: string) => void;
}

/**
 * Install a minimal `window` so the engine can install its listeners and tick.
 *
 * The key listeners are captured rather than discarded, so a test can hold a
 * control axis down across frames the way a user does.
 */
function withStubWindow<T>(run: (stub: StubWindow) => T): T {
  const original = (globalThis as { window?: unknown }).window;
  let frame: ((now: number) => void) | null = null;
  let clock = 0;
  const listeners = new Map<string, (event: unknown) => void>();
  (globalThis as { window?: unknown }).window = {
    requestAnimationFrame: (cb: (now: number) => void) => {
      frame = cb;
      return 1;
    },
    cancelAnimationFrame: () => {
      frame = null;
    },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.set(type, handler);
    },
    removeEventListener: (type: string) => {
      listeners.delete(type);
    },
  };
  const dispatch = (type: string, code: string) => {
    listeners.get(type)?.({
      code,
      target: null,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      preventDefault: () => {},
      stopPropagation: () => {},
    });
  };
  const stub: StubWindow = {
    pump: () => {
      const next = frame;
      frame = null;
      clock += 16;
      next?.(clock);
    },
    hold: (code) => dispatch("keydown", code),
    release: (code) => dispatch("keyup", code),
  };
  try {
    return run(stub);
  } finally {
    (globalThis as { window?: unknown }).window = original;
  }
}

describe("flight simulator engine", () => {
  it("reports flying in the HUD across frames, not just at takeoff", () => {
    withStubWindow(({ pump }) => {
      resetStore();
      const map = stubMap();
      openFlightSimulatorPanel({ getMap: () => map } as unknown as GeoLibreAppAPI);
      assert.equal(startFlying(), true);
      assert.equal(isFlying(), true);
      assert.equal(getFlightHudSnapshot().flying, true, "HUD must report flying at takeoff");
      // Several frames in — the regression showed up only here.
      for (let i = 0; i < 5; i += 1) pump();
      assert.equal(isFlying(), true, "still flying after several frames");
      assert.equal(
        getFlightHudSnapshot().flying,
        true,
        "HUD must still report flying mid-animation",
      );
      stopFlying();
      assert.equal(isFlying(), false);
      assert.equal(getFlightHudSnapshot().flying, false);
      resetStore();
    });
  });

  it("takes over the map on start and hands it back on stop", () => {
    withStubWindow(() => {
      resetStore();
      const map = stubMap();
      openFlightSimulatorPanel({ getMap: () => map } as unknown as GeoLibreAppAPI);
      startFlying();

      // Every interaction handler is suspended — `keyboard` above all, since
      // MapLibre binds the arrow keys the simulator needs.
      assert.equal(map.dragPan.enabled, false);
      assert.equal(map.keyboard.enabled, false);
      assert.equal(map.scrollZoom.enabled, false);
      // The center must stop being pinned to the terrain surface.
      assert.equal(map.state.centerClamped, false);

      stopFlying();
      assert.equal(map.dragPan.enabled, true, "handlers must be re-enabled");
      assert.equal(map.keyboard.enabled, true);
      assert.equal(map.state.centerClamped, true, "center clamping must be restored");
      assert.equal(map.state.maxPitch, 85, "pitch ceiling must be restored");
      resetStore();
    });
  });

  it("enables 3D terrain for flight and restores the previous terrain state", () => {
    withStubWindow(() => {
      resetStore();
      const map = stubMap();
      let terrainEnabled = false;
      const app = {
        getMap: () => map,
        setTerrainEnabled: (enabled: boolean) => {
          terrainEnabled = enabled;
          return true;
        },
      } as unknown as GeoLibreAppAPI;
      openFlightSimulatorPanel(app);

      startFlying();
      assert.equal(terrainEnabled, true, "takeoff must enable 3D terrain");

      stopFlying();
      assert.equal(terrainEnabled, false, "landing must restore terrain to off");
      resetStore();
    });
  });

  it("preserves a custom terrain source that was already active before flight", () => {
    withStubWindow(() => {
      resetStore();
      const map = stubMap();
      map.getTerrain = () => ({ source: "custom-terrain" });
      const terrainChanges: boolean[] = [];
      const app = {
        getMap: () => map,
        setTerrainEnabled: (enabled: boolean) => {
          terrainChanges.push(enabled);
          return true;
        },
      } as unknown as GeoLibreAppAPI;
      openFlightSimulatorPanel(app);

      startFlying();
      stopFlying();
      assert.deepEqual(terrainChanges, [], "pre-existing terrain must not be replaced or disabled");
      resetStore();
    });
  });

  it("restores the pre-flight pitch rather than leaving the flight's own tilt", () => {
    withStubWindow(({ pump }) => {
      resetStore();
      const map = stubMap();
      openFlightSimulatorPanel({ getMap: () => map } as unknown as GeoLibreAppAPI);
      startFlying();
      pump();
      stopFlying();
      const last = map.state.jumps.at(-1);
      assert.equal(last?.options.roll, 0, "wings must be levelled on exit");
      assert.equal(last?.options.pitch, 30, "the pitch the user started from");
      resetStore();
    });
  });

  it("tags every camera jump so the app's moveend listeners can skip them", () => {
    withStubWindow(({ pump }) => {
      resetStore();
      const map = stubMap();
      openFlightSimulatorPanel({ getMap: () => map } as unknown as GeoLibreAppAPI);
      startFlying();
      for (let i = 0; i < 3; i += 1) pump();
      // Every jump but the final exit one carries the token; without it the
      // viewport history would gain ~60 entries a second.
      const flightJumps = map.state.jumps.filter((jump) => jump.eventData);
      assert.ok(flightJumps.length >= 2, "the engine should have driven the camera");
      for (const jump of flightJumps) {
        assert.equal(typeof jump.eventData?.[FLIGHT_CAMERA_TOKEN], "number");
      }
      stopFlying();
      resetStore();
    });
  });

  it("keeps the camera pitch below the projection singularity while flying", () => {
    withStubWindow(({ pump }) => {
      resetStore();
      const map = stubMap();
      openFlightSimulatorPanel({ getMap: () => map } as unknown as GeoLibreAppAPI);
      startFlying();
      for (let i = 0; i < 10; i += 1) pump();
      const pitches = map.state.jumps
        .filter((jump) => jump.eventData)
        .map((jump) => jump.options.pitch as number);
      assert.ok(pitches.length > 0);
      for (const pitch of pitches) {
        assert.ok(pitch <= MAX_CAMERA_PITCH, `camera pitch ${pitch} exceeded the cap`);
        assert.ok(pitch >= MIN_CAMERA_PITCH, `camera pitch ${pitch} below the floor`);
      }
      stopFlying();
      resetStore();
    });
  });

  it("starts every flight at the cruise throttle, not the previous flight's", () => {
    withStubWindow(({ pump, hold, release }) => {
      resetStore();
      const map = stubMap();
      openFlightSimulatorPanel({ getMap: () => map } as unknown as GeoLibreAppAPI);
      startFlying();
      pump();
      const cruise = getFlightHudSnapshot().throttle;

      // Firewall the throttle, which is what a user does before landing.
      hold("PageUp");
      for (let i = 0; i < 40; i += 1) pump();
      release("PageUp");
      assert.ok(
        getFlightHudSnapshot().throttle > cruise,
        "holding PageUp should have raised the throttle",
      );

      // Land and take off again: the airspeed is re-seeded to idle, so carrying
      // the old throttle over would leave the HUD and the handling disagreeing.
      stopFlying();
      startFlying();
      pump();
      assert.equal(
        getFlightHudSnapshot().throttle,
        cruise,
        "a new flight must not inherit the previous flight's throttle",
      );
      stopFlying();
      resetStore();
    });
  });

  it("does not outlive a stop triggered from a HUD subscriber", () => {
    withStubWindow(({ pump }) => {
      resetStore();
      const map = stubMap();
      openFlightSimulatorPanel({ getMap: () => map } as unknown as GeoLibreAppAPI);
      startFlying();
      // Arm only after takeoff, so the stop lands on a HUD publish from inside
      // tick() — where the rAF handle has already been nulled, making stop()'s
      // cancelAnimationFrame a no-op. tick() throttles the HUD to 100 ms, so
      // this needs several 16 ms frames to trigger.
      let armed = true;
      const unsubscribe = subscribeFlightHud(() => {
        if (armed && isFlying()) {
          armed = false;
          stopFlying();
        }
      });
      for (let i = 0; i < 10 && armed; i += 1) pump();
      unsubscribe();
      assert.equal(armed, false, "the HUD must have published from inside tick()");
      assert.equal(isFlying(), false, "the subscriber's stop must take effect");
      const jumpsAfterStop = map.state.jumps.length;
      pump();
      pump();
      assert.equal(
        map.state.jumps.length,
        jumpsAfterStop,
        "the loop must not keep driving the camera after the map was handed back",
      );
      resetStore();
    });
  });

  it("does not tear down a live flight when the map instance is unchanged", () => {
    withStubWindow(({ pump }) => {
      resetStore();
      const map = stubMap();
      const app = { getMap: () => map } as unknown as GeoLibreAppAPI;
      openFlightSimulatorPanel(app);
      startFlying();
      pump();
      // The host calls this from an effect that also re-runs on a project load.
      reattachFlightSimulator(app);
      assert.equal(isFlying(), true, "an unchanged map must not interrupt the flight");
      // A missing map means the old instance has been removed while the host
      // rebuilds it, so the engine must release that stale instance.
      reattachFlightSimulator({ getMap: () => null } as unknown as GeoLibreAppAPI);
      assert.equal(isFlying(), false, "a missing map must tear down the old engine");

      // Reattach the original engine so the replacement-map case also starts
      // from a live flight rather than merely asserting the already-idle state.
      reattachFlightSimulator(app);
      assert.equal(startFlying(), true);
      assert.equal(isFlying(), true);
      // A genuinely new map still rebinds (and ends the old flight with it).
      reattachFlightSimulator({ getMap: () => stubMap() } as unknown as GeoLibreAppAPI);
      assert.equal(isFlying(), false, "a new map instance must rebind the engine");
      resetStore();
    });
  });

  it("seeds the aircraft above the terrain, inside the flyable band", () => {
    withStubWindow(() => {
      resetStore();
      const map = stubMap();
      openFlightSimulatorPanel({ getMap: () => map } as unknown as GeoLibreAppAPI);
      startFlying();
      const hud = getFlightHudSnapshot();
      // Terrain is a flat 1000 m plateau in the stub.
      assert.ok(hud.altitudeMeters > 1000, "must start above the ground");
      assert.ok(hud.aglMeters >= 200, "must start at least the seed floor above ground");
      assert.ok(hud.aglMeters <= 8000, "must not start in the stratosphere");
      stopFlying();
      resetStore();
    });
  });
});
