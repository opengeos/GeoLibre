import type { LayerLevelFilter, LevelFilterMode } from "./types";

/**
 * Floor picker (issue #3341): the levels a multi-floor layer holds, and the
 * filter that draws one floor (or one floor and those below it).
 *
 * Indoor data stores the floor in many shapes. OpenStreetMap's `level` tag is
 * text and may name several floors (`"0;1"`) or a span (`"-1-2"`); IMDF stores
 * a numeric `ordinal`; other exports use a plain number. Rather than compile a
 * MapLibre expression that tries to parse all of these (string splitting has
 * no expression operator, and `to-number` throws on `"0;1"`), the picker
 * resolves the choice against the layer's features once and stores the raw
 * values that match. The compiled filter is then a plain `in` test, which
 * MapLibre, Mapbox, Cesium and ArcGIS all evaluate with the same style-spec
 * code.
 */

/** One floor as the picker lists it. */
export interface LevelEntry {
  /** Canonical label: a number's shortest form (`"1"` for `"01"`), or the trimmed text. */
  label: string;
  /** The floor's number, or `null` for a named floor such as `"G"`. */
  ordinal: number | null;
  /** How many features sit on this floor (a multi-level feature counts once per floor). */
  count: number;
}

/** A feature as far as level parsing needs it. */
interface LevelFeature {
  properties?: Record<string, unknown> | null;
}

/** Field names that usually hold a floor, in preference order (compared case-insensitively). */
const LEVEL_FIELD_CANDIDATES = [
  "level",
  "ordinal",
  "floor",
  "level_ordinal",
  "floor_number",
  "floornumber",
  "floor_no",
  "storey",
  "story",
  "etage",
  "level_name",
];

const NUMBER = /^-?\d+(?:\.\d+)?$/;
const RANGE = /^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/;
/** A range wider than this is read as its two ends, not every floor between. */
const MAX_RANGE_STEPS = 200;

/** A parsed floor token: its canonical label and number. */
interface LevelToken {
  label: string;
  ordinal: number | null;
}

function numericToken(value: number): LevelToken {
  return { label: String(value), ordinal: value };
}

/**
 * Parse one attribute value into the floors it names.
 *
 * Numbers are taken as they are. Text is split on `;` (OSM's list separator),
 * each part read as a number, an integer span such as `0-2` or `-2--1`
 * (expanded to every floor it covers), or kept as a named floor.
 *
 * @param raw - The attribute value.
 * @returns The floors it names, possibly empty (for `null`, booleans, blanks).
 */
export function parseLevelValue(raw: unknown): LevelToken[] {
  if (typeof raw === "number") return Number.isFinite(raw) ? [numericToken(raw)] : [];
  if (typeof raw !== "string") return [];
  const tokens: LevelToken[] = [];
  for (const part of raw.split(";")) {
    const text = part.trim();
    if (!text) continue;
    if (NUMBER.test(text)) {
      tokens.push(numericToken(Number(text)));
      continue;
    }
    const range = RANGE.exec(text);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      // Safe integers only: past 2^53, `level += 1` no longer advances.
      if (Number.isSafeInteger(lo) && Number.isSafeInteger(hi) && hi - lo <= MAX_RANGE_STEPS) {
        for (let level = lo; level <= hi; level += 1) tokens.push(numericToken(level));
      } else {
        tokens.push(numericToken(lo), numericToken(hi));
      }
      continue;
    }
    tokens.push({ label: text, ordinal: null });
  }
  return tokens;
}

/** The ordinal of a picker label: its number, or `null` for a named floor. */
function labelOrdinal(label: string): number | null {
  return NUMBER.test(label.trim()) ? Number(label) : null;
}

/**
 * Whether a feature's level value falls on the chosen floor.
 *
 * @param raw - The feature's level attribute.
 * @param level - The chosen floor's label.
 * @param mode - `only` matches that floor; `below` also matches every
 *   numbered floor under it (a named floor matches only itself). `all`
 *   matches everything.
 * @returns True when the feature should be drawn.
 */
export function levelValueMatches(raw: unknown, level: string, mode: LevelFilterMode): boolean {
  if (mode === "all") return true;
  const tokens = parseLevelValue(raw);
  const target = labelOrdinal(level);
  const label = target === null ? level.trim() : String(target);
  return tokens.some((token) => {
    if (token.label === label) return true;
    return mode === "below" && target !== null && token.ordinal !== null && token.ordinal <= target;
  });
}

/**
 * Order floors top down, the way a building directory or lift panel lists
 * them: numbered floors from highest to lowest, then named floors by name.
 */
function compareLevels(a: LevelEntry, b: LevelEntry): number {
  if (a.ordinal !== null && b.ordinal !== null) return b.ordinal - a.ordinal;
  if (a.ordinal !== null) return -1;
  if (b.ordinal !== null) return 1;
  return a.label.localeCompare(b.label);
}

/**
 * The distinct floors a set of features holds in one field, top floor first.
 *
 * @param features - The layer's features.
 * @param field - The property holding the floor.
 * @returns One entry per floor with its feature count.
 */
export function collectLevels(
  features: readonly LevelFeature[] | null | undefined,
  field: string,
): LevelEntry[] {
  const byLabel = new Map<string, LevelEntry>();
  for (const feature of features ?? []) {
    const seen = new Set<string>();
    for (const token of parseLevelValue(feature?.properties?.[field])) {
      if (seen.has(token.label)) continue;
      seen.add(token.label);
      const entry = byLabel.get(token.label);
      if (entry) entry.count += 1;
      else byLabel.set(token.label, { label: token.label, ordinal: token.ordinal, count: 1 });
    }
  }
  return [...byLabel.values()].sort(compareLevels);
}

/**
 * Merge the floor lists of several layers into one, top floor first, summing
 * the counts of a floor that appears in more than one layer.
 *
 * @param lists - One {@link collectLevels} result per linked layer.
 * @returns The combined floor list.
 */
export function mergeLevels(lists: readonly (readonly LevelEntry[])[]): LevelEntry[] {
  const byLabel = new Map<string, LevelEntry>();
  for (const list of lists) {
    for (const entry of list) {
      const existing = byLabel.get(entry.label);
      if (existing) existing.count += entry.count;
      else byLabel.set(entry.label, { ...entry });
    }
  }
  return [...byLabel.values()].sort(compareLevels);
}

/**
 * The distinct raw values of `field` that match a floor choice, in first-seen
 * order. These are what {@link compileLevelFilter} tests with `in`.
 *
 * @param features - The layer's features.
 * @param field - The property holding the floor.
 * @param level - The chosen floor's label.
 * @param mode - The floor picker mode.
 * @returns The matching values (strings and numbers kept as stored).
 */
export function matchingLevelValues(
  features: readonly LevelFeature[] | null | undefined,
  field: string,
  level: string,
  mode: LevelFilterMode,
): (string | number)[] {
  const values: (string | number)[] = [];
  const checked = new Set<string | number>();
  for (const feature of features ?? []) {
    const raw = feature?.properties?.[field];
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    if (checked.has(raw)) continue;
    checked.add(raw);
    if (levelValueMatches(raw, level, mode)) values.push(raw);
  }
  return values;
}

/**
 * Apply a floor choice to a layer's link, resolving the matching values from
 * the layer's features.
 *
 * Without features (a tile-backed layer, or data not loaded yet) the values
 * stay unresolved, which draws every floor, rather than resolving to an empty
 * list that would hide the layer once its data arrives.
 *
 * @param filter - The layer's current link.
 * @param features - The layer's features, or `null`/`undefined` when none are loaded.
 * @param level - The chosen floor's label, or `null` for every floor.
 * @param mode - The floor picker mode.
 * @returns The updated link.
 */
export function selectLevel(
  filter: LayerLevelFilter,
  features: readonly LevelFeature[] | null | undefined,
  level: string | null,
  mode: LevelFilterMode,
): LayerLevelFilter {
  if (level === null || mode === "all") {
    return { field: filter.field, mode: "all", level: null };
  }
  if (!features) return { field: filter.field, mode, level };
  return {
    field: filter.field,
    mode,
    level,
    values: matchingLevelValues(features, filter.field, level, mode),
  };
}

/** The floor shown by the picker: a level (`null` for every floor) and a mode. */
export interface LevelChoice {
  level: string | null;
  mode: LevelFilterMode;
}

/** A layer as far as the floor picker reads it. */
interface LevelLinkedLayer {
  id: string;
  levelFilter?: LayerLevelFilter;
  geojson?: { features: readonly LevelFeature[] } | null;
}

/**
 * The floor choice the picker shows: the first linked layer that has a floor
 * chosen, so a layer linked later (still on `all`) does not reset the display.
 *
 * @param linked - The linked layers.
 * @returns The chosen level and mode, or every floor.
 */
export function currentLevelChoice(linked: readonly LevelLinkedLayer[]): LevelChoice {
  for (const layer of linked) {
    const link = layer.levelFilter;
    if (link && link.mode && link.mode !== "all" && typeof link.level === "string") {
      return { level: link.level, mode: link.mode };
    }
  }
  return { level: null, mode: "all" };
}

/**
 * Whether two links store the same choice, independent of key order (a
 * project written by the Python API may order the keys differently).
 *
 * @param a - One link.
 * @param b - The other.
 * @returns True when they draw the same features.
 */
export function sameLevelLink(a: LayerLevelFilter, b: LayerLevelFilter): boolean {
  if (a.field !== b.field) return false;
  if ((a.mode ?? "all") !== (b.mode ?? "all")) return false;
  if ((a.level ?? null) !== (b.level ?? null)) return false;
  const av = a.values;
  const bv = b.values;
  // A hand-edited project can hold anything in `values`; never throw on it.
  if (!Array.isArray(av) || !Array.isArray(bv)) return av === bv;
  return av.length === bv.length && av.every((value, index) => value === bv[index]);
}

/** Resolved links per feature array and choice, so an unrelated layer edit does not rescan. */
const resolvedLinks = new WeakMap<object, Map<string, LayerLevelFilter>>();

/** {@link selectLevel}, memoized on the feature array (replaced whenever the data changes). */
function cachedSelectLevel(
  link: LayerLevelFilter,
  features: readonly LevelFeature[] | null | undefined,
  choice: LevelChoice,
): LayerLevelFilter {
  if (!features) return selectLevel(link, features, choice.level, choice.mode);
  const key = JSON.stringify([link.field, choice.level, choice.mode]);
  let byChoice = resolvedLinks.get(features);
  if (!byChoice) {
    byChoice = new Map();
    resolvedLinks.set(features, byChoice);
  }
  let next = byChoice.get(key);
  if (!next) {
    next = selectLevel(link, features, choice.level, choice.mode);
    byChoice.set(key, next);
  }
  return next;
}

/**
 * The link updates that put every linked layer on one floor choice, with the
 * matching values resolved from each layer's own features: a layer linked
 * after a floor was chosen, a project written without the values (the Python
 * API without inline data), or data that changed since the choice was made.
 *
 * @param linked - The linked layers.
 * @param choice - The floor to apply; defaults to {@link currentLevelChoice}.
 * @returns One update per layer whose stored link differs.
 */
export function resolveLevelLinks(
  linked: readonly LevelLinkedLayer[],
  choice: LevelChoice = currentLevelChoice(linked),
): { id: string; levelFilter: LayerLevelFilter }[] {
  const updates: { id: string; levelFilter: LayerLevelFilter }[] = [];
  for (const layer of linked) {
    const link = layer.levelFilter;
    if (!link) continue;
    const next = cachedSelectLevel(link, layer.geojson?.features, choice);
    if (!sameLevelLink(link, next)) updates.push({ id: layer.id, levelFilter: next });
  }
  return updates;
}

/**
 * Whether a link narrows the layer: a floor is chosen and its values resolved.
 *
 * @param filter - The layer's link, if any.
 * @returns True when {@link compileLevelFilter} would return a filter.
 */
export function isLevelFilterActive(filter: LayerLevelFilter | null | undefined): boolean {
  return (
    !!filter &&
    typeof filter.field === "string" &&
    filter.field.length > 0 &&
    (filter.mode === "only" || filter.mode === "below") &&
    typeof filter.level === "string" &&
    Array.isArray(filter.values)
  );
}

/**
 * Compile a floor picker link into a MapLibre filter expression.
 *
 * @param filter - The layer's link, if any.
 * @returns An `in` test over the resolved values, or `null` when every floor
 *   is drawn (no link, `all` mode, no floor chosen, or values unresolved).
 */
export function compileLevelFilter(filter: LayerLevelFilter | null | undefined): unknown[] | null {
  if (!isLevelFilterActive(filter)) return null;
  const values = (filter!.values ?? []).filter(
    (value) => typeof value === "string" || (typeof value === "number" && Number.isFinite(value)),
  );
  return ["in", ["get", filter!.field], ["literal", values]];
}

/**
 * Guess which field holds the floor.
 *
 * @param fields - The layer's field names.
 * @returns The best candidate, or `null` when none looks like a floor field.
 */
export function guessLevelField(fields: readonly string[]): string | null {
  const byLower = new Map<string, string>();
  for (const field of fields) {
    const lower = field.toLowerCase();
    if (!byLower.has(lower)) byLower.set(lower, field);
  }
  for (const candidate of LEVEL_FIELD_CANDIDATES) {
    const field = byLower.get(candidate);
    if (field) return field;
  }
  return null;
}
