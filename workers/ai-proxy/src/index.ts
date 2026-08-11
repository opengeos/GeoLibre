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
const TAVILY_ENDPOINT = "https://api.tavily.com/search";

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
        ? await proxyTavily(request, env, origin)
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
