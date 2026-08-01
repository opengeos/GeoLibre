/**
 * SSRF guard for the Vite dev-server `__geolibre_*_proxy` binary proxies.
 *
 * Validates that a target URL is a public HTTP(S) address (not loopback,
 * private RFC-1918, link-local, metadata, or IPv6 ULA/loopback), resolves
 * DNS names and checks every returned address before connecting (with a
 * custom undici lookup that pins the connection to a validated address),
 * and follows redirects manually while re-validating each hop.
 *
 * Exported so `tests/` can import and exercise the guard without pulling in
 * the full vite.config.
 */

import { lookup as dnsLookupCallback } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Agent, fetch as undiciFetch } from "undici";

export const PROXY_MAX_REDIRECT_HOPS = 5;
export const PROXY_MAX_BODY_BYTES = 50 * 1024 * 1024; // 50 MB
export const PROXY_FETCH_TIMEOUT_MS = 30_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Returns an error message if `urlString` is not a safe public HTTP(S) URL,
 * or `null` when it is acceptable. This only inspects the literal hostname;
 * call {@link assertResolvedPublicHost} before connecting so DNS names that
 * resolve to private addresses are also refused.
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
  // Non-default ports are remapped/ignored differently across runtimes; keep
  // the allowlist on the default http/https ports only.
  if (parsed.port !== "") {
    return `Blocked non-default port: ${parsed.port}`;
  }
  const hostname = parsed.hostname;
  const bare = stripIpv6Brackets(hostname);

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

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isIpv4Literal(host: string): boolean {
  const parts = host.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p));
}

function isIpv6Literal(host: string): boolean {
  return host.includes(":");
}

/** True when `host` is a literal IPv4/IPv6 address (not a DNS name). */
export function isIpLiteral(host: string): boolean {
  const bare = stripIpv6Brackets(host);
  return isIpv4Literal(bare) || isIpv6Literal(bare);
}

export function isPrivateHost(host: string): boolean {
  const bare = stripIpv6Brackets(host);
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;

  if (isIpv4Literal(bare)) {
    const octets = bare.split(".").map(Number);
    if (octets.some((o) => o > 255)) return false;
    return isPrivateIPv4(octets);
  }

  if (isIpv6Literal(bare)) {
    return isPrivateIPv6(bare);
  }

  if (bare === "metadata.google.internal") return true;

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
  if (a === 192 && b === 0 && octets[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && octets[2] === 100) return true; // 198.51.100.0/24 documentation
  if (a === 203 && b === 0 && octets[2] === 113) return true; // 203.0.113.0/24 documentation
  if (a >= 224) return true; // 224.0.0.0+ multicast + reserved
  return false;
}

function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();

  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(lower);
  if (mappedDotted) {
    return isPrivateIPv4(mappedDotted[1].split(".").map(Number));
  }

  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(lower);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateIPv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]);
  }

  if (lower === "::1") return true; // loopback
  if (lower === "::") return true; // unspecified

  // Link-local is fe80::/10 (first hextet 0xfe80–0xfebf), not merely "fe80:".
  const firstHextet = parseInt(lower.split(":")[0] || "", 16);
  if (Number.isFinite(firstHextet) && (firstHextet & 0xffc0) === 0xfe80) return true;

  // ULA fc00::/7
  if (Number.isFinite(firstHextet) && (firstHextet & 0xfe00) === 0xfc00) return true;

  return false;
}

/**
 * Resolve `hostname` (when it is a DNS name) and refuse if any returned
 * address is private/reserved. IP literals are checked synchronously.
 */
export async function assertResolvedPublicHost(hostname: string): Promise<void> {
  const bare = stripIpv6Brackets(hostname);
  if (isIpLiteral(bare)) {
    if (isPrivateHost(bare)) {
      throw new Error(`Blocked private/reserved address: ${hostname}`);
    }
    return;
  }
  if (isPrivateHost(bare)) {
    throw new Error(`Blocked private/reserved address: ${hostname}`);
  }
  const results = await dnsLookup(bare, { all: true, verbatim: true });
  if (results.length === 0) {
    throw new Error(`DNS lookup returned no addresses for ${hostname}`);
  }
  for (const { address } of results) {
    if (isPrivateHost(address)) {
      throw new Error(`Blocked private/reserved address: ${hostname} → ${address}`);
    }
  }
}

/**
 * undici Agent whose DNS lookup validates every address and only hands the
 * connector a previously-checked public address — closing the rebinding
 * window between a pre-check and connect.
 */
const guardedDispatcher = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dnsLookupCallback(hostname, { all: true, verbatim: true, ...options }, (err, addresses) => {
        if (err) {
          callback(err as NodeJS.ErrnoException, "", 4);
          return;
        }
        const list = Array.isArray(addresses)
          ? addresses
          : [{ address: String(addresses), family: 4 as const }];
        if (list.length === 0) {
          callback(
            Object.assign(new Error(`DNS lookup returned no addresses for ${hostname}`), {
              code: "ENOTFOUND",
            }),
            "",
            4,
          );
          return;
        }
        for (const entry of list) {
          if (isPrivateHost(entry.address)) {
            callback(
              Object.assign(
                new Error(`Blocked private/reserved address: ${hostname} → ${entry.address}`),
                { code: "ENOTFOUND" },
              ),
              "",
              4,
            );
            return;
          }
        }
        const chosen = list[0];
        callback(null, chosen.address, chosen.family);
      });
    },
  },
});

function mergeAbortSignals(timeoutMs: number, caller?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) return timeout;
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === "function") return any([timeout, caller]);
  return timeout;
}

/**
 * Fetch `targetUrl` with manual redirect following, DNS-resolved SSRF checks,
 * a per-hop timeout, and (by default) a dispatcher that pins connects to
 * validated addresses. Returns the final Response or throws on disallowed
 * targets / too many hops.
 *
 * `options.fetchImpl` is for tests; production callers leave it unset so the
 * undici agent with the validating DNS lookup is used.
 */
export async function fetchWithGuard(
  targetUrl: string,
  init: RequestInit = {},
  options: {
    timeoutMs?: number;
    fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  } = {},
): Promise<Response> {
  assertPublicHttpUrl(targetUrl);
  const timeoutMs = options.timeoutMs ?? PROXY_FETCH_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl;

  let current = targetUrl;
  for (let hop = 0; hop <= PROXY_MAX_REDIRECT_HOPS; hop++) {
    // Production always resolves so DNS-rebinding hosts are refused. Injected
    // fetchImpl (unit tests) skips the lookup so offline mocks stay offline.
    if (!fetchImpl) {
      await assertResolvedPublicHost(new URL(current).hostname);
    }

    const { signal: callerSignal, ...rest } = init;
    const signal = mergeAbortSignals(timeoutMs, callerSignal ?? null);
    const response = fetchImpl
      ? await fetchImpl(current, { ...rest, signal, redirect: "manual" })
      : ((await undiciFetch(current, {
          ...rest,
          signal,
          redirect: "manual",
          dispatcher: guardedDispatcher,
        })) as unknown as Response);
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
 * Read an upstream body while enforcing {@link PROXY_MAX_BODY_BYTES}. Checks
 * Content-Length early when present and aborts mid-stream if the running
 * total exceeds the cap.
 */
export async function readBodyWithLimit(
  response: Response,
  maxBytes: number = PROXY_MAX_BODY_BYTES,
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("Upstream response exceeds size limit");
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Upstream response exceeds size limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/**
 * Hardened version of the Vite dev-server binary proxy handler. Validates the
 * target URL against SSRF rules (including DNS resolution), follows redirects
 * manually, and caps the response body size while streaming.
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
  let body: Buffer;
  try {
    body = await readBodyWithLimit(response);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("content-type", "text/plain");
    res.end(err instanceof Error ? err.message : "Upstream response exceeds size limit");
    return;
  }

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
