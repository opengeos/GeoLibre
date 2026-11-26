// Movement vector tools: cell sectors, trajectory speed, stop detection and space-time proximity.

import sector from "@turf/sector";
import circle from "@turf/circle";
import { featureCollection } from "@turf/helpers";
import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  LineString,
  Point,
  Polygon,
  Position,
  MultiPolygon,
} from "geojson";
import { bodyLengthToEarth, getActiveEllipsoid } from "@geolibre/core/worker-safe";
import {
  centralAngle,
  geodesicDistance,
  geodesicRadiusBounds,
  isLonLat,
  withinGeodesicDistance,
} from "@geolibre/core/geodesic";
import type { ProcessingAlgorithm } from "./types";
import {
  requireFeatures,
  numberParam,
  toNumeric,
  collectPoints,
  LINEAR_UNITS,
  type LinearUnit,
  METERS_PER_LINEAR_UNIT,
} from "./vector-tools-common";

/**
 * Read a feature property as a finite number, or null when it is missing or
 * non-numeric. Reuses the aggregate engine's coercion (numbers pass through,
 * numeric strings parse, booleans map to 1/0).
 */
export function numberField(props: GeoJsonProperties, field: string | undefined): number | null {
  if (!field) return null;
  return toNumeric(props?.[field]);
}

/**
 * Parse a timestamp property to epoch milliseconds. Accepts parseable date
 * strings (ISO-8601 etc.) and numeric times. Numbers are read by magnitude:
 * `>= 1e11` are taken as epoch milliseconds, and everything else as seconds.
 *
 * The 1e11 boundary sits in the wide gap between the two realistic numeric
 * forms: epoch/relative seconds stay well below ~1e10 (1e10 s is the year 2286;
 * a relative seconds counter is far smaller), while millisecond epochs are
 * >= 1e11 for any date from 1973 onward. This assumes numeric times are not
 * millisecond epochs from before 1973 nor relative-millisecond counters — both
 * unheard of in GPS tracks; use ISO-8601 strings if either is ever needed.
 * Returns null when unparseable.
 */
export function parseTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Math.abs(value) >= 1e11 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    // A bare numeric string is an epoch, not a date, so route it through the
    // numeric branch ("1700000000" → Unix seconds, not "year 1700000000"). The
    // optional exponent also catches scientific notation like "1.7e9".
    if (/^[-+]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed))
      return parseTimestamp(Number(trimmed));
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A point with a parsed timestamp, used by the movement tools. */
export interface TimedPoint {
  coord: Position;
  time: number;
  props: GeoJsonProperties;
}

/**
 * Collect timed point features grouped by an optional id field (each distinct
 * value is one target/trajectory), sorted by time within each group. Points
 * lacking a parseable timestamp are counted in `skipped`; when an id field is
 * set, points with no id value are counted in `skippedNoId` rather than being
 * lumped under one anonymous trajectory (which would wrongly connect unrelated
 * targets). Both kinds are dropped.
 */
export function collectTimedPoints(
  fc: FeatureCollection,
  timeField: string,
  idField: string | undefined,
): {
  groups: Map<string, TimedPoint[]>;
  skipped: number;
  skippedNoId: number;
  skippedPosition: number;
} {
  const groups = new Map<string, TimedPoint[]>();
  let skipped = 0;
  let skippedNoId = 0;
  let skippedPosition = 0;
  for (const point of collectPoints(fc)) {
    // A latitude beyond ±90° has no geodesic distance (GeographicLib gives NaN).
    if (!isLonLat(point.geometry.coordinates)) {
      skippedPosition += 1;
      continue;
    }
    const time = parseTimestamp(point.properties?.[timeField]);
    if (time === null) {
      skipped += 1;
      continue;
    }
    // The "__all__" sentinel is only used when no id field is set; in that case
    // the `if (idField)` branch never runs, so a real trajectory whose id value
    // happens to be "__all__" cannot collide with it (the two paths are mutually
    // exclusive within a single call).
    let key = "__all__";
    if (idField) {
      const rawId = point.properties?.[idField];
      if (rawId == null) {
        skippedNoId += 1;
        continue;
      }
      key = String(rawId);
    }
    const entry: TimedPoint = {
      coord: point.geometry.coordinates,
      time,
      props: point.properties ?? {},
    };
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }
  for (const bucket of groups.values()) bucket.sort((a, b) => a.time - b.time);
  return { groups, skipped, skippedNoId, skippedPosition };
}

export const cellSectorsTool: ProcessingAlgorithm = {
  id: "cell-sectors",
  name: "Cell-site coverage",
  description:
    "Build antenna sector/wedge polygons from point sites using azimuth, radius and beamwidth (read from attribute fields or fixed values). Beamwidth is clamped to 360° (a full circle); the recorded beamwidth reflects the clamped value. Useful for cell-tower coverage, like QGIS Shape Tools.",
  group: "Geometry",
  parameters: [
    {
      id: "layer",
      label: "Input point layer",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "azimuthField",
      label: "Azimuth field (°)",
      type: "field",
      fieldSource: "layer",
      description:
        "Direction the sector faces, in degrees clockwise from north. Falls back to the fixed azimuth when blank or non-numeric.",
    },
    {
      id: "azimuth",
      label: "Azimuth (fixed, °)",
      type: "number",
      default: 0,
      step: 1,
    },
    {
      id: "radiusField",
      label: "Radius field",
      type: "field",
      fieldSource: "layer",
      description: "Coverage radius. Falls back to the fixed radius when blank or non-numeric.",
    },
    {
      id: "radius",
      label: "Radius (fixed)",
      type: "number",
      default: 1,
      min: 0,
      step: 0.1,
    },
    {
      id: "beamwidthField",
      label: "Beamwidth field (°)",
      type: "field",
      fieldSource: "layer",
      description:
        "Angular width of the sector, clamped to 360° (a full circle). Falls back to the fixed beamwidth when blank or non-numeric.",
    },
    {
      id: "beamwidth",
      label: "Beamwidth (fixed, °)",
      type: "number",
      default: 65,
      min: 0,
      max: 360,
      step: 1,
    },
    {
      id: "units",
      label: "Radius units",
      type: "select",
      default: "kilometers",
      options: [
        { value: "kilometers", label: "Kilometers" },
        { value: "meters", label: "Meters" },
        { value: "miles", label: "Miles" },
      ],
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const azimuthField = (ctx.parameters.azimuthField as string)?.trim() || undefined;
    const radiusField = (ctx.parameters.radiusField as string)?.trim() || undefined;
    const beamwidthField = (ctx.parameters.beamwidthField as string)?.trim() || undefined;
    const azimuthDefault = numberParam(ctx, "azimuth", 0);
    const radiusDefault = numberParam(ctx, "radius", 1);
    const beamwidthDefault = numberParam(ctx, "beamwidth", 65);
    const units = (ctx.parameters.units as string) || "kilometers";
    if (!LINEAR_UNITS.has(units)) {
      ctx.log(`Error: unknown units '${units}'`);
      return;
    }
    const points = collectPoints(fc);
    if (!points.length) {
      ctx.log("Error: the input layer has no point features");
      return;
    }
    const sectors: Feature<Polygon | MultiPolygon>[] = [];
    let skipped = 0;
    for (const point of points) {
      const props = point.properties ?? {};
      const azimuth = numberField(props, azimuthField) ?? azimuthDefault;
      const radius = numberField(props, radiusField) ?? radiusDefault;
      let angle = numberField(props, beamwidthField) ?? beamwidthDefault;
      // A non-positive radius or beamwidth has no coverage to draw; skip it.
      if (!(radius > 0) || !(angle > 0)) {
        skipped += 1;
        continue;
      }
      // A full turn is undefined for turf's sector (its two bearings coincide
      // after normalization), so draw an omnidirectional site as a circle.
      if (angle > 360) angle = 360;
      const full = angle === 360; // only reachable once the clamp above fired
      // turf's circle/sector are Earth-radius based, so scale the site radius
      // into its Earth equivalent to cover the intended ground on this body
      // (GeoLibre#1128). A no-op on Earth.
      const turfRadius = bodyLengthToEarth(radius);
      const wedge = full
        ? circle(point.geometry.coordinates, turfRadius, { units: units as LinearUnit })
        : sector(point.geometry.coordinates, turfRadius, azimuth - angle / 2, azimuth + angle / 2, {
            units: units as LinearUnit,
          });
      if (!wedge?.geometry) {
        skipped += 1;
        continue;
      }
      wedge.properties = { ...props, azimuth, radius, beamwidth: angle };
      sectors.push(wedge as Feature<Polygon | MultiPolygon>);
    }
    if (skipped) {
      // Covers both skip reasons above: non-positive radius/beamwidth, and a
      // degenerate geometry returned by turf's sector.
      ctx.log(
        `Skipped ${skipped} site(s) with a non-positive radius/beamwidth or degenerate geometry`,
      );
    }
    ctx.log(`Cell-site coverage: built ${sectors.length} sector(s) from ${points.length} site(s)`);
    ctx.addResultLayer?.("Cell-site coverage", featureCollection(sectors));
  },
};

/**
 * Multipliers from metres-per-second to each supported speed unit. The keys are
 * the literal unit strings (e.g. "m/s", not "ms") so the `speed_units` value in
 * the output GeoJSON is unambiguous to downstream consumers.
 */
export const SPEED_FACTORS: Record<string, number> = {
  "m/s": 1,
  "km/h": 3.6,
  mph: 2.2369362920544,
};

export const trajectorySpeedTool: ProcessingAlgorithm = {
  id: "trajectory-speed",
  name: "Trajectory speed",
  description:
    "Order points by time (per target) and connect consecutive fixes into segments carrying distance, duration and speed. Like QGIS TrajecTools.",
  group: "Movement & time",
  parameters: [
    {
      id: "layer",
      label: "Input point layer",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "timeField",
      label: "Time field",
      type: "field",
      fieldSource: "layer",
      required: true,
      description:
        "Timestamp per fix: an ISO date/time string or an epoch (seconds or milliseconds).",
    },
    {
      id: "idField",
      label: "Target id field",
      type: "field",
      fieldSource: "layer",
      description:
        "Splits the points into separate trajectories. Leave blank to treat all points as one target.",
    },
    {
      id: "speedUnits",
      label: "Speed units",
      type: "select",
      default: "km/h",
      options: [
        { value: "km/h", label: "km/h" },
        { value: "m/s", label: "m/s" },
        { value: "mph", label: "mph" },
      ],
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const timeField = (ctx.parameters.timeField as string)?.trim();
    if (!timeField) {
      ctx.log("Error: a time field is required");
      return;
    }
    const idField = (ctx.parameters.idField as string)?.trim() || undefined;
    const speedUnits = (ctx.parameters.speedUnits as string) || "km/h";
    const factor = SPEED_FACTORS[speedUnits];
    if (factor === undefined) {
      ctx.log(`Error: unknown speed units '${speedUnits}'`);
      return;
    }
    const { groups, skipped, skippedNoId, skippedPosition } = collectTimedPoints(
      fc,
      timeField,
      idField,
    );
    const segments: Feature<LineString>[] = [];
    const ellipsoid = getActiveEllipsoid();
    for (const [key, pts] of groups) {
      for (let i = 1; i < pts.length; i += 1) {
        const a = pts[i - 1];
        const b = pts[i];
        // On the active body's ellipsoid, so speeds are correct off Earth too.
        const meters = geodesicDistance(a.coord, b.coord, ellipsoid);
        const seconds = (b.time - a.time) / 1000;
        // Equal timestamps (the only non-positive gap after sorting) give an
        // undefined speed; emit the segment with null rather than Infinity.
        const speed = seconds > 0 ? Math.round((meters / seconds) * factor * 1000) / 1000 : null;
        segments.push({
          type: "Feature",
          properties: {
            ...(idField ? { [idField]: key } : {}),
            from_time: a.props?.[timeField] ?? null,
            to_time: b.props?.[timeField] ?? null,
            duration_s: Math.round(seconds),
            distance_m: Math.round(meters * 100) / 100,
            speed,
            speed_units: speedUnits,
          },
          geometry: { type: "LineString", coordinates: [a.coord, b.coord] },
        });
      }
    }
    if (skipped) ctx.log(`Skipped ${skipped} point(s) with no parseable time`);
    if (skippedNoId) ctx.log(`Skipped ${skippedNoId} point(s) with no '${idField}' value`);
    if (skippedPosition) ctx.log(`Skipped ${skippedPosition} point(s) with an invalid position`);
    if (!segments.length) {
      ctx.log("Error: need at least two timed fixes in a target to build a segment");
      return;
    }
    // Consecutive fixes with identical timestamps yield a null speed; warn so a
    // style-by-speed expression downstream isn't silently fed nulls.
    const nullSpeed = segments.filter((s) => s.properties?.speed === null).length;
    if (nullSpeed)
      ctx.log(`Warning: ${nullSpeed} segment(s) have identical timestamps and null speed`);
    ctx.log(
      `Trajectory speed: built ${segments.length} segment(s) across ${groups.size} target(s)`,
    );
    ctx.addResultLayer?.("Trajectory speed", featureCollection(segments));
  },
};

/**
 * Point cap for the stop scan. The scan re-anchors on every non-stop advance
 * (see the loop below), so its worst case is O(n²) distance checks on the UI
 * thread. Each check is decided from a haversine bound and reaches the geodesic
 * (about 1 µs) only near the threshold. 5,000 points bounds that to ~12.5M
 * checks in the degenerate case; the typical case is far cheaper because a
 * formed stop jumps the anchor.
 * Larger inputs get a clear "split the layer" error rather than a frozen tab.
 */
export const STOPS_MAX_POINTS = 5_000;

export const detectStopsTool: ProcessingAlgorithm = {
  id: "detect-stops",
  name: "Detect stops",
  description:
    "Find places where a target dwells: runs of consecutive fixes that stay within a distance (absorbing GPS scatter) for at least a minimum duration. Outputs one point per stop. Like QGIS TrajecTools.",
  group: "Movement & time",
  parameters: [
    {
      id: "layer",
      label: "Input point layer",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "timeField",
      label: "Time field",
      type: "field",
      fieldSource: "layer",
      required: true,
      description:
        "Timestamp per fix: an ISO date/time string or an epoch (seconds or milliseconds).",
    },
    {
      id: "idField",
      label: "Target id field",
      type: "field",
      fieldSource: "layer",
      description: "Detects stops per target. Leave blank to treat all points as one target.",
    },
    {
      id: "maxDistance",
      label: "Max distance",
      type: "number",
      required: true,
      default: 50,
      min: 0,
      step: 1,
      description:
        "Every fix in a stop must be within this distance of the stop's first fix (so a stop can span up to twice this value). Set it to your GPS scatter radius.",
    },
    {
      id: "distanceUnits",
      label: "Distance units",
      type: "select",
      default: "meters",
      options: [
        { value: "meters", label: "Meters" },
        { value: "kilometers", label: "Kilometers" },
        { value: "miles", label: "Miles" },
      ],
    },
    {
      id: "minDuration",
      label: "Min duration (s)",
      type: "number",
      required: true,
      default: 60,
      min: 0,
      step: 1,
      description: "A dwell shorter than this is not reported as a stop.",
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const timeField = (ctx.parameters.timeField as string)?.trim();
    if (!timeField) {
      ctx.log("Error: a time field is required");
      return;
    }
    const idField = (ctx.parameters.idField as string)?.trim() || undefined;
    const maxDistance = numberParam(ctx, "maxDistance", 50);
    const distanceUnits = (ctx.parameters.distanceUnits as string) || "meters";
    if (!LINEAR_UNITS.has(distanceUnits)) {
      ctx.log(`Error: unknown distance units '${distanceUnits}'`);
      return;
    }
    const minDurationMs = numberParam(ctx, "minDuration", 60) * 1000;
    const { groups, skipped, skippedNoId, skippedPosition } = collectTimedPoints(
      fc,
      timeField,
      idField,
    );
    let totalPoints = 0;
    for (const pts of groups.values()) totalPoints += pts.length;
    if (totalPoints === 0) {
      ctx.log("Error: no points with a parseable time; check the time field");
      return;
    }
    if (totalPoints > STOPS_MAX_POINTS) {
      ctx.log(
        `Error: ${totalPoints.toLocaleString()} timed points exceed the ${STOPS_MAX_POINTS.toLocaleString()} limit for stop detection; filter or split the layer first`,
      );
      return;
    }
    const stops: Feature<Point>[] = [];
    // Convert the threshold to metres once, rather than converting every
    // measured distance inside the O(n²) scan below.
    const maxMeters = maxDistance * METERS_PER_LINEAR_UNIT[distanceUnits as LinearUnit];
    const ellipsoid = getActiveEllipsoid();
    const bounds = geodesicRadiusBounds(ellipsoid);
    for (const [key, pts] of groups) {
      let i = 0;
      while (i < pts.length) {
        // `j` restarts from i+1 every iteration by design: the distance test is
        // relative to the current anchor pts[i], so when a run is rejected and i
        // advances by one (below), the next anchor must be re-scanned. This is
        // the source of the O(n²) worst case bounded by STOPS_MAX_POINTS; do not
        // "optimize" it into a monotonic pointer, which would change the result.
        let j = i + 1;
        // Extend the run while each later fix stays within maxDistance of the
        // anchor (the run's first fix), so brief GPS scatter around one spot is
        // absorbed into a single stop.
        while (
          j < pts.length &&
          withinGeodesicDistance(pts[i].coord, pts[j].coord, maxMeters, ellipsoid, bounds)
        ) {
          j += 1;
        }
        const run = pts.slice(i, j);
        const durationMs = run[run.length - 1].time - run[0].time;
        if (run.length >= 2 && durationMs >= minDurationMs) {
          // Average longitudes relative to the anchor and unwrap each delta into
          // [-180, 180] so a stop straddling the antimeridian (e.g. 179.9 and
          // -179.9) centres near ±180, not 0. The run is within maxDistance of
          // the anchor, so the deltas are tiny and the unwrap is unambiguous.
          const anchorLon = run[0].coord[0];
          let sumLonDelta = 0;
          let sumLat = 0;
          for (const p of run) {
            let dLon = p.coord[0] - anchorLon;
            if (dLon > 180) dLon -= 360;
            else if (dLon < -180) dLon += 360;
            sumLonDelta += dLon;
            sumLat += p.coord[1];
          }
          const meanLon = ((anchorLon + sumLonDelta / run.length + 540) % 360) - 180;
          stops.push({
            type: "Feature",
            properties: {
              ...(idField ? { [idField]: key } : {}),
              arrival: run[0].props?.[timeField] ?? null,
              departure: run[run.length - 1].props?.[timeField] ?? null,
              duration_s: Math.round(durationMs / 1000),
              n_points: run.length,
            },
            geometry: {
              type: "Point",
              coordinates: [meanLon, sumLat / run.length],
            },
          });
          i = j; // a fix belongs to at most one stop
        } else {
          i += 1; // not a stop; advance and retry from the next fix
        }
      }
    }
    if (skipped) ctx.log(`Skipped ${skipped} point(s) with no parseable time`);
    if (skippedNoId) ctx.log(`Skipped ${skippedNoId} point(s) with no '${idField}' value`);
    if (skippedPosition) ctx.log(`Skipped ${skippedPosition} point(s) with an invalid position`);
    ctx.log(`Detect stops: found ${stops.length} stop(s) across ${groups.size} target(s)`);
    ctx.addResultLayer?.("Stops", featureCollection(stops));
  },
};

/**
 * Worst-case pair cap for the space-time proximity scan. Each pair within the
 * time window costs one distance check on the UI thread: a haversine bound, and
 * the geodesic (about 1 µs) only near the threshold. This bounds the absolute
 * worst case (all points inside the window) to ~2M checks. Typical
 * runs are far cheaper because the time-sorted loop breaks out once the gap is
 * exceeded; the cap only rejects layers whose worst case would freeze the tab.
 */
export const PROXIMITY_MAX_PAIRS = 2_000_000;

/** Multipliers from each supported time unit to milliseconds. */
export const TIME_UNIT_MS: Record<string, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
};

export const spaceTimeProximityTool: ProcessingAlgorithm = {
  id: "space-time-proximity",
  name: "Space-time proximity",
  description:
    "Find pairs of points close in both space and time — e.g. two targets meeting. Outputs a line connecting each qualifying pair, carrying the distance and time gap.",
  group: "Movement & time",
  parameters: [
    {
      id: "layer",
      label: "Input point layer",
      type: "layer",
      required: true,
      geometryFilter: ["point"],
    },
    {
      id: "timeField",
      label: "Time field",
      type: "field",
      fieldSource: "layer",
      required: true,
      description:
        "Timestamp per point: an ISO date/time string or an epoch (seconds or milliseconds).",
    },
    {
      id: "idField",
      label: "Target id field",
      type: "field",
      fieldSource: "layer",
      description:
        "When set, only points with DIFFERENT id values are paired (encounters between distinct targets). Leave blank to consider every pair.",
    },
    {
      id: "maxDistance",
      label: "Max distance",
      type: "number",
      required: true,
      default: 100,
      min: 0,
      step: 1,
    },
    {
      id: "distanceUnits",
      label: "Distance units",
      type: "select",
      default: "meters",
      options: [
        { value: "meters", label: "Meters" },
        { value: "kilometers", label: "Kilometers" },
        { value: "miles", label: "Miles" },
      ],
    },
    {
      id: "maxTime",
      label: "Max time difference",
      type: "number",
      required: true,
      default: 5,
      min: 0,
      step: 1,
    },
    {
      id: "timeUnits",
      label: "Time units",
      type: "select",
      default: "minutes",
      options: [
        { value: "seconds", label: "Seconds" },
        { value: "minutes", label: "Minutes" },
        { value: "hours", label: "Hours" },
      ],
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const timeField = (ctx.parameters.timeField as string)?.trim();
    if (!timeField) {
      ctx.log("Error: a time field is required");
      return;
    }
    const idField = (ctx.parameters.idField as string)?.trim() || undefined;
    const maxDistance = numberParam(ctx, "maxDistance", 100);
    const distanceUnits = (ctx.parameters.distanceUnits as string) || "meters";
    if (!LINEAR_UNITS.has(distanceUnits)) {
      ctx.log(`Error: unknown distance units '${distanceUnits}'`);
      return;
    }
    const maxTimeValue = numberParam(ctx, "maxTime", 5);
    const timeUnits = (ctx.parameters.timeUnits as string) || "minutes";
    const timeFactor = TIME_UNIT_MS[timeUnits];
    if (timeFactor === undefined) {
      ctx.log(`Error: unknown time units '${timeUnits}'`);
      return;
    }
    const maxTimeMs = maxTimeValue * timeFactor;
    const timed: { coord: Position; time: number; id: string | null; props: GeoJsonProperties }[] =
      [];
    let skipped = 0;
    let skippedNoId = 0;
    let skippedPosition = 0;
    for (const point of collectPoints(fc)) {
      // A latitude beyond ±90° has no geodesic distance (GeographicLib gives NaN).
      if (!isLonLat(point.geometry.coordinates)) {
        skippedPosition += 1;
        continue;
      }
      const time = parseTimestamp(point.properties?.[timeField]);
      if (time === null) {
        skipped += 1;
        continue;
      }
      let id: string | null = null;
      if (idField) {
        const rawId = point.properties?.[idField];
        // A missing id would coerce to "" and be treated as one shared target,
        // which would wrongly exclude unrelated id-less points from pairing.
        if (rawId == null) {
          skippedNoId += 1;
          continue;
        }
        id = String(rawId);
      }
      timed.push({
        coord: point.geometry.coordinates,
        time,
        id,
        props: point.properties ?? {},
      });
    }
    const n = timed.length;
    if (n === 0) {
      ctx.log("Error: no points with a parseable time; check the time field");
      return;
    }
    // Pre-work guard on the number of pairs the loop can actually evaluate. With
    // an id field only cross-target pairs are kept, so the real bound is
    // (n² − Σ nᵢ²) / 2 — this lets a layer that is mostly (or entirely) one
    // target through, instead of rejecting it on the all-pairs worst case.
    let maxPairs = (n * (n - 1)) / 2;
    if (idField) {
      const perId = new Map<string, number>();
      for (const t of timed) perId.set(t.id!, (perId.get(t.id!) ?? 0) + 1);
      let sumSquares = 0;
      for (const count of perId.values()) sumSquares += count * count;
      maxPairs = (n * n - sumSquares) / 2;
    }
    if (maxPairs > PROXIMITY_MAX_PAIRS) {
      ctx.log(
        `Error: these points could form up to ${maxPairs.toLocaleString()} pairs ` +
          `(> ${PROXIMITY_MAX_PAIRS.toLocaleString()}); filter or split the layer first` +
          (idField ? " or use more distinct target ids" : ""),
      );
      return;
    }
    // Sort by time so the inner loop can stop once the time gap is exceeded.
    timed.sort((a, b) => a.time - b.time);
    const pairs: Feature<LineString>[] = [];
    // As in stop detection: compare in metres so the O(n²) candidate scan does
    // no per-iteration conversion. Only the pairs that survive the test are
    // converted back to the chosen units for the reported `distance` property.
    const metersPerUnit = METERS_PER_LINEAR_UNIT[distanceUnits as LinearUnit];
    const maxMeters = maxDistance * metersPerUnit;
    // Pairs whose lower bound is already past the threshold skip the geodesic.
    const ellipsoid = getActiveEllipsoid();
    const minRadius = geodesicRadiusBounds(ellipsoid).min;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const dt = timed[j].time - timed[i].time; // >= 0 (sorted)
        if (dt > maxTimeMs) break; // later j only widens the gap
        if (idField && timed[i].id === timed[j].id) continue;
        if (centralAngle(timed[i].coord, timed[j].coord) * minRadius > maxMeters) continue;
        const meters = geodesicDistance(timed[i].coord, timed[j].coord, ellipsoid);
        if (meters > maxMeters) continue;
        const dist = meters / metersPerUnit;
        pairs.push({
          type: "Feature",
          properties: {
            ...(idField ? { id_a: timed[i].id, id_b: timed[j].id } : {}),
            time_a: timed[i].props?.[timeField] ?? null,
            time_b: timed[j].props?.[timeField] ?? null,
            time_diff_s: Math.round(dt / 1000),
            distance: Math.round(dist * 1000) / 1000,
            distance_units: distanceUnits,
          },
          geometry: {
            type: "LineString",
            coordinates: [timed[i].coord, timed[j].coord],
          },
        });
      }
    }
    if (skipped) ctx.log(`Skipped ${skipped} point(s) with no parseable time`);
    if (skippedNoId) ctx.log(`Skipped ${skippedNoId} point(s) with no '${idField}' value`);
    if (skippedPosition) ctx.log(`Skipped ${skippedPosition} point(s) with an invalid position`);
    ctx.log(
      `Space-time proximity: found ${pairs.length} pair(s) within ${maxDistance} ${distanceUnits} and ${maxTimeValue} ${timeUnits}`,
    );
    ctx.addResultLayer?.("Space-time proximity", featureCollection(pairs));
  },
};
