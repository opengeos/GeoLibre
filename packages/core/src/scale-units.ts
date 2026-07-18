/**
 * Shared scale-bar unit maths.
 *
 * The on-screen scale bar (`PlanetaryScaleControl` in `@geolibre/map`) and the
 * Print Layout scale bar (`apps/geolibre-desktop/src/lib/print-layout.ts`) both
 * need to pick a "nice" round distance in the user's chosen unit system
 * (metric / imperial / nautical). Keeping that logic in one place here means the
 * two bars round a given ground span to the same value and share the same unit
 * constants, so a change to one can never silently diverge from the other.
 */

import type { MapScaleUnit } from "./types";

/** Conversion constants shared by every scale-bar denomination. */
export const FEET_PER_METER = 3.2808398950131235; // 1 / 0.3048
export const METERS_PER_FOOT = 0.3048;
export const FEET_PER_MILE = 5280;
export const METERS_PER_MILE = 1609.344; // 5280 ft
export const METERS_PER_NAUTICAL_MILE = 1852;

/**
 * The largest `1 / 2 / 3 / 5 / 10 × 10ⁿ` number that does not exceed `num`, so
 * the bar lands on a readable round value. Uses log10 for the magnitude (unlike
 * MapLibre's digit-count trick, which returns 1 for any `0 < num < 1` and so
 * rounds *up* — producing a bar wider than the max width for sub-unit spans).
 * Returns 0 for a non-positive input so callers can clamp or fall back.
 */
export function getRoundNum(num: number): number {
  if (!(num > 0)) return 0;
  const pow10 = Math.pow(10, Math.floor(Math.log10(num)));
  const d = num / pow10;
  const nice = d >= 10 ? 10 : d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1;
  return pow10 * nice;
}

/** Trim trailing-zero noise from a rounded value (e.g. 0.5, 2, 300). */
export function formatRoundNum(value: number): string {
  return Number.parseFloat(value.toPrecision(12)).toString();
}

/**
 * The denomination a scale bar rounds and labels distances with for a ground
 * span of `maxMeters` in the requested unit system: km/m for metric, mi/ft for
 * imperial, and nautical miles for nautical. The unit crosses to the larger
 * denomination once the span exceeds one of it. `metersPerUnit` is the size of
 * one unit of that denomination in metres, so a caller can round the span in
 * unit space and convert the result back to metres (and thus pixels).
 */
export function scaleDenomination(
  maxMeters: number,
  unit: MapScaleUnit,
): { metersPerUnit: number; label: string } {
  if (unit === "imperial") {
    const feet = maxMeters * FEET_PER_METER;
    return feet >= FEET_PER_MILE
      ? { metersPerUnit: METERS_PER_MILE, label: "mi" }
      : { metersPerUnit: METERS_PER_FOOT, label: "ft" };
  }
  if (unit === "nautical") {
    return { metersPerUnit: METERS_PER_NAUTICAL_MILE, label: "nmi" };
  }
  return maxMeters >= 1000
    ? { metersPerUnit: 1000, label: "km" }
    : { metersPerUnit: 1, label: "m" };
}

/**
 * Convert a ground distance in metres into the span (already divided into the
 * bar's denomination) and its label — the shape the on-screen control consumes.
 * Derived from {@link scaleDenomination} so the two never diverge.
 */
export function scaleSpan(maxMeters: number, unit: MapScaleUnit): { span: number; label: string } {
  const { metersPerUnit, label } = scaleDenomination(maxMeters, unit);
  return { span: maxMeters / metersPerUnit, label };
}
