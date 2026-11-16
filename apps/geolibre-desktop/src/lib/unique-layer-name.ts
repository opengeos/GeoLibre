/**
 * Unique names for processing outputs (issue #3472).
 *
 * Running a tool twice used to add two layers with the same name ("Buffer",
 * "Select by value", "<image> objects"), which the Layers panel, the layer
 * pickers and the attribute table cannot tell apart. A repeated output now gets
 * the next free numeric suffix: "Buffer", "Buffer (2)", "Buffer (3)".
 */

/**
 * Return `base` when no existing layer uses it, otherwise `base (n)` with the
 * smallest `n >= 2` that is free.
 *
 * Names compare case-sensitively after trimming, matching how the Layers panel
 * shows them. A base that already ends in a suffix is numbered as is, so a run
 * of a tool on "Buffer (2)" gives "Buffer (2) (2)" rather than colliding.
 *
 * @param base The name the tool would give its output.
 * @param layers The current layers (anything with a `name`).
 * @returns A name no layer in `layers` carries.
 */
export function uniqueLayerName(base: string, layers: Iterable<{ name: string }>): string {
  const taken = new Set<string>();
  for (const layer of layers) taken.add(layer.name.trim());
  const trimmed = base.trim();
  if (!taken.has(trimmed)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${trimmed} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}
