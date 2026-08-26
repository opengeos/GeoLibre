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
 * Fetch the model ids installed in an Ollama server. `signal`, when given, is
 * combined with the discovery budget so a caller that discards the result (a
 * provider change, a profile switch) can abort the request instead of leaving
 * it running to the deadline.
 */
export async function discoverOllamaModels(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<string[]> {
  let normalized = baseUrl.trim() || "http://localhost:11434";
  if (!/^https?:\/\//i.test(normalized)) normalized = `http://${normalized}`;
  normalized = normalized.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const budget = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  const response = await fetch(`${normalized}/api/tags`, {
    signal: signal ? AbortSignal.any([signal, budget]) : budget,
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
