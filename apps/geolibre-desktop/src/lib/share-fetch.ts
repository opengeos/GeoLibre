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

/** The request URL's host, or null when it cannot be parsed. */
function requestHost(input: RequestInfo | URL): string | null {
  try {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(href).host;
  } catch {
    return null;
  }
}

/**
 * Route requests to the share host through Tauri's native HTTP client instead of
 * the WebView's `fetch`, bypassing browser CORS enforcement. Requests to any
 * other host keep the browser `fetch` unchanged, so the native, CORS-exempt
 * client stays scoped to the single share host — which must also be listed in
 * the `http:default` capability scope (`src-tauri/capabilities/default.json`).
 *
 * The host is resolved from {@link resolveShareBaseUrl} (the configured or
 * production share URL) at install time, so a `VITE_GEOLIBRE_SHARE_URL` override
 * is honored.
 *
 * Loaded lazily and only in the desktop build so the web/embedded bundles never
 * pull in `@tauri-apps/plugin-http`.
 */
export async function installNativeShareFetch(): Promise<void> {
  let shareHost: string | null;
  try {
    shareHost = new URL(resolveShareBaseUrl()).host;
  } catch {
    shareHost = null;
  }
  if (!shareHost) return;
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  setShareFetch((input, init) => {
    if (requestHost(input) !== shareHost) {
      // Not the share host (e.g. a third-party thumbnail or project URL): keep
      // the browser fetch, unchanged and outside the native capability scope.
      return fetch(input, init);
    }
    return tauriFetch(input, init);
  });
}
