// Shared helpers for the web.geolibre.app / viewer.geolibre.app proxy.
// Kept free of the Worker `export default` so unit tests can import them
// without Cloudflare runtime types.

/** Origin of record for the viewer static build (GitHub Pages). */
export const VIEWER_ORIGIN = "https://geolibre.app/demo";

/** Hostnames the upstream may redirect within (never leave geolibre.app). */
export const ALLOWED_UPSTREAM_HOSTS = new Set(["geolibre.app"]);

/** Cap server-side redirect hops so a misconfigured origin cannot loop us. */
export const MAX_REDIRECT_HOPS = 5;

const ALLOWED_METHODS = new Set(["GET", "HEAD"]);

/** HTTP statuses that carry a Location and should be followed manually. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Reject pathnames that could escape `/demo` via traversal once joined with
 * the origin prefix. Returns the cleaned pathname, or null when unsafe.
 */
export function sanitizeViewerPath(pathname: string): string | null {
  if (!pathname.startsWith("/")) return null;
  const lower = pathname.toLowerCase();
  // Block backslash, encoded dots, and encoded slashes so a smuggled
  // `/foo%2f..%2fsecret` cannot bypass the literal `..` segment check.
  if (
    pathname.includes("\\") ||
    lower.includes("%2e") ||
    lower.includes("%2f") ||
    lower.includes("%5c")
  ) {
    return null;
  }
  const segments = pathname.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  return pathname;
}

/**
 * Whether a resolved upstream URL is still an HTTPS geolibre.app path under
 * `/demo` (the only origin this proxy is allowed to fetch).
 */
export function isAllowedUpstreamUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    // Default HTTPS only — non-empty ports (e.g. :8443) are ignored or
    // remapped by Workers outbound fetch and must not pass the allowlist.
    if (parsed.port !== "") return false;
    if (!ALLOWED_UPSTREAM_HOSTS.has(parsed.hostname)) return false;
    // Keep redirects under the demo prefix so a 302 to https://geolibre.app/
    // (the marketing site) cannot be served under the viewer hostname.
    return parsed.pathname === "/demo" || parsed.pathname.startsWith("/demo/");
  } catch {
    return false;
  }
}

/**
 * Strip hop-by-hop and credential headers a public static-asset proxy never
 * needs, and drop Set-Cookie from the origin so the viewer host cannot be
 * used to plant cookies for geolibre.app.
 */
export function sanitizeUpstreamResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  headers.delete("set-cookie2");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Proxy one viewer request to geolibre.app/demo, following only same-site
 * redirects that stay under `/demo`. Cross-origin (or off-prefix) Locations
 * become 502 instead of being fetched and re-hosted under the viewer hostname.
 */
export async function proxyViewerRequest(
  request: Request,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  if (!ALLOWED_METHODS.has(request.method)) {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const url = new URL(request.url);
  const pathname = sanitizeViewerPath(url.pathname);
  if (pathname === null) {
    return new Response("Bad Request", { status: 400 });
  }

  let target = `${VIEWER_ORIGIN}${pathname}${url.search}`;
  if (!isAllowedUpstreamUrl(target)) {
    return new Response("Bad Request", { status: 400 });
  }

  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");

  try {
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      const response = await fetchImpl(target, {
        method: request.method,
        headers,
        body: null,
        redirect: "manual",
      });

      // Pass through non-redirect responses, including 304 Not Modified from
      // conditional revalidation (If-None-Match / If-Modified-Since).
      if (!REDIRECT_STATUSES.has(response.status)) {
        return sanitizeUpstreamResponse(response);
      }

      const location = response.headers.get("location");
      if (!location) {
        return new Response("Bad Gateway", { status: 502 });
      }

      const next = new URL(location, target).toString();
      if (!isAllowedUpstreamUrl(next)) {
        return new Response("Bad Gateway", { status: 502 });
      }
      target = next;
    }
    return new Response("Bad Gateway", { status: 502 });
  } catch {
    return new Response("Bad Gateway", { status: 502 });
  }
}
