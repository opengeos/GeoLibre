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
 * Settles with `promise`, or rejects with `signal.reason` as soon as `signal`
 * aborts (immediately when it already has), removing its listener either way.
 *
 * @param promise The work, which may not take the signal itself.
 * @param signal Cancels the wait.
 * @returns The work's result.
 */
export function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
