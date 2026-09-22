/**
 * Substring search over the Whitebox tool catalog.
 *
 * Two places search those ~1,000 tools by text — the Whitebox toolbox dialog's
 * filter box and the assistant's `list_whitebox_tools` — and both want the same
 * rule, so it lives here once.
 *
 * The rule has two halves. **Match names and summaries, but never let a summary
 * match outrank a name match**, and **within the name matches, put the tool
 * actually called that first.**
 *
 * The first half is what lets "speckle" find the four SAR filters, none of
 * which say so in their name — before the catalog carried summaries that search
 * returned nothing at all. But a summary is a paragraph, so a common word hits
 * dozens of tools: matching name and summary in one joined string leaves the
 * results in catalog order with nothing to separate the tool called Slope from
 * the forty that mention slope in passing. Measured against the shipped
 * catalog, that put the Slope tool 47th of 51 hits for "slope", and 15th of 18
 * for "watershed".
 *
 * The second half is what the first does not fix. Splitting names from
 * summaries restored Slope to 20th of 21 — the rank it held before the catalog
 * carried summaries at all — which is still buried behind every tool whose name
 * merely contains the word (Average Flowpath Slope, Downslope Index, …). So the
 * name matches are themselves tiered: a tool whose id or label *is* the query
 * leads, then the ones it is a prefix of, then the rest in catalog order.
 * Searching "slope", "watershed" or "aspect" now reaches the tool of that name
 * first instead of 20th, 12th and 2nd.
 *
 * Ranking reads {@link WhiteboxToolText.identifiers} — the tool's own id and
 * label — rather than the joined text the substring pass uses, so a category
 * name cannot promote its whole category ("terrain" would otherwise rank the 36
 * tools filed under Terrain ahead of the tools named after it). Identifiers are
 * compared with `_` and `-` folded to spaces, so `fill_depressions`,
 * `fill-depressions` and `Fill Depressions` are one query.
 */

/** The searchable text of one tool. */
export interface WhiteboxToolText {
  /**
   * Everything that identifies the tool — id, display name, category.
   *
   * The caller joins these because they are localized, and the labels come
   * from i18n rather than from the catalog.
   */
  name: string;
  /**
   * The tool's own names: its id and its display label, separately.
   *
   * Only these are ranked. `name` decides *whether* a tool matches; this
   * decides *where* among the matches it lands.
   */
  identifiers: readonly string[];
  /** The catalog's description of what the tool does; may be empty. */
  summary: string;
}

/**
 * Fold an id or a label into the form exact and prefix matches compare in.
 *
 * Whitebox ids are `snake_case` and labels are Title Case, so folding the
 * separators is what lets one query match both.
 */
function foldIdentifier(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Where a tool lands: named exactly, named with the query as a prefix, … */
const EXACT = 0;
const PREFIX = 1;
const NAMED = 2;
const DESCRIBED = 3;

/**
 * Order a tool list against a search, name matches first.
 *
 * @param tools - The tools to search, already narrowed by category/source.
 * @param query - The raw search text; blank returns `tools` unchanged.
 * @param textOf - The searchable text for one tool.
 * @returns Tools whose name the query matches, most exactly first and in their
 *   original order within each tier, followed by those matching only by
 *   summary. Non-matches are dropped.
 */
export function searchWhiteboxTools<T>(
  tools: readonly T[],
  query: string,
  textOf: (tool: T) => WhiteboxToolText,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...tools];
  // A query of only separators folds to nothing, and every identifier starts
  // with nothing — so the tiers are skipped rather than matching the catalog.
  const folded = foldIdentifier(needle);

  const tiers: T[][] = [[], [], [], []];
  for (const tool of tools) {
    const text = textOf(tool);
    const identifiers = folded ? text.identifiers.map(foldIdentifier) : [];
    if (identifiers.includes(folded)) tiers[EXACT].push(tool);
    else if (identifiers.some((identifier) => identifier.startsWith(folded)))
      tiers[PREFIX].push(tool);
    else if (text.name.toLowerCase().includes(needle)) tiers[NAMED].push(tool);
    else if (text.summary.toLowerCase().includes(needle)) tiers[DESCRIBED].push(tool);
  }
  return tiers.flat();
}
