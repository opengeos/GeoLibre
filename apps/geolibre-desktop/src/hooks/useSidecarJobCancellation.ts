import { useState, type Dispatch, type SetStateAction } from "react";

/** Cancel a sidecar job and reconcile its response without replacing a newer job. */
export function useSidecarJobCancellation<T extends { id: string }>(
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
      setJob((current) => (current?.id === next.id ? next : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : errorMessage);
    } finally {
      setCancellingJob(false);
    }
  };
  return { cancellingJob, cancelSidecarJob };
}
