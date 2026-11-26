import { OgcProcessError } from "./ogc-process-errors";
import {
  readOgcProcessJob,
  readOgcProcessResults,
  resolveOgcProcessJobContext,
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
  const deadline = AbortSignal.timeout(30 * 60_000);
  const abort = AbortSignal.any([signal, deadline]);
  try {
    let current = typeof initial === "string" ? await readOgcProcessJob(initial, abort) : initial;
    const attemptedContexts = new Set<string>();
    for (;;) {
      abort.throwIfAborted();
      const reference = current.processUrl ?? current.processId;
      if (reference && !current.outputDefinitions && !attemptedContexts.has(reference)) {
        attemptedContexts.add(reference);
        current = await resolveOgcProcessJobContext(current, abort);
      }
      onUpdate?.(current);
      if (current.status === "successful") return await readOgcProcessResults(current, abort);
      if (current.status === "failed" || current.status === "dismissed")
        throw current.message ? new Error(current.message) : new OgcProcessError("jobFailed");
      await pollDelay(current.retryAfterMs, abort);
      const next = await readOgcProcessJob(current.url, abort);
      current = {
        ...next,
        outputIds: current.outputIds,
        outputDefinitions: current.outputDefinitions,
        processUrl: current.processUrl ?? next.processUrl,
        processId: current.processId ?? next.processId,
      };
    }
  } catch (error) {
    if (deadline.aborted && !signal.aborted) throw new OgcProcessError("monitoringTimeout");
    throw error;
  }
}
