/**
 * Caps how many requests run at once. Queued requests whose signal aborts
 * (MapLibre cancels tiles the user panned away from) leave the queue without
 * ever starting, so a small backend pool only works on tiles still wanted.
 *
 * Pure and dependency-free so it unit-tests without MapLibre or Tauri.
 */

export type RequestLimiter = <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

function abortError(): Error {
  return new DOMException("The request was aborted.", "AbortError");
}

export function createRequestLimiter(limit: number): RequestLimiter {
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = () => {
    const next = waiting.shift();
    // Hand the slot straight to the next queued request, or free it.
    if (next) next();
    else active -= 1;
  };

  return async (task, signal) => {
    if (signal?.aborted) throw abortError();
    if (active < limit) {
      active += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        const start = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = waiting.indexOf(start);
          if (index >= 0) waiting.splice(index, 1);
          reject(abortError());
        };
        waiting.push(start);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    try {
      // Aborted after the slot was handed over but before it started.
      if (signal?.aborted) throw abortError();
      return await task();
    } finally {
      release();
    }
  };
}
