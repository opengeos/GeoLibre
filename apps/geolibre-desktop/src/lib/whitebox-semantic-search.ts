/**
 * Searching the Whitebox toolbox by meaning rather than by substring.
 *
 * The toolbox's filter box is a substring match, so it answers only when the
 * user already knows the word the catalog uses. Type "remove sinks so water
 * drains off the edge" and it finds nothing at all, because no tool is named
 * "sinks" — the tool is `fill_depressions`. Measured over 20 requests phrased
 * in plain words, the tiered Jev lookup in {@link ./assistant/catalog-select}
 * put the right tool first 19 times where the substring filter found nothing.
 *
 * That lookup is the assistant's, but nothing about it is assistant-shaped:
 * {@link selectCatalogTools} takes a query, a catalog and an endpoint. This
 * module is the toolbox's side of it — when to spend a round trip, and what to
 * send — so the dialog never touches the assistant's plumbing directly.
 *
 * Three rules shape it, all from the same worry: the filter box is instant and
 * the lookup is not, so the lookup must never make the box feel slower or make
 * the list move under someone already reading it.
 *
 * 1. **It is invisible when unavailable.** With no System One endpoint
 *    configured — the default — {@link whiteboxSemanticSearchEndpoint} returns
 *    null, nothing runs, and the dialog renders exactly as it did before.
 * 2. **It runs rarely.** Never per keystroke: the caller debounces, and
 *    {@link shouldSearchWhiteboxByMeaning} then insists the query is either a
 *    phrase (a description, which is the case substrings cannot answer) or a
 *    single word the catalog barely matches. A one-word search that already
 *    returns a full list is answered by the substring filter, which now ranks
 *    the tool of that name first anyway.
 * 3. **It adds, never reorders.** The caller renders the ranked hits as their
 *    own group above the substring list rather than merging into it, so the
 *    list someone is reading keeps its order.
 */

import type { WhiteboxTool } from "@geolibre/processing";
import {
  selectCatalogTools,
  type CatalogMatch,
  type CatalogTool,
} from "./assistant/catalog-select";
import { readRuntimeEnv } from "./assistant/provider";
import { resolveSystemOneEndpoint, type SystemOneEndpoint } from "./assistant/system-one";
import { typesafeFetch } from "./assistant/typesafe-fetch";
import { humanizeIdentifier } from "./processing-tool-i18n";

/**
 * Shortest query worth a round trip.
 *
 * One or two characters are a prefix someone is still typing, not a request.
 */
export const SEMANTIC_MIN_QUERY_LENGTH = 3;

/**
 * Substring hits below which even a single-word query earns a lookup.
 *
 * A word the catalog uses returns dozens of rows and needs no help. A word it
 * does not — "grainy", "sinks" — returns almost nothing, and that emptiness is
 * exactly the case the lookup exists for.
 */
export const SEMANTIC_SPARSE_HITS = 3;

/**
 * Idle time after the last keystroke before a lookup goes out.
 *
 * Long enough that typing a phrase costs one request rather than one per word,
 * short enough that a pause to read the list is answered before the reading is
 * done.
 */
export const SEMANTIC_DEBOUNCE_MS = 500;

/**
 * Substring hits offered to the lookup as extra candidates.
 *
 * Mirrors the assistant's cap for the same reason: a one-word search can match
 * hundreds of tools, and feeding all of them into the Choice question would
 * crowd out the categories the lookup's own first question chose.
 */
const MAX_KEYWORD_CANDIDATES = 40;

/**
 * Whether a query is worth asking about, given what the substring filter found.
 *
 * @param query - The raw filter-box text.
 * @param keywordHits - How many tools the substring filter matched.
 */
export function shouldSearchWhiteboxByMeaning(query: string, keywordHits: number): boolean {
  const trimmed = query.trim();
  if (trimmed.length < SEMANTIC_MIN_QUERY_LENGTH) return false;
  // Several words are a description of an operation, which is the thing a
  // substring match cannot answer however many tools it happens to return.
  if (/\s/.test(trimmed)) return true;
  return keywordHits < SEMANTIC_SPARSE_HITS;
}

/** Where the lookup would send its questions, or null when it cannot run. */
export function whiteboxSemanticSearchEndpoint(): SystemOneEndpoint | null {
  return resolveSystemOneEndpoint(readRuntimeEnv());
}

/**
 * A toolbox tool as the catalog questions describe it.
 *
 * Deliberately the catalog's own English strings rather than the translated
 * labels the list renders: the questions are asked in English, and keeping the
 * request identical in every locale keeps a bad answer reproducible.
 */
export function whiteboxCatalogTool(tool: WhiteboxTool): CatalogTool {
  return {
    id: tool.id,
    name: tool.display_name || humanizeIdentifier(tool.id, "Tool"),
    category: tool.category ?? "",
    description: tool.summary,
  };
}

/** One toolbox lookup. */
export interface WhiteboxSemanticSearchOptions {
  /** The filter-box text, as the user typed it. */
  query: string;
  /** The tools in scope, after the category and source filters. */
  tools: readonly WhiteboxTool[];
  /** What the substring filter already matched, in its own ranked order. */
  keywordMatches: readonly WhiteboxTool[];
  /** Cancels the lookup when the query changes or the dialog closes. */
  signal?: AbortSignal;
}

/**
 * Rank the catalog against a query by meaning, or null to leave it alone.
 *
 * Every failure — no credential, a timeout, a refused origin, an answer with
 * nothing above the noise floor — resolves to null, so the filter box can never
 * break because the lookup was unavailable.
 */
export async function searchWhiteboxToolsByMeaning(
  options: WhiteboxSemanticSearchOptions,
): Promise<CatalogMatch[] | null> {
  const endpoint = whiteboxSemanticSearchEndpoint();
  if (!endpoint) return null;
  try {
    return await selectCatalogTools({
      query: options.query,
      tools: options.tools.map(whiteboxCatalogTool),
      keywordMatches: options.keywordMatches
        .slice(0, MAX_KEYWORD_CANDIDATES)
        .map(whiteboxCatalogTool),
      endpoint,
      fetchImpl: await typesafeFetch(),
      signal: options.signal,
    });
  } catch (error) {
    // `selectCatalogTools` resolves rather than throws for every failure it
    // knows about; this covers the transport import, which does not.
    console.warn("[GeoLibre] Whitebox catalog selection was unavailable:", error);
    return null;
  }
}
