import { useEffect } from "react";
import { notify } from "../../lib/notify";

/**
 * Shows a `?project=`/`?url=` or `?data=` load failure as an error notification,
 * once per distinct message. It used to be a banner of its own under the
 * toolbar; the notification keeps it until dismissed, as the banner did, and
 * records it in Diagnostics for a report.
 *
 * @param projectError - The project URL loader's error, or null/undefined.
 * @param dataError - The data URL loader's error, or null/undefined.
 */
export function useUrlLoadErrorNotices(
  projectError: string | null | undefined,
  dataError: string | null | undefined,
): void {
  useEffect(() => {
    if (projectError) notify.error(projectError, { dedupeKey: `url-load:project:${projectError}` });
  }, [projectError]);
  useEffect(() => {
    if (dataError) notify.error(dataError, { dedupeKey: `url-load:data:${dataError}` });
  }, [dataError]);
}
