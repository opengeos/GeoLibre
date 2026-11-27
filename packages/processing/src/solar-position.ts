/**
 * Sun position and clear-sky beam irradiance (issue #3530).
 *
 * The position itself lives in `@geolibre/core` so the Sun control and the
 * Building shadows tool share one ephemeris (issue #3698); it is re-exported
 * here for the processing code. The beam irradiance is the Meinel clear-sky
 * model with the Kasten-Young air mass, the usual first-order estimate when no
 * measured or modelled irradiance is at hand.
 */

export {
  julianDay,
  solarEphemeris,
  subsolarPoint,
  sunPosition,
  type SolarEphemeris,
  type SunPosition,
} from "@geolibre/core/worker-safe";

const RAD = Math.PI / 180;

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
  // Date.UTC maps years 0-99 to 1900-1999, and the solar series is only
  // valid for 1800-2100 anyway, so reject anything outside that.
  if (year < 1800 || year > 2100) {
    throw new Error(`The year must be between 1800 and 2100 (got ${year}).`);
  }
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
