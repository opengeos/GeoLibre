interface OllamaTagsResponse {
  models?: Array<{ name?: unknown; model?: unknown }>;
}

/** Fetch the model ids installed in an Ollama server. */
export async function discoverOllamaModels(baseUrl: string): Promise<string[]> {
  let normalized = baseUrl.trim() || "http://localhost:11434";
  if (!/^https?:\/\//i.test(normalized)) normalized = `http://${normalized}`;
  normalized = normalized.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${normalized}/api/tags`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
    const payload = (await response.json()) as OllamaTagsResponse;
    return [
      ...new Set(
        (payload.models ?? [])
          .map((entry) =>
            typeof entry.name === "string"
              ? entry.name.trim()
              : typeof entry.model === "string"
                ? entry.model.trim()
                : "",
          )
          .filter(Boolean),
      ),
    ].sort((a, b) => a.localeCompare(b));
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
