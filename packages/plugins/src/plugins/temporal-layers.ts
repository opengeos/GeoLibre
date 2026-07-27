import { parseTimeValue, pickGranularity, type TimeGranularity } from "./time-slider-binding";

/**
 * A layer whose time is an **internal dimension** rather than a feature property
 * or a separate dated source: a Zarr data cube with a `time` axis, a plugin's
 * own custom layer that steps through frames, and so on. The adapter is the
 * whole contract between such a layer and the Time Slider.
 *
 * The slider owns the snapping so it can skip a tick that lands on the slice
 * already showing (one chunk fetch per *changed* index, not per tick):
 * {@link getTimeValues} is read to find the nearest index, and {@link setTime}
 * is then called with that slice's own date. `setTime` should still snap
 * defensively — it is idempotent — because a caller other than the slider may
 * hand it an arbitrary date.
 */
export interface TemporalLayerAdapter {
  /**
   * The layer's time coordinate, in index order. `Date`s, epoch
   * milliseconds/seconds, bare calendar years, and date strings are all
   * accepted; see {@link toEpochMsAxis} for how each is read.
   */
  getTimeValues: () => ReadonlyArray<Date | number | string>;
  /** Apply a date to the layer, snapping it to the nearest time value. */
  setTime: (date: Date) => void | Promise<void>;
  /**
   * Name of the internal dimension being driven, e.g. `"time"`. Persisted on
   * the layer's {@link SelectorTimeBinding} so a saved project records which
   * axis the timeline was bound to. Defaults to `"time"`.
   */
  dimension?: string;
}

/**
 * The persisted configuration that binds a layer's **internal time dimension**
 * to the Time Slider, stored on `layer.metadata.timeBinding` beside the vector
 * `TimeBinding` it sits alongside. It records only the timeline's shape: the
 * time values themselves are transient and come from the live
 * {@link TemporalLayerAdapter}, because they belong to the data store rather
 * than to the project (and a daily cube's axis would bloat the project file).
 */
export interface SelectorTimeBinding {
  /** Discriminates this from the vector-filter `TimeBinding`. */
  kind: "selector";
  /** The internal dimension driven by the timeline, e.g. `"time"`. */
  dimension: string;
  /** Epoch-millisecond extent of the time axis, used to set the timeline range. */
  min: number;
  max: number;
  /** Suggested stepping granularity derived from the axis span. */
  granularity: TimeGranularity;
}

/**
 * Whether a value read off `layer.metadata.timeBinding` is a selector binding
 * (an internal time dimension) rather than the vector-filter kind.
 *
 * @param value - A raw metadata value.
 * @returns True when it is a well-formed {@link SelectorTimeBinding}.
 */
export function isSelectorTimeBinding(value: unknown): value is SelectorTimeBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<SelectorTimeBinding>;
  return (
    binding.kind === "selector" &&
    typeof binding.dimension === "string" &&
    binding.dimension !== "" &&
    Number.isFinite(binding.min) &&
    Number.isFinite(binding.max)
  );
}

/**
 * Read a time coordinate into epoch milliseconds, **keeping every position** so
 * the result stays index-aligned with the store's own axis. A value that is not
 * a timestamp becomes `NaN` rather than being dropped, and
 * {@link nearestTimeIndex} skips those.
 *
 * `Date`s are taken as-is; everything else goes through the same reader the
 * vector bindings use (`parseTimeValue`), so epoch seconds/milliseconds, bare
 * calendar years, and ISO strings are all understood.
 *
 * @param values - The layer's time coordinate, in index order.
 * @returns The axis in epoch milliseconds, or null when nothing parsed.
 */
export function toEpochMsAxis(
  values: ReadonlyArray<Date | number | string> | null | undefined,
): number[] | null {
  if (!values || values.length === 0) return null;
  let finite = 0;
  const axis = new Array<number>(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    const ms = value instanceof Date ? value.getTime() : parseTimeValue(value);
    if (ms === null || !Number.isFinite(ms)) {
      axis[i] = Number.NaN;
      continue;
    }
    axis[i] = ms;
    finite += 1;
  }
  return finite > 0 ? axis : null;
}

/**
 * Index of the axis entry closest to `targetMs`. Ties go to the earlier index,
 * so stepping forward never skips a slice. Positions holding `NaN` (a value the
 * axis could not express as a timestamp) are ignored.
 *
 * The scan is linear rather than a binary search because a Zarr time axis is
 * not guaranteed to be sorted, and it runs at most once per throttled timeline
 * tick per layer.
 *
 * @param axis - Epoch-millisecond values, in index order.
 * @param targetMs - The timeline's current date, in epoch milliseconds.
 * @returns The nearest index, or -1 when the axis holds no usable value.
 */
export function nearestTimeIndex(axis: readonly number[], targetMs: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < axis.length; i += 1) {
    const value = axis[i];
    if (!Number.isFinite(value)) continue;
    const distance = Math.abs(value - targetMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * Build the persisted binding for a layer's internal time dimension from its
 * time coordinate. Mirrors `buildTimeBindingFromRecords`: the extent comes from
 * the data and the stepping granularity from the span, so a cube and a vector
 * layer bound together share one sensibly-stepped track.
 *
 * @param dimension - The internal dimension's name, e.g. `"time"`.
 * @param values - The layer's time coordinate, in index order.
 * @returns The binding, or null when the axis holds no usable timestamp.
 */
export function buildSelectorTimeBinding(
  dimension: string,
  values: ReadonlyArray<Date | number | string> | null | undefined,
): SelectorTimeBinding | null {
  const axis = toEpochMsAxis(values);
  if (!axis) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of axis) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  // A single-slice cube still needs a non-zero span so the slider can move,
  // matching the vector path's treatment of a single-instant dataset.
  if (max <= min) max = min + 86_400_000;
  return {
    kind: "selector",
    dimension: dimension.trim() || "time",
    min,
    max,
    granularity: pickGranularity(max - min),
  };
}

// ----- Registry --------------------------------------------------------------
// Adapters are transient: they belong to a *live* layer instance, so they are
// registered when the layer is created (natively by the Zarr flow, or by an
// external plugin for its own custom layer) and dropped when it is removed. The
// binding on `layer.metadata.timeBinding` is what persists.

const adapters = new Map<string, TemporalLayerAdapter>();
const listeners = new Set<() => void>();
// Bumped on every registration change so a React view can subscribe with
// `useSyncExternalStore` without the registry having to hand out a new object.
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * Register a temporal adapter for a layer, making it bindable to the Time
 * Slider. Replaces any adapter already registered for the same layer id.
 *
 * @param layerId - The store layer's id.
 * @param adapter - The adapter driving that layer's internal time dimension.
 * @returns A function that unregisters this adapter.
 */
export function registerTemporalLayer(layerId: string, adapter: TemporalLayerAdapter): () => void {
  adapters.set(layerId, adapter);
  notify();
  return () => {
    // Only remove it if it is still the adapter we registered, so a later
    // re-registration for the same id is not torn down by a stale detacher.
    if (adapters.get(layerId) !== adapter) return;
    adapters.delete(layerId);
    notify();
  };
}

/**
 * Drop a layer's temporal adapter, e.g. when the layer is removed.
 *
 * @param layerId - The store layer's id.
 */
export function unregisterTemporalLayer(layerId: string): void {
  if (!adapters.delete(layerId)) return;
  notify();
}

/**
 * The temporal adapter registered for a layer, if any.
 *
 * @param layerId - The store layer's id.
 * @returns The adapter, or undefined when the layer has none.
 */
export function getTemporalLayerAdapter(layerId: string): TemporalLayerAdapter | undefined {
  return adapters.get(layerId);
}

/**
 * A counter that changes whenever an adapter is registered or unregistered.
 * Pairs with {@link subscribeTemporalLayers} as a `useSyncExternalStore`
 * snapshot, so the Layers panel can offer the bind action as soon as a layer
 * becomes temporal.
 *
 * @returns The current registry version.
 */
export function getTemporalLayersVersion(): number {
  return version;
}

/**
 * Subscribe to registration changes.
 *
 * @param listener - Called after every register/unregister.
 * @returns A function that removes the listener.
 */
export function subscribeTemporalLayers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop every registered adapter. Exported for tests. */
export function __resetTemporalLayersForTests(): void {
  adapters.clear();
  notify();
}
