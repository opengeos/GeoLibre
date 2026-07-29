import {
  chooseGraduatedProperty,
  getPropertyValues,
  isCategoricalProperty,
  type ClassifiableLayer,
} from "./vector-style-classification";

/**
 * One-click styling offers derived from a layer's own data (issue #1519).
 *
 * A newly added layer arrives with single-symbol styling, and turning that into
 * a useful map means knowing which column to classify by — a decision the data
 * can usually make for itself. These suggestions are built from the same
 * predicates the Style panel already uses to pre-select an attribute when the
 * user picks a renderer by hand, so the shortcut and the manual path never
 * disagree about what a good field is.
 */

/** A renderer offered for a layer, with the attribute it would classify by. */
export interface StyleSuggestion {
  kind: "categorized" | "graduated" | "heatmap";
  /** Attribute to classify by; unset for the heatmap suggestion. */
  property?: string;
}

/** Feature count above which a point layer reads better as a density surface. */
export const HEATMAP_SUGGESTION_MIN_FEATURES = 200;

/**
 * Column names that are numeric but carry no magnitude worth mapping —
 * identifiers and timestamps. Classifying by them produces a legend of epoch
 * milliseconds or row numbers.
 */
const UNMAPPABLE_NAME = /(^|[_\s-])(id|fid|gid|oid|objectid|uid|uuid|key|index)$/i;
const TIMESTAMP_NAME = /(^|[_\s-])(time|timestamp|datetime|date|updated|created|epoch|at)$/i;

/**
 * Insert a separator at every camelCase boundary so the name patterns above see
 * `featureId` and `createdAt` the same way they see `feature_id` and
 * `created_at`. Matching those suffixes without a boundary would swallow
 * ordinary words — `grid` ends in "id", `candidate` ends in "date".
 */
function separateCamelCase(property: string): string {
  return property.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
}

/**
 * Share of distinct values above which a column is treated as an identifier
 * regardless of its name: a value per feature classifies into noise.
 */
const NEAR_UNIQUE_RATIO = 0.9;
/** Below this many features, a high distinct ratio is just a small sample. */
const NEAR_UNIQUE_MIN_FEATURES = 20;

/** True when a column's values are so nearly all-distinct it behaves as an id. */
function isNearUnique(layer: ClassifiableLayer, property: string): boolean {
  const values = getPropertyValues(layer, property);
  if (values.length < NEAR_UNIQUE_MIN_FEATURES) return false;
  return new Set(values.map(String)).size / values.length > NEAR_UNIQUE_RATIO;
}

/**
 * Columns worth *recommending* a classification on.
 *
 * A suggestion is held to a higher bar than the manual dropdown's pre-selection:
 * offering "Graduate by time" on a feed whose `time` column is epoch
 * milliseconds is worse than offering nothing, because it reads as advice. The
 * manual path keeps its existing behavior — this filter only narrows what the
 * panel volunteers.
 */
function mappableProperties(layer: ClassifiableLayer, properties: string[]): string[] {
  return properties.filter((property) => {
    const normalized = separateCamelCase(property);
    return (
      !UNMAPPABLE_NAME.test(normalized) &&
      !TIMESTAMP_NAME.test(normalized) &&
      !isNearUnique(layer, property)
    );
  });
}

/** The layer shape a suggestion is derived from. */
export type SuggestableLayer = ClassifiableLayer & {
  geojson?: { features?: unknown[] };
};

/**
 * Suggest up to three renderers for a layer, best first.
 *
 * @param layer - The layer to inspect; its GeoJSON supplies the values.
 * @param properties - Attribute names the symbology controls offer.
 * @param options - `supportsPointRenderer` gates the heatmap offer to layers
 *   where the heatmap/cluster renderers actually apply (point-only layers).
 * @returns Suggestions in display order; empty when nothing fits.
 */
export function buildStyleSuggestions(
  layer: SuggestableLayer,
  properties: string[],
  options: { supportsPointRenderer: boolean },
): StyleSuggestion[] {
  const suggestions: StyleSuggestion[] = [];
  const candidates = mappableProperties(layer, properties);

  // Categorized first: a low-cardinality label is what a reader most often
  // wants a map colored by, and it needs no scale to interpret.
  const categorical = candidates.find((property) => isCategoricalProperty(layer, property));
  if (categorical) suggestions.push({ kind: "categorized", property: categorical });

  // No fallback to the unfiltered list: when every numeric column is an id or a
  // timestamp, offering none is better than recommending a meaningless one.
  const numeric = chooseGraduatedProperty(layer, candidates);
  if (numeric) suggestions.push({ kind: "graduated", property: numeric });

  if (
    options.supportsPointRenderer &&
    (layer.geojson?.features?.length ?? 0) >= HEATMAP_SUGGESTION_MIN_FEATURES
  ) {
    suggestions.push({ kind: "heatmap" });
  }

  return suggestions;
}
