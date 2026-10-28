/**
 * A promise that rejects with an `AbortError` once `signal` aborts. Race it
 * against work that cannot itself be interrupted (an inline tool, a sidecar
 * request) so a cancelled run settles at once; the losing work's late
 * callbacks are the caller's to ignore.
 *
 * @param signal The run's abort signal.
 * @returns A promise that never resolves, and rejects when `signal` aborts
 *   (immediately when it already has).
 */
export function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => {
      const error = new Error("The run was cancelled.");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

/**
 * Settles with `promise`, or rejects with the abort reason as soon as `signal`
 * aborts (immediately when it already has), removing its listener either way.
 *
 * @param promise The work, which may not take the signal itself.
 * @param signal Cancels the wait.
 * @returns The work's result.
 */
export function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // Nobody waits for it now; keep a later rejection from going unhandled.
    promise.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Why `signal` aborted, or an `AbortError` for a signal-like object that
 * carries no `reason` (plugins may pass one from another realm).
 *
 * @param signal An aborted signal.
 * @returns The rejection value.
 */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
