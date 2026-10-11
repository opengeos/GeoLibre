import {
  bearingAlong,
  bearingDifference,
  haversine,
  pointAlong,
  projectOntoPolyline,
  type LngLat,
} from "./geometry";
import type { NavMode, NavRoute } from "./route";

/**
 * The turn-by-turn navigation engine: a pure function from (route, previous
 * state, GPS fix) to (next state, events). Speaking, rerouting and arriving
 * all follow from that one call, so the whole drive can be replayed in a unit
 * test from a list of fixes.
 *
 * The rules follow the ones Vela Maps documents for its drive loop
 * (docs/book/04-navigation.md in PimpinPumpkin/Vela): progress along the route
 * only moves forward and is matched inside a window around the progress so
 * far; the off-route corridor widens with the fix's reported accuracy; a fix
 * outside it, or heading against the route, counts a hit, and three hits make
 * the drive off route; a stationary fix holds the count, so waiting at a red
 * light never reroutes. The announcements themselves are Valhalla's, each
 * placed at its own distance before the maneuver.
 */

/** A position fix, from the device or a simulation. */
export interface NavFix {
  lng: number;
  lat: number;
  /** Reported horizontal accuracy in metres, when known. */
  accuracy?: number | null;
  /** Course over ground in degrees, when known. */
  heading?: number | null;
  /** Ground speed in m/s, when known. */
  speed?: number | null;
  timestamp: number;
}

/** Where the drive is on the route. */
export interface NavProgress {
  /** Distance travelled along the route, in metres. */
  along: number;
  /** The fix snapped onto the route. */
  snapped: LngLat;
  /** Distance from the fix to the route, in metres. */
  offset: number;
  /** The step being driven; its end is the next maneuver. */
  stepIndex: number;
  /** Metres to the next maneuver. */
  distanceToManeuver: number;
  /** Metres to the destination. */
  distanceRemaining: number;
  /** Seconds to the destination, from the router's step times. */
  durationRemaining: number;
  /** Metres to the next stop (the destination when there are none left). */
  distanceToNextStop: number;
  /** The route's direction of travel at {@link snapped}, in degrees. */
  routeBearing: number;
}

export interface NavState {
  progress: NavProgress | null;
  /** The step whose announcements {@link voiceCount} counts. */
  voiceStep: number;
  /** How many of {@link voiceStep}'s announcements have been spoken. */
  voiceCount: number;
  /** Consecutive evidence that the drive has left the route. */
  offRouteHits: number;
  /** Consecutive fixes back on the route while {@link offRoute}. */
  onRouteStreak: number;
  offRoute: boolean;
  /** Intermediate stops reached so far. */
  stopsPassed: number;
  arrived: boolean;
}

export type NavEvent =
  | { type: "speak"; text: string }
  | { type: "step"; stepIndex: number }
  | { type: "offRoute" }
  | { type: "backOnRoute" }
  | { type: "stop"; legIndex: number }
  | { type: "arrive" };

/** Per-mode thresholds; walking and cycling paths are narrower than roads. */
interface ModeTuning {
  /** corridor = base + perAccuracy × accuracy, clamped to [min, max]. */
  base: number;
  perAccuracy: number;
  min: number;
  max: number;
  /** Cap on the "far off" distance (twice the corridor). */
  farCap: number;
  /** Below this speed (m/s) a fix counts as stationary. */
  movingFloor: number;
}

const TUNING: Record<NavMode, ModeTuning> = {
  auto: { base: 18, perAccuracy: 2.0, min: 24, max: 70, farCap: 110, movingFloor: 2.0 },
  bicycle: { base: 12, perAccuracy: 1.9, min: 18, max: 55, farCap: 75, movingFloor: 1.0 },
  pedestrian: { base: 8, perAccuracy: 1.8, min: 15, max: 50, farCap: 60, movingFloor: 0.6 },
};

/** Accuracy assumed for a fix that reports none, in metres. */
const DEFAULT_ACCURACY_M = 12;
/** Hits before the drive counts as off route. */
export const OFF_ROUTE_HITS = 3;
/** A heading this far from the route's direction counts as a hit. */
export const HEADING_OFF_DEG = 60;
/** On-route fixes that end an off-route episode. */
export const BACK_ON_ROUTE_FIXES = 2;
/** How far behind the last progress a fix may still be matched, in metres. */
const WINDOW_BEHIND_M = 30;
/** Within this of the destination, the drive has arrived. */
export const ARRIVE_RADIUS_M = 20;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * The off-route corridor half-width for a fix.
 *
 * @param mode - The travel mode.
 * @param accuracy - The fix's reported accuracy in metres, when known.
 * @returns The corridor and the "far off" distance, in metres.
 */
export function offRouteCorridor(
  mode: NavMode,
  accuracy: number | null | undefined,
): { corridor: number; far: number } {
  const tuning = TUNING[mode];
  const acc = clamp(
    accuracy != null && Number.isFinite(accuracy) ? accuracy : DEFAULT_ACCURACY_M,
    3,
    40,
  );
  const corridor = clamp(tuning.base + tuning.perAccuracy * acc, tuning.min, tuning.max);
  return { corridor, far: Math.min(2 * corridor, tuning.farCap) };
}

/**
 * The state a drive starts in, or restarts in after a reroute.
 *
 * @returns A fresh state.
 */
export function initialNavState(): NavState {
  return {
    progress: null,
    voiceStep: -1,
    voiceCount: 0,
    offRouteHits: 0,
    onRouteStreak: 0,
    offRoute: false,
    stopsPassed: 0,
    arrived: false,
  };
}

/**
 * Index of the step that holds a distance along the route.
 *
 * @param route - The route.
 * @param along - Distance along it, in metres.
 * @param from - The step to start searching from (progress only moves forward).
 * @returns The step index.
 */
export function stepAt(route: NavRoute, along: number, from = 0): number {
  const steps = route.steps;
  let index = Math.max(0, Math.min(from, steps.length - 1));
  // A zero-length step (an intermediate "arrive", a "depart" at the same
  // point) is passed straight through.
  while (index < steps.length - 1 && along >= steps[index].endDistance) index += 1;
  return index;
}

/**
 * Seconds left from a point on the route, from the router's step times: the
 * unfinished part of the current step pro rata, plus every later step.
 *
 * @param route - The route.
 * @param stepIndex - The step being driven.
 * @param along - Distance along the route, in metres.
 * @returns The remaining travel time in seconds.
 */
export function remainingDuration(route: NavRoute, stepIndex: number, along: number): number {
  const step = route.steps[stepIndex];
  if (!step) return 0;
  const fraction = step.distance > 0 ? clamp((step.endDistance - along) / step.distance, 0, 1) : 0;
  let total = step.duration * fraction;
  for (let i = stepIndex + 1; i < route.steps.length; i += 1) total += route.steps[i].duration;
  return total;
}

/**
 * Advance the drive by one fix.
 *
 * @param route - The route being driven.
 * @param state - The state after the previous fix.
 * @param fix - The new fix.
 * @returns The next state and what happened (announcements to speak, a step
 *   change, going off route, a stop, the arrival).
 */
export function updateNavigation(
  route: NavRoute,
  state: NavState,
  fix: NavFix,
): { state: NavState; events: NavEvent[] } {
  const events: NavEvent[] = [];
  if (state.arrived || route.coordinates.length < 2) return { state, events };
  const point: LngLat = [fix.lng, fix.lat];
  const prev = state.progress;
  const speed = fix.speed != null && Number.isFinite(fix.speed) ? fix.speed : null;

  // Match inside a window around the progress so far, so a route that passes
  // over itself (a cloverleaf, an out-and-back) cannot jump to a later leg.
  let projection = null;
  if (prev) {
    const ahead = Math.max(400, (speed ?? 15) * 30 + 200);
    projection = projectOntoPolyline(route.coordinates, route.cumulative, point, [
      prev.along - WINDOW_BEHIND_M,
      prev.along + ahead,
    ]);
  }
  projection ??= projectOntoPolyline(route.coordinates, route.cumulative, point);
  if (!projection) return { state, events };

  const { corridor, far } = offRouteCorridor(route.mode, fix.accuracy);
  const tuning = TUNING[route.mode];
  // A fix without a speed figure is treated as moving: desktop browsers often
  // report none, and holding the count forever would never reroute.
  const moving = speed === null || speed >= tuning.movingFloor;
  const routeBearingHere = bearingAlong(route.coordinates, route.cumulative, projection.along);
  const headingKnown =
    speed !== null && moving && fix.heading != null && Number.isFinite(fix.heading);
  const wrongWay =
    headingKnown && bearingDifference(fix.heading as number, routeBearingHere) > HEADING_OFF_DEG;
  const inside = projection.offset <= corridor;

  // Off-route evidence.
  let hits = state.offRouteHits;
  if (inside && !wrongWay) hits = 0;
  else if (!moving && projection.offset <= far) {
    // Stationary: hold the count. A red light cannot cause a reroute.
  } else if (inside) {
    // Heading against the route inside the corridor: a wrong turn onto a road
    // that runs beside the planned one stays inside for blocks.
    hits += projection.offset > corridor / 4 ? 2 : 1;
  } else {
    hits += moving && projection.offset > far ? 2 : 1;
  }

  let offRoute = state.offRoute;
  let onRouteStreak = state.onRouteStreak;
  if (!offRoute && hits >= OFF_ROUTE_HITS) {
    offRoute = true;
    onRouteStreak = 0;
    events.push({ type: "offRoute" });
  } else if (offRoute) {
    onRouteStreak = hits === 0 ? onRouteStreak + 1 : 0;
    if (onRouteStreak >= BACK_ON_ROUTE_FIXES) {
      offRoute = false;
      onRouteStreak = 0;
      events.push({ type: "backOnRoute" });
    }
  }

  // Progress only moves forward, and only on fixes that are on the route.
  let along = prev ? prev.along : projection.along;
  if (inside && !wrongWay) along = Math.max(along, projection.along);
  if (!prev) along = projection.along;

  const stepIndex = stepAt(route, along, prev?.stepIndex ?? 0);
  if (prev && stepIndex !== prev.stepIndex) events.push({ type: "step", stepIndex });

  // Announcements: a step's are sorted farthest first, so the ones now due are
  // a prefix. When several fall due at once (a gap in the fixes, the first
  // fix), only the closest is spoken: the earlier ones are stale.
  let voiceStep = state.voiceStep;
  let voiceCount = state.voiceCount;
  if (voiceStep !== stepIndex) {
    voiceStep = stepIndex;
    voiceCount = 0;
  }
  const step = route.steps[stepIndex];
  const distanceToManeuver = Math.max(0, step.endDistance - along);
  if (!offRoute) {
    let due = voiceCount;
    while (due < step.voice.length && step.voice[due].distanceBefore >= distanceToManeuver) {
      due += 1;
    }
    if (due > voiceCount) {
      events.push({ type: "speak", text: step.voice[due - 1].text });
      voiceCount = due;
    }
  }

  // Intermediate stops.
  let stopsPassed = state.stopsPassed;
  while (
    stopsPassed < route.legEnds.length - 1 &&
    along >= route.legEnds[stopsPassed] - ARRIVE_RADIUS_M
  ) {
    events.push({ type: "stop", legIndex: stopsPassed });
    stopsPassed += 1;
  }

  const distanceRemaining = Math.max(0, route.distance - along);
  const destination = route.coordinates[route.coordinates.length - 1];
  const arrived =
    (distanceRemaining <= ARRIVE_RADIUS_M && inside) ||
    haversine(point, destination) <= ARRIVE_RADIUS_M;
  if (arrived) events.push({ type: "arrive" });

  const nextStopEnd = route.legEnds.find((end) => end > along + 1) ?? route.distance;
  const progress: NavProgress = {
    along,
    snapped: pointAlong(route.coordinates, route.cumulative, along),
    offset: projection.offset,
    stepIndex,
    distanceToManeuver,
    distanceRemaining,
    durationRemaining: remainingDuration(route, stepIndex, along),
    distanceToNextStop: Math.max(0, nextStopEnd - along),
    routeBearing: bearingAlong(route.coordinates, route.cumulative, along),
  };
  return {
    state: {
      progress,
      voiceStep,
      voiceCount,
      offRouteHits: offRoute ? 0 : hits,
      onRouteStreak,
      offRoute,
      stopsPassed,
      arrived,
    },
    events,
  };
}

/**
 * The fix a simulated drive is at, a distance along the route: on the line,
 * heading along it, at the step's average speed.
 *
 * @param route - The route being simulated.
 * @param along - Distance along it, in metres.
 * @param timestamp - The fix time in milliseconds.
 * @returns The simulated fix.
 */
export function simulatedFix(route: NavRoute, along: number, timestamp: number): NavFix {
  const [lng, lat] = pointAlong(route.coordinates, route.cumulative, along);
  return {
    lng,
    lat,
    accuracy: 5,
    heading: bearingAlong(route.coordinates, route.cumulative, along),
    speed: simulatedSpeed(route, along),
    timestamp,
  };
}

/** Fallback speeds (m/s) for a step without a usable router time. */
const DEFAULT_SPEED: Record<NavMode, number> = { auto: 13.9, bicycle: 4.5, pedestrian: 1.4 };

/**
 * The router's average speed on the step at a distance along the route.
 *
 * @param route - The route.
 * @param along - Distance along it, in metres.
 * @returns The speed in m/s.
 */
export function simulatedSpeed(route: NavRoute, along: number): number {
  const step = route.steps[stepAt(route, along)];
  const speed = step && step.duration > 0 ? step.distance / step.duration : 0;
  return speed > 0.3 && Number.isFinite(speed) ? speed : DEFAULT_SPEED[route.mode];
}

/**
 * The camera zoom for following the drive: closer in town, wider on a fast
 * road, so the next maneuver stays on screen.
 *
 * @param speed - Ground speed in m/s, when known.
 * @param mode - The travel mode.
 * @returns The zoom level.
 */
export function followZoom(speed: number | null | undefined, mode: NavMode): number {
  if (mode === "pedestrian") return 18;
  const v = speed ?? 0;
  if (v >= 25) return 15.5;
  if (v >= 15) return 16.25;
  return 17;
}
