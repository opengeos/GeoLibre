import { isTauri } from "../is-tauri";
import type { SystemOneFetch } from "./system-one";

/**
 * Transport for the assistant's TypeSafe System One requests.
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
 * special-cased: {@link postSystemOne} treats every transport error as no
 * answer, so those builds simply keep using the agent and the keyword filter.
 */

/** Tauri's native fetch, taken from the plugin so a signature change fails typecheck. */
type NativeFetch = typeof import("@tauri-apps/plugin-http").fetch;

/**
 * Resolving the transport means a dynamic import on the desktop, so the result
 * is memoized — paying it on every prompt would eat into the very budget this
 * feature exists to protect.
 */
let cached: Promise<SystemOneFetch> | null = null;

/** The transport to reach TypeSafe with, native on desktop and `fetch` elsewhere. */
export function typesafeFetch(): Promise<SystemOneFetch> {
  cached ??= resolveTransport();
  return cached;
}

async function resolveTransport(): Promise<SystemOneFetch> {
  if (!isTauri()) return browserFetch;
  try {
    const { fetch: nativeFetch } = (await import("@tauri-apps/plugin-http")) as {
      fetch: NativeFetch;
    };
    return (url, init) => nativeFetch(url, init as RequestInit);
  } catch (error) {
    // A missing capability must not disable the feature outright: browser fetch
    // still works wherever the origin happens to be allowed.
    //
    // The fallback is memoized along with the success case, unlike the retrying
    // memo in `os-env.ts`. What fails here is importing the plugin or reaching
    // its capability, neither of which changes while the app is running, so a
    // retry would re-pay the failed import on every prompt — out of the very
    // latency budget this module exists to protect — and never succeed.
    console.warn("[geolibre] TypeSafe transport falling back to browser fetch:", error);
    return browserFetch;
  }
}

const browserFetch: SystemOneFetch = (url, init) => fetch(url, init as RequestInit);

/** Drop the memoized transport. Exported for tests. */
export function resetTypesafeFetch(): void {
  cached = null;
}
