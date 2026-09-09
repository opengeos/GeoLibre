import type { fetch as nativeFetch } from "@tauri-apps/plugin-http";

/** Protect ArcGIS tokens from plaintext requests and automatic redirect downgrades. */
export function createNativeArcGISFetch(fetchImpl: typeof nativeFetch): typeof globalThis.fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const authenticated = Boolean(url.searchParams.get("token"));
    if (authenticated && url.protocol !== "https:") {
      return Promise.reject(new Error("ArcGIS access tokens require HTTPS."));
    }
    // Tauri's native client can follow redirects outside the original URL's
    // capability scope. Authenticated services must use their canonical URL so
    // a redirect cannot disclose a token to plaintext HTTP or another host.
    return fetchImpl(input, authenticated ? { ...init, maxRedirections: 0 } : init);
  };
}

/** Route desktop ArcGIS REST downloads through Rust, outside WebView CORS. */
export async function installNativeArcGISFetch(): Promise<void> {
  const { setArcGISFetch } = await import("@geolibre/plugins");
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  setArcGISFetch(createNativeArcGISFetch(tauriFetch));
}
