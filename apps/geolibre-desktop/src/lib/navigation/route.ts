import { decodePolyline } from "@geolibre/core";
import type { Feature, FeatureCollection } from "geojson";
import { cumulativeDistances, type LngLat } from "./geometry";

/**
 * Turn-by-turn routes for the navigation tool.
 *
 * Routes come from Valhalla's `/route` endpoint asked for its OSRM-compatible
 * output with `voice_instructions` and `banner_instructions` — the format the
 * open-source navigation SDKs consume. Valhalla writes every announcement in
 * the requested language ("In 300 meters, turn right onto …") and places it at
 * a distance before the maneuver, and it carries lane arrows, exit numbers and
 * sign text. This module builds that request and flattens the response into a
 * {@link NavRoute}: one polyline for the whole trip, with every step placed on
 * it by distance along, so the engine never has to reason about legs.
 */

/** Valhalla costing models offered for navigation. */
export type NavMode = "auto" | "bicycle" | "pedestrian";

/** Road types a driving route can be asked to avoid. */
export interface NavAvoid {
  tolls: boolean;
  highways: boolean;
  ferries: boolean;
}

export const NO_AVOID: NavAvoid = { tolls: false, highways: false, ferries: false };

/** One lane of a lane-guidance diagram. */
export interface NavLane {
  /** The arrows painted on the lane, e.g. `["straight", "slight right"]`. */
  indications: string[];
  /** Whether the lane can be used for the upcoming maneuver. */
  active: boolean;
  /** The arrow to highlight when the lane is active. */
  activeIndication?: string;
}

/** A spoken announcement, placed by its distance before a maneuver. */
export interface NavVoiceInstruction {
  /** Metres before the end of the step (the maneuver) to speak it. */
  distanceBefore: number;
  text: string;
}

/** The banner shown while approaching a maneuver. */
export interface NavBanner {
  /** Metres before the end of the step from which to show it. */
  distanceBefore: number;
  text: string;
  secondary?: string;
  type?: string;
  modifier?: string;
  lanes: NavLane[] | null;
}

/**
 * A step: the maneuver at its start, then the road to the next maneuver.
 *
 * Following the OSRM/Mapbox convention, a step's {@link voice} and
 * {@link banners} are about the *next* step's maneuver, the one at this step's
 * end, which is what a driver on this stretch is approaching.
 */
export interface NavStep {
  legIndex: number;
  /** OSRM maneuver type: `depart`, `turn`, `fork`, `roundabout`, `arrive`, … */
  type: string;
  /** OSRM maneuver modifier: `left`, `slight right`, `uturn`, … */
  modifier?: string;
  /** The maneuver written out, in the route's language. */
  instruction: string;
  /** Road name of the step. */
  name: string;
  /** Road reference (route number), when the road has one. */
  ref?: string;
  /** Exit number(s) of a highway exit. */
  exits?: string;
  /** Sign text, e.g. "I 40 West: Nashville". */
  destinations?: string;
  /** Roundabout exit to take, when the step enters one. */
  roundaboutExit?: number;
  /** Where the maneuver happens. */
  location: LngLat;
  /** Length of the step in metres, measured on the route's own geometry. */
  distance: number;
  /** The router's travel time for the step, in seconds. */
  duration: number;
  /** Distance along the route at which the step starts (its maneuver). */
  startDistance: number;
  /** Distance along the route at which the step ends (the next maneuver). */
  endDistance: number;
  voice: NavVoiceInstruction[];
  banners: NavBanner[];
}

/** A route ready to be driven. */
export interface NavRoute {
  /** The trip's full geometry. */
  coordinates: LngLat[];
  /** Distance along {@link coordinates} at each vertex. */
  cumulative: number[];
  /** Total length in metres, measured on {@link coordinates}. */
  distance: number;
  /** The router's travel time, in seconds. */
  duration: number;
  steps: NavStep[];
  /** Distance along the route at which each leg (each stop) ends. */
  legEnds: number[];
  /** The language Valhalla actually wrote the instructions in. */
  voiceLocale: string;
  /** The main roads, e.g. "US 441, Cumberland Avenue". */
  summary: string;
  /** The road each requested location was matched to, in request order. */
  waypointNames: string[];
  mode: NavMode;
}

/** A location in a route request. */
export interface NavWaypoint {
  lng: number;
  lat: number;
}

/** What to ask Valhalla for. */
export interface NavRouteRequest {
  /** Origin, any stops, and the destination, in visiting order. */
  waypoints: NavWaypoint[];
  mode: NavMode;
  /** UI language tag; Valhalla falls back to English for one it lacks. */
  language: string;
  imperial: boolean;
  avoid?: NavAvoid;
  /** Direction of travel at the origin, for a reroute while moving. */
  heading?: number | null;
  /** Number of alternative routes to ask for (Valhalla ignores it with stops). */
  alternates?: number;
}

/** How far the start heading may differ from a road's direction, in degrees. */
const HEADING_TOLERANCE = 60;

/**
 * Build the Valhalla `/route` body for a navigation route.
 *
 * @param request - Waypoints, travel mode, language, units, and options.
 * @returns The JSON request body.
 */
export function buildNavRouteRequest(request: NavRouteRequest): Record<string, unknown> {
  const { waypoints, mode, language, imperial, avoid = NO_AVOID, heading, alternates } = request;
  const locations = waypoints.map((point, index) => {
    const location: Record<string, unknown> = { lon: point.lng, lat: point.lat };
    if (index === 0 && heading != null && Number.isFinite(heading)) {
      location.heading = Math.round(((heading % 360) + 360) % 360);
      location.heading_tolerance = HEADING_TOLERANCE;
    }
    return location;
  });
  const body: Record<string, unknown> = {
    locations,
    costing: mode,
    format: "osrm",
    voice_instructions: true,
    banner_instructions: true,
    language,
    units: imperial ? "miles" : "kilometers",
  };
  if (alternates && alternates > 0 && waypoints.length === 2) body.alternates = alternates;
  if (mode === "auto" && (avoid.tolls || avoid.highways || avoid.ferries)) {
    const auto: Record<string, number> = {};
    if (avoid.tolls) auto.use_tolls = 0;
    if (avoid.highways) auto.use_highways = 0;
    if (avoid.ferries) auto.use_ferry = 0;
    body.costing_options = { auto };
  }
  return body;
}

interface RawLaneComponent {
  type?: string;
  directions?: unknown;
  active?: unknown;
  active_direction?: unknown;
}

interface RawBanner {
  distanceAlongGeometry?: unknown;
  primary?: { text?: unknown; type?: unknown; modifier?: unknown };
  secondary?: { text?: unknown } | null;
  sub?: { components?: RawLaneComponent[] } | null;
}

interface RawStep {
  geometry?: unknown;
  distance?: unknown;
  duration?: unknown;
  name?: unknown;
  ref?: unknown;
  exits?: unknown;
  destinations?: unknown;
  maneuver?: {
    type?: unknown;
    modifier?: unknown;
    instruction?: unknown;
    location?: unknown;
    exit?: unknown;
  };
  voiceInstructions?: { distanceAlongGeometry?: unknown; announcement?: unknown }[];
  bannerInstructions?: RawBanner[];
}

interface RawRoute {
  duration?: unknown;
  voiceLocale?: unknown;
  legs?: { summary?: unknown; steps?: RawStep[] }[];
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function parseLanes(components: RawLaneComponent[] | undefined): NavLane[] | null {
  if (!Array.isArray(components)) return null;
  const lanes = components
    .filter((c) => c?.type === "lane")
    .map((c) => ({
      indications: Array.isArray(c.directions)
        ? c.directions.filter((d): d is string => typeof d === "string")
        : [],
      active: c.active === true,
      activeIndication: str(c.active_direction),
    }));
  return lanes.length > 0 ? lanes : null;
}

function parseBanner(raw: RawBanner): NavBanner | null {
  const text = str(raw?.primary?.text);
  const distanceBefore = num(raw?.distanceAlongGeometry);
  if (!text || distanceBefore === undefined) return null;
  return {
    distanceBefore,
    text,
    secondary: str(raw.secondary?.text),
    type: str(raw.primary?.type),
    modifier: str(raw.primary?.modifier),
    lanes: parseLanes(raw.sub?.components),
  };
}

/**
 * Turn one route of a Valhalla OSRM-format response into a {@link NavRoute}.
 *
 * The trip's geometry is rebuilt from the steps' own geometries, so every
 * step's start and end are positions on the very line the engine projects
 * fixes onto, measured the same way.
 *
 * @param raw - One element of the response's `routes` array.
 * @param mode - The travel mode the route was asked for.
 * @param waypointNames - The matched road names of the request's locations.
 * @returns The route, or null when it has no usable geometry.
 */
export function parseNavRoute(
  raw: unknown,
  mode: NavMode,
  waypointNames: string[] = [],
): NavRoute | null {
  const route = raw as RawRoute | null;
  if (!route || !Array.isArray(route.legs)) return null;
  const coordinates: LngLat[] = [];
  const stepRanges: { raw: RawStep; legIndex: number; start: number; end: number }[] = [];
  const legEndVertex: number[] = [];
  route.legs.forEach((leg, legIndex) => {
    for (const step of leg?.steps ?? []) {
      const geometry = typeof step?.geometry === "string" ? decodePolyline(step.geometry, 6) : [];
      const start = Math.max(0, coordinates.length - 1);
      for (const point of geometry) {
        const last = coordinates[coordinates.length - 1];
        if (last && last[0] === point[0] && last[1] === point[1]) continue;
        coordinates.push([point[0], point[1]]);
      }
      stepRanges.push({ raw: step, legIndex, start, end: Math.max(0, coordinates.length - 1) });
    }
    legEndVertex.push(Math.max(0, coordinates.length - 1));
  });
  if (coordinates.length < 2) return null;
  const cumulative = cumulativeDistances(coordinates);

  const steps: NavStep[] = stepRanges.map(({ raw: step, legIndex, start, end }) => {
    const maneuver = step.maneuver ?? {};
    const location = Array.isArray(maneuver.location)
      ? ([Number(maneuver.location[0]), Number(maneuver.location[1])] as LngLat)
      : coordinates[start];
    const voice = (step.voiceInstructions ?? [])
      .map((v) => ({ distanceBefore: num(v?.distanceAlongGeometry), text: str(v?.announcement) }))
      .filter((v): v is NavVoiceInstruction => v.distanceBefore !== undefined && !!v.text)
      .sort((a, b) => b.distanceBefore - a.distanceBefore);
    const banners = (step.bannerInstructions ?? [])
      .map(parseBanner)
      .filter((b): b is NavBanner => b !== null)
      .sort((a, b) => b.distanceBefore - a.distanceBefore);
    const startDistance = cumulative[start];
    const endDistance = cumulative[end];
    return {
      legIndex,
      type: str(maneuver.type) ?? "continue",
      modifier: str(maneuver.modifier),
      instruction: str(maneuver.instruction) ?? "",
      name: str(step.name) ?? "",
      ref: str(step.ref),
      exits: str(step.exits),
      destinations: str(step.destinations),
      roundaboutExit: num(maneuver.exit),
      location,
      distance: endDistance - startDistance,
      duration: num(step.duration) ?? 0,
      startDistance,
      endDistance,
      voice,
      banners,
    };
  });

  const summary = route.legs
    .map((leg) => str(leg?.summary))
    .filter((s): s is string => !!s)
    .join(" · ");
  return {
    coordinates,
    cumulative,
    distance: cumulative[cumulative.length - 1],
    duration: num(route.duration) ?? steps.reduce((sum, s) => sum + s.duration, 0),
    steps,
    legEnds: legEndVertex.map((vertex) => cumulative[vertex]),
    voiceLocale: str(route.voiceLocale) ?? "en-US",
    summary,
    waypointNames,
    mode,
  };
}

/**
 * Turn a whole Valhalla OSRM-format response into routes, best first.
 *
 * @param response - The `/route` response.
 * @param mode - The travel mode the routes were asked for.
 * @returns The usable routes; empty when the router found none.
 */
export function parseNavRoutes(response: unknown, mode: NavMode): NavRoute[] {
  const body = response as { routes?: unknown[]; waypoints?: { name?: unknown }[] } | null;
  if (!body || !Array.isArray(body.routes)) return [];
  const names = Array.isArray(body.waypoints)
    ? body.waypoints.map((w) => (typeof w?.name === "string" ? w.name : ""))
    : [];
  return body.routes
    .map((route) => parseNavRoute(route, mode, names))
    .filter((route): route is NavRoute => route !== null);
}

/**
 * Valhalla's error text, when a failed request carried one in its body.
 *
 * @param body - A parsed error response.
 * @returns The router's message, or undefined.
 */
export function routerErrorMessage(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" ? error : undefined;
}

/**
 * A route as a GeoJSON layer: the line, and a point per maneuver carrying its
 * instruction, for "Save as layer".
 *
 * @param route - The route to save.
 * @returns The feature collection.
 */
export function navRouteToFeatureCollection(route: NavRoute): FeatureCollection {
  const features: Feature[] = [
    {
      type: "Feature",
      geometry: { type: "LineString", coordinates: route.coordinates },
      properties: {
        kind: "route",
        mode: route.mode,
        distance_m: Math.round(route.distance),
        duration_s: Math.round(route.duration),
        summary: route.summary,
        stroke: "#2563eb",
        "stroke-width": 5,
      },
    },
  ];
  route.steps.forEach((step, index) => {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: step.location },
      properties: {
        kind: "maneuver",
        step: index + 1,
        type: step.type,
        modifier: step.modifier ?? null,
        instruction: step.instruction,
        road: step.name || step.ref || null,
        distance_m: Math.round(step.distance),
        duration_s: Math.round(step.duration),
        "marker-color": "#1d4ed8",
        "marker-size": "small",
      },
    });
  });
  return { type: "FeatureCollection", features };
}
