/**
 * Default-date fallback for time-enabled NASA GIBS layers (issue #3259).
 *
 * GIBS sometimes advertises a default (latest) date in its WMTS capabilities
 * that has no imagery behind it: every tile at that date is a 404, so adding
 * the layer draws nothing. When a layer is added at its default date, one
 * world tile is probed; if it is missing, the previous dates of the advertised
 * time domain are probed (a bounded number of steps) and the first one with
 * imagery becomes the layer's date. A default date that works costs one tile
 * request and changes nothing.
 */
import {
  buildTileUrl,
  type GibsLayer,
  type GibsTimeDimension,
  type NasaEarthdataControl,
} from "maplibre-gl-nasa-earthdata";

/** How many earlier dates are probed before giving up on the fallback. */
export const MAX_FALLBACK_STEPS = 3;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?$/;

interface TimeInterval {
  start: string;
  end: string;
  period?: { years: number; months: number; days: number };
}

function parseInterval(value: string): TimeInterval | null {
  const [start, end, period] = value.split("/");
  if (!start || !DATE_ONLY.test(start)) return null;
  if (end === undefined) return { start, end: start };
  if (!DATE_ONLY.test(end)) return null;
  const match = period ? PERIOD.exec(period) : null;
  const years = Number(match?.[1] ?? 0);
  const months = Number(match?.[2] ?? 0);
  const days = Number(match?.[3] ?? 0);
  // A zero (or unparseable) period cannot be stepped through.
  if (years + months + days === 0) return { start, end };
  return { start, end, period: { years, months, days } };
}

function subtractPeriod(date: string, period: NonNullable<TimeInterval["period"]>): string {
  const [year, month, day] = date.split("-").map(Number);
  // Clamp the day to the target month so 2024-03-31 minus P1M is 2024-02-29,
  // not the Date.UTC rollover 2024-03-02 (a date GIBS never advertises).
  const lastDay = new Date(Date.UTC(year - period.years, month - period.months, 0)).getUTCDate();
  const shifted = new Date(
    Date.UTC(year - period.years, month - 1 - period.months, Math.min(day, lastDay) - period.days),
  );
  return shifted.toISOString().slice(0, 10);
}

/**
 * Lists the dates of a GIBS time domain that come before `from`, newest first.
 *
 * Steps back by the period of the interval `from` falls in, then continues at
 * the end of the previous interval. Only date-only (`YYYY-MM-DD`) domains are
 * handled; sub-daily domains return no dates.
 *
 * @param time - The layer's time dimension from the capabilities document.
 * @param from - The date to step back from (usually the default date).
 * @param count - The maximum number of dates to return.
 * @returns Up to `count` earlier dates, newest first.
 */
export function previousGibsDates(time: GibsTimeDimension, from: string, count: number): string[] {
  if (!DATE_ONLY.test(from)) return [];
  const intervals = time.values
    .map(parseInterval)
    .filter((interval): interval is TimeInterval => interval !== null);
  const dates: string[] = [];
  let current = from;
  while (dates.length < count) {
    const containing = intervals.find(
      (interval) => interval.start <= current && current <= interval.end,
    );
    let next: string | undefined;
    if (containing?.period) {
      const stepped = subtractPeriod(current, containing.period);
      if (stepped >= containing.start) next = stepped;
    }
    if (!next) {
      // Continue at the newest interval end before the current date.
      next = intervals
        .map((interval) => interval.end)
        .filter((end) => end < current)
        .sort()
        .at(-1);
    }
    if (!next) break;
    dates.push(next);
    current = next;
  }
  return dates;
}

/**
 * Builds the URL of the zoom-0 tile of a GIBS layer at a date.
 *
 * @param layer - The GIBS catalog layer.
 * @param date - The ISO 8601 date to request.
 * @returns The concrete tile URL.
 */
export function gibsProbeTileUrl(layer: GibsLayer, date: string): string {
  return buildTileUrl(layer, date).replace("{z}", "0").replace("{y}", "0").replace("{x}", "0");
}

/** Fetch signature the probe needs, injectable for tests. */
export type ProbeFetch = (url: string) => Promise<Pick<Response, "status">>;

/**
 * Asks whether a tile is missing.
 *
 * @param fetchImpl - The fetch used for the probe.
 * @param url - The concrete tile URL.
 * @returns `true` for a missing tile (404/204), `false` for one that loaded,
 *   and `null` when the response does not say.
 */
async function tileMissing(fetchImpl: ProbeFetch, url: string): Promise<boolean | null> {
  try {
    const { status } = await fetchImpl(url);
    if (status === 404 || status === 204) return true;
    if (status >= 200 && status < 300) return false;
    // Any other status (a 5xx, a throttle) is not an answer about the date.
    return null;
  } catch {
    // A network failure says nothing about the date: leave it alone.
    return null;
  }
}

/**
 * Finds the date a newly added GIBS layer should show when its default date
 * has no imagery.
 *
 * @param layer - The GIBS catalog layer (must be time-enabled).
 * @param fetchImpl - The fetch used for the tile probes.
 * @param maxSteps - How many earlier dates to try.
 * @returns The newest earlier date whose world tile exists, or `null` when the
 *   default date works, the probe could not tell, or no earlier date in range
 *   has imagery.
 */
export async function findGibsFallbackDate(
  layer: GibsLayer,
  fetchImpl: ProbeFetch,
  maxSteps: number = MAX_FALLBACK_STEPS,
): Promise<string | null> {
  const time = layer.time;
  if (!time || !DATE_ONLY.test(time.default)) return null;
  if ((await tileMissing(fetchImpl, gibsProbeTileUrl(layer, time.default))) !== true) {
    return null;
  }
  for (const date of previousGibsDates(time, time.default, maxSteps)) {
    const missing = await tileMissing(fetchImpl, gibsProbeTileUrl(layer, date));
    if (missing === false) return date;
    if (missing === null) return null;
  }
  return null;
}

/** How long one tile probe may take before the layer is added at its default. */
export const DATE_PROBE_TIMEOUT_MS = 5000;

/**
 * Fetches a tile, aborting the request after {@link DATE_PROBE_TIMEOUT_MS}.
 *
 * @param url - The tile URL.
 * @returns The response.
 */
export async function fetchWithProbeTimeout(url: string): Promise<Pick<Response, "status">> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DATE_PROBE_TIMEOUT_MS);
  try {
    return await globalThis.fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

type AddLayerOptions = Parameters<NasaEarthdataControl["addLayer"]>[1];

/** The parts of `NasaEarthdataControl` the Add wrapper uses. */
export interface DateFallbackControl {
  search(query: string): GibsLayer[];
  addLayer(layerId: string, options?: AddLayerOptions): void;
}

/**
 * Makes a panel "Add" of a time-enabled layer start at a date GIBS has imagery
 * for (issue #3259). The control's Add button calls `addLayer(id)` with no
 * date; that call now probes one tile first and adds the layer at the newest
 * date with imagery (the default date when it works). Calls that name a date
 * or key (project restore, the date picker's re-add) pass straight through.
 *
 * @param control - The control whose `addLayer` is wrapped in place.
 * @param isActive - Whether the control is still in use once a probe settles;
 *   a deactivated plugin adds nothing.
 * @param fetchImpl - The fetch used for the probes.
 */
export function addAtAvailableDefaultDate(
  control: DateFallbackControl,
  isActive: () => boolean,
  fetchImpl: ProbeFetch = fetchWithProbeTimeout,
): void {
  const addLayer = control.addLayer.bind(control);
  control.addLayer = (layerId: string, options?: AddLayerOptions) => {
    const layer =
      options?.date === undefined && options?.key === undefined
        ? control.search(layerId).find((candidate) => candidate.id === layerId)
        : undefined;
    if (!layer?.time) {
      addLayer(layerId, options);
      return;
    }
    void findGibsFallbackDate(layer, fetchImpl)
      // An unexpected failure must not swallow the add: use the default date.
      .catch(() => null)
      .then((date) => {
        if (!isActive()) return;
        addLayer(layerId, date ? { ...options, date } : options);
      });
  };
}
