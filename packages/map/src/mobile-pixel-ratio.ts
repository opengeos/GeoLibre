/**
 * Mobile WebGL pixel ratio capping (GeoLibre#3537 Phase 5).
 *
 * High-DPR smartphones (3x–4x OLED displays) allocate 9x–16x as many WebGL
 * fragments as 1x, which increases battery drain and WebGL context loss on
 * tiled maps. Capping touch devices at 2x preserves retina sharpness while
 * cutting fragment fill rate by >55% on 3x devices.
 */

export const MAX_MOBILE_PIXEL_RATIO = 2;

export function resolveMapPixelRatio(options?: {
  devicePixelRatio?: number;
  isTouchDevice?: boolean;
}): number | undefined {
  const rawDpr =
    options?.devicePixelRatio ??
    (typeof window !== "undefined" ? window.devicePixelRatio : undefined);
  if (typeof rawDpr !== "number" || !Number.isFinite(rawDpr) || rawDpr <= 0) {
    return undefined;
  }
  const touch =
    options?.isTouchDevice ??
    (typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches);
  if (!touch) return rawDpr;
  return Math.min(rawDpr, MAX_MOBILE_PIXEL_RATIO);
}
