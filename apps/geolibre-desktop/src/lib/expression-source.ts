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
 * Text the user wrote is never thrown away: re-running an authored expression
 * against a second layer is a normal thing to want, and silently replacing a
 * half-written one with the target's saved filter would lose work. So the
 * target's filter is seeded only into an empty textarea or over a previous
 * seed. Conversely a seed does not follow the user to a layer that has no
 * filter of its own, or **Filter layer** would persist one layer's filter onto
 * another that never had one.
 */
export function retargetExpressionSource(
  current: SeededExpressionSource,
  next: Pick<GeoLibreLayer, "id" | "filterExpression"> | null | undefined,
): SeededExpressionSource {
  const authored = current.seededFromLayerId === null && current.source.trim().length > 0;
  if (next?.filterExpression?.length) {
    if (authored) return current;
    return {
      source: JSON.stringify(next.filterExpression, null, 2),
      seededFromLayerId: next.id,
    };
  }
  const seedBelongsElsewhere =
    current.seededFromLayerId !== null && current.seededFromLayerId !== next?.id;
  return { source: seedBelongsElsewhere ? "" : current.source, seededFromLayerId: null };
}
