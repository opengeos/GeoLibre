import type { ArcgisSdk } from "./arcgis-sdk";
import { generatedImageFactory, generatedImageToCanvas } from "./generated-images";

/**
 * Sprites and glyphs for the ArcGIS `VectorTileLayer`. The store's vector tile
 * layers carry no style resources: their markers, line decorations and fill
 * patterns are images GeoLibre draws on demand (`generated-images.ts`), which
 * MapLibre asks for one at a time through `styleimagemissing`. The SDK instead
 * reads a sprite sheet, so this module bakes the images a style references
 * into one and serves it to the SDK through a request interceptor. Labels use
 * the glyphs of Esri's public basemap font service.
 */

/** Esri's public glyph endpoint, the one its vector basemaps use. */
export const ARCGIS_GLYPHS_URL =
  "https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/resources/fonts/{fontstack}/{range}.pbf";

/** A font stack the glyph endpoint serves. */
export const ARCGIS_TEXT_FONT = ["Arial Regular"];

/** Layout and paint properties whose value names a sprite image. */
const IMAGE_PROPERTIES = ["icon-image", "fill-pattern", "line-pattern", "fill-extrusion-pattern"];

type StyleLayer = {
  type?: string;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
};

/**
 * The generated image ids a style's layers reference, including the ones an
 * expression chooses between (a categorized marker's `match`).
 *
 * @param layers - Style layers.
 * @returns The distinct ids with a registered factory.
 */
export function generatedSpriteIds(layers: readonly unknown[]): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      if (generatedImageFactory(value)) ids.add(value);
    } else if (Array.isArray(value)) value.forEach(visit);
  };
  for (const layer of layers as StyleLayer[])
    for (const property of IMAGE_PROPERTIES) {
      visit(layer.layout?.[property]);
      visit(layer.paint?.[property]);
    }
  return [...ids];
}

/** Whether a style has a symbol layer, which the SDK only accepts with glyphs. */
export function hasSymbolLayers(layers: readonly unknown[]): boolean {
  return (layers as StyleLayer[]).some((layer) => layer.type === "symbol");
}

type SpriteEntry = { x: number; y: number; width: number; height: number; pixelRatio: number };

/**
 * Draw the images onto one sheet at `ratio` device pixels per CSS pixel (the
 * SDK asks for `@2x` on a high-density screen), shelf-packed in rows.
 */
async function bakeSheet(
  ids: string[],
  ratio: number,
): Promise<{ index: Record<string, SpriteEntry>; image: HTMLImageElement }> {
  const drawn: { id: string; canvas: HTMLCanvasElement; width: number; height: number }[] = [];
  for (const id of ids) {
    const factory = generatedImageFactory(id);
    if (!factory) continue;
    let bitmap: Awaited<ReturnType<typeof generatedImageToCanvas>> = null;
    try {
      bitmap = await generatedImageToCanvas(factory());
    } catch {
      // A broken custom SVG leaves the icon out, as MapLibre's placeholder does.
    }
    if (!bitmap) continue;
    const scale = ratio / bitmap.pixelRatio;
    drawn.push({
      id,
      canvas: bitmap.canvas,
      width: Math.max(1, Math.round(bitmap.canvas.width * scale)),
      height: Math.max(1, Math.round(bitmap.canvas.height * scale)),
    });
  }
  const index: Record<string, SpriteEntry> = {};
  // A sheet with nothing on it is still an image: the interceptor must never
  // answer null, which tells the SDK to fetch the synthetic URL itself.
  if (!drawn.length) return { index, image: await sheetImage(emptyCanvas()) };
  const maxRow = 1024;
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let sheetWidth = 0;
  for (const entry of drawn) {
    if (x > 0 && x + entry.width > maxRow) {
      x = 0;
      y += rowHeight + 1;
      rowHeight = 0;
    }
    index[entry.id] = { x, y, width: entry.width, height: entry.height, pixelRatio: ratio };
    x += entry.width + 1;
    rowHeight = Math.max(rowHeight, entry.height);
    sheetWidth = Math.max(sheetWidth, x);
  }
  const sheet = document.createElement("canvas");
  sheet.width = sheetWidth;
  sheet.height = y + rowHeight;
  const context = sheet.getContext("2d");
  if (!context) return { index: {}, image: await sheetImage(emptyCanvas()) };
  for (const entry of drawn) {
    const at = index[entry.id];
    context.drawImage(entry.canvas, at.x, at.y, at.width, at.height);
  }
  return { index, image: await sheetImage(sheet) };
}

function emptyCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  return canvas;
}

/** The SDK's sprite loader expects an image element as the response data. */
async function sheetImage(canvas: HTMLCanvasElement): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = canvas.toDataURL("image/png");
  await image.decode();
  return image;
}

/**
 * Give a vector tile style the sprite and glyphs its symbol and pattern
 * layers need. A style that references no generated image and has no symbol
 * layer is returned as it is.
 *
 * @param sdk - The loaded SDK, whose request interceptors serve the sheet.
 * @param style - A Mapbox style document for a `VectorTileLayer`.
 * @returns The style to hand the SDK, and a disposer that removes the
 *   interceptor with the layer.
 */
export function attachArcgisSprite<T extends Record<string, unknown>>(
  sdk: ArcgisSdk,
  style: T,
): { style: T & { sprite?: string; glyphs?: string }; dispose(): void } {
  const layers = Array.isArray(style.layers) ? (style.layers as unknown[]) : [];
  const ids = generatedSpriteIds(layers);
  const symbols = hasSymbolLayers(layers);
  if (!ids.length || typeof document === "undefined")
    return { style: symbols ? { ...style, glyphs: ARCGIS_GLYPHS_URL } : style, dispose() {} };
  const prefix = `${globalThis.location?.origin ?? "https://geolibre.invalid"}/__arcgis_sprite/${crypto.randomUUID()}/sprite`;
  const sheets = new Map<number, ReturnType<typeof bakeSheet>>();
  const sheet = (ratio: number) => {
    let baked = sheets.get(ratio);
    if (!baked) {
      baked = bakeSheet(ids, ratio);
      sheets.set(ratio, baked);
    }
    return baked;
  };
  const interceptor = {
    urls: prefix,
    before: async ({ url }: { url: string }) => {
      const match = /^(@2x)?\.(json|png)(?:\?|$)/.exec(url.slice(prefix.length));
      if (!match) throw new Error("Invalid sprite request");
      const baked = await sheet(match[1] ? 2 : 1);
      return match[2] === "json" ? baked.index : baked.image;
    },
  };
  sdk.config.request.interceptors.push(interceptor);
  return {
    style: {
      ...style,
      sprite: prefix,
      ...(symbols ? { glyphs: ARCGIS_GLYPHS_URL } : {}),
    },
    dispose() {
      const at = sdk.config.request.interceptors.indexOf(interceptor);
      if (at >= 0) sdk.config.request.interceptors.splice(at, 1);
    },
  };
}
