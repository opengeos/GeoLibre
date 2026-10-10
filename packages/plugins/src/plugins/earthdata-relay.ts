// The Earthdata relay route, in a leaf module with no imports so the host can
// load it at boot (earthdata-fetch-auth.ts) without pulling in the plugin.

/**
 * GeoLibre's tiles Worker route that streams a protected Earthdata file with
 * CORS (`workers/tiles/src/earthdata.ts`). The DAACs send no CORS headers, so
 * the browser build downloads through it, and COG map layers on every build
 * read through it: the layer keeps this token-free URL, and the host adds the
 * Earthdata Login token to requests under it (`earthdata-fetch-auth.ts`).
 */
export const EARTHDATA_PROXY_ENDPOINT = "https://tiles.geolibre.app/earthdata/download";

/**
 * The relay URL for an Earthdata file.
 *
 * @param url The DAAC file URL.
 * @returns The tiles Worker URL that streams it with CORS.
 */
export function earthdataProxyUrl(url: string): string {
  return `${EARTHDATA_PROXY_ENDPOINT}?url=${encodeURIComponent(url)}`;
}

/**
 * Whether a URL is an Earthdata relay URL (and so may carry the token).
 *
 * @param url Any request URL.
 * @returns True only for the exact Worker route, never a look-alike host or path.
 */
export function isEarthdataProxyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}` === EARTHDATA_PROXY_ENDPOINT;
  } catch {
    return false;
  }
}
