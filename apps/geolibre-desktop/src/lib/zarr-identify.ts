import type { GeoLibreLayer } from "@geolibre/core";
import {
  getTemporalLayerAdapter,
  isSelectorTimeBinding,
  queryZarrLayer,
  toEpochMsAxis,
  zarrPointValue,
} from "@geolibre/plugins";

/** Localized labels for the rows {@link readZarrIdentifyRows} returns. */
export interface ZarrIdentifyLabels {
  /** Shown instead of a value for a fill-value cell (e.g. land in an ocean grid). */
  nodata: string;
  /** Label for the clicked location row, e.g. "lon, lat". */
  coordinates: string;
}

/**
 * Formats a cube value for display: six significant digits for ordinary
 * magnitudes, exponent form for very large or very small ones.
 *
 * Six significant digits is what a float32 store actually carries, so a stored
 * `26.54` reads as `26.54` rather than its float32 expansion `26.539999`.
 *
 * @param value - The value.
 * @returns Display text.
 */
export function formatZarrValue(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude >= 1e6 || magnitude < 1e-3)) return value.toExponential(3);
  return Number(value.toPrecision(6)).toString();
}

/**
 * The date of the slice a time-bound Zarr layer is showing, as `YYYY-MM-DD`
 * (or a full ISO time when the slice is not at midnight UTC).
 *
 * @param layer - The Zarr layer.
 * @returns The dimension name and date, or null when the layer is not bound to
 *   the Time Slider or its axis is not available.
 */
export function zarrSliceDate(layer: GeoLibreLayer): { dimension: string; date: string } | null {
  const binding = layer.metadata.timeBinding;
  if (!isSelectorTimeBinding(binding)) return null;
  const adapter = getTemporalLayerAdapter(layer.id);
  const axis = toEpochMsAxis(adapter?.getTimeValues());
  if (!axis) return null;
  const selector = layer.source.selector as Record<string, unknown> | undefined;
  const index = selector?.[binding.dimension];
  if (typeof index !== "number" || !Number.isFinite(axis[index])) return null;
  const iso = new Date(axis[index]).toISOString();
  return {
    dimension: binding.dimension,
    date: iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso,
  };
}

/**
 * Reads the value of a Zarr layer at a clicked location, for the slice on screen,
 * as Identify popup rows: the variable's value, the slice's date when the layer
 * is stepped by the Time Slider, and the clicked location.
 *
 * @param layer - The Zarr layer.
 * @param lngLat - The clicked location, `[lng, lat]` in WGS84.
 * @param labels - Localized row labels.
 * @param signal - Aborts the read.
 * @returns The rows, or null when the click is outside the grid or the layer is
 *   not live.
 */
export async function readZarrIdentifyRows(
  layer: GeoLibreLayer,
  lngLat: [number, number],
  labels: ZarrIdentifyLabels,
  signal?: AbortSignal,
): Promise<Array<[string, string]> | null> {
  const variable = typeof layer.source.variable === "string" ? layer.source.variable : undefined;
  const result = await queryZarrLayer(layer.id, { type: "Point", coordinates: lngLat }, undefined, {
    signal,
    includeSpatialCoordinates: false,
  });
  const value = zarrPointValue(result as Record<string, unknown> | null, variable);
  if (value === undefined) return null;
  const rows: Array<[string, string]> = [
    [variable ?? layer.name, value === null ? labels.nodata : formatZarrValue(value)],
  ];
  const slice = zarrSliceDate(layer);
  if (slice) rows.push([slice.dimension, slice.date]);
  rows.push([labels.coordinates, `${lngLat[0].toFixed(4)}, ${lngLat[1].toFixed(4)}`]);
  return rows;
}
