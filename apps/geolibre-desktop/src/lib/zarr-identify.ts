import { wrapLongitude, type GeoLibreLayer } from "@geolibre/core";
import {
  getTemporalLayerAdapter,
  isSelectorTimeBinding,
  toEpochMsAxis,
} from "@geolibre/plugins/temporal-layers";
import { queryZarrLayer } from "@geolibre/plugins/maplibre-components";
import { zarrPointValue } from "@geolibre/plugins/zarr-time-axis";

/** Localized labels for the rows {@link readZarrIdentifyRows} returns. */
export interface ZarrIdentifyLabels {
  /** Shown instead of a value for a fill-value cell (e.g. land in an ocean grid). */
  nodata: string;
  /** Label for the clicked location row, e.g. "lon, lat". */
  coordinates: string;
}

/**
 * Formats a cube value for display: six significant digits, in exponent form
 * for very large or very small magnitudes.
 *
 * Six significant digits is what a float32 store actually carries, so a stored
 * `26.54` reads as `26.54` rather than its float32 expansion `26.539999`.
 *
 * @param value - The value.
 * @returns Display text.
 */
export function formatZarrValue(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude >= 1e6 || magnitude < 1e-3)) return value.toExponential(5);
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
  // A finite but out-of-range coordinate makes an Invalid Date, whose
  // toISOString() throws.
  const date = new Date(axis[index]);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return {
    dimension: binding.dimension,
    date: iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso,
  };
}

/**
 * Whether a point lies inside a layer's `[west, south, east, north]` bounds.
 *
 * @param bounds - The layer's bounds, as stored on its source.
 * @param point - `[lng, lat]` in WGS84.
 * @returns False when the bounds are missing or malformed.
 */
function insideBounds(bounds: unknown, point: [number, number]): boolean {
  if (!Array.isArray(bounds) || bounds.length !== 4) return false;
  const [west, south, east, north] = bounds as number[];
  if (![west, south, east, north].every(Number.isFinite)) return false;
  const [lng, lat] = point;
  if (lat < south || lat > north) return false;
  // Bounds may run past ±180 (e.g. [170, -10, 190, 10]) while the point is
  // wrapped, so test the point and its copies one world away.
  return [lng, lng - 360, lng + 360].some((x) =>
    west <= east ? x >= west && x <= east : x >= west || x <= east,
  );
}

/**
 * Whether a layer's `source.bounds` are in WGS84 degrees. They are recorded in
 * the store's CRS, so a projected store's bounds are in metres and cannot be
 * compared with a clicked `[lng, lat]`.
 *
 * @param layer - The Zarr layer.
 * @returns True when the store declares no CRS or a geographic WGS84 one.
 */
function hasGeographicBounds(layer: GeoLibreLayer): boolean {
  const crs = typeof layer.source.crs === "string" ? layer.source.crs.toUpperCase() : "";
  if (layer.source.proj4) return false;
  return crs === "" || crs === "EPSG:4326" || crs === "OGC:CRS84";
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
  // A click on a repeated world copy reports a longitude beyond ±180, which the
  // store's grid does not cover.
  const point: [number, number] = [wrapLongitude(lngLat[0]), lngLat[1]];
  const result = await queryZarrLayer(layer.id, { type: "Point", coordinates: point }, undefined, {
    signal,
    includeSpatialCoordinates: false,
  });
  let value = zarrPointValue(result as Record<string, unknown> | null, variable);
  // The renderer drops a fill-value sample, so a covered no-data cell (land in
  // an ocean grid) comes back as empty as a click off the grid. Inside the
  // layer's bounds it is no data; outside, Identify stays silent.
  if (value === undefined) {
    if (!result || !hasGeographicBounds(layer) || !insideBounds(layer.source.bounds, point)) {
      return null;
    }
    value = null;
  }
  const rows: Array<[string, string]> = [
    [variable ?? layer.name, value === null ? labels.nodata : formatZarrValue(value)],
  ];
  const slice = zarrSliceDate(layer);
  if (slice) rows.push([slice.dimension, slice.date]);
  rows.push([labels.coordinates, `${point[0].toFixed(4)}, ${point[1].toFixed(4)}`]);
  return rows;
}
