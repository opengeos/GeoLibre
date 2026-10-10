/**
 * Data for the along-track profile of an ICESat-2 / GEDI footprint layer:
 * distance along the track (x) against elevation or any numeric field (y), one
 * beam at a time, so ground and canopy read as two lines along the orbit.
 *
 * Footprint layers come from Add Data → ICESat-2 / GEDI or the Python
 * `Map.add_icesat2` / `add_gedi`; both tag the layer with
 * `metadata.sourceKind = "spaceborne-lidar"` and give every point `beam`,
 * `beam_type`, `time` and `distance_km`.
 */

import type { GeoLibreLayer } from "@geolibre/core";
import type { Feature, Geometry } from "geojson";

/** `metadata.sourceKind` of a footprint layer. */
export const SPACEBORNE_LIDAR_SOURCE_KIND = "spaceborne-lidar";

/** Properties every footprint carries; never offered as a plotted field. */
const BASE_PROPERTIES = new Set(["beam", "beam_type", "time", "distance_km"]);
const PRODUCT_PREFIX = /^(ATL06|ATL08|GEDI_L2A|GEDI_L2B|GEDI_L4A)\b/;

/** Label keys under `alongTrackProfile.series`. */
export type ProfileSeriesLabelKey = "ground" | "canopyTop" | "surfaceHeight";
/** Label keys under `alongTrackProfile.preset`. */
export type ProfilePresetLabelKey = "groundCanopy" | "surface";

/** One line on the chart: a label and how to read its value from a footprint. */
export interface ProfileSeriesDef {
  key: string;
  /** i18n key under `alongTrackProfile.series`, or null to show `key` as is. */
  labelKey: ProfileSeriesLabelKey | null;
  value: (properties: Record<string, unknown>) => number | null;
}

/** A named set of series, e.g. ground and canopy top. */
export interface ProfilePreset {
  id: string;
  /** i18n key under `alongTrackProfile.preset`. */
  labelKey: ProfilePresetLabelKey;
  series: ProfileSeriesDef[];
}

/** One plotted footprint. */
export interface ProfilePoint {
  distance: number;
  /** One value per series, null where the footprint has none. */
  values: (number | null)[];
  /** The store feature id, for selecting the footprint on the map. */
  featureId: string;
  coordinates: [number, number];
}

/** A beam present in the layer. */
export interface ProfileBeam {
  name: string;
  type: string | null;
  count: number;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function features(layer: GeoLibreLayer): Feature<Geometry | null>[] {
  return (layer.geojson?.features ?? []) as Feature<Geometry | null>[];
}

/**
 * Whether a layer holds ICESat-2 / GEDI footprints the profile can chart.
 *
 * @param layer A store layer.
 * @returns True for a tagged footprint layer, or an untagged GeoJSON layer
 *   whose points carry `beam` and `distance_km`.
 */
export function isSpaceborneLidarLayer(layer: GeoLibreLayer): boolean {
  if (
    (layer.metadata as { sourceKind?: unknown } | undefined)?.sourceKind ===
    SPACEBORNE_LIDAR_SOURCE_KIND
  ) {
    return true;
  }
  const first = features(layer)[0];
  const props = first?.properties as Record<string, unknown> | null | undefined;
  return (
    first?.geometry?.type === "Point" &&
    typeof props?.beam === "string" &&
    typeof props?.distance_km === "number"
  );
}

/**
 * The product a footprint layer came from.
 *
 * @param layer A footprint layer.
 * @returns The product id from metadata or the default layer name, or null.
 */
export function spaceborneLidarProduct(layer: GeoLibreLayer): string | null {
  const product = (layer.metadata as { product?: unknown } | undefined)?.product;
  if (typeof product === "string") return product;
  return PRODUCT_PREFIX.exec(layer.name)?.[1] ?? null;
}

/**
 * The beams in a footprint layer, in name order.
 *
 * @param layer A footprint layer.
 * @returns Each beam with its type and footprint count.
 */
export function profileBeams(layer: GeoLibreLayer): ProfileBeam[] {
  const beams = new Map<string, ProfileBeam>();
  for (const feature of features(layer)) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    if (typeof props.beam !== "string") continue;
    const entry = beams.get(props.beam);
    if (entry) entry.count += 1;
    else {
      beams.set(props.beam, {
        name: props.beam,
        type: typeof props.beam_type === "string" ? props.beam_type : null,
        count: 1,
      });
    }
  }
  return [...beams.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The numeric fields a user can plot, in first-seen order.
 *
 * @param layer A footprint layer.
 * @returns Property names with at least one finite number.
 */
export function profileFields(layer: GeoLibreLayer): string[] {
  const seen = new Set<string>();
  const numeric: string[] = [];
  for (const feature of features(layer)) {
    for (const [key, value] of Object.entries(feature.properties ?? {})) {
      if (BASE_PROPERTIES.has(key) || seen.has(key)) continue;
      if (numberOrNull(value) !== null) {
        seen.add(key);
        numeric.push(key);
      }
    }
  }
  return numeric;
}

const field =
  (name: string) =>
  (properties: Record<string, unknown>): number | null =>
    numberOrNull(properties[name]);

const sum =
  (base: string, height: string) =>
  (properties: Record<string, unknown>): number | null => {
    const ground = numberOrNull(properties[base]);
    const above = numberOrNull(properties[height]);
    return ground === null || above === null ? null : ground + above;
  };

/**
 * The preset views for a product, given the fields the layer actually has:
 * ground with canopy top (ICESat-2 ATL08, GEDI L2A / L2B) or the surface
 * height (ATL06), so the chart opens on the profile people expect.
 *
 * @param product The product id, or null.
 * @param fields The layer's numeric fields.
 * @returns Presets whose fields are all present (possibly none).
 */
export function profilePresets(product: string | null, fields: string[]): ProfilePreset[] {
  const has = (...names: string[]) => names.every((name) => fields.includes(name));
  const presets: ProfilePreset[] = [];
  const groundAndCanopy = (ground: string, canopy: string): ProfilePreset => ({
    id: "ground-canopy",
    labelKey: "groundCanopy",
    series: [
      { key: ground, labelKey: "ground", value: field(ground) },
      { key: `${ground}+${canopy}`, labelKey: "canopyTop", value: sum(ground, canopy) },
    ],
  });
  if (product === "ATL08" && has("h_te_best_fit", "h_canopy")) {
    presets.push(groundAndCanopy("h_te_best_fit", "h_canopy"));
  } else if (product === "GEDI_L2A" && has("elev_lowestmode", "rh98")) {
    presets.push(groundAndCanopy("elev_lowestmode", "rh98"));
  } else if (product === "GEDI_L2B" && has("elev_lowestmode", "rh100")) {
    presets.push(groundAndCanopy("elev_lowestmode", "rh100"));
  } else if (product === "ATL06" && has("h_li")) {
    presets.push({
      id: "surface",
      labelKey: "surface",
      series: [{ key: "h_li", labelKey: "surfaceHeight", value: field("h_li") }],
    });
  }
  return presets;
}

/**
 * A series definition that plots one property as is.
 *
 * @param name The property name.
 * @returns The series definition.
 */
export function fieldSeries(name: string): ProfileSeriesDef {
  return { key: name, labelKey: null, value: field(name) };
}

/**
 * The plotted points of one beam, sorted by along-track distance.
 *
 * Store feature ids follow the GeoJSON layer convention: the feature's own
 * `id`, else its index in the collection.
 *
 * @param layer A footprint layer.
 * @param beam The beam to plot.
 * @param series The lines to plot.
 * @returns Points with at least one value.
 */
export function buildProfilePoints(
  layer: GeoLibreLayer,
  beam: string,
  series: ProfileSeriesDef[],
): ProfilePoint[] {
  const points: ProfilePoint[] = [];
  features(layer).forEach((feature, index) => {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    if (props.beam !== beam || feature.geometry?.type !== "Point") return;
    const distance = numberOrNull(props.distance_km);
    if (distance === null) return;
    const values = series.map((def) => def.value(props));
    if (values.every((value) => value === null)) return;
    const [lng, lat] = feature.geometry.coordinates;
    points.push({
      distance,
      values,
      featureId: String(feature.id ?? index),
      coordinates: [lng, lat],
    });
  });
  points.sort((a, b) => a.distance - b.distance);
  return points;
}

/**
 * The point nearest an along-track distance (binary search; points sorted).
 *
 * @param points Points sorted by distance.
 * @param distance The distance to look up, in km.
 * @returns The index of the nearest point, or -1 when there are none.
 */
export function nearestProfileIndex(points: ProfilePoint[], distance: number): number {
  if (points.length === 0) return -1;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].distance < distance) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && distance - points[lo - 1].distance < points[lo].distance - distance) return lo - 1;
  return lo;
}

/**
 * An SVG path through a series, broken where a value is missing or where
 * footprints are further apart than `maxGapKm` (a cloud gap, a dropped orbit
 * segment), so the line never bridges data that is not there.
 *
 * @param points Points sorted by distance.
 * @param seriesIndex Which value to draw.
 * @param x Maps a distance to an x pixel.
 * @param y Maps a value to a y pixel.
 * @param maxGapKm The largest step drawn as a connected line.
 * @returns The `d` attribute.
 */
export function profilePath(
  points: ProfilePoint[],
  seriesIndex: number,
  x: (distance: number) => number,
  y: (value: number) => number,
  maxGapKm: number,
): string {
  let path = "";
  let previous: ProfilePoint | null = null;
  for (const point of points) {
    const value = point.values[seriesIndex];
    if (value === null) {
      previous = null;
      continue;
    }
    const connect = previous !== null && point.distance - previous.distance <= maxGapKm;
    path += `${connect ? "L" : "M"}${x(point.distance).toFixed(1)} ${y(value).toFixed(1)}`;
    previous = point;
  }
  return path;
}

/**
 * The largest along-track step still drawn as a line: a few times the typical
 * spacing (ATL08 segments are 100 m, GEDI shots 60 m), so real gaps break it.
 *
 * @param points Points sorted by distance.
 * @returns The gap threshold in km.
 */
export function profileGapThreshold(points: ProfilePoint[]): number {
  if (points.length < 3) return Number.POSITIVE_INFINITY;
  const steps: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const step = points[i].distance - points[i - 1].distance;
    if (step > 0) steps.push(step);
  }
  if (steps.length === 0) return Number.POSITIVE_INFINITY;
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)] * 5;
}

/**
 * The plotted profile as CSV: distance, then one column per series.
 *
 * @param points The plotted points.
 * @param labels One column header per series.
 * @returns CSV text.
 */
export function profileCsv(points: ProfilePoint[], labels: string[]): string {
  const escape = (text: string) => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const rows = [["distance_km", "longitude", "latitude", ...labels].map(escape).join(",")];
  for (const point of points) {
    rows.push(
      [
        point.distance,
        point.coordinates[0],
        point.coordinates[1],
        ...point.values.map((value) => (value === null ? "" : value)),
      ].join(","),
    );
  }
  return `${rows.join("\n")}\n`;
}
