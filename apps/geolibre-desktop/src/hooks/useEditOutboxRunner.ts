import { useEffect } from "react";

/**
 * Start the offline edit outbox's background sync (#3530) for the life of the
 * app, independent of whether the status bar indicator is visible.
 */
export function useEditOutboxRunner(): void {
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void Promise.all([
      import("../lib/edit-sync/register-backends"),
      import("../lib/edit-sync/edit-outbox-runner"),
    ]).then(([backends, runner]) => {
      if (cancelled) return;
      backends.ensureEditSyncBackends();
      stop = runner.startEditOutboxRunner();
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
}
