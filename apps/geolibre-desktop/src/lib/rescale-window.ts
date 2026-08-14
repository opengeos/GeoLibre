/**
 * The rescale window a pair of min/max fields currently describes.
 *
 * A renderer's rescale is a *pair*: it takes a full `[min, max]` or
 * auto-stretches. Its own module so the pair rule is testable — filling in the
 * end the user has not typed is the obvious-looking shortcut, and it silently
 * copies the typed value onto the empty end (entering a max of 255 also setting
 * the min to 255).
 */

/** Renders a bound for its field: empty when that end is unset. */
export function boundText(value: number | null): string {
  return value == null ? "" : String(value);
}

/**
 * Reads a bound from its field.
 *
 * @param text - The raw field value.
 * @returns The bound, or null when the field is empty or not yet a number.
 */
export function parseBound(text: string): number | null {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * The window the two fields describe together.
 *
 * @param minText - The min field's text.
 * @param maxText - The max field's text.
 * @returns The `[min, max]` window, or null while either end is missing — the
 *   layer auto-stretches until both are present rather than being given a
 *   bound the user never typed.
 */
export function nextRescaleWindow(minText: string, maxText: string): [number, number] | null {
  const low = parseBound(minText);
  const high = parseBound(maxText);
  if (low == null || high == null) return null;
  return [low, high];
}
