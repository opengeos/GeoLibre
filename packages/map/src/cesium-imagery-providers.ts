import {
  resolveProjectHeaderReferences,
  resolveLayerTileAddress,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  mercatorBbox,
  ProtocolImageryProvider,
  quadkey,
  webMercatorRectangle,
} from "./cesium-protocol-imagery";
import { hasRegisteredProtocol, protocolScheme } from "./protocol-tiles";
import type { ImageryProvider, Resource, TilingScheme } from "@cesium/engine";
import {
  str,
  layerCredit,
  allowsCredentials,
  firstTile,
  arcgisToken,
  imageBounds,
  wmtsCapabilities,
} from "./cesium-layer-records";

type CesiumNs = typeof import("@cesium/engine");

// --- Imagery providers ------------------------------------------------------
// The per-branch provider builders behind CesiumLayerSync.createImagery. Each
// takes the layer and returns the provider (or the promise of one) exactly as
// the branch it was lifted from built it.

/**
 * What `CesiumLayerSync` gets back when it starts building an imagery
 * provider: the provider itself for the synchronous branches, or a pending
 * one (`null` when the layer was removed before a provider existed).
 */
export type ImageryProviderRequest =
  | { isAsync: false; provider: ImageryProvider }
  | { isAsync: true; pending: Promise<ImageryProvider | null> };

/** Turns a provider URL into what the provider's `url` option takes. */
type ImageryResourceFactory = (url: string) => string | Resource;

/** Refuses (throws) when `what` cannot be sent to `url` over plaintext. */
type RequireSecure = (url: string, what: string) => void;

/** A layer's request headers with `${NAME}` resolved, as JSON for comparison. */
export function resolvedRequestHeaders(layer: GeoLibreLayer): string {
  return JSON.stringify(
    resolveProjectHeaderReferences(
      layer.source.requestHeaders as Record<string, string> | undefined,
    ) ?? null,
  );
}

/**
 * The credential guard and the URL → `Resource` wrapper every imagery branch
 * builds its provider `url` with.
 */
export function imageryResourceFactory(
  Cesium: CesiumNs,
  layer: GeoLibreLayer,
): { requireSecure: RequireSecure; makeResource: ImageryResourceFactory } {
  const headers = resolveProjectHeaderReferences(
    layer.source.requestHeaders as Record<string, string> | undefined,
  );
  const hasHeaders = Boolean(headers && Object.keys(headers).length);
  // Credentials (request headers, an ArcGIS token) never go out over
  // plaintext — loopback excepted, so a local dev tile server still works.
  // Residual exposure: Cesium.Resource issues these through XHR/fetch, which
  // give no redirect control, so a service that 3xx-redirects cross-origin
  // still sees non-Authorization headers replayed (the browser strips only
  // Authorization). CORS preflight means the redirect target must opt into
  // the header by name, and the endpoint is user-configured, so this is
  // accepted rather than proxied.
  // Refusing the whole layer beats quietly stripping them: an
  // unauthenticated request would look like a working layer that renders
  // nothing. The outer catch turns this into the same best-effort skip a
  // failing provider already gets.
  const requireSecure = (url: string, what: string) => {
    if (allowsCredentials(url)) return;
    console.warn(
      `[GeoLibre] skipping "${layer.name}" on the globe: ${what} cannot be sent over ${url}`,
    );
    throw new Error("credentials require https");
  };
  // Every provider's `url` option is typed `Resource | string`, so the
  // union is passed through as-is rather than cast.
  const makeResource = (url: string): string | Resource => {
    if (!hasHeaders) return url;
    requireSecure(url, "request headers");
    return new Cesium.Resource({ url, headers });
  };
  return { requireSecure, makeResource };
}

/** An ArcGIS MapServer through its own REST surface (`/export`), not a tile template. */
export function arcgisMapServerImageryProvider(
  Cesium: CesiumNs,
  layer: GeoLibreLayer,
  makeResource: ImageryResourceFactory,
  requireSecure: RequireSecure,
): Promise<ImageryProvider> {
  const url = String(layer.sourcePath);
  const resource = makeResource(url);
  const sublayers = str(layer.metadata?.arcgisSublayers);
  // arcgis-layer.ts writes a bare id list ("0,2,5"); the `show:` prefix only
  // ever appears in the tile URL's query string. Stripping it here is purely
  // defensive, for a hand-authored or MCP project that copies the ArcGIS
  // `layers=show:0,1` param form straight into the metadata field.
  const cleanLayers = sublayers?.replace(/^show:/i, "").trim() || undefined;
  const options: Record<string, unknown> = {};
  if (cleanLayers) options.layers = cleanLayers;
  const token = arcgisToken(layer);
  if (token) {
    requireSecure(url, "an access token");
    options.token = token;
  }

  return Cesium.ArcGisMapServerImageryProvider.fromUrl(resource, options);
}

/** A georeferenced image as one tile stretched over its bounds. */
export function singleImageImageryProvider(
  Cesium: CesiumNs,
  layer: GeoLibreLayer,
  makeResource: ImageryResourceFactory,
): Promise<ImageryProvider> {
  const url = String(layer.source.url);
  const bounds = imageBounds(layer);
  if (!bounds) throw new Error("the image layer has no usable bounds");
  const resource = makeResource(url);
  const rectangle = Cesium.Rectangle.fromDegrees(bounds[0], bounds[1], bounds[2], bounds[3]);
  const options = { rectangle };

  return Cesium.SingleTileImageryProvider.fromUrl(resource, options);
}

/** A WMS endpoint queried directly (no tile template). */
export function wmsImageryProvider(
  Cesium: CesiumNs,
  layer: GeoLibreLayer,
  makeResource: ImageryResourceFactory,
): ImageryProvider {
  const url = String(layer.source.url);
  const resource = makeResource(url);
  return new Cesium.WebMapServiceImageryProvider({
    url: resource,
    layers: String(layer.source.layers ?? ""),
    parameters: {
      transparent: layer.source.transparent !== false,
      format: str(layer.source.format) ?? "image/png",
      styles: str(layer.source.styles) ?? "",
      version: str(layer.source.version) ?? "1.1.1",
    },
    credit: layerCredit(layer),
  });
}

/** A capabilities-driven WMTS layer (see {@link wmtsCapabilities}). */
export function wmtsImageryProvider(
  Cesium: CesiumNs,
  layer: GeoLibreLayer,
  wmtsCaps: NonNullable<ReturnType<typeof wmtsCapabilities>>,
  makeResource: ImageryResourceFactory,
): ImageryProvider {
  const url = wmtsCaps.url;
  const resource = makeResource(url);
  const maxLevel = Number(layer.source.maxzoom);
  const minLevel = Number(layer.source.minzoom);
  // No UI writes `tilingScheme`/`tileMatrixLabels` today; they come from a
  // hand-authored or MCP-generated `.geolibre.json` (`source` is a
  // free-form record), which is how non-default WMTS matrix sets are
  // expressed. Left in so those projects render on the globe.
  const schemeId = str(layer.source.tilingScheme);
  let tilingScheme: TilingScheme | undefined;
  if (schemeId) {
    if (schemeId === "GeographicTilingScheme") tilingScheme = new Cesium.GeographicTilingScheme();
    else if (schemeId === "WebMercatorTilingScheme")
      tilingScheme = new Cesium.WebMercatorTilingScheme();
    else {
      // Warn rather than bail silently: the layer still reads as
      // globe-supported in the layer menu, so a mute skip looks like a
      // broken renderer.
      console.warn(
        `[GeoLibre] skipping "${layer.name}" on the globe: unsupported WMTS tiling scheme "${schemeId}"`,
      );
      throw new Error(`unsupported WMTS tiling scheme "${schemeId}"`);
    }
  }
  const labels = layer.source.tileMatrixLabels;
  const tileMatrixLabels = Array.isArray(labels) ? labels.map(String) : undefined;

  return new Cesium.WebMapTileServiceImageryProvider({
    url: resource,
    layer: wmtsCaps.layer,
    style: str(layer.source.style) ?? str(layer.source.styles) ?? "",
    // Cesium's own WebMapTileServiceImageryProvider default. The WMS
    // branch above defaults to image/png instead because WMS overlays are
    // usually drawn transparent over the globe, while WMTS sets are
    // typically opaque base imagery — the asymmetry is deliberate.
    format: str(layer.source.format) ?? "image/jpeg",
    tileMatrixSetID: wmtsCaps.tileMatrixSetID,
    maximumLevel: Number.isFinite(maxLevel) ? maxLevel : undefined,
    minimumLevel: Number.isFinite(minLevel) ? minLevel : undefined,
    tilingScheme,
    tileMatrixLabels,
    credit: layerCredit(layer),
  });
}

/**
 * The fallback: the layer's first tile template, over HTTP or through a
 * custom protocol MapLibre registered.
 */
export function tileTemplateImageryProvider(
  Cesium: CesiumNs,
  layer: GeoLibreLayer,
  makeResource: ImageryResourceFactory,
): ImageryProvider {
  const rawUrl = firstTile(layer);
  if (!rawUrl) throw new Error("no tile URL template");
  const addressed = resolveLayerTileAddress(layer, [rawUrl]);
  const url = addressed.tiles[0] ?? rawUrl;
  const tileScheme = addressed.scheme;
  const maxLevel = Number(layer.source.maxzoom);
  const minLevel = Number(layer.source.minzoom);
  const scheme = protocolScheme(url);
  const bounds = layer.source.bounds;
  const rectangle =
    Array.isArray(bounds) &&
    bounds.length === 4 &&
    bounds.every((v) => typeof v === "number" && Number.isFinite(v))
      ? webMercatorRectangle(Cesium, bounds as [number, number, number, number])
      : undefined;
  // The tile size drives Cesium's level selection the way it drives
  // MapLibre's, so a 512 px source fetches the same zoom on both.
  const tileSize = Number(layer.source.tileSize);
  const tileWidth = Number.isFinite(tileSize) && tileSize > 0 ? tileSize : undefined;
  if (scheme) {
    // A custom-protocol template (local MBTiles, the desktop's native
    // XYZ/WMS fetcher, a KML super-overlay, the COG DEM): the tiles come
    // from the handler MapLibre registered, not from HTTP. An
    // unregistered scheme is refused rather than rendered blank, so the
    // layer reads as failed instead of as a working layer drawing
    // nothing.
    if (!hasRegisteredProtocol(scheme))
      throw new Error(`no MapLibre protocol handler registered for "${scheme}://"`);
    return new ProtocolImageryProvider(Cesium, {
      template: url,
      scheme: tileScheme,
      tileWidth,
      tileHeight: tileWidth,
      rectangle,
      maximumLevel: Number.isFinite(maxLevel) ? maxLevel : undefined,
      minimumLevel: Number.isFinite(minLevel) ? minLevel : undefined,
      credit: layerCredit(layer),
    });
  }
  let finalUrl = url;
  if (tileScheme === "tms") {
    finalUrl = finalUrl.replace(/\{y\}/g, "{-y}");
  }
  const resource = makeResource(finalUrl);
  return new Cesium.UrlTemplateImageryProvider({
    url: resource,
    tileWidth,
    tileHeight: tileWidth,
    rectangle,
    maximumLevel: Number.isFinite(maxLevel) ? maxLevel : undefined,
    minimumLevel: Number.isFinite(minLevel) ? minLevel : undefined,
    credit: layerCredit(layer),
    customTags: {
      "bbox-epsg-3857": (_p: unknown, x: number, y: number, level: number) =>
        mercatorBbox(level, x, y),
      quadkey: (_p: unknown, x: number, y: number, level: number) => quadkey(level, x, y),
      "-y": (_p: unknown, _x: number, y: number, level: number) => String(2 ** level - 1 - y),
      ratio: () => "",
    },
  });
}
