import { config } from "maplibre-gl";
import type { AddProtocolAction, RequestParameters } from "maplibre-gl";
import type {
  Credit,
  Event,
  ImageryProvider,
  Rectangle,
  Request,
  TileDiscardPolicy,
  WebMercatorTilingScheme,
} from "@cesium/engine";

// A Cesium `ImageryProvider` fed by MapLibre custom protocols (issue #2283).
//
// COG tiles from the WASM tiler, raster PMTiles, local MBTiles, the desktop's
// native XYZ/WMS fetcher, KML super-overlays, and the COG-backed terrain DEM
// all reach the 2D map as `<scheme>://…/{z}/{x}/{y}` tile templates whose
// scheme is a handler registered with `maplibregl.addProtocol`. Cesium's own
// `UrlTemplateImageryProvider` only speaks HTTP, so on the globe those layers
// either rendered nothing or were reported "2D only". This provider bridges
// them: it expands the template exactly as MapLibre would, hands the URL to the
// registered handler, and decodes the bytes into an `ImageBitmap` for Cesium.
//
// The registry is `maplibregl.config.REGISTERED_PROTOCOLS`, a process-wide
// table independent of any map instance, so the bridge works when the primary
// map is the globe and no MapLibre map is mounted at all. Like the terrain
// provider, the engine is injected (type-only Cesium imports) so this module
// never pulls Cesium into the build graph itself.

type CesiumNs = typeof import("@cesium/engine");

/** A decoded tile Cesium can upload as a texture. */
export type DecodedTile = ImageBitmap | HTMLCanvasElement | HTMLImageElement;

/** Loads one tile's bytes. `null` means "nothing here" (a transparent tile). */
export type TileBytesLoader = (
  url: string,
  signal: AbortSignal,
) => Promise<ArrayBuffer | Uint8Array | null>;

/** Decodes tile bytes into an image; injectable so tests can run without a DOM. */
export type TileDecoder = (bytes: ArrayBuffer | Uint8Array) => Promise<DecodedTile>;

export interface ProtocolImageryOptions {
  /** The `{z}/{x}/{y}` template, e.g. `geolibre-mbtiles://tile/{z}/{x}/{y}?path=…`. */
  template: string;
  /** `tms` flips the Y axis, as MapLibre's `scheme: "tms"` does. */
  scheme?: "xyz" | "tms";
  tileWidth?: number;
  tileHeight?: number;
  minimumLevel?: number;
  maximumLevel?: number;
  /** Geographic extent to request tiles within; the whole world when absent. */
  rectangle?: Rectangle;
  credit?: string;
  /**
   * Fetches a tile's bytes. Defaults to the MapLibre protocol handler
   * registered for the template's scheme (see {@link requestProtocolTile}).
   */
  loadTile?: TileBytesLoader;
  /** Decodes bytes into an image. Defaults to `createImageBitmap`. */
  decodeTile?: TileDecoder;
  /**
   * Produces a tile image directly, bypassing {@link loadTile} and
   * {@link decodeTile}, for sources that render pixels rather than serve
   * encoded bytes (the COG tiler). `null` means a transparent tile.
   */
  loadImage?: (url: string, signal: AbortSignal) => Promise<DecodedTile | null>;
  /** The image drawn for an empty tile. Defaults to a shared 1×1 canvas. */
  emptyTile?: () => DecodedTile;
  /**
   * Cap on tiles in flight. Beyond it `requestImage` returns `undefined`, which
   * is how a Cesium provider tells the imagery layer to ask again later; the
   * MapLibre handlers behind this bridge are not all cheap (the WASM tiler
   * decodes on the main thread), so the default is conservative.
   */
  maxConcurrentRequests?: number;
}

/** Web Mercator's latitude limit, in degrees. */
const MAX_MERCATOR_LATITUDE = 85.05113;

/**
 * A Cesium `Rectangle` from `[west, south, east, north]` degrees, clamped to
 * what a Web Mercator tiling scheme can address. Bounds arrive from archive
 * headers, tiler metadata, and hand-authored projects, any of which can carry
 * a longitude past ±180 or a latitude past the Mercator limit;
 * `Rectangle.fromDegrees` would accept the numbers and the provider would then
 * request tiles that do not exist.
 */
export function webMercatorRectangle(
  Cesium: CesiumNs,
  bounds: readonly [number, number, number, number],
): Rectangle {
  const clampLon = (v: number) => Math.min(180, Math.max(-180, v));
  const clampLat = (v: number) =>
    Math.min(MAX_MERCATOR_LATITUDE, Math.max(-MAX_MERCATOR_LATITUDE, v));
  return Cesium.Rectangle.fromDegrees(
    clampLon(bounds[0]),
    clampLat(bounds[1]),
    clampLon(bounds[2]),
    clampLat(bounds[3]),
  );
}

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

/**
 * Expand a MapLibre tile template for one tile, the way MapLibre does:
 * `{z}`, `{x}`, `{y}` (and `{-y}` for TMS), plus `{quadkey}`, `{bbox-epsg-3857}`,
 * and `{ratio}` (always empty here — the globe requests device-independent
 * tiles).
 */
export function expandTileTemplate(
  template: string,
  z: number,
  x: number,
  y: number,
  scheme: "xyz" | "tms" = "xyz",
): string {
  const n = 2 ** z;
  const yUp = n - 1 - y;
  const tileY = scheme === "tms" ? yUp : y;
  return template
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(tileY))
    .replace(/\{-y\}/g, String(yUp))
    .replace(/\{quadkey\}/g, quadkey(z, x, y))
    .replace(/\{bbox-epsg-3857\}/g, mercatorBbox(z, x, y))
    .replace(/\{ratio\}/g, "");
}

function quadkey(z: number, x: number, y: number): string {
  let key = "";
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    let digit = 0;
    if (x & mask) digit += 1;
    if (y & mask) digit += 2;
    key += digit;
  }
  return key;
}

function mercatorBbox(z: number, x: number, y: number): string {
  const half = 20037508.342789244;
  const size = (2 * half) / 2 ** z;
  const west = -half + x * size;
  const north = half - y * size;
  return `${west},${north - size},${west + size},${north}`;
}

/**
 * The `createImageBitmap` options Cesium itself decodes tiles with
 * (`Resource.fetchImage({ preferImageBitmap: true, flipY: true })`). Cesium
 * uploads an `ImageBitmap` without the WebGL Y flip it applies to other image
 * sources, so a bitmap must arrive already flipped or every tile renders
 * mirrored top-to-bottom; and alpha must stay straight, as the imagery shader
 * premultiplies itself.
 */
export const CESIUM_IMAGE_BITMAP_OPTIONS: ImageBitmapOptions = {
  imageOrientation: "flipY",
  premultiplyAlpha: "none",
};

/** Default decoder: `createImageBitmap` on the raw bytes, oriented for Cesium. */
async function decodeWithImageBitmap(bytes: ArrayBuffer | Uint8Array): Promise<DecodedTile> {
  return createImageBitmap(new Blob([bytes as BlobPart]), CESIUM_IMAGE_BITMAP_OPTIONS);
}

/**
 * A `Cesium.ImageryProvider` over a MapLibre-style tile template whose tiles
 * come from a custom protocol handler (or any injected loader).
 *
 * Structurally it mirrors `UrlTemplateImageryProvider`: a Web-Mercator tiling
 * scheme, per-tile `requestImage`, no feature picking. It differs in the two
 * places Cesium's own provider cannot go: the bytes come from the handler
 * rather than an HTTP fetch, and an empty response is drawn as a transparent
 * tile rather than treated as an error, because that is what the GeoLibre
 * handlers return for "no tile here" (outside an MBTiles archive's bounds, a
 * COG's footprint, a KML super-overlay's region).
 */
export class ProtocolImageryProvider implements ImageryProvider {
  readonly tilingScheme: WebMercatorTilingScheme;
  readonly rectangle: Rectangle;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly minimumLevel: number;
  readonly maximumLevel: number | undefined;
  // Owned but deliberately never raised here. `ImageryLayer._requestImagery`
  // already funnels a rejected `requestImage` through
  // `TileProviderError.reportError(..., imageryProvider.errorEvent, ...)`,
  // so raising it from the provider would report every failed tile twice and
  // sidestep the retry bookkeeping `TileProviderError` keeps across attempts.
  readonly errorEvent: Event;
  // Cesium declares a non-optional Credit; providers without one leave it
  // undefined at runtime (UrlTemplateImageryProvider does the same).
  readonly credit: Credit;
  readonly hasAlphaChannel = true;
  // Typed as Cesium declares them (non-optional) so the class satisfies
  // `ImageryProvider` structurally; both are legitimately absent at runtime,
  // exactly as `UrlTemplateImageryProvider` leaves them.
  readonly tileDiscardPolicy = undefined as unknown as TileDiscardPolicy;
  readonly proxy = undefined as unknown as ImageryProvider["proxy"];
  /** Kept for callers on older Cesium that still poll it; always ready. */
  readonly ready = true;
  /** The template, for diagnostics and the layer-sync rebuild check. */
  readonly template: string;

  private readonly scheme: "xyz" | "tms";
  private readonly loadTile: TileBytesLoader;
  private readonly decodeTile: TileDecoder;
  private readonly loadImage:
    | ((url: string, signal: AbortSignal) => Promise<DecodedTile | null>)
    | null;
  private readonly emptyTile: (() => DecodedTile) | null;
  private readonly maxConcurrent: number;
  private readonly abort = new AbortController();
  private blank: HTMLCanvasElement | null = null;
  private pending = 0;

  constructor(
    private readonly Cesium: CesiumNs,
    options: ProtocolImageryOptions,
  ) {
    this.template = options.template;
    this.scheme = options.scheme ?? "xyz";
    this.tilingScheme = new Cesium.WebMercatorTilingScheme();
    this.rectangle = options.rectangle ?? this.tilingScheme.rectangle;
    this.tileWidth = options.tileWidth ?? 256;
    this.tileHeight = options.tileHeight ?? 256;
    this.minimumLevel = Math.max(0, options.minimumLevel ?? 0);
    this.maximumLevel = options.maximumLevel;
    this.errorEvent = new Cesium.Event();
    this.credit = (options.credit ? new Cesium.Credit(options.credit) : undefined) as Credit;
    this.loadTile = options.loadTile ?? requestProtocolTile;
    this.decodeTile = options.decodeTile ?? decodeWithImageBitmap;
    this.loadImage = options.loadImage ?? null;
    this.emptyTile = options.emptyTile ?? null;
    this.maxConcurrent = options.maxConcurrentRequests ?? 8;
  }

  getTileCredits(_x: number, _y: number, _level: number): Credit[] {
    return [];
  }

  pickFeatures(): undefined {
    return undefined;
  }

  /** The URL a tile resolves to, for diagnostics and tests. */
  tileUrl(x: number, y: number, level: number): string {
    return expandTileTemplate(this.template, level, x, y, this.scheme);
  }

  /**
   * `request` is accepted to satisfy `ImageryProvider` and deliberately
   * ignored. Cesium only ever flags that object through `RequestScheduler`,
   * which is reached from `Resource.fetchImage` (the HTTP path this provider
   * exists to bypass), so for a bridged tile nothing would ever set it. Honouring
   * per-tile cancellation therefore means routing the handler's bytes through
   * the scheduler, not reading a flag here. Until then cancellation is by
   * provider lifetime (the shared `AbortController`, aborted in `destroy`) and
   * back-pressure is `maxConcurrentRequests`: a tile that scrolls off-screen
   * mid-flight still holds its slot until it resolves, so a fast pan can queue
   * briefly behind tiles Cesium no longer wants.
   */
  requestImage(
    x: number,
    y: number,
    level: number,
    _request?: Request,
  ): Promise<DecodedTile> | undefined {
    if (this.abort.signal.aborted) return undefined;
    // Returning undefined asks Cesium to retry on a later frame — the same
    // back-pressure UrlTemplateImageryProvider applies through its request
    // scheduler, which this provider bypasses.
    if (this.pending >= this.maxConcurrent) return undefined;
    this.pending++;
    const url = this.tileUrl(x, y, level);
    const signal = this.abort.signal;
    const image = this.loadImage
      ? this.loadImage(url, signal)
      : this.loadTile(url, signal).then((bytes) => (bytes ? this.decodeTile(bytes) : null));
    return image
      .then((tile) => {
        signal.throwIfAborted();
        return tile ?? this.transparentTile();
      })
      .finally(() => {
        this.pending--;
      });
  }

  /**
   * One shared transparent tile for "nothing here". Cesium uploads whatever
   * size it is given, so 1×1 costs nothing; the same canvas serves every empty
   * tile.
   */
  private transparentTile(): DecodedTile {
    if (this.emptyTile) return this.emptyTile();
    if (!this.blank) {
      this.blank = document.createElement("canvas");
      this.blank.width = 1;
      this.blank.height = 1;
    }
    return this.blank;
  }

  /** Stop every in-flight tile; a destroyed provider never resolves again. */
  destroy(): void {
    this.abort.abort();
  }
}
