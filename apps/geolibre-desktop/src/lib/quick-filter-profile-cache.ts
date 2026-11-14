import {
  createQuickFilterScan,
  type ProfileQuickFilterOptions,
  type QuickFilterFieldProfile,
} from "./quick-filter-profile";

/**
 * On-demand, cached field profiling for quick filters (issue #3426).
 *
 * Profiling used to tally every field of a layer during render each time the
 * Style panel's Quick filters section mounted. Most of that work was never
 * looked at: a layer with no quick filters needs only its field names, and a
 * layer with two filters needs two profiles, not twenty.
 *
 * This module profiles the fields a caller asks for, in slices that yield to
 * the event loop, and remembers the answers per record array. The cache is
 * keyed on the array's identity (a `WeakMap`, so it dies with the data): the
 * store replaces a layer's `features` array whenever the features change, and
 * keeps it across the paint and visibility patches that do not, so reselecting
 * a layer or reopening the panel costs nothing.
 *
 * That relies on one invariant: nothing mutates a `features` array, or a
 * feature's `properties`, in place. Every edit path (attribute edits, the field
 * calculator, adding a field) builds new objects today. One that mutated in
 * place would leave stale counts here, because the array's identity would not
 * change.
 */

/** What is known about one record array so far. */
export interface QuickFilterProfileCacheEntry {
  /** Every field name, in first-seen order. Absent until a scan has listed them. */
  names?: readonly string[];
  /**
   * Profiles by field. `null` records that the field was looked for and no
   * inspected record carries it, so it is not scanned for again.
   */
  profiles: ReadonlyMap<string, QuickFilterFieldProfile | null>;
}

interface MutableEntry {
  names?: readonly string[];
  profiles: Map<string, QuickFilterFieldProfile | null>;
}

const cache = new WeakMap<object, MutableEntry>();

/**
 * What the cache holds for a record array.
 *
 * @param source - The record array a scan ran, or will run, over.
 * @returns The cached names and profiles, or `undefined` before any scan.
 */
export function readQuickFilterProfileCache(
  source: readonly unknown[],
): QuickFilterProfileCacheEntry | undefined {
  return cache.get(source);
}

/** What a caller needs to know about a record array. */
export interface QuickFilterProfileRequest {
  /** Fields whose profiles are needed. */
  fields: readonly string[];
  /** Whether the list of field names is needed. */
  names?: boolean;
}

export interface QuickFilterProfilingOptions<T> {
  /** How to reach a record's property bag; see {@link ProfileQuickFilterOptions.properties}. */
  properties?: ProfileQuickFilterOptions<T>["properties"];
  /** Features to inspect; see {@link ProfileQuickFilterOptions.sampleLimit}. */
  sampleLimit?: number;
  /**
   * Called once the scan has settled and the request is answerable from the
   * cache. A scan that throws records its fields as having no values (and an
   * empty field list) so a caller never waits on it forever. Called
   * synchronously, before `ensureQuickFilterProfiles` returns, when the request
   * already was answerable or the scan fits in its first slice.
   */
  onDone?: () => void;
  /** How long one slice may hold the main thread, in milliseconds. */
  sliceBudgetMs?: number;
  /** Resolves on a later task. Injectable for tests. */
  yieldControl?: () => Promise<void>;
  /** Monotonic clock in milliseconds. Injectable for tests. */
  now?: () => number;
}

/**
 * How long one slice of a scan may run before yielding. Half a frame: long
 * enough that an ordinary layer finishes in the first slice (so its controls
 * never show a loading state), short enough that a large one cannot drop input.
 */
export const PROFILE_SLICE_BUDGET_MS = 8;

/** Resolve on a later task, so pending input and paint can run. */
function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Whether the cache can already answer a request without scanning.
 *
 * @param source - The record array the request is about.
 * @param request - The fields to profile and whether to list field names.
 * @returns `true` when every requested field (and the name list, if asked for)
 *   is cached.
 */
export function hasQuickFilterProfiles(
  source: readonly unknown[],
  request: QuickFilterProfileRequest,
): boolean {
  const entry = cache.get(source);
  if (request.names && !entry?.names) return false;
  return request.fields.every((field) => entry?.profiles.has(field));
}

/**
 * Make sure the cache can answer a request, scanning for whatever is missing.
 *
 * The first slice runs synchronously, so a small layer is answered before the
 * call returns; the rest of a larger scan runs in later tasks. Only the missing
 * fields are scanned, and nothing is written to the cache until the scan
 * completes, so a cancelled scan leaves no partial counts behind.
 *
 * @param source - The record array to profile. Its identity is the cache key.
 * @param request - The fields to profile and whether to list field names.
 * @param options - Property accessor, completion callback, and slicing knobs.
 * @returns A function that cancels the scan (and its `onDone`) if still running.
 */
export function ensureQuickFilterProfiles<T>(
  source: readonly T[],
  request: QuickFilterProfileRequest,
  options: QuickFilterProfilingOptions<T> = {},
): () => void {
  const entry = cache.get(source);
  const missing = [...new Set(request.fields)].filter((field) => !entry?.profiles.has(field));
  const needNames = !!request.names && !entry?.names;
  if (missing.length === 0 && !needNames) {
    options.onDone?.();
    return () => {};
  }

  const scan = createQuickFilterScan(source, {
    fields: missing,
    names: needNames,
    properties: options.properties,
    sampleLimit: options.sampleLimit,
  });
  const now = options.now ?? (() => performance.now());
  const budget = options.sliceBudgetMs ?? PROFILE_SLICE_BUDGET_MS;
  const yieldControl = options.yieldControl ?? yieldToEventLoop;

  const runSlice = (): boolean => {
    const deadline = now() + budget;
    return scan.step(() => now() >= deadline);
  };

  const commit = (failed = false): void => {
    // Re-read rather than reuse `entry`: another scan over the same array may
    // have finished while this one was yielding.
    const target: MutableEntry = cache.get(source) ?? { profiles: new Map() };
    const found = failed
      ? new Map<string, QuickFilterFieldProfile>()
      : new Map(scan.profiles().map((profile) => [profile.field, profile]));
    for (const field of missing) target.profiles.set(field, found.get(field) ?? null);
    if (needNames) target.names = failed ? [] : scan.fieldNames();
    cache.set(source, target);
    options.onDone?.();
  };
  // A throwing accessor must not leave a caller showing a loading state
  // forever. The same array would throw again, so the failure is cached as
  // "no values" rather than retried.
  const fail = (error: unknown): void => {
    console.error("Quick filter profiling failed", error);
    commit(true);
  };

  let done: boolean;
  try {
    done = runSlice();
  } catch (error) {
    fail(error);
    return () => {};
  }
  if (done) {
    commit();
    return () => {};
  }

  let cancelled = false;
  void (async () => {
    try {
      for (;;) {
        await yieldControl();
        if (cancelled) return;
        if (runSlice()) break;
      }
    } catch (error) {
      fail(error);
      return;
    }
    commit();
  })();
  return () => {
    cancelled = true;
  };
}
