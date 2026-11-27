/**
 * Sun position: the one ephemeris the Sun control and the Building shadows
 * raster tool share (issues #3530, #3698).
 *
 * The position follows the NOAA Solar Calculator (Meeus, "Astronomical
 * Algorithms", low-precision series): good to a few hundredths of a degree
 * between 1800 and 2100, with the equation of time and atmospheric refraction
 * applied. It has no store, DOM or map dependencies, so it is safe to import
 * from a Web Worker through `@geolibre/core/worker-safe`.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Where the sun is, seen from a point on the ground. */
export interface SunPosition {
  /** Degrees clockwise from true north, 0-360. */
  azimuth: number;
  /** Apparent elevation above the horizon in degrees, refraction included. */
  elevation: number;
  /**
   * Geometric elevation in degrees, without refraction. Shadows follow the
   * apparent elevation instead, since that is the direction the light
   * arrives from.
   */
  geometricElevation: number;
  /** Solar declination in degrees. */
  declination: number;
  /** Equation of time in minutes. */
  equationOfTime: number;
}

/**
 * Julian day of a JavaScript time value.
 *
 * @param ms - Milliseconds since the Unix epoch (UTC).
 * @returns The Julian day number, fractional.
 */
export function julianDay(ms: number): number {
  return ms / 86_400_000 + 2_440_587.5;
}

/**
 * Atmospheric refraction to add to a geometric elevation, in degrees (the
 * NOAA calculator's piecewise fit).
 */
function refractionCorrection(elevation: number): number {
  if (elevation > 85) return 0;
  const te = Math.tan(elevation * RAD);
  let arcsec: number;
  if (elevation > 5) arcsec = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elevation > -0.575)
    arcsec =
      1735 + elevation * (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)));
  else arcsec = -20.774 / te;
  return arcsec / 3600;
}

/** The sun's declination and the equation of time for an instant. */
export interface SolarEphemeris {
  /** Solar declination in degrees. */
  declination: number;
  /** Equation of time in minutes (apparent minus mean solar time). */
  equationOfTime: number;
}

/**
 * The sun's declination and the equation of time for an instant, which is
 * all the place-independent part of the position needs.
 *
 * @param ms - The instant, as milliseconds since the Unix epoch (UTC).
 * @returns Declination in degrees and equation of time in minutes.
 */
export function solarEphemeris(ms: number): SolarEphemeris {
  const t = (julianDay(ms) - 2_451_545) / 36_525;
  const l0 = (((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360) + 360) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const declination = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const equationOfTime =
    4 *
    DEG *
    (y * Math.sin(2 * l0 * RAD) -
      2 * e * Math.sin(m * RAD) +
      4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD) -
      0.5 * y * y * Math.sin(4 * l0 * RAD) -
      1.25 * e * e * Math.sin(2 * m * RAD));
  return { declination, equationOfTime };
}

/** Minutes past UTC midnight for a JavaScript time value. */
function minutesOfUtcDay(ms: number): number {
  return (((ms % 86_400_000) + 86_400_000) % 86_400_000) / 60_000;
}

/**
 * The sun's position for an instant and a place.
 *
 * @param ms - The instant, as milliseconds since the Unix epoch (UTC).
 * @param lat - Latitude in degrees, north positive.
 * @param lon - Longitude in degrees, east positive.
 * @returns Azimuth, apparent elevation, declination and equation of time.
 */
export function sunPosition(ms: number, lat: number, lon: number): SunPosition {
  const { declination, equationOfTime } = solarEphemeris(ms);
  const minutesUtc = minutesOfUtcDay(ms);
  const trueSolarMinutes = (((minutesUtc + equationOfTime + 4 * lon) % 1440) + 1440) % 1440;
  const hourAngle = trueSolarMinutes / 4 - 180;
  const latR = lat * RAD;
  const decR = declination * RAD;
  const haR = hourAngle * RAD;
  const cosZenith = Math.min(
    1,
    Math.max(-1, Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(haR)),
  );
  const geometric = 90 - Math.acos(cosZenith) * DEG;
  const azimuth =
    (Math.atan2(Math.sin(haR), Math.cos(haR) * Math.sin(latR) - Math.tan(decR) * Math.cos(latR)) *
      DEG +
      180 +
      360) %
    360;
  return {
    azimuth,
    elevation: geometric + refractionCorrection(geometric),
    geometricElevation: geometric,
    declination,
    equationOfTime,
  };
}

/**
 * The subsolar point: where the sun stands at the zenith (geometric, without
 * refraction). Its latitude is the declination; its longitude is where the
 * true solar time is noon, so it walks about 15 degrees west an hour.
 *
 * @param ms - The instant, as milliseconds since the Unix epoch (UTC).
 * @returns Latitude and longitude in degrees, longitude in [-180, 180).
 */
export function subsolarPoint(ms: number): { lat: number; lng: number } {
  const { declination, equationOfTime } = solarEphemeris(ms);
  // The hour angle in sunPosition is zero where
  // minutesUtc + equationOfTime + 4 * lon = 720 (mod 1440).
  const lng = 180 - (minutesOfUtcDay(ms) + equationOfTime) / 4;
  return { lat: declination, lng: ((((lng + 180) % 360) + 360) % 360) - 180 };
}
