import { getGoogleMapsApiKey } from "./runtime-env";

// Shared request-header resolution for 3D Tiles layers. Google Photorealistic
// 3D Tiles authenticate with a Maps API key sent in the `X-GOOG-API-KEY` header,
// but the key is deliberately stripped from the store/project record (so shared
// projects never carry it in plain text) and re-injected at render time from
// runtime env. Both the MapLibre/deck.gl render path (packages/plugins) and the
// Cesium globe path (packages/map) must resolve headers the same way, so the
// logic lives here in core rather than being duplicated per renderer.

/** Google Photorealistic 3D Tiles root host + path. */
const GOOGLE_PHOTOREALISTIC_TILES_HOST = "tile.googleapis.com";
const GOOGLE_PHOTOREALISTIC_TILES_PATH = "/v1/3dtiles/root.json";
/** Header Google's tile server expects the Maps API key in. */
export const GOOGLE_MAPS_API_KEY_HEADER = "X-GOOG-API-KEY";

/** Whether `url` points at Google's Photorealistic 3D Tiles root tileset. */
export function isGooglePhotorealisticTilesetUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === GOOGLE_PHOTOREALISTIC_TILES_HOST &&
      parsed.pathname === GOOGLE_PHOTOREALISTIC_TILES_PATH
    );
  } catch {
    return false;
  }
}

/** A masked placeholder (all asterisks) is a UI stand-in, not a real key. */
function isMaskedKey(value: string): boolean {
  return /^\*+$/.test(value.trim());
}

/** Drop the `X-GOOG-API-KEY` header (case-insensitive), keeping the rest. */
export function stripGoogleMapsApiKeyHeader(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const entries = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() !== GOOGLE_MAPS_API_KEY_HEADER.toLowerCase(),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * The real `X-GOOG-API-KEY` value from `headers`, or `undefined` when absent,
 * blank, or a masked placeholder.
 */
export function googleMapsApiKeyHeaderValue(
  headers: Record<string, string> | undefined,
): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === GOOGLE_MAPS_API_KEY_HEADER.toLowerCase(),
  );
  const value = entry?.[1].trim();
  if (!value || isMaskedKey(value)) return undefined;
  return value;
}

/** Collapse an empty record to `undefined`, otherwise pass it through. */
export function nonEmptyRecord(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  return value && Object.keys(value).length > 0 ? value : undefined;
}

/**
 * Resolve the request headers a 3D Tiles layer should load with. For non-Google
 * tilesets the headers pass through unchanged. For Google Photorealistic tiles
 * the `X-GOOG-API-KEY` header is (re)built from, in order: an explicit key in
 * the given headers, the `googleMapsApiKey` argument, then `getGoogleMapsApiKey()`
 * (runtime env). Returns `undefined` when there is nothing to send.
 */
export function resolveThreeDTilesRequestHeaders(
  url: string,
  headers: Record<string, string> | undefined,
  googleMapsApiKey?: string,
): Record<string, string> | undefined {
  if (!isGooglePhotorealisticTilesetUrl(url)) return headers;
  const nonGoogleHeaders = stripGoogleMapsApiKeyHeader(headers);
  const apiKey = googleMapsApiKeyHeaderValue(headers) ?? googleMapsApiKey ?? getGoogleMapsApiKey();
  if (!apiKey) return nonEmptyRecord(nonGoogleHeaders);
  return {
    ...(nonGoogleHeaders ?? {}),
    [GOOGLE_MAPS_API_KEY_HEADER]: apiKey,
  };
}

/**
 * The request headers to persist on a 3D Tiles layer record. Non-Google
 * tilesets keep their headers; Google Photorealistic tiles keep any non-key
 * custom headers but never persist the `X-GOOG-API-KEY` value, so shared
 * projects do not carry the key in plain text (it is re-injected at render
 * time by `resolveThreeDTilesRequestHeaders`).
 */
export function persistedThreeDTilesRequestHeaders(
  url: string,
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!isGooglePhotorealisticTilesetUrl(url)) return headers;
  return nonEmptyRecord(stripGoogleMapsApiKeyHeader(headers));
}
