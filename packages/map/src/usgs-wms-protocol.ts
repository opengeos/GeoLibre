import {
  getPlanetaryBasemapById,
  USGS_ASTRO_WMS_BASE,
  USGS_WMS_PROTOCOL,
  type UsgsWmsLayer,
} from "@geolibre/core";
import { addProtocol, config, type RequestParameters } from "maplibre-gl";
import { remapRowsToMercator, tileGeoBounds, wmsBboxFor, type TileCoords } from "./wms-reproject";

// The `usgs-wms://<basemap id>/{z}/{x}/{y}` MapLibre protocol behind the
// Mercury, Venus, Galilean-moon, Titan, Pluto and Charon basemaps.
//
// The USGS Astrogeology MapServer serves those bodies only in equirectangular
// EPSG:4326, which MapLibre can't draw. For each Web-Mercator tile the handler
// requests the WMS window covering exactly that tile's lon/lat bounds, then
// resamples its rows onto the Mercator latitude grid (see wms-reproject.ts) and
// hands MapLibre a PNG. USGS sends `Access-Control-Allow-Origin: *`, so the
// browser fetches it directly; a Cloudflare Worker proxy can't, because USGS's
// own Cloudflare bot protection answers Worker requests with a 403.
//
// The basemap id in the URL is looked up in the core catalog, so only the
// catalog's `map`/`layer` pairs are ever requested. The Cesium globe reads the
// same tiles through this handler (cesium-basemap.ts).

/** Edge length of a reprojected tile, matching the raster source's `tileSize`. */
export const USGS_WMS_TILE_SIZE = 256;

const TILE_URL = /^usgs-wms:\/\/([a-z0-9-]+)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})(?:[?#].*)?$/;

/** A parsed `usgs-wms://` tile URL. */
export interface UsgsWmsTileRequest extends TileCoords {
  /** The planetary basemap id (a `PLANETARY_BASEMAPS` entry with `wms`). */
  basemapId: string;
  /** The USGS layer that basemap draws. */
  wms: UsgsWmsLayer;
}

/**
 * Parse a `usgs-wms://<basemap id>/<z>/<x>/<y>` tile URL.
 *
 * Args:
 *   url: The tile URL MapLibre requested.
 *
 * Returns:
 *   The tile coordinates and its USGS layer, or `null` when the URL is
 *   malformed, outside the tile pyramid, or names a basemap without a WMS layer.
 */
export function parseUsgsWmsTileUrl(url: string): UsgsWmsTileRequest | null {
  const match = TILE_URL.exec(url);
  if (!match) return null;
  const [, basemapId, zs, xs, ys] = match;
  const z = Number(zs);
  const x = Number(xs);
  const y = Number(ys);
  const dim = 2 ** z;
  if (x >= dim || y >= dim) return null;
  const wms = getPlanetaryBasemapById(basemapId)?.wms;
  if (!wms) return null;
  return { basemapId, wms, z, x, y };
}

/**
 * The USGS WMS 1.1.1 GetMap URL for one Web-Mercator tile: the equirectangular
 * window covering exactly the tile's lon/lat bounds, at the tile's pixel size.
 *
 * Args:
 *   wms: The USGS MapServer map file and layer.
 *   tile: The Web-Mercator tile.
 *   size: Requested image edge in pixels.
 *
 * Returns:
 *   The GetMap URL.
 */
export function usgsWmsGetMapUrl(
  wms: UsgsWmsLayer,
  tile: TileCoords,
  size = USGS_WMS_TILE_SIZE,
): string {
  return (
    `${USGS_ASTRO_WMS_BASE}?map=${encodeURIComponent(wms.map)}` +
    "&SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&STYLES=" +
    `&LAYERS=${encodeURIComponent(wms.layer)}` +
    "&SRS=EPSG:4326&FORMAT=image/png&TRANSPARENT=TRUE" +
    `&WIDTH=${size}&HEIGHT=${size}` +
    `&BBOX=${wmsBboxFor(tileGeoBounds(tile))}`
  );
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** A `size`×`size` 2D canvas, offscreen where supported (WebKitGTK may lack it). */
function makeCanvas(size: number): {
  ctx: Canvas2D;
  toPng: () => Promise<Blob>;
} {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) return { ctx, toPng: () => canvas.convertToBlob({ type: "image/png" }) };
  }
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  return {
    ctx,
    toPng: () =>
      new Promise((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
          "image/png",
        ),
      ),
  };
}

/**
 * Warp an equirectangular WMS image to the Web-Mercator tile and re-encode it.
 *
 * Args:
 *   image: The decoded WMS window (exactly the tile's lon/lat bounds).
 *   tile: The Web-Mercator tile being produced.
 *
 * Returns:
 *   PNG bytes of the reprojected tile.
 */
async function warpToMercatorPng(image: ImageBitmap, tile: TileCoords): Promise<ArrayBuffer> {
  const size = USGS_WMS_TILE_SIZE;
  const { ctx, toPng } = makeCanvas(size);
  // Draw at the tile size so a server that ignores WIDTH/HEIGHT can't drive an
  // out-of-bounds read in the row remap.
  ctx.drawImage(image, 0, 0, size, size);
  const src = ctx.getImageData(0, 0, size, size);
  const warped = remapRowsToMercator(
    new Uint8Array(src.data.buffer, src.data.byteOffset, src.data.byteLength),
    size,
    tile,
    tileGeoBounds(tile),
  );
  const out = ctx.createImageData(size, size);
  out.data.set(warped);
  ctx.putImageData(out, 0, 0);
  return (await toPng()).arrayBuffer();
}

/**
 * The MapLibre handler for `usgs-wms://` tiles.
 *
 * Args:
 *   params: MapLibre's request; `params.url` is the tile URL.
 *   abortController: Aborted by MapLibre when the tile is no longer wanted.
 *
 * Returns:
 *   The reprojected tile as PNG bytes.
 *
 * Raises:
 *   Error: For an unknown tile URL or a non-image WMS response (a
 *   ServiceException is XML), so MapLibre reports a tile error instead of
 *   drawing a silently blank basemap.
 */
export async function usgsWmsProtocolHandler(
  params: RequestParameters,
  abortController: AbortController,
): Promise<{ data: ArrayBuffer }> {
  const tile = parseUsgsWmsTileUrl(params.url);
  if (!tile) throw new Error(`Unknown USGS WMS tile: ${params.url}`);
  const response = await fetch(usgsWmsGetMapUrl(tile.wms, tile), {
    signal: abortController.signal,
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.startsWith("image/")) {
    await response.arrayBuffer().catch(() => undefined);
    throw new Error(
      `USGS WMS ${tile.basemapId} ${tile.z}/${tile.x}/${tile.y}: ${response.status} ${contentType || "?"}`,
    );
  }
  const image = await createImageBitmap(await response.blob());
  try {
    return { data: await warpToMercatorPng(image, tile) };
  } finally {
    image.close();
  }
}

/** Register the `usgs-wms://` protocol with MapLibre once per page. */
export function ensureUsgsWmsProtocol(): void {
  const registered = (config as { REGISTERED_PROTOCOLS?: Record<string, unknown> })
    .REGISTERED_PROTOCOLS?.[USGS_WMS_PROTOCOL];
  if (registered) return;
  addProtocol(USGS_WMS_PROTOCOL, usgsWmsProtocolHandler);
}
