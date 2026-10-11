import type { NavFix } from "./engine";
import type { LngLat } from "./geometry";
import {
  NO_AVOID,
  type NavAvoid,
  type NavBanner,
  type NavMode,
  type NavRoute,
  type NavStep,
} from "./route";

/**
 * Plain state and helpers shared by the navigation panel's planning and
 * driving halves: the persisted settings, the conversion of a browser fix, the
 * banner to show, and the camera framing. Kept free of React and MapLibre so
 * they can be unit tested.
 */

/** A placed waypoint; `mine` marks the device's location. */
export interface NavPoint {
  lng: number;
  lat: number;
  mine?: boolean;
  /** The address or place name it was found by, when typed. */
  label?: string;
}

/** Planning, driving, or the arrival card. */
export type NavPhase = "plan" | "navigate" | "arrived";

/** The state of the route request while planning. */
export type NavRouteStatus = "idle" | "loading" | "noRoute" | "error";

/** The tool's per-device preferences. */
export interface NavSettings {
  mode: NavMode;
  avoid: NavAvoid;
  voice: boolean;
  simSpeed: number;
}

export const NAV_MODES: NavMode[] = ["auto", "bicycle", "pedestrian"];
export const SIM_SPEEDS = [1, 2, 4, 8];
export const NAV_SETTINGS_KEY = "geolibre.navigation.settings";
export const DEFAULT_NAV_SETTINGS: NavSettings = {
  mode: "auto",
  avoid: NO_AVOID,
  voice: true,
  simSpeed: 2,
};

/** Simulation tick, in milliseconds. */
export const SIM_TICK_MS = 500;
/** A reroute is abandoned after this long, in milliseconds. */
export const REROUTE_TIMEOUT_MS = 20_000;
/** Minimum gap after an adopted reroute, so a parallel road cannot cause a storm. */
export const REROUTE_COOLDOWN_MS = 10_000;
/** "Rerouting" is spoken at most this often. */
export const REROUTE_SPEAK_MIN_MS = 30_000;
/** No fix for this long shows "Searching for GPS". */
export const GPS_LOST_MS = 12_000;
/** A following maneuver this close is shown under the banner as "Then …". */
export const THEN_DISTANCE_M = 200;
/** Height of the folded card plus a margin, kept clear below a route on a phone. */
export const NARROW_BOTTOM_CLEARANCE = 200;
/** Panel width plus a margin, in pixels, kept clear when fitting a route. */
export const PLAN_PANEL_CLEARANCE = 400;

/** The subset of `Storage` the settings use, so tests can pass a stub. */
type SettingsStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): SettingsStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Read the saved settings, keeping only values that are still valid.
 *
 * @param storage - Where to read from (default `localStorage`).
 * @returns The settings, or the defaults when none are saved or readable.
 */
export function loadNavSettings(storage = defaultStorage()): NavSettings {
  try {
    const raw = JSON.parse(storage?.getItem(NAV_SETTINGS_KEY) ?? "null") as Partial<NavSettings>;
    if (!raw || typeof raw !== "object") return DEFAULT_NAV_SETTINGS;
    const avoid: Partial<NavAvoid> = raw.avoid && typeof raw.avoid === "object" ? raw.avoid : {};
    return {
      mode: NAV_MODES.includes(raw.mode as NavMode)
        ? (raw.mode as NavMode)
        : DEFAULT_NAV_SETTINGS.mode,
      avoid: {
        tolls: avoid.tolls === true,
        highways: avoid.highways === true,
        ferries: avoid.ferries === true,
      },
      voice: raw.voice !== false,
      simSpeed: SIM_SPEEDS.includes(raw.simSpeed as number)
        ? (raw.simSpeed as number)
        : DEFAULT_NAV_SETTINGS.simSpeed,
    };
  } catch {
    return DEFAULT_NAV_SETTINGS;
  }
}

/**
 * Save the settings; a storage that throws (private mode) just keeps them for
 * the session.
 *
 * @param settings - The settings to save.
 * @param storage - Where to write (default `localStorage`).
 */
export function saveNavSettings(settings: NavSettings, storage = defaultStorage()): void {
  try {
    storage?.setItem(NAV_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Settings simply do not persist.
  }
}

/**
 * A browser (or native plugin) position as an engine fix. A `NaN` or missing
 * heading or speed, which browsers report for a stationary device, becomes null.
 *
 * @param position - The geolocation position.
 * @returns The fix.
 */
export function fixFromPosition(position: GeolocationPosition): NavFix {
  const { coords } = position;
  const finite = (value: number | null | undefined) =>
    value != null && Number.isFinite(value) ? value : null;
  return {
    lng: coords.longitude,
    lat: coords.latitude,
    accuracy: finite(coords.accuracy),
    heading: finite(coords.heading),
    speed: finite(coords.speed),
    timestamp: position.timestamp,
  };
}

/**
 * The bounding box of a set of coordinates, in the `[[w, s], [e, n]]` form
 * `fitBounds` takes.
 *
 * @param coordinates - The points.
 * @returns The box, or null for no points.
 */
export function boundsOf(coordinates: LngLat[]): [LngLat, LngLat] | null {
  if (coordinates.length === 0) return null;
  let [west, south] = coordinates[0];
  let [east, north] = coordinates[0];
  for (const [lng, lat] of coordinates) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [
    [west, south],
    [east, north],
  ];
}

/**
 * Fit padding that keeps a route clear of the planning panel: at the map's
 * inline start on a wide map, along the bottom on a phone-sized one. A map in
 * between gets plain padding.
 *
 * @param width - The map container's width in pixels.
 * @param rtl - Whether the layout runs right to left.
 * @returns The padding for `fitBounds`.
 */
export function planPadding(
  width: number,
  rtl: boolean,
): { top: number; bottom: number; left: number; right: number } {
  const base = { top: 60, bottom: 60, left: 60, right: 60 };
  // On a phone the card is a bar along the bottom, under the route.
  if (width < NARROW_MAP_WIDTH)
    return { top: 60, bottom: NARROW_BOTTOM_CLEARANCE, left: 40, right: 60 };
  if (width < PLAN_PANEL_CLEARANCE * 2) return base;
  return rtl ? { ...base, right: PLAN_PANEL_CLEARANCE } : { ...base, left: PLAN_PANEL_CLEARANCE };
}

/**
 * The banner for the stretch being driven: the closest one now due, or the
 * step's first while none is due yet.
 *
 * @param step - The step being driven.
 * @param distanceToManeuver - Metres to the maneuver at the step's end.
 * @returns The banner, or null when the step has none.
 */
export function activeBanner(
  step: NavStep | undefined,
  distanceToManeuver: number,
): NavBanner | null {
  if (!step || step.banners.length === 0) return null;
  let banner = step.banners[0];
  for (const candidate of step.banners) {
    if (candidate.distanceBefore >= distanceToManeuver) banner = candidate;
  }
  return banner;
}

/** Map width, in pixels, below which the tool uses its compact phone layout. */
export const NARROW_MAP_WIDTH = 640;

/** A stop still ahead of the drive. */
export interface UpcomingStop {
  /** The leg that ends at the stop; the last one ends at the destination. */
  legIndex: number;
  /** Whether this is the trip's destination rather than an intermediate stop. */
  destination: boolean;
  /** The road the stop was matched to, when the router named one. */
  name: string;
  /** Metres to the stop along the route. */
  distance: number;
  /** Seconds to the stop, from the router's step times. */
  duration: number;
}

/**
 * The stops still ahead of a drive, each with the distance and travel time to
 * it, for the list a driver opens without ending the drive.
 *
 * @param route - The route being driven.
 * @param along - Distance travelled along it, in metres.
 * @returns The stops not yet reached, in order; the destination is last.
 */
export function upcomingStops(route: NavRoute, along: number): UpcomingStop[] {
  const stops: UpcomingStop[] = [];
  route.legEnds.forEach((end, legIndex) => {
    if (end <= along + 1 && legIndex < route.legEnds.length - 1) return;
    let duration = 0;
    for (const step of route.steps) {
      if (step.legIndex > legIndex || step.endDistance <= along) continue;
      const fraction =
        step.distance > 0
          ? Math.min(1, (step.endDistance - Math.max(along, step.startDistance)) / step.distance)
          : 0;
      duration += step.duration * fraction;
    }
    stops.push({
      legIndex,
      destination: legIndex === route.legEnds.length - 1,
      // waypointNames[0] is the origin, so leg i ends at waypoint i + 1.
      name: route.waypointNames[legIndex + 1] ?? "",
      distance: Math.max(0, end - along),
      duration,
    });
  });
  return stops;
}

/**
 * Read typed coordinates, "lat, lng" (the order map apps print them in) with a
 * comma or space between, so a pasted position needs no geocoder.
 *
 * @param text - What was typed.
 * @returns The point, or null when the text is not a valid coordinate pair.
 */
export function parseTypedCoordinates(text: string): NavPoint | null {
  const match = /^\s*([-+]?\d+(?:\.\d+)?)\s*[,\s]\s*([-+]?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lng, lat };
}
