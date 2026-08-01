import {
  createGeoLensHostFetch,
  setGeoLensFetch,
  type GeoLensFetch,
  type GeoLensHttpResponse,
} from "@geolibre/plugins";

/** The public service bundled into the GeoLens server picker. */
const GEOLIBRE_DATASETS_HOST = "datasets.geolibre.app";

/**
 * Build the desktop GeoLens transport.
 *
 * Only the built-in GeoLibre datasets host goes through Tauri's native HTTP
 * client, so production WebView origins are not blocked when the service's
 * CORS allowlist changes. Custom/self-hosted GeoLens deployments remain on
 * browser fetch and therefore stay outside the Tauri capability scope.
 */
export async function installNativeGeoLensFetch(): Promise<void> {
  const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
  const nativeFetch: GeoLensFetch = (url, init) =>
    tauriFetch(url, init as RequestInit) as unknown as Promise<GeoLensHttpResponse>;
  setGeoLensFetch(createGeoLensHostFetch(GEOLIBRE_DATASETS_HOST, nativeFetch));
}
