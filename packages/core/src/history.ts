/**
 * Runtime-settable window (ms) used to coalesce rapid history-producing changes
 * (e.g. a continuous opacity/style slider drag) into a single undo entry. Tests
 * set this to 0 for deterministic one-entry-per-action behavior.
 */
let historyCoalesceMs = 400;

export function setHistoryCoalesceMs(ms: number): void {
  historyCoalesceMs = ms;
}

export function getHistoryCoalesceMs(): number {
  return historyCoalesceMs;
}

/**
 * Soft budget (in total feature count) for the geometry/attribute payload
 * retained across undo snapshots. Each in-app edit of a vector layer pushes a
 * new snapshot that holds the layer's full `geojson`; without a bound, editing
 * a large layer many times pins several copies of its feature set in memory
 * (issue #341). When the distinct features across snapshots exceed this budget,
 * the oldest snapshots are dropped (see {@link trimHistoryBySize}).
 *
 * Feature count is a cheap proxy for payload size; it avoids serializing
 * geometry on every edit. The default is generous enough that ordinary
 * multi-step editing of small/medium layers keeps the full history depth, while
 * very large layers trade history depth for a bounded footprint.
 */
let maxHistoryFeatureCount = 500_000;

export function setMaxHistoryFeatureCount(count: number): void {
  if (!Number.isFinite(count) || count < 0) {
    throw new RangeError(
      `maxHistoryFeatureCount must be a non-negative finite number, got ${count}`,
    );
  }
  maxHistoryFeatureCount = count;
}

export function getMaxHistoryFeatureCount(): number {
  return maxHistoryFeatureCount;
}

/** Structural shape of a partialized undo snapshot, for size accounting. */
interface HistorySnapshot {
  layers?: { geojson?: { features?: unknown[] } | null }[];
}

/**
 * Sum the feature counts of a snapshot's layer `geojson` payloads, skipping any
 * payload whose object reference is already in `seen` so feature sets shared
 * across snapshots (unchanged layers keep the same reference) are counted once.
 * Mutates `seen` with each newly counted payload.
 */
function distinctFeatureCount(
  snapshot: HistorySnapshot,
  seen: Set<object>,
): number {
  let count = 0;
  for (const layer of snapshot.layers ?? []) {
    const geojson = layer?.geojson;
    // Dedup the reference first so a payload shared across snapshots is visited
    // once even when its `features` is missing/malformed (it then contributes 0).
    if (!geojson || seen.has(geojson)) continue;
    seen.add(geojson);
    if (!Array.isArray(geojson.features)) continue;
    count += geojson.features.length;
  }
  return count;
}

/**
 * Bound the memory held by undo history by dropping the oldest snapshots whose
 * combined feature payload exceeds `maxFeatures`.
 *
 * Walks newest-to-oldest and keeps the most recent snapshots whose cumulative
 * distinct feature count fits the budget. The single newest snapshot is always
 * kept regardless of size, so one-step undo of even a huge edit still works.
 * Feature sets shared by reference across snapshots (unchanged layers) are
 * counted once, so retaining many snapshots of small layers stays cheap.
 *
 * Returns the original array when nothing needs trimming, or a trimmed slice
 * (oldest entries removed) otherwise. Pure: never mutates its input.
 */
export function trimHistoryBySize<T extends HistorySnapshot>(
  pastStates: T[],
  maxFeatures: number,
): T[] {
  if (!Number.isFinite(maxFeatures) || maxFeatures < 0) {
    throw new RangeError(
      `maxFeatures must be a non-negative finite number, got ${maxFeatures}`,
    );
  }
  if (pastStates.length <= 1) return pastStates;
  const seen = new Set<object>();
  const lastIndex = pastStates.length - 1;
  // The newest snapshot is always retained, even if it alone exceeds the budget.
  let total = distinctFeatureCount(pastStates[lastIndex], seen);
  let keepFrom = lastIndex;
  for (let i = lastIndex - 1; i >= 0; i--) {
    const added = distinctFeatureCount(pastStates[i], seen);
    if (total + added > maxFeatures) break;
    total += added;
    keepFrom = i;
  }
  return keepFrom === 0 ? pastStates : pastStates.slice(keepFrom);
}

/** A debounced function with a `cancel` to clear its in-flight burst window. */
export type DebouncedFn<A extends unknown[]> = ((...args: A) => void) & {
  /** Clear the active burst timer so the next call fires on its leading edge. */
  cancel: () => void;
};

/**
 * Leading-edge debounce. Fires `fn` immediately on the first call of a burst,
 * then suppresses further calls until `getWait()` ms of quiet have elapsed.
 * When the wait is <= 0, every call is passed straight through (used in tests).
 *
 * Used as zundo's `handleSet`: `fn` is zundo's "save previous state to history"
 * function, so firing only on the leading edge records the pre-burst state once.
 * `cancel()` resets the window so that clearing history mid-burst doesn't
 * suppress the next edit's save.
 */
export function leadingDebounce<A extends unknown[]>(
  fn: (...args: A) => void,
  getWait: () => number,
): DebouncedFn<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: A) => {
    const wait = getWait();
    if (wait <= 0) {
      fn(...args);
      return;
    }
    const atBurstStart = timer === null;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
    }, wait);
    if (atBurstStart) fn(...args);
  };
  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return wrapped;
}
