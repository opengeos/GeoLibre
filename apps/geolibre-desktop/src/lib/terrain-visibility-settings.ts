import {
  DEFAULT_REFRACTION_COEFFICIENT,
  EARTH_RADIUS_METERS,
  resolveCurvature,
  type ResolvedCurvature,
} from "@geolibre/processing";
import { create } from "zustand";

/**
 * The Earth model shared by the interactive Line of Sight panel and the
 * right-click viewshed (issue #3530).
 *
 * Both tools answer "what can I see from here" against the same terrain, so
 * they must agree on whether the Earth is curved and how much the air bends
 * the sight line; a line of sight that sees a peak the viewshed hides would be
 * a contradiction. The settings are device-local, like the map chrome
 * preferences: they describe how this person likes to analyse, not the
 * project's data, so nothing here is saved with a project.
 */

const STORAGE_KEY = "geolibre:terrain-visibility";

/** The defaults: curvature on, k = 0.13, the IUGG mean Earth radius. */
export const DEFAULT_TERRAIN_VISIBILITY: ResolvedCurvature = {
  curvature: true,
  refractionCoefficient: DEFAULT_REFRACTION_COEFFICIENT,
  earthRadiusMeters: EARTH_RADIUS_METERS,
};

/**
 * Read the stored settings, clamping anything out of range.
 *
 * @returns The stored settings, or the defaults when storage is empty,
 *   malformed, or blocked.
 */
export function readTerrainVisibility(): ResolvedCurvature {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      return { ...DEFAULT_TERRAIN_VISIBILITY };
    }
    const value = stored as Record<string, unknown>;
    return resolveCurvature({
      curvature: typeof value.curvature === "boolean" ? value.curvature : undefined,
      refractionCoefficient:
        typeof value.refractionCoefficient === "number" ? value.refractionCoefficient : undefined,
      earthRadiusMeters:
        typeof value.earthRadiusMeters === "number" ? value.earthRadiusMeters : undefined,
    });
  } catch {
    return { ...DEFAULT_TERRAIN_VISIBILITY };
  }
}

function writeTerrainVisibility(settings: ResolvedCurvature): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Blocked or full storage must not stop the analysis from running.
  }
}

interface TerrainVisibilityState extends ResolvedCurvature {
  /**
   * Merge a change into the settings, clamp it, and remember it.
   *
   * @param patch - The fields to change.
   */
  update: (patch: Partial<ResolvedCurvature>) => void;
  /** Restore the defaults. */
  reset: () => void;
}

export const useTerrainVisibility = create<TerrainVisibilityState>((set, get) => ({
  ...readTerrainVisibility(),
  update: (patch) => {
    const { curvature, refractionCoefficient, earthRadiusMeters } = get();
    // `??` per field rather than a spread, so a key passed as undefined
    // keeps the stored value instead of resetting it to the default.
    const next = resolveCurvature({
      curvature: patch.curvature ?? curvature,
      refractionCoefficient: patch.refractionCoefficient ?? refractionCoefficient,
      earthRadiusMeters: patch.earthRadiusMeters ?? earthRadiusMeters,
    });
    writeTerrainVisibility(next);
    set(next);
  },
  reset: () => {
    writeTerrainVisibility(DEFAULT_TERRAIN_VISIBILITY);
    set({ ...DEFAULT_TERRAIN_VISIBILITY });
  },
}));

/**
 * The current settings as a plain object, for non-React callers such as the
 * viewshed runner.
 *
 * @returns A snapshot of the curvature model.
 */
export function getTerrainVisibility(): ResolvedCurvature {
  const { curvature, refractionCoefficient, earthRadiusMeters } = useTerrainVisibility.getState();
  return { curvature, refractionCoefficient, earthRadiusMeters };
}
