import { managedAssistantProxyBaseUrl, readRuntimeEnv, type RuntimeEnv } from "./provider";

/** Read one provider response within the timeout, including its JSON body. */
async function fetchSearchJson(provider: string, url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, 20_000);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`${provider} ${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abort);
  }
}

/** One web search hit. */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** A normalized search response across backends. */
export interface WebSearchResponse {
  provider: "tavily" | "duckduckgo" | "parallel";
  /** A direct answer/abstract when the backend provides one. */
  answer?: string;
  results: WebSearchResult[];
}

/** Richer web search via Tavily (requires `TAVILY_API_KEY`). */
async function tavilySearch(
  query: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<WebSearchResponse> {
  const data = (await fetchSearchJson("Tavily", "https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: 6,
      include_answer: true,
    }),
    signal,
  })) as {
    answer?: string;
    results?: { title?: string; url?: string; content?: string }[];
  };
  return {
    provider: "tavily",
    answer: data.answer,
    results: (data.results ?? []).map((result) => ({
      title: result.title ?? result.url ?? "",
      url: result.url ?? "",
      snippet: result.content ?? "",
    })),
  };
}

/**
 * Keyless fallback: DuckDuckGo Instant Answer. Best-effort only — DDG does not
 * reliably send CORS headers, so this may fail from a browser origin; callers
 * should treat a rejection as "search unavailable" and recommend TAVILY_API_KEY.
 */
async function duckDuckGoSearch(query: string, signal?: AbortSignal): Promise<WebSearchResponse> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
    query,
  )}&format=json&no_html=1&skip_disambig=1&t=geolibre`;
  const data = (await fetchSearchJson("DuckDuckGo", url, { signal })) as {
    AbstractText?: string;
    AbstractURL?: string;
    Heading?: string;
    RelatedTopics?: {
      Text?: string;
      FirstURL?: string;
      Topics?: { Text?: string; FirstURL?: string }[];
    }[];
  };
  const results: WebSearchResult[] = [];
  const collect = (topic: { Text?: string; FirstURL?: string }) => {
    if (topic.FirstURL && topic.Text) {
      results.push({
        title: topic.Text.split(" - ")[0],
        url: topic.FirstURL,
        snippet: topic.Text,
      });
    }
  };
  for (const topic of data.RelatedTopics ?? []) {
    if (topic.Topics) topic.Topics.forEach(collect);
    else collect(topic);
    if (results.length >= 8) break;
  }
  if (data.AbstractURL && data.AbstractText) {
    results.unshift({
      title: data.Heading ?? query,
      url: data.AbstractURL,
      snippet: data.AbstractText,
    });
  }
  return { provider: "duckduckgo", answer: data.AbstractText, results };
}

/**
 * Search the web. Uses Tavily when `TAVILY_API_KEY` is configured (richer,
 * full-text results) and otherwise falls back to DuckDuckGo's keyless Instant
 * Answer API. Both run directly from the browser, so results depend on each
 * service's CORS policy. Explicit `GEOLIBRE_WEB_SEARCH_PROVIDER=parallel`
 * instead uses the deployment's same-origin managed AI proxy without a search key.
 *
 * @param query The search query.
 * @param env Runtime environment variables (for `TAVILY_API_KEY`).
 * @param signal Optional abort signal.
 */
export async function webSearch(
  query: string,
  env: RuntimeEnv = readRuntimeEnv(),
  signal?: AbortSignal,
): Promise<WebSearchResponse> {
  if (env.GEOLIBRE_WEB_SEARCH_PROVIDER?.trim() === "parallel") {
    const proxy = managedAssistantProxyBaseUrl();
    if (!proxy) throw new Error("Parallel search requires the managed GeoLibre AI proxy.");
    // Only the same-origin, token-injecting proxy is supported. Never send a
    // personal provider key or the server-side instance token from the browser.
    const endpoint = new URL(`${proxy.replace(/\/v1$/, "")}/parallel`, window.location.origin);
    if (endpoint.origin !== window.location.origin) {
      throw new Error("Parallel search requires a same-origin GeoLibre AI proxy.");
    }
    const data = (await fetchSearchJson("Parallel search", endpoint.href, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal,
    })) as {
      results: { title: string; url: string; content: string }[];
    };
    return {
      provider: "parallel",
      results: data.results.map((hit) => ({
        title: hit.title,
        url: hit.url,
        snippet: hit.content,
      })),
    };
  }
  const tavilyKey = env.TAVILY_API_KEY?.trim();
  if (tavilyKey) {
    try {
      return await tavilySearch(query, tavilyKey, signal);
    } catch (error) {
      // Fall back to the keyless backend if Tavily fails (bad key, CORS, …),
      // but surface why so a misconfigured key isn't silently ignored.
      console.warn("Tavily search failed; falling back to DuckDuckGo.", error);
    }
  }
  return duckDuckGoSearch(query, signal);
}
