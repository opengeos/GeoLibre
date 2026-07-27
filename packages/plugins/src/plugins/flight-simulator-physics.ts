/**
 * Flight model for the Flight Simulator plugin.
 *
 * Deliberately map-free: everything here is pure arithmetic over an
 * {@link AircraftState}, so the flight dynamics can be unit-tested without a
 * MapLibre instance, a DOM, or a GPU (mirroring how `route-animation-geometry`
 * splits out of the route-animation plugin).
 *
 * The model is a coordinated-turn arcade model, not an aerodynamic simulation:
 * bank angle drives turn rate, nose attitude drives climb rate, and throttle
 * drives airspeed. That is the same simplification Google Earth's flight
 * simulator makes at its easier setting, and it is what makes the aircraft
 * controllable with three keyboard axes.
 */

/** Standard gravity, m/s². Sets how hard a given bank angle turns. */
const GRAVITY = 9.80665;

/**
 * Meters per degree of latitude. A sphere approximation is deliberate: at the
 * scale of one animation frame (tens of meters) the ~0.5% difference from the
 * WGS84 ellipsoid is far below the DEM's own resolution, and the flight path is
 * dead-reckoned rather than surveyed.
 */
const METERS_PER_DEGREE_LAT = 111_320;

/**
 * Web Mercator's latitude limit. MapLibre cannot represent a center beyond
 * this, so the aircraft is held short of the poles rather than allowed to
 * produce an unprojectable position.
 */
export const MAX_FLIGHT_LATITUDE = 85.05112878;

/** Below this airspeed a bank angle produces no turn, avoiding a divide-by-zero. */
const MIN_TURN_AIRSPEED = 1;

/** One knot in meters per second, for the HUD's airspeed readout. */
export const KNOTS_PER_MPS = 1.943844;

/** One foot in meters, for the HUD's altitude readout. */
export const FEET_PER_METER = 3.280839895;

/** Where the aircraft is and how it is oriented. */
export interface AircraftState {
  /** Longitude in degrees, normalized to [-180, 180]. */
  lng: number;
  /** Latitude in degrees, clamped to {@link MAX_FLIGHT_LATITUDE}. */
  lat: number;
  /**
   * Altitude in meters above sea level, in the map's **rendered** vertical
   * space — i.e. including terrain exaggeration. Flying at a mountain you can
   * see should hit it, so the altitude is compared against the exaggerated
   * surface rather than true meters.
   */
  altitude: number;
  /** Compass heading in degrees: 0 = north, increasing clockwise. */
  heading: number;
  /** Nose attitude in degrees; positive is nose-up. */
  pitch: number;
  /** Bank angle in degrees; positive is right-wing-down. */
  roll: number;
  /** True airspeed in meters per second. */
  airspeed: number;
}

/** Control-axis positions, each normalized to a unit range. */
export interface FlightControls {
  /** -1 (full nose-down) to +1 (full nose-up). */
  elevator: number;
  /** -1 (roll left) to +1 (roll right). */
  aileron: number;
  /** 0 (idle) to 1 (full power). */
  throttle: number;
}

/** Tunable handling characteristics of the aircraft. */
export interface FlightModelConfig {
  /** Airspeed at idle throttle, m/s. */
  minSpeedMps: number;
  /** Airspeed at full throttle, m/s. */
  maxSpeedMps: number;
  /** How fast airspeed converges on the throttle setting, m/s². */
  accelerationMps2: number;
  /** Maximum elevator authority, degrees of pitch per second. */
  pitchRateDegPerSec: number;
  /** Maximum aileron authority, degrees of roll per second. */
  rollRateDegPerSec: number;
  /** Nose attitude limit in degrees, applied symmetrically. */
  maxPitchDeg: number;
  /** Bank angle limit in degrees, applied symmetrically. */
  maxRollDeg: number;
  /**
   * How fast pitch and roll return to level when the axis is released, in
   * degrees per second. This is the "stability" that makes the aircraft
   * flyable with digital (keyboard) inputs rather than an analog stick.
   */
  levelingRateDegPerSec: number;
  /**
   * Minimum height above the terrain, in meters. The aircraft is held at or
   * above this, so flying into a hillside skims it instead of burying the
   * camera inside the DEM (where the view fills with backface).
   */
  minAltitudeAglMeters: number;
}

export const DEFAULT_FLIGHT_MODEL: FlightModelConfig = {
  minSpeedMps: 30,
  maxSpeedMps: 250,
  accelerationMps2: 25,
  pitchRateDegPerSec: 35,
  rollRateDegPerSec: 60,
  maxPitchDeg: 45,
  maxRollDeg: 70,
  levelingRateDegPerSec: 40,
  minAltitudeAglMeters: 25,
};

/** Neutral stick with the throttle at a cruise setting. */
export const NEUTRAL_CONTROLS: FlightControls = {
  elevator: 0,
  aileron: 0,
  throttle: 0.5,
};

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Wrap a longitude into [-180, 180] so eastbound flight crosses the antimeridian. */
export function normalizeLongitude(lng: number): number {
  if (!Number.isFinite(lng)) return 0;
  // `((x % 360) + 540) % 360 - 180` folds any magnitude into range in one step,
  // including large negatives, where a bare `%` would keep the sign.
  return (((lng % 360) + 540) % 360) - 180;
}

/** Wrap a compass heading into [0, 360). */
export function normalizeHeading(heading: number): number {
  if (!Number.isFinite(heading)) return 0;
  return ((heading % 360) + 360) % 360;
}

/**
 * Move a value toward a target by at most `maxDelta`, without overshooting.
 * Used for the throttle→airspeed lag and the self-leveling of pitch and roll.
 */
export function approach(current: number, target: number, maxDelta: number): number {
  const difference = target - current;
  if (Math.abs(difference) <= maxDelta) return target;
  return current + Math.sign(difference) * maxDelta;
}

/**
 * Rate of heading change for a coordinated turn, in degrees per second.
 *
 * The standard result `ω = g·tan(φ) / V`: a steeper bank or a slower aircraft
 * turns tighter. Returns 0 below {@link MIN_TURN_AIRSPEED} so a stopped
 * aircraft does not spin on the spot (and never divides by zero).
 *
 * @param rollDeg - Bank angle in degrees; positive banks right.
 * @param airspeedMps - True airspeed in meters per second.
 * @returns Turn rate in degrees per second; positive turns right.
 */
export function turnRateDegPerSec(rollDeg: number, airspeedMps: number): number {
  if (airspeedMps < MIN_TURN_AIRSPEED) return 0;
  return ((GRAVITY * Math.tan(rollDeg * DEG_TO_RAD)) / airspeedMps) * RAD_TO_DEG;
}

/**
 * Offset a geographic position by a local east/north displacement in meters.
 *
 * Uses the flat-earth approximation around the current latitude, which is
 * accurate well past the per-frame distances this is called with. The
 * longitude scale is guarded near the poles, where a meter of easting spans an
 * unbounded number of degrees.
 *
 * @param lng - Starting longitude in degrees.
 * @param lat - Starting latitude in degrees.
 * @param eastMeters - Displacement toward east, in meters.
 * @param northMeters - Displacement toward north, in meters.
 * @returns The offset position, longitude-wrapped and latitude-clamped.
 */
export function offsetPosition(
  lng: number,
  lat: number,
  eastMeters: number,
  northMeters: number,
): { lng: number; lat: number } {
  const nextLat = clamp(
    lat + northMeters / METERS_PER_DEGREE_LAT,
    -MAX_FLIGHT_LATITUDE,
    MAX_FLIGHT_LATITUDE,
  );
  // Guard the cosine so a near-polar position cannot blow the longitude step up
  // to infinity; 0.01 caps the stretch at ~100x, well inside the clamped range.
  const metersPerDegreeLng = Math.max(
    METERS_PER_DEGREE_LAT * Math.cos(lat * DEG_TO_RAD),
    METERS_PER_DEGREE_LAT * 0.01,
  );
  return {
    lng: normalizeLongitude(lng + eastMeters / metersPerDegreeLng),
    lat: nextLat,
  };
}

/** Outcome of one integration step. */
export interface FlightStepResult {
  /** The aircraft state after the step. */
  state: AircraftState;
  /**
   * True when the terrain floor held the aircraft up during this step — i.e.
   * it is skimming or has "landed". The HUD surfaces this as a ground warning.
   */
  grounded: boolean;
}

/**
 * Advance the aircraft by one time step.
 *
 * Order matters: attitude is integrated first, then the turn it produces, then
 * the translation along the resulting heading. Integrating position before
 * attitude would lag the flight path a frame behind the controls, which reads
 * as sluggish handling at high frame rates.
 *
 * @param state - Current aircraft state.
 * @param controls - Control-axis positions for this step.
 * @param config - Handling characteristics.
 * @param dtSeconds - Elapsed time for this step, in seconds.
 * @param groundElevationMeters - Rendered terrain height under the aircraft, in
 *   meters above sea level. Pass 0 where terrain is unavailable.
 * @returns The new state and whether the terrain floor was hit.
 */
export function stepFlight(
  state: AircraftState,
  controls: FlightControls,
  config: FlightModelConfig,
  dtSeconds: number,
  groundElevationMeters: number,
): FlightStepResult {
  // A non-positive or non-finite step (a paused tab, a clock adjustment) must
  // not move the aircraft or produce NaN coordinates.
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
    return { state, grounded: false };
  }

  const elevator = clamp(controls.elevator, -1, 1);
  const aileron = clamp(controls.aileron, -1, 1);
  const throttle = clamp(controls.throttle, 0, 1);

  // --- Airspeed: lag toward the throttle setting rather than snapping to it.
  const targetSpeed = config.minSpeedMps + throttle * (config.maxSpeedMps - config.minSpeedMps);
  const airspeed = approach(state.airspeed, targetSpeed, config.accelerationMps2 * dtSeconds);

  // --- Attitude: commanded rate while an axis is held, self-leveling when released.
  const leveling = config.levelingRateDegPerSec * dtSeconds;
  const pitch =
    elevator === 0
      ? approach(state.pitch, 0, leveling)
      : clamp(
          state.pitch + elevator * config.pitchRateDegPerSec * dtSeconds,
          -config.maxPitchDeg,
          config.maxPitchDeg,
        );
  const roll =
    aileron === 0
      ? approach(state.roll, 0, leveling)
      : clamp(
          state.roll + aileron * config.rollRateDegPerSec * dtSeconds,
          -config.maxRollDeg,
          config.maxRollDeg,
        );

  // --- Heading: the bank angle turns the aircraft.
  const heading = normalizeHeading(state.heading + turnRateDegPerSec(roll, airspeed) * dtSeconds);

  // --- Translation: split airspeed into its climb and ground components.
  const pitchRad = pitch * DEG_TO_RAD;
  const headingRad = heading * DEG_TO_RAD;
  const groundSpeed = airspeed * Math.cos(pitchRad);
  const verticalSpeed = airspeed * Math.sin(pitchRad);
  const { lng, lat } = offsetPosition(
    state.lng,
    state.lat,
    groundSpeed * Math.sin(headingRad) * dtSeconds,
    groundSpeed * Math.cos(headingRad) * dtSeconds,
  );

  // --- Terrain floor.
  let altitude = state.altitude + verticalSpeed * dtSeconds;
  const floor = groundElevationMeters + config.minAltitudeAglMeters;
  const grounded = altitude <= floor;
  if (grounded) altitude = floor;

  return {
    state: { lng, lat, altitude, heading, pitch, roll, airspeed },
    grounded,
  };
}

/** Height above the terrain in meters, never negative. */
export function altitudeAboveGround(altitude: number, groundElevationMeters: number): number {
  return Math.max(0, altitude - groundElevationMeters);
}

/**
 * Ground resolution at zoom 0 on the equator, in meters per pixel.
 *
 * MapLibre defines zoom against **512-pixel** tiles, so this is half the widely
 * quoted 156543.03 figure (which assumes 256-pixel tiles). Using the 256 value
 * puts the seed altitude at exactly twice the height the user was viewing from.
 */
const EQUATOR_METERS_PER_PIXEL = 78271.51696402048;

/**
 * Tangent of half MapLibre's default vertical field of view (36.87°), the
 * factor relating the camera's height to how much ground it sees. MapLibre
 * derives the same number internally from `fovInRadians`, which is not part of
 * its public `Map` surface — this is only used to *seed* the aircraft at a
 * plausible altitude when flight starts, so an FOV change upstream would shift
 * the starting height slightly and nothing else.
 */
const HALF_FOV_TANGENT = Math.tan(0.6435011087932844 / 2);

/**
 * Camera altitude that roughly reproduces a given map zoom, in meters above the
 * map surface.
 *
 * Used to seed the aircraft when flight mode starts, so it begins at the height
 * the user was already looking from rather than jumping to a fixed altitude.
 *
 * @param lat - Latitude in degrees (Mercator scale varies with it).
 * @param zoom - MapLibre zoom level.
 * @param viewportHeightPx - Height of the map canvas in CSS pixels.
 * @returns Height above the map surface in meters, always positive.
 */
export function altitudeForZoom(lat: number, zoom: number, viewportHeightPx: number): number {
  const metersPerPixel =
    (EQUATOR_METERS_PER_PIXEL *
      Math.cos(clamp(lat, -MAX_FLIGHT_LATITUDE, MAX_FLIGHT_LATITUDE) * DEG_TO_RAD)) /
    2 ** zoom;
  const height = (metersPerPixel * Math.max(1, viewportHeightPx)) / 2 / HALF_FOV_TANGENT;
  return Number.isFinite(height) && height > 0 ? height : 1000;
}

/**
 * Compass point for a heading (N, NNE, NE, …), for the HUD.
 *
 * @param heading - Compass heading in degrees.
 * @returns One of the 16 compass point abbreviations.
 */
export function compassPoint(heading: number): string {
  const points = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
  ];
  const index = Math.round(normalizeHeading(heading) / 22.5) % points.length;
  return points[index];
}
