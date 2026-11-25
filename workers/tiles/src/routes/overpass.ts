import {
  fetchAllowlistedUpstream,
  OVERPASS_API_FALLBACK_UPSTREAM,
  OVERPASS_API_UPSTREAM,
} from "../allowlisted-fetch";
import { isAllowedOverpassQuery } from "../overpass-query";
import {
  isAllowedProxyOrigin,
  OVERPASS_CORS_HEADERS,
  OVERPASS_UPSTREAM_HEADER,
  readRequestBodyWithLimit,
  streamWithTimeoutCleanup,
} from "./shared";

export const OVERPASS_PATH = "/overpass";
const OVERPASS_MAX_BODY_BYTES = 20_000;
const OVERPASS_UPSTREAM_TIMEOUT_MS = 65_000;

/** Relay one bounded form-encoded Overpass query with browser-readable CORS. */
export async function handleOverpass(request: Request): Promise<Response> {
  if (!isAllowedProxyOrigin(request.headers.get("origin"))) {
    return new Response("Forbidden", {
      status: 403,
      headers: OVERPASS_CORS_HEADERS,
    });
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > OVERPASS_MAX_BODY_BYTES) {
    return new Response("Payload Too Large", {
      status: 413,
      headers: OVERPASS_CORS_HEADERS,
    });
  }
  const body = await readRequestBodyWithLimit(request, OVERPASS_MAX_BODY_BYTES);
  if (body === null) {
    return new Response("Payload Too Large", {
      status: 413,
      headers: OVERPASS_CORS_HEADERS,
    });
  }
  const params = new URLSearchParams(body);
  const query = params.get("data");
  if (
    !query ||
    params.getAll("data").length !== 1 ||
    [...params.keys()].some((key) => key !== "data") ||
    !isAllowedOverpassQuery(query)
  ) {
    return new Response("Bad Request", {
      status: 400,
      headers: OVERPASS_CORS_HEADERS,
    });
  }
  let originResponse: Response | null = null;
  let answeringUpstream: string | null = null;
  let upstreamTimeout: ReturnType<typeof setTimeout> | null = null;
  const upstreamDeadline = Date.now() + OVERPASS_UPSTREAM_TIMEOUT_MS;
  const upstreams = [OVERPASS_API_UPSTREAM, OVERPASS_API_FALLBACK_UPSTREAM];
  for (const upstream of upstreams) {
    const remainingMs = upstreamDeadline - Date.now();
    if (remainingMs <= 0) break;
    const upstreamController = new AbortController();
    upstreamTimeout = setTimeout(() => upstreamController.abort(), remainingMs);
    try {
      originResponse = await fetchAllowlistedUpstream(upstream, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          referer: "https://geolibre.app/",
        },
        body,
        signal: upstreamController.signal,
      });
    } catch {
      clearTimeout(upstreamTimeout);
      upstreamTimeout = null;
      continue;
    }
    if (originResponse && originResponse.status !== 429 && originResponse.status < 500) {
      clearTimeout(upstreamTimeout);
      const bodyTimeoutMs = Math.max(1, upstreamDeadline - Date.now());
      upstreamTimeout = setTimeout(() => upstreamController.abort(), bodyTimeoutMs);
      answeringUpstream = upstream;
      break;
    }
    clearTimeout(upstreamTimeout);
    upstreamTimeout = null;
    await originResponse?.body?.cancel().catch(() => undefined);
    originResponse = null;
  }
  if (!originResponse || !answeringUpstream) {
    return new Response(
      "Overpass is busy: every upstream instance failed or timed out. Try again later.",
      {
        status: 502,
        headers: OVERPASS_CORS_HEADERS,
      },
    );
  }
  if (!originResponse.body && upstreamTimeout) clearTimeout(upstreamTimeout);
  const headers = new Headers(OVERPASS_CORS_HEADERS);
  headers.set("content-type", originResponse.headers.get("content-type") ?? "application/json");
  headers.set("cache-control", "no-store");
  headers.set(OVERPASS_UPSTREAM_HEADER, new URL(answeringUpstream).host);
  const responseBody = originResponse.body
    ? streamWithTimeoutCleanup(originResponse.body, upstreamTimeout!)
    : null;
  return new Response(responseBody, { status: originResponse.status, headers });
}
