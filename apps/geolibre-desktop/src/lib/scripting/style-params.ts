/**
 * Normalize a `style` command param into a layer-style patch.
 *
 * The Python notebook client collects style kwargs with `**style`, so it always
 * sends a `style` object — `{}` when the caller passed none. Applying an empty
 * patch would still call `setLayerStyle`, which rebuilds the layer object and
 * pushes a no-op undo entry, so a plain `add_geojson(gdf, name=…)` would cost
 * two undo steps instead of one. Returning `null` for anything that isn't a
 * non-empty plain object lets callers skip the store write entirely.
 *
 * @param value - The raw `style` param, from an untrusted command payload.
 * @returns The patch to merge, or `null` when there is nothing to apply.
 */
export function styleParamPatch(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const style = value as Record<string, unknown>;
  return Object.keys(style).length > 0 ? style : null;
}
