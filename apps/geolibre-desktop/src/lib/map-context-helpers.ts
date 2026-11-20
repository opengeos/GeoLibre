import { FEET_PER_METER, METERS_PER_MILE } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import type { TFunction } from "i18next";

/** Decimal places used when formatting and copying map context-menu coordinates. */
export const COORD_PRECISION = 6;

/** Format a clicked point as "lat, lng" to mirror the Google Maps convention. */
export function formatContextCoords(lat: number, lng: number): string {
  return `${lat.toFixed(COORD_PRECISION)}, ${lng.toFixed(COORD_PRECISION)}`;
}

/** Copy plain text to the clipboard with a transient textarea fallback. */
export async function copyContextText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

/** Viewshed preset radii in meters offered in the map context menu. */
export const VIEWSHED_RADII_METERS = [2000, 5000, 15000] as const;

/** Format a viewshed radius using the active scale bar unit system. */
export function formatContextViewshedRadius(
  meters: number,
  scaleUnit: string,
  language: string,
  t: TFunction,
): string {
  const imperial = scaleUnit === "imperial";
  const perUnit = imperial ? METERS_PER_MILE : 1000;
  const large = meters >= perUnit;
  const value = large ? meters / perUnit : imperial ? meters * FEET_PER_METER : meters;
  const formatted = new Intl.NumberFormat(language, {
    maximumFractionDigits: large ? 1 : 0,
  }).format(value);
  const unit = large
    ? imperial
      ? t("quickAnalysis.unit.miles")
      : t("quickAnalysis.unit.kilometers")
    : imperial
      ? t("quickAnalysis.unit.feet")
      : t("quickAnalysis.unit.meters");
  return `${formatted} ${unit}`;
}

/** Read the camera zoom only while the engine still owns a render surface. */
export function liveContextZoom(engine: MapEngine | null | undefined): number | undefined {
  return engine?.getRenderSurface() ? engine.readView().zoom : undefined;
}
