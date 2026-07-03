import { setGeocodingFetch } from "@geolibre/core";

/**
 * Identify the app to geocoding services. Nominatim's usage policy requires a
 * User-Agent (or Referer) naming the application; the WebView's browser `fetch`
 * cannot set that header, but Tauri's native HTTP client can.
 */
const GEOCODER_USER_AGENT =
  "GeoLibre-Desktop (+https://github.com/opengeos/GeoLibre)";

/**
 * Route geocoding requests through Tauri's native HTTP client instead of the
 * WebView's `fetch`.
 *
 * This bypasses browser CORS enforcement: public Nominatim's CDN intermittently
 * drops the `Access-Control-Allow-Origin` header on cached responses, which the
 * WebView then rejects — surfacing to the user as "Search failed. Try again."
 * (the symptom that failed Microsoft Store certification). The native client is
 * not bound by CORS and can also send a proper User-Agent, as Nominatim's usage
 * policy requires.
 *
 * Loaded lazily and only in the desktop build so the web/embedded bundles never
 * pull in `@tauri-apps/plugin-http`.
 */
export async function installNativeGeocodingFetch(): Promise<void> {
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  const nativeFetch: typeof globalThis.fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("User-Agent", GEOCODER_USER_AGENT);
    return tauriFetch(input, { ...init, headers });
  };
  setGeocodingFetch(nativeFetch);
}
