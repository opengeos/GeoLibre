import type {
  IControl,
  Map as MapLibreMap,
} from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

/**
 * Weather overlay plugin (RainViewer).
 *
 * Adds an animated precipitation-radar layer over the basemap, similar to
 * Google Earth's weather layer: a semi-transparent, time-animated overlay drawn
 * beneath the basemap's place labels so the map stays readable. Data comes from
 * the free, key-less RainViewer API (https://www.rainviewer.com/api.html),
 * which publishes ~2h of past radar frames plus short-range nowcast frames.
 *
 * Each frame is its own MapLibre `raster` layer, loaded once and then animated
 * purely by toggling `raster-opacity` — the approach RainViewer's own player
 * uses. This is the crucial difference from swapping one source's tiles per
 * frame: that re-fetches every visible tile on every frame, which hammers the
 * free tile server (rate-limited `Failed to fetch` errors) and keeps the render
 * pipeline busy (an unresponsive map). Frames are created lazily on the first
 * (idle-gated) playthrough so there is no initial request burst; after that,
 * playback is a network-free opacity crossfade. The overlay is a transient map
 * overlay (like the graticule) rather than a Layers-panel entry, matching the
 * always-on-top behaviour of Google Earth's weather layer.
 */

export const WEATHER_PLUGIN_ID = "maplibre-gl-weather";

/** Per-frame source/layer id prefixes (one raster source + layer per frame). */
const SOURCE_PREFIX = "geolibre-weather-source-";
const LAYER_PREFIX = "geolibre-weather-layer-";

/** RainViewer maps index: the list of available frames and the tile host. */
const MAPS_API_URL = "https://api.rainviewer.com/public/weather-maps.json";
const TILE_SIZE = 256;
/**
 * RainViewer radar colour scheme (4 = "The Weather Channel", the familiar
 * green→yellow→orange→red precipitation ramp). Tile options `1_1` = smoothed
 * tiles with snow shown.
 */
const RADAR_COLOR = 4;
const RADAR_OPTIONS = "1_1";
/**
 * Cap the number of animated frames. RainViewer publishes ~13 past frames; each
 * frame is a raster layer that reloads its viewport tiles on pan/zoom, so the
 * cap bounds how many parallel tile requests a navigation triggers. The most
 * recent frames are kept.
 */
const MAX_FRAMES = 13;
/** Milliseconds between animation frames, and how long to rest on the last one. */
const FRAME_INTERVAL_MS = 500;
const LOOP_REST_MS = 1500;
/** Opacity crossfade between consecutive frames, in ms. */
const CROSSFADE_MS = 220;
/**
 * Delay before the *first* frame advance so the initial (current) frame renders
 * before playback begins.
 */
const INITIAL_PLAY_DELAY_MS = 1200;
/** Re-fetch the frame index periodically so a long-open overlay stays current. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export interface WeatherSettings {
  /** Overlay opacity, 0–1. */
  opacity: number;
  /** Whether the frame loop is playing. */
  playing: boolean;
}

export const DEFAULT_WEATHER_SETTINGS: WeatherSettings = {
  opacity: 0.8,
  playing: true,
};

/**
 * User-facing strings for the on-map control. This package is framework
 * agnostic and cannot call react-i18next's `t()` directly, so the host pushes
 * translated values via {@link setWeatherLabels} (the pattern used by
 * `maplibre-graticule` / `maplibre-reverse-geocode`). Defaults are English.
 */
export interface WeatherLabels {
  title: string;
  play: string;
  pause: string;
  opacity: string;
  attribution: string;
  loading: string;
  error: string;
  noData: string;
}

export const DEFAULT_WEATHER_LABELS: WeatherLabels = {
  title: "Weather · Radar",
  play: "Play",
  pause: "Pause",
  opacity: "Opacity",
  attribution: "RainViewer",
  loading: "Loading weather…",
  error: "Weather data unavailable",
  noData: "No weather frames available",
};

let labels: WeatherLabels = { ...DEFAULT_WEATHER_LABELS };

/**
 * Replace the user-facing strings (the host calls this with translations on
 * every language change). Refreshes the live control if it is mounted.
 */
export function setWeatherLabels(next: Partial<WeatherLabels>): void {
  labels = { ...labels, ...next };
  control?.refresh();
}

// ---------------------------------------------------------------------------
// Frame model
// ---------------------------------------------------------------------------

interface WeatherFrame {
  /** Frame time in unix seconds. */
  time: number;
  /** RainViewer tile path, e.g. "/v2/radar/1700000000". */
  path: string;
  /** True for radar nowcast (near-future) frames. */
  nowcast: boolean;
}

interface RainViewerFrame {
  time: number;
  path: string;
}

interface RainViewerMaps {
  host: string;
  radar?: { past?: RainViewerFrame[]; nowcast?: RainViewerFrame[] };
}

let settings: WeatherSettings = { ...DEFAULT_WEATHER_SETTINGS };
let map: MapLibreMap | null = null;
let control: WeatherControl | null = null;
let unsubscribeBasemap: (() => void) | null = null;

/** Tile host from the most recent maps index. */
let tileHost = "";
/** Frames for the overlay, oldest first (nowcast, if any, last). */
let frames: WeatherFrame[] = [];
let frameIndex = 0;
/** Frame indices whose raster layer has been created (lazy load). */
const createdFrames = new Set<number>();
let animationTimer: ReturnType<typeof setTimeout> | null = null;
/** Cancellation flag for the in-flight animation loop (idle waits can't clear). */
let animationRun: { cancelled: boolean } | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
/** Guards async loads so a stale response cannot overwrite a newer one. */
let loadToken = 0;
type WeatherStatus = "loading" | "ready" | "error" | "empty";
let status: WeatherStatus = "loading";

export function getWeatherSettings(): WeatherSettings {
  return { ...settings };
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function frameSourceId(index: number): string {
  return `${SOURCE_PREFIX}${index}`;
}

function frameLayerId(index: number): string {
  return `${LAYER_PREFIX}${index}`;
}

/** Build the XYZ tile template for a radar frame. */
function frameTileUrl(frame: WeatherFrame): string {
  return `${tileHost}${frame.path}/${TILE_SIZE}/{z}/{x}/{y}/${RADAR_COLOR}/${RADAR_OPTIONS}.png`;
}

/** Extract the radar frame list (past + nowcast), capped to the most recent. */
function framesFromMaps(maps: RainViewerMaps): WeatherFrame[] {
  const past = (maps.radar?.past ?? []).map((f) => ({ ...f, nowcast: false }));
  const nowcast = (maps.radar?.nowcast ?? []).map((f) => ({
    ...f,
    nowcast: true,
  }));
  const all = [...past, ...nowcast];
  // Keep the most recent MAX_FRAMES (nowcast frames, being newest, are kept).
  return all.length > MAX_FRAMES ? all.slice(all.length - MAX_FRAMES) : all;
}

/** True when two frame lists reference the same times/paths in the same order. */
function framesUnchanged(a: WeatherFrame[], b: WeatherFrame[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (frame, index) => frame.path === b[index].path && frame.time === b[index].time,
  );
}

/**
 * Fetch the RainViewer frame index and render the overlay. Uses a load token so
 * a response that arrives after the plugin was deactivated is discarded instead
 * of drawing stale frames.
 *
 * Pass `silent` for the periodic background refresh so an already-drawn overlay
 * keeps showing its current frame (and time label) instead of flashing the
 * "loading" state every few minutes.
 */
async function loadFrames(silent = false): Promise<void> {
  const token = ++loadToken;
  if (!silent) {
    status = "loading";
    control?.refresh();
  }
  let maps: RainViewerMaps;
  try {
    const response = await fetch(MAPS_API_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    maps = (await response.json()) as RainViewerMaps;
  } catch {
    if (token !== loadToken || !map) return;
    if (status !== "ready") {
      // Only surface an error when there is nothing already on screen; a failed
      // background refresh should leave the current overlay untouched.
      status = "error";
      control?.refresh();
    }
    return;
  }
  if (token !== loadToken || !map) return;

  tileHost = maps.host ?? "https://tilecache.rainviewer.com";
  const nextFrames = framesFromMaps(maps);
  if (nextFrames.length === 0) {
    if (status !== "ready") {
      frames = [];
      status = "empty";
      control?.refresh();
    }
    return;
  }

  // A silent refresh with an unchanged frame set is a no-op — never tear down a
  // running animation just to rebuild identical layers.
  if (silent && status === "ready" && framesUnchanged(frames, nextFrames)) {
    return;
  }

  // Rebuild for a new frame set: the per-frame layers are indexed by position,
  // so a changed list must drop the old layers before showing the new ones.
  teardownLayers(map);
  frames = nextFrames;
  // Start on the most recent observed (non-nowcast) frame so the overlay shows
  // current conditions the moment it appears — whether it will animate or stay
  // paused — rather than opening on 2h-old radar.
  frameIndex = frames.reduce(
    (last, frame, index) => (frame.nowcast ? last : index),
    0,
  );
  status = "ready";

  showFrame(frameIndex);
  // Defer the first advance so the current frame renders before playback swaps.
  if (settings.playing) startAnimation(INITIAL_PLAY_DELAY_MS);
  control?.refresh();
}

// ---------------------------------------------------------------------------
// MapLibre layer management
// ---------------------------------------------------------------------------

/**
 * Id of the first symbol (label) layer, so the overlay can be inserted beneath
 * place labels — the Google Earth look, where city names stay legible on top of
 * the radar. Returns undefined if the style has no symbol layer (overlay then
 * draws on top).
 */
function firstSymbolLayerId(activeMap: MapLibreMap): string | undefined {
  const styleLayers = activeMap.getStyle()?.layers ?? [];
  for (const layer of styleLayers) {
    if (layer.type === "symbol") return layer.id;
  }
  return undefined;
}

/**
 * Create the raster source + layer for a frame if it does not exist yet. The
 * layer starts fully transparent; {@link showFrame} raises the active frame's
 * opacity. Lazy creation means each frame's tiles load once, the first time the
 * animation reaches it, rather than all frames loading up front.
 */
function ensureFrameLayer(activeMap: MapLibreMap, index: number): void {
  const sourceId = frameSourceId(index);
  const layerId = frameLayerId(index);
  if (!activeMap.getSource(sourceId)) {
    activeMap.addSource(sourceId, {
      type: "raster",
      tiles: [frameTileUrl(frames[index])],
      tileSize: TILE_SIZE,
      attribution:
        '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>',
    });
  }
  if (!activeMap.getLayer(layerId)) {
    activeMap.addLayer(
      {
        id: layerId,
        type: "raster",
        source: sourceId,
        paint: {
          "raster-opacity": 0,
          // Animate opacity changes for a smooth crossfade between frames.
          "raster-opacity-transition": { duration: CROSSFADE_MS, delay: 0 },
          // We own the crossfade via opacity; MapLibre's own tile fade would
          // stack a second, laggier dissolve on top of it.
          "raster-fade-duration": 0,
        },
      },
      firstSymbolLayerId(activeMap),
    );
  }
  createdFrames.add(index);
}

function teardownLayers(activeMap: MapLibreMap): void {
  for (const index of createdFrames) {
    const layerId = frameLayerId(index);
    const sourceId = frameSourceId(index);
    if (activeMap.getLayer(layerId)) activeMap.removeLayer(layerId);
    if (activeMap.getSource(sourceId)) activeMap.removeSource(sourceId);
  }
  createdFrames.clear();
}

/**
 * Make `index` the visible frame: ensure its layer exists, then raise its
 * opacity while dropping every other created frame's to 0. No tiles are fetched
 * unless this frame's layer is new (lazy load) or the viewport changed.
 */
function showFrame(index: number): void {
  if (!map || frames.length === 0) return;
  frameIndex = ((index % frames.length) + frames.length) % frames.length;
  ensureFrameLayer(map, frameIndex);
  for (const created of createdFrames) {
    const layerId = frameLayerId(created);
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(
      layerId,
      "raster-opacity",
      created === frameIndex ? settings.opacity : 0,
    );
  }
  control?.refresh();
}

function applyOpacity(): void {
  if (map?.getLayer(frameLayerId(frameIndex))) {
    map.setPaintProperty(
      frameLayerId(frameIndex),
      "raster-opacity",
      settings.opacity,
    );
  }
}

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------

/**
 * Advance the radar loop, gating each step on BOTH a minimum interval and the
 * map reaching `idle`. Waiting for idle means a frame whose layer is being
 * created (or whose viewport tiles are still loading) finishes before the next
 * advance, so playback naturally paces itself to the network on the first loop
 * and while panning. Once every frame's layer exists and its tiles are cached,
 * idle fires immediately and playback runs at the plain frame interval with no
 * further fetching — just an opacity crossfade.
 */
function startAnimation(initialDelay = FRAME_INTERVAL_MS): void {
  stopAnimation();
  if (frames.length < 2) return;
  const run = { cancelled: false };
  animationRun = run;

  const step = (): void => {
    if (run.cancelled || !map) return;
    const atEnd = frameIndex >= frames.length - 1;
    showFrame(frameIndex + 1);
    const interval = atEnd ? LOOP_REST_MS : FRAME_INTERVAL_MS;

    let idled = false;
    let waited = false;
    const advance = (): void => {
      if (idled && waited && !run.cancelled) step();
    };
    map.once("idle", () => {
      idled = true;
      advance();
    });
    animationTimer = setTimeout(() => {
      waited = true;
      advance();
    }, interval);
  };

  animationTimer = setTimeout(step, initialDelay);
}

function stopAnimation(): void {
  if (animationTimer !== null) {
    clearTimeout(animationTimer);
    animationTimer = null;
  }
  if (animationRun) {
    animationRun.cancelled = true;
    animationRun = null;
  }
}

// ---------------------------------------------------------------------------
// Settings mutations (driven by the control)
// ---------------------------------------------------------------------------

function setPlaying(playing: boolean): void {
  if (settings.playing === playing) return;
  settings.playing = playing;
  if (playing) startAnimation();
  else stopAnimation();
  control?.refresh();
}

function setOpacity(opacity: number): void {
  const clamped = Math.min(1, Math.max(0, opacity));
  settings.opacity = clamped;
  applyOpacity();
  control?.refresh();
}

/** Format a frame's unix-seconds time as a short local time for the label. */
function formatFrameTime(frame: WeatherFrame | undefined): string {
  if (!frame) return "";
  const date = new Date(frame.time * 1000);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return frame.nowcast ? `${time} ›` : time;
}

// ---------------------------------------------------------------------------
// On-map control
// ---------------------------------------------------------------------------

/**
 * Compact weather widget: a title, a play/pause button beside an opacity
 * slider, and a frame-time + attribution footer. Built as plain DOM per the
 * plugin contract; the host themes it via `.geolibre-weather-control` in
 * index.css.
 */
class WeatherControl implements IControl {
  private container: HTMLElement | null = null;
  private playButton: HTMLButtonElement | null = null;
  private opacityInput: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;

  onAdd(): HTMLElement {
    const container = document.createElement("div");
    container.className =
      "maplibregl-ctrl maplibregl-ctrl-group geolibre-weather-control";
    // Keep map drag/zoom from firing while interacting with the widget.
    container.addEventListener("mousedown", (e) => e.stopPropagation());
    container.addEventListener("dblclick", (e) => e.stopPropagation());

    const title = document.createElement("div");
    title.className = "geolibre-weather-title";
    title.textContent = labels.title;
    container.appendChild(title);

    const playRow = document.createElement("div");
    playRow.className = "geolibre-weather-row";
    this.playButton = document.createElement("button");
    this.playButton.type = "button";
    this.playButton.className = "geolibre-weather-play";
    this.playButton.addEventListener("click", () =>
      setPlaying(!settings.playing),
    );
    playRow.appendChild(this.playButton);

    this.opacityInput = document.createElement("input");
    this.opacityInput.type = "range";
    this.opacityInput.min = "0";
    this.opacityInput.max = "1";
    this.opacityInput.step = "0.05";
    this.opacityInput.className = "geolibre-weather-opacity";
    this.opacityInput.setAttribute("aria-label", labels.opacity);
    this.opacityInput.addEventListener("input", () => {
      setOpacity(Number(this.opacityInput?.value ?? settings.opacity));
    });
    playRow.appendChild(this.opacityInput);
    container.appendChild(playRow);

    this.statusEl = document.createElement("div");
    this.statusEl.className = "geolibre-weather-status";
    container.appendChild(this.statusEl);

    this.container = container;
    this.refresh();
    return container;
  }

  /** Re-render the control's dynamic state (title, play icon, status). */
  refresh(): void {
    if (!this.container) return;
    const titleEl = this.container.querySelector(".geolibre-weather-title");
    if (titleEl) titleEl.textContent = labels.title;
    if (this.playButton) {
      this.playButton.innerHTML = settings.playing ? PAUSE_ICON : PLAY_ICON;
      const label = settings.playing ? labels.pause : labels.play;
      this.playButton.title = label;
      this.playButton.setAttribute("aria-label", label);
      this.playButton.disabled = status !== "ready" || frames.length < 2;
    }
    if (this.opacityInput) {
      this.opacityInput.value = String(settings.opacity);
    }
    if (this.statusEl) {
      this.statusEl.textContent = this.statusText();
    }
  }

  private statusText(): string {
    switch (status) {
      case "loading":
        return labels.loading;
      case "error":
        return labels.error;
      case "empty":
        return labels.noData;
      default: {
        const time = formatFrameTime(frames[frameIndex]);
        return time ? `${time} · ${labels.attribution}` : labels.attribution;
      }
    }
  }

  onRemove(): void {
    this.container?.parentNode?.removeChild(this.container);
    this.container = null;
    this.playButton = null;
    this.opacityInput = null;
    this.statusEl = null;
  }
}

const PLAY_ICON = `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M3.5 2.5v9l7-4.5z"/></svg>`;
const PAUSE_ICON = `<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="3" y="2.5" width="3" height="9" rx="0.5"/><rect x="8" y="2.5" width="3" height="9" rx="0.5"/></svg>`;

// ---------------------------------------------------------------------------
// Settings normalization (project state is opaque JSON)
// ---------------------------------------------------------------------------

function normalizeSettings(value: unknown): WeatherSettings {
  const v = (value ?? {}) as Partial<WeatherSettings>;
  const d = DEFAULT_WEATHER_SETTINGS;
  const opacity = Number(v.opacity);
  return {
    opacity: Number.isFinite(opacity)
      ? Math.min(1, Math.max(0, opacity))
      : d.opacity,
    playing: typeof v.playing === "boolean" ? v.playing : d.playing,
  };
}

function settingsEqual(a: WeatherSettings, b: WeatherSettings): boolean {
  return a.opacity === b.opacity && a.playing === b.playing;
}

function isDefaultSettings(value: WeatherSettings): boolean {
  return settingsEqual(value, DEFAULT_WEATHER_SETTINGS);
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export const maplibreWeatherPlugin: GeoLibrePlugin = {
  id: WEATHER_PLUGIN_ID,
  name: "Weather",
  version: "0.1.0",
  activate: (app: GeoLibreAppAPI) => {
    const activeMap = app.getMap?.();
    if (!activeMap) return false;
    map = activeMap;

    control = new WeatherControl();
    const added = app.addMapControl(control, "top-right");
    if (!added) {
      control = null;
      map = null;
      return false;
    }

    // setStyle (basemap change) drops our sources/layers, so rebuild afterward
    // once the new style is ready.
    unsubscribeBasemap = app.onBasemapChange(() => {
      if (!map) return;
      map.once("idle", () => {
        if (!map || status !== "ready" || frames.length === 0) return;
        // setStyle already removed the layers; forget them so showFrame/
        // startAnimation recreate them lazily rather than skip "existing" ids.
        createdFrames.clear();
        showFrame(frameIndex);
        if (settings.playing) startAnimation(INITIAL_PLAY_DELAY_MS);
      });
    });

    void loadFrames();
    // Refresh the frame index periodically so the loop keeps up with new radar.
    refreshTimer = setInterval(() => void loadFrames(true), REFRESH_INTERVAL_MS);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    stopAnimation();
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    // Bump the token so any in-flight load resolves into a no-op.
    loadToken += 1;
    unsubscribeBasemap?.();
    unsubscribeBasemap = null;
    if (control) {
      app.removeMapControl(control);
      control = null;
    }
    if (map) teardownLayers(map);
    map = null;
    frames = [];
    frameIndex = 0;
    status = "loading";
  },
  getProjectState: () =>
    isDefaultSettings(settings) ? undefined : { ...settings },
  applyProjectState: (_app: GeoLibreAppAPI, state: unknown) => {
    const next = normalizeSettings(state);
    if (settingsEqual(settings, next)) return false;
    settings = next;
    applyOpacity();
    if (settings.playing) startAnimation();
    else stopAnimation();
    control?.refresh();
  },
};
