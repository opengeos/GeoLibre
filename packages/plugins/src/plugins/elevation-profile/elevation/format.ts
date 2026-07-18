/**
 * Distance and elevation formatting for metric and imperial unit systems.
 *
 * Pure string formatting with no DOM dependencies so the output can be asserted
 * directly in unit tests.
 */

/** Selectable measurement system for the profile readouts. */
export type UnitSystem = "metric" | "imperial";

const FEET_PER_METER = 3.28084;
const MILES_PER_METER = 0.000621371;
const KM_PER_METER = 0.001;

/** Ordered unit systems, for cycling a toggle button. */
export const UNIT_SYSTEMS: readonly UnitSystem[] = ["metric", "imperial"];

/** Short label for a unit system's distance/elevation units. */
export function unitSystemLabel(system: UnitSystem): string {
  return system === "imperial" ? "ft / mi" : "m / km";
}

/**
 * Format an elevation value for display.
 *
 * @param meters - The elevation in meters
 * @param system - The active unit system
 * @returns A rounded elevation with its unit, e.g. `"742 m"` or `"2434 ft"`
 */
export function formatElevation(meters: number, system: UnitSystem): string {
  if (system === "imperial") {
    return `${Math.round(meters * FEET_PER_METER)} ft`;
  }
  return `${Math.round(meters)} m`;
}

/**
 * Format a distance value for display, switching to a larger unit when helpful.
 *
 * Metric distances under 1 km render in meters; imperial distances under about a
 * tenth of a mile render in feet.
 *
 * @param meters - The distance in meters
 * @param system - The active unit system
 * @returns A formatted distance with its unit, e.g. `"850 m"`, `"1.50 km"`, or `"2.30 mi"`
 */
export function formatDistance(meters: number, system: UnitSystem): string {
  if (system === "imperial") {
    const miles = meters * MILES_PER_METER;
    if (miles < 0.1) {
      return `${Math.round(meters * FEET_PER_METER)} ft`;
    }
    return `${miles.toFixed(2)} mi`;
  }
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters * KM_PER_METER).toFixed(2)} km`;
}
