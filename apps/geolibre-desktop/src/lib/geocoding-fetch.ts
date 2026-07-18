import { GEOCODING_PROVIDERS, setGeocodingFetch } from "@geolibre/core";

/**
 * Identify the app to geocoding services. Nominatim's usage policy requires a
 * User-Agent (or Referer) naming the application; the WebView's browser `fetch`
 * cannot set that header, but Tauri's native HTTP client can.
 */
const GEOCODER_USER_AGENT = "GeoLibre-Desktop (+https://github.com/opengeos/GeoLibre)";

/**
 * Hosts of the built-in geocoding providers' default endpoints. Only these are
 * routed through the native HTTP client; any other host (a project-configured
 * custom or self-hosted endpoint) keeps the browser `fetch` — unchanged from
 * before this bypass existed. This bounds the native, CORS-exempt client to the
 * exact hosts that need it, and it stays in sync with the provider registry in
 * `@geolibre/core`. The Tauri capability scope (`src-tauri/capabilities/
 * default.json`, `http:default`) must list the same hosts.
 */
const NATIVE_FETCH_HOSTS = new Set(
  GEOCODING_PROVIDERS.flatMap((provider) =>
    [provider.defaultForwardEndpoint, provider.defaultReverseEndpoint].flatMap((endpoint) => {
      try {
        return [new URL(endpoint).host];
      } catch {
        return [];
      }
    }),
  ),
);

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
 * Route geocoding requests to the built-in providers through Tauri's native
 * HTTP client instead of the WebView's `fetch`.
 *
 * This bypasses browser CORS enforcement: public Nominatim's CDN intermittently
 * drops the `Access-Control-Allow-Origin` header on cached responses, which the
 * WebView then rejects — surfacing to the user as "Search failed. Try again."
 * (the symptom that failed Microsoft Store certification). The native client is
 * not bound by CORS and can also send a proper User-Agent, as Nominatim's usage
 * policy requires. Requests to any other host fall back to the browser `fetch`,
 * so the native client stays scoped to the known provider hosts.
 *
 * Loaded lazily and only in the desktop build so the web/embedded bundles never
 * pull in `@tauri-apps/plugin-http`.
 */
export async function installNativeGeocodingFetch(): Promise<void> {
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  const nativeFetch: typeof globalThis.fetch = (input, init) => {
    const host = requestHost(input);
    if (!host || !NATIVE_FETCH_HOSTS.has(host)) {
      // Custom/self-hosted endpoint: keep the browser fetch (its behavior is
      // unchanged by this fix, and it is outside the native capability scope).
      return fetch(input, init);
    }
    const headers = new Headers(init?.headers);
    headers.set("User-Agent", GEOCODER_USER_AGENT);
    return tauriFetch(input, { ...init, headers });
  };
  setGeocodingFetch(nativeFetch);
}
