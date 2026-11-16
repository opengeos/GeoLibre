import type { MapPreferences } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { clampExaggeration } from "./terrain-exaggeration";
import { resolveTerrainFillOutside } from "./terrain-fill";

/** The engine calls {@link applyTerrainLook} makes (stubbed in tests). */
export type TerrainLookEngine = Pick<
  MapEngine,
  | "capabilities"
  | "setTerrainExaggeration"
  | "getTerrainCogSource"
  | "hasCustomTerrainSource"
  | "setTerrainCogSource"
  | "setTerrainFillOutside"
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
  map: Pick<MapPreferences, "terrainExaggeration" | "terrainSource" | "terrainFillOutside">,
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
  const fillOutside =
    source === null ? undefined : resolveTerrainFillOutside(map.terrainFillOutside, source);
  if (source === null) {
    if (!options.reset || !engine.hasCustomTerrainSource()) return;
  } else if (engine.getTerrainCogSource() === source) {
    // Already drawn: only the fill may differ, and the engine skips a no-op.
    if (fillOutside !== undefined) engine.setTerrainFillOutside?.(fillOutside);
    return;
  }
  // The fill goes with the source, so a restored DEM opens with it rather than
  // being rebuilt a second time.
  void engine
    .setTerrainCogSource(source, undefined, fillOutside === undefined ? undefined : { fillOutside })
    .catch((error: unknown) => {
      console.warn("[terrain] could not restore the project's terrain source", source, error);
    });
}
