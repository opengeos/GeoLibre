import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { useEffect } from "react";

/**
 * Apply the project's `terrainEnabled` preference to the live map.
 *
 * Terrain is project state rather than optional map chrome, so restoring it
 * cannot live in the toolbar: embeds that hide the toolbar (`?maponly`, used by
 * share.geolibre.app for thumbnails) never mount it and would render a saved 3D
 * project flat. Re-runs on project load and on controller/style initialization
 * so reopening a project brings back both the control and its terrain surface.
 *
 * Args:
 *     mapControllerRef: Ref to the live MapController.
 *     mapReadyGeneration: Bumped whenever the controller/style reinitialises.
 *     projectGeneration: Bumped whenever a project is loaded.
 */
export function useTerrainRestore(
  mapControllerRef: React.RefObject<MapController | null>,
  mapReadyGeneration: number,
  projectGeneration: number,
): void {
  const terrainEnabled = useAppStore((state) => state.preferences.map.terrainEnabled);

  useEffect(() => {
    mapControllerRef.current?.setBuiltInControlVisible("terrain", terrainEnabled);
  }, [mapControllerRef, mapReadyGeneration, projectGeneration, terrainEnabled]);
}
