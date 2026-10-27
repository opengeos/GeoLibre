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
import { buildTileUrl, type GibsLayer, type GibsTimeDimension } from "maplibre-gl-nasa-earthdata";

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
  if (!match || !(match[1] || match[2] || match[3])) return { start, end };
  return {
    start,
    end,
    period: {
      years: Number(match[1] ?? 0),
      months: Number(match[2] ?? 0),
      days: Number(match[3] ?? 0),
    },
  };
}

function subtractPeriod(date: string, period: NonNullable<TimeInterval["period"]>): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(
    Date.UTC(year - period.years, month - 1 - period.months, day - period.days),
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
