import type { Feature, FeatureCollection, Point } from "geojson";

/** One band's value at a queried COG pixel. */
export interface PixelBandReading {
  /** One-based COG band index. */
  index: number;
  /** Band name from COG metadata, when available. */
  name: string | null;
  /** Raw value before the chart's nodata/non-finite normalization. */
  value: number;
  /** Whether the COG marks this reading as nodata. */
  isNodata: boolean;
}

/** A single timestep's reading for one source. */
export interface PixelSeriesPoint {
  /** ISO date (`YYYY-MM-DD`) of the timeline step. */
  date: string;
  /** Epoch milliseconds of the step, for ordering and the chart x-axis. */
  timestamp: number;
  /** Concrete COG URL the source template resolved to for this date. */
  url: string;
  /** Every band's reading at the clicked pixel; empty represents a gap. */
  bands: PixelBandReading[];
}

/** One source's value-over-time series. */
export interface PixelSeries {
  /** Source id (matches the mirrored store layer id). */
  sourceId: string;
  /** Human-readable source name. */
  sourceName: string;
  /** Ordered timestep points, each carrying all band readings. */
  points: PixelSeriesPoint[];
}

/** A band available to chart, derived from COG metadata. */
export interface BandOption {
  /** One-based band index. */
  index: number;
  /** Band name from COG metadata, when known. */
  name: string | null;
}

/** Result of a pixel time-series query at one clicked location. */
export interface PixelTimeSeriesResult {
  /** The clicked location, `[lng, lat]` in WGS84. */
  lngLat: [number, number];
  /** One series per COG source in the stack. */
  series: PixelSeries[];
  /** Bands seen across the stack (union by index, ascending), for the picker. */
  bands: BandOption[];
  /** The preferred chart band, or null when no bands could be read. */
  defaultBandIndex: number | null;
  /** Number of timeline steps queried per source after downsampling. */
  stepCount: number;
  /** Full timeline step count before downsampling. */
  originalStepCount: number;
  /** True when the timeline had more steps than the query cap. */
  truncated: boolean;
}

/** A query result paired with the display label the UI assigns it. */
export interface LabeledPixelTimeSeries {
  /** Short label for the clicked location (for example, `Point 1`). */
  label: string;
  /** The query result. */
  result: PixelTimeSeriesResult;
}

/** Options for a time-slider pixel-series request. */
export interface PixelTimeSeriesOptions {
  /** Aborts in-flight COG reads. */
  signal?: AbortSignal;
  /** Reports completed and total COG reads. */
  onProgress?: (completed: number, total: number) => void;
  /** Maximum timeline steps to query before downsampling. Defaults to 120. */
  maxSteps?: number;
}

/**
 * Downsamples timeline steps while preserving their endpoints.
 *
 * @param steps - Full ordered timeline steps.
 * @param maxSteps - Maximum steps to retain, coerced to at least one.
 * @returns Retained steps and whether any were omitted.
 */
export function downsampleSteps(
  steps: Date[],
  maxSteps: number,
): { steps: Date[]; truncated: boolean } {
  const cap = Math.max(1, Math.floor(maxSteps));
  if (steps.length <= cap) return { steps: steps.slice(), truncated: false };
  if (cap === 1) return { steps: [steps[0]], truncated: true };
  const kept: Date[] = [];
  for (let i = 0; i < cap; i++) {
    const index = Math.round((i * (steps.length - 1)) / (cap - 1));
    kept.push(steps[index]);
  }
  return { steps: kept, truncated: true };
}

/** Read one chartable band value, turning nodata and non-finite values into gaps. */
export function valueAtBand(point: PixelSeriesPoint, bandIndex: number): number | null {
  const band = point.bands.find((entry) => entry.index === bandIndex);
  if (!band || band.isNodata || !Number.isFinite(band.value)) return null;
  return band.value;
}

/** Union the bands read across results, retaining the first known name per index. */
export function bandOptionsFromResults(results: PixelTimeSeriesResult[]): BandOption[] {
  const byIndex = new Map<number, BandOption>();
  for (const result of results) {
    for (const band of result.bands) {
      const existing = byIndex.get(band.index);
      if (!existing) byIndex.set(band.index, band);
      else if (existing.name == null && band.name != null) byIndex.set(band.index, band);
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/**
 * Flatten labeled pixel-series results into a long-format FeatureCollection for
 * the existing vector exporters.
 */
export function seriesToFeatureCollection(
  items: LabeledPixelTimeSeries[],
): FeatureCollection<Point> {
  const features: Feature<Point>[] = [];
  let id = 0;
  const push = (lng: number, lat: number, properties: Record<string, unknown>) =>
    features.push({
      type: "Feature",
      id: id++,
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties,
    });
  for (const { label, result } of items) {
    const [lng, lat] = result.lngLat;
    for (const series of result.series) {
      for (const point of series.points) {
        const base = { label, lng, lat, date: point.date, source: series.sourceName };
        if (point.bands.length > 0) {
          for (const band of point.bands) {
            push(lng, lat, {
              ...base,
              band: band.index,
              band_name: band.name,
              value: band.isNodata || !Number.isFinite(band.value) ? null : band.value,
              is_nodata: band.isNodata,
            });
          }
        } else {
          push(lng, lat, {
            ...base,
            band: null,
            band_name: null,
            value: null,
            is_nodata: null,
          });
        }
      }
    }
  }
  return { type: "FeatureCollection", features };
}
