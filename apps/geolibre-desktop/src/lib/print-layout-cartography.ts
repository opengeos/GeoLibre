/**
 * Pure geometry for the Print Layout's cartographic extras (GH #3530):
 *
 * - the map-frame coordinate grid: where Lat/Lon, UTM and MGRS lines cross the
 *   frame border, at what interval, and how each tick is labelled;
 * - the overview / inset locator map: the Web Mercator view it renders and
 *   where a longitude/latitude lands on it;
 * - free-form element positioning: how a stored offset or frame box maps onto
 *   page pixels, and how a drag or resize turns back into one.
 *
 * Nothing here touches a canvas or the DOM, so all of it is unit tested in
 * `tests/print-layout-cartography.test.ts`; `print-layout.ts` does the drawing.
 */

import type {
  PrintLayoutGridType,
  PrintLayoutElementOffset,
  PrintLayoutFrameBox,
} from "@geolibre/core";
import * as mgrsModule from "mgrs";
import proj4, { type Converter } from "proj4";

// mgrs 2.x publishes an ESM `module` build with named exports only, and a UMD
// `main` whose named exports Node cannot detect. Bundlers take the first, the
// test runner the second, so read the functions from whichever carries them
// (the same shim as packages/plugins' satellite-embeddings-grids.ts).
const mgrs: typeof mgrsModule =
  "forward" in mgrsModule ? mgrsModule : (Reflect.get(mgrsModule, "default") as typeof mgrsModule);

/** A rectangle in page pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A point in page pixels. */
export interface Point {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Coordinate grid
// ---------------------------------------------------------------------------

/** How the map-frame grid labels its ticks. */
export type MapGridType = PrintLayoutGridType;

/** One side of the map frame. */
export type FrameEdge = "top" | "bottom" | "left" | "right";

/** Where one grid line meets the frame border. */
export interface GridTick {
  edge: FrameEdge;
  axis: 0 | 1;
  /** Page-pixel position on the frame border. */
  x: number;
  y: number;
  /** The coordinate value (degrees, or UTM metres). */
  value: number;
  label: string;
}

/** A grid line across the frame, joining two ticks with the same value. */
export interface GridLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The computed grid for one frame. */
export interface MapGrid {
  ticks: GridTick[];
  lines: GridLine[];
  /** The interval used, in degrees (Lat/Lon) or metres (UTM, MGRS). */
  interval: number;
  /**
   * The UTM zone ("33N") or MGRS grid zone and 100 km square ("33U VP") the
   * projected grid is drawn in; null for a Lat/Lon grid.
   */
  zoneLabel: string | null;
  warning?: "mgrs-multiple-squares";
}

/** Degree intervals a DMS grid snaps to: whole seconds, minutes and degrees. */
const DMS_STEPS: readonly number[] = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000, 36000, 54000, 108000,
  162000, 324000,
].map((seconds) => seconds / 3600);

/** The smallest "nice" 1-2-5 number at or above `raw`. */
function niceCeil125(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  for (const m of [1, 2, 5, 10]) {
    if (m * base >= raw * (1 - 1e-9)) return m * base;
  }
  return 10 * base;
}

/**
 * The automatic grid interval for a frame spanning `span` units (degrees for a
 * Lat/Lon grid, metres for UTM/MGRS) along its shorter side, aiming for about
 * `target` lines across it.
 *
 * @param span - Coordinate extent of the frame's shorter side.
 * @param type - The grid type.
 * @param target - The number of intervals wanted across `span`.
 * @returns A positive interval snapped to a readable step.
 */
export function autoGridInterval(span: number, type: MapGridType, target = 4): number {
  const raw = Math.abs(span) / Math.max(1, target);
  if (type === "dms") {
    return DMS_STEPS.find((step) => step >= raw * (1 - 1e-9)) ?? DMS_STEPS[DMS_STEPS.length - 1];
  }
  if (type === "decimal") return Math.min(90, niceCeil125(raw));
  // MGRS labels are kilometre digits, so its lines are at least 1 km apart.
  const metres = niceCeil125(raw);
  return type === "mgrs" ? Math.max(1000, metres) : Math.max(1, metres);
}

/**
 * Where multiples of `interval` occur along one frame edge.
 *
 * The edge is sampled at `samples + 1` evenly spaced points; between each
 * consecutive pair the coordinate is treated as linear, which is exact for a
 * north-up Web Mercator capture and well inside a pixel for anything else at
 * the default density.
 *
 * @param valueAt - The coordinate at a position `t` in [0, 1] along the edge,
 *   or null where the edge leaves the map (off the globe).
 * @param interval - The grid interval; must be positive.
 * @param periodic - True for longitude, so a crossing of the antimeridian is
 *   unwrapped instead of read as a 360-degree jump.
 * @param samples - How many segments to split the edge into.
 * @returns Each crossing's `t` and exact value, in edge order.
 */
export function findEdgeTicks(
  valueAt: (t: number) => number | null,
  interval: number,
  periodic = false,
  samples = 128,
): { t: number; value: number }[] {
  if (!(interval > 0) || !Number.isFinite(interval)) return [];
  const out: { t: number; value: number }[] = [];
  let prev: { t: number; v: number } | null = null;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    let v = valueAt(t);
    if (v === null || !Number.isFinite(v)) {
      prev = null;
      continue;
    }
    if (periodic && prev) {
      while (v - prev.v > 180) v -= 360;
      while (prev.v - v > 180) v += 360;
    }
    if (prev && v !== prev.v) {
      const lo = Math.min(prev.v, v);
      const hi = Math.max(prev.v, v);
      // Closed [lo, hi]: a multiple landing exactly on a shared sample is found
      // by both segments and merged below. `+ 0` turns -0 into 0.
      const eps = 1e-9 * interval;
      const worldFirst = periodic ? Math.floor((lo + 180) / 360) : 0;
      const worldLast = periodic ? Math.floor((hi + 180) / 360) : 0;
      if (![worldFirst, worldLast].every(Number.isSafeInteger) || worldLast - worldFirst > 4096)
        return [];
      for (let world = worldFirst; world <= worldLast; world++) {
        const shift = world * 360;
        const localLo = periodic ? Math.max(-180, lo - shift) : lo;
        const localHi = periodic ? Math.min(180, hi - shift) : hi;
        const first = Math.ceil((localLo - eps) / interval);
        const last = Math.floor((localHi + eps) / interval);
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last - first > 4096)
          return [];
        for (let k = first; k <= last; k++) {
          const value = k * interval + shift + 0;
          const f = Math.min(1, Math.max(0, (value - prev.v) / (v - prev.v)));
          out.push({ t: prev.t + f * (t - prev.t), value });
          if (out.length >= 4096) return out;
        }
      }
    }
    prev = { t, v };
  }
  out.sort((a, b) => a.t - b.t);
  // Merge the duplicates shared samples (or a flat run of samples) produce.
  return out.filter(
    (tick, i) =>
      i === 0 ||
      Math.abs(tick.t - out[i - 1].t) > 1e-6 ||
      Math.abs(tick.value - out[i - 1].value) > 1e-9 * interval,
  );
}

/** Wrap a longitude into [-180, 180). */
export function wrapLongitude(lng: number): number {
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

/**
 * Format an angle as degrees, minutes and seconds with a hemisphere letter,
 * dropping zero trailing parts ("45°N", "122°30′W", "12°15′30″S").
 *
 * @param value - The angle in degrees (a longitude is wrapped first).
 * @param axis - "lon" for E/W, "lat" for N/S.
 * @returns The label.
 */
export function formatDms(value: number, axis: "lon" | "lat"): string {
  const v = axis === "lon" ? wrapLongitude(value) : value;
  let total = Math.round(Math.abs(v) * 3600);
  const deg = Math.floor(total / 3600);
  total -= deg * 3600;
  const min = Math.floor(total / 60);
  const sec = total - min * 60;
  let text = `${deg}°`;
  if (min > 0 || sec > 0) text += `${String(min).padStart(2, "0")}′`;
  if (sec > 0) text += `${String(sec).padStart(2, "0")}″`;
  return text + hemisphere(v, axis);
}

function hemisphere(v: number, axis: "lon" | "lat"): string {
  // 0 and 180 carry no hemisphere: they are on the line between two.
  if (Math.abs(v) < 1e-9 || (axis === "lon" && Math.abs(Math.abs(v) - 180) < 1e-9)) return "";
  if (axis === "lon") return v < 0 ? "W" : "E";
  return v < 0 ? "S" : "N";
}

/**
 * Format an angle as decimal degrees with as many decimals as the interval
 * needs ("45°N", "122.25°W").
 *
 * @param value - The angle in degrees.
 * @param axis - "lon" or "lat".
 * @param interval - The grid interval, which sets the decimals.
 * @returns The label.
 */
export function formatDecimalDegrees(value: number, axis: "lon" | "lat", interval: number): string {
  const v = axis === "lon" ? wrapLongitude(value) : value;
  // The fewest decimals that write the interval exactly (0.25 needs two).
  let decimals = 0;
  while (
    decimals < 6 &&
    Math.abs(interval * 10 ** decimals - Math.round(interval * 10 ** decimals)) > 1e-6
  ) {
    decimals++;
  }
  let text = Math.abs(v).toFixed(decimals);
  // Trailing zeros of a multiple (10.50 on a 0.25 grid) carry nothing.
  if (text.includes(".")) text = text.replace(/\.?0+$/, "");
  return `${text}°${hemisphere(v, axis)}`;
}

/**
 * Format a UTM easting or northing in metres ("345000mE", "4123000mN").
 *
 * @param value - The coordinate in metres.
 * @param axis - "lon" for an easting, "lat" for a northing.
 * @returns The label.
 */
export function formatUtm(value: number, axis: "lon" | "lat"): string {
  return `${Math.round(value)}m${axis === "lon" ? "E" : "N"}`;
}

/**
 * The MGRS "principal digits" of a UTM coordinate: its kilometres inside the
 * 100 km square, two digits ("45" for an easting of 345000).
 *
 * @param value - The easting or northing in metres.
 * @returns The two-digit label.
 */
export function formatMgrsDigits(value: number): string {
  const inSquare = (((Math.round(value) % 100000) + 100000) % 100000) / 1000;
  return String(Math.floor(inSquare + 1e-9)).padStart(2, "0");
}

/** A UTM zone: number (1-60) and hemisphere. */
export interface UtmZone {
  zone: number;
  south: boolean;
}

/**
 * The UTM zone a point falls in, including the Norway and Svalbard
 * exceptions.
 *
 * @param lng - Longitude in degrees.
 * @param lat - Latitude in degrees.
 * @returns The zone.
 */
export function utmZoneFor(lng: number, lat: number): UtmZone {
  const lon = wrapLongitude(lng);
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) zone = 31;
    else if (lon >= 9 && lon < 21) zone = 33;
    else if (lon >= 21 && lon < 33) zone = 35;
    else if (lon >= 33 && lon < 42) zone = 37;
  }
  return { zone: Math.min(60, Math.max(1, zone)), south: lat < 0 };
}

const utmConverters = new Map<string, Converter>();

/**
 * A WGS 84 longitude/latitude to UTM easting/northing converter for one zone.
 *
 * @param zone - The zone to project into (points outside it still project,
 *   with the usual growing distortion).
 * @returns The converter.
 */
export function utmProjector(zone: UtmZone): (lng: number, lat: number) => [number, number] {
  const def = `+proj=utm +zone=${zone.zone}${zone.south ? " +south" : ""} +datum=WGS84 +units=m +no_defs`;
  let converter = utmConverters.get(def);
  if (!converter) {
    converter = proj4("EPSG:4326", def);
    utmConverters.set(def, converter);
  }
  const active = converter;
  return (lng, lat) => active.forward([lng, lat]) as [number, number];
}

/**
 * The MGRS grid zone and 100 km square a point is in, spaced for a map label
 * ("33U VP").
 *
 * @param lng - Longitude in degrees.
 * @param lat - Latitude in degrees.
 * @returns The label, or null outside MGRS coverage (the poles).
 */
export function mgrsSquareLabel(lng: number, lat: number): string | null {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lat < -80 || lat >= 84) return null;
  try {
    const ref = mgrs.forward([wrapLongitude(lng), lat], 0);
    const match = /^(\d{1,2}[A-Z])([A-Z]{2})$/.exec(ref);
    return match ? `${match[1]} ${match[2]}` : ref;
  } catch {
    return null;
  }
}

/** Inputs to {@link computeMapGrid}. */
export interface MapGridInput {
  /** The map frame in page pixels. */
  frame: Rect;
  /** Longitude/latitude at a page pixel, or null off the map. */
  pageToLngLat: (x: number, y: number) => [number, number] | null;
  type: MapGridType;
  /** Interval in degrees (Lat/Lon) or metres (UTM, MGRS); 0 picks one. */
  interval: number;
  /** Edge sampling density. */
  samples?: number;
}

/**
 * Compute the border ticks, labels and grid lines for a map frame.
 *
 * Both coordinates are sampled on all four edges so rotated frames retain
 * their crossings. A projected grid uses the frame centre's UTM zone.
 *
 * @param input - The frame, its georeference and the grid settings.
 * @returns The grid, or null when the frame centre has no coordinate.
 */
export function computeMapGrid(input: MapGridInput): MapGrid | null {
  const { frame, pageToLngLat, type } = input;
  const samples = input.samples ?? 128;
  const center = pageToLngLat(frame.x + frame.w / 2, frame.y + frame.h / 2);
  if (!center) return null;
  const projected = type === "utm" || type === "mgrs";
  const zone = projected ? utmZoneFor(center[0], center[1]) : null;
  const project = zone ? utmProjector(zone) : null;
  const coordAt = (x: number, y: number): [number, number] | null => {
    const ll = pageToLngLat(x, y);
    if (!ll) return null;
    if (!project) return ll;
    try {
      const xy = project(ll[0], ll[1]);
      return Number.isFinite(xy[0]) && Number.isFinite(xy[1]) ? xy : null;
    } catch {
      return null;
    }
  };

  const frameEdges: { edge: FrameEdge; from: Point; to: Point; axis: 0 | 1 }[] = [
    {
      edge: "top",
      from: { x: frame.x, y: frame.y },
      to: { x: frame.x + frame.w, y: frame.y },
      axis: 0,
    },
    {
      edge: "bottom",
      from: { x: frame.x, y: frame.y + frame.h },
      to: { x: frame.x + frame.w, y: frame.y + frame.h },
      axis: 0,
    },
    {
      edge: "left",
      from: { x: frame.x, y: frame.y },
      to: { x: frame.x, y: frame.y + frame.h },
      axis: 1,
    },
    {
      edge: "right",
      from: { x: frame.x + frame.w, y: frame.y },
      to: { x: frame.x + frame.w, y: frame.y + frame.h },
      axis: 1,
    },
  ];
  const edges = frameEdges.flatMap((edge) => [
    { ...edge, axis: 0 as const },
    { ...edge, axis: 1 as const },
  ]);
  const along = (e: (typeof edges)[number], t: number): Point => ({
    x: e.from.x + (e.to.x - e.from.x) * t,
    y: e.from.y + (e.to.y - e.from.y) * t,
  });
  const valueAlong = (e: (typeof edges)[number]) => (t: number) => {
    const p = along(e, t);
    const c = coordAt(p.x, p.y);
    return c ? c[e.axis] : null;
  };

  const spanOf = (edge: (typeof edges)[number]) => {
    const at = valueAlong(edge);
    let previous: number | null = null;
    let low = Infinity,
      high = -Infinity;
    for (let i = 0; i <= samples; i++) {
      let value = at(i / samples);
      if (value === null || !Number.isFinite(value)) continue;
      if (!projected && edge.axis === 0 && previous !== null) {
        value += 360 * Math.round((previous - value) / 360);
      }
      low = Math.min(low, value);
      high = Math.max(high, value);
      previous = value;
    }
    return Math.max(0, high - low);
  };
  const spans = [0, 1].map((axis) => Math.max(...edges.filter((e) => e.axis === axis).map(spanOf)));
  const span = Math.min(...spans.filter((value) => value > 0));
  const largestSpan = Math.max(...spans);
  if (!(span > 0) || !Number.isFinite(span)) return null;
  let interval =
    input.interval > 0 && Number.isFinite(input.interval)
      ? input.interval
      : autoGridInterval(span, type);
  const precisionFloor =
    type === "mgrs" ? 1000 : type === "utm" ? 1 : type === "dms" ? 1 / 3600 : 1e-6;
  interval = Math.max(interval, largestSpan / 200, precisionFloor);
  if (type === "mgrs") interval = Math.ceil(interval / 1000) * 1000;

  if (type === "mgrs") {
    const square = mgrsSquareLabel(center[0], center[1]);
    for (const edge of frameEdges) {
      for (let i = 0; i <= samples; i++) {
        const p = along(edge, i / samples);
        const ll = pageToLngLat(p.x, p.y);
        if (!ll || !square || mgrsSquareLabel(ll[0], ll[1]) !== square) {
          return {
            ticks: [],
            lines: [],
            interval,
            zoneLabel: null,
            warning: "mgrs-multiple-squares",
          };
        }
      }
    }
  }

  const label = (value: number, axis: 0 | 1): string => {
    const ax = axis === 0 ? "lon" : "lat";
    switch (type) {
      case "dms":
        return formatDms(value, ax);
      case "decimal":
        return formatDecimalDegrees(value, ax, interval);
      case "utm":
        return formatUtm(value, ax);
      case "mgrs":
        return formatMgrsDigits(value);
    }
  };

  const ticks: GridTick[] = [];
  for (const e of edges) {
    const periodic = !projected && e.axis === 0;
    for (const { t, value } of findEdgeTicks(valueAlong(e), interval, periodic, samples)) {
      const p = along(e, t);
      ticks.push({
        edge: e.edge,
        axis: e.axis,
        x: p.x,
        y: p.y,
        value,
        label: label(value, e.axis),
      });
    }
  }

  // Join equal-coordinate crossings even when rotation puts them on adjacent
  // edges. Projected lines are approximated by straight chords inside the frame.
  const lines: GridLine[] = [];
  const crossings = new Map<string, GridTick[]>();
  for (const tick of ticks) {
    const value = !projected && tick.axis === 0 ? wrapLongitude(tick.value) : tick.value;
    const key = `${tick.axis}:${Math.round((value / interval) * 1e7)}`;
    const group = crossings.get(key) ?? [];
    if (!group.some((p) => Math.hypot(p.x - tick.x, p.y - tick.y) < 1e-6)) group.push(tick);
    crossings.set(key, group);
  }
  for (const group of crossings.values()) {
    const dx = Math.max(...group.map((p) => p.x)) - Math.min(...group.map((p) => p.x));
    const dy = Math.max(...group.map((p) => p.y)) - Math.min(...group.map((p) => p.y));
    group.sort((a, b) => (dx > dy ? a.x - b.x || a.y - b.y : a.y - b.y || a.x - b.x));
    for (let i = 1; i < group.length; i += 2) {
      const a = group[i - 1],
        b = group[i];
      lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
  }

  let zoneLabel: string | null = null;
  if (zone) {
    zoneLabel =
      type === "mgrs"
        ? mgrsSquareLabel(center[0], center[1])
        : `${zone.zone}${zone.south ? "S" : "N"}`;
  }
  return { ticks, lines, interval, zoneLabel };
}

/**
 * Convert a font size in typographic points to page pixels.
 *
 * @param points - The size in points (1/72 inch).
 * @param pageWidthPx - The page width in pixels at the current resolution.
 * @param pageWidthMm - The page's physical width in millimetres.
 * @returns The size in page pixels.
 */
export function pointsToPagePx(points: number, pageWidthPx: number, pageWidthMm: number): number {
  if (!(pageWidthMm > 0) || !(pageWidthPx > 0)) return points;
  return points * (25.4 / 72) * (pageWidthPx / pageWidthMm);
}

// ---------------------------------------------------------------------------
// Inset / overview map
// ---------------------------------------------------------------------------

/** MapLibre's world size at zoom 0, in CSS pixels. */
const TILE_SIZE = 512;
const MAX_MERCATOR_LAT = 85.0511287798066;

/** A north-up Web Mercator view: what an inset map renders. */
export interface MercatorView {
  center: [number, number];
  zoom: number;
  /** Rendered size in CSS pixels. */
  width: number;
  height: number;
}

/** Keep both dimensions positive while bounding a very narrow or wide inset. */
export function insetRenderSize(
  aspect: number,
  maxDimension = 480,
): { width: number; height: number } {
  const value = aspect > 0 && Number.isFinite(aspect) ? aspect : 4 / 3;
  return value >= 1
    ? { width: maxDimension, height: Math.max(1, Math.round(maxDimension / value)) }
    : { width: Math.max(1, Math.round(maxDimension * value)), height: maxDimension };
}

function mercatorX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * TILE_SIZE * 2 ** zoom;
}

function mercatorY(lat: number, zoom: number): number {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const rad = (clamped * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
  return y * TILE_SIZE * 2 ** zoom;
}

/**
 * Where a longitude/latitude lands in a rendered Web Mercator view, in the
 * view's CSS pixels (origin top-left).
 *
 * @param view - The view.
 * @param lng - Longitude in degrees.
 * @param lat - Latitude in degrees.
 * @returns The pixel position.
 */
export function mercatorViewPx(view: MercatorView, lng: number, lat: number, wrap = true): Point {
  let dLng = lng - view.center[0];
  // Take the short way round so a frame across the antimeridian stays whole.
  while (wrap && dLng > 180) dLng -= 360;
  while (wrap && dLng < -180) dLng += 360;
  const cx = mercatorX(view.center[0], view.zoom);
  const x = mercatorX(view.center[0] + dLng, view.zoom) - cx + view.width / 2;
  const y = mercatorY(lat, view.zoom) - mercatorY(view.center[1], view.zoom) + view.height / 2;
  return { x, y };
}

/**
 * The footprint of a boundary that circles a pole, closed along that pole's
 * map edge. The ring restarts at the view's world seam so the cap spans
 * exactly the rendered world, whichever vertex the boundary started on.
 *
 * @param view - The inset view.
 * @param boundary - The ring, in order, without its closing vertex.
 * @param dir - 1 when the ring travels east, -1 when it travels west.
 * @param centreLat - Legacy hemisphere hint when explicit visibility is absent.
 * @param visiblePole - Pole verified on the actual capture surface.
 * @returns The footprint in view pixels.
 */
function polarFootprint(
  view: MercatorView,
  boundary: readonly [number, number][],
  dir: 1 | -1,
  centreLat?: number,
  visiblePole?: -90 | 90,
): Point[] {
  const hemisphere =
    visiblePole ??
    (Number.isFinite(centreLat)
      ? centreLat!
      : boundary.reduce<number>((sum, point) => sum + point[1], 0));
  const pole = hemisphere >= 0 ? MAX_MERCATOR_LAT : -MAX_MERCATOR_LAT;
  const seam = view.center[0] - 180;
  const offset = (lng: number) => (((lng - seam) % 360) + 360) % 360;
  // Eastward rings start just east of the seam, westward ones just west of it.
  let start = 0;
  for (let i = 1; i < boundary.length; i++) {
    const delta = offset(boundary[i][0]) - offset(boundary[start][0]);
    if (dir * delta < 0) start = i;
  }
  const ring: [number, number][] = [];
  for (let k = 0; k < boundary.length; k++) {
    const [lng, lat] = boundary[(start + k) % boundary.length];
    const previous = ring.at(-1)?.[0];
    ring.push([
      previous === undefined ? seam + offset(lng) : lng + 360 * Math.round((previous - lng) / 360),
      lat,
    ]);
  }
  const head = ring[0];
  const tail = ring[ring.length - 1];
  // The ring re-crosses the seam between its tail and its (next-world) head.
  const enter = dir > 0 ? seam : seam + 360;
  const exit = dir > 0 ? seam + 360 : seam;
  const headNext = head[0] + 360 * dir;
  const t = headNext !== tail[0] ? (exit - tail[0]) / (headNext - tail[0]) : 0;
  const seamLat = tail[1] + (head[1] - tail[1]) * Math.max(0, Math.min(1, t));
  return [
    [enter, seamLat] as [number, number],
    ...ring,
    [exit, seamLat],
    [exit, pole],
    [enter, pole],
  ].map(([lng, lat]) => mercatorViewPx(view, lng, lat, false));
}

/**
 * Project an ordered, densified boundary without folding it at the dateline.
 *
 * @param view - The inset view.
 * @param boundary - The main frame's boundary, in order.
 * @param centreLat - Legacy hemisphere hint when explicit visibility is absent.
 * @param visiblePole - Verified enclosed pole, or null when no single pole is enclosed.
 * @returns The footprint in view pixels.
 */
export function insetFootprint(
  view: MercatorView,
  boundary: readonly [number, number][],
  centreLat?: number,
  visiblePole?: -90 | 90 | null,
): Point[] {
  const unwrapped: [number, number][] = [];
  for (const [lng, lat] of boundary) {
    const previous = unwrapped.at(-1)?.[0];
    unwrapped.push([
      previous === undefined ? lng : lng + 360 * Math.round((previous - lng) / 360),
      lat,
    ]);
  }
  if (!unwrapped.length) return [];
  // The boundary is a closed ring sampled up to (not including) its start, so
  // whole turns between its ends mean it circles a pole: a globe seen from
  // above it (GH #3551). An open curve is not expected here.
  const turns = Math.round((unwrapped[unwrapped.length - 1][0] - unwrapped[0][0]) / 360);
  if (turns !== 0 && visiblePole !== null)
    return polarFootprint(view, boundary, turns > 0 ? 1 : -1, centreLat, visiblePole);
  const west = Math.min(...unwrapped.map((point) => point[0]));
  const east = Math.max(...unwrapped.map((point) => point[0]));
  if (east - west >= 360 - 1e-7) {
    const north = Math.max(...unwrapped.map((point) => point[1]));
    const south = Math.min(...unwrapped.map((point) => point[1]));
    return [
      [view.center[0] - 180, north],
      [view.center[0] + 180, north],
      [view.center[0] + 180, south],
      [view.center[0] - 180, south],
    ].map(([lng, lat]) => mercatorViewPx(view, lng, lat, false));
  }
  const shift = 360 * Math.round((view.center[0] - (west + east) / 2) / 360);
  return unwrapped.map(([lng, lat]) => mercatorViewPx(view, lng + shift, lat, false));
}

/**
 * The view an inset locator map renders: centred on the main frame's extent,
 * zoomed to fit it, then zoomed out by `zoomOffset` levels so the extent reads
 * as a rectangle inside its surroundings.
 *
 * @param bounds - The main frame's extent, `[west, south, east, north]`.
 * @param width - The inset's rendered width in CSS pixels.
 * @param height - The inset's rendered height in CSS pixels.
 * @param zoomOffset - Levels to zoom out from the fitted zoom (<= 0).
 * @returns The view; the zoom is clamped to [0, 22].
 */
export function insetViewForBounds(
  bounds: [number, number, number, number],
  width: number,
  height: number,
  zoomOffset: number,
): MercatorView {
  const [west, south, , north] = bounds;
  const east = bounds[2] < west ? bounds[2] + 360 : bounds[2];
  const midLat = mercatorLatFromY((mercatorY(south, 0) + mercatorY(north, 0)) / 2);
  const center: [number, number] = [wrapLongitude((west + east) / 2), midLat];
  const spanX = Math.max(1e-9, mercatorX(east, 0) - mercatorX(west, 0));
  const spanY = Math.max(1e-9, mercatorY(south, 0) - mercatorY(north, 0));
  const fit = Math.log2(Math.min(width / spanX, height / spanY));
  const zoom = Math.max(0, Math.min(22, fit + Math.min(0, zoomOffset)));
  return { center, zoom, width, height };
}

function mercatorLatFromY(y0: number): number {
  const n = Math.PI - (2 * Math.PI * y0) / TILE_SIZE;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

// ---------------------------------------------------------------------------
// Free-form element positioning
// ---------------------------------------------------------------------------

/**
 * A movable page element's displacement from its automatic position: a
 * translation as fractions of the page width/height, and a uniform scale
 * about the element's anchor.
 */
export type ElementOffset = PrintLayoutElementOffset;

/** A frame placed on the page, as fractions of the page width/height. */
export type FrameBox = PrintLayoutFrameBox;

export const MIN_ELEMENT_SCALE = 0.25;
export const MAX_ELEMENT_SCALE = 4;
/** Smallest a frame may be resized to, as a page fraction. */
export const MIN_FRAME_SIZE = 0.05;

/**
 * Clamp an element scale to the supported range; a non-finite value is 1.
 *
 * @param scale - The requested scale.
 * @returns The clamped scale.
 */
export function clampElementScale(scale: number): number {
  return Number.isFinite(scale)
    ? Math.min(MAX_ELEMENT_SCALE, Math.max(MIN_ELEMENT_SCALE, scale))
    : 1;
}

/**
 * Where an element drawn at `natural` lands once its offset is applied: scaled
 * about `anchor`, then translated.
 *
 * @param natural - The element's box at its automatic position, page pixels.
 * @param anchor - The point the element scales about, page pixels.
 * @param offset - The stored offset, or undefined for none.
 * @param W - Page width in pixels.
 * @param H - Page height in pixels.
 * @returns The displaced box in page pixels.
 */
export function offsetBox(
  natural: Rect,
  anchor: Point,
  offset: ElementOffset | undefined,
  W: number,
  H: number,
): Rect {
  if (!offset) return { ...natural };
  const s = clampElementScale(offset.scale);
  return {
    x: anchor.x + offset.dx * W + (natural.x - anchor.x) * s,
    y: anchor.y + offset.dy * H + (natural.y - anchor.y) * s,
    w: natural.w * s,
    h: natural.h * s,
  };
}

/**
 * The offset after dragging an element by a page-pixel delta.
 *
 * @param offset - The offset at the start of the drag (undefined for none).
 * @param deltaX - Horizontal drag distance in page pixels.
 * @param deltaY - Vertical drag distance in page pixels.
 * @param W - Page width in pixels.
 * @param H - Page height in pixels.
 * @returns The new offset.
 */
export function movedOffset(
  offset: ElementOffset | undefined,
  deltaX: number,
  deltaY: number,
  W: number,
  H: number,
): ElementOffset {
  const base = offset ?? { dx: 0, dy: 0, scale: 1 };
  return {
    dx: Math.max(-1, Math.min(1, base.dx + deltaX / W)),
    dy: Math.max(-1, Math.min(1, base.dy + deltaY / H)),
    scale: clampElementScale(base.scale),
  };
}

/**
 * The offset after resizing an element by dragging its bottom-right corner:
 * the scale follows the new width (or height, whichever grew more) and the
 * top-left corner stays put.
 *
 * @param natural - The element's box at its automatic position.
 * @param anchor - The point the element scales about.
 * @param offset - The offset at the start of the resize.
 * @param deltaX - Horizontal drag of the corner in page pixels.
 * @param deltaY - Vertical drag of the corner in page pixels.
 * @param W - Page width in pixels.
 * @param H - Page height in pixels.
 * @returns The new offset.
 */
export function resizedOffset(
  natural: Rect,
  anchor: Point,
  offset: ElementOffset | undefined,
  deltaX: number,
  deltaY: number,
  W: number,
  H: number,
): ElementOffset {
  const start = offsetBox(natural, anchor, offset, W, H);
  const sx = natural.w > 0 ? (start.w + deltaX) / natural.w : 1;
  const sy = natural.h > 0 ? (start.h + deltaY) / natural.h : 1;
  const current = offset ? clampElementScale(offset.scale) : 1;
  // Follow whichever axis moved further from the current scale, so a mostly
  // horizontal drag on a wide element still resizes it.
  const s = clampElementScale(Math.abs(sx - current) >= Math.abs(sy - current) ? sx : sy);
  return {
    dx: Math.max(-1, Math.min(1, (start.x - anchor.x - (natural.x - anchor.x) * s) / W)),
    dy: Math.max(-1, Math.min(1, (start.y - anchor.y - (natural.y - anchor.y) * s) / H)),
    scale: s,
  };
}

/**
 * Convert a page-pixel rectangle to a page-fraction frame box.
 *
 * @param rect - The rectangle in page pixels.
 * @param W - Page width in pixels.
 * @param H - Page height in pixels.
 * @returns The box.
 */
export function rectToFrameBox(rect: Rect, W: number, H: number): FrameBox {
  return { x: rect.x / W, y: rect.y / H, w: rect.w / W, h: rect.h / H };
}

/**
 * Convert a page-fraction frame box to page pixels.
 *
 * @param box - The box.
 * @param W - Page width in pixels.
 * @param H - Page height in pixels.
 * @returns The rectangle.
 */
export function frameBoxToRect(box: FrameBox, W: number, H: number): Rect {
  return { x: box.x * W, y: box.y * H, w: box.w * W, h: box.h * H };
}

/**
 * Keep a frame box on the page and at least {@link MIN_FRAME_SIZE} on each
 * side.
 *
 * @param box - The box to clamp.
 * @returns The clamped box.
 */
export function clampFrameBox(box: FrameBox): FrameBox {
  const w = Math.min(1, Math.max(MIN_FRAME_SIZE, box.w));
  const h = Math.min(1, Math.max(MIN_FRAME_SIZE, box.h));
  return {
    x: Math.min(1 - w, Math.max(0, box.x)),
    y: Math.min(1 - h, Math.max(0, box.y)),
    w,
    h,
  };
}

/**
 * A frame box moved or resized by a page-fraction delta.
 *
 * @param box - The box at the start of the gesture.
 * @param mode - "move" translates; "resize" drags the bottom-right corner.
 * @param dx - Horizontal delta as a page fraction.
 * @param dy - Vertical delta as a page fraction.
 * @returns The clamped result.
 */
export function adjustFrameBox(
  box: FrameBox,
  mode: "move" | "resize",
  dx: number,
  dy: number,
): FrameBox {
  if (mode === "move") return clampFrameBox({ ...box, x: box.x + dx, y: box.y + dy });
  const w = Math.min(box.w < MIN_FRAME_SIZE ? 1 : 1 - box.x, Math.max(MIN_FRAME_SIZE, box.w + dx));
  const h = Math.min(box.h < MIN_FRAME_SIZE ? 1 : 1 - box.y, Math.max(MIN_FRAME_SIZE, box.h + dy));
  return {
    ...box,
    x: box.w < MIN_FRAME_SIZE ? Math.min(box.x, 1 - w) : box.x,
    y: box.h < MIN_FRAME_SIZE ? Math.min(box.y, 1 - h) : box.y,
    w,
    h,
  };
}

/**
 * Where the inset map sits before the user moves it: the bottom-left corner
 * of the main map frame, a quarter of its width wide at a 4:3 aspect.
 *
 * @param body - The main map frame in page pixels.
 * @param unit - The layout's furniture unit (1% of the page's shorter side).
 * @returns The inset rectangle in page pixels.
 */
export function defaultInsetRect(body: Rect, unit: number): Rect {
  const pad = Math.min(unit * 2, body.w * 0.1, body.h * 0.1);
  const w = Math.min(body.w - 2 * pad, Math.max(unit * 10, body.w * 0.25));
  const h = Math.min(body.h - 2 * pad, body.h * 0.4, w * 0.75);
  return { x: body.x + pad, y: body.y + body.h - pad - h, w, h };
}
