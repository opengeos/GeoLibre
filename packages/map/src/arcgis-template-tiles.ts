import type { ArcgisRasterLayer, ArcgisSdk } from "./arcgis-sdk";

/**
 * A MapLibre raster tile source the SDK's `WebTileLayer` cannot express: a
 * `{bbox-epsg-3857}` request (an ArcGIS `/export`, a WMS without layers), a TMS
 * scheme, 512 px tiles, a zoom range to overzoom past, or several templates to
 * rotate through.
 */
export interface ArcgisTileTemplateSource {
  /** The store's templates, in MapLibre placeholder form. */
  templates: string[];
  scheme: "xyz" | "tms";
  /** Source tile size in pixels; MapLibre draws a 512 px tile one zoom level earlier. */
  tileSize: number;
  /** Source zoom range; below `minzoom` nothing draws, past `maxzoom` tiles are overzoomed. */
  minzoom: number;
  maxzoom: number;
  bounds?: [number, number, number, number];
}

/** Half the Web Mercator world width, in metres. */
const MERCATOR_EXTENT = 20037508.342789244;

/** Placeholders MapLibre substitutes (plus the common `{-y}` TMS row), which this layer honours. */
const TEMPLATE_PLACEHOLDER = /\{(?:z|x|y|-y|quadkey|ratio|bbox-epsg-3857)\}/;

/** Whether a template has a placeholder this layer knows but `WebTileLayer` does not. */
export function needsTemplateTileLayer(template: string): boolean {
  return /\{(?:-y|quadkey|ratio|bbox-epsg-3857)\}/.test(template);
}

/** Whether a template names any tile the layer can fill in. */
export function isTileTemplate(template: string): boolean {
  return TEMPLATE_PLACEHOLDER.test(template);
}

/** The Bing-style quadkey of an XYZ tile. */
function quadkey(z: number, x: number, y: number): string {
  let key = "";
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    key += String((x & mask ? 1 : 0) + (y & mask ? 2 : 0));
  }
  return key;
}

/**
 * The URL of source tile `z/x/y` (XYZ row order), substituted the way MapLibre
 * does: `{y}` follows the scheme, `{bbox-epsg-3857}` is the tile's Web Mercator
 * extent, and several templates rotate by tile so requests spread across hosts.
 */
export function tileTemplateUrl(
  source: Pick<ArcgisTileTemplateSource, "templates" | "scheme">,
  z: number,
  x: number,
  y: number,
): string {
  const template = source.templates[(x + y) % source.templates.length];
  const flipped = 2 ** z - 1 - y;
  const size = (2 * MERCATOR_EXTENT) / 2 ** z;
  const bbox = [
    -MERCATOR_EXTENT + x * size,
    MERCATOR_EXTENT - (y + 1) * size,
    -MERCATOR_EXTENT + (x + 1) * size,
    MERCATOR_EXTENT - y * size,
  ].join(",");
  return template
    .replaceAll("{z}", String(z))
    .replaceAll("{x}", String(x))
    .replaceAll("{-y}", String(flipped))
    .replaceAll("{y}", String(source.scheme === "tms" ? flipped : y))
    .replaceAll("{quadkey}", quadkey(z, x, y))
    .replaceAll("{ratio}", "")
    .replaceAll("{bbox-epsg-3857}", bbox);
}

/**
 * The source tile that fills the SDK's 256 px tile `level/row/col`, and the
 * power-of-two factor by which it is cropped: a 512 px source tile covers a
 * 256 px tile one level deeper, and past `maxzoom` the deepest tile is
 * enlarged. Null below `minzoom`, where MapLibre draws nothing.
 */
export function sourceTileFor(
  source: Pick<ArcgisTileTemplateSource, "tileSize" | "minzoom" | "maxzoom">,
  level: number,
  row: number,
  col: number,
): { z: number; x: number; y: number; factor: number } | null {
  const shift = Math.max(0, Math.round(Math.log2(source.tileSize / 256)));
  // MapLibre never requests below zoom 0: a 512 px world tile fills level 0.
  const wanted = Math.max(0, level - shift);
  if (wanted < source.minzoom) return null;
  const z = Math.min(wanted, source.maxzoom);
  const factor = 2 ** (level - z);
  return { z, x: Math.floor(col / factor), y: Math.floor(row / factor), factor };
}

/**
 * A native tile layer that requests tiles from MapLibre templates, cropping
 * and enlarging source tiles where their size or zoom range differs from the
 * SDK's 256 px Web Mercator grid.
 */
export function createArcgisTemplateTileLayer(
  sdk: ArcgisSdk,
  source: ArcgisTileTemplateSource,
  properties: Record<string, unknown>,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
    fetch(url, init),
): ArcgisRasterLayer {
  const TemplateTiles = sdk.layers.BaseTileLayer.createSubclass({
    load(this: ArcgisRasterLayer) {
      if (source.bounds)
        this.fullExtent = sdk.webMercatorUtils.geographicToWebMercator(
          new sdk.Extent({
            xmin: source.bounds[0],
            ymin: source.bounds[1],
            xmax: source.bounds[2],
            ymax: source.bounds[3],
            spatialReference: { wkid: 4326 },
          }),
        );
    },
    async fetchTile(level: number, row: number, col: number, options?: { signal?: AbortSignal }) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const tile = sourceTileFor(source, level, row, col);
      if (!tile) return canvas;
      const response = await fetchImpl(tileTemplateUrl(source, tile.z, tile.x, tile.y), {
        signal: options?.signal,
      });
      // A tile outside the service's coverage is a gap in the layer, as it is
      // on MapLibre, not a failure of the whole layer.
      if (response.status === 404 || response.status === 204) return canvas;
      if (!response.ok) throw new Error(`Tile request failed (${response.status})`);
      const bitmap = await createImageBitmap(await response.blob());
      try {
        options?.signal?.throwIfAborted();
        const { factor } = tile;
        canvas
          .getContext("2d")!
          .drawImage(
            bitmap,
            ((col % factor) * bitmap.width) / factor,
            ((row % factor) * bitmap.height) / factor,
            bitmap.width / factor,
            bitmap.height / factor,
            0,
            0,
            256,
            256,
          );
      } finally {
        bitmap.close();
      }
      return canvas;
    },
  });
  return new TemplateTiles(properties);
}
