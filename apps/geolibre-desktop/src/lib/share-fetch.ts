// The share client uses browser fetch by default. Desktop uses native HTTP only
// for the shipped share.geolibre.app origin, which is narrowly permitted by the
// Tauri HTTP capability. Self-hosted servers must explicitly allow the desktop
// WebView origin in CORS (tauri://localhost on macOS/Linux and
// http://tauri.localhost on Windows); requests are never retried via native HTTP.

import type { fetch as nativeHttpFetch } from "@tauri-apps/plugin-http";
import { DEFAULT_SHARE_BASE_URL, resolveShareBaseUrl } from "./share-geolibre";

/**
 * The active share fetch. Browser `fetch` by default; the desktop build
 * overrides it via {@link installNativeShareFetch}. Callers read it lazily
 * through {@link getShareFetch} so the override applies even to modules imported
 * before install runs.
 */
let shareFetch: typeof globalThis.fetch = (input, init) => fetch(input, init);

/** The fetch the share client should use; the desktop build overrides it. */
export function getShareFetch(): typeof globalThis.fetch {
  return shareFetch;
}

/** Override the share fetch. Exposed for {@link installNativeShareFetch} and tests. */
export function setShareFetch(fetchImpl: typeof globalThis.fetch): void {
  shareFetch = fetchImpl;
}

/** Restore the default browser `fetch` (used to reset state between tests). */
export function resetShareFetch(): void {
  shareFetch = (input, init) => fetch(input, init);
}

/**
 * The request URL's origin, or null when it cannot be parsed.
 *
 * Origin, not host: the host of `http://maps.example.org` and
 * `https://maps.example.org` is identical, so matching on host alone would route
 * a plaintext request to a host configured over HTTPS through the CORS-exempt
 * native client.
 */
export function requestOrigin(input: RequestInfo | URL): string | null {
  try {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const origin = new URL(href).origin;
    // `new URL("mailto:a@b").origin` is the string "null"; never match that.
    return origin && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
}

// Resolve lazily: share-geolibre imports getShareFetch and can load first in
// tests, before its DEFAULT_SHARE_BASE_URL export has initialized.
let nativeShareOrigin: string | null = null;
function shippedShareOrigin(): string {
  return nativeShareOrigin ?? (nativeShareOrigin = new URL(DEFAULT_SHARE_BASE_URL).origin);
}

type NativeFetch = typeof nativeHttpFetch;

/**
 * Route the shipped share origin through Tauri HTTP; all other origins use the
 * WebView's fetch and its normal CORS enforcement. Redirects on credentialed
 * native requests are disabled in reqwest, since the plugin ignores the web
 * Request.redirect setting and could otherwise forward Authorization off-site.
 */
export function createNativeShareFetch(
  tauriFetch: NativeFetch,
  browserFetch: typeof fetch = (input, init) => globalThis.fetch(input, init),
): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    if (requestOrigin(input) !== shippedShareOrigin()) return browserFetch(input, init);

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const protectedRequest =
      headers.has("Authorization") ||
      (init?.redirect ?? (input instanceof Request ? input.redirect : undefined)) === "error";
    if (!protectedRequest) return tauriFetch(input, init);

    return tauriFetch(input, { ...init, maxRedirections: 0 }).then((response) => {
      if (response.status >= 300 && response.status < 400) {
        throw new TypeError("Redirect refused for authenticated share request");
      }
      return response;
    });
  }) as typeof fetch;
}

/**
 * Install native HTTP only when sharing targets the shipped origin. For a
 * self-hosted deployment the browser fetch remains active and the server must
 * allow the exact desktop WebView origin in its CORS policy. The plugin is
 * imported lazily because the Tauri plugin is unavailable in web/embedded
 * runtimes.
 */
export async function installNativeShareFetch(): Promise<void> {
  if (requestOrigin(resolveShareBaseUrl() ?? "") !== shippedShareOrigin()) return;
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  setShareFetch(createNativeShareFetch(tauriFetch));
}
