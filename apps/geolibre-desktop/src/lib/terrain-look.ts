import type { MapPreferences } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { clampExaggeration } from "./terrain-exaggeration";

/** The engine calls {@link applyTerrainLook} makes (stubbed in tests). */
export type TerrainLookEngine = Pick<
  MapEngine,
  | "capabilities"
  | "setTerrainExaggeration"
  | "getTerrainCogSource"
  | "hasCustomTerrainSource"
  | "setTerrainCogSource"
>;

/**
 * Apply a project's saved terrain exaggeration and DEM source to an engine.
 *
 * Args:
 *     engine: The live map engine.
 *     map: The project's map preferences.
 *     options: `reset` also puts an unsaved look back to the defaults. It is
 *         set when a project was just opened or created; a new engine for the
 *         same project only takes what the project saved, so a DEM opened from
 *         a local file (which has no URL to save) is not dropped by it.
 *         `defaultExaggeration` is the renderer default to reset to.
 */
export function applyTerrainLook(
  engine: TerrainLookEngine,
  map: Pick<MapPreferences, "terrainExaggeration" | "terrainSource">,
  options: { reset: boolean; defaultExaggeration: number },
): void {
  if (map.terrainExaggeration !== undefined || options.reset) {
    // Clamped to the Terrain dialog's range, so a hand-edited project cannot
    // open at a value the dialog would show (and save) differently.
    engine.setTerrainExaggeration(
      clampExaggeration(map.terrainExaggeration ?? options.defaultExaggeration),
    );
  }
  if (!engine.capabilities.terrainSource) return;
  const source = map.terrainSource ?? null;
  if (source === null) {
    if (!options.reset || !engine.hasCustomTerrainSource()) return;
  } else if (engine.getTerrainCogSource() === source) {
    return;
  }
  void engine.setTerrainCogSource(source).catch((error: unknown) => {
    console.warn("[terrain] could not restore the project's terrain source", source, error);
  });
}
