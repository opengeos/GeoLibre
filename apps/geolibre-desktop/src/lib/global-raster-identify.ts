import type { PixelReading } from "maplibre-gl-raster";

export interface RasterIdentifyLabels {
  band: (index: number) => string;
  nodata: string;
  coordinates: string;
  row: string;
  column: string;
}

/** Format a decoded raster sample without exposing binary floating-point noise. */
export function formatRasterIdentifyValue(value: number): string {
  if (!Number.isFinite(value) || Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(6)));
}

/**
 * Convert a decoded COG pixel into rows suitable for an Identify popup.
 *
 * @param reading - Pixel coordinates and decoded band values.
 * @param labels - Localized labels for the popup rows.
 * @returns Ordered property rows for the identified pixel.
 */
export function rasterPixelIdentifyProperties(
  reading: PixelReading,
  labels: RasterIdentifyLabels,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const band of reading.bands) {
    const label = band.name ?? labels.band(band.index);
    const value = formatRasterIdentifyValue(band.value);
    properties[label] = band.isNodata ? `${value} (${labels.nodata})` : value;
  }
  properties[labels.coordinates] = `${reading.lngLat[0].toFixed(
    5,
  )}, ${reading.lngLat[1].toFixed(5)}`;
  properties[labels.row] = reading.row;
  properties[labels.column] = reading.col;
  return properties;
}
