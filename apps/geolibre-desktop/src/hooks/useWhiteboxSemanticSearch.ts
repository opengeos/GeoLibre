import type { WhiteboxTool } from "@geolibre/processing";
import { useEffect, useState } from "react";
import {
  SEMANTIC_DEBOUNCE_MS,
  searchWhiteboxToolsByMeaning,
  shouldSearchWhiteboxByMeaning,
  whiteboxSemanticSearchEndpoint,
} from "../lib/whitebox-semantic-search";
import type { CatalogMatch } from "../lib/assistant/catalog-select";

/** What the Whitebox toolbox needs to render a lookup. */
export interface WhiteboxSemanticSearch {
  /** Tool ids ranked by meaning, or null when the lookup did not answer. */
  matches: readonly CatalogMatch[] | null;
  /** True only while a request is actually in flight. */
  pending: boolean;
  /** Whether this deployment can run the lookup at all. */
  available: boolean;
}

const IDLE = { matches: null, pending: false } as const;

/**
 * Search the Whitebox catalog by meaning alongside the toolbox's filter box.
 *
 * Owns the three things that keep the lookup from being felt: the debounce, the
 * cancellation, and clearing the previous query's answer the moment the query
 * changes — a shortlist for what someone typed ten seconds ago, sitting above a
 * list they have since retyped, is worse than no shortlist.
 *
 * `pending` covers the request only, not the debounce. A spinner that lit on
 * every keystroke would say "busy" for the whole time someone types a sentence,
 * which is both untrue and distracting; this one appears once, for the ~400ms
 * the lookup takes.
 *
 * @param query - The filter-box text.
 * @param tools - The tools in scope, after the category and source filters.
 * @param keywordMatches - What the substring filter matched, ranked.
 * @param enabled - False while the catalog is still loading.
 * @returns The ranked shortlist, whether one is on its way, and whether the
 *   feature exists here at all.
 */
export function useWhiteboxSemanticSearch(
  query: string,
  tools: readonly WhiteboxTool[],
  keywordMatches: readonly WhiteboxTool[],
  enabled = true,
): WhiteboxSemanticSearch {
  // Resolved once: the endpoint comes from build-time and deployment config,
  // neither of which changes while the app is running.
  const [available] = useState(() => whiteboxSemanticSearchEndpoint() !== null);
  const [state, setState] = useState<{
    matches: readonly CatalogMatch[] | null;
    pending: boolean;
  }>(IDLE);

  useEffect(() => {
    const wanted =
      available && enabled && shouldSearchWhiteboxByMeaning(query, keywordMatches.length);
    if (!wanted) {
      setState((current) => (current.matches === null && !current.pending ? current : IDLE));
      return;
    }

    const controller = new AbortController();
    // Drop the previous query's shortlist now rather than when the new one
    // lands, so the group above the list always describes the text in the box.
    setState(IDLE);
    const timer = window.setTimeout(() => {
      setState({ matches: null, pending: true });
      void searchWhiteboxToolsByMeaning({
        query,
        tools,
        keywordMatches,
        signal: controller.signal,
      }).then((matches) => {
        if (controller.signal.aborted) return;
        setState({ matches, pending: false });
      });
    }, SEMANTIC_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [available, enabled, query, tools, keywordMatches]);

  return { matches: state.matches, pending: state.pending, available };
}
