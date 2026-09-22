/**
 * Substring search over the Whitebox tool catalog.
 *
 * Two places search those ~1,000 tools by text — the Whitebox toolbox dialog's
 * filter box and the assistant's `list_whitebox_tools` — and both want the same
 * rule, so it lives here once.
 *
 * The rule is: **match names and summaries, but never let a summary match
 * outrank a name match.**
 *
 * Both halves matter. Searching summaries is what lets "speckle" find the four
 * SAR filters, none of which say so in their name — before the catalog carried
 * summaries that search returned nothing at all. But a summary is a paragraph,
 * so a common word hits dozens of tools: matching name and summary in one
 * joined string leaves the results in catalog order with nothing to separate
 * the tool called Slope from the forty that mention slope in passing. Measured
 * against the shipped catalog, that put the Slope tool 47th of 51 hits for
 * "slope", and 15th of 18 for "watershed".
 *
 * Splitting the two restores every tool to exactly the position it held before
 * the catalog carried summaries at all — Slope back to 20th, Watershed to 12th
 * — while keeping the summary hits behind them as added reach.
 *
 * Note what that does *not* do: within the name matches the order is still the
 * catalog's, so "slope" leads with Average Flowpath Slope and reaches the tool
 * called Slope 20th. That is long-standing behaviour and not something this
 * function tries to change; ranking exact and prefix matches first would be a
 * real improvement to the toolbox and a separate, deliberate one.
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
  /** The catalog's description of what the tool does; may be empty. */
  summary: string;
}

/**
 * Order a tool list against a search, name matches first.
 *
 * @param tools - The tools to search, already narrowed by category/source.
 * @param query - The raw search text; blank returns `tools` unchanged.
 * @param textOf - The searchable text for one tool.
 * @returns Tools matching by name, in their original order, followed by those
 *   matching only by summary. Non-matches are dropped.
 */
export function searchWhiteboxTools<T>(
  tools: readonly T[],
  query: string,
  textOf: (tool: T) => WhiteboxToolText,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...tools];

  const named: T[] = [];
  const describedOnly: T[] = [];
  for (const tool of tools) {
    const text = textOf(tool);
    if (text.name.toLowerCase().includes(needle)) named.push(tool);
    else if (text.summary.toLowerCase().includes(needle)) describedOnly.push(tool);
  }
  return [...named, ...describedOnly];
}
