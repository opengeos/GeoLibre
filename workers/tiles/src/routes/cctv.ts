import {
  AUSTIN_CCTV_FRAME_UPSTREAM,
  CALGARY_CCTV_FRAME_UPSTREAM,
  CALTRANS_CCTV_UPSTREAM,
  DRIVEBC_CCTV_CATALOG_UPSTREAM,
  fetchAllowlistedUpstream,
  NSW_CCTV_CATALOG_UPSTREAM,
  NSW_CCTV_FRAME_UPSTREAM,
  ONTARIO_CCTV_CATALOG_UPSTREAM,
  ONTARIO_CCTV_FRAME_UPSTREAM,
} from "../allowlisted-fetch";
import {
  CORS_HEADERS,
  isAllowedProxyImageRequest,
  isAllowedProxyOrigin,
  readResponseBytesWithLimit,
} from "./shared";

const CALGARY_CCTV_PATH = /^\/cctv\/calgary\/(\d{1,4})\.jpg$/;
const AUSTIN_CCTV_PATH = /^\/cctv\/austin\/(\d{1,4})\.jpg$/;
const ONTARIO_CCTV_PATH = /^\/cctv\/ontario\/([A-Za-z0-9_.-]{1,64})$/;
const NSW_CCTV_PATH = /^\/cctv\/nsw\/((?:[A-Za-z0-9_.-]|%[0-9A-Fa-f]{2}){1,300})$/;
const CALTRANS_CCTV_PATH = /^\/cctv\/caltrans\/(3|4|7|11)\/([a-z0-9-]{1,100})\.jpg$/i;

const CCTV_CATALOG_PROVIDERS = [
  "ontario",
  "drivebc",
  "nsw",
  "caltrans-3",
  "caltrans-4",
  "caltrans-7",
  "caltrans-11",
] as const;
type CctvCatalogProvider = (typeof CCTV_CATALOG_PROVIDERS)[number];

const CCTV_CATALOG_PATH = new RegExp(
  `^/cctv/catalog/(${CCTV_CATALOG_PROVIDERS.join("|")})\\.json$`,
);
const CCTV_FRAME_MAX_BODY_BYTES = 5 * 1024 * 1024;
const CCTV_UPSTREAM_TIMEOUT_MS = 30_000;
const CCTV_CATALOG_MAX_BODY_BYTES = 4 * 1024 * 1024;
const CCTV_CATALOG_CACHE_SECONDS = 15 * 60;
const NSW_CCTV_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function caltransCatalogUpstream(district: 3 | 4 | 7 | 11): string {
  return `${CALTRANS_CCTV_UPSTREAM}d${district}/cctv/cctvStatusD${String(district).padStart(2, "0")}.json`;
}

async function handleCctvFrame(
  request: Request,
  ctx: ExecutionContext,
  upstream: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  if (!isAllowedProxyImageRequest(request)) {
    return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
  }
  const cache = typeof caches === "undefined" ? null : caches.default;
  const cached = await cache?.match(request);
  if (cached) return cached;
  const upstreamController = new AbortController();
  const upstreamTimeout = setTimeout(() => upstreamController.abort(), CCTV_UPSTREAM_TIMEOUT_MS);
  try {
    const originResponse = await fetchAllowlistedUpstream(upstream, {
      headers: { accept: "image/jpeg,image/png,image/*", ...extraHeaders },
      signal: upstreamController.signal,
    });
    const contentType = originResponse.headers.get("content-type")?.split(";", 1)[0].trim() ?? "";
    const body = await readResponseBytesWithLimit(originResponse, CCTV_FRAME_MAX_BODY_BYTES);
    if (!originResponse.ok || !body || !["image/jpeg", "image/png"].includes(contentType)) {
      return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
    }
    const headers = new Headers(CORS_HEADERS);
    headers.set("content-type", contentType);
    headers.set("cache-control", "public, max-age=30");
    const response = new Response(body, { status: 200, headers });
    if (cache) ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  } finally {
    clearTimeout(upstreamTimeout);
  }
}

async function handleCctvCatalog(
  request: Request,
  ctx: ExecutionContext,
  provider: CctvCatalogProvider,
): Promise<Response> {
  if (!isAllowedProxyOrigin(request.headers.get("origin"))) {
    return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
  }
  const cache = typeof caches === "undefined" ? null : caches.default;
  const cached = await cache?.match(request);
  if (cached) return cached;
  const upstreams: Record<CctvCatalogProvider, string> = {
    ontario: `${ONTARIO_CCTV_CATALOG_UPSTREAM}?format=json&lang=en`,
    drivebc: DRIVEBC_CCTV_CATALOG_UPSTREAM,
    nsw: NSW_CCTV_CATALOG_UPSTREAM,
    "caltrans-3": caltransCatalogUpstream(3),
    "caltrans-4": caltransCatalogUpstream(4),
    "caltrans-7": caltransCatalogUpstream(7),
    "caltrans-11": caltransCatalogUpstream(11),
  };
  const upstream = upstreams[provider];
  const upstreamController = new AbortController();
  const upstreamTimeout = setTimeout(() => upstreamController.abort(), CCTV_UPSTREAM_TIMEOUT_MS);
  try {
    const originResponse = await fetchAllowlistedUpstream(upstream, {
      headers: { accept: "application/json" },
      signal: upstreamController.signal,
    });
    const body = await readResponseBytesWithLimit(originResponse, CCTV_CATALOG_MAX_BODY_BYTES);
    if (!originResponse.ok || !body) {
      return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
    }
    try {
      const payload = JSON.parse(new TextDecoder().decode(body)) as
        | { features?: unknown; data?: unknown }
        | unknown[];
      const features =
        payload && typeof payload === "object" && !Array.isArray(payload) ? payload.features : null;
      const valid =
        provider === "nsw"
          ? Array.isArray(features)
          : provider.startsWith("caltrans-")
            ? !Array.isArray(payload) && Array.isArray(payload.data)
            : Array.isArray(payload);
      if (!valid) throw new Error();
    } catch {
      return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
    }
    const headers = new Headers(CORS_HEADERS);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("cache-control", `public, max-age=${CCTV_CATALOG_CACHE_SECONDS}`);
    const response = new Response(body, { status: 200, headers });
    if (cache) ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  } finally {
    clearTimeout(upstreamTimeout);
  }
}

/** Route CCTV frame and catalog proxy requests. */
export function handleCctvRoute(
  request: Request,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> | null {
  const calgaryMatch = CALGARY_CCTV_PATH.exec(url.pathname);
  if (calgaryMatch) {
    return handleCctvFrame(request, ctx, `${CALGARY_CCTV_FRAME_UPSTREAM}loc${calgaryMatch[1]}.jpg`);
  }
  const austinMatch = AUSTIN_CCTV_PATH.exec(url.pathname);
  if (austinMatch) {
    return handleCctvFrame(request, ctx, `${AUSTIN_CCTV_FRAME_UPSTREAM}${austinMatch[1]}.jpg`);
  }
  const catalogMatch = CCTV_CATALOG_PATH.exec(url.pathname);
  if (catalogMatch) {
    return handleCctvCatalog(request, ctx, catalogMatch[1] as CctvCatalogProvider);
  }
  const ontarioMatch = ONTARIO_CCTV_PATH.exec(url.pathname);
  if (ontarioMatch) {
    return handleCctvFrame(
      request,
      ctx,
      `${ONTARIO_CCTV_FRAME_UPSTREAM}${encodeURIComponent(ontarioMatch[1])}`,
    );
  }
  const nswMatch = NSW_CCTV_PATH.exec(url.pathname);
  if (nswMatch) {
    let frameId: string;
    try {
      frameId = decodeURIComponent(nswMatch[1]);
    } catch {
      return Promise.resolve(new Response("Not Found", { status: 404, headers: CORS_HEADERS }));
    }
    if (!/^[a-z0-9_.&-]{1,100}\.(?:jpe?g)$/i.test(frameId)) {
      return Promise.resolve(new Response("Not Found", { status: 404, headers: CORS_HEADERS }));
    }
    return handleCctvFrame(
      request,
      ctx,
      `${NSW_CCTV_FRAME_UPSTREAM}${encodeURIComponent(frameId)}`,
      { "user-agent": NSW_CCTV_USER_AGENT },
    );
  }
  const caltransMatch = CALTRANS_CCTV_PATH.exec(url.pathname);
  if (caltransMatch) {
    const [, district, slug] = caltransMatch;
    return handleCctvFrame(
      request,
      ctx,
      `${CALTRANS_CCTV_UPSTREAM}d${district}/cctv/image/${slug}/${slug}.jpg`,
    );
  }
  return null;
}
