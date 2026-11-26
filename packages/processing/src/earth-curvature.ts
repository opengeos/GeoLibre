/**
 * Earth curvature and atmospheric refraction for terrain visibility (issue
 * #3530).
 *
 * Both interactive visibility tools -- the line of sight
 * (`line-of-sight.ts`) and the viewshed (`terrain-viewshed.ts`) -- compare
 * slopes from an eye to the ground in a flat, tangent-plane frame. Over a
 * curved Earth the ground at distance `d` sits below that plane by
 * `d² / 2R`, and refraction bends the sight line back down by a fraction `k`
 * of that, so the apparent drop is `d²(1 - k) / 2R`. Lowering every elevation
 * by that drop before the comparison is the standard correction (it is what
 * GDAL's `gdal_viewshed -cc` and ArcGIS's viewshed do).
 *
 * The module lives on its own so the viewshed and the line of sight share one
 * definition without importing each other.
 */

/** Mean Earth radius in metres (IUGG). */
export const EARTH_RADIUS_METERS = 6_371_008.8;

/**
 * Standard coefficient of atmospheric refraction for visible light. Refraction
 * bends a sight line back toward the ground, so it offsets part of the
 * curvature drop. 0.13 is the ArcGIS viewshed default; GDAL's
 * `gdal_viewshed -cc` defaults to a curvature coefficient of 0.85714, which
 * is k = 1/7 (about 0.143).
 */
export const DEFAULT_REFRACTION_COEFFICIENT = 0.13;

/**
 * Bounds a refraction coefficient is clamped to. Below about -1 (strong
 * sub-refraction) or at 1 and above (the sight line bends as fast as the Earth
 * curves, so the drop vanishes or turns negative) the model stops describing a
 * real atmosphere.
 */
export const MIN_REFRACTION_COEFFICIENT = -1;
export const MAX_REFRACTION_COEFFICIENT = 0.99;

/** Bounds an Earth radius is clamped to, in metres. */
export const MIN_EARTH_RADIUS_METERS = 1_000_000;
export const MAX_EARTH_RADIUS_METERS = 100_000_000;

/** How a visibility computation models the Earth's shape. */
export interface CurvatureOptions {
  /** Model Earth curvature and refraction (default true). */
  curvature?: boolean;
  /** Refraction coefficient `k` (default {@link DEFAULT_REFRACTION_COEFFICIENT}). */
  refractionCoefficient?: number;
  /** Earth radius in metres (default {@link EARTH_RADIUS_METERS}). */
  earthRadiusMeters?: number;
}

/** A {@link CurvatureOptions} with every field filled in and clamped. */
export interface ResolvedCurvature {
  curvature: boolean;
  refractionCoefficient: number;
  earthRadiusMeters: number;
}

/**
 * Fill in and clamp curvature options.
 *
 * A non-finite coefficient or radius (an empty form field parsed to NaN) falls
 * back to the default rather than poisoning every elevation with NaN.
 *
 * @param options - The caller's options, possibly partial.
 * @returns Options safe to pass to {@link curvatureDrop}.
 */
export function resolveCurvature(options: CurvatureOptions = {}): ResolvedCurvature {
  const k = options.refractionCoefficient;
  const radius = options.earthRadiusMeters;
  return {
    curvature: options.curvature ?? true,
    refractionCoefficient:
      typeof k === "number" && Number.isFinite(k)
        ? Math.min(MAX_REFRACTION_COEFFICIENT, Math.max(MIN_REFRACTION_COEFFICIENT, k))
        : DEFAULT_REFRACTION_COEFFICIENT,
    earthRadiusMeters:
      typeof radius === "number" && Number.isFinite(radius)
        ? Math.min(MAX_EARTH_RADIUS_METERS, Math.max(MIN_EARTH_RADIUS_METERS, radius))
        : EARTH_RADIUS_METERS,
  };
}

/**
 * How far below the observer's tangent plane the ground at `distance` appears
 * to sit, once curvature and refraction are combined: `d²(1 - k) / 2R`.
 *
 * @param distance - Ground distance from the observer, in metres.
 * @param refractionCoefficient - The refraction coefficient `k`.
 * @param earthRadiusMeters - The Earth radius `R`, in metres.
 * @returns The apparent drop, in metres.
 */
export function curvatureDrop(
  distance: number,
  refractionCoefficient = DEFAULT_REFRACTION_COEFFICIENT,
  earthRadiusMeters = EARTH_RADIUS_METERS,
): number {
  return ((distance * distance) / (2 * earthRadiusMeters)) * (1 - refractionCoefficient);
}

/**
 * Distance to the apparent horizon for an eye above smooth ground:
 * `sqrt(2Rh / (1 - k))`, the inverse of {@link curvatureDrop}.
 *
 * @param eyeHeightMeters - Eye height above the ground, in metres.
 * @param refractionCoefficient - The refraction coefficient `k`.
 * @param earthRadiusMeters - The Earth radius `R`, in metres.
 * @returns The horizon distance, in metres.
 */
export function horizonDistance(
  eyeHeightMeters: number,
  refractionCoefficient = DEFAULT_REFRACTION_COEFFICIENT,
  earthRadiusMeters = EARTH_RADIUS_METERS,
): number {
  if (eyeHeightMeters <= 0) return 0;
  return Math.sqrt((2 * earthRadiusMeters * eyeHeightMeters) / (1 - refractionCoefficient));
}
