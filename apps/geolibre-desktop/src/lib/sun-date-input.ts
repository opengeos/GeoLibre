/**
 * Value helpers for the Sun panel's native `<input type="date">` and
 * `<input type="time">` fields, kept free of React so they can be unit tested.
 */

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Format epoch ms as date/time input values in device local time.
 *
 * The year is zero-padded to four digits: `<input type="date">` only accepts
 * `yyyy-mm-dd`, so an unpadded `2-12-21` (year 2) would be rejected as an
 * invalid value and blank the field.
 */
export function localDateParts(dateMs: number): { date: string; time: string } {
  const d = new Date(dateMs);
  return {
    date: `${String(d.getFullYear()).padStart(4, "0")}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  };
}

/** Parse local `yyyy-mm-dd` + `hh:mm` input values to epoch ms, or `null`. */
export function fromLocalDateTimeParts(date: string, time: string): number | null {
  const ms = new Date(`${date}T${time}`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whether a date input value is complete enough to commit to the simulation.
 *
 * While the user types a year digit by digit, the browser reports every
 * intermediate value (`0002-…`, `0020-…`, `0202-…`) as a valid date. Committing
 * those would jump the simulation to year 2 and re-render mid-typing, so only a
 * four-digit year (1000 or later) counts as a finished entry.
 */
export function isCompleteDateInput(value: string): boolean {
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(value);
  return match !== null && Number(match[1]) >= 1000;
}
