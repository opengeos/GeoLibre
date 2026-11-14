import { formatPixelValue } from "@geolibre/core";
import type { PlanetaryComputerPixelReading } from "@geolibre/plugins";
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

/** Localized labels for a Planetary Computer pixel reading. */
export interface PlanetaryComputerIdentifyLabels {
  item: string;
  nodata: string;
  coordinates: string;
  /** The clicked `[lng, lat]`, echoed as the last row. */
  lngLat: [number, number];
}

/**
 * Convert a Planetary Computer pixel reading into rows for an Identify popup.
 *
 * The band names are the Data API's own: `<asset>_b<N>` for an asset band, or
 * the band-math expression for a computed index such as NDVI.
 *
 * @param reading - Band values and the STAC item they were read from.
 * @param labels - Localized labels for the popup rows.
 * @returns Ordered property rows for the identified pixel.
 */
export function planetaryComputerIdentifyProperties(
  reading: PlanetaryComputerPixelReading,
  labels: PlanetaryComputerIdentifyLabels,
): Record<string, unknown> {
  const rows: Array<[string, unknown]> = reading.values.map((band) => [
    band.name,
    band.value === null ? labels.nodata : formatPixelValue(band.value),
  ]);
  if (reading.itemId) rows.push([labels.item, reading.itemId]);
  rows.push([labels.coordinates, `${labels.lngLat[0].toFixed(5)}, ${labels.lngLat[1].toFixed(5)}`]);
  return rasterIdentifyProperties(rows);
}

/**
 * Wrap a longitude into the geographic range.
 *
 * @param lng - A longitude, possibly from a repeated world copy (e.g. 181).
 * @returns The equivalent longitude in [-180, 180).
 */
export function wrapLongitude(lng: number): number {
  // Leave an in-range value untouched: the arithmetic below would nudge it by
  // a floating-point ulp, and the popup echoes the coordinate back.
  if (lng >= -180 && lng < 180) return lng;
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}
