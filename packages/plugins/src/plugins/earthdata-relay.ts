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
 * Whether a URL is on a NASA Earthdata data host, the only place the Earthdata
 * Login token may be sent. CMR `data` links are chosen by each data provider,
 * so a link on any other host gets no token. Mirrors `isEarthdataDataUrl` in
 * `workers/tiles/src/earthdata.ts`, which the relay enforces on its side.
 *
 * @param url A granule file URL.
 * @returns True for HTTPS `*.earthdatacloud.nasa.gov` / `*.earthdata.nasa.gov`,
 *   never the login host.
 */
export function isEarthdataDataUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "urs.earthdata.nasa.gov") return false;
  const within = (suffix: string) => host === suffix || host.endsWith(`.${suffix}`);
  return within("earthdatacloud.nasa.gov") || within("earthdata.nasa.gov");
}

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
