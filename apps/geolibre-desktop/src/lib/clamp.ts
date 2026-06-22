/**
 * Clamp a number to the inclusive range [min, max].
 *
 * @param value - The value to clamp.
 * @param min - Lower bound.
 * @param max - Upper bound.
 * @returns `value` constrained to the range.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
