import {
  readOgcProcessJob,
  readOgcProcessResults,
  type OgcProcessJob,
  type OgcProcessOutput,
} from "./ogc-api-processes";

/** Wait between status reads without leaving an abort listener or timer behind. */
function pollDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Monitor an existing job, honoring Retry-After and surfacing terminal failures.
 * Cancelling stops observation only; dismissOgcProcessJob is the explicit
 * operation for stopping/deleting work on the remote service. A job that takes
 * longer than the observation deadline can be resumed by its status URL.
 */
export async function monitorOgcProcessJob(
  initial: OgcProcessJob | string,
  signal: AbortSignal,
  onUpdate?: (job: OgcProcessJob) => void,
): Promise<OgcProcessOutput[]> {
  const abort = AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]);
  let current = typeof initial === "string" ? await readOgcProcessJob(initial, abort) : initial;
  for (;;) {
    abort.throwIfAborted();
    onUpdate?.(current);
    if (current.status === "successful") return readOgcProcessResults(current, abort);
    if (current.status === "failed" || current.status === "dismissed")
      throw new Error(current.message || `OGC process job ${current.status}.`);
    await pollDelay(current.retryAfterMs, abort);
    current = await readOgcProcessJob(current.url, abort);
  }
}
