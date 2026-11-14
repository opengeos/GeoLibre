import { useAppStore } from "@geolibre/core";
import { DEFAULT_TERRAIN_EXAGGERATION, type MapEngine } from "@geolibre/map";
import { useEffect, useRef } from "react";
import { applyTerrainLook } from "../lib/terrain-look";

/**
 * Apply the project's 3D terrain (`terrainEnabled`, exaggeration and DEM
 * source) to the live map.
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
  mapControllerRef: React.RefObject<MapEngine | null>,
  mapReadyGeneration: number,
  projectGeneration: number,
): void {
  const terrainEnabled = useAppStore((state) => state.preferences.map.terrainEnabled);
  // The engine and project the saved look was last applied to. A style reload
  // keeps the engine's own exaggeration and source, so only a new engine or a
  // new project applies it again; the Terrain settings dialog drives the
  // engine directly in between.
  const applied = useRef<{ engine: MapEngine; projectGeneration: number } | null>(null);

  useEffect(() => {
    mapControllerRef.current?.setBuiltInControlVisible("terrain", terrainEnabled);
  }, [mapControllerRef, mapReadyGeneration, projectGeneration, terrainEnabled]);

  useEffect(() => {
    const engine = mapControllerRef.current;
    if (!engine) return;
    const last = applied.current;
    if (last?.engine === engine && last.projectGeneration === projectGeneration) return;
    applied.current = { engine, projectGeneration };
    applyTerrainLook(engine, useAppStore.getState().preferences.map, {
      reset: last !== null && last.projectGeneration !== projectGeneration,
      defaultExaggeration: DEFAULT_TERRAIN_EXAGGERATION,
    });
  }, [mapControllerRef, mapReadyGeneration, projectGeneration]);
}
