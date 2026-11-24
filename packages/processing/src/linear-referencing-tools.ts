// Linear referencing: routes with M (measure) values, locating features along
// routes, and dynamic segmentation of event tables (#3530).
//
// How M survives GeoJSON
// ----------------------
// RFC 7946 has no measure ordinate, so GeoLibre stores M as the FOURTH
// ordinate of each position: `[lng, lat, z, m]`. A route built from a 2D line
// gets `z = 0` as a placeholder so the measure always sits at index 3 and is
// never mistaken for an elevation (a 3-element `[lng, lat, m]` would be read
// as Z by MapLibre, deck.gl, DuckDB and every export path). The position
// array passes through the project file, the store and GeoJSON export
// unchanged; tools that rebuild geometry (Turf, DuckDB, the editor) drop it,
// so run Create routes again after editing a route's shape. Each route also
// carries its measure range as plain `m_from` / `m_to` properties so the
// attribute table shows it.
import type {
  Feature,
  FeatureCollection,
  Geometry,
  LineString,
  MultiLineString,
  Position,
} from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";
import type { ProcessingAlgorithm, ProcessingContext } from "./types";

const EARTH_RADIUS_M = 6371008.8;

/** Length units a measure can be expressed in, as metres per unit. */
export const MEASURE_UNITS = {
  meters: 1,
  kilometers: 1000,
  feet: 0.3048,
  miles: 1609.344,
} as const;

export type MeasureUnit = keyof typeof MEASURE_UNITS;

/** Great-circle distance between two positions in metres (haversine). */
export function haversineMeters(a: Position, b: Position): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLng = (b[0] - a[0]) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The M value of a position, or undefined when it carries none.
 *
 * @param position - A GeoJSON position, `[lng, lat, z, m]` when measured.
 * @returns The measure, or undefined.
 */
export function getMeasure(position: Position): number | undefined {
  const m = position[3];
  return typeof m === "number" && Number.isFinite(m) ? m : undefined;
}

/**
 * Copy a position with M set as its fourth ordinate (Z defaults to 0).
 *
 * @param position - The source position.
 * @param m - The measure to store.
 * @returns `[lng, lat, z, m]`.
 */
export function withMeasure(position: Position, m: number): Position {
  const z = typeof position[2] === "number" && Number.isFinite(position[2]) ? position[2] : 0;
  return [position[0], position[1], z, m];
}

function lineParts(geometry: Geometry | null): Position[][] | null {
  if (geometry?.type === "LineString") return [geometry.coordinates];
  if (geometry?.type === "MultiLineString") return geometry.coordinates;
  return null;
}

function partsToGeometry(parts: Position[][]): LineString | MultiLineString {
  return parts.length === 1
    ? { type: "LineString", coordinates: parts[0] }
    : { type: "MultiLineString", coordinates: parts };
}

/** Total geodesic length of line parts, in metres. */
function partsLength(parts: Position[][]): number {
  let total = 0;
  for (const part of parts) {
    for (let i = 0; i + 1 < part.length; i++) total += haversineMeters(part[i], part[i + 1]);
  }
  return total;
}

/**
 * Add M values to a line: cumulative geodesic length (in `unit`), optionally
 * rescaled so the line runs from `fromMeasure` to `toMeasure`. Parts of a
 * MultiLineString continue the measure of the part before them (the gap
 * between parts adds nothing). Z values are kept.
 *
 * @param geometry - A LineString or MultiLineString.
 * @param options - Unit, and optional start/end measures.
 * @returns The measured geometry, or null for non-line or empty input.
 */
export function measureLine(
  geometry: Geometry | null,
  options: { unit?: MeasureUnit; fromMeasure?: number; toMeasure?: number } = {},
): LineString | MultiLineString | null {
  const parts = lineParts(geometry)?.filter((part) => part.length >= 2);
  if (!parts?.length) return null;
  const metresPerUnit = MEASURE_UNITS[options.unit ?? "meters"];
  const total = partsLength(parts);
  const scaled =
    options.fromMeasure !== undefined &&
    options.toMeasure !== undefined &&
    Number.isFinite(options.fromMeasure) &&
    Number.isFinite(options.toMeasure);
  let walked = 0;
  const measured = parts.map((part) =>
    part.map((position, i) => {
      if (i > 0) walked += haversineMeters(part[i - 1], position);
      const m = scaled
        ? options.fromMeasure! +
          (total === 0 ? 0 : walked / total) * (options.toMeasure! - options.fromMeasure!)
        : walked / metresPerUnit;
      return withMeasure(position, m);
    }),
  );
  return partsToGeometry(measured);
}

/**
 * The line's parts with M on every vertex: the stored M where all vertices
 * carry one, otherwise measured by length in metres.
 */
function measuredParts(geometry: Geometry | null): Position[][] | null {
  const parts = lineParts(geometry)?.filter((part) => part.length >= 2);
  if (!parts?.length) return null;
  if (parts.every((part) => part.every((p) => getMeasure(p) !== undefined))) return parts;
  return lineParts(measureLine(geometry));
}

export interface RouteLocation {
  /** Measure at the closest point on the route. */
  measure: number;
  /** Distance from the input point to the route, in metres. */
  distance: number;
  /** The closest point on the route, `[lng, lat, z, m]`. */
  point: Position;
}

/**
 * Find the point on a measured route closest to `point` and interpolate its
 * measure. Segments are projected in a local equirectangular frame (accurate
 * for the short segments routes are made of); the reported distance is
 * geodesic.
 *
 * @param route - A LineString or MultiLineString, measured or not.
 * @param point - The `[lng, lat]` to locate.
 * @returns The closest location, or null when the route has no segments.
 */
export function locatePointOnRoute(route: Geometry | null, point: Position): RouteLocation | null {
  return locatePointInParts(measuredParts(route), point);
}

/** Locate a position without rescanning or remeasuring a cached route. */
function locatePointInParts(parts: Position[][] | null, point: Position): RouteLocation | null {
  if (!parts) return null;
  const kx = Math.cos((point[1] * Math.PI) / 180);
  let best: RouteLocation | null = null;
  for (const part of parts) {
    for (let i = 0; i + 1 < part.length; i++) {
      const a = part[i];
      const b = part[i + 1];
      const ax = (((a[0] - point[0] + 540) % 360) - 180) * kx;
      const ay = a[1] - point[1];
      const longitudeSpan = ((b[0] - a[0] + 540) % 360) - 180;
      const dx = longitudeSpan * kx;
      const dy = b[1] - a[1];
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
      const lng = a[0] + t * longitudeSpan;
      const lat = a[1] + t * (b[1] - a[1]);
      const distance = haversineMeters(point, [lng, lat]);
      if (best && distance >= best.distance) continue;
      const ma = getMeasure(a)!;
      const mb = getMeasure(b)!;
      const za = a[2] ?? 0;
      const zb = b[2] ?? 0;
      const measure = ma + t * (mb - ma);
      best = { measure, distance, point: [lng, lat, za + t * (zb - za), measure] };
    }
  }
  return best;
}

/**
 * Extract the stretch of a measured route between two measures (dynamic
 * segmentation of a line event). The measures are clamped to the range each
 * segment covers, and interpolated vertices get interpolated Z and M. Works
 * whether M increases or decreases along the line.
 *
 * @param route - A measured LineString or MultiLineString.
 * @param fromMeasure - One end of the event.
 * @param toMeasure - The other end.
 * @returns The sub-line (MultiLineString when it spans several parts), or
 *   null when the route does not cover any of the range.
 */
export function sliceRouteByMeasure(
  route: Geometry | null,
  fromMeasure: number,
  toMeasure: number,
): LineString | MultiLineString | null {
  const parts = measuredParts(route);
  if (!parts) return null;
  const lo = Math.min(fromMeasure, toMeasure);
  const hi = Math.max(fromMeasure, toMeasure);
  const out: Position[][] = [];
  for (const part of parts) {
    let current: Position[] = [];
    const push = (p: Position) => {
      const last = current[current.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1] || last[3] !== p[3]) current.push(p);
    };
    const flush = () => {
      if (current.length >= 2) out.push(current);
      current = [];
    };
    for (let i = 0; i + 1 < part.length; i++) {
      const a = part[i];
      const b = part[i + 1];
      const ma = getMeasure(a)!;
      const mb = getMeasure(b)!;
      const segLo = Math.min(ma, mb);
      const segHi = Math.max(ma, mb);
      if (segHi < lo || segLo > hi) {
        flush();
        continue;
      }
      const at = (m: number): Position => {
        const t = mb === ma ? 0 : (m - ma) / (mb - ma);
        const za = a[2] ?? 0;
        const zb = b[2] ?? 0;
        return [
          a[0] + t * (((b[0] - a[0] + 540) % 360) - 180),
          a[1] + t * (b[1] - a[1]),
          za + t * (zb - za),
          m,
        ];
      };
      const start = ma >= lo && ma <= hi ? a : at(ma < lo ? lo : hi);
      const end = mb >= lo && mb <= hi ? b : at(mb < lo ? lo : hi);
      // Entering the range mid-segment starts a new run; leaving it mid-segment
      // ends the current one.
      if (start !== a) flush();
      push(start);
      push(end);
      if (end !== b) flush();
    }
    flush();
  }
  if (out.length === 0) return null;
  return partsToGeometry(out);
}

/**
 * The point on a measured route at a single measure (a point event).
 *
 * @param route - A measured LineString or MultiLineString.
 * @param measure - The measure to locate.
 * @returns `[lng, lat, z, m]`, or null when no segment covers the measure.
 */
export function pointAtMeasure(route: Geometry | null, measure: number): Position | null {
  const parts = measuredParts(route);
  if (!parts) return null;
  for (const part of parts) {
    for (let i = 0; i + 1 < part.length; i++) {
      const a = part[i];
      const b = part[i + 1];
      const ma = getMeasure(a)!;
      const mb = getMeasure(b)!;
      if (measure < Math.min(ma, mb) || measure > Math.max(ma, mb)) continue;
      const t = mb === ma ? 0 : (measure - ma) / (mb - ma);
      const za = a[2] ?? 0;
      const zb = b[2] ?? 0;
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), za + t * (zb - za), measure];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function getLayer(ctx: ProcessingContext, paramId: string): GeoLibreLayer | undefined {
  const id = ctx.parameters[paramId] as string | undefined;
  return ctx.layers.find((l) => l.id === id);
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function routeIdOf(feature: Feature, field: string | undefined, index: number): string {
  if (!field) return String(feature.id ?? index);
  const value = feature.properties?.[field];
  return value === null || value === undefined ? "" : String(value);
}

const UNIT_OPTIONS = [
  { value: "meters", label: "Meters" },
  { value: "kilometers", label: "Kilometers" },
  { value: "feet", label: "Feet" },
  { value: "miles", label: "Miles" },
];

export const createRoutesTool: ProcessingAlgorithm = {
  id: "create-routes",
  name: "Create routes",
  description:
    "Add M (measure) values to lines, from their length or from start/end measure fields, so they can be used as routes for linear referencing",
  group: "Linear referencing",
  parameters: [
    { id: "layer", label: "Line layer", type: "layer", required: true, geometryFilter: ["line"] },
    {
      id: "routeIdField",
      label: "Route ID field",
      type: "field",
      description: "Copied to route_id. Leave empty to use the feature id or index.",
    },
    {
      id: "measureSource",
      label: "Measures from",
      type: "select",
      default: "length",
      options: [
        { value: "length", label: "Line length" },
        { value: "fields", label: "Start and end fields" },
      ],
    },
    {
      id: "unit",
      label: "Measure unit",
      type: "select",
      default: "meters",
      options: UNIT_OPTIONS,
      visibleWhen: { param: "measureSource", in: ["length"] },
    },
    {
      id: "fromField",
      label: "Start measure field",
      type: "field",
      visibleWhen: { param: "measureSource", in: ["fields"] },
    },
    {
      id: "toField",
      label: "End measure field",
      type: "field",
      visibleWhen: { param: "measureSource", in: ["fields"] },
    },
  ],
  run: async (ctx) => {
    const layer = getLayer(ctx, "layer");
    const fc = layer?.geojson;
    if (!fc?.features?.length) {
      ctx.log("Error: select a line layer with features");
      return;
    }
    const fromFields = ctx.parameters.measureSource === "fields";
    const fromField = ctx.parameters.fromField as string | undefined;
    const toField = ctx.parameters.toField as string | undefined;
    if (fromFields && (!fromField || !toField)) {
      ctx.log("Error: choose the start and end measure fields");
      return;
    }
    const unit = (ctx.parameters.unit as MeasureUnit) ?? "meters";
    const routeIdField = (ctx.parameters.routeIdField as string | undefined) || undefined;
    const features: Feature[] = [];
    let skipped = 0;
    fc.features.forEach((feature, index) => {
      let fromMeasure: number | undefined;
      let toMeasure: number | undefined;
      if (fromFields) {
        fromMeasure = numberOrUndefined(feature.properties?.[fromField!]);
        toMeasure = numberOrUndefined(feature.properties?.[toField!]);
        if (fromMeasure === undefined || toMeasure === undefined) {
          skipped += 1;
          return;
        }
      }
      const geometry = measureLine(feature.geometry, {
        unit: unit in MEASURE_UNITS ? unit : "meters",
        fromMeasure,
        toMeasure,
      });
      if (!geometry) {
        skipped += 1;
        return;
      }
      const parts = lineParts(geometry)!;
      const first = getMeasure(parts[0][0])!;
      const lastPart = parts[parts.length - 1];
      const last = getMeasure(lastPart[lastPart.length - 1])!;
      features.push({
        ...feature,
        geometry,
        properties: {
          ...(feature.properties ?? {}),
          route_id: routeIdOf(feature, routeIdField, index),
          m_from: first,
          m_to: last,
        },
      });
    });
    if (skipped) {
      ctx.log(
        `Skipped ${skipped} feature(s) that are not lines` +
          (fromFields ? " or have no numeric start/end measure" : ""),
      );
    }
    if (features.length === 0) {
      ctx.log("Error: no routes could be created");
      return;
    }
    ctx.log(`Created ${features.length} route(s) with M values`);
    ctx.addResultLayer?.(`${layer!.name} routes`, { type: "FeatureCollection", features });
  },
};

interface IndexedRoute {
  id: string;
  geometry: Geometry;
  parts: Position[][];
  bounds: [number, number, number, number];
}

function collectRoutes(
  fc: FeatureCollection,
  routeIdField: string | undefined,
  log: (message: string) => void,
): Map<string, IndexedRoute[]> {
  const routes = new Map<string, IndexedRoute[]>();
  let fallback = 0;
  let missingId = 0;
  fc.features.forEach((feature, index) => {
    if (!lineParts(feature.geometry)) return;
    const id = routeIdOf(feature, routeIdField, index);
    if (!id) {
      missingId++;
      return;
    }
    const source = lineParts(feature.geometry);
    const parts = measuredParts(feature.geometry);
    if (!source || !parts) return;
    if (source.some((part) => part.some((point) => getMeasure(point) === undefined))) fallback++;
    const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const part of parts)
      for (const point of part) {
        bounds[0] = Math.min(bounds[0], point[0]);
        bounds[1] = Math.min(bounds[1], point[1]);
        bounds[2] = Math.max(bounds[2], point[0]);
        bounds[3] = Math.max(bounds[3], point[1]);
      }
    const list = routes.get(id) ?? [];
    list.push({ id, geometry: { type: "MultiLineString", coordinates: parts }, parts, bounds });
    routes.set(id, list);
  });
  if (missingId) log(`Skipped ${missingId} route(s) with an empty route ID`);
  if (fallback)
    log(`${fallback} route(s) have incomplete M values and were measured by length in metres`);
  const repeated = [...routes.values()].filter((parts) => parts.length > 1).length;
  if (repeated)
    log(
      `${repeated} route ID(s) occur on multiple features; event measures use the first feature whose measure range covers the event`,
    );
  return routes;
}

export const locateFeaturesAlongRoutesTool: ProcessingAlgorithm = {
  id: "locate-features-along-routes",
  name: "Locate features along routes",
  description:
    "Find the route and measure for each point: the nearest route within a search radius, or every route within it",
  group: "Linear referencing",
  parameters: [
    {
      id: "layer",
      label: "Point layer",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "routes",
      label: "Route layer",
      type: "layer",
      required: true,
      geometryFilter: ["line"],
    },
    {
      id: "routeIdField",
      label: "Route ID field",
      type: "field",
      fieldSource: "routes",
      description: "Leave empty to use the route feature id or index.",
    },
    {
      id: "radius",
      label: "Search radius (m)",
      type: "number",
      default: 50,
      min: 0,
      step: 1,
    },
    {
      id: "allRoutes",
      label: "Report every route within the radius",
      type: "boolean",
      default: false,
      description: "Otherwise only the nearest route is reported.",
    },
  ],
  run: async (ctx) => {
    const points = getLayer(ctx, "layer")?.geojson;
    const routesLayer = getLayer(ctx, "routes");
    if (!points?.features?.length || !routesLayer?.geojson?.features?.length) {
      ctx.log("Error: select a point layer and a route layer with features");
      return;
    }
    const routeIdField = (ctx.parameters.routeIdField as string | undefined) || undefined;
    const radius = Math.max(0, Number(ctx.parameters.radius ?? 50) || 0);
    const allRoutes = Boolean(ctx.parameters.allRoutes);
    const routes = [...collectRoutes(routesLayer.geojson, routeIdField, ctx.log).values()].flat();
    const features: Feature[] = [];
    let unmatched = 0;
    for (const feature of points.features) {
      const positions =
        feature.geometry?.type === "Point"
          ? [feature.geometry.coordinates]
          : feature.geometry?.type === "MultiPoint"
            ? feature.geometry.coordinates
            : [];
      if (positions.length === 0) {
        unmatched += 1;
        continue;
      }
      const hits: { route: string; location: RouteLocation; position: Position }[] = [];
      for (const position of positions) {
        for (const route of routes) {
          const pad = radius / ((EARTH_RADIUS_M * Math.PI) / 180);
          const [west, south, east, north] = route.bounds;
          if (position[1] < south - pad || position[1] > north + pad) continue;
          const lat = Math.max(Math.abs(position[1]), Math.abs(south), Math.abs(north));
          const padX = pad / Math.max(1e-6, Math.cos((Math.min(90, lat) * Math.PI) / 180));
          const nearLongitude =
            position[0] + 360 * Math.round(((west + east) / 2 - position[0]) / 360);
          if (east - west < 180 && (nearLongitude < west - padX || nearLongitude > east + padX))
            continue;
          const location = locatePointInParts(route.parts, position);
          if (location && location.distance <= radius)
            hits.push({ route: route.id, location, position });
        }
      }
      if (hits.length === 0) {
        unmatched += 1;
        continue;
      }
      hits.sort((a, b) => a.location.distance - b.location.distance);
      for (const hit of allRoutes ? hits : hits.slice(0, 1)) {
        features.push({
          type: "Feature",
          properties: {
            ...(feature.properties ?? {}),
            route_id: hit.route,
            measure: hit.location.measure,
            distance_m: hit.location.distance,
          },
          geometry: { type: "Point", coordinates: hit.position },
        });
      }
    }
    if (unmatched) ctx.log(`${unmatched} feature(s) had no route within ${radius} m`);
    if (features.length === 0) {
      ctx.log("No features were located on a route");
      return;
    }
    ctx.log(`Located ${features.length} event(s) along routes`);
    ctx.addResultLayer?.("Route events", { type: "FeatureCollection", features });
  },
};

export const dynamicSegmentationTool: ProcessingAlgorithm = {
  id: "dynamic-segmentation",
  name: "Dynamic segmentation",
  description:
    "Turn an event table with route IDs and measures into features: line events (from and to measures) become route segments, point events (one measure) become points",
  group: "Linear referencing",
  parameters: [
    {
      id: "routes",
      label: "Route layer",
      type: "layer",
      required: true,
      geometryFilter: ["line"],
    },
    {
      id: "routeIdField",
      label: "Route ID field",
      type: "field",
      fieldSource: "routes",
      description: "Leave empty to use the route feature id or index.",
    },
    { id: "layer", label: "Event table", type: "layer", required: true },
    { id: "eventRouteField", label: "Event route ID field", type: "field", required: true },
    { id: "fromField", label: "From (or point) measure field", type: "field", required: true },
    {
      id: "toField",
      label: "To measure field",
      type: "field",
      description: "Leave empty for point events.",
    },
  ],
  run: async (ctx) => {
    const routesLayer = getLayer(ctx, "routes");
    const events = getLayer(ctx, "layer")?.geojson;
    if (!routesLayer?.geojson?.features?.length || !events?.features?.length) {
      ctx.log("Error: select a route layer and an event table with rows");
      return;
    }
    const eventRouteField = ctx.parameters.eventRouteField as string | undefined;
    const fromField = ctx.parameters.fromField as string | undefined;
    const toField = (ctx.parameters.toField as string | undefined) || undefined;
    if (!eventRouteField || !fromField) {
      ctx.log("Error: choose the event route ID and measure fields");
      return;
    }
    const routeIdField = (ctx.parameters.routeIdField as string | undefined) || undefined;
    const routes = collectRoutes(routesLayer.geojson, routeIdField, ctx.log);
    const features: Feature[] = [];
    let noRoute = 0;
    let offRoute = 0;
    let badMeasure = 0;
    for (const event of events.features) {
      const routeValue = event.properties?.[eventRouteField];
      const candidates =
        routeValue === null || routeValue === undefined
          ? undefined
          : routes.get(String(routeValue));
      if (!candidates) {
        noRoute += 1;
        continue;
      }
      const from = numberOrUndefined(event.properties?.[fromField]);
      const to = toField ? numberOrUndefined(event.properties?.[toField]) : undefined;
      if (from === undefined || (toField && to === undefined)) {
        badMeasure += 1;
        continue;
      }
      let geometry: Geometry | null = null;
      for (const route of candidates) {
        if (toField && to !== from) {
          geometry = sliceRouteByMeasure(route.geometry, from, to!);
        } else {
          const point = pointAtMeasure(route.geometry, from);
          geometry = point ? { type: "Point", coordinates: point } : null;
        }
        if (geometry) break;
      }
      if (!geometry) {
        offRoute += 1;
        continue;
      }
      features.push({ type: "Feature", properties: { ...(event.properties ?? {}) }, geometry });
    }
    if (noRoute) ctx.log(`${noRoute} event(s) reference a route that does not exist`);
    if (badMeasure) ctx.log(`${badMeasure} event(s) have no numeric measure`);
    if (offRoute) ctx.log(`${offRoute} event(s) fall outside their route's measure range`);
    if (features.length === 0) {
      ctx.log("No events could be placed");
      return;
    }
    ctx.log(`Placed ${features.length} event(s)`);
    ctx.addResultLayer?.("Route event features", { type: "FeatureCollection", features });
  },
};

export const LINEAR_REFERENCING_TOOLS: ProcessingAlgorithm[] = [
  createRoutesTool,
  locateFeaturesAlongRoutesTool,
  dynamicSegmentationTool,
];
