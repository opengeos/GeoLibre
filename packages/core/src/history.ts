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
