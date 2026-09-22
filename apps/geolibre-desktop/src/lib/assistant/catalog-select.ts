/**
 * Semantic selection over the Whitebox tool catalog.
 *
 * `list_whitebox_tools` has always answered with a substring filter over tool
 * names, ids and categories. That works when the model already knows the word
 * the catalog uses, and not at all otherwise: measured over 20 raster requests,
 * a filter given the request in the user's own words ("get rid of the grainy
 * speckle in a radar image") matched **nothing** on all 20, because no tool is
 * named "grainy". Given instead the single best keyword a model could guess, it
 * put the right tool somewhere in its 25 results 19 times — but first only 8
 * times, so the model still had to read a list and choose.
 *
 * This module asks Jev instead. 775 tools do not fit in one Choice question
 * (the API caps at 255 options), so the lookup is **tiered**: one question
 * picks the part of the catalog, a second picks the tool inside it.
 *
 * The first answer is read as a *distribution* rather than a pick. Taking only
 * the argmax would make one debatable judgement fatal — the catalog files
 * `mosaic` under "Remote Sensing - Enhancement & Contrast", which no amount of
 * reasoning about "combine overlapping aerial tiles" will suggest — so the top
 * few categories are carried forward together and the second question chooses
 * across all of them at once. That costs nothing extra: it is still two round
 * trips, ~400ms in total.
 *
 * Nothing here replaces the keyword filter. The caller merges the two, so a
 * literal-word search keeps working exactly as before and the ranked semantic
 * hits sit in front of it. Selection can only add candidates the filter missed.
 *
 * Everything is pure except {@link selectCatalogTools}, the only function that
 * touches the network, so the tiering rules can be tested without an API key.
 */

import {
  flattenCriterionName,
  postSystemOne,
  SYSTEM_ONE_MAX_CHOICES,
  type SystemOneAnswer,
  type SystemOneEndpoint,
  type SystemOneFetch,
} from "./system-one";

/** The parts of a catalog tool the questions need. */
export interface CatalogTool {
  id: string;
  name: string;
  category: string;
  /**
   * What the tool does, when the catalog says.
   *
   * 770 of the 775 snapshot entries carry one. The five that do not are in the
   * taxonomy but not in the Whitebox runtime catalog the summaries come from,
   * so the tool question falls back to their name and category.
   */
  description?: string;
}

/** One slice of the catalog the first question chooses between. */
export interface CatalogCategory {
  name: string;
  tools: readonly CatalogTool[];
}

/** Sentinel meaning "nothing in this set does what was asked". */
const NONE = "none";

/**
 * How many categories the second question draws its candidates from.
 *
 * One is too few: category assignment in the snapshot is genuinely arguable in
 * places, and a single wrong pick loses the tool outright. Wider helps until
 * the candidate list stops being a shortlist — at three, the second question
 * sees at most 187 of the 775 tools (the catalog's three largest categories
 * together), which fits the API's 255-option cap with room for the `none`
 * sentinel whatever the user asks for.
 */
export const CATALOG_BEAM_WIDTH = 3;

/**
 * Confidence the category question must reach for the lookup to continue.
 *
 * Low on purpose. A spread across several categories is the normal answer for
 * a request that could plausibly be served by tools in more than one of them,
 * and the beam exists precisely to carry that spread forward — gating hard here
 * would throw away the case the beam was built for. What this rejects is the
 * degenerate answer, where no category stands out from 51 at all.
 */
export const CATALOG_MIN_CATEGORY_CONFIDENCE = 0.1;

/**
 * How many tools the lookup returns.
 *
 * The point of selecting is to hand the model a shortlist it can read rather
 * than a page it must skim, so this stays small. Measured over 20 requests the
 * right tool was first 19 times and inside the top five 19 times, so a longer
 * list buys almost nothing and costs the model tokens on every raster request.
 */
export const CATALOG_SHORTLIST_SIZE = 5;

/**
 * Probability below which a candidate is not worth returning.
 *
 * A Choice distribution over ~180 options always has a long tail of near-zero
 * entries; passing those on as "matches" would be worse than saying nothing,
 * because the model cannot tell a 0.003 from a real answer once the numbers
 * are gone.
 */
export const CATALOG_MIN_TOOL_PROBABILITY = 0.01;

/**
 * Budget for the whole two-request lookup.
 *
 * Unlike the fast path, this is not racing anything: it runs inside a tool call
 * the model is already blocked on, where the alternative is the model reading
 * 25 filter hits and guessing. So the budget is generous compared with the
 * ~400ms the lookup actually takes, and exists to bound a stall rather than to
 * protect a latency win.
 */
export const CATALOG_TIMEOUT_MS = 6_000;

/** Example tool names listed per category in the first question. */
const CATEGORY_EXAMPLES = 6;

/** Longest tool description carried into a criterion. */
const MAX_DESCRIPTION_LENGTH = 160;

/**
 * Group a flat tool list into the categories the first question offers.
 *
 * Sorted by name so the question — and therefore the request body — is stable
 * for a given catalog, which keeps a failure reproducible.
 */
export function groupCatalogByCategory(tools: readonly CatalogTool[]): CatalogCategory[] {
  const byName = new Map<string, CatalogTool[]>();
  for (const tool of tools) {
    const bucket = byName.get(tool.category);
    if (bucket) bucket.push(tool);
    else byName.set(tool.category, [tool]);
  }
  return [...byName]
    .map(([name, grouped]) => ({ name, tools: grouped }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the first question: which part of the catalog holds the tool?
 *
 * Each category is described by its size and a few of its tools, because the
 * names alone are not self-explanatory — "Terrain - Multiscale Signatures"
 * means little until you see that it holds Multiscale Roughness and friends.
 *
 * @param categories - The catalog grouped by category.
 * @returns A Choice question for a System One request.
 */
export function buildCategoryQuestion(categories: readonly CatalogCategory[]): unknown {
  const criteria: Record<string, string> = {};
  for (const category of categories) {
    const examples = category.tools
      .slice(0, CATEGORY_EXAMPLES)
      .map((tool) => flattenCriterionName(tool.name))
      .join(", ");
    criteria[category.name] =
      `${flattenCriterionName(category.name)} — ${category.tools.length} tools, such as ${examples}`;
  }
  criteria[NONE] = "No group of geoprocessing tools does what the request describes";
  return {
    type: "choice",
    instructions:
      "A GIS user has described a geoprocessing operation they want to run. Which group of the Whitebox tool catalog holds the tool that does it?",
    criteria,
  };
}

/** Options for {@link selectBeamCategories}. */
export interface BeamOptions {
  width?: number;
  /** Cap on the tools the second question may offer, `none` excluded. */
  maxTools?: number;
  minConfidence?: number;
}

/**
 * Read the category answer as a beam: the most likely few, not just the pick.
 *
 * Categories are taken in probability order until the width or the option cap
 * runs out. A category that would overflow the cap is skipped rather than
 * breaking the loop, so one very large category cannot crowd out the smaller
 * ones behind it — the alternative silently narrows the beam to one.
 *
 * @param answer - The category question's answer.
 * @param categories - The same categories the question was built from.
 * @returns The categories to draw candidates from; empty to stand down.
 */
export function selectBeamCategories(
  answer: SystemOneAnswer | undefined,
  categories: readonly CatalogCategory[],
  options: BeamOptions = {},
): CatalogCategory[] {
  if (!answer) return [];
  const width = options.width ?? CATALOG_BEAM_WIDTH;
  const minConfidence = options.minConfidence ?? CATALOG_MIN_CATEGORY_CONFIDENCE;
  if ((answer.confidence ?? 0) < minConfidence) return [];
  // `none` winning outright is a real answer — the request is not a raster
  // operation at all — and standing down leaves the keyword filter in charge.
  if (answer.choice === NONE) return [];

  const byName = new Map(categories.map((category) => [category.name, category]));
  // Without a distribution there is still a pick; the beam is just width one.
  const ranked: string[] = answer.probabilities
    ? Object.entries(answer.probabilities)
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name)
    : answer.choice
      ? [answer.choice]
      : [];

  let budget = options.maxTools ?? SYSTEM_ONE_MAX_CHOICES - 1;
  const picked: CatalogCategory[] = [];
  for (const name of ranked) {
    if (picked.length >= width) break;
    if (name === NONE) continue;
    const category = byName.get(name);
    if (!category || category.tools.length > budget) continue;
    picked.push(category);
    budget -= category.tools.length;
  }
  return picked;
}

/**
 * Build the second question: which of these tools does the job?
 *
 * @param tools - The candidate tools, already within the option cap.
 * @returns A Choice question for a System One request.
 */
export function buildToolQuestion(tools: readonly CatalogTool[]): unknown {
  const criteria: Record<string, string> = {};
  for (const tool of tools) {
    const name = flattenCriterionName(tool.name);
    const category = flattenCriterionName(tool.category);
    const description = tool.description?.trim()
      ? flattenCriterionName(tool.description, MAX_DESCRIPTION_LENGTH)
      : "";
    criteria[tool.id] = description
      ? `${name} (${category}): ${description}`
      : `${name} — a tool in the ${category} group`;
  }
  criteria[NONE] = "None of these tools performs the operation the request describes";
  return {
    type: "choice",
    instructions:
      "Which one of these Whitebox tools performs the operation the user described? Match on what the tool does, not on words it happens to share with the request.",
    criteria,
  };
}

/** One selected tool and how sure the model was. */
export interface CatalogMatch {
  id: string;
  probability: number;
}

/** Options for {@link rankCatalogTools}. */
export interface RankOptions {
  limit?: number;
  minProbability?: number;
}

/**
 * Read the tool answer as a ranked shortlist.
 *
 * @param answer - The tool question's answer.
 * @param tools - The candidates the question was built from.
 * @returns Matching tool ids, most likely first.
 */
export function rankCatalogTools(
  answer: SystemOneAnswer | undefined,
  tools: readonly CatalogTool[],
  options: RankOptions = {},
): CatalogMatch[] {
  if (!answer) return [];
  const limit = options.limit ?? CATALOG_SHORTLIST_SIZE;
  const minProbability = options.minProbability ?? CATALOG_MIN_TOOL_PROBABILITY;
  const known = new Set(tools.map((tool) => tool.id));

  if (!answer.probabilities) {
    // Only an argmax came back; it is still worth one entry, held to the same
    // floor as a distribution would be. Without that, the one response shape
    // that carries no distribution is also the one with no threshold, so a
    // bare `{choice, confidence: 0.001}` would be promoted ahead of every
    // keyword match — the opposite of what the floor exists for.
    const choice = answer.choice;
    const confidence = answer.confidence ?? 1;
    if (!choice || choice === NONE || !known.has(choice)) return [];
    if (confidence < minProbability) return [];
    return [{ id: choice, probability: confidence }];
  }
  return Object.entries(answer.probabilities)
    .filter(([id, probability]) => id !== NONE && known.has(id) && probability >= minProbability)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, probability]) => ({ id, probability }));
}

/** One tool in a merged result, tagged with how it was found. */
export type MergedCatalogTool<T> = T & { match: "semantic" | "keyword" };

/** A merged search result, shaped for `list_whitebox_tools`. */
export interface MergedCatalogResult<T> {
  /** What to show, semantic hits first. */
  tools: MergedCatalogTool<T>[];
  /** How many distinct tools matched at all, before any cap. */
  matched: number;
  /** Whether `tools` is a subset of those. */
  truncated: boolean;
}

/**
 * Combine a semantic shortlist with the keyword hits, ranked first.
 *
 * The cap applies to the **keyword half only**, which is what makes "selection
 * can only add" true rather than merely close. Capping the combined list would
 * let five semantic hits push the 21st to 25th keyword hits out of a response
 * that used to contain them — a search that got strictly worse because the
 * lookup was configured. So the keyword half is cut exactly where it always
 * was, and the shortlist sits in front of it.
 *
 * @param selected - The lookup's shortlist, or null when it did not run.
 * @param keywordMatches - Substring hits, already ranked by the caller.
 * @param tools - The full catalog, to resolve selected ids against.
 * @param limit - How many keyword hits to keep.
 */
export function mergeCatalogMatches<T extends { id: string }>(
  selected: readonly CatalogMatch[] | null,
  keywordMatches: readonly T[],
  tools: readonly T[],
  limit: number,
): MergedCatalogResult<T> {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const ranked = (selected ?? [])
    .map((match) => byId.get(match.id))
    .filter((tool): tool is T => tool !== undefined);
  const rankedIds = new Set(ranked.map((tool) => tool.id));

  const merged: MergedCatalogTool<T>[] = [
    // Semantic hits lead: they are ranked, and the model reads top-down.
    ...ranked.map((tool) => ({ ...tool, match: "semantic" as const })),
    ...keywordMatches
      .slice(0, limit)
      .filter((tool) => !rankedIds.has(tool.id))
      .map((tool) => ({ ...tool, match: "keyword" as const })),
  ];
  const everything = new Set([...keywordMatches.map((tool) => tool.id), ...rankedIds]);
  return { tools: merged, matched: everything.size, truncated: merged.length < everything.size };
}

/** Options for one catalog lookup. */
export interface SelectCatalogToolsOptions {
  /** What the model is looking for: a keyword or a phrase, as it typed it. */
  query: string;
  /** The whole catalog. */
  tools: readonly CatalogTool[];
  /**
   * Tools the keyword filter already matched.
   *
   * Added to the second question's candidates so the two searches reinforce
   * each other: a literal match whose category the first question did not pick
   * still gets judged on what it does. This is how `mosaic` — filed under
   * "Remote Sensing - Enhancement & Contrast" — is reachable from a search for
   * "mosaic" even though no beam over category names would ever go there.
   */
  keywordMatches?: readonly CatalogTool[];
  endpoint: SystemOneEndpoint;
  fetchImpl: SystemOneFetch;
  /** Budget for both round trips; defaults to {@link CATALOG_TIMEOUT_MS}. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Pick the tools that match a request, or null to leave it to the keyword filter.
 *
 * Two sequential requests: the second question's options depend on the first
 * answer, which is the one case the TypeSafe guidance calls out as worth a
 * second round trip rather than asking everything at once.
 *
 * Every failure — no credential, a timeout, a refused origin, an answer with
 * nothing above the noise floor — returns null rather than throwing, so a
 * `list_whitebox_tools` call can never fail because selection was unavailable.
 *
 * @returns The ranked shortlist, or null when the lookup did not resolve.
 */
export async function selectCatalogTools(
  options: SelectCatalogToolsOptions,
): Promise<CatalogMatch[] | null> {
  const { query, tools, endpoint, fetchImpl, signal } = options;
  if (!query.trim() || tools.length === 0) return null;

  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS;
  const started = Date.now();
  const state = { request: query };
  const categories = groupCatalogByCategory(tools);

  const first = await postSystemOne({
    endpoint,
    fetchImpl,
    state,
    questions: { category: buildCategoryQuestion(categories) },
    timeoutMs,
    signal,
  });
  if (!first) return null;

  const candidates = new Map<string, CatalogTool>();
  for (const category of selectBeamCategories(first.category, categories)) {
    for (const tool of category.tools) candidates.set(tool.id, tool);
  }
  // Keyword hits go in after the beam, and only while there is room: the beam
  // is the ranked answer to the question actually asked, so a search matching
  // hundreds of tools by substring must not push it out of its own question.
  for (const tool of options.keywordMatches ?? []) {
    if (candidates.size >= SYSTEM_ONE_MAX_CHOICES - 1) break;
    candidates.set(tool.id, tool);
  }
  if (candidates.size === 0) return null;

  const shortlist = [...candidates.values()];
  const second = await postSystemOne({
    endpoint,
    fetchImpl,
    state,
    questions: { tool: buildToolQuestion(shortlist) },
    // The two requests share one budget, so a slow first answer cannot let the
    // pair run to twice the timeout the caller asked for.
    timeoutMs: Math.max(0, timeoutMs - (Date.now() - started)),
    signal,
  });
  if (!second) return null;

  const matches = rankCatalogTools(second.tool, shortlist);
  return matches.length > 0 ? matches : null;
}
