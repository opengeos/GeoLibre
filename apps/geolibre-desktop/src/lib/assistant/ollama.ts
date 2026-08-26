interface OllamaTagsResponse {
  models?: unknown;
}

/**
 * The discovery budget. Uses `AbortSignal.timeout` rather than a manual
 * `AbortController` + `setTimeout` so the rejection is a `TimeoutError` that
 * `classifyFetchFailure` can tell apart from a plain abort, and so the deadline
 * stays armed while the response body is read.
 */
const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Where Ollama listens out of the box. Prefilled into a new profile's base-URL
 * field — the field is required, so leaving it blank reads as "incomplete" even
 * on the default install where discovery would have worked untouched.
 */
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

/**
 * Fetch the model ids installed in an Ollama server. `signal`, when given, is
 * combined with the discovery budget so a caller that discards the result (a
 * provider change, a profile switch) can abort the request instead of leaving
 * it running to the deadline.
 */
export async function discoverOllamaModels(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<string[]> {
  let normalized = baseUrl.trim() || DEFAULT_OLLAMA_BASE_URL;
  if (!/^https?:\/\//i.test(normalized)) normalized = `http://${normalized}`;
  normalized = normalized.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const budget = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  // AbortSignal.any shipped in Chrome 116 / Firefox 124 / Safari 17.4 — later
  // than the WebViews `crypto-random-uuid-polyfill` exists for. On an older
  // engine fall back to the budget alone (mirroring `offline-tiles.ts`), so the
  // request still times out rather than throwing before it is even made.
  const combine = signal && typeof AbortSignal.any === "function";
  const response = await fetch(`${normalized}/api/tags`, {
    signal: combine ? AbortSignal.any([signal, budget]) : budget,
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  // `Response.json()` resolves to `null` for a literal `null` body, so the
  // payload is coalesced before `models` is read.
  const payload = ((await response.json()) ?? {}) as OllamaTagsResponse;
  const entries = Array.isArray(payload.models) ? payload.models : [];
  return [
    ...new Set(
      entries
        .map((entry) => {
          // A malformed response can hold a null or non-object element; read it
          // defensively so one bad entry does not reject the whole discovery.
          const record = (entry ?? {}) as { name?: unknown; model?: unknown };
          const name = typeof record.name === "string" ? record.name.trim() : "";
          return name || (typeof record.model === "string" ? record.model.trim() : "");
        })
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));
}
