import {
  createGeoLensHostFetch,
  GEOLENS_SAMPLE_SERVERS,
  setGeoLensFetch,
  type GeoLensFetch,
  type GeoLensHttpResponse,
} from "@geolibre/plugins";

/** Domain suffix of the GeoLens deployments GeoLibre operates. */
const GEOLIBRE_HOST_SUFFIX = ".geolibre.app";

/**
 * Hosts of the GeoLibre-operated servers in the GeoLens picker, derived from
 * the sample-server registry so the two cannot drift (the same approach
 * `geocoding-fetch.ts` takes with `GEOCODING_PROVIDERS`). The suffix filter is
 * what keeps this to *our* deployments: the picker also offers a third-party
 * demo server, which must stay on the browser `fetch` and outside the native
 * client's reach. The Tauri capability scope (`src-tauri/capabilities/
 * default.json`, `http:default`) must list the same hosts.
 */
const NATIVE_FETCH_HOSTS = new Set(
  GEOLENS_SAMPLE_SERVERS.flatMap((server) => {
    try {
      const { host } = new URL(server.baseUrl);
      return host.endsWith(GEOLIBRE_HOST_SUFFIX) ? [host] : [];
    } catch {
      return [];
    }
  }),
);

/**
 * Build the desktop GeoLens transport.
 *
 * Only the GeoLibre-operated datasets hosts go through Tauri's native HTTP
 * client, so production WebView origins are not blocked when the service's
 * CORS allowlist changes. Custom and self-hosted GeoLens deployments remain on
 * browser fetch and therefore stay outside the Tauri capability scope.
 */
export async function installNativeGeoLensFetch(): Promise<void> {
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  const nativeFetch: GeoLensFetch = (url, init) =>
    tauriFetch(url, init as RequestInit) as unknown as Promise<GeoLensHttpResponse>;
  setGeoLensFetch(createGeoLensHostFetch(NATIVE_FETCH_HOSTS, nativeFetch));
}
