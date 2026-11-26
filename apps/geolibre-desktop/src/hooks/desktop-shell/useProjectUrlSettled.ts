import { useMemo, useState } from "react";
import type { ProjectUrlLoadState } from "../useProjectUrlLoader";
import { createLatch } from "../../lib/settle-gate";
import { projectUrlFromLocation } from "../../lib/project-url";

/**
 * Whether startup no longer waits on a `?url=` project.
 *
 * True at once when the page opened without a project URL; otherwise true
 * once that project has loaded or failed. Latched: the loader goes from
 * `loaded` back to `idle` after a few seconds, which must not un-settle a
 * project that has already loaded.
 *
 * Args:
 *   projectUrlLoadState: The `?url=` project loader's state, if any.
 *
 * Returns:
 *   Whether the startup project URL has settled.
 */
export function useProjectUrlSettled(projectUrlLoadState?: ProjectUrlLoadState): boolean {
  // Read once: whether the page opened with a `?url=` project to wait for.
  const hasProjectUrl = useMemo(() => projectUrlFromLocation() !== null, []);
  const [latch] = useState(createLatch);
  return latch(
    !hasProjectUrl ||
      projectUrlLoadState?.status === "loaded" ||
      projectUrlLoadState?.status === "error",
  );
}
