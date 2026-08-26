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

/** Fetch the model ids installed in an Ollama server. */
export async function discoverOllamaModels(baseUrl: string): Promise<string[]> {
  let normalized = baseUrl.trim() || "http://localhost:11434";
  if (!/^https?:\/\//i.test(normalized)) normalized = `http://${normalized}`;
  normalized = normalized.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const response = await fetch(`${normalized}/api/tags`, {
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  const payload = (await response.json()) as OllamaTagsResponse;
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
