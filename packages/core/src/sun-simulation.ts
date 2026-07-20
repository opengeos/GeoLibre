/** Shared, renderer-neutral model for GeoLibre's sun-position simulation. */

export const SUN_MS_PER_DAY = 86_400_000;
export const SUN_MS_PER_MINUTE = 60_000;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Local midnight (device time zone) of the day containing `dateMs`. */
export function localDayStart(dateMs: number): number {
  const d = new Date(dateMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Persisted, user-tunable state of the sun simulation. */
export interface SunSettings {
  /** Simulated instant, epoch milliseconds (UTC under the hood). */
  dateMs: number;
  /** Whether the clock is animating forward. */
  playing: boolean;
  /** Simulated minutes advanced per real second of playback. */
  speed: number;
  /** When true, playback wraps to the start of the day instead of stopping. */
  loop: boolean;
  /** Opacity of the deep-night core (0 = no shading, 1 = fully dark). */
  shadeOpacity: number;
}

export const SUN_SPEED_MIN = 5;
export const SUN_SPEED_MAX = 480;
export const SUN_SHADE_MIN = 0;
export const SUN_SHADE_MAX = 0.85;

/** A stable default keeps projects deterministic until the user selects Now. */
export const DEFAULT_SUN_SETTINGS: SunSettings = {
  dateMs: Date.UTC(2024, 5, 21, 12, 0, 0),
  playing: false,
  speed: 60,
  loop: true,
  shadeOpacity: 0.55,
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Coerce arbitrary persisted/partial input into a complete SunSettings. */
export function normalizeSunSettings(
  value: unknown,
  base: SunSettings = DEFAULT_SUN_SETTINGS,
): SunSettings {
  const c = (value ?? {}) as Partial<SunSettings>;
  return {
    dateMs: typeof c.dateMs === "number" && Number.isFinite(c.dateMs) ? c.dateMs : base.dateMs,
    playing: typeof c.playing === "boolean" ? c.playing : base.playing,
    speed: clampNumber(c.speed, SUN_SPEED_MIN, SUN_SPEED_MAX, base.speed),
    loop: typeof c.loop === "boolean" ? c.loop : base.loop,
    shadeOpacity: clampNumber(c.shadeOpacity, SUN_SHADE_MIN, SUN_SHADE_MAX, base.shadeOpacity),
  };
}

export function sunSettingsEqual(a: SunSettings, b: SunSettings): boolean {
  return (
    a.dateMs === b.dateMs &&
    a.playing === b.playing &&
    a.speed === b.speed &&
    a.loop === b.loop &&
    a.shadeOpacity === b.shadeOpacity
  );
}

// ---------------------------------------------------------------------------
// Solar position (low-precision NOAA equations).
// ---------------------------------------------------------------------------

function julianDay(dateMs: number): number {
  return dateMs / SUN_MS_PER_DAY + 2440587.5;
}

/** Greenwich Mean Sidereal Time, in hours. */
function greenwichMeanSiderealTime(jd: number): number {
  const d = jd - 2451545.0;
  return (18.697374558 + 24.06570982441908 * d) % 24;
}

export interface SunEquatorial {
  /** Right ascension, degrees. */
  alpha: number;
  /** Declination, degrees. */
  delta: number;
}

/** Sun's apparent right ascension and declination for the given instant. */
export function sunEquatorialPosition(dateMs: number): SunEquatorial {
  const jd = julianDay(dateMs);
  const n = jd - 2451545.0;
  const meanLng = (280.46 + 0.9856474 * n) % 360;
  const meanAnomaly = ((357.528 + 0.9856003 * n) % 360) * D2R;
  const eclipticLng = meanLng + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly);
  const obliquity = 23.439 - 0.0000004 * n;
  const lngRad = eclipticLng * D2R;
  const obRad = obliquity * D2R;

  let alpha = Math.atan2(Math.cos(obRad) * Math.sin(lngRad), Math.cos(lngRad)) * R2D;
  alpha = ((alpha % 360) + 360) % 360;
  const delta = Math.asin(Math.sin(obRad) * Math.sin(lngRad)) * R2D;
  return { alpha, delta };
}

/** Subsolar point: the latitude/longitude where the sun is directly overhead. */
export function subsolarPoint(dateMs: number): { lat: number; lng: number } {
  const jd = julianDay(dateMs);
  const gst = greenwichMeanSiderealTime(jd);
  const { alpha, delta } = sunEquatorialPosition(dateMs);
  let lng = alpha - gst * 15;
  lng = ((((lng + 180) % 360) + 360) % 360) - 180;
  return { lat: delta, lng };
}

/** Solar altitude and clockwise-from-north azimuth for a location and instant. */
export function sunPositionAt(
  dateMs: number,
  lat: number,
  lng: number,
): { altitude: number; azimuth: number } {
  const jd = julianDay(dateMs);
  const gst = greenwichMeanSiderealTime(jd);
  const { alpha, delta } = sunEquatorialPosition(dateMs);
  let ha = gst * 15 + lng - alpha;
  ha = ((((ha + 180) % 360) + 360) % 360) - 180;
  const haR = ha * D2R;
  const latR = lat * D2R;
  const decR = delta * D2R;
  const sinAltitude =
    Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(haR);
  const altitude = Math.asin(Math.min(1, Math.max(-1, sinAltitude))) * R2D;
  const azimuth =
    (Math.atan2(Math.sin(haR), Math.cos(haR) * Math.sin(latR) - Math.tan(decR) * Math.cos(latR)) *
      R2D +
      180) %
    360;
  return { altitude, azimuth };
}
