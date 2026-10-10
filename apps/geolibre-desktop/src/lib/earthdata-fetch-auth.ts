/**
 * Adds the Earthdata Login token to requests for GeoLibre's Earthdata relay
 * (`workers/tiles/src/earthdata.ts`), so a NASA GeoTIFF added by the
 * Earthaccess plugin works as an ordinary COG layer.
 *
 * The COG readers (cog-tiler-wasm, maplibre-gl-raster) fetch with the global
 * `fetch` and take no headers, and the DAACs send no CORS headers, so a layer
 * reads through the relay URL. That URL carries no secret, which keeps the
 * token out of saved projects; the token is attached here, at request time,
 * and only to that one exact route.
 */

import { isEarthdataProxyUrl } from "@geolibre/plugins/earthdata-relay";
import { pluginCredentialHost } from "./plugin-credentials";

/** The Earthaccess plugin's id and credential name (see maplibre-earthaccess.ts). */
const EARTHACCESS_PLUGIN_ID = "geolibre-earthaccess";
const TOKEN_CREDENTIAL = "earthdataToken";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Wrap a fetch so relay requests carry the Earthdata Login token.
 *
 * @param fetchImpl The fetch to wrap.
 * @param getToken Reads the saved token ("" when none).
 * @returns A fetch with the same signature.
 */
export function withEarthdataAuth(
  fetchImpl: typeof globalThis.fetch,
  getToken: () => string,
): typeof globalThis.fetch {
  return (input, init) => {
    if (!isEarthdataProxyUrl(requestUrl(input))) return fetchImpl(input, init);
    const token = getToken();
    if (!token) return fetchImpl(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    // A caller that already authenticates (the plugin's own downloads) wins.
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
    return fetchImpl(input, { ...init, headers });
  };
}

/** Read the saved token; empty before credentials hydrate or when unset. */
function savedToken(): string {
  try {
    return pluginCredentialHost.get(TOKEN_CREDENTIAL, EARTHACCESS_PLUGIN_ID);
  } catch {
    return "";
  }
}

if (typeof window !== "undefined" && typeof window.fetch === "function") {
  window.fetch = withEarthdataAuth(window.fetch.bind(window), savedToken);
}
