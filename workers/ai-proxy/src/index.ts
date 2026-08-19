// How long to wait for the provider's response headers. Generous enough for a
// slow non-streaming generation, and below the 600s nginx read timeout that a
// self-hosted deployment puts in front of this worker.
const UPSTREAM_HEADER_TIMEOUT_MS = 300_000;
// Bounds the wait for Tavily's response *headers*, exactly as
// UPSTREAM_HEADER_TIMEOUT_MS does for chat: the timer is cleared once fetch()
// resolves, and the (small, single-chunk) JSON body then streams through
// unbounded, with nginx's proxy_read_timeout as the outer bound on the
// Docker-fronted path. Twice the 30s it started at, because every request is
// `search_depth: "advanced"` with `include_answer`, which adds extra ranking
// plus an answer-synthesis step on Tavily's side; 30s was tight enough to turn
// a merely slow news query during a live disaster event into a 504.
const SEARCH_HEADER_TIMEOUT_MS = 60_000;
// Declared here rather than in wrangler.jsonc: all four are optional and
// deployment-specific. wrangler.jsonc's `secrets` block only supports
// `required`, so listing SEARCH_MESSAGES_API_KEY there would warn on every
// Tavily deployment that legitimately does not set it.
declare global {
  interface Env {
    /** "tavily" (default) or "messages". */
    SEARCH_BACKEND?: string;
    /** Base URL of an Anthropic-messages-compatible endpoint, e.g. a cli-proxy-api. */
    SEARCH_MESSAGES_URL?: string;
    SEARCH_MESSAGES_API_KEY?: string;
    /** Defaults to claude-sonnet-5. */
    SEARCH_MESSAGES_MODEL?: string;
  }
}

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

// Search + synthesis on one round trip, and this bound covers the whole body
// rather than just the response headers, so it sits well above Tavily's.
const MESSAGES_SEARCH_TIMEOUT_MS = 90_000;

function jsonError(message: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error: { message, type: "geolibre_proxy_error" } }, { status, headers });
}

function parseList(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function positiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function corsHeaders(origin: string): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
}

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get("Origin");
  if (!origin || !parseList(env.ALLOWED_ORIGINS).has(origin)) return null;
  return origin;
}

function responseHeaders(origin: string | null): Headers {
  return origin ? corsHeaders(origin) : new Headers();
}

async function hasValidInstanceToken(request: Request, env: Env): Promise<boolean> {
  const supplied = request.headers.get("X-GeoLibre-Instance-Token") ?? "";
  const expected = env.GEOLIBRE_AI_PROXY_TOKEN ?? "";
  if (!supplied || !expected) return false;

  // Digest first: timingSafeEqual throws on a length mismatch, so comparing the
  // raw bytes would have to bail out early and leak the secret's length.
  const encoder = new TextEncoder();
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(suppliedHash, expectedHash);
}

async function readBoundedJson(
  request: Request,
  maximumBytes: number,
): Promise<Record<string, unknown>> {
  const declaredLength = Number.parseInt(request.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new RangeError("Request body is too large");
  }
  if (!request.body) throw new SyntaxError("Request body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel("Request body is too large");
      throw new RangeError("Request body is too large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function clampOutputTokens(body: Record<string, unknown>, limit: number): void {
  let capped = false;
  for (const field of ["max_tokens", "max_completion_tokens"] as const) {
    if (!(field in body)) continue;
    // Anything that is not a usable positive number -- null, a numeric string,
    // NaN -- would otherwise reach upstream uncapped, so pin it to the limit.
    const requested = body[field];
    const usable = typeof requested === "number" && Number.isFinite(requested) && requested >= 1;
    body[field] = usable ? Math.min(Math.floor(requested as number), limit) : limit;
    capped = true;
  }
  if (!capped) body.max_completion_tokens = limit;
}

export function buildTavilySearchRequest(
  body: Record<string, unknown>,
  query: string,
  now = new Date(),
): Record<string, unknown> {
  const requestedMaxResults =
    typeof body.max_results === "number" && Number.isFinite(body.max_results)
      ? Math.floor(body.max_results)
      : 6;
  const maxResults = Math.min(Math.max(requestedMaxResults, 1), 20);
  const topic = body.topic === "news" ? "news" : "general";
  const request: Record<string, unknown> = {
    query,
    max_results: maxResults,
    topic,
    search_depth: "advanced",
    include_answer: true,
  };
  if (topic === "news" && typeof body.days === "number" && Number.isFinite(body.days)) {
    const days = Math.min(Math.max(Math.floor(body.days), 1), 3650);
    const startDate = new Date(now);
    startDate.setUTCDate(startDate.getUTCDate() - days);
    request.start_date = startDate.toISOString().slice(0, 10);
  }
  return request;
}

/**
 * Which backend answers /tavily. Tavily stays the default so an existing
 * deployment is unaffected until SEARCH_BACKEND is set deliberately.
 */
export function resolveSearchBackend(env: Env): "tavily" | "messages" {
  return env.SEARCH_BACKEND?.trim().toLowerCase() === "messages" ? "messages" : "tavily";
}

const MESSAGES_SEARCH_MODEL_DEFAULT = "claude-sonnet-5";

// The client contract is Tavily's: {results:[{title,url,content,published_date}],
// answer}. Anthropic's server-side search returns citable titles and URLs but the
// page text arrives as opaque encrypted_content, so the model has to write the
// per-source snippets that ground the impact figures. Asking for the whole
// envelope as JSON keeps that mapping in one place instead of splitting it
// between a synthesis prompt and a post-hoc merge.
/** The client's requested result count, clamped to the documented range. */
export function searchResultLimit(body: Record<string, unknown>): number {
  const requested =
    typeof body.max_results === "number" && Number.isFinite(body.max_results)
      ? Math.floor(body.max_results)
      : 6;
  return Math.min(Math.max(requested, 1), 20);
}

export function buildMessagesSearchRequest(
  body: Record<string, unknown>,
  query: string,
  model = MESSAGES_SEARCH_MODEL_DEFAULT,
): Record<string, unknown> {
  const maxResults = searchResultLimit(body);
  const topic = body.topic === "news" ? "news" : "general";
  const days =
    topic === "news" && typeof body.days === "number" && Number.isFinite(body.days)
      ? Math.min(Math.max(Math.floor(body.days), 1), 3650)
      : undefined;

  const recency =
    days === undefined
      ? topic === "news"
        ? " Prefer recent journalistic coverage."
        : " Retrospective sources are fine; prefer authoritative ones."
      : ` Only use sources published within the last ${days} days.`;

  return {
    model,
    max_tokens: 4096,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
    system:
      "You are a search backend. Use the web_search tool, then reply with ONE JSON " +
      "object and nothing else -- no prose, no code fence. Schema: " +
      '{"answer": string, "results": [{"title": string, "url": string, ' +
      '"content": string, "published_date": string}]}. "content" must be a short ' +
      "extract from that specific source supporting the answer, quoting any " +
      'figures it states. "url" must be a URL the search returned; never invent ' +
      'one. Omit "published_date" when the source does not state one. Return at ' +
      `most ${maxResults} results.`,
    messages: [{ role: "user", content: `${query}${recency}` }],
  };
}

interface MessagesSearchPayload {
  results: { title: string; url: string; content: string; published_date?: string }[];
  answer?: string;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Map an Anthropic messages response onto the Tavily-shaped envelope. Falls back
 * to the raw search hits when the model does not return usable JSON, so a
 * malformed reply still yields citable URLs rather than an error.
 */
export function parseMessagesSearchResponse(data: unknown, limit = 20): MessagesSearchPayload {
  const content = Array.isArray((data as { content?: unknown })?.content)
    ? ((data as { content: unknown[] }).content as Record<string, unknown>[])
    : [];

  const searched = new Map<string, { title: string; published_date?: string }>();
  const textParts: string[] = [];
  for (const block of content) {
    if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const hit of block.content as Record<string, unknown>[]) {
        const url = typeof hit?.url === "string" ? hit.url : "";
        if (!url) continue;
        // page_age is absent for many pages and arrives as the string "None".
        const age =
          typeof hit.page_age === "string" && hit.page_age !== "None" ? hit.page_age : undefined;
        searched.set(url, {
          title: typeof hit.title === "string" ? hit.title : "",
          published_date: age,
        });
      }
    } else if (block?.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }

  const parsed = extractJsonObject(textParts.join(""));
  const claimed = Array.isArray((parsed as { results?: unknown })?.results)
    ? ((parsed as { results: unknown[] }).results as Record<string, unknown>[])
    : [];

  const results = claimed
    .map((entry) => {
      const url = typeof entry?.url === "string" ? entry.url.trim() : "";
      if (!url) return undefined;
      // Only URLs the search actually returned may be cited: the model writes
      // the snippets, so without this an invented link reaches the client
      // looking exactly as citable as a real one.
      const hit = searched.get(url);
      if (!hit) return undefined;
      // A citation with no extract does not meet the schema the prompt asks for
      // and grounds nothing, so drop it rather than let it stand in for a real
      // result and suppress the raw-hit fallback below.
      const content = typeof entry.content === "string" ? entry.content : "";
      if (!content.trim()) return undefined;
      const published =
        typeof entry.published_date === "string" && entry.published_date.trim()
          ? entry.published_date.trim()
          : hit.published_date;
      return {
        title: typeof entry.title === "string" && entry.title ? entry.title : hit.title,
        url,
        content,
        ...(published ? { published_date: published } : {}),
      };
    })
    .filter((entry): entry is MessagesSearchPayload["results"][number] => entry !== undefined)
    .slice(0, limit);

  const answer =
    typeof (parsed as { answer?: unknown })?.answer === "string"
      ? ((parsed as { answer: string }).answer as string)
      : undefined;

  if (results.length > 0) return { results, answer };

  // No usable JSON: hand back what the search itself found so the caller still
  // has sources to cite, with the model's prose as the answer.
  return {
    results: [...searched.entries()]
      .map(([url, hit]) => ({
        title: hit.title,
        url,
        content: "",
        ...(hit.published_date ? { published_date: hit.published_date } : {}),
      }))
      .slice(0, limit),
    answer: answer ?? (textParts.join("").trim() || undefined),
  };
}

// Chat and search deliberately draw down one budget per client: both spend the
// same operator's account, so the limit an operator configures is the total an
// individual user may cost them, not a per-route allowance that a client can
// double by alternating routes.
async function rateLimit(request: Request, env: Env): Promise<Response | null> {
  const instanceClient = request.headers.get("X-GeoLibre-Client-IP")?.trim();
  const actor = instanceClient || request.headers.get("CF-Connecting-IP") || "unidentified";
  const { success } = await env.AI_RATE_LIMITER.limit({ key: actor });
  return success
    ? null
    : jsonError("Rate limit exceeded", 429, {
        "Retry-After": "60",
      });
}

function withOrigin(response: Response | null, origin: string | null): Response | null {
  if (!response) return null;
  const headers = new Headers(response.headers);
  for (const [name, value] of responseHeaders(origin)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

async function proxyChat(request: Request, env: Env, origin: string | null): Promise<Response> {
  // Check the limit before buffering: otherwise a throttled client can still
  // make the worker hold MAX_BODY_BYTES in memory on every rejected request.
  const limited = withOrigin(await rateLimit(request, env), origin);
  if (limited) return limited;

  const maximumBytes = positiveInteger(env.MAX_BODY_BYTES, 1_048_576);
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson(request, maximumBytes);
  } catch (error) {
    const status = error instanceof RangeError ? 413 : 400;
    return jsonError(
      error instanceof Error ? error.message : "Invalid request body",
      status,
      responseHeaders(origin),
    );
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError("messages must be a non-empty array", 400, responseHeaders(origin));
  }

  const allowedModels = parseList(env.ALLOWED_MODELS);
  const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
  const model = requestedModel || env.DEFAULT_MODEL;
  if (!allowedModels.has(model)) {
    return jsonError("The requested model is not allowed", 400, responseHeaders(origin));
  }
  body.model = model;
  clampOutputTokens(body, positiveInteger(env.MAX_OUTPUT_TOKENS, 16_384));

  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/` +
    `${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/v1/chat/completions`;
  // Bound the wait for response headers so a stalled provider fails as a
  // deterministic 504 instead of hanging until the platform kills the request.
  // The timer is cleared once headers arrive, leaving streamed bodies to run to
  // completion however long the generation takes.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), UPSTREAM_HEADER_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_AI_GATEWAY_TOKEN}`,
        "cf-aig-gateway-id": env.AI_GATEWAY_ID,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      return jsonError("Upstream request timed out", 504, responseHeaders(origin));
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }

  const headers = new Headers(upstream.headers);
  for (const [name, value] of responseHeaders(origin)) headers.set(name, value);
  headers.delete("set-cookie");
  headers.set("Cache-Control", "no-store");

  console.log(
    JSON.stringify({
      message: "AI proxy request",
      status: upstream.status,
      model,
      gateway: env.AI_GATEWAY_ID,
      colo: request.cf?.colo,
    }),
  );
  return new Response(upstream.body, { status: upstream.status, headers });
}

/**
 * /tavily keeps its name and its response shape; SEARCH_BACKEND decides who
 * actually answers it, so clients need no change to switch providers.
 */
async function proxySearch(request: Request, env: Env, origin: string | null): Promise<Response> {
  return resolveSearchBackend(env) === "messages"
    ? proxyMessagesSearch(request, env, origin)
    : proxyTavily(request, env, origin);
}

async function proxyTavily(request: Request, env: Env, origin: string | null): Promise<Response> {
  // Limit first, as proxyChat does, so an unconfigured Worker cannot be probed
  // without bound: the 503 below is cheap, but "cheap" is not "free".
  const limited = withOrigin(await rateLimit(request, env), origin);
  if (limited) return limited;

  const apiKey = env.TAVILY_API_KEY?.trim();
  if (!apiKey) {
    return jsonError("Search is not configured", 503, responseHeaders(origin));
  }

  const maximumBytes = Math.min(positiveInteger(env.MAX_BODY_BYTES, 1_048_576), 65_536);
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson(request, maximumBytes);
  } catch (error) {
    const status = error instanceof RangeError ? 413 : 400;
    return jsonError(
      error instanceof Error ? error.message : "Invalid request body",
      status,
      responseHeaders(origin),
    );
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length > 1_000) {
    return jsonError(
      "query must be a non-empty string of at most 1,000 characters",
      400,
      responseHeaders(origin),
    );
  }
  const tavilyBody = buildTavilySearchRequest(body, query);

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), SEARCH_HEADER_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(tavilyBody),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      return jsonError("Search request timed out", 504, responseHeaders(origin));
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }

  const headers = responseHeaders(origin);
  headers.set(
    "Content-Type",
    upstream.headers.get("Content-Type") ?? "application/json; charset=utf-8",
  );
  headers.set("Cache-Control", "no-store");
  console.log(
    JSON.stringify({
      message: "Tavily proxy request",
      status: upstream.status,
      topic: tavilyBody.topic,
      resultLimit: tavilyBody.max_results,
      colo: request.cf?.colo,
    }),
  );
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function proxyMessagesSearch(
  request: Request,
  env: Env,
  origin: string | null,
): Promise<Response> {
  const limited = withOrigin(await rateLimit(request, env), origin);
  if (limited) return limited;

  const endpoint = env.SEARCH_MESSAGES_URL?.trim().replace(/\/+$/, "");
  const apiKey = env.SEARCH_MESSAGES_API_KEY?.trim();
  if (!endpoint || !apiKey) {
    return jsonError("Search is not configured", 503, responseHeaders(origin));
  }

  const maximumBytes = Math.min(positiveInteger(env.MAX_BODY_BYTES, 1_048_576), 65_536);
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson(request, maximumBytes);
  } catch (error) {
    const status = error instanceof RangeError ? 413 : 400;
    return jsonError(
      error instanceof Error ? error.message : "Invalid request body",
      status,
      responseHeaders(origin),
    );
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length > 1_000) {
    return jsonError(
      "query must be a non-empty string of at most 1,000 characters",
      400,
      responseHeaders(origin),
    );
  }

  const payload = buildMessagesSearchRequest(
    body,
    query,
    env.SEARCH_MESSAGES_MODEL?.trim() || undefined,
  );

  const controller = new AbortController();
  // A search plus a synthesis pass runs longer than Tavily's own bound. The
  // timer is cleared only in the outer finally, after the body has been read:
  // clearing it when fetch resolves would disarm the abort while the body --
  // where the whole answer actually arrives -- was still streaming.
  const deadline = setTimeout(() => controller.abort(), MESSAGES_SEARCH_TIMEOUT_MS);
  try {
    let upstream: Response;
    try {
      upstream = await fetch(`${endpoint}/v1/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return jsonError("Search request timed out", 504, responseHeaders(origin));
      }
      throw error;
    }

    const headers = responseHeaders(origin);
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");

    if (!upstream.ok) {
      // Do not forward the upstream body: it can carry provider detail the client
      // has no use for, and its shape is not the client's error contract.
      console.log(
        JSON.stringify({ message: "Messages search upstream error", status: upstream.status }),
      );
      return jsonError("Search upstream error", 502, headers);
    }

    let parsed: ReturnType<typeof parseMessagesSearchResponse>;
    try {
      parsed = parseMessagesSearchResponse(await upstream.json(), searchResultLimit(body));
    } catch {
      // A stalled body aborts rather than parses, so separate the two: the
      // client should see a timeout, not a malformed-response error.
      if (controller.signal.aborted) {
        return jsonError("Search request timed out", 504, headers);
      }
      return jsonError("Search upstream returned an unreadable response", 502, headers);
    }

    console.log(
      JSON.stringify({
        message: "Messages search request",
        status: upstream.status,
        resultCount: parsed.results.length,
        colo: request.cf?.colo,
      }),
    );
    return new Response(JSON.stringify(parsed), { status: 200, headers });
  } finally {
    clearTimeout(deadline);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true });
    }

    const origin = allowedOrigin(request, env);
    if (!(await hasValidInstanceToken(request, env))) {
      return jsonError("Unauthorized", 401, responseHeaders(origin));
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: responseHeaders(origin),
      });
    }
    if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/tavily") {
      return jsonError("Not found", 404, responseHeaders(origin));
    }
    if (request.method !== "POST") {
      return jsonError("Method not allowed", 405, responseHeaders(origin));
    }

    try {
      return url.pathname === "/tavily"
        ? await proxySearch(request, env, origin)
        : await proxyChat(request, env, origin);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "AI proxy failure",
          error: error instanceof Error ? error.message : String(error),
          path: url.pathname,
        }),
      );
      return jsonError("Upstream request failed", 502, responseHeaders(origin));
    }
  },
} satisfies ExportedHandler<Env>;
