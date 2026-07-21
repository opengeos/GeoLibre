import { useAppStore } from "@geolibre/core";
import { useEffect, useMemo } from "react";

import { whiteboxToolFromLocation } from "../lib/whitebox-tool-url";

/**
 * Opens the Processing (Whitebox toolbox) dialog on a specific tool when the app
 * is loaded with a `?tool=<id>` deep link, optionally pre-filling the tool's
 * parameters from the remaining query params, e.g.
 * `…/?tool=extract_cog_subset&url=https%3A%2F%2F…%2Fdem.tif&bbox_crs=4326`.
 *
 * The id is validated against the checked-in menu catalog
 * ({@link whiteboxToolFromLocation}). A **known** id preselects the tool — and,
 * when the URL carries parameters, dispatches a re-run-style request so the
 * dialog overlays those values on the tool's defaults once its catalog finishes
 * loading, exactly like the History "re-run" path (`ProcessingDialog` consumes
 * `ui.processingRerun` + `ui.processingInitialTool`). A present-but-**unknown**
 * id still opens the dialog with no preselection rather than silently doing
 * nothing; its parameters can't be mapped without a tool, so they are dropped.
 *
 * The query string is read once on mount (`useMemo` with no deps), so later
 * in-app state changes never re-trigger it. Works identically in the web and
 * desktop builds: it touches only `window.location.search` and the shared store.
 */
export function useWhiteboxToolUrl(): void {
  const setProcessingOpen = useAppStore((state) => state.setProcessingOpen);
  const setProcessingInitialTool = useAppStore((state) => state.setProcessingInitialTool);
  const setProcessingRerun = useAppStore((state) => state.setProcessingRerun);
  const target = useMemo(() => whiteboxToolFromLocation(), []);

  useEffect(() => {
    if (!target) return;

    if (!target.known) {
      // Unknown id: open Processing without preselecting a tool. Clear any stale
      // pending id so the dialog lands on its default tool rather than a leftover.
      setProcessingInitialTool(null);
      setProcessingOpen(true);
      return;
    }

    // Known id. When the URL carries tool parameters, queue a re-run-style
    // request that pre-fills the form (the rerun effect overlays the values on
    // the tool's defaults once the catalog is loaded). Pair it with the
    // initial-tool stash, which clears the list filters and selects the tool —
    // exactly how the History panel opens a whitebox re-run.
    if (Object.keys(target.parameters).length > 0) {
      setProcessingRerun({
        kind: "whitebox",
        toolId: target.toolId,
        parameters: target.parameters,
      });
    }
    setProcessingInitialTool(target.toolId);
    setProcessingOpen(true);
  }, [target, setProcessingInitialTool, setProcessingRerun, setProcessingOpen]);
}
