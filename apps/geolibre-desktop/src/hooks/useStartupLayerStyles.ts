import { useAppStore } from "@geolibre/core";
import { useEffect } from "react";
import { useDesktopSettingsStore } from "./useDesktopSettings";

/**
 * Restyle each layer added to the map from the layer styles file chosen in
 * Startup settings, matching by layer name.
 *
 * Only layers added within the current project are restyled. Opening or
 * creating a project (a `projectGeneration` change) adopts that project's
 * layers as already seen, so a saved project keeps its own styles. Every id
 * stays seen for the rest of the project, so undoing a removal brings the layer
 * back as it was rather than restyling it again.
 */
export function useStartupLayerStyles(): void {
  useEffect(() => {
    let generation = useAppStore.getState().projectGeneration;
    let seen = new Set(useAppStore.getState().layers.map((layer) => layer.id));
    return useAppStore.subscribe((state, previous) => {
      if (state.projectGeneration !== generation) {
        generation = state.projectGeneration;
        seen = new Set(state.layers.map((layer) => layer.id));
        return;
      }
      if (state.layers === previous.layers) return;
      const added: string[] = [];
      for (const layer of state.layers) {
        if (seen.has(layer.id)) continue;
        seen.add(layer.id);
        added.push(layer.id);
      }
      if (added.length === 0) return;
      const entries = useDesktopSettingsStore.getState().desktopSettings.startup.layerStyles?.entries;
      if (!entries?.length) return;
      // Apply after this notification finishes. A store update made from inside
      // a listener notifies every listener with the new state first, and then
      // the listeners still queued for this update run with the older one, so
      // a map sync among them would put back the unstyled layer.
      queueMicrotask(() => {
        if (useAppStore.getState().projectGeneration !== generation) return;
        useAppStore.getState().applyLayerStyleEntries(entries, added);
      });
    });
  }, []);
}
