import {
  addProtocol,
  type Map as MapLibreMap,
  type RasterTileSource,
  type RequestParameters,
} from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

/**
 * Realtime clouds plugin — a "clouds like Google Earth" overlay.
 *
 * Google Earth's clouds layer is a global, hourly infrared satellite composite
 * that is processed so clear sky is transparent and cloudy areas are shaded by
 * brightness (a proxy for cloud-top temperature/height). This plugin reproduces
 * that look from public, no-key, CORS-enabled sources:
 *
 * - **Realtime (infrared):** SSEC RealEarth's "Global Infrared" composite
 *   (`globalir`), a merged geostationary+polar IR mosaic refreshed roughly
 *   hourly. RealEarth serves it as an *opaque grayscale* PNG (dark = clear,
 *   bright = cold/high cloud), so a custom MapLibre protocol re-keys each tile
 *   in-browser: brightness → alpha, colour → white. The result is a transparent
 *   white cloud overlay, exactly the Google Earth style.
 * - **Satellite (true colour):** NASA GIBS VIIRS Corrected Reflectance, a
 *   near-realtime daily photographic mosaic. Opaque, so it reads as a satellite
 *   image of clouds + land rather than a cloud-only overlay, but rock-solid and
 *   a good high-fidelity alternative.
 *
 * The overlay is a native MapLibre raster source/layer added straight to the
 * map (not a store layer), so realtime tiles are never persisted with a stale
 * timestamp and the Layers panel stays uncluttered. Only the small appearance
 * settings (source + opacity) round-trip through the project file.
 */

export const CLOUDS_PLUGIN_ID = "maplibre-gl-clouds";

/** Which imagery backs the clouds overlay. */
export type CloudsSource = "realtime" | "satellite";

export interface CloudsSettings {
  /**
   * `"realtime"` = RealEarth Global Infrared, re-keyed to a transparent white
   * cloud overlay (the Google Earth look). `"satellite"` = NASA GIBS VIIRS true
   * colour, an opaque photographic mosaic.
   */
  source: CloudsSource;
  /** Overlay opacity in [{@link CLOUDS_OPACITY_MIN}, {@link CLOUDS_OPACITY_MAX}]. */
  opacity: number;
}

export const CLOUDS_OPACITY_MIN = 0.1;
export const CLOUDS_OPACITY_MAX = 1;

export const DEFAULT_CLOUDS_SETTINGS: CloudsSettings = {
  source: "realtime",
  opacity: 0.8,
};

// ---------------------------------------------------------------------------
// Tile sources
// ---------------------------------------------------------------------------

/** Custom MapLibre protocol that alpha-keys the grayscale IR tiles. */
const CLOUDS_PROTOCOL = "geolibre-clouds";
const SOURCE_ID = "geolibre-clouds-source";
const LAYER_ID = "geolibre-clouds-layer";

/** RealEarth "Global Infrared" latest-frame tiles (opaque grayscale PNG). */
const REALEARTH_IR_TILE = "https://realearth.ssec.wisc.edu/tiles/globalir";
const REALEARTH_ATTRIBUTION =
  'Infrared clouds &copy; <a href="https://realearth.ssec.wisc.edu/" target="_blank" rel="noopener">SSEC RealEarth, UW&ndash;Madison</a>';
/** Native IR resolution is coarse (~4&nbsp;km); overzoom above this level. */
const REALEARTH_MAXZOOM = 6;

/**
 * NASA GIBS VIIRS Corrected Reflectance true colour (note the {z}/{y}/{x} axis
 * order). `%DATE%` is filled with a UTC date at request time — see
 * {@link nasaTileUrl}.
 */
const NASA_VIIRS_TEMPLATE =
  "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/%DATE%/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg";
const NASA_ATTRIBUTION =
  'Imagery &copy; <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA EOSDIS GIBS</a>';
const NASA_MAXZOOM = 8;

/**
 * Brightness → alpha transfer curve for the infrared re-key. Values below the
 * floor (clear sky / warm surface) map to fully transparent; the gamma steepens
 * the ramp so only distinct cloud tops read as opaque white. Tuned against live
 * RealEarth tiles so mid-latitude ocean drops out cleanly while thin cloud stays
 * faintly visible.
 */
const IR_ALPHA_FLOOR = 105;
const IR_ALPHA_GAMMA = 1.5;

/** Refresh the realtime composite this often (RealEarth updates ~hourly). */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/** 1×1 fully transparent PNG, returned when an IR tile fails to load. */
const TRANSPARENT_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let settings: CloudsSettings = { ...DEFAULT_CLOUDS_SETTINGS };
let map: MapLibreMap | null = null;
let unsubscribeBasemap: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let protocolRegistered = false;
/** Bumped on every refresh so re-keyed IR tiles bypass any cache. */
let refreshVersion = 0;

export function getCloudsSettings(): CloudsSettings {
  return { ...settings };
}

/**
 * Update the overlay appearance and redraw the live map immediately. Unknown
 * keys are ignored; values are clamped/coerced by {@link normalizeCloudsSettings}.
 * Persistence happens when the project is saved (via {@link getProjectState}).
 */
export function setCloudsSettings(patch: Partial<CloudsSettings>): void {
  const next = normalizeCloudsSettings({ ...settings, ...patch });
  const sourceChanged = next.source !== settings.source;
  settings = next;
  if (!map) return;
  if (sourceChanged) {
    // Switching sources swaps the tile URLs (and the IR re-key on/off), so tear
    // the layer down and rebuild it rather than trying to mutate in place.
    rebuildOverlay();
  } else {
    applyOpacity();
  }
}

// ---------------------------------------------------------------------------
// Infrared re-key protocol
// ---------------------------------------------------------------------------

/** Parse `geolibre-clouds://ir/{z}/{x}/{y}` into tile coordinates. */
function parseTileUrl(url: string): { z: string; x: string; y: string } | null {
  // e.g. "geolibre-clouds://ir/3/2/1" — strip the scheme, split the path.
  const withoutScheme = url.replace(`${CLOUDS_PROTOCOL}://`, "");
  const parts = withoutScheme.split("?")[0].split("/");
  // parts: ["ir", z, x, y]
  if (parts.length < 4) return null;
  const [, z, x, y] = parts;
  if (z === undefined || x === undefined || y === undefined) return null;
  return { z, x, y };
}

/** A 2D canvas for the current tile (OffscreenCanvas where available). */
function createCanvas(
  width: number,
  height: number,
): { canvas: OffscreenCanvas | HTMLCanvasElement; offscreen: boolean } {
  if (typeof OffscreenCanvas !== "undefined") {
    return { canvas: new OffscreenCanvas(width, height), offscreen: true };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return { canvas, offscreen: false };
}

async function canvasToPngBytes(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  offscreen: boolean,
): Promise<ArrayBuffer> {
  const blob = offscreen
    ? await (canvas as OffscreenCanvas).convertToBlob({ type: "image/png" })
    : await new Promise<Blob>((resolve, reject) => {
        (canvas as HTMLCanvasElement).toBlob(
          (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
          "image/png",
        );
      });
  return blob.arrayBuffer();
}

/**
 * Fetch one grayscale IR tile and re-key it to a transparent white cloud tile:
 * brightness drives alpha (via {@link IR_ALPHA_FLOOR}/{@link IR_ALPHA_GAMMA})
 * and the colour is forced to white. Failures resolve to a blank tile so a
 * single 404/500 never surfaces as a map error.
 */
async function loadInfraredTile(
  params: RequestParameters,
  abortController: AbortController,
): Promise<{ data: ArrayBuffer }> {
  const coords = parseTileUrl(params.url);
  if (!coords) return { data: TRANSPARENT_PNG.buffer };
  const upstream = `${REALEARTH_IR_TILE}/${coords.z}/${coords.x}/${coords.y}.png?v=${refreshVersion}`;
  try {
    const response = await fetch(upstream, { signal: abortController.signal });
    if (!response.ok) return { data: TRANSPARENT_PNG.buffer };
    const bitmap = await createImageBitmap(await response.blob());
    const { canvas, offscreen } = createCanvas(bitmap.width, bitmap.height);
    // OffscreenCanvas and HTMLCanvasElement expose incompatible getContext
    // overloads, so acquire the 2D context through one concrete type; both
    // return an equivalent context object at runtime.
    const ctx = (canvas as HTMLCanvasElement).getContext("2d");
    if (!ctx) {
      bitmap.close();
      return { data: TRANSPARENT_PNG.buffer };
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = image.data;
    const range = 255 - IR_ALPHA_FLOOR;
    for (let i = 0; i < data.length; i += 4) {
      // Source is grayscale, so the red channel is the brightness.
      const brightness = data[i];
      let t = (brightness - IR_ALPHA_FLOOR) / range;
      if (t <= 0) {
        data[i + 3] = 0;
        continue;
      }
      if (t > 1) t = 1;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(t ** IR_ALPHA_GAMMA * 255);
    }
    ctx.putImageData(image, 0, 0);
    return { data: await canvasToPngBytes(canvas, offscreen) };
  } catch (error) {
    // An aborted request (tile scrolled out of view) rejects with AbortError;
    // MapLibre expects a rejection so it can drop the pending tile. Re-throw
    // aborts and only swallow real failures into a blank tile.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { data: TRANSPARENT_PNG.buffer };
  }
}

function ensureProtocol(): void {
  if (protocolRegistered) return;
  addProtocol(CLOUDS_PROTOCOL, loadInfraredTile);
  protocolRegistered = true;
}

// ---------------------------------------------------------------------------
// Native MapLibre overlay management
// ---------------------------------------------------------------------------

interface SourceConfig {
  tiles: string[];
  attribution: string;
  maxzoom: number;
}

/**
 * NASA VIIRS true colour is a daily mosaic; the current UTC day is still being
 * imaged (un-imaged tiles 404 and imaged-at-night tiles are dark), so request
 * the previous full UTC day for complete, bright global coverage.
 */
function nasaTileUrl(): string {
  const now = new Date();
  const yesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  );
  return NASA_VIIRS_TEMPLATE.replace("%DATE%", yesterday.toISOString().slice(0, 10));
}

function sourceConfig(): SourceConfig {
  if (settings.source === "satellite") {
    return {
      tiles: [nasaTileUrl()],
      attribution: NASA_ATTRIBUTION,
      maxzoom: NASA_MAXZOOM,
    };
  }
  return {
    tiles: [`${CLOUDS_PROTOCOL}://ir/{z}/{x}/{y}?v=${refreshVersion}`],
    attribution: REALEARTH_ATTRIBUTION,
    maxzoom: REALEARTH_MAXZOOM,
  };
}

/**
 * Insert clouds just beneath the basemap's first symbol (label) layer so place
 * names stay legible on top of the overlay. Falls back to the top of the stack
 * when the style has no symbol layers.
 */
function firstSymbolLayerId(activeMap: MapLibreMap): string | undefined {
  try {
    for (const layer of activeMap.getStyle()?.layers ?? []) {
      if (layer.type === "symbol") return layer.id;
    }
  } catch {
    // getStyle can throw before the style is ready; add on top instead.
  }
  return undefined;
}

function addOverlay(activeMap: MapLibreMap): void {
  if (settings.source === "realtime") ensureProtocol();
  const config = sourceConfig();
  if (!activeMap.getSource(SOURCE_ID)) {
    activeMap.addSource(SOURCE_ID, {
      type: "raster",
      tiles: config.tiles,
      tileSize: 256,
      maxzoom: config.maxzoom,
      attribution: config.attribution,
    });
  }
  if (!activeMap.getLayer(LAYER_ID)) {
    activeMap.addLayer(
      {
        id: LAYER_ID,
        type: "raster",
        source: SOURCE_ID,
        paint: { "raster-opacity": settings.opacity },
      },
      firstSymbolLayerId(activeMap),
    );
  }
}

function removeOverlay(activeMap: MapLibreMap): void {
  if (activeMap.getLayer(LAYER_ID)) activeMap.removeLayer(LAYER_ID);
  if (activeMap.getSource(SOURCE_ID)) activeMap.removeSource(SOURCE_ID);
}

function applyOpacity(): void {
  if (map?.getLayer(LAYER_ID)) {
    map.setPaintProperty(LAYER_ID, "raster-opacity", settings.opacity);
  }
}

/** Tear the overlay down and re-add it (used on a source switch). */
function rebuildOverlay(): void {
  if (!map) return;
  const activeMap = map;
  removeOverlay(activeMap);
  whenStyleReady(activeMap, () => addOverlay(activeMap));
}

/**
 * Re-request the realtime composite so a long-running session keeps up with the
 * ~hourly refresh. Bumps the cache-busting version and swaps the source's tile
 * URLs; a no-op for the (single, dated) satellite mosaic.
 */
function refreshRealtime(): void {
  if (!map || settings.source !== "realtime") return;
  refreshVersion += 1;
  const source = map.getSource(SOURCE_ID) as RasterTileSource | undefined;
  source?.setTiles(sourceConfig().tiles);
}

/** Run `fn` once the style is ready (immediately, or on the next `idle`). */
function whenStyleReady(activeMap: MapLibreMap, fn: () => void): void {
  if (activeMap.isStyleLoaded()) {
    fn();
    return;
  }
  activeMap.once("idle", fn);
}

// ---------------------------------------------------------------------------
// Settings normalization (project state is opaque JSON)
// ---------------------------------------------------------------------------

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeCloudsSettings(value: unknown): CloudsSettings {
  const v = (value ?? {}) as Partial<CloudsSettings>;
  const d = DEFAULT_CLOUDS_SETTINGS;
  return {
    source: v.source === "satellite" ? "satellite" : "realtime",
    opacity: clampNumber(v.opacity, CLOUDS_OPACITY_MIN, CLOUDS_OPACITY_MAX, d.opacity),
  };
}

function settingsEqual(a: CloudsSettings, b: CloudsSettings): boolean {
  return a.source === b.source && a.opacity === b.opacity;
}

function isDefaultSettings(value: CloudsSettings): boolean {
  return settingsEqual(value, DEFAULT_CLOUDS_SETTINGS);
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export const maplibreCloudsPlugin: GeoLibrePlugin = {
  id: CLOUDS_PLUGIN_ID,
  name: "Clouds",
  version: "0.1.0",
  activate: (app: GeoLibreAppAPI) => {
    const activeMap = app.getMap?.();
    if (!activeMap) return false;
    map = activeMap;

    whenStyleReady(activeMap, () => addOverlay(activeMap));

    // setStyle (basemap change) drops our source/layer, so rebuild afterward.
    unsubscribeBasemap = app.onBasemapChange(() => {
      if (!map) return;
      map.once("idle", () => {
        if (map) addOverlay(map);
      });
    });

    // Keep the realtime composite current across a long session.
    refreshTimer = setInterval(refreshRealtime, REFRESH_INTERVAL_MS);
  },
  deactivate: (_app: GeoLibreAppAPI) => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    unsubscribeBasemap?.();
    unsubscribeBasemap = null;
    if (map) removeOverlay(map);
    map = null;
  },
  getProjectState: () => (isDefaultSettings(settings) ? undefined : { ...settings }),
  applyProjectState: (_app: GeoLibreAppAPI, state: unknown) => {
    const next = normalizeCloudsSettings(state);
    if (settingsEqual(settings, next)) return false;
    settings = next;
    if (map) rebuildOverlay();
    return true;
  },
};
