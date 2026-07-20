import { downsampleSteps } from "@geolibre/core";
import type {
  BandOption,
  PixelSeries,
  PixelSeriesPoint,
  PixelTimeSeriesRequest,
  PixelTimeSeriesResult,
} from "@geolibre/core";
import {
  type CogSourceSpec,
  type TimeSliderConfig,
  generateSteps,
  resolveUrl,
} from "maplibre-gl-time-slider";
import { loadGeoTIFF, type PixelReading, readBandNames, readPixelValues } from "maplibre-gl-raster";

/**
 * Pixel time-series support for the Time Slider's raster stack.
 *
 * A Time Slider COG source is a single template URL (e.g.
 * `https://.../{date:YYYY}.tif`) that resolves to a different Cloud Optimized
 * GeoTIFF per timeline date. Stepping the timeline therefore walks a temporal
 * stack of COGs. This module clicks a single pixel through that stack: for every
 * timeline step it resolves the source URL, HTTP-range-reads just the tile under
 * the click, and records *every* band value, producing a value-over-time series
 * the UI charts (for a user-chosen band) and can export.
 *
 * It reuses `maplibre-gl-raster`'s `loadGeoTIFF`/`readPixelValues`, the same
 * client-side reader the single-COG Identify tool uses, so no Python sidecar or
 * full-file download is involved.
 */

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
function getTimeSliderCogSources(config: TimeSliderConfig | null): CogSourceSpec[] {
  if (!config) return [];
  return config.sources.filter((spec): spec is CogSourceSpec => spec.type === "cog");
}

/**
 * The timeline step dates for the active Time Slider, downsampled to the cap.
 *
 * @param maxSteps - Maximum steps before downsampling.
 * @returns The (possibly downsampled) step dates, whether the timeline was
 *   downsampled, and the full step count before downsampling. Empty when the
 *   dock is closed.
 */
function getTimeSliderSteps(
  config: TimeSliderConfig,
  maxSteps: number,
): {
  steps: Date[];
  truncated: boolean;
  total: number;
} {
  const state = config;
  if (
    typeof state?.startDate !== "string" ||
    typeof state.granularity !== "string" ||
    (state.endDate != null && typeof state.endDate !== "string")
  ) {
    return { steps: [], truncated: false, total: 0 };
  }
  const startDate = new Date(state.startDate);
  const endDate = state.endDate ? new Date(state.endDate) : new Date();
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return { steps: [], truncated: false, total: 0 };
  }
  const steps = generateSteps(
    startDate,
    endDate,
    Math.max(1, typeof state.interval === "number" ? state.interval : 1),
    state.granularity as TimeSliderConfig["granularity"],
  );
  return { ...downsampleSteps(steps, maxSteps), total: steps.length };
}

/**
 * Runs `tasks` with a bounded number in flight at once, preserving result order.
 *
 * A rejecting task is swallowed so it cannot kill its worker; its result slot is
 * left `undefined`, which the return type reflects. Callers that care about
 * failures should handle them inside the task or check for missing slots.
 *
 * @param tasks - Thunks producing each result.
 * @param limit - Maximum concurrent tasks.
 * @param signal - Optional abort signal; when aborted, workers stop pulling new
 *   tasks so the queue drains immediately instead of running every remaining
 *   no-op task. Already-started tasks still settle.
 * @returns The results in the same order as `tasks`; failed tasks are `undefined`.
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  signal?: AbortSignal,
): Promise<(T | undefined)[]> {
  const results = new Array<T | undefined>(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      if (signal?.aborted) return;
      const index = next++;
      try {
        results[index] = await tasks[index]();
      } catch {
        // A rejecting task must not kill its worker (which would leave later
        // tasks unprocessed and the results array half-filled). Tasks own their
        // failure state via their own try/catch, so swallow everything here —
        // including non-Error throws such as a DOMException/AbortError, which
        // do not extend Error in browsers and would otherwise kill the worker.
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Picks the default band index for a result: the first source's first
 * configured band (`bidx`) when that band was actually read *for that source*,
 * otherwise the first available band. Returns null when nothing was read.
 *
 * @param sources - The queried COG sources, in order.
 * @param bands - The stack-wide union of bands read.
 * @param firstSourcePoints - The first source's per-step points, used to confirm
 *   its configured band was actually present (so the chart does not open on a
 *   band that renders the first series as all gaps).
 */
function pickDefaultBandIndex(
  sources: CogSourceSpec[],
  bands: BandOption[],
  firstSourcePoints: PixelSeriesPoint[],
): number | null {
  if (bands.length === 0) return null;
  const configured = sources[0]?.bidx?.[0];
  const firstSourceBands = new Set(
    firstSourcePoints.flatMap((point) => point.bands.map((band) => band.index)),
  );
  if (configured !== undefined && firstSourceBands.has(configured)) return configured;
  return bands[0].index;
}

/**
 * Queries a single pixel's value across the Time Slider's raster stack and
 * timeline, returning one value-over-time series per COG source. Every band is
 * read and retained so the UI can switch the charted band without re-querying.
 *
 * For every (source, step) pair the source URL template is resolved to the
 * step's date, the COG is opened, and all band values at the click are read via
 * an HTTP range read. Reads share a per-URL cache so a static (non-templated)
 * source is fetched once. Failed reads become empty points (charted as gaps)
 * rather than aborting the whole query.
 *
 * @param lngLat - The clicked location, `[lng, lat]` in WGS84.
 * @param options - Progress, abort, and step-cap controls.
 * @returns The assembled result.
 * @throws When the Time Slider has no COG sources or no timeline steps.
 */
export async function queryMapLibreTimeSliderPixels(
  config: TimeSliderConfig | null,
  request: PixelTimeSeriesRequest,
): Promise<PixelTimeSeriesResult> {
  const { lngLat, options = {} } = request;
  const { signal, onProgress, maxSteps = DEFAULT_MAX_STEPS } = options;
  const sources = getTimeSliderCogSources(config);
  if (sources.length === 0) {
    throw new Error("The Time Slider has no COG sources to query.");
  }
  if (!config) throw new Error("The Time Slider timeline has no configuration.");
  const { steps, truncated, total: originalStepCount } = getTimeSliderSteps(config, maxSteps);
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
      // loadGeoTIFF does not accept the abort signal, so once its header fetch
      // resolves, skip the pixel read if the query was cancelled meanwhile.
      if (signal?.aborted) return null;
      return readPixelValues(tiff, lngLat, {
        signal,
        bandNames: readBandNames(tiff),
      });
    })();
    // Evict on rejection so a transient failure (network/CORS/404) for a URL
    // does not poison every later task that resolves to the same URL within
    // this query — exactly the static-source case the dedup cache targets.
    promise.catch(() => readingCache.delete(url));
    readingCache.set(url, promise);
    return promise;
  };

  const total = sources.length * steps.length;
  let completed = 0;

  // Per-source result slots, pre-filled with empty points so order is preserved
  // and there are no sparse holes: if the query is aborted, workers stop before
  // pulling some tasks, so those slots keep their (gap) placeholder instead of
  // staying `undefined` and breaking the band-union loop below.
  const points = sources.map(() =>
    steps.map(
      (date): PixelSeriesPoint => ({
        date: isoDate(date),
        timestamp: date.getTime(),
        url: "",
        bands: [],
      }),
    ),
  );

  // Flatten every (source, step) into one task list so READ_CONCURRENCY bounds
  // the reads across the whole query. Running runWithConcurrency per source
  // inside Promise.all would instead allow sources.length * READ_CONCURRENCY
  // concurrent reads and flood remote range endpoints.
  const tasks: Array<() => Promise<void>> = [];
  sources.forEach((source, si) => {
    steps.forEach((date, di) => {
      tasks.push(async () => {
        const point: PixelSeriesPoint = {
          date: isoDate(date),
          timestamp: date.getTime(),
          url: "",
          bands: [],
        };
        try {
          if (signal?.aborted) throw new Error("aborted");
          const url = await resolveUrl(source.url, date);
          point.url = url;
          const reading = await readAt(url);
          if (reading) point.bands = reading.bands;
        } catch {
          // Leave bands empty so one bad step charts as a gap instead of failing
          // the whole query. A failed step read is the *expected* case here
          // (a per-date COG may legitimately be missing/404/CORS for a sparse
          // stack), so this intentionally swallows everything — including any
          // programming error — rather than logging, which would be noisy across
          // many steps. Helper purity keeps the surface small enough that a real
          // bug surfaces in the typed call sites instead.
        } finally {
          // Write the slot before onProgress so a throwing progress callback
          // cannot leave a sparse hole that the chart would silently drop.
          points[si][di] = point;
          completed += 1;
          onProgress?.(completed, total);
        }
      });
    });
  });
  await runWithConcurrency(tasks, READ_CONCURRENCY, signal);

  const series = sources.map((source, si) => ({
    // Index-based fallbacks so multiple unnamed COG sources still get distinct
    // ids (React keys / export rows) rather than all collapsing to "cog".
    sourceId: source.id ?? source.name ?? `cog-${si}`,
    sourceName: source.name ?? source.id ?? `COG ${si + 1}`,
    points: points[si],
  }));

  // Union of bands actually read, so the picker matches the data even when a
  // source's configured bidx differs from what the COG exposes.
  const bandByIndex = new Map<number, BandOption>();
  for (const sourcePoints of points) {
    for (const point of sourcePoints) {
      for (const band of point.bands) {
        const existing = bandByIndex.get(band.index);
        // Record a band on first sight, but upgrade a null name to a later
        // non-null one so a name read at a later step/source is not lost.
        if (!existing || (existing.name == null && band.name != null))
          bandByIndex.set(band.index, { index: band.index, name: band.name });
      }
    }
  }
  const bands = [...bandByIndex.values()].sort((a, b) => a.index - b.index);

  return {
    lngLat,
    series,
    bands,
    // sources is non-empty (guarded above), so points[0] always exists.
    defaultBandIndex: pickDefaultBandIndex(sources, bands, points[0]),
    stepCount: steps.length,
    originalStepCount,
    truncated,
  };
}

/**
 * Formats a date as an ISO `YYYY-MM-DD` string in UTC, matching the Time Slider
 * token expansion so chart labels and the timeline agree.
 */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
