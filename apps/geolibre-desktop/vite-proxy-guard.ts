/**
 * SSRF guard for the Vite dev-server `__geolibre_*_proxy` binary proxies.
 *
 * Validates that a target URL is a public HTTP(S) address (not loopback,
 * private RFC-1918, link-local, metadata, or IPv6 ULA/loopback) and follows
 * redirects manually, re-validating each hop against the same rules.
 *
 * Exported so `tests/` can import and exercise the guard without pulling in
 * the full vite.config.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

const PROXY_MAX_REDIRECT_HOPS = 5;
const PROXY_MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Returns an error message if `urlString` is not a safe public HTTP(S) URL,
 * or `null` when it is acceptable.
 */
export function validatePublicUrl(urlString: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return "Malformed URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Only http/https URLs are allowed";
  }
  if (parsed.username || parsed.password) {
    return "URLs with credentials are not allowed";
  }
  const hostname = parsed.hostname;
  // Strip IPv6 brackets for address checks.
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;

  if (isPrivateHost(bare)) {
    return `Blocked private/reserved address: ${hostname}`;
  }
  return null;
}

/**
 * Throws if `urlString` is not a safe, publicly-routable HTTP(S) URL.
 */
export function assertPublicHttpUrl(urlString: string): void {
  const err = validatePublicUrl(urlString);
  if (err) throw new Error(err);
}

function isPrivateHost(host: string): boolean {
  // Loopback names
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  // IPv4 checks
  const ipv4Parts = host.split(".");
  if (ipv4Parts.length === 4 && ipv4Parts.every((p) => /^\d{1,3}$/.test(p))) {
    const octets = ipv4Parts.map(Number);
    if (octets.some((o) => o > 255)) return false; // not a valid IPv4, let DNS decide
    return isPrivateIPv4(octets);
  }

  // IPv6 checks (bare, already stripped of brackets)
  if (host.includes(":")) {
    return isPrivateIPv6(host);
  }

  // DNS names like "metadata.google.internal" — block if they resolve to a
  // known cloud metadata hostname pattern (the actual resolution to 169.254.*
  // is caught by IPv4 checks when the caller resolves, but we block the name
  // too for defence in depth).
  if (host === "metadata.google.internal") return true;

  return false;
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
  if (a === 0) return true; // 0.0.0.0/8 "this" network
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0.0/24 IETF protocol
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && octets[2] === 100) return true; // 198.51.100.0/24 documentation
  if (a === 203 && b === 0 && octets[2] === 113) return true; // 203.0.113.0/24 documentation
  if (a >= 224) return true; // 224.0.0.0+ multicast + reserved
  return false;
}

function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();

  // Handle ::ffff:a.b.c.d mapped IPv4 (dotted-quad form)
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(lower);
  if (mappedDotted) {
    return isPrivateIPv4(mappedDotted[1].split(".").map(Number));
  }

  // Handle ::ffff:HHHH:HHHH mapped IPv4 (hex form — Node.js normalizes to this)
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(lower);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateIPv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]);
  }

  if (lower === "::1") return true; // loopback
  if (lower === "::") return true; // unspecified
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7

  return false;
}

/**
 * Fetch `targetUrl` with manual redirect following, re-validating each hop.
 * Returns the final Response or throws on disallowed targets / too many hops.
 */
export async function fetchWithGuard(targetUrl: string, init: RequestInit = {}): Promise<Response> {
  assertPublicHttpUrl(targetUrl);

  let current = targetUrl;
  for (let hop = 0; hop <= PROXY_MAX_REDIRECT_HOPS; hop++) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) return response;
    const next = new URL(location, current).toString();
    assertPublicHttpUrl(next);
    current = next;
  }
  throw new Error("Too many proxy redirects");
}

/**
 * Hardened version of the Vite dev-server binary proxy handler. Validates the
 * target URL against SSRF rules, follows redirects manually, and caps the
 * response body size.
 */
export async function proxyBinaryRequestGuarded(
  req: IncomingMessage,
  res: ServerResponse,
  proxyPath: string,
): Promise<void> {
  const requestUrl = new URL(req.url ?? "", `http://localhost${proxyPath}`);
  const target = requestUrl.searchParams.get("url");
  if (!target || !/^https?:\/\//i.test(target)) {
    res.statusCode = 400;
    res.setHeader("content-type", "text/plain");
    res.end("Missing or invalid target URL");
    return;
  }

  const urlErr = validatePublicUrl(target);
  if (urlErr) {
    res.statusCode = 502;
    res.setHeader("content-type", "text/plain");
    res.end(urlErr);
    return;
  }

  const headers = new Headers();
  const range = req.headers.range;
  if (range) headers.set("range", range);

  let response: Response;
  try {
    response = await fetchWithGuard(target, { headers });
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("content-type", "text/plain");
    res.end(err instanceof Error ? err.message : "Upstream fetch failed");
    return;
  }

  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const buf = await response.arrayBuffer();
  if (buf.byteLength > PROXY_MAX_BODY_BYTES) {
    res.statusCode = 502;
    res.setHeader("content-type", "text/plain");
    res.end("Upstream response exceeds size limit");
    return;
  }
  const body = Buffer.from(buf);

  res.statusCode = response.status;
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("cache-control", "public, max-age=3600");
  res.setHeader("content-type", contentType);
  for (const header of ["accept-ranges", "content-range"]) {
    const value = response.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  res.setHeader("content-length", String(body.byteLength));
  res.end(body);
}
