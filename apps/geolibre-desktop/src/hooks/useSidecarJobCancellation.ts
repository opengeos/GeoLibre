import { useState, type Dispatch, type SetStateAction } from "react";

const RUNNING_JOB_STATUSES = new Set(["pending", "running"]);

/** Cancel a sidecar job and reconcile its response without replacing a newer job. */
export function useSidecarJobCancellation<T extends { id: string; status: string }>(
  job: T | null,
  running: boolean,
  cancel: (id: string) => Promise<T>,
  setJob: Dispatch<SetStateAction<T | null>>,
  setError: Dispatch<SetStateAction<string | null>>,
  errorMessage: string,
) {
  const [cancellingJob, setCancellingJob] = useState(false);
  const cancelSidecarJob = async () => {
    if (!job || !running) return;
    setCancellingJob(true);
    try {
      const next = await cancel(job.id);
      setJob((current) => {
        if (current?.id !== next.id) return current;
        // Polling may have already observed completion while cancel was in
        // flight. An older active response must not reopen that finished job.
        if (!RUNNING_JOB_STATUSES.has(current.status) && RUNNING_JOB_STATUSES.has(next.status)) {
          return current;
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : errorMessage);
    } finally {
      setCancellingJob(false);
    }
  };
  return { cancellingJob, cancelSidecarJob };
}
