/**
 * Camera altitude ("Eye alt") for the status bar — issue #1816.
 *
 * MapLibre's `transform.getCameraAltitude()` returns the camera height above
 * sea level in metres, which is exactly what Google Earth Pro's `Eye alt`
 * reports. But it derives that height from the Web-Mercator scale, which is
 * built on Earth's radius — so on a Moon / Mars / Mercury basemap it is wrong by
 * the ratio of that body's circumference to Earth's, the same way MapLibre's
 * built-in ScaleControl is (see `PlanetaryScaleControl`, which fixes the
 * horizontal case).
 *
 * {@link scaleAltitudeToActiveBody} applies the matching correction so the
 * readout is right on every body, using the same active-ellipsoid singleton the
 * scale bar and the measurement tools read.
 */

import { getActiveBodyRadiusRatio } from "./ellipsoids";
import { scaleDenomination } from "./scale-units";
import type { MapScaleUnit } from "./types";

/**
 * Convert a MapLibre camera altitude (computed against Earth's radius) into the
 * active body's true altitude. A no-op on Earth.
 *
 * @param earthAltitudeMeters Altitude in metres as MapLibre reports it
 * @returns Altitude in metres above the active body's datum, or null when the
 *   input is not a usable number (no map, degenerate transform, globe edge case)
 */
export function scaleAltitudeToActiveBody(earthAltitudeMeters: number | null): number | null {
  if (earthAltitudeMeters === null || !Number.isFinite(earthAltitudeMeters)) return null;
  return earthAltitudeMeters * getActiveBodyRadiusRatio();
}

/**
 * Format a camera altitude for the status bar.
 *
 * Altitude spans metres (standing on a ridge) to tens of thousands of
 * kilometres (whole-globe view), so it borrows the scale bar's denomination
 * switching rather than printing "12,742,000 m". Metric crosses to km past
 * 1 km, imperial to miles past a mile, and nautical stays in nautical miles —
 * the same thresholds {@link scaleDenomination} gives the scale bar, so the two
 * always agree about which unit this view is being described in.
 */
export function formatCameraAltitude(meters: number, unit: MapScaleUnit): string {
  const { metersPerUnit, label } = scaleDenomination(Math.abs(meters), unit);
  const value = meters / metersPerUnit;
  // Sub-unit and single-digit values need a decimal to say anything; past that
  // the extra digit is noise on a number that moves with every zoom step.
  const digits = Math.abs(value) < 10 ? 1 : 0;
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${label}`;
}
