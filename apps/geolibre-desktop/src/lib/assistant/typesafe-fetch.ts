import { isTauri } from "../is-tauri";
import type { FastPathFetch } from "./fast-path";

/**
 * Transport for the assistant's TypeSafe fast path.
 *
 * `api.typesafe.ai` answers a browser preflight with `Disallowed CORS origin`
 * and returns no `Access-Control-Allow-Origin` on the POST, so a WebView
 * `fetch` from the app's own origin is blocked before it ever reaches the
 * service. On the desktop the request therefore goes through Tauri's native
 * HTTP client, which is not subject to the WebView's origin checks — the same
 * arrangement `geolens-fetch.ts` and `geocoding-fetch.ts` use, and it needs the
 * matching entry in `src-tauri/capabilities/default.json` (`http:default`).
 *
 * In the browser and Jupyter builds the plain `fetch` is used and will fail
 * until TypeSafe allowlists the deployment's origin. That failure is not
 * special-cased: {@link resolveFastPathAction} treats every transport error as
 * "no fast path", so those builds simply keep using the agent.
 */

/** Tauri's native fetch, taken from the plugin so a signature change fails typecheck. */
type NativeFetch = typeof import("@tauri-apps/plugin-http").fetch;

/**
 * Resolving the transport means a dynamic import on the desktop, so the result
 * is memoized — paying it on every prompt would eat into the very budget this
 * feature exists to protect.
 */
let cached: Promise<FastPathFetch> | null = null;

/** The transport to reach TypeSafe with, native on desktop and `fetch` elsewhere. */
export function typesafeFetch(): Promise<FastPathFetch> {
  cached ??= resolveTransport();
  return cached;
}

async function resolveTransport(): Promise<FastPathFetch> {
  if (!isTauri()) return browserFetch;
  try {
    const { fetch: nativeFetch } = (await import("@tauri-apps/plugin-http")) as {
      fetch: NativeFetch;
    };
    return (url, init) => nativeFetch(url, init as RequestInit);
  } catch (error) {
    // A missing capability must not disable the feature outright: browser fetch
    // still works wherever the origin happens to be allowed.
    console.warn("[geolibre] TypeSafe fast path falling back to browser fetch:", error);
    cached = null;
    return browserFetch;
  }
}

const browserFetch: FastPathFetch = (url, init) => fetch(url, init as RequestInit);

/** Drop the memoized transport. Exported for tests. */
export function resetTypesafeFetch(): void {
  cached = null;
}
