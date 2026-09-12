import type { GeoLibreLayer } from "@geolibre/core";

/**
 * How the Select by Expression panel decides what stays in its expression
 * textarea when the target layer changes. Kept apart from
 * `expression-inputs.ts` so it carries no map runtime dependency.
 */

/** The Select by Expression textarea plus which layer's saved filter seeded it. */
export interface SeededExpressionSource {
  /** The textarea's contents. */
  source: string;
  /** The layer whose saved filter produced `source`, or null when the user authored it. */
  seededFromLayerId: string | null;
}

/**
 * Retarget the expression textarea at another layer.
 *
 * A hand-authored expression follows the user, because re-running one against
 * a second layer is a normal thing to want. Text seeded from a layer's saved
 * filter does not follow: leaving it in place would let **Filter layer**
 * persist one layer's filter onto another that never had one.
 */
export function retargetExpressionSource(
  current: SeededExpressionSource,
  next: Pick<GeoLibreLayer, "id" | "filterExpression"> | null | undefined,
): SeededExpressionSource {
  if (next?.filterExpression?.length) {
    return {
      source: JSON.stringify(next.filterExpression, null, 2),
      seededFromLayerId: next.id,
    };
  }
  const seedBelongsElsewhere =
    current.seededFromLayerId !== null && current.seededFromLayerId !== next?.id;
  return { source: seedBelongsElsewhere ? "" : current.source, seededFromLayerId: null };
}
