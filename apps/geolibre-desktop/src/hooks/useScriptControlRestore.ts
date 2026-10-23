import type { MapEngine } from "@geolibre/map";
import { useEffect } from "react";

import { getScriptMapControls } from "../lib/scripting/ui-controls";

/**
 * Re-apply the map controls a script showed or hid to the live map.
 *
 * Like terrain (see `useTerrainRestore`), this cannot live in the toolbar:
 * embeds that hide it (`?maponly`, used by share.geolibre.app for thumbnails)
 * never mount one, so nothing would re-apply a `hide_control` after a renderer
 * swap and the control would come back. Running here also covers a script that
 * reaches the app before the controller exists — it is created asynchronously,
 * so a command flushed right after `geolibre:ready` can find none, and this
 * effect applies the recorded state once the controller is ready.
 *
 * Args:
 *     mapControllerRef: Ref to the live MapController.
 *     mapReadyGeneration: Bumped whenever the controller/style reinitialises.
 *     projectGeneration: Bumped whenever a project is loaded.
 */
export function useScriptControlRestore(
  mapControllerRef: React.RefObject<MapEngine | null>,
  mapReadyGeneration: number,
  projectGeneration: number,
): void {
  useEffect(() => {
    const controller = mapControllerRef.current;
    if (!controller) return;
    for (const [control, visible] of getScriptMapControls()) {
      controller.setBuiltInControlVisible(control, visible);
    }
  }, [mapControllerRef, mapReadyGeneration, projectGeneration]);
}
