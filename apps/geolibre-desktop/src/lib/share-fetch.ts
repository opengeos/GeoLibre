// The fetch used by the share.geolibre.app client: project upload
// (`share-geolibre.ts`) and the gallery reads (`share-gallery.ts`).
//
// Defaults to the WebView's browser `fetch`. The desktop build swaps in a
// native-HTTP-backed fetch (`installNativeShareFetch`) that bypasses the
// WebView's CORS enforcement for the share host — the share server's CORS
// policy allows the web origin but not the Tauri WebView origin
// (`tauri://localhost` / `http://tauri.localhost`), so a plain browser `fetch`
// from the desktop app throws a `TypeError` that surfaces to the user as
// "Could not reach share.geolibre.app." This mirrors the geocoding fix in
// `geocoding-fetch.ts`.

import { resolveShareBaseUrl } from "./share-geolibre";

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

/**
 * Route requests to the share host through Tauri's native HTTP client instead of
 * the WebView's `fetch`, bypassing browser CORS enforcement. Requests to any
 * other host keep the browser `fetch` unchanged, so the native, CORS-exempt
 * client stays scoped to the single share origin — which must also be listed in
 * the `http:default` capability scope (`src-tauri/capabilities/default.json`).
 *
 * The host is resolved from {@link resolveShareBaseUrl} (the configured or
 * production share URL) at install time, so a `VITE_GEOLIBRE_SHARE_URL` override
 * is honored. When it resolves to null — sharing disabled, or a configured host
 * that was rejected — no override is installed and every request keeps the
 * browser `fetch`.
 *
 * Note that a self-hosted host still has to be listed in the Tauri `http:default`
 * capability scope to be reachable from the desktop build; the web build (where
 * self-hosting is configured) has no such constraint.
 *
 * Loaded lazily and only in the desktop build so the web/embedded bundles never
 * pull in `@tauri-apps/plugin-http`.
 */
export async function installNativeShareFetch(): Promise<void> {
  const baseUrl = resolveShareBaseUrl();
  if (!baseUrl) return;
  const shareOrigin = requestOrigin(baseUrl);
  if (!shareOrigin) return;
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  setShareFetch((input, init) => {
    if (requestOrigin(input) !== shareOrigin) {
      // Not the share origin (a third-party thumbnail, a project URL, or the same
      // host over plaintext): keep the browser fetch, unchanged and outside the
      // native capability scope.
      return fetch(input, init);
    }
    return tauriFetch(input, init);
  });
}
