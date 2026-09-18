import { formatPixelValue } from "@geolibre/core";
import type { PixelReading } from "maplibre-gl-raster";

export interface RasterIdentifyLabels {
  band: (index: number) => string;
  nodata: string;
  coordinates: string;
  row: string;
  column: string;
}

/**
 * Collect label/value rows into popup properties without losing collisions.
 *
 * A record cannot hold two rows under one key, and the labels here are not
 * guaranteed unique: two bands can carry the same `name`, and a band or a
 * NetCDF variable can be named exactly like the localized coordinate or cell
 * row. Colliding labels are suffixed rather than overwritten so every value
 * still reaches the popup.
 *
 * @param rows - Label/value pairs in display order.
 * @returns Properties keyed by unique display labels, in the same order.
 */
export function rasterIdentifyProperties(
  rows: Iterable<readonly [string, unknown]>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [label, value] of rows) {
    let key = label;
    for (let suffix = 2; Object.hasOwn(properties, key); suffix += 1) {
      key = `${label} (${suffix})`;
    }
    properties[key] = value;
  }
  return properties;
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
  const rows: Array<[string, unknown]> = reading.bands.map((band) => {
    const label = band.name ?? labels.band(band.index);
    const value = formatPixelValue(band.value);
    return [label, band.isNodata ? `${value} (${labels.nodata})` : value];
  });
  rows.push([
    labels.coordinates,
    `${reading.lngLat[0].toFixed(5)}, ${reading.lngLat[1].toFixed(5)}`,
  ]);
  rows.push([labels.row, reading.row]);
  rows.push([labels.column, reading.col]);
  return rasterIdentifyProperties(rows);
}
