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
