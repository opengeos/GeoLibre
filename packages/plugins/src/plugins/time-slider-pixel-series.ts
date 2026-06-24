import {
  type CogSourceSpec,
  generateSteps,
  resolveUrl,
} from "maplibre-gl-time-slider";
import {
  type BandReading,
  loadGeoTIFF,
  type PixelReading,
  readBandNames,
  readPixelValues,
} from "maplibre-gl-raster";
import type { Feature, FeatureCollection, Point } from "geojson";
import { getActiveTimeSliderControl } from "./maplibre-time-slider";

/**
 * Pixel time-series support for the Time Slider's raster stack.
 *
 * A Time Slider COG source is a single template URL (e.g.
 * `https://.../{date:YYYY}.tif`) that resolves to a different Cloud Optimized
 * GeoTIFF per timeline date. Stepping the timeline therefore walks a temporal
 * stack of COGs. This module clicks a single pixel through that stack: for every
 * timeline step it resolves the source URL, HTTP-range-reads just the tile under
 * the click, and records the band value, producing a value-over-time series that
 * the UI charts and can export.
 *
 * It reuses `maplibre-gl-raster`'s `loadGeoTIFF`/`readPixelValues`, the same
 * client-side reader the single-COG Identify tool uses, so no Python sidecar or
 * full-file download is involved.
 */

/** A single timestep's value for one source. */
export interface PixelSeriesPoint {
  /** ISO date (`YYYY-MM-DD`) of the timeline step. */
  date: string;
  /** Epoch milliseconds of the step, for ordering and the chart x-axis. */
  timestamp: number;
  /** Concrete COG URL the source template resolved to for this date. */
  url: string;
  /**
   * Raw band value, or null when the pixel falls outside the image, the COG
   * failed to load, or the value is the source's nodata. Null points render as
   * gaps in the chart.
   */
  value: number | null;
  /** Whether {@link value} was flagged as the source's nodata. */
  isNodata: boolean;
}

/** One source's value-over-time series. */
export interface PixelSeries {
  /** Source id (matches the mirrored store layer id). */
  sourceId: string;
  /** Human-readable source name. */
  sourceName: string;
  /** 1-based band index that was read. */
  bandIndex: number;
  /** Band name from the COG metadata, when known. */
  bandName: string | null;
  /** Ordered timestep points. */
  points: PixelSeriesPoint[];
}

/** Result of a pixel time-series query. */
export interface PixelTimeSeriesResult {
  /** The clicked location, `[lng, lat]` in WGS84. */
  lngLat: [number, number];
  /** One series per COG source in the stack. */
  series: PixelSeries[];
  /** Number of timeline steps queried per source. */
  stepCount: number;
  /** True when the timeline had more steps than the cap and was downsampled. */
  truncated: boolean;
}

/** Options for {@link queryPixelTimeSeries}. */
export interface PixelTimeSeriesOptions {
  /** Aborts in-flight COG reads. */
  signal?: AbortSignal;
  /** Reports progress as `(completed, total)` reads. */
  onProgress?: (completed: number, total: number) => void;
  /** Maximum timeline steps to query before downsampling. Defaults to 120. */
  maxSteps?: number;
}

/** Default cap on timeline steps, balancing detail against many range reads. */
const DEFAULT_MAX_STEPS = 120;
/** Concurrent COG reads. Keeps the stack query responsive without flooding. */
const READ_CONCURRENCY = 6;

/**
 * The COG sources currently configured on the active Time Slider, in dock order.
 *
 * @returns The COG source specs, or an empty array when the dock is closed or
 *   has no COG sources (XYZ/WMS/GeoJSON sources are not pixel-readable here).
 */
export function getTimeSliderCogSources(): CogSourceSpec[] {
  const control = getActiveTimeSliderControl();
  if (!control) return [];
  return control
    .getSources()
    .filter((spec): spec is CogSourceSpec => spec.type === "cog");
}

/**
 * Whether the Time Slider currently exposes a pixel-readable raster stack.
 *
 * @returns True when at least one COG source is configured.
 */
export function hasTimeSliderRasterStack(): boolean {
  return getTimeSliderCogSources().length > 0;
}

/**
 * Downsamples a list of step dates to at most `maxSteps`, keeping the endpoints
 * and spreading the rest evenly so a daily timeline over many years still charts
 * without thousands of range reads.
 *
 * @param steps - The full ordered list of step dates.
 * @param maxSteps - Maximum steps to keep (coerced to >= 1).
 * @returns The kept steps and whether any were dropped.
 */
export function downsampleSteps(
  steps: Date[],
  maxSteps: number,
): { steps: Date[]; truncated: boolean } {
  const cap = Math.max(1, Math.floor(maxSteps));
  if (steps.length <= cap) return { steps, truncated: false };
  // A cap of 1 keeps only the first step; the even-spacing formula below would
  // divide by `cap - 1 === 0` and yield a NaN index (so `steps[NaN]` would be
  // undefined), so handle it explicitly.
  if (cap === 1) return { steps: [steps[0]], truncated: true };
  const kept: Date[] = [];
  // Even spacing across [0, length-1] inclusive of both ends.
  for (let i = 0; i < cap; i++) {
    const index = Math.round((i * (steps.length - 1)) / (cap - 1));
    kept.push(steps[index]);
  }
  return { steps: kept, truncated: true };
}

/**
 * The timeline step dates for the active Time Slider, downsampled to the cap.
 *
 * @param maxSteps - Maximum steps before downsampling.
 * @returns The step dates and whether the timeline was downsampled. Empty when
 *   the dock is closed.
 */
function getTimeSliderSteps(maxSteps: number): {
  steps: Date[];
  truncated: boolean;
} {
  const control = getActiveTimeSliderControl();
  if (!control) return { steps: [], truncated: false };
  const state = control.getState();
  const steps = generateSteps(
    state.startDate,
    state.endDate,
    Math.max(1, state.interval),
    state.granularity,
  );
  return downsampleSteps(steps, maxSteps);
}

/**
 * Picks the band reading to chart for a source: its first configured band index
 * (`bidx`) when set, otherwise the first band.
 *
 * @param reading - The pixel reading for one COG.
 * @param bidx - The source's 1-based band indexes, if any.
 * @returns The chosen band reading, or null when the reading has no bands.
 */
export function pickBand(
  reading: PixelReading,
  bidx: number[] | undefined,
): BandReading | null {
  if (reading.bands.length === 0) return null;
  const wanted = bidx && bidx.length > 0 ? bidx[0] : undefined;
  if (wanted !== undefined) {
    const match = reading.bands.find((band) => band.index === wanted);
    if (match) return match;
  }
  return reading.bands[0];
}

/**
 * Runs `tasks` with a bounded number in flight at once, preserving result order.
 *
 * @param tasks - Thunks producing each result.
 * @param limit - Maximum concurrent tasks.
 * @returns The results in the same order as `tasks`.
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * Queries a single pixel's value across the Time Slider's raster stack and
 * timeline, returning one value-over-time series per COG source.
 *
 * For every (source, step) pair the source URL template is resolved to the
 * step's date, the COG is opened, and the band value at the click is read via an
 * HTTP range read. Reads share a per-URL cache so a static (non-templated)
 * source is fetched once. Failed reads become null points (charted as gaps)
 * rather than aborting the whole query.
 *
 * @param lngLat - The clicked location, `[lng, lat]` in WGS84.
 * @param options - Progress, abort, and step-cap controls.
 * @returns The assembled series.
 * @throws When the Time Slider has no COG sources or no timeline steps.
 */
export async function queryPixelTimeSeries(
  lngLat: [number, number],
  options: PixelTimeSeriesOptions = {},
): Promise<PixelTimeSeriesResult> {
  const { signal, onProgress, maxSteps = DEFAULT_MAX_STEPS } = options;
  const sources = getTimeSliderCogSources();
  if (sources.length === 0) {
    throw new Error("The Time Slider has no COG sources to query.");
  }
  const { steps, truncated } = getTimeSliderSteps(maxSteps);
  if (steps.length === 0) {
    throw new Error("The Time Slider timeline has no steps to query.");
  }

  // Dedupe COG opens and pixel reads by resolved URL: lngLat is constant for the
  // whole query, so a repeated URL (e.g. a static source) yields the same value.
  const readingCache = new Map<string, Promise<PixelReading | null>>();
  const readAt = (url: string): Promise<PixelReading | null> => {
    const cached = readingCache.get(url);
    if (cached) return cached;
    const promise = (async () => {
      const tiff = await loadGeoTIFF(url);
      return readPixelValues(tiff, lngLat, {
        signal,
        bandNames: readBandNames(tiff),
      });
    })();
    readingCache.set(url, promise);
    return promise;
  };

  const total = sources.length * steps.length;
  let completed = 0;

  const series = await Promise.all(
    sources.map(async (source) => {
      // Each task returns its point plus the band it read; the band metadata is
      // then taken from the first successful step (by step order) rather than
      // mutating a shared closure under concurrency, where last-writer-wins
      // would make bandIndex/bandName non-deterministic.
      const tasks = steps.map(
        (date) =>
          async (): Promise<{
            point: PixelSeriesPoint;
            band: BandReading | null;
          }> => {
            const point: PixelSeriesPoint = {
              date: isoDate(date),
              timestamp: date.getTime(),
              url: "",
              value: null,
              isNodata: false,
            };
            let band: BandReading | null = null;
            try {
              if (signal?.aborted) throw new Error("aborted");
              const url = await resolveUrl(source.url, date);
              point.url = url;
              const reading = await readAt(url);
              band = reading ? pickBand(reading, source.bidx) : null;
              if (band) {
                point.isNodata = band.isNodata;
                point.value = band.isNodata ? null : band.value;
              }
            } catch {
              // Leave the point null: one missing/late COG should not fail the rest.
            } finally {
              completed += 1;
              onProgress?.(completed, total);
            }
            return { point, band };
          },
      );
      const results = await runWithConcurrency(tasks, READ_CONCURRENCY);
      const points = results.map((result) => result.point);
      const firstBand = results.find((result) => result.band)?.band ?? null;
      return {
        sourceId: source.id ?? source.name ?? "cog",
        sourceName: source.name ?? source.id ?? "COG",
        bandIndex:
          firstBand?.index ??
          (source.bidx && source.bidx.length > 0 ? source.bidx[0] : 1),
        bandName: firstBand?.name ?? null,
        points,
      } satisfies PixelSeries;
    }),
  );

  return { lngLat, series, stepCount: steps.length, truncated };
}

/**
 * Formats a date as an ISO `YYYY-MM-DD` string in UTC, matching the Time Slider
 * token expansion so chart labels and the timeline agree.
 */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Flattens a pixel time-series result into a point FeatureCollection for export.
 * Every (source, timestep) becomes a Point feature at the clicked location with
 * the date, source, band, and value as attributes, so the existing vector
 * exporters write it straight to CSV or GeoParquet.
 *
 * @param result - The query result.
 * @returns A FeatureCollection of one point per (source, timestep).
 */
export function seriesToFeatureCollection(
  result: PixelTimeSeriesResult,
): FeatureCollection<Point> {
  const [lng, lat] = result.lngLat;
  const features: Feature<Point>[] = [];
  let id = 0;
  for (const series of result.series) {
    for (const point of series.points) {
      features.push({
        type: "Feature",
        id: id++,
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: {
          date: point.date,
          source: series.sourceName,
          band: series.bandIndex,
          band_name: series.bandName,
          value: point.value,
          is_nodata: point.isNodata,
        },
      });
    }
  }
  return { type: "FeatureCollection", features };
}
