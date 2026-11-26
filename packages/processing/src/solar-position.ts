/**
 * Sun position and clear-sky beam irradiance (issue #3530).
 *
 * The position follows the NOAA Solar Calculator (Meeus, "Astronomical
 * Algorithms", low-precision series): good to a few hundredths of a degree between 1800
 * and 2100, far finer than a building shadow raster can resolve. The beam
 * irradiance is the Meinel clear-sky model with the Kasten-Young air mass,
 * the usual first-order estimate when no measured or modelled irradiance is
 * at hand.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Where the sun is, seen from a point on the ground. */
export interface SunPosition {
  /** Degrees clockwise from true north, 0-360. */
  azimuth: number;
  /** Apparent elevation above the horizon in degrees, refraction included. */
  elevation: number;
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

/**
 * The sun's position for an instant and a place.
 *
 * @param ms - The instant, as milliseconds since the Unix epoch (UTC).
 * @param lat - Latitude in degrees, north positive.
 * @param lon - Longitude in degrees, east positive.
 * @returns Azimuth, apparent elevation, declination and equation of time.
 */
export function sunPosition(ms: number, lat: number, lon: number): SunPosition {
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
  const minutesUtc = (((ms % 86_400_000) + 86_400_000) % 86_400_000) / 60_000;
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
    declination,
    equationOfTime,
  };
}

/** Solar constant used by the Meinel model, in W/m². */
export const SOLAR_CONSTANT = 1353;

/**
 * Clear-sky direct normal irradiance for a sun elevation (Meinel 1976 with
 * the Kasten-Young 1989 air mass), in W/m²; 0 with the sun down.
 *
 * @param elevation - Apparent sun elevation in degrees.
 * @returns Direct normal irradiance in W/m².
 */
export function clearSkyDni(elevation: number): number {
  if (elevation <= 0) return 0;
  const zenith = 90 - elevation;
  const airMass = 1 / (Math.cos(zenith * RAD) + 0.50572 * (96.07995 - zenith) ** -1.6364);
  return SOLAR_CONSTANT * 0.7 ** (airMass ** 0.678);
}

/**
 * Parse a local date and time with a UTC offset into a UTC instant.
 *
 * @param date - `YYYY-MM-DD`.
 * @param time - `HH:MM` (24 h), local time.
 * @param utcOffsetHours - Local time minus UTC, in hours (e.g. -4 for EDT).
 * @returns Milliseconds since the Unix epoch.
 * @throws When the date or time is malformed.
 */
export function localTimeToUtc(date: string, time: string, utcOffsetHours: number): number {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!d) throw new Error(`Enter the date as YYYY-MM-DD (got "${date}").`);
  if (!tm) throw new Error(`Enter the time as HH:MM (got "${time}").`);
  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [hour, minute] = [Number(tm[1]), Number(tm[2])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error(`"${date}" is not a calendar date.`);
  }
  if (hour > 23 || minute > 59) throw new Error(`"${time}" is not a time of day.`);
  if (!Number.isFinite(utcOffsetHours) || Math.abs(utcOffsetHours) > 14) {
    throw new Error("The UTC offset must be between -14 and +14 hours.");
  }
  return Date.UTC(year, month - 1, day, hour, minute) - utcOffsetHours * 3_600_000;
}
