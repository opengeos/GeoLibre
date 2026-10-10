/**
 * `/earthdata/download?url=<granule URL>` streams a NASA Earthdata granule to
 * the browser with CORS added, for the Earthaccess plugin's web build.
 *
 * The DAACs (NSIDC, LP DAAC, ORNL DAAC, …) answer a CORS preflight with 405 and
 * redirect an authenticated GET to a presigned CloudFront URL that sends no CORS
 * headers either, so a browser cannot read a protected file directly. The
 * desktop app downloads natively and never reaches this route.
 *
 * Guards, since the route carries a user's Earthdata Login token:
 *   - the first URL must be HTTPS on a NASA Earthdata data host (never the
 *     login host, urs.earthdata.nasa.gov);
 *   - the token goes to that first request only; every redirect hop must stay
 *     on an Earthdata host, CloudFront or S3, and is fetched without it;
 *   - a redirect back to the login page means the token was not accepted, and
 *     is answered with 401 instead of being followed;
 *   - responses are `private, no-store`, never put in the edge cache, and the
 *     token is never logged.
 */

const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LOGIN_HOST = "urs.earthdata.nasa.gov";

/** Response headers passed through from the file host. */
const PASSTHROUGH_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
];

export const EARTHDATA_DOWNLOAD_PATH = "/earthdata/download";

export const EARTHDATA_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "authorization, range",
  "access-control-expose-headers": "content-range, content-length, accept-ranges, etag",
  "access-control-max-age": "86400",
};

/**
 * Presigned redirect targets, keyed by a hash of the token and file URL. A COG
 * map layer reads a file as many small range requests; without this each one
 * would pay the DAAC's token check and redirect. The DAACs presign for an hour,
 * so entries live 50 minutes, and an entry that stops working is dropped and
 * the request falls back to the DAAC. Per isolate, in memory only: the key is a
 * hash, so the token itself is never stored.
 */
const PRESIGNED_TTL_MS = 50 * 60 * 1000;
const PRESIGNED_CACHE_LIMIT = 1000;
const presignedCache = new Map<string, { url: string; expires: number }>();

async function presignedCacheKey(authorization: string, target: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${authorization}\n${target}`),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function rememberPresigned(key: string, url: string, now: number): void {
  presignedCache.delete(key);
  presignedCache.set(key, { url, expires: now + PRESIGNED_TTL_MS });
  while (presignedCache.size > PRESIGNED_CACHE_LIMIT) {
    const oldest = presignedCache.keys().next().value;
    if (oldest === undefined) break;
    presignedCache.delete(oldest);
  }
}

/**
 * The edge cache (Cache API), which is shared by every isolate in a Cloudflare
 * data center, unlike the in-memory map. Absent outside the Workers runtime.
 */
function edgeCache(): Cache | null {
  const storage = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches;
  return storage?.default ?? null;
}

function edgeCacheRequest(key: string): Request {
  // A synthetic URL on a host the Worker never serves: the entry is only ever
  // read back by this code, never matched by a real request.
  return new Request(`https://earthdata-presigned.invalid/${key}`);
}

async function lookupPresigned(key: string, now: number): Promise<string | null> {
  const local = presignedCache.get(key);
  if (local && local.expires > now) return local.url;
  const cache = edgeCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(edgeCacheRequest(key));
    if (!hit) return null;
    const url = await hit.text();
    rememberPresigned(key, url, now);
    return url;
  } catch {
    return null;
  }
}

async function storePresigned(key: string, url: string, now: number): Promise<void> {
  rememberPresigned(key, url, now);
  const cache = edgeCache();
  if (!cache) return;
  try {
    await cache.put(
      edgeCacheRequest(key),
      new Response(url, {
        headers: { "cache-control": `max-age=${PRESIGNED_TTL_MS / 1000}` },
      }),
    );
  } catch {
    // The in-memory entry still helps this isolate.
  }
}

async function forgetPresigned(key: string): Promise<void> {
  presignedCache.delete(key);
  try {
    await edgeCache()?.delete(edgeCacheRequest(key));
  } catch {
    // Expires on its own.
  }
}

/** Empties the presigned-URL cache (tests). */
export function clearEarthdataPresignedCache(): void {
  presignedCache.clear();
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function hostIn(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

/** Whether a URL is an Earthdata data host the token may be sent to. */
export function isEarthdataDataUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  if (host === LOGIN_HOST) return false;
  return hostIn(host, "earthdatacloud.nasa.gov") || hostIn(host, "earthdata.nasa.gov");
}

/** Whether a redirect hop may be followed (without the token). */
export function isEarthdataRedirectUrl(value: string): boolean {
  if (isEarthdataDataUrl(value)) return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  // CloudFront fronts the DAACs' presigned URLs; S3 hosts are matched by
  // their `s3.` / `s3-` endpoint label, not every amazonaws.com service.
  return hostIn(host, "cloudfront.net") || /(^|\.)s3[.-][a-z0-9.-]*amazonaws\.com$/.test(host);
}

function plain(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      ...EARTHDATA_CORS_HEADERS,
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * Stream one Earthdata file. The caller has already checked the Origin.
 *
 * @param request The incoming request (its `Authorization` and `Range` are forwarded).
 * @param fetchImpl The upstream fetch.
 * @returns The file with CORS headers, or a plain-text error.
 */
export async function handleEarthdataDownload(
  request: Request,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const target = new URL(request.url).searchParams.get("url") ?? "";
  if (!isEarthdataDataUrl(target)) {
    return plain(400, "The url parameter must be an HTTPS NASA Earthdata data URL.");
  }
  const authorization = request.headers.get("authorization");
  if (authorization && !/^Bearer [A-Za-z0-9._~+/=-]+$/.test(authorization)) {
    return plain(400, "Only an Earthdata Login bearer token is accepted.");
  }
  const range = request.headers.get("range");
  const now = Date.now();
  const cacheKey = authorization ? await presignedCacheKey(authorization, target) : null;

  let url = target;
  let response: Response | null = null;
  const cachedUrl = cacheKey ? await lookupPresigned(cacheKey, now) : null;
  if (cacheKey && cachedUrl && isEarthdataRedirectUrl(cachedUrl)) {
    try {
      const upstream = await fetchImpl(cachedUrl, {
        headers: range
          ? { range, "accept-encoding": "identity" }
          : { "accept-encoding": "identity" },
        redirect: "manual",
      });
      if (upstream.ok) response = upstream;
    } catch {
      // Fall back to the DAAC below.
    }
    if (!response) await forgetPresigned(cacheKey);
  }
  for (let hop = 0; !response && hop <= MAX_REDIRECT_HOPS; hop += 1) {
    const headers = new Headers();
    if (range) headers.set("range", range);
    if (hop === 0 && authorization) headers.set("authorization", authorization);
    // Content-Length must describe the bytes relayed, so ask for them as stored.
    headers.set("accept-encoding", "identity");
    let upstream: Response;
    try {
      upstream = await fetchImpl(url, { headers, redirect: "manual" });
    } catch {
      return plain(502, "Could not reach the Earthdata file host.");
    }
    if (!REDIRECT_STATUSES.has(upstream.status)) {
      response = upstream;
      break;
    }
    const location = upstream.headers.get("location");
    if (!location) {
      response = upstream;
      break;
    }
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return plain(502, "The Earthdata file host redirected somewhere unexpected.");
    }
    if (next.hostname.toLowerCase() === LOGIN_HOST) {
      return plain(
        401,
        "Earthdata Login did not accept the request. Add a valid token, and accept the dataset's EULA if it has one.",
      );
    }
    if (!isEarthdataRedirectUrl(next.toString())) {
      return plain(502, "The Earthdata file host redirected somewhere unexpected.");
    }
    url = next.toString();
    // Cache only a presigned target: another Earthdata hop would answer the
    // tokenless replay with a redirect or 401 and be evicted every time.
    if (hop === 0 && cacheKey && !isEarthdataDataUrl(url)) {
      await storePresigned(cacheKey, url, now);
    }
  }
  if (!response) return plain(508, "Too many redirects.");
  if (!response.ok) {
    const status = response.status === 401 || response.status === 403 ? response.status : 502;
    return plain(status, `The Earthdata file host answered ${response.status}.`);
  }

  const headers = new Headers(EARTHDATA_CORS_HEADERS);
  for (const name of PASSTHROUGH_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", "private, no-store");
  // A header-safe name: Headers.set throws on CR/LF and non-Latin-1 text.
  const fileName = (new URL(target).pathname.split("/").pop() ?? "").replace(
    /[^A-Za-z0-9._-]/g,
    "_",
  );
  if (fileName) headers.set("content-disposition", `attachment; filename="${fileName}"`);
  return new Response(response.body, { status: response.status, headers });
}
