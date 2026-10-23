/**
 * Request headers for authenticated tile services, applied by the one
 * `transformRequest` the MapLibre maps are built with.
 *
 * MapLibre takes a single request transform per map, so a plugin that installs
 * its own with `setTransformRequest` replaces any other. Registering headers
 * here instead lets several owners (a plugin's layers, GeoLens's private
 * rasters) authenticate side by side. Headers are held in memory only: they
 * never reach the store, a saved project, or a share.
 */
import type { RequestParameters, ResourceType } from "maplibre-gl";

interface TileRequestHeaderEntry {
  urlPrefixes: readonly string[];
  headers: Readonly<Record<string, string>>;
}

const entries = new Map<string, TileRequestHeaderEntry>();

// A TileJSON URL is fetched as a "Source"; its tiles as "Tile".
const AUTHENTICATED_RESOURCE_TYPES: ReadonlySet<string> = new Set(["Tile", "Source"]);

/**
 * The part of a tile URL template before its first placeholder, which every
 * tile URL it expands to starts with.
 *
 * @param template - A tile URL template such as `https://host/tiles/{z}/{x}/{y}.pbf`.
 * @returns The fixed prefix (the whole URL when there is no placeholder).
 */
export function tileUrlPrefix(template: string): string {
  const brace = template.indexOf("{");
  return brace === -1 ? template : template.slice(0, brace);
}

// An HTTP(S) origin with a fixed host, followed by the start of a path.
const SCOPED_PREFIX = /^https?:\/\/[^/?#{}]+\//i;

/**
 * Whether `prefix` is narrow enough to carry credentials: an HTTP(S) URL whose
 * host is fixed and which goes on past it with `/`. A looser prefix would also
 * match other servers' requests: `https://` (a template with a placeholder in
 * its host), or `https://host` (which matches `https://host.evil.test`).
 *
 * @param prefix - A URL prefix, as {@link tileUrlPrefix} returns.
 * @returns True if it names one host and a path on it.
 */
export function isScopedTileUrlPrefix(prefix: string): boolean {
  if (!SCOPED_PREFIX.test(prefix)) return false;
  try {
    new URL(prefix);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attach `headers` to every tile and TileJSON request whose URL starts with one
 * of `urlPrefixes`, replacing what `key` registered before.
 *
 * @param key - The owner's key, such as a layer id.
 * @param urlPrefixes - URL prefixes to match; see {@link tileUrlPrefix}. Each
 *   must pass {@link isScopedTileUrlPrefix}, or this throws and registers
 *   nothing, so credentials can't reach other servers.
 * @param headers - The headers to send, such as `Authorization`.
 */
export function setTileRequestHeaders(
  key: string,
  urlPrefixes: readonly string[],
  headers: Readonly<Record<string, string>>,
): void {
  const prefixes = urlPrefixes.filter((prefix) => prefix.length > 0);
  if (prefixes.length === 0 || Object.keys(headers).length === 0) {
    entries.delete(key);
    return;
  }
  const unscoped = prefixes.find((prefix) => !isScopedTileUrlPrefix(prefix));
  if (unscoped !== undefined) {
    throw new Error(
      `Tile request headers need a URL with a fixed host and path before its first placeholder; "${unscoped}" could match other servers.`,
    );
  }
  entries.set(key, { urlPrefixes: [...prefixes], headers: { ...headers } });
}

/**
 * Stop adding the headers `key` registered.
 *
 * @param key - The owner's key passed to {@link setTileRequestHeaders}.
 */
export function clearTileRequestHeaders(key: string): void {
  entries.delete(key);
}

/**
 * Drop every registration whose key `shouldClear` accepts, such as all of one
 * plugin's keys when it deactivates.
 *
 * @param shouldClear - Returns true for the keys to drop.
 */
export function clearTileRequestHeadersWhere(shouldClear: (key: string) => boolean): void {
  for (const key of [...entries.keys()]) {
    if (shouldClear(key)) entries.delete(key);
  }
}

/**
 * The headers registered for `url`. When several registrations match, the
 * longest prefix wins, so a specific endpoint's credentials beat a broader one.
 *
 * @param url - The request URL.
 * @returns The headers to send, or undefined when none apply.
 */
export function tileRequestHeadersFor(url: string): Record<string, string> | undefined {
  let bestLength = -1;
  let best: Readonly<Record<string, string>> | undefined;
  for (const { urlPrefixes, headers } of entries.values()) {
    for (const prefix of urlPrefixes) {
      if (prefix.length > bestLength && url.startsWith(prefix)) {
        bestLength = prefix.length;
        best = headers;
      }
    }
  }
  return best ? { ...best } : undefined;
}

/**
 * MapLibre's `transformRequest`: adds the registered headers to tile and
 * TileJSON requests and leaves every other request alone. A header other than
 * `accept` also moves a raster tile off `HTMLImageElement` onto `fetch`, which
 * is what lets it carry headers at all.
 *
 * @param url - The request URL.
 * @param resourceType - What MapLibre is loading.
 * @returns The request with headers, or undefined to leave it unchanged.
 */
export function transformTileRequest(
  url: string,
  resourceType?: ResourceType,
): RequestParameters | undefined {
  if (entries.size === 0 || !resourceType || !AUTHENTICATED_RESOURCE_TYPES.has(resourceType)) {
    return undefined;
  }
  const headers = tileRequestHeadersFor(url);
  return headers ? { url, headers } : undefined;
}
