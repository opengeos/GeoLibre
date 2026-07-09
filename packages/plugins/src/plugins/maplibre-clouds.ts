import { useAppStore } from "@geolibre/core";
import type { Map as MapLibreMap, RasterTileSource } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

/**
 * Realtime clouds plugin — a "clouds like Google Earth" overlay.
 *
 * Backed by **NASA GIBS VIIRS Corrected Reflectance (true colour)**, a
 * near-realtime daily photographic satellite mosaic (no key, CORS-enabled). The
 * overlay is added as a normal raster tile layer through the store's
 * {@link AppState.addTileLayer}, so it appears in the Layers panel, carries its
 * own visibility/opacity, and round-trips with the project like any other tile
 * layer.
 *
 * A built-in **time-scrub animation** steps the layer through the last several
 * complete UTC days. VIIRS is a once-daily mosaic, so scrubbing plays cloud
 * evolution day by day. Because {@link syncRasterTileLayer} only creates a
 * raster source once and never re-reads `tiles`, the animation drives the live
 * source's `setTiles` directly for instant frame swaps, and mirrors the current
 * date back into the store layer so persistence and any source rebuild (e.g. a
 * basemap change) stay in step.
 */

export const CLOUDS_PLUGIN_ID = "maplibre-gl-clouds";

/** Layer name shown in the Layers panel. */
const CLOUDS_LAYER_NAME = "Clouds";
/** Marks the store layer as the one this plugin owns (for adopt-on-restore). */
const CLOUDS_LAYER_FLAG = "cloudsLayer";
/** Initial overlay opacity; the user adjusts it from the Layers panel. */
const DEFAULT_OPACITY = 0.85;

/**
 * NASA GIBS VIIRS Corrected Reflectance true colour (note the {z}/{y}/{x} axis
 * order). `%DATE%` is filled with a UTC date at request time.
 */
const NASA_VIIRS_TEMPLATE =
  "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/%DATE%/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg";
const NASA_ATTRIBUTION =
  'Imagery &copy; <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA EOSDIS GIBS</a>';
/** Plain-text attribution for the metadata panel (the source one is HTML). */
const NASA_ATTRIBUTION_TEXT = "NASA EOSDIS GIBS";
const NASA_MAXZOOM = 8;
const NASA_SERVICE_URL = "https://gibs.earthdata.nasa.gov/";

/**
 * Descriptive metadata shown in the Layers panel's "Layer metadata and source
 * information" view. `date` reflects the frame currently displayed; the rest is
 * static provider/product info so the layer is self-describing.
 */
function cloudsMetadata(date: string): Record<string, unknown> {
  return {
    [CLOUDS_LAYER_FLAG]: true,
    title: "Realtime Clouds",
    description:
      "Near-real-time global satellite imagery of cloud cover. Play a day-by-day animation from the Controls → Clouds menu.",
    provider: "NASA GIBS (Global Imagery Browse Services)",
    product: "VIIRS (Suomi NPP) Corrected Reflectance — True Color",
    date,
    updateFrequency: "Daily (previous full UTC day)",
    tileMatrixSet: "GoogleMapsCompatible · EPSG:3857",
    maxZoom: NASA_MAXZOOM,
    attribution: NASA_ATTRIBUTION_TEXT,
    license: "NASA EOSDIS open data (no restrictions)",
    documentation: "https://nasa-gibs.github.io/gibs-api-docs/",
  };
}

/** How many complete UTC days the scrubber covers. */
const HISTORY_DAYS = 10;
/** Animation frame interval while playing. */
const FRAME_MS = 900;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let appRef: GeoLibreAppAPI | null = null;
/** Id of the store layer this plugin owns, or null when inactive. */
let layerId: string | null = null;
/** Scrub dates as `YYYY-MM-DD`, oldest → newest (newest = previous full day). */
let dates: string[] = [];
/** Current frame within {@link dates}. */
let frameIndex = 0;
let playing = false;
let frameTimer: ReturnType<typeof setInterval> | null = null;
/** Listeners notified on any frame/play/active change (drives the submenu). */
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

// ---------------------------------------------------------------------------
// Dates + tile URLs
// ---------------------------------------------------------------------------

function utcDaysAgo(days: number): string {
  const now = new Date();
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days),
  );
  return d.toISOString().slice(0, 10);
}

/**
 * The last {@link HISTORY_DAYS} complete UTC days, oldest first. The current UTC
 * day is skipped because its mosaic is still being imaged (dark/partial), so the
 * newest frame is the previous full day. Exported for unit testing.
 */
export function buildDates(): string[] {
  const out: string[] = [];
  for (let i = HISTORY_DAYS; i >= 1; i -= 1) out.push(utcDaysAgo(i));
  return out;
}

/** Build the GIBS tile URL for a `YYYY-MM-DD` date. Exported for unit testing. */
export function nasaTileUrl(date: string): string {
  return NASA_VIIRS_TEMPLATE.replace("%DATE%", date);
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

/** The live raster source id the map assigns to a store layer (`@geolibre/map`'s `sourceId`). */
function rasterSourceId(id: string): string {
  return `source-${id}`;
}

/** Swap the live source to the current frame's date for an instant update. */
function applyFrameToMap(): void {
  if (layerId === null) return;
  const map = appRef?.getMap?.() as MapLibreMap | null | undefined;
  const source = map?.getSource(rasterSourceId(layerId)) as
    | RasterTileSource
    | undefined;
  source?.setTiles([nasaTileUrl(dates[frameIndex])]);
}

/**
 * Mirror the current frame's date into the store layer's `source.tiles`, so the
 * project persists the shown day and a later source rebuild recreates it at the
 * right date. Clears {@link layerId} if the layer was deleted from the panel.
 */
function syncStoreTiles(): void {
  if (layerId === null) return;
  const store = useAppStore.getState();
  const layer = store.layers.find((l) => l.id === layerId);
  if (!layer) {
    layerId = null;
    return;
  }
  const date = dates[frameIndex];
  const nextTile = nasaTileUrl(date);
  const currentTile = Array.isArray(layer.source.tiles)
    ? layer.source.tiles[0]
    : undefined;
  if (currentTile === nextTile && layer.metadata?.date === date) return;
  store.updateLayer(layerId, {
    source: { ...layer.source, tiles: [nextTile] },
    // Refresh the metadata so the shown date tracks the scrubber and a layer
    // adopted from an older project picks up the richer descriptive fields.
    metadata: cloudsMetadata(date),
  });
}

function stopPlaying(): void {
  if (frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
  if (playing) {
    playing = false;
    // Persist the frame we landed on so a saved project reopens on it.
    syncStoreTiles();
  }
}

function startPlaying(): void {
  if (playing || layerId === null || dates.length <= 1) return;
  playing = true;
  frameTimer = setInterval(() => {
    frameIndex = (frameIndex + 1) % dates.length;
    // Live source swap only per tick; avoid churning the store (and its dirty
    // flag) every frame — the resting date is written on pause.
    applyFrameToMap();
    notify();
  }, FRAME_MS);
}

// ---------------------------------------------------------------------------
// Public API (consumed by the Clouds submenu in ControlsMenu)
// ---------------------------------------------------------------------------

export interface CloudsAnimationState {
  /** Scrub dates as `YYYY-MM-DD`, oldest → newest. */
  dates: string[];
  /** Current frame index into {@link dates}. */
  index: number;
  /** Whether the animation is playing. */
  playing: boolean;
  /** Whether the clouds layer is present (plugin active). */
  active: boolean;
}

export function getCloudsAnimationState(): CloudsAnimationState {
  return { dates: [...dates], index: frameIndex, playing, active: layerId !== null };
}

/** Jump to a scrub frame. A manual scrub pauses playback. */
export function setCloudsFrame(index: number): void {
  if (layerId === null || dates.length === 0) return;
  stopPlaying();
  frameIndex = Math.max(0, Math.min(dates.length - 1, Math.round(index)));
  applyFrameToMap();
  syncStoreTiles();
  notify();
}

/** Toggle the day-by-day animation. */
export function toggleCloudsPlaying(): void {
  if (playing) stopPlaying();
  else startPlaying();
  notify();
}

/** Subscribe to animation-state changes; returns an unsubscribe function. */
export function subscribeClouds(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export const maplibreCloudsPlugin: GeoLibrePlugin = {
  id: CLOUDS_PLUGIN_ID,
  name: "Clouds",
  version: "0.2.0",
  activate: (app: GeoLibreAppAPI) => {
    appRef = app;
    dates = buildDates();
    frameIndex = dates.length - 1; // newest complete day
    playing = false;

    const store = useAppStore.getState();
    // Adopt a layer restored from the project (avoids a duplicate on reload),
    // otherwise add a fresh one. No beforeLayerId — the overlay sits on top.
    const existing = store.layers.find(
      (l) => l.metadata?.[CLOUDS_LAYER_FLAG] === true,
    );
    if (existing) {
      layerId = existing.id;
      syncStoreTiles(); // refresh a stale saved date to the latest day
      applyFrameToMap();
    } else {
      layerId = store.addTileLayer(CLOUDS_LAYER_NAME, {
        type: "xyz",
        tiles: [nasaTileUrl(dates[frameIndex])],
        url: NASA_SERVICE_URL,
        attribution: NASA_ATTRIBUTION,
        maxzoom: NASA_MAXZOOM,
        opacity: DEFAULT_OPACITY,
        metadata: cloudsMetadata(dates[frameIndex]),
      });
    }
    notify();
  },
  deactivate: (_app: GeoLibreAppAPI) => {
    stopPlaying();
    if (layerId !== null) {
      const store = useAppStore.getState();
      if (store.layers.some((l) => l.id === layerId)) store.removeLayer(layerId);
    }
    layerId = null;
    appRef = null;
    dates = [];
    frameIndex = 0;
    notify();
  },
};
