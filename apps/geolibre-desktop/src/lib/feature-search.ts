/**
 * Matches a search query against the attributes of the vector layers already
 * loaded on the map, so the Layers panel search box can find a parcel id, a
 * station code, or a well name in the data the user just added instead of only
 * geocoding place names (issue #2115).
 *
 * Kept out of the React component so the matching and its cost caps can be unit
 * tested in isolation, mirroring `coordinates.ts` and `h3-search.ts`.
 */

import {
  effectiveLayerRenderState,
  featureSelectionId,
  isInternalPopupField,
  PHOTO_PROPERTY,
  type GeoLibreLayer,
  type LayerGroup,
} from "@geolibre/core";

/**
 * How a value matched the query, in ranking order: an exact (case-insensitive)
 * equality beats a prefix, which beats a match anywhere in the value.
 */
export type FeatureMatchKind = "exact" | "prefix" | "contains";

/** Rank order for {@link FeatureMatchKind}; lower sorts first. */
const KIND_RANK: Record<FeatureMatchKind, number> = { exact: 0, prefix: 1, contains: 2 };

/** One matched feature of one layer. */
export interface FeatureSearchMatch {
  layerId: string;
  layerName: string;
  /** Selection id, the same one the attribute table and highlight overlay use. */
  featureId: string;
  /** Property whose value matched. */
  field: string;
  /** The matched value, stringified for display. */
  value: string;
  kind: FeatureMatchKind;
}

/** The matches found in one layer, ready to render as a labeled group. */
export interface FeatureSearchGroup {
  layerId: string;
  layerName: string;
  matches: FeatureSearchMatch[];
  /**
   * True when the scan stopped before reading every feature (the feature
   * ceiling or the per-layer time budget ran out), so the group is labeled as
   * partial rather than passed off as the whole answer.
   */
  truncated: boolean;
}

/** Cost caps and result limits; every field has a sensible default. */
export interface FeatureSearchOptions {
  /** Rows kept per layer. Ranking matters more than completeness here. */
  maxPerLayer?: number;
  /** Layers reported. Keeps the dropdown compact when many layers match. */
  maxLayers?: number;
  /** Features read per layer before the scan is called off as truncated. */
  maxFeaturesPerLayer?: number;
  /** Wall-clock budget per layer, in milliseconds. */
  layerBudgetMs?: number;
  /**
   * Wall-clock budget for the whole call, in milliseconds. Bounds the cost of a
   * project with many large layers, where the per-layer budget alone would let
   * the total grow with the layer count.
   */
  totalBudgetMs?: number;
  /** The project's layer groups, so group visibility can be folded in. */
  groups?: LayerGroup[];
  /** Clock source, injectable so the budget can be exercised in tests. */
  now?: () => number;
}

/** Don't scan the data for a query shorter than this; everything matches. */
export const MIN_FEATURE_QUERY_LENGTH = 2;

const DEFAULT_MAX_PER_LAYER = 5;
const DEFAULT_MAX_LAYERS = 4;
const DEFAULT_MAX_FEATURES_PER_LAYER = 50_000;
const DEFAULT_LAYER_BUDGET_MS = 40;
const DEFAULT_TOTAL_BUDGET_MS = 120;
/**
 * Features scanned between two clock reads: `now()` is not free either. The
 * budgets are therefore best-effort to within this many features, not hard
 * ceilings — a small enough window that a layer with wide property sets cannot
 * overrun a budget by much, and still one clock read per hundred-odd features.
 */
const BUDGET_CHECK_INTERVAL = 128;

/**
 * Render a property value as the string the query is matched against.
 *
 * Strings pass through; numbers (finite only), booleans, and bigints are
 * stringified so a numeric id or a boolean flag is searchable. Everything else
 * (null, nested objects, arrays) has no useful text form here and is skipped.
 *
 * @param value A raw GeoJSON property value.
 * @returns The searchable text, or null when the value is not searchable.
 */
export function searchableText(value: unknown): string | null {
  if (typeof value === "string") {
    // A data URL is an embedded blob, not text: matching it wastes the scan on
    // megabytes of base64, and a base64 alphabet makes a two-character query
    // hit almost every one of them, which would put the whole blob in a row.
    // The scheme is case-insensitive, so `DATA:` is the same blob.
    return value.slice(0, 5).toLowerCase() === "data:" ? null : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean" || typeof value === "bigint") return String(value);
  return null;
}

/**
 * Classify how `haystack` matches an already-lowercased `needle`.
 *
 * @param haystack The candidate value, lowercased by the caller.
 * @param needle The lowercased query.
 * @returns The match kind, or null when the value does not contain the query.
 */
function classify(haystack: string, needle: string): FeatureMatchKind | null {
  if (haystack === needle) return "exact";
  if (haystack.startsWith(needle)) return "prefix";
  return haystack.includes(needle) ? "contains" : null;
}

/**
 * Whether a layer's attributes can be searched: it has to carry its features
 * locally. Tile-backed sources (vector tiles, PMTiles, MBTiles) hold nothing in
 * the store, so they are skipped rather than reported as empty. Hidden layers
 * are skipped too — flying to a feature the user turned off would show only the
 * highlight overlay hovering over nothing.
 *
 * Visibility is the *effective* one: `layer.visible` is a raw per-layer flag
 * that a hidden parent group never writes to, so the group chain is folded in
 * the way every renderer does it, and a layer inside a hidden group counts as
 * hidden.
 *
 * @param layer A store layer.
 * @param groups The project's layer groups, as an array or a prebuilt id → group
 *   map. Omit when the project has none.
 * @returns True when the layer's own features can be matched.
 */
export function isSearchableLayer(
  layer: GeoLibreLayer,
  groups: LayerGroup[] | ReadonlyMap<string, LayerGroup> = [],
): boolean {
  if ((layer.geojson?.features?.length ?? 0) === 0) return false;
  return effectiveLayerRenderState(layer, groups).visible;
}

/**
 * Fields excluded from matching: a field the user marked "hidden" or
 * "excluded" in the attribute table should not resurface through search.
 *
 * @param layer A store layer.
 * @returns The set of property names to skip; empty when nothing is marked.
 */
function skippedFields(layer: GeoLibreLayer): Set<string> {
  const visibility = layer.fieldVisibility;
  if (!visibility) return new Set();
  return new Set(
    Object.entries(visibility)
      .filter(([, state]) => state === "hidden" || state === "excluded")
      .map(([field]) => field),
  );
}

/**
 * Search one layer's features for `needle` (already trimmed and lowercased).
 *
 * A feature is reported once, on its best-ranked field, so one row never
 * repeats because two of its columns carry the same text. The scan stops early
 * once it holds `maxPerLayer` exact matches (nothing found later could rank
 * higher), and is called off as truncated when it exhausts the feature ceiling
 * or the time budget.
 *
 * @param layer The layer to scan.
 * @param needle The lowercased query.
 * @param options Cost caps and limits.
 * @returns The layer's group, or null when nothing matched.
 */
function searchLayer(
  layer: GeoLibreLayer,
  needle: string,
  options: {
    maxPerLayer: number;
    maxFeaturesPerLayer: number;
    layerBudgetMs: number;
    now: () => number;
  },
): FeatureSearchGroup | null {
  const { maxPerLayer, maxFeaturesPerLayer, layerBudgetMs, now } = options;
  const features = layer.geojson?.features ?? [];
  const skip = skippedFields(layer);
  const best = new Map<string, FeatureSearchMatch>();
  const started = now();
  let exactCount = 0;
  let scanned = 0;
  let truncated = false;

  for (let index = 0; index < features.length; index += 1) {
    if (scanned >= maxFeaturesPerLayer) {
      truncated = true;
      break;
    }
    // Check after the first feature as well as every interval: a layer smaller
    // than one interval would otherwise never have its budget enforced at all,
    // however expensive its property sets are.
    if (
      scanned > 0 &&
      (scanned === 1 || scanned % BUDGET_CHECK_INTERVAL === 0) &&
      now() - started > layerBudgetMs
    ) {
      truncated = true;
      break;
    }
    scanned += 1;

    const feature = features[index];
    const properties = feature.properties;
    if (!properties) continue;
    const featureId = featureSelectionId(feature, index);

    for (const [field, raw] of Object.entries(properties)) {
      // `isInternalPopupField` is the codebase's existing answer to "not a field
      // the user authored" (`photo_full`, `__geolibre_*`); `photo` is a real
      // field but holds a thumbnail data URL, so it is no more searchable.
      if (skip.has(field) || field === PHOTO_PROPERTY || isInternalPopupField(field)) continue;
      const text = searchableText(raw);
      if (text === null) continue;
      const kind = classify(text.toLowerCase(), needle);
      if (!kind) continue;
      const previous = best.get(featureId);
      // A previous match of equal or better rank stands, so nothing reaching
      // past this guard can be downgrading an exact match: `exactCount` only
      // ever counts up.
      if (previous && KIND_RANK[previous.kind] <= KIND_RANK[kind]) continue;
      if (kind === "exact") exactCount += 1;
      best.set(featureId, {
        layerId: layer.id,
        layerName: layer.name,
        featureId,
        field,
        value: text,
        kind,
      });
    }
    // Enough exact matches to fill the group: no later feature can outrank them.
    if (exactCount >= maxPerLayer) {
      truncated = index < features.length - 1;
      break;
    }
  }

  if (best.size === 0) return null;
  // Rows dropped by the row cap make the group partial just as surely as a scan
  // that ran out of budget: the layer holds matches this group does not show.
  if (best.size > maxPerLayer) truncated = true;
  // Within a rank, the shorter value is the closer match ("India" before
  // "Indonesia" for "ind"), which matters because only a handful of rows
  // survive the cap. Ties keep the layer's own order: Map preserves insertion
  // (feature) order and sort is stable.
  const matches = Array.from(best.values())
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.value.length - b.value.length)
    .slice(0, maxPerLayer);
  return { layerId: layer.id, layerName: layer.name, matches, truncated };
}

/** A feature a search row selected: enough to recognize it again later. */
export interface OwnedSelection {
  layerId: string;
  featureId: string;
}

/**
 * Whether the live selection is still the single feature a search row put
 * there. The selection is app-wide — the attribute table and the map's own
 * click-select write the same state — so the search box may only take back a
 * selection that is still, exactly, its own.
 *
 * @param owned The feature a search row selected, or null if none did.
 * @param selection The store's current selection state.
 * @returns True when clearing the selection would clear only that feature.
 */
export function holdsOwnedSelection(
  owned: OwnedSelection | null,
  selection: { selectedLayerId: string | null; selectedFeatureIds: readonly string[] },
): boolean {
  if (!owned) return false;
  return (
    selection.selectedLayerId === owned.layerId &&
    selection.selectedFeatureIds.length === 1 &&
    selection.selectedFeatureIds[0] === owned.featureId
  );
}

/**
 * Search every searchable layer's attributes for `query`.
 *
 * Runs entirely on data already in the store, so it is independent of the
 * geocoder's network call and its results can be shown before the geocoder
 * answers. Layers are scanned in the order given (the layer panel's order, top
 * layer first), each capped on its own so one huge layer cannot starve the
 * rest, and the whole call is capped again by `totalBudgetMs` so the cost does
 * not grow with the number of loaded layers — a layer that matches nothing
 * still costs its scan, and a project can hold many of them.
 *
 * @param layers The store's layers.
 * @param query The raw typed query.
 * @param options Cost caps and limits.
 * @returns One group per matching layer, in layer order.
 */
export function searchLayerFeatures(
  layers: readonly GeoLibreLayer[],
  query: string,
  options: FeatureSearchOptions = {},
): FeatureSearchGroup[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < MIN_FEATURE_QUERY_LENGTH) return [];
  const maxLayers = options.maxLayers ?? DEFAULT_MAX_LAYERS;
  const layerBudgetMs = options.layerBudgetMs ?? DEFAULT_LAYER_BUDGET_MS;
  const totalBudgetMs = options.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  // Build the group map once: folding it per layer would rebuild it per layer.
  const groupById = new Map((options.groups ?? []).map((group) => [group.id, group]));
  const started = now();

  const groups: FeatureSearchGroup[] = [];
  for (const layer of layers) {
    if (groups.length >= maxLayers) break;
    const remaining = totalBudgetMs - (now() - started);
    if (remaining <= 0) break;
    if (!isSearchableLayer(layer, groupById)) continue;
    const group = searchLayer(layer, needle, {
      maxPerLayer: options.maxPerLayer ?? DEFAULT_MAX_PER_LAYER,
      maxFeaturesPerLayer: options.maxFeaturesPerLayer ?? DEFAULT_MAX_FEATURES_PER_LAYER,
      // Never let one layer spend more than the call has left.
      layerBudgetMs: Math.min(layerBudgetMs, remaining),
      now,
    });
    if (group) groups.push(group);
  }
  return groups;
}
