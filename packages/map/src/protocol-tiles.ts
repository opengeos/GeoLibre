import { config } from "maplibre-gl";
import type { AddProtocolAction, RequestParameters } from "maplibre-gl";

// Tile requests through the MapLibre custom-protocol registry.
//
// GeoLibre registers its non-HTTP tile sources (COG tiles from the WASM tiler,
// raster PMTiles, local MBTiles, the desktop's native XYZ/WMS fetcher, KML
// super-overlays) as `maplibregl.addProtocol` handlers. The registry,
// `maplibregl.config.REGISTERED_PROTOCOLS`, is process-wide and independent of
// any map instance, so a renderer that cannot speak those schemes itself (the
// Cesium globe, the ArcGIS SDK) reads tiles through the same handlers here,
// with no MapLibre map mounted.

/**
 * The URL scheme of a tile template that names a custom protocol, or `null`
 * for a plain web (`http`, `https`, `blob`, `data`) or relative URL that
 * Cesium can fetch itself.
 */
export function protocolScheme(url: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  return scheme === "http" || scheme === "https" || scheme === "blob" || scheme === "data"
    ? null
    : scheme;
}

/** The MapLibre protocol registry — process-wide, so no map has to be mounted. */
function registeredProtocols(): Record<string, AddProtocolAction> {
  return (
    (config as { REGISTERED_PROTOCOLS?: Record<string, AddProtocolAction> }).REGISTERED_PROTOCOLS ??
    {}
  );
}

/** Whether a handler for `scheme` is registered with `maplibregl.addProtocol`. */
export function hasRegisteredProtocol(scheme: string): boolean {
  return typeof registeredProtocols()[scheme] === "function";
}

/**
 * Fetch a tile through the MapLibre protocol handler registered for its
 * scheme. Resolves `null` when the handler returns no bytes (the empty
 * `ArrayBuffer` every GeoLibre handler uses for "no tile here").
 */
export async function requestProtocolTile(
  url: string,
  signal: AbortSignal,
): Promise<ArrayBuffer | Uint8Array | null> {
  const scheme = protocolScheme(url);
  const handler = scheme ? registeredProtocols()[scheme] : undefined;
  if (!handler) throw new Error(`no MapLibre protocol handler for "${scheme ?? url}"`);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const params: RequestParameters = { url, type: "image" };
    const response = await handler(params, controller);
    const data = response?.data as ArrayBuffer | Uint8Array | null | undefined;
    if (!data) return null;
    return data.byteLength > 0 ? data : null;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
