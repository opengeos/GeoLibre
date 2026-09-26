import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { useEffect, useRef } from "react";

import { createScriptingHandlers } from "../lib/scripting/scriptingApi";
import { isScriptableMapControl, isScriptablePanel } from "../lib/scripting/ui-controls";

/**
 * Show or hide the map controls and toolbar panels a project's `interaction`
 * block names, once per loaded project (issue #2688).
 *
 * The Identify half of the block is applied by the store's `loadProject`; the
 * controls need the live map, so they are applied here through the same
 * `setControlVisible` command the Python widget replays. That records map
 * controls for `useScriptControlRestore`, so a renderer swap keeps them.
 *
 * Each project is applied only once, and only after the controller exists: a
 * later renderer swap must not reopen a panel the user has since closed.
 *
 * Args:
 *     mapControllerRef: Ref to the live MapController.
 *     mapReadyGeneration: Bumped whenever the controller/style reinitialises.
 *     projectGeneration: Bumped whenever a project is loaded.
 */
export function useProjectInteractionRestore(
  mapControllerRef: React.RefObject<MapEngine | null>,
  mapReadyGeneration: number,
  projectGeneration: number,
): void {
  const appliedGeneration = useRef<number | null>(null);
  useEffect(() => {
    if (appliedGeneration.current === projectGeneration) return;
    if (!mapControllerRef.current) return;
    appliedGeneration.current = projectGeneration;
    const controls = useAppStore.getState().projectInteraction?.controls;
    if (!controls) return;
    const handlers = createScriptingHandlers({ getController: () => mapControllerRef.current });
    for (const [control, visible] of Object.entries(controls)) {
      if (!isScriptablePanel(control) && !isScriptableMapControl(control)) continue;
      try {
        void handlers.setControlVisible({ control, visible });
      } catch (error) {
        console.warn(`[GeoLibre] could not apply the project's "${control}" control`, error);
      }
    }
  }, [mapControllerRef, mapReadyGeneration, projectGeneration]);
}
