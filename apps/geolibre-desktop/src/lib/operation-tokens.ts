/**
 * "Latest operation wins" bookkeeping for async UI handlers.
 *
 * A handler calls `begin()` before its first `await` and checks
 * `isCurrent(token)` after each one; anything that makes the in-flight work
 * irrelevant (a newer operation, a context switch such as a language change)
 * calls `invalidate()`, after which the stale handler leaves state alone.
 */
export interface OperationTokens {
  /** Start an operation, superseding any in flight. Returns its token. */
  begin: () => number;
  /** Whether `token` still belongs to the latest, uninvalidated operation. */
  isCurrent: (token: number) => boolean;
  /** Orphan every in-flight operation without starting a new one. */
  invalidate: () => void;
}

/**
 * Create an independent operation-token counter.
 *
 * Returns:
 *   The `begin` / `isCurrent` / `invalidate` trio sharing one counter.
 */
export function createOperationTokens(): OperationTokens {
  let current = 0;
  return {
    begin: () => {
      current += 1;
      return current;
    },
    isCurrent: (token) => token === current,
    invalidate: () => {
      current += 1;
    },
  };
}
