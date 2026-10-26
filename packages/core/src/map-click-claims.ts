/**
 * Map tools that own the map's clicks while they draw (the Measure control
 * placing points, the Geo Editor sketching a shape) register a claim here, and
 * the Identify click handlers stand down while any claim holds. Without it a
 * click meant as a measure vertex also opens an Identify popup over the layer
 * underneath (issue #3237).
 *
 * A claim is a predicate read at click time rather than a flag the tool sets,
 * so a tool whose drawing state changes without an event (Measure stops
 * drawing silently when its panel collapses) never leaves a stale claim.
 */
const claims = new Set<() => boolean>();

/**
 * Register a tool whose drawing state claims the map's clicks.
 *
 * Args:
 *   isClaiming: Returns true while the tool is drawing and owns map clicks.
 *
 * Returns:
 *   A function that removes the claim.
 */
export function registerMapClickClaim(isClaiming: () => boolean): () => void {
  // A fresh entry per registration, so two tools sharing one predicate keep
  // independent claims and releasing one leaves the other in place.
  const entry = () => isClaiming();
  claims.add(entry);
  return () => {
    claims.delete(entry);
  };
}

/**
 * Whether a registered map tool currently owns the map's clicks.
 *
 * Returns:
 *   True when any registered claim reports that its tool is drawing.
 */
export function isMapClickClaimed(): boolean {
  for (const isClaiming of claims) {
    try {
      if (isClaiming()) return true;
    } catch (error) {
      // A tool torn down mid-read reports no claim rather than breaking
      // Identify for every other click; warn so a broken predicate (an
      // upstream API change, say) does not fail silently.
      console.warn("[GeoLibre] A map click claim could not be read", error);
    }
  }
  return false;
}
