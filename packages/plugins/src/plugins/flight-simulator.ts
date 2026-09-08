/**
 * Flight Simulator plugin — an interactive, keyboard-driven free-flight camera
 * over GeoLibre's terrain and 3D layers (issue #1454).
 *
 * Every other camera path in the app is scripted and discrete: `flyTo` from Set
 * View, story-map chapters, the keyframe Camera Tour recorder. This one is
 * continuous — an aircraft state is integrated each animation frame and the
 * MapLibre camera is placed to match, so the user steers rather than declares a
 * destination.
 *
 * **How the camera is driven.** MapLibre has no `setFreeCameraOptions` (that is
 * a Mapbox API added after the fork); its equivalent is
 * `map.calculateCameraOptionsFromCameraLngLatAltRotation()`, which converts a
 * camera position in lng/lat/altitude plus an orientation into the
 * `CameraOptions` that `jumpTo` accepts. The flight model lives in
 * `flight-simulator-physics.ts` so it can be unit-tested without a map.
 *
 * **Why the camera pitch saturates.** That conversion finds the ground point the
 * camera looks at by dividing by `cos(pitch)`, so a pitch of exactly 90° (dead
 * level with the horizon) puts the map center — and the derived zoom — at
 * infinity. The camera is therefore capped at {@link MAX_CAMERA_PITCH}, just
 * short of it. Level flight looks slightly downward, which is also what keeps
 * terrain rather than empty sky filling the viewport.
 */

import type { CesiumSceneHandle } from "@geolibre/map";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  DEFAULT_FLIGHT_MODEL,
  type AircraftState,
  type FlightControls,
  type FlightModelConfig,
  altitudeAboveGround,
  altitudeForZoom,
  constrainToTerrain,
  stepFlight,
} from "./flight-simulator-physics";

export const FLIGHT_SIMULATOR_PLUGIN_ID = "geolibre-flight-simulator";

/**
 * Marker merged into the event data of every camera jump the simulator makes.
 *
 * The app's `moveend` listeners (viewport history, the store's view sync,
 * collaboration presence) treat a settled camera as user navigation. At 60
 * frames a second that would flood the back/forward stack, overwrite the saved
 * project view, and spam collaborators. Tagging the events lets those listeners
 * skip them, exactly as the story presenter's `storyCameraToken` already does.
 */
export const FLIGHT_CAMERA_TOKEN = "flightCameraToken";

/**
 * MapLibre camera pitch for level flight, in degrees from straight-down.
 * Slightly below the 90° horizon so the view leads into the terrain ahead.
 */
export const LEVEL_CAMERA_PITCH = 78;

/**
 * Hard cap on camera pitch. `calculateCameraOptionsFromCameraLngLatAltRotation`
 * divides by `cos(pitch)`, so 90° diverges; 85° is both safe and MapLibre's own
 * conventional maximum.
 */
export const MAX_CAMERA_PITCH = 85;

/** Lower bound on camera pitch, so a steep dive still shows some horizon. */
export const MIN_CAMERA_PITCH = 20;

/** How fast held throttle keys move the throttle, in units per second. */
const THROTTLE_RATE_PER_SEC = 0.6;

/** Throttle change applied immediately for a discrete key press. */
const THROTTLE_KEY_STEP = 0.05;

/** Throttle every flight starts at — a cruise setting, not idle or full power. */
const DEFAULT_THROTTLE = 0.6;

/**
 * Largest time step the model will integrate, in seconds. A backgrounded tab
 * pauses `requestAnimationFrame`; without this cap the first frame after
 * returning would teleport the aircraft kilometers downrange.
 *
 * Matches the cap the route-animation engine uses, and for a second reason: a
 * cap *below* the real frame interval makes simulated time run slower than
 * wall-clock time, so on weak hardware (software WebGL with terrain enabled,
 * ~7 fps) the aircraft would fly in visible slow motion.
 */
const MAX_STEP_SECONDS = 0.25;

/** Maximum integration slice. Short slices keep keyboard handling and terrain
 * collision stable when rendering drops below 30 fps. */
const MAX_PHYSICS_STEP_SECONDS = 1 / 30;

/** Floor for the seeded altitude, in meters above the terrain. */
const MIN_SEED_ALTITUDE_AGL = 200;

/** Ceiling for the seeded altitude, in meters above the terrain. */
const MAX_SEED_ALTITUDE_AGL = 8000;

/** How often the HUD is notified, in ms. The camera still updates every frame. */
const HUD_REFRESH_MS = 100;

/**
 * Lowest ground height the Cesium adapter accepts from `globe.getHeight`, in
 * metres: below the lowest land (the Dead Sea shore, −430 m) and above the
 * skirt depths a coarse terrain tile interpolates to.
 */
const MIN_GROUND_HEIGHT_METERS = -500;

/** Physical key codes (layout-independent) bound to each control axis. */
const KEYS = {
  pitchForward: ["ArrowUp"],
  pitchBack: ["ArrowDown"],
  rollLeft: ["ArrowLeft", "KeyA"],
  rollRight: ["ArrowRight", "KeyD"],
  throttleUp: ["PageUp", "KeyW"],
  throttleDown: ["PageDown", "KeyS"],
  level: ["Space"],
  exit: ["Escape"],
} as const;

/** Every key code the simulator consumes while flying. */
const ALL_FLIGHT_KEYS = new Set<string>(Object.values(KEYS).flat());

/**
 * MapLibre interaction handlers suspended while flying, so a stray scroll or
 * drag cannot fight the flight model. `keyboard` matters most: MapLibre binds
 * the arrow keys to pan/rotate/tilt, which would double-handle every input.
 */
const INTERACTION_HANDLERS = [
  "dragPan",
  "scrollZoom",
  "boxZoom",
  "dragRotate",
  "keyboard",
  "doubleClickZoom",
  "touchZoomRotate",
  "touchPitch",
] as const;

/** User-adjustable simulator settings, persisted with the project. */
export interface FlightSimulatorSettings {
  /** Airspeed at full throttle, m/s. */
  maxSpeedMps: number;
  /** Minimum height above the terrain, m. */
  minAltitudeAglMeters: number;
  /** Roll the horizon with the aircraft during a banked turn. */
  bankCamera: boolean;
  /**
   * Swap the pitch axis. Off follows Google Earth's keyboard controls:
   * Arrow Up climbs and Arrow Down dives.
   */
  invertPitch: boolean;
  /** Which units the HUD reads out in. */
  units: FlightUnits;
}

export type FlightUnits = "imperial" | "metric";

export const FLIGHT_UNITS: readonly FlightUnits[] = ["imperial", "metric"] as const;

export const FLIGHT_MAX_SPEED_MIN = 30;
export const FLIGHT_MAX_SPEED_MAX = 400;
export const FLIGHT_MIN_AGL_MIN = 5;
export const FLIGHT_MIN_AGL_MAX = 500;

export const DEFAULT_FLIGHT_SIMULATOR_SETTINGS: FlightSimulatorSettings = {
  maxSpeedMps: DEFAULT_FLIGHT_MODEL.maxSpeedMps,
  minAltitudeAglMeters: DEFAULT_FLIGHT_MODEL.minAltitudeAglMeters,
  bankCamera: true,
  invertPitch: false,
  units: "imperial",
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  // Coerce only real numbers and non-empty numeric strings. `Number(null)`,
  // `Number("")` and `Number([])` are all 0 — finite, so a bare `Number()` would
  // clamp those to `min` rather than falling back to the documented default.
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

/**
 * Coerce an unknown value (a project file's saved state) into valid settings.
 *
 * @param value - Raw persisted state, possibly from an older version.
 * @returns Fully populated settings with every field in range.
 */
export function normalizeFlightSimulatorSettings(value: unknown): FlightSimulatorSettings {
  const raw = (value ?? {}) as Partial<Record<keyof FlightSimulatorSettings, unknown>>;
  const units = raw.units;
  return {
    maxSpeedMps: clampNumber(
      raw.maxSpeedMps,
      FLIGHT_MAX_SPEED_MIN,
      FLIGHT_MAX_SPEED_MAX,
      DEFAULT_FLIGHT_SIMULATOR_SETTINGS.maxSpeedMps,
    ),
    minAltitudeAglMeters: clampNumber(
      raw.minAltitudeAglMeters,
      FLIGHT_MIN_AGL_MIN,
      FLIGHT_MIN_AGL_MAX,
      DEFAULT_FLIGHT_SIMULATOR_SETTINGS.minAltitudeAglMeters,
    ),
    bankCamera: typeof raw.bankCamera === "boolean" ? raw.bankCamera : true,
    invertPitch: typeof raw.invertPitch === "boolean" ? raw.invertPitch : false,
    units: units === "metric" || units === "imperial" ? units : "imperial",
  };
}

function settingsEqual(a: FlightSimulatorSettings, b: FlightSimulatorSettings): boolean {
  return (
    a.maxSpeedMps === b.maxSpeedMps &&
    a.minAltitudeAglMeters === b.minAltitudeAglMeters &&
    a.bankCamera === b.bankCamera &&
    a.invertPitch === b.invertPitch &&
    a.units === b.units
  );
}

/** Live instrument readout for the HUD. Replaced wholesale on every refresh. */
export interface FlightHudState {
  /** True while the rAF loop is running. */
  flying: boolean;
  lng: number;
  lat: number;
  /** Altitude above sea level, meters. */
  altitudeMeters: number;
  /** Height above the terrain, meters. */
  aglMeters: number;
  /** Compass heading in degrees. */
  headingDeg: number;
  /** Nose attitude, degrees; positive is nose-up. */
  pitchDeg: number;
  /** Bank angle, degrees; positive is right-wing-down. */
  rollDeg: number;
  /** True airspeed, m/s. */
  airspeedMps: number;
  /** Throttle setting, 0–1. */
  throttle: number;
  /** True while the terrain floor is holding the aircraft up. */
  grounded: boolean;
}

const IDLE_HUD: FlightHudState = {
  flying: false,
  lng: 0,
  lat: 0,
  altitudeMeters: 0,
  aglMeters: 0,
  headingDeg: 0,
  pitchDeg: 0,
  rollDeg: 0,
  airspeedMps: 0,
  throttle: 0,
  grounded: false,
};

/** MapLibre map state saved on entry and restored when flight ends. */
interface SavedMapState {
  maxPitch: number;
  /** Camera pitch before flight, restored on exit. */
  pitch: number;
  centerClampedToGround: boolean;
  /** Whether 3D terrain was active before flight took ownership of the map. */
  terrainEnabled: boolean;
  enabledHandlers: boolean[];
}

/** Where the aircraft is seeded from: the camera the user was looking through. */
interface FlightSeedView {
  lng: number;
  lat: number;
  zoom: number;
  bearing: number;
  viewportHeightPx: number;
}

/**
 * The renderer-specific half of the simulator (issue #2287).
 *
 * The flight model, the keyboard, the HUD, and the animation loop are the same
 * whichever engine draws the world; only reading the starting view, sampling
 * the ground, taking the camera over, and placing it each frame differ. Those
 * five operations are the adapter, so the 2D map and the globe share one
 * {@link FlightSimulatorEngine} instead of two drifting copies.
 */
interface FlightCameraAdapter {
  /** The view to seed the aircraft from. */
  seedView(): FlightSeedView;
  /**
   * Rendered terrain height under a position, in meters — as drawn, so with
   * any vertical exaggeration applied (see {@link FlightSimulatorEngine}).
   */
  groundElevation(lng: number, lat: number): number;
  /** Suspend interaction, widen the pitch limit, enable terrain. */
  takeOver(): void;
  /** Place the camera at the aircraft. */
  applyCamera(state: AircraftState, cameraPitch: number, roll: number): void;
  /** Level the camera and hand the map back. */
  release(): void;
  /** Whether this adapter drives `target` (a MapLibre map or a Cesium widget). */
  drives(target: unknown): boolean;
}

/**
 * The MapLibre adapter: `calculateCameraOptionsFromCameraLngLatAltRotation`
 * (see the module header), interaction handlers suspended while flying, and
 * the pitch ceiling widened so the camera is not clamped flat.
 */
class MapLibreFlightAdapter implements FlightCameraAdapter {
  private saved: SavedMapState | null = null;
  private cameraToken = 0;

  constructor(
    private readonly map: MapLibreMap,
    private readonly setTerrainEnabled?: (enabled: boolean) => boolean,
  ) {}

  drives(target: unknown): boolean {
    return target === this.map;
  }

  seedView(): FlightSeedView {
    const center = this.map.getCenter();
    return {
      lng: center.lng,
      lat: center.lat,
      zoom: this.map.getZoom(),
      bearing: this.map.getBearing(),
      viewportHeightPx: this.map.getCanvas()?.clientHeight ?? 600,
    };
  }

  groundElevation(lng: number, lat: number): number {
    try {
      const elevation = this.map.queryTerrainElevation?.([lng, lat]);
      return Number.isFinite(elevation) ? (elevation as number) : 0;
    } catch {
      // Terrain can be mid-teardown (style reload); sea level is a safe floor.
      return 0;
    }
  }

  takeOver(): void {
    const handlers = INTERACTION_HANDLERS.map((key) => this.map[key]);
    this.saved = {
      maxPitch: this.map.getMaxPitch(),
      pitch: this.map.getPitch(),
      centerClampedToGround: this.map.getCenterClampedToGround(),
      terrainEnabled: this.map.getTerrain?.() != null,
      enabledHandlers: handlers.map((handler) => handler.isEnabled()),
    };
    // Terrain is part of flight mode, not an optional prerequisite. Enable it
    // before seeding the aircraft so its starting altitude is measured above
    // the rendered ground rather than sea level.
    if (!this.saved.terrainEnabled) this.setTerrainEnabled?.(true);
    for (const handler of handlers) handler.disable();
    // The app's default max pitch is 85 but a user preference can lower it;
    // flight needs the full range or the camera would be clamped flat.
    if (this.map.getMaxPitch() < MAX_CAMERA_PITCH) this.map.setMaxPitch(MAX_CAMERA_PITCH);
    // MapLibre pins the map center to the terrain surface by default, which
    // would drag the camera down with the ground passing beneath it.
    this.map.setCenterClampedToGround(false);
  }

  applyCamera(state: AircraftState, cameraPitch: number, roll: number): void {
    try {
      const options = this.map.calculateCameraOptionsFromCameraLngLatAltRotation(
        [state.lng, state.lat],
        state.altitude,
        state.heading,
        cameraPitch,
        roll,
      );
      this.map.jumpTo(options, { [FLIGHT_CAMERA_TOKEN]: ++this.cameraToken });
    } catch {
      // A style/terrain reload can briefly make camera conversion unavailable.
      // Keep the simulation alive; the next animation frame will retry.
    }
  }

  release(): void {
    if (!this.saved) return;
    const { maxPitch, pitch, centerClampedToGround, terrainEnabled, enabledHandlers } = this.saved;
    // Level the wings and return to the tilt the user started from, keeping
    // where they flew to. Leaving the flight's own ~78 deg pitch in place
    // would drop them into a near-horizon view spanning half a continent.
    // Done *before* the pitch ceiling is reinstated so the exit view is one
    // the app considers valid and the store's `moveend` sync records it.
    this.map.jumpTo({ roll: 0, pitch: Math.min(pitch, maxPitch) });
    this.map.setMaxPitch(maxPitch);
    if (!terrainEnabled) this.setTerrainEnabled?.(false);
    this.map.setCenterClampedToGround(centerClampedToGround);
    INTERACTION_HANDLERS.forEach((key, index) => {
      if (enabledHandlers[index]) this.map[key].enable();
    });
    this.saved = null;
  }
}

/**
 * The Cesium adapter: the camera is placed with `camera.setView` from the
 * aircraft's own position and attitude (Cesium's camera is a free camera, so
 * there is no MapLibre-style conversion and no pitch singularity), and
 * `screenSpaceCameraController.enableInputs` stands in for the suspended
 * MapLibre handlers.
 *
 * Cesium's pitch is horizon-referenced (0 level, −90° straight down) where the
 * flight model and MapLibre's are nadir-referenced, so the MapLibre camera
 * pitch the engine computes is shifted by 90° here; the same
 * {@link LEVEL_CAMERA_PITCH} then reads as a slight nose-down view on both.
 */
class CesiumFlightAdapter implements FlightCameraAdapter {
  private restoreInputs: (() => void) | null = null;
  private savedTerrainEnabled = false;
  private savedPitch = 0;

  constructor(
    private readonly globe: CesiumSceneHandle,
    private readonly setTerrainEnabled?: (enabled: boolean) => boolean,
    private readonly isTerrainEnabled?: () => boolean,
  ) {}

  drives(target: unknown): boolean {
    return target === this.globe.viewer;
  }

  private live(): boolean {
    return !this.globe.viewer.isDestroyed();
  }

  seedView(): FlightSeedView {
    const { canvas } = this.globe;
    const view = this.globe.readView();
    return {
      lng: view.center[0],
      lat: view.center[1],
      zoom: view.zoom,
      bearing: view.bearing,
      viewportHeightPx: canvas.clientHeight || canvas.height || 600,
    };
  }

  groundElevation(lng: number, lat: number): number {
    if (!this.live()) return 0;
    const { Cesium, scene } = this.globe;
    const globe = scene.globe;
    if (!globe) return 0;
    try {
      const height = globe.getHeight(Cesium.Cartographic.fromDegrees(lng, lat));
      if (typeof height !== "number" || !Number.isFinite(height)) return 0;
      // `getHeight` interpolates whatever tile is loaded at the position. Far
      // from the camera that is a coarse level whose mesh skirts hang
      // kilometres below the surface, and the interpolation returns them as
      // heights (−9 km over Kansas was observed); no land is below −500 m, so
      // anything under that is a skirt, not the ground.
      const grounded = Math.max(height, MIN_GROUND_HEIGHT_METERS);
      // `getHeight` reports the source height; the globe is drawn scaled by
      // `verticalExaggeration`, and the aircraft must clear what is drawn.
      const exaggeration = scene.verticalExaggeration;
      return Number.isFinite(exaggeration) && exaggeration > 0 ? grounded * exaggeration : grounded;
    } catch {
      return 0;
    }
  }

  takeOver(): void {
    if (!this.live()) return;
    const { Cesium, scene, camera } = this.globe;
    this.savedPitch = Cesium.Math.toDegrees(camera.pitch);
    this.savedTerrainEnabled = this.isTerrainEnabled?.() ?? false;
    if (!this.savedTerrainEnabled) this.setTerrainEnabled?.(true);
    const controller = scene.screenSpaceCameraController;
    const previous = controller.enableInputs;
    controller.enableInputs = false;
    this.restoreInputs = () => {
      if (this.live()) controller.enableInputs = previous;
    };
  }

  applyCamera(state: AircraftState, cameraPitch: number, roll: number): void {
    if (!this.live()) return;
    const { Cesium, camera } = this.globe;
    try {
      camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(state.lng, state.lat, state.altitude),
        orientation: {
          heading: Cesium.Math.toRadians(state.heading),
          pitch: Cesium.Math.toRadians(cameraPitch - 90),
          roll: Cesium.Math.toRadians(roll),
        },
      });
      this.globe.requestRender();
    } catch {
      // A morph between scene modes rejects camera writes; retry next frame.
    }
  }

  release(): void {
    this.restoreInputs?.();
    this.restoreInputs = null;
    if (!this.savedTerrainEnabled) this.setTerrainEnabled?.(false);
    if (!this.live()) return;
    const { Cesium, camera } = this.globe;
    try {
      // Level the wings and return to the tilt the user started from, where
      // they flew to — the same exit the 2D adapter gives. Cesium's setView
      // keeps the position when only the orientation is supplied.
      camera.setView({
        orientation: {
          heading: camera.heading,
          pitch: Cesium.Math.toRadians(Math.min(this.savedPitch, 0)),
          roll: 0,
        },
      });
      this.globe.requestRender();
    } catch {
      // Mid-morph; the engine's own morph handling re-applies the view.
    }
  }
}

/**
 * Owns the map while flight mode is active: the animation loop, the keyboard,
 * and the aircraft. The renderer-specific camera work is delegated to a
 * {@link FlightCameraAdapter}.
 */
class FlightSimulatorEngine {
  private settings: FlightSimulatorSettings;
  private aircraft: AircraftState;
  private held = new Set<string>();
  private throttle = DEFAULT_THROTTLE;
  private rafId: number | null = null;
  /**
   * Whether flight is active. Deliberately separate from `rafId`: `tick()` nulls
   * `rafId` on entry and only reassigns it at the end, so deriving "flying" from
   * it reads false for the whole body of every frame — including where the HUD
   * is published.
   */
  private running = false;
  private lastFrame: number | null = null;
  private lastHudAt = 0;
  private grounded = false;
  private destroyed = false;

  constructor(
    private readonly adapter: FlightCameraAdapter,
    settings: FlightSimulatorSettings,
  ) {
    this.settings = settings;
    this.aircraft = this.seedAircraft();
    this.tick = this.tick.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.handleBlur = this.handleBlur.bind(this);
  }

  /** Place the aircraft at the current map view, heading where the map faces. */
  private seedAircraft(): AircraftState {
    const view = this.adapter.seedView();
    const ground = this.groundElevation(view.lng, view.lat);
    // Start from the height the user was already looking from, but inside a
    // band that is actually flyable: a wide view corresponds to an eye height of
    // tens of kilometers, where there is nothing to see and the controls feel
    // inert.
    const altitude = Math.min(
      Math.max(altitudeForZoom(view.lat, view.zoom, view.viewportHeightPx), MIN_SEED_ALTITUDE_AGL),
      MAX_SEED_ALTITUDE_AGL,
    );
    return {
      lng: view.lng,
      lat: view.lat,
      altitude: ground + altitude,
      heading: view.bearing,
      pitch: 0,
      roll: 0,
      airspeed: this.model().minSpeedMps,
    };
  }

  private model(): FlightModelConfig {
    return {
      ...DEFAULT_FLIGHT_MODEL,
      maxSpeedMps: this.settings.maxSpeedMps,
      minAltitudeAglMeters: this.settings.minAltitudeAglMeters,
    };
  }

  /**
   * Rendered terrain height under a position, in meters.
   *
   * Deliberately **not** divided by the terrain exaggeration (unlike
   * `terrain-measure`, which reports true ground distances): the aircraft must
   * clear the mountain the user can see, and an exaggerated map renders that
   * mountain taller than it really is.
   */
  private groundElevation(lng: number, lat: number): number {
    return this.adapter.groundElevation(lng, lat);
  }

  applySettings(settings: FlightSimulatorSettings): void {
    this.settings = settings;
  }

  isFlying(): boolean {
    return this.running;
  }

  /** Whether this engine drives `target`, so a reattach can skip an unchanged one. */
  drives(target: unknown): boolean {
    return this.adapter.drives(target);
  }

  /** Take over the map: suspend interaction, widen the pitch limit, start flying. */
  start(): void {
    if (this.destroyed || this.running) return;
    this.adapter.takeOver();

    this.aircraft = this.seedAircraft();
    this.held.clear();
    // Reset with the rest of the per-flight state: the airspeed is re-seeded to
    // idle, so carrying the previous flight's throttle over would leave the HUD
    // and the handling disagreeing at takeoff.
    this.throttle = DEFAULT_THROTTLE;
    this.grounded = false;
    this.lastFrame = null;
    this.lastHudAt = 0;

    window.addEventListener("keydown", this.handleKeyDown, { capture: true });
    window.addEventListener("keyup", this.handleKeyUp, { capture: true });
    // A tab switch or alt-tab swallows the keyup, which would leave a control
    // axis stuck hard over until the key is pressed and released again.
    window.addEventListener("blur", this.handleBlur);

    this.running = true;
    this.applyCamera();
    this.rafId = window.requestAnimationFrame(this.tick);
    publishHud(this.hudState());
  }

  /** Hand the map back: level the camera, restore limits and interaction. */
  stop(): void {
    const wasRunning = this.running;
    this.running = false;
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    window.removeEventListener("keydown", this.handleKeyDown, { capture: true });
    window.removeEventListener("keyup", this.handleKeyUp, { capture: true });
    window.removeEventListener("blur", this.handleBlur);
    this.held.clear();
    this.lastFrame = null;

    if (wasRunning) this.adapter.release();
    publishHud(IDLE_HUD);
  }

  destroy(): void {
    this.stop();
    this.destroyed = true;
  }

  private handleBlur(): void {
    this.held.clear();
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.isFlying()) return;
    // Never steal keys from a text field — the settings panel has number inputs,
    // and the command palette can be open over the map.
    if (isEditableTarget(event.target)) return;
    if (!ALL_FLIGHT_KEYS.has(event.code)) return;
    // Let the browser keep its own chords (Ctrl+W, Cmd+S, ...).
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if ((KEYS.exit as readonly string[]).includes(event.code)) {
      event.preventDefault();
      event.stopPropagation();
      stopFlying();
      return;
    }
    if ((KEYS.level as readonly string[]).includes(event.code)) {
      event.preventDefault();
      event.stopPropagation();
      this.aircraft = { ...this.aircraft, roll: 0, pitch: 0 };
      return;
    }
    // Arrows and Page Up/Down scroll the page; W/A/S/D would type into nothing
    // here but are claimed for symmetry.
    event.preventDefault();
    event.stopPropagation();
    // A quick key tap can begin and end between animation frames. Apply one
    // discrete throttle step on the initial press so Page Up/Down behave like
    // Google Earth's controls; the held-key path below still provides smooth
    // continuous adjustment.
    if (!event.repeat) {
      const throttleDirection = (KEYS.throttleUp as readonly string[]).includes(event.code)
        ? 1
        : (KEYS.throttleDown as readonly string[]).includes(event.code)
          ? -1
          : 0;
      if (throttleDirection !== 0) {
        this.throttle = Math.min(
          1,
          Math.max(0, this.throttle + throttleDirection * THROTTLE_KEY_STEP),
        );
      }
    }
    this.held.add(event.code);
  }

  private handleKeyUp(event: KeyboardEvent): void {
    if (!ALL_FLIGHT_KEYS.has(event.code)) return;
    this.held.delete(event.code);
  }

  private axis(negative: readonly string[], positive: readonly string[]): number {
    const down = positive.some((code) => this.held.has(code)) ? 1 : 0;
    const up = negative.some((code) => this.held.has(code)) ? 1 : 0;
    return down - up;
  }

  /** Resolve the held keys into control-axis positions for this frame. */
  private controls(dtSeconds: number): FlightControls {
    const throttleInput = this.axis(KEYS.throttleDown, KEYS.throttleUp);
    if (throttleInput !== 0) {
      this.throttle = Math.min(
        1,
        Math.max(0, this.throttle + throttleInput * THROTTLE_RATE_PER_SEC * dtSeconds),
      );
    }
    // Match Google Earth's keyboard controls: ArrowUp climbs and ArrowDown
    // dives. The setting remains available for pilots who prefer a yoke axis.
    const rawPitch = this.axis(KEYS.pitchBack, KEYS.pitchForward);
    return {
      elevator: this.settings.invertPitch ? -rawPitch : rawPitch,
      aileron: this.axis(KEYS.rollLeft, KEYS.rollRight),
      throttle: this.throttle,
    };
  }

  /** Place the camera at the aircraft. */
  private applyCamera(): void {
    const { pitch, roll } = this.aircraft;
    const cameraPitch = Math.min(
      MAX_CAMERA_PITCH,
      Math.max(MIN_CAMERA_PITCH, LEVEL_CAMERA_PITCH + pitch),
    );
    const cameraRoll = this.settings.bankCamera ? roll : 0;
    this.adapter.applyCamera(this.aircraft, cameraPitch, cameraRoll);
  }

  private hudState(): FlightHudState {
    const ground = this.groundElevation(this.aircraft.lng, this.aircraft.lat);
    return {
      flying: this.isFlying(),
      lng: this.aircraft.lng,
      lat: this.aircraft.lat,
      altitudeMeters: this.aircraft.altitude,
      aglMeters: altitudeAboveGround(this.aircraft.altitude, ground),
      headingDeg: this.aircraft.heading,
      pitchDeg: this.aircraft.pitch,
      rollDeg: this.aircraft.roll,
      airspeedMps: this.aircraft.airspeed,
      throttle: this.throttle,
      grounded: this.grounded,
    };
  }

  private tick(now: number): void {
    this.rafId = null;
    if (this.destroyed || !this.running) return;

    if (this.lastFrame !== null) {
      let remaining = Math.max(0, Math.min(MAX_STEP_SECONDS, (now - this.lastFrame) / 1000));
      this.grounded = false;
      while (remaining > 0) {
        const dt = Math.min(MAX_PHYSICS_STEP_SECONDS, remaining);
        const controls = this.controls(dt);
        const model = this.model();
        const ground = this.groundElevation(this.aircraft.lng, this.aircraft.lat);
        const result = stepFlight(this.aircraft, controls, model, dt, ground);
        // Check the terrain at the *new* position as well. Sampling only the
        // departure point lets a fast aircraft enter a steep hillside for one
        // or more frames.
        const arrivalGround = this.groundElevation(result.state.lng, result.state.lat);
        const constrained = constrainToTerrain(
          result.state,
          arrivalGround,
          model.minAltitudeAglMeters,
        );
        this.aircraft = constrained.state;
        this.grounded ||= result.grounded || constrained.grounded;
        remaining -= dt;
      }
      this.applyCamera();
    }
    this.lastFrame = now;

    // The camera moves every frame; the HUD text only needs to be legible.
    if (now - this.lastHudAt >= HUD_REFRESH_MS) {
      this.lastHudAt = now;
      publishHud(this.hudState());
    }
    // Re-check before re-arming: publishHud above notifies subscribers
    // synchronously, and one of them may have stopped the flight. `stop()`
    // cancels `rafId`, but tick() nulled it on entry, so that cancel is a no-op
    // and only this guard keeps the loop from outliving the flight.
    if (!this.running) return;
    this.rafId = window.requestAnimationFrame(this.tick);
  }
}

/**
 * True when a key event targets a text-entry element, so flight controls do not
 * hijack typing. Mirrors the host's own `isEditableTarget` (which lives in the
 * app and cannot be imported from the plugins package).
 */
function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== "string") return false;
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable;
}

// ---------------------------------------------------------------------------
// Module store: one simulator per app, shared by the engine and the React HUD.
// ---------------------------------------------------------------------------

let engine: FlightSimulatorEngine | null = null;
let panelVisible = false;
let settings: FlightSimulatorSettings = { ...DEFAULT_FLIGHT_SIMULATOR_SETTINGS };
let hud: FlightHudState = IDLE_HUD;

const panelListeners = new Set<() => void>();
const hudListeners = new Set<() => void>();

function notifyPanel(): void {
  for (const listener of panelListeners) listener();
}

function publishHud(next: FlightHudState): void {
  hud = next;
  for (const listener of hudListeners) listener();
}

/**
 * The renderer the simulator should bind to: the MapLibre map when there is
 * one, else the primary Cesium globe. `null` while neither is mounted.
 */
function flightTarget(app: GeoLibreAppAPI): MapLibreMap | CesiumSceneHandle | null {
  const map = app.getMap?.() ?? null;
  if (map) return map;
  const globe = app.getCesiumScene?.() ?? null;
  return globe?.primary ? globe : null;
}

function attachEngine(app: GeoLibreAppAPI): void {
  const target = flightTarget(app);
  if (!target) return;
  if (engine) return;
  const adapter =
    "viewer" in target
      ? new CesiumFlightAdapter(target, app.setTerrainEnabled, app.isTerrainEnabled)
      : new MapLibreFlightAdapter(target, app.setTerrainEnabled);
  engine = new FlightSimulatorEngine(adapter, settings);
}

function detachEngine(): void {
  engine?.destroy();
  engine = null;
  hud = IDLE_HUD;
}

/** Open the Flight Simulator panel and attach the engine to the live map. */
export function openFlightSimulatorPanel(app: GeoLibreAppAPI): void {
  if (!panelVisible) {
    panelVisible = true;
    notifyPanel();
  }
  attachEngine(app);
}

/** Close the panel, ending any flight in progress and restoring the map. */
export function closeFlightSimulatorPanel(_app?: GeoLibreAppAPI): void {
  detachEngine();
  if (panelVisible) {
    panelVisible = false;
    notifyPanel();
  }
  publishHud(IDLE_HUD);
}

export function isFlightSimulatorPanelVisible(): boolean {
  return panelVisible;
}

export function subscribeFlightSimulatorPanel(listener: () => void): () => void {
  panelListeners.add(listener);
  return () => panelListeners.delete(listener);
}

export function subscribeFlightHud(listener: () => void): () => void {
  hudListeners.add(listener);
  return () => hudListeners.delete(listener);
}

/** Stable HUD reference for `useSyncExternalStore`. */
export function getFlightHudSnapshot(): FlightHudState {
  return hud;
}

/** Re-attach the engine after the map is rebuilt (style reload, project load). */
export function reattachFlightSimulator(app: GeoLibreAppAPI): void {
  if (!panelVisible) return;
  const target = flightTarget(app);
  // Rebinding tears the engine down, which hands the map back and ends any
  // flight in progress. The host calls this from an effect that also re-runs on
  // a project load, so skip the work when the map instance has not actually
  // changed — that is the only thing a reattach exists to handle.
  const bound = target && "viewer" in target ? target.viewer : target;
  if (bound && engine?.drives(bound)) return;
  detachEngine();
  attachEngine(app);
}

export function getFlightSimulatorSettings(): FlightSimulatorSettings {
  return { ...settings };
}

/** Stable settings reference for `useSyncExternalStore`. */
export function getFlightSimulatorSnapshot(): FlightSimulatorSettings {
  return settings;
}

/** Merge a partial settings patch and push it to the running engine. */
export function setFlightSimulatorSettings(patch: Partial<FlightSimulatorSettings>): void {
  const next = normalizeFlightSimulatorSettings({ ...settings, ...patch });
  if (settingsEqual(next, settings)) return;
  settings = next;
  engine?.applySettings(next);
  notifyPanel();
}

/** Begin flying. No-op when the panel is closed or no map is attached. */
export function startFlying(): boolean {
  if (!engine) return false;
  engine.start();
  notifyPanel();
  return true;
}

/** Stop flying and restore the map's interaction handlers and pitch limit. */
export function stopFlying(): void {
  if (!engine) return;
  engine.stop();
  notifyPanel();
}

export function isFlying(): boolean {
  return engine?.isFlying() ?? false;
}

/** Toggle flight, returning the state it settled into. */
export function toggleFlying(): boolean {
  if (isFlying()) {
    stopFlying();
    return false;
  }
  return startFlying();
}

/**
 * Restore the plugin from a project file's saved state.
 *
 * `flying` is never restored as true: taking over the camera and the keyboard
 * is an explicit user action, not something a loaded project should do.
 */
export function restoreFlightSimulator(app: GeoLibreAppAPI, state: unknown): boolean {
  if (!state || typeof state !== "object") {
    closeFlightSimulatorPanel(app);
    settings = { ...DEFAULT_FLIGHT_SIMULATOR_SETTINGS };
    notifyPanel();
    return false;
  }
  const raw = state as { open?: unknown };
  settings = normalizeFlightSimulatorSettings(state);
  if (raw.open === true) {
    openFlightSimulatorPanel(app);
  } else {
    closeFlightSimulatorPanel(app);
  }
  notifyPanel();
  return true;
}

export const flightSimulatorPlugin: GeoLibrePlugin = {
  id: FLIGHT_SIMULATOR_PLUGIN_ID,
  name: "Flight Simulator",
  version: "1.1.0",
  activeByDefault: false,
  engines: ["maplibre", "cesium"],
  activate: (app: GeoLibreAppAPI) => openFlightSimulatorPanel(app),
  deactivate: (app: GeoLibreAppAPI) => closeFlightSimulatorPanel(app),
  // Persist the panel flag and the handling/HUD preferences, but never the
  // aircraft: a flight starts from wherever the reopened project's view is.
  getProjectState: () => {
    if (!panelVisible && settingsEqual(settings, DEFAULT_FLIGHT_SIMULATOR_SETTINGS))
      return undefined;
    return { open: panelVisible, ...settings };
  },
  applyProjectState: (app: GeoLibreAppAPI, state: unknown) => restoreFlightSimulator(app, state),
};
