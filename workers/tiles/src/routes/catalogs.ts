import { fetchAllowlistedUpstream, HDX_CKAN_SEARCH_UPSTREAM } from "../allowlisted-fetch";
import { odpUpstream } from "../odp";
import { CORS_HEADERS, isAllowedProxyOrigin } from "./shared";

const OAM_META_PATH = "/oam/meta";
const OAM_META_UPSTREAM = "https://api.openaerialmap.org/meta";
const OAM_META_PARAMS = new Set([
  "bbox",
  "limit",
  "page",
  "order_by",
  "sort",
  "acquisition_from",
  "acquisition_to",
]);
const OAM_CACHE_CONTROL = "public, max-age=120";
const OAM_MAX_LIMIT = 100;

const CKAN_SEARCH_PATH = "/ckan/search";
const CKAN_MAX_ROWS = 50;

const SOURCE_COOP_PREFIX = "/source-coop/";
const SOURCE_COOP_API_UPSTREAM = "https://source.coop/api/v1";
const SOURCE_COOP_FEED_UPSTREAM = "https://source.coop/feed.xml";
const SOURCE_COOP_PRODUCTS_PATH =
  /^products\/([a-zA-Z0-9][a-zA-Z0-9-_.]{0,63})(?:\/([a-zA-Z0-9][a-zA-Z0-9-_.]{0,63}))?$/;
const SOURCE_COOP_CACHE_CONTROL = "public, max-age=300";

const GITHUB_RAW_PATH = "/github-raw";
const GITHUB_RAW_REPOSITORY_PATH = /^\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/raw\/.+$/;

function sourceCoopUpstream(pathname: string): string | null {
  const rest = pathname.slice(SOURCE_COOP_PREFIX.length);
  if (rest === "feed") return SOURCE_COOP_FEED_UPSTREAM;
  const match = SOURCE_COOP_PRODUCTS_PATH.exec(rest);
  if (!match) return null;
  const [, account, product] = match;
  return product
    ? `${SOURCE_COOP_API_UPSTREAM}/products/${account}/${product}`
    : `${SOURCE_COOP_API_UPSTREAM}/products/${account}`;
}

async function handleSourceCoop(request: Request, pathname: string): Promise<Response> {
  if (!isAllowedProxyOrigin(request.headers.get("origin"))) {
    return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
  }
  const upstream = sourceCoopUpstream(pathname);
  if (!upstream) {
    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  }
  let originResponse: Response;
  try {
    originResponse = await fetchAllowlistedUpstream(upstream, {
      cf: { cacheEverything: true, cacheTtl: 300 },
    });
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }
  const headers = new Headers(CORS_HEADERS);
  headers.set("content-type", originResponse.headers.get("content-type") ?? "application/json");
  const contentType = headers.get("content-type") ?? "";
  const cacheable =
    originResponse.ok && (contentType.includes("json") || contentType.includes("xml"));
  headers.set("cache-control", cacheable ? SOURCE_COOP_CACHE_CONTROL : "no-store");
  return new Response(originResponse.body, {
    status: originResponse.status,
    headers,
  });
}

async function handleOdp(request: Request, url: URL): Promise<Response> {
  if (!isAllowedProxyOrigin(request.headers.get("origin"))) {
    return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
  }
  const route = odpUpstream(url);
  if (!route) {
    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  }
  let originResponse: Response;
  try {
    originResponse = await fetchAllowlistedUpstream(route.upstream, {
      headers: { "user-agent": "GeoLibre tiles proxy (+https://geolibre.app)" },
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: { "200-299": route.cacheSeconds, "300-599": -1 },
      },
    });
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }
  const headers = new Headers(CORS_HEADERS);
  const contentType = originResponse.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set(
    "cache-control",
    originResponse.ok ? `public, max-age=${route.cacheSeconds}` : "no-store",
  );
  return new Response(originResponse.body, { status: originResponse.status, headers });
}

async function handleOamMeta(request: Request, url: URL): Promise<Response> {
  if (!isAllowedProxyOrigin(request.headers.get("origin"))) {
    return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
  }
  const upstream = new URL(OAM_META_UPSTREAM);
  for (const [key, value] of url.searchParams) {
    if (!OAM_META_PARAMS.has(key)) continue;
    if (key === "limit") {
      const n = Number(value);
      const limit = Number.isFinite(n)
        ? Math.min(Math.max(Math.trunc(n), 1), OAM_MAX_LIMIT)
        : OAM_MAX_LIMIT;
      upstream.searchParams.set("limit", String(limit));
    } else {
      upstream.searchParams.append(key, value);
    }
  }
  let originResponse: Response;
  try {
    originResponse = await fetchAllowlistedUpstream(upstream.toString(), {
      headers: { accept: "application/json" },
      cf: { cacheEverything: true, cacheTtl: 120 },
    });
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }
  const headers = new Headers(CORS_HEADERS);
  headers.set("content-type", originResponse.headers.get("content-type") ?? "application/json");
  headers.set("cache-control", originResponse.ok ? OAM_CACHE_CONTROL : "no-store");
  return new Response(originResponse.body, {
    status: originResponse.status,
    headers,
  });
}

async function handleCkanSearch(request: Request, url: URL): Promise<Response> {
  if (!isAllowedProxyOrigin(request.headers.get("origin"))) {
    return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
  }
  const upstream = new URL(HDX_CKAN_SEARCH_UPSTREAM);
  const query = url.searchParams.get("q")?.trim().slice(0, 300);
  if (!query) {
    return new Response("Missing query", { status: 400, headers: CORS_HEADERS });
  }
  const rowsParam = url.searchParams.get("rows");
  const requestedRows = rowsParam === null ? Number.NaN : Number(rowsParam);
  const rows = Number.isFinite(requestedRows)
    ? Math.min(Math.max(Math.trunc(requestedRows), 1), CKAN_MAX_ROWS)
    : 20;
  const startParam = url.searchParams.get("start");
  const requestedStart = startParam === null ? Number.NaN : Number(startParam);
  const start = Number.isFinite(requestedStart)
    ? Math.min(Math.max(Math.trunc(requestedStart), 0), 10_000)
    : 0;
  upstream.searchParams.set("q", query);
  upstream.searchParams.set("rows", String(rows));
  upstream.searchParams.set("start", String(start));
  let originResponse: Response;
  try {
    originResponse = await fetchAllowlistedUpstream(upstream.toString(), {
      headers: { accept: "application/json" },
      cf: { cacheEverything: true, cacheTtl: 120 },
    });
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }
  const headers = new Headers(CORS_HEADERS);
  headers.set("content-type", originResponse.headers.get("content-type") ?? "application/json");
  headers.set("cache-control", originResponse.ok ? "public, max-age=120" : "no-store");
  return new Response(originResponse.body, {
    status: originResponse.status,
    headers,
  });
}

async function handleGithubRaw(request: Request, url: URL): Promise<Response> {
  if (!isAllowedProxyOrigin(request.headers.get("origin"))) {
    return new Response("Forbidden", { status: 403, headers: CORS_HEADERS });
  }
  const source = url.searchParams.get("url");
  let upstream: URL;
  try {
    upstream = new URL(source ?? "");
  } catch {
    return new Response("Bad Request", { status: 400, headers: CORS_HEADERS });
  }
  if (
    upstream.protocol !== "https:" ||
    upstream.hostname !== "github.com" ||
    upstream.search !== "" ||
    !GITHUB_RAW_REPOSITORY_PATH.test(upstream.pathname)
  ) {
    return new Response("Bad Request", { status: 400, headers: CORS_HEADERS });
  }
  let originResponse: Response;
  try {
    const parts = upstream.pathname.split("/").filter(Boolean);
    const rawUrl = new URL(
      `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join("/")}`,
    );
    originResponse = await fetchAllowlistedUpstream(rawUrl.toString(), {
      headers: { accept: "application/octet-stream" },
    });
  } catch {
    return new Response("Bad Gateway", { status: 502, headers: CORS_HEADERS });
  }
  const headers = new Headers(CORS_HEADERS);
  for (const key of ["content-type", "content-length", "content-disposition", "etag"]) {
    const value = originResponse.headers.get(key);
    if (value) headers.set(key, value);
  }
  headers.set("cache-control", originResponse.ok ? "public, max-age=300" : "no-store");
  return new Response(originResponse.body, {
    status: originResponse.status,
    headers,
  });
}

/** Route catalog and repository proxy requests (OAM, CKAN, Source Coop, ODP, GitHub Raw). */
export function handleCatalogRoute(request: Request, url: URL): Promise<Response> | null {
  if (url.pathname === OAM_META_PATH) return handleOamMeta(request, url);
  if (url.pathname === CKAN_SEARCH_PATH) return handleCkanSearch(request, url);
  if (url.pathname.startsWith(SOURCE_COOP_PREFIX)) return handleSourceCoop(request, url.pathname);
  if (url.pathname.startsWith("/odp/")) return handleOdp(request, url);
  if (url.pathname === GITHUB_RAW_PATH) return handleGithubRaw(request, url);
  return null;
}
