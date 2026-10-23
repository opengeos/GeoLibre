/**
 * Distance, duration and clock formatting for the navigation tool, through
 * `Intl` so units and numbers follow the UI language ("1,2 km", "12 min").
 */

const METERS_PER_MILE = 1609.344;
const FEET_PER_METER = 3.28084;

function unit(locale: string, name: string, value: number, digits: number): string {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: name,
    unitDisplay: "short",
    maximumFractionDigits: digits,
  }).format(value);
}

/**
 * A distance rounded the way a navigation banner reads it: to 10 m close to a
 * turn, 50 m further out, then tenths of a kilometre (or feet, then tenths of a
 * mile).
 *
 * @param meters - The distance in metres.
 * @param imperial - Use feet and miles.
 * @param locale - The UI language.
 * @returns The formatted distance.
 */
export function formatNavDistance(meters: number, imperial: boolean, locale: string): string {
  const m = Math.max(0, meters);
  if (imperial) {
    const miles = m / METERS_PER_MILE;
    if (miles >= 10) return unit(locale, "mile", Math.round(miles), 0);
    if (miles >= 0.1) return unit(locale, "mile", Math.round(miles * 10) / 10, 1);
    const feet = m * FEET_PER_METER;
    return unit(
      locale,
      "foot",
      feet < 100 ? Math.round(feet / 10) * 10 : Math.round(feet / 50) * 50,
      0,
    );
  }
  if (m >= 10_000) return unit(locale, "kilometer", Math.round(m / 1000), 0);
  if (m >= 1000) return unit(locale, "kilometer", Math.round(m / 100) / 10, 1);
  if (m >= 100) return unit(locale, "meter", Math.round(m / 50) * 50, 0);
  return unit(locale, "meter", Math.round(m / 10) * 10, 0);
}

/**
 * A travel time: minutes under an hour, hours and minutes above.
 *
 * @param seconds - The duration in seconds.
 * @param locale - The UI language.
 * @returns The formatted duration, e.g. "12 min" or "1 hr 5 min".
 */
export function formatNavDuration(seconds: number, locale: string): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  if (minutes < 60) return unit(locale, "minute", Math.max(minutes, seconds > 0 ? 1 : 0), 0);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = unit(locale, "hour", hours, 0);
  return rest === 0 ? h : `${h} ${unit(locale, "minute", rest, 0)}`;
}

/**
 * The clock time of arrival.
 *
 * @param secondsFromNow - Travel time left.
 * @param locale - The UI language.
 * @param now - The current time in milliseconds (for tests).
 * @returns The arrival time, e.g. "14:35" or "2:35 PM".
 */
export function formatArrivalTime(
  secondsFromNow: number,
  locale: string,
  now = Date.now(),
): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(
    new Date(now + secondsFromNow * 1000),
  );
}
