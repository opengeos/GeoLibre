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
  for (const field of ["max_tokens", "max_completion_tokens"] as const) {
    const requested = body[field];
    if (typeof requested === "number" && Number.isFinite(requested)) {
      body[field] = Math.max(1, Math.min(Math.floor(requested), limit));
    }
  }
  if (body.max_tokens === undefined && body.max_completion_tokens === undefined) {
    body.max_completion_tokens = limit;
  }
}

async function proxyChat(request: Request, env: Env, origin: string): Promise<Response> {
  const maximumBytes = positiveInteger(env.MAX_BODY_BYTES, 1_048_576);
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson(request, maximumBytes);
  } catch (error) {
    const status = error instanceof RangeError ? 413 : 400;
    return jsonError(
      error instanceof Error ? error.message : "Invalid request body",
      status,
      corsHeaders(origin),
    );
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError("messages must be a non-empty array", 400, corsHeaders(origin));
  }

  const allowedModels = parseList(env.ALLOWED_MODELS);
  const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
  const model = requestedModel || env.DEFAULT_MODEL;
  if (!allowedModels.has(model)) {
    return jsonError("The requested model is not allowed", 400, corsHeaders(origin));
  }
  body.model = model;
  clampOutputTokens(body, positiveInteger(env.MAX_OUTPUT_TOKENS, 16_384));

  const actor = request.headers.get("CF-Connecting-IP") ?? "unidentified";
  const { success } = await env.AI_RATE_LIMITER.limit({ key: actor });
  if (!success) {
    return jsonError("Rate limit exceeded", 429, {
      ...Object.fromEntries(corsHeaders(origin)),
      "Retry-After": "60",
    });
  }

  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/` +
    `${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/ai/v1/chat/completions`;
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_AI_GATEWAY_TOKEN}`,
      "cf-aig-gateway-id": env.AI_GATEWAY_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const headers = new Headers(upstream.headers);
  for (const [name, value] of corsHeaders(origin)) headers.set(name, value);
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true });
    }

    const origin = allowedOrigin(request, env);
    if (!origin) return jsonError("Origin is not allowed", 403);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (url.pathname !== "/v1/chat/completions") {
      return jsonError("Not found", 404, corsHeaders(origin));
    }
    if (request.method !== "POST") {
      return jsonError("Method not allowed", 405, corsHeaders(origin));
    }

    try {
      return await proxyChat(request, env, origin);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "AI proxy failure",
          error: error instanceof Error ? error.message : String(error),
          path: url.pathname,
        }),
      );
      return jsonError("Upstream request failed", 502, corsHeaders(origin));
    }
  },
} satisfies ExportedHandler<Env>;
