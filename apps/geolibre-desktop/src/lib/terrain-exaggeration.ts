/**
 * Vertical-exaggeration bounds and clamp for the terrain settings dialog. Kept
 * in its own pure module (no React / map-package imports) so it can be unit
 * tested in isolation. The upper bound is a UI display choice — the terrain
 * control itself imposes no maximum.
 */

export const MIN_EXAGGERATION = 0;
export const MAX_EXAGGERATION = 5;
export const EXAGGERATION_STEP = 0.1;

/**
 * Clamp a vertical-exaggeration value to the dialog's display range. Non-finite
 * input (NaN/Infinity) falls back to the minimum rather than propagating a bad
 * value to the slider/map.
 *
 * @param value - The requested exaggeration.
 * @returns The value clamped to `[MIN_EXAGGERATION, MAX_EXAGGERATION]`.
 */
export function clampExaggeration(value: number): number {
  if (!Number.isFinite(value)) return MIN_EXAGGERATION;
  return Math.min(MAX_EXAGGERATION, Math.max(MIN_EXAGGERATION, value));
}
