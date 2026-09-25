import type { AssistantProviderId } from "./provider";

/** One entry in a provider's live model catalog. */
export interface DiscoveredModel {
  id: string;
  name: string;
}

/** Hosted providers whose model list can be fetched with the user's API key. */
export type KeyedDiscoveryProvider = "google" | "anthropic" | "openai";

const KEYED_DISCOVERY_PROVIDERS: ReadonlySet<AssistantProviderId> = new Set([
  "google",
  "anthropic",
  "openai",
]);

const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * How long a successful discovery is reused before the picker asks again. Kept
 * in memory only: results are keyed by API key, and nothing derived from a
 * credential should be written to browser storage.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;

const cache = new Map<string, { models: DiscoveredModel[]; expires: number }>();

/**
 * Whether a provider's model list can be discovered with its API key.
 *
 * @param provider The assistant provider id.
 * @returns True for the providers {@link discoverProviderModels} supports.
 */
export function supportsKeyedModelDiscovery(
  provider: AssistantProviderId,
): provider is KeyedDiscoveryProvider {
  return KEYED_DISCOVERY_PROVIDERS.has(provider);
}

/** Drop the cached catalogs, so the next discovery hits the network. */
export function clearModelDiscoveryCache(): void {
  cache.clear();
}

/**
 * Fetch the chat models an API key can use, newest first where the provider
 * reports release order. Successful results are cached in memory for an hour
 * per provider and key; pass `force` to bypass the cache.
 *
 * @param provider The hosted provider to query.
 * @param apiKey The user's API key for that provider.
 * @param options `signal` aborts the request; `force` skips the cache.
 * @returns The filtered, de-duplicated model list.
 * @throws When the request fails, times out, or returns an unexpected payload.
 */
export async function discoverProviderModels(
  provider: KeyedDiscoveryProvider,
  apiKey: string,
  options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<DiscoveredModel[]> {
  const key = apiKey.trim();
  const cacheKey = `${provider}\u0000${key}`;
  // Drop expired entries on every call, so a key the user tried and replaced
  // does not stay resident for the rest of the session.
  const now = Date.now();
  for (const [entryKey, entry] of cache) if (entry.expires <= now) cache.delete(entryKey);
  const cached = cache.get(cacheKey);
  if (!options.force && cached) return cached.models;

  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  // AbortSignal.any is newer than some supported WebViews; without it the
  // deadline still bounds the request and callers ignore superseded results.
  const signal =
    options.signal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([options.signal, timeout])
      : timeout;

  let models: DiscoveredModel[];
  switch (provider) {
    case "openai":
      models = parseOpenAIModels(
        await fetchJson(
          "OpenAI",
          "https://api.openai.com/v1/models",
          { Authorization: `Bearer ${key}` },
          signal,
        ),
      );
      break;
    case "anthropic":
      models = parseAnthropicModels(
        await fetchJson(
          "Anthropic",
          "https://api.anthropic.com/v1/models?limit=1000",
          {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            // Required for the API to answer a CORS request from a webview.
            "anthropic-dangerous-direct-browser-access": "true",
          },
          signal,
        ),
      );
      break;
    case "google":
      models = parseGeminiModels(
        await fetchJson(
          "Google",
          "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
          { "x-goog-api-key": key },
          signal,
        ),
      );
      break;
  }
  cache.set(cacheKey, { models, expires: Date.now() + CACHE_TTL_MS });
  return models;
}

/** GET a JSON document, turning a non-2xx status into a readable error. */
async function fetchJson(
  label: string,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, { headers, signal });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response.json();
}

/** Return the array under `field`, or throw when the payload is not a catalog. */
function listField(payload: unknown, field: string, label: string): unknown[] {
  if (typeof payload === "object" && payload !== null && field in payload) {
    const list = (payload as Record<string, unknown>)[field];
    if (Array.isArray(list)) return list;
  }
  throw new Error(`${label} returned an invalid model catalog`);
}

/** Read a trimmed string property, or "" when absent or not a string. */
function stringProp(entry: unknown, prop: string): string {
  if (typeof entry !== "object" || entry === null) return "";
  const value = (entry as Record<string, unknown>)[prop];
  return typeof value === "string" ? value.trim() : "";
}

/** Model-id fragments for OpenAI models that are not chat/tool models. */
const OPENAI_EXCLUDED =
  /(audio|realtime|transcribe|tts|image|search|embedding|moderation|instruct|codex|computer-use|deep-research)/i;

/**
 * Keep the chat models from an OpenAI `/v1/models` response. The endpoint lists
 * every model (embeddings, speech, images, dated snapshots) with no capability
 * metadata, so filter by id: GPT and o-series families, minus the non-chat
 * variants and the `-YYYY-MM-DD` snapshots of an alias that is also listed.
 *
 * @param payload The parsed JSON response.
 * @returns Chat models, newest first by `created`.
 */
export function parseOpenAIModels(payload: unknown): DiscoveredModel[] {
  const entries = listField(payload, "data", "OpenAI")
    .map((entry) => ({
      id: stringProp(entry, "id"),
      created:
        typeof (entry as { created?: unknown } | null)?.created === "number"
          ? (entry as { created: number }).created
          : 0,
    }))
    .filter(
      ({ id }) =>
        /^(gpt-|o\d)/i.test(id) && !OPENAI_EXCLUDED.test(id) && !/-\d{4}-\d{2}-\d{2}$/.test(id),
    )
    .sort((a, b) => b.created - a.created);
  return dedupe(entries.map(({ id }) => ({ id, name: id })));
}

/**
 * Read an Anthropic `/v1/models` response. Every listed model supports the
 * Messages API with tools, and the API already returns newest first.
 *
 * @param payload The parsed JSON response.
 * @returns The models with their display names.
 */
export function parseAnthropicModels(payload: unknown): DiscoveredModel[] {
  return dedupe(
    listField(payload, "data", "Anthropic").map((entry) => ({
      id: stringProp(entry, "id"),
      name: stringProp(entry, "display_name"),
    })),
  );
}

/** Gemini model-id fragments for variants the text assistant cannot use. */
const GEMINI_EXCLUDED = /(embedding|image|tts|audio|live|robotics|computer-use|veo|imagen)/i;

/**
 * Keep the text-generation Gemini models from a Generative Language API
 * `/v1beta/models` response: those supporting `generateContent`, minus the
 * embedding, speech, image and live variants and the non-Gemini families
 * (Gemma, AQA). The API has no release date, so sort by id with numeric
 * collation, which puts higher version numbers first.
 *
 * @param payload The parsed JSON response.
 * @returns Gemini chat models, highest version first.
 */
export function parseGeminiModels(payload: unknown): DiscoveredModel[] {
  const models = listField(payload, "models", "Google")
    .filter((entry) => {
      const methods = (entry as { supportedGenerationMethods?: unknown } | null)
        ?.supportedGenerationMethods;
      return Array.isArray(methods) && methods.includes("generateContent");
    })
    .map((entry) => ({
      id: stringProp(entry, "name").replace(/^models\//, ""),
      name: stringProp(entry, "displayName"),
    }))
    .filter(({ id }) => id.startsWith("gemini-") && !GEMINI_EXCLUDED.test(id))
    .sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }));
  return dedupe(models);
}

/** Drop blank and repeated ids, and fall back to the id when a name is blank. */
function dedupe(models: DiscoveredModel[]): DiscoveredModel[] {
  const seen = new Set<string>();
  const result: DiscoveredModel[] = [];
  for (const { id, name } of models) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, name: name || id });
  }
  return result;
}
