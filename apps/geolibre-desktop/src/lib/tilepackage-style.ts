import type { LayerSpecification, SourceSpecification, StyleSpecification } from "maplibre-gl";

/**
 * Pure helpers for ArcGIS tile packages (VTPK vector, TPKX raster). Nothing here
 * touches MapLibre at runtime or the store, so it runs under plain Node in the
 * tests; `tilepackage.ts` owns the protocol, the file readers and the layers.
 */

/** MapLibre protocol scheme the `maplibre-tilepackage-protocol` handler serves. */
export const TILEPACKAGE_PROTOCOL = "tilepackage";

/** Fonts a style falls back on: the glyph set GeoLibre's default basemap serves. */
export const DEFAULT_TILEPACKAGE_TEXT_FONT = ["Noto Sans Regular"];

/** Web Mercator's half-width in metres, the bound of a valid projected extent. */
const WEB_MERCATOR_LIMIT = 20037508.342789244;
const EARTH_RADIUS_METRES = 6378137;

/** WKIDs that name Web Mercator (3857 and the older Esri codes for it). */
const WEB_MERCATOR_WKIDS = new Set([3857, 102100, 102113, 900913]);

/** Style layer kinds a vector tile source can draw (a `background` needs no source). */
const DRAWABLE_LAYER_TYPES = new Set([
  "fill",
  "line",
  "circle",
  "symbol",
  "fill-extrusion",
  "heatmap",
]);

/** Whether a file name is an ArcGIS tile package (`.vtpk` or `.tpkx`). */
export function isTilePackageFileName(name: string): boolean {
  return /\.(vtpk|tpkx)$/i.test(name.split(/[?#]/)[0] ?? "");
}

/** A layer name from a package file name or URL: the file's stem. */
export function tilePackageBaseName(nameOrUrl: string): string {
  const file = (nameOrUrl.split(/[?#]/)[0] ?? "").split(/[/\\]/).pop() ?? "";
  return file.replace(/\.(vtpk|tpkx)$/i, "") || "Tile package";
}

/** The `{z}/{x}/{y}` tile template the protocol resolves for a registered package key. */
export function tilePackageTileUrl(key: string): string {
  return `${TILEPACKAGE_PROTOCOL}://${key}/{z}/{x}/{y}`;
}

function randomSessionId(): string {
  return Math.random().toString(36).slice(2, 8) || "session";
}

/**
 * Make the keys a local package is registered under with the protocol.
 *
 * The library keys a `File` by its bare name, so two files called `map.vtpk`
 * would share a tile reader, and a project that outlives the page would resolve
 * a stale key against a new session's unrelated file. A per-session id and a
 * counter keep every opened file's key unique, and the characters are limited to
 * what survives MapLibre's URL handling.
 */
export function createLocalTilePackageKeyGenerator(
  sessionId: string = randomSessionId(),
): (fileName: string) => string {
  let counter = 0;
  return (fileName: string) => {
    counter += 1;
    const safe = fileName.replace(/[^A-Za-z0-9._-]+/g, "_");
    return `${LOCAL_TILEPACKAGE_KEY_PREFIX}${sessionId}-${counter}-${safe}`;
  };
}

/** Prefix of the key a package opened from a local file is registered under. */
const LOCAL_TILEPACKAGE_KEY_PREFIX = "local-";

/** Whether a registered key names a package opened from a local file. */
export function isLocalTilePackageKey(key: string): boolean {
  return key.startsWith(LOCAL_TILEPACKAGE_KEY_PREFIX);
}

/**
 * The local-file package key a `tilepackage://` request names, or null for any
 * other request (a package at a URL names the URL itself, which the protocol
 * can open again on demand).
 */
export function localTilePackageKeyFromUrl(url: string): string | null {
  const match = new RegExp(
    `^${TILEPACKAGE_PROTOCOL}://(${LOCAL_TILEPACKAGE_KEY_PREFIX}[A-Za-z0-9._-]+)(?:/|$)`,
  ).exec(url);
  return match ? (match[1] ?? null) : null;
}

/**
 * Every local-file package key referenced by the given layer sets (the live
 * layers plus any undo/redo snapshots, which can bring a removed layer back).
 */
export function localTilePackageKeysInLayers(
  layerSets: Iterable<readonly { metadata?: Record<string, unknown> }[]>,
): Set<string> {
  const keys = new Set<string>();
  for (const layers of layerSets) {
    for (const layer of layers) {
      const key = layer.metadata?.packageKey;
      if (typeof key === "string" && isLocalTilePackageKey(key)) keys.add(key);
    }
  }
  return keys;
}

function isLonLatBounds(bounds: number[]): boolean {
  const [west, south, east, north] = bounds;
  return (
    bounds.length === 4 &&
    bounds.every(Number.isFinite) &&
    west >= -180 &&
    west <= 180 &&
    east >= -180 &&
    east <= 180 &&
    south >= -90 &&
    south <= 90 &&
    north >= -90 &&
    north <= 90 &&
    west <= east &&
    south <= north
  );
}

function webMercatorToLonLat(x: number, y: number): [number, number] {
  const lon = (x / EARTH_RADIUS_METRES) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / EARTH_RADIUS_METRES)) - Math.PI / 2) * (180 / Math.PI);
  return [lon, lat];
}

/**
 * The package extent as `[west, south, east, north]` degrees, or null when it
 * has none usable.
 *
 * The header's `minLon`/`minLat`/`maxLon`/`maxLat` are the `root.json` extent in
 * whatever coordinate system the package declares, and a package labelled Web
 * Mercator can still hold plain degrees. So the declared spatial reference
 * never overrules the numbers: values that fit longitude/latitude are used as
 * they are. Otherwise values inside the Web Mercator square are converted from
 * metres, unless the package declares some other projection (a UTM zone, a
 * national grid), which cannot be placed without reprojection and so has no
 * bounds rather than a wrong one.
 */
export function tilePackageBounds(header: {
  minLon?: number;
  minLat?: number;
  maxLon?: number;
  maxLat?: number;
  spatialReference?: number;
}): [number, number, number, number] | null {
  const values = [header.minLon, header.minLat, header.maxLon, header.maxLat].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [xmin, ymin, xmax, ymax] = values;
  if (isLonLatBounds(values)) return [xmin, ymin, xmax, ymax];
  const declared = header.spatialReference;
  if (declared != null && !WEB_MERCATOR_WKIDS.has(declared)) return null;
  const inMercator = values.every((value) => Math.abs(value) <= WEB_MERCATOR_LIMIT);
  if (!inMercator) return null;
  // The world's edge converts to 180.00000000000003, which is not a valid
  // longitude; clamp the rounding noise rather than reject a whole-world package.
  const clampLon = (lon: number) => Math.min(180, Math.max(-180, lon));
  const clampLat = (lat: number) => Math.min(90, Math.max(-90, lat));
  const [west, south] = webMercatorToLonLat(xmin, ymin);
  const [east, north] = webMercatorToLonLat(xmax, ymax);
  const converted: [number, number, number, number] = [
    clampLon(west),
    clampLat(south),
    clampLon(east),
    clampLat(north),
  ];
  return isLonLatBounds(converted) ? converted : null;
}

/** A vector style rewritten to live inside a GeoLibre layer. */
export interface PreparedVtpkStyle {
  /** The vector sources, ids scoped to the layer. */
  sources: Record<string, SourceSpecification>;
  /** The drawable style layers, ids scoped to the layer. */
  layers: LayerSpecification[];
  /** Every layer id, as the layer's `nativeLayerIds`. */
  nativeLayerIds: string[];
  /** Every source id, as the layer's `sourceIds`. */
  sourceIds: string[];
  /** Style layers left out because the host map cannot draw them (see below). */
  droppedLayerIds: string[];
}

export interface PrepareVtpkStyleOptions {
  /** The tile template for any vector source the package style left without one. */
  tileUrl: string;
  /** Font stack for text labels (the basemap's glyph server must offer it). */
  textFont?: string[];
}

type LooseLayer = LayerSpecification & {
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
  "source-layer"?: unknown;
  source?: unknown;
};

/**
 * Paint properties that read an image from the package's sprite, each mapped to
 * the flat colour property that can stand in for it.
 */
const SPRITE_PAINT_PROPERTIES: Record<string, string> = {
  "fill-pattern": "fill-color",
  "line-pattern": "line-color",
  "fill-extrusion-pattern": "fill-extrusion-color",
};

/**
 * Rewrite a package's own style (`p12/resources/styles/root.json`) so it can be
 * drawn as one layer among a project's others.
 *
 * Source and layer ids are scoped to the GeoLibre layer id so two packages (or
 * the same one added twice) never collide. Two things a package style assumes
 * are map-wide do not hold inside a project, and are handled here:
 *
 * - A package style owns the whole map, including its `background`, which would
 *   paint over the basemap and everything beneath the layer. Backgrounds and any
 *   other non-vector layer are dropped.
 * - Its glyphs and sprite are style-level and the project's basemap supplies
 *   those. Text labels are kept but moved to a font the basemap serves, and
 *   anything that needs the package's sprite is handled because the basemap's
 *   sprite does not contain those images. Icons are removed (an icon-only
 *   layer is dropped). A fill/line/extrusion pattern is replaced by the layer's
 *   own flat colour when it has one, and the layer is dropped when it has not.
 *
 * @param style - The style returned by `TilePackage.getStyle()`.
 * @param layerId - The id of the GeoLibre layer the style will belong to.
 * @param options - The fallback tile template and the label font.
 * @returns The scoped sources and layers, ready for `arcgisSources`/`arcgisLayers`.
 */
export function prepareVtpkStyle(
  style: StyleSpecification,
  layerId: string,
  options: PrepareVtpkStyleOptions,
): PreparedVtpkStyle {
  const textFont = options.textFont ?? DEFAULT_TILEPACKAGE_TEXT_FONT;

  const sources: Record<string, SourceSpecification> = {};
  const sourceIdByOriginal = new Map<string, string>();
  for (const [originalId, source] of Object.entries(style.sources ?? {})) {
    if (!source || typeof source !== "object") continue;
    const spec = source as Record<string, unknown>;
    if ((spec.type ?? "vector") !== "vector") continue;
    const tiles = Array.isArray(spec.tiles) && spec.tiles.length > 0 ? spec.tiles : null;
    // A source with neither tiles nor a package-local URL points outside the
    // package (a hosted tile service), which this layer does not own.
    const url = typeof spec.url === "string" ? spec.url : null;
    if (!tiles && url && !url.startsWith(`${TILEPACKAGE_PROTOCOL}://`)) continue;
    const scopedId = `${layerId}-${originalId}`;
    const { url: _url, ...rest } = spec;
    sources[scopedId] = {
      ...rest,
      type: "vector",
      tiles: tiles ?? [options.tileUrl],
    } as SourceSpecification;
    sourceIdByOriginal.set(originalId, scopedId);
  }

  const layers: LayerSpecification[] = [];
  const droppedLayerIds: string[] = [];
  for (const original of style.layers ?? []) {
    const spec = original as LooseLayer;
    const scopedSource =
      typeof spec.source === "string" ? sourceIdByOriginal.get(spec.source) : undefined;
    const sourceLayer = spec["source-layer"];
    if (
      !DRAWABLE_LAYER_TYPES.has(spec.type) ||
      !scopedSource ||
      typeof sourceLayer !== "string" ||
      sourceLayer.length === 0
    ) {
      droppedLayerIds.push(spec.id);
      continue;
    }

    const layout: Record<string, unknown> = { ...spec.layout };
    const paint: Record<string, unknown> = { ...spec.paint };

    // A pattern needs the package's sprite, which the basemap does not have.
    // Strip it; if the layer also sets its own flat colour, that colour stands
    // in for the pattern. Without one the layer would fall back to MapLibre's
    // default paint (a faint black fill, a black line), which is not what the
    // package intended, so the layer is dropped instead.
    let lostPattern = false;
    for (const [pattern, color] of Object.entries(SPRITE_PAINT_PROPERTIES)) {
      if (!(pattern in paint)) continue;
      if (paint[color] === undefined) lostPattern = true;
      delete paint[pattern];
    }
    if (lostPattern) {
      droppedLayerIds.push(spec.id);
      continue;
    }

    if (spec.type === "symbol") {
      // An icon-only symbol layer has nothing left to draw once its sprite
      // image is gone, so only labels survive.
      if (!layout["text-field"]) {
        droppedLayerIds.push(spec.id);
        continue;
      }
      for (const key of Object.keys(layout)) if (key.startsWith("icon-")) delete layout[key];
      for (const key of Object.keys(paint)) if (key.startsWith("icon-")) delete paint[key];
      layout["text-font"] = textFont;
    }

    layers.push({
      ...spec,
      id: `${layerId}-${spec.id}`,
      source: scopedSource,
      layout,
      paint,
    } as LayerSpecification);
  }

  return {
    sources,
    layers,
    nativeLayerIds: layers.map((layer) => layer.id),
    sourceIds: Object.keys(sources),
    droppedLayerIds,
  };
}
