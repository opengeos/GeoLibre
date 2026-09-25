import type { AssistantProviderConfig, AssistantProviderId } from "./provider";

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

/** Providers the model picker serves: every one with a live catalog. */
export type PickerProvider = "openrouter" | "bedrock" | KeyedDiscoveryProvider;

/**
 * Whether a provider gets the searchable model picker with live discovery.
 *
 * @param provider The assistant provider id.
 * @returns True for OpenRouter, Bedrock, and the key-based hosted providers.
 */
export function hasModelPicker(provider: AssistantProviderId): provider is PickerProvider {
  return (
    provider === "openrouter" || provider === "bedrock" || supportsKeyedModelDiscovery(provider)
  );
}

/** Drop the cached catalogs, so the next discovery hits the network. */
export function clearModelDiscoveryCache(): void {
  cache.clear();
}

/**
 * Return the cached catalog for `cacheKey`, or run `load` and cache its result.
 * Expired entries are evicted on every call, so a credential the user tried and
 * replaced does not stay resident for the rest of the session. A failed load is
 * not cached.
 */
async function withCache(
  cacheKey: string,
  force: boolean | undefined,
  load: () => Promise<DiscoveredModel[]>,
): Promise<DiscoveredModel[]> {
  const now = Date.now();
  for (const [entryKey, entry] of cache) if (entry.expires <= now) cache.delete(entryKey);
  const cached = cache.get(cacheKey);
  if (!force && cached) return cached.models;
  const models = await load();
  cache.set(cacheKey, { models, expires: Date.now() + CACHE_TTL_MS });
  return models;
}

/**
 * Combine a caller's abort signal with a deadline, so either one cancels the
 * request.
 *
 * @param signal The caller's signal, or undefined for the deadline alone.
 * @param timeoutMs The deadline in milliseconds.
 * @returns A signal that aborts when `signal` aborts or the deadline passes.
 */
export function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  // AbortSignal.any is newer than some supported WebViews. Forward whichever
  // fires first by hand, so a superseded request is still cancelled rather
  // than left running to the deadline.
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort(signal.reason);
  } else {
    for (const source of [signal, timeout]) {
      source.addEventListener("abort", () => controller.abort(source.reason), { once: true });
    }
  }
  return controller.signal;
}

/** Combine the caller's abort signal with the discovery deadline. */
function discoverySignal(signal: AbortSignal | undefined): AbortSignal {
  return withDeadline(signal, DISCOVERY_TIMEOUT_MS);
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
  return withCache(`${provider}\u0000${key}`, options.force, () =>
    fetchKeyedCatalog(provider, key, discoverySignal(options.signal)),
  );
}

/** Fetch and filter one key-based provider's catalog, uncached. */
async function fetchKeyedCatalog(
  provider: KeyedDiscoveryProvider,
  key: string,
  signal: AbortSignal,
): Promise<DiscoveredModel[]> {
  switch (provider) {
    case "openai":
      return parseOpenAIModels(
        await fetchJson(
          "OpenAI",
          "https://api.openai.com/v1/models",
          { Authorization: `Bearer ${key}` },
          signal,
        ),
      );
    case "anthropic":
      return parseAnthropicModels(
        await fetchJson(
          "Anthropic",
          // One page, no cursor: 1000 is the API's maximum page size, far above
          // the catalog's size, and any id can still be entered by hand.
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
    case "google":
      return parseGeminiModels(
        await fetchJson(
          "Google",
          // One page, no `nextPageToken` follow-up, for the same reason as Anthropic.
          "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
          { "x-goog-api-key": key },
          signal,
        ),
      );
  }
}

/** GET a JSON document, turning a non-2xx status into a readable error. */
async function fetchJson(
  label: string,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, { headers, signal });
  if (!response.ok) {
    // All three providers explain a rejection in `{ error: { message } }`
    // (e.g. "invalid x-api-key"); surface it rather than only the status.
    let detail = "";
    try {
      detail = stringProp(
        ((await response.json()) as { error?: unknown } | null)?.error,
        "message",
      );
    } catch {
      // A non-JSON error body leaves just the status.
    }
    throw new Error(`${label} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
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

/**
 * Model-id fragments for OpenAI models the Responses-API assistant cannot use:
 * speech, realtime and live voice models, image and embedding models, and the
 * retired `chat-latest` ChatGPT aliases the endpoint still lists.
 */
const OPENAI_EXCLUDED =
  /(audio|realtime|live|transcribe|tts|image|search|embedding|moderation|instruct|codex|computer-use|deep-research|chat-latest)/i;

/**
 * Keep the chat models from an OpenAI `/v1/models` response. The endpoint lists
 * every model (embeddings, speech, images, dated snapshots) with no capability
 * metadata, so filter by id: GPT and o-series families, minus the non-chat
 * variants and the dated snapshots (`-YYYY-MM-DD`, or the older `-MMDD`) of an
 * alias that is also listed.
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
        /^(gpt-|o\d)/i.test(id) &&
        !OPENAI_EXCLUDED.test(id) &&
        !/-(\d{4}-\d{2}-\d{2}|\d{4})$/.test(id),
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

/**
 * Gemini model-id fragments for variants the text assistant cannot use. `omni`
 * models only answer the Interactions API, and `transcribe` has no function
 * calling, although both still advertise `generateContent`.
 */
const GEMINI_EXCLUDED =
  /(embedding|image|tts|audio|live|transcribe|omni|robotics|computer-use|veo|imagen)/i;

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

/** The AWS credentials and region Bedrock discovery signs its requests with. */
export interface BedrockDiscoveryAuth {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Extract Bedrock discovery credentials from a resolved provider config.
 *
 * @param config A config from `configForProvider`/`configForProfile`, or null.
 * @returns The region and credentials, or null when it is not a usable Bedrock config.
 */
export function bedrockAuthFromConfig(
  config: AssistantProviderConfig | null | undefined,
): BedrockDiscoveryAuth | null {
  if (config?.provider !== "bedrock" || !config.region || !config.credentials) return null;
  const { accessKeyId, secretAccessKey, sessionToken } = config.credentials;
  return { region: config.region, accessKeyId, secretAccessKey, sessionToken };
}

/**
 * Fetch the Bedrock models the credentials can run through the Converse API:
 * the system-defined cross-region inference profiles (`global.*`, `us.*`, …)
 * plus the foundation models that support on-demand throughput. Cached like
 * {@link discoverProviderModels}. The control-plane SDK client is imported on
 * demand, so it only loads for Bedrock users.
 *
 * @param auth The region and AWS credentials.
 * @param options `signal` aborts the requests; `force` skips the cache.
 * @returns The filtered model list, global profiles first.
 * @throws When either list call fails or times out.
 */
export async function discoverBedrockModels(
  auth: BedrockDiscoveryAuth,
  options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<DiscoveredModel[]> {
  const cacheKey = [
    "bedrock",
    auth.region,
    auth.accessKeyId,
    auth.secretAccessKey,
    auth.sessionToken ?? "",
  ].join("\u0000");
  return withCache(cacheKey, options.force, async () => {
    const { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } =
      await import("@aws-sdk/client-bedrock");
    const client = new BedrockClient({
      region: auth.region,
      credentials: {
        accessKeyId: auth.accessKeyId,
        secretAccessKey: auth.secretAccessKey,
        sessionToken: auth.sessionToken,
      },
    });
    const abortSignal = discoverySignal(options.signal);
    try {
      const profiles: unknown[] = [];
      let nextToken: string | undefined;
      do {
        const page = await client.send(
          new ListInferenceProfilesCommand({
            typeEquals: "SYSTEM_DEFINED",
            maxResults: 1000,
            nextToken,
          }),
          { abortSignal },
        );
        profiles.push(...(page.inferenceProfileSummaries ?? []));
        nextToken = page.nextToken;
      } while (nextToken);
      const foundation = await client.send(
        new ListFoundationModelsCommand({ byOutputModality: "TEXT" }),
        { abortSignal },
      );
      return parseBedrockModels(profiles, foundation.modelSummaries ?? []);
    } finally {
      client.destroy();
    }
  });
}

/**
 * Bedrock model-id fragments to drop although the model outputs text: rerank,
 * embedding, video (Pegasus), speech (Sonic) and vision-only models the
 * Converse API rejects, the gpt-oss safeguard classifiers, and the older
 * models Converse refuses tools for. Checked by probing every listed model
 * with a tool-calling Converse request (2026-09).
 */
const BEDROCK_EXCLUDED =
  /(rerank|embed|pegasus|sonic|palmyra-vision|safeguard|llama3-(8b|70b)-instruct|mistral-7b|mixtral|deepseek\.r1)/i;

/** Region prefix of a cross-region inference profile id (`global.`, `us.`, `eu.`, …). */
const PROFILE_PREFIX = /^[a-z]+\./;

/**
 * Build the Bedrock model list from `ListInferenceProfiles` (system-defined)
 * and `ListFoundationModels` (text output) summaries. Keeps active text models
 * only: a profile is kept when its underlying foundation model is in the text
 * list and not `LEGACY` (legacy models are refused unless recently used), and a
 * foundation model is listed by its bare id only when it supports on-demand
 * throughput — the newest models run through inference profiles only.
 *
 * @param profiles Inference-profile summaries.
 * @param foundationModels Foundation-model summaries.
 * @returns Global profiles, then regional profiles, then on-demand models,
 *   each group sorted by name with numeric collation.
 */
export function parseBedrockModels(
  profiles: unknown[],
  foundationModels: unknown[],
): DiscoveredModel[] {
  const textModels = new Map<string, { name: string; onDemand: boolean }>();
  for (const summary of foundationModels) {
    const id = stringProp(summary, "modelId");
    const record = summary as {
      modelLifecycle?: { status?: unknown };
      inferenceTypesSupported?: unknown;
      inputModalities?: unknown;
    } | null;
    if (!id || BEDROCK_EXCLUDED.test(id) || record?.modelLifecycle?.status === "LEGACY") continue;
    const inputs = record?.inputModalities;
    if (Array.isArray(inputs) && !inputs.includes("TEXT")) continue;
    const inference = record?.inferenceTypesSupported;
    textModels.set(id, {
      name: stringProp(summary, "modelName"),
      onDemand: Array.isArray(inference) && inference.includes("ON_DEMAND"),
    });
  }

  const byName = (a: DiscoveredModel, b: DiscoveredModel) =>
    a.name.localeCompare(b.name, "en", { numeric: true });
  const globalProfiles: DiscoveredModel[] = [];
  const regionalProfiles: DiscoveredModel[] = [];
  for (const summary of profiles) {
    const id = stringProp(summary, "inferenceProfileId");
    if (!id || !textModels.has(id.replace(PROFILE_PREFIX, ""))) continue;
    if (stringProp(summary, "status") && stringProp(summary, "status") !== "ACTIVE") continue;
    // Profile names mix "GLOBAL" and "Global"; normalize so they sort together.
    const name = stringProp(summary, "inferenceProfileName").replace(/^GLOBAL\b/, "Global");
    (id.startsWith("global.") ? globalProfiles : regionalProfiles).push({ id, name });
  }
  const onDemand = [...textModels]
    .filter(([, model]) => model.onDemand)
    .map(([id, model]) => ({ id, name: model.name }));

  return dedupe([
    ...globalProfiles.sort(byName),
    ...regionalProfiles.sort(byName),
    ...onDemand.sort(byName),
  ]);
}
