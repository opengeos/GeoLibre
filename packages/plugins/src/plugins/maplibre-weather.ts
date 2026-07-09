import type {
  PropertyValueSpecification,
  IControl,
  Map as MapLibreMap,
  RasterTileSource,
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
 * The overlay is ONE MapLibre `raster` layer whose tile template is swapped per
 * animation frame via `RasterTileSource.setTiles`. A single source keeps
 * navigation cheap — a pan/zoom loads one frame's viewport tiles, not one set
 * per frame — and each advance is gated on the map reaching `idle`, so:
 *   - the first playthrough loads each frame's tiles gently (no cold-cache
 *     abort storm), and thereafter frames are served from the browser's HTTP
 *     cache (RainViewer sends a 2-day max-age), so playback issues no network;
 *   - while the user is panning/zooming the map is never idle, so frame-advance
 *     naturally pauses and does not pile tile churn onto the navigation.
 *
 * The source is capped at {@link RADAR_MAX_ZOOM}: RainViewer radar is coarse
 * (~1 km native), so beyond that MapLibre overzooms the deepest tiles instead of
 * requesting (and aborting) hundreds of deep tiles that would only upscale into
 * a uniform smear. The overlay is a transient map overlay (like the graticule)
 * rather than a Layers-panel entry, matching Google Earth's always-on-top look.
 */

export const WEATHER_PLUGIN_ID = "maplibre-gl-weather";

const SOURCE_ID = "geolibre-weather-source";
const LAYER_ID = "geolibre-weather-layer";

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
 * Native max zoom for the radar source. RainViewer's radar data is coarse, so
 * requesting tiles past this only yields upscaled/empty tiles; capping the
 * source here makes MapLibre overzoom (stretch) the deepest real tiles instead,
 * which keeps the layer visible when zoomed in and — crucially — stops the burst
 * of aborted deep-tile requests that otherwise floods the console (issue seen at
 * city-level zoom: layer blanks out, diagnostics fill with `Failed to fetch`).
 */
const RADAR_MAX_ZOOM = 9;
/**
 * Zooms past {@link RADAR_MAX_ZOOM} over which the overlay fades toward
 * {@link DEEP_ZOOM_OPACITY_FACTOR} of the user's opacity. Beyond the radar's
 * native resolution each tile is one coarse pixel stretched across the screen;
 * at full opacity that reads as a solid colour blanketing the basemap, so the
 * overlay is made progressively translucent (the map stays visible beneath it).
 */
const OPACITY_FADE_ZOOMS = 4;
const DEEP_ZOOM_OPACITY_FACTOR = 0.3;
/** Milliseconds between animation frames, and how long to rest on the last one. */
const FRAME_INTERVAL_MS = 500;
const LOOP_REST_MS = 1500;
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

/** Build the XYZ tile template for a radar frame. */
function frameTileUrl(frame: WeatherFrame): string {
  return `${tileHost}${frame.path}/${TILE_SIZE}/{z}/{x}/{y}/${RADAR_COLOR}/${RADAR_OPTIONS}.png`;
}

/** Extract the radar frame list (past + nowcast) from a maps index. */
function framesFromMaps(maps: RainViewerMaps): WeatherFrame[] {
  const past = (maps.radar?.past ?? []).map((f) => ({ ...f, nowcast: false }));
  const nowcast = (maps.radar?.nowcast ?? []).map((f) => ({
    ...f,
    nowcast: true,
  }));
  return [...past, ...nowcast];
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

  // A silent refresh with an unchanged frame set is a no-op — never restart a
  // running animation just to redraw the same frames.
  if (silent && status === "ready" && framesUnchanged(frames, nextFrames)) {
    return;
  }

  frames = nextFrames;
  // Start on the most recent observed (non-nowcast) frame so the overlay shows
  // current conditions the moment it appears — whether it will animate or stay
  // paused — rather than opening on 2h-old radar.
  frameIndex = frames.reduce(
    (last, frame, index) => (frame.nowcast ? last : index),
    0,
  );
  status = "ready";

  ensureLayer(map);
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
 * Raster opacity as a zoom expression: the user's opacity up to the radar's
 * native max zoom, fading to {@link DEEP_ZOOM_OPACITY_FACTOR} of it over the
 * next {@link OPACITY_FADE_ZOOMS} levels so the coarse overzoomed tiles do not
 * blanket the basemap when the user zooms in past the data's resolution.
 */
function opacityExpression(): PropertyValueSpecification<number> {
  const base = settings.opacity;
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    RADAR_MAX_ZOOM,
    base,
    RADAR_MAX_ZOOM + OPACITY_FADE_ZOOMS,
    Math.max(0, base * DEEP_ZOOM_OPACITY_FACTOR),
  ];
}

function ensureLayer(activeMap: MapLibreMap): void {
  if (!activeMap.getSource(SOURCE_ID)) {
    activeMap.addSource(SOURCE_ID, {
      type: "raster",
      tiles: [],
      tileSize: TILE_SIZE,
      // Overzoom past the radar's native resolution instead of fetching coarse
      // deep tiles (keeps the layer visible when zoomed in, no request storm).
      maxzoom: RADAR_MAX_ZOOM,
      attribution:
        '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>',
    });
  }
  if (!activeMap.getLayer(LAYER_ID)) {
    activeMap.addLayer(
      {
        id: LAYER_ID,
        type: "raster",
        source: SOURCE_ID,
        paint: {
          "raster-opacity": opacityExpression(),
          // A short crossfade smooths the per-frame tile swap during playback.
          "raster-fade-duration": 250,
        },
      },
      firstSymbolLayerId(activeMap),
    );
  }
}

function teardownLayer(activeMap: MapLibreMap): void {
  if (activeMap.getLayer(LAYER_ID)) activeMap.removeLayer(LAYER_ID);
  if (activeMap.getSource(SOURCE_ID)) activeMap.removeSource(SOURCE_ID);
}

/** Point the raster source at the given frame's tiles and update the control. */
function showFrame(index: number): void {
  if (!map || frames.length === 0) return;
  frameIndex = ((index % frames.length) + frames.length) % frames.length;
  const source = map.getSource(SOURCE_ID) as RasterTileSource | undefined;
  source?.setTiles([frameTileUrl(frames[frameIndex])]);
  control?.refresh();
}

function applyOpacity(): void {
  if (map?.getLayer(LAYER_ID)) {
    map.setPaintProperty(LAYER_ID, "raster-opacity", opacityExpression());
  }
}

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------

/**
 * Advance the radar loop, gating each step on BOTH a minimum interval and the
 * map reaching `idle`. Waiting for idle means the frame just shown has finished
 * loading its tiles before the next swap replaces them — swapping a raster
 * source mid-load aborts the in-flight tile requests, which Chromium surfaces as
 * a burst of CORS/ERR_FAILED console noise. It also means playback pauses while
 * the user pans/zooms (the map is not idle then), so navigation is not saddled
 * with per-frame tile churn. On a warm cache idle fires immediately, so playback
 * runs at the plain frame interval fetching nothing.
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

    // setStyle (basemap change) drops our source/layer, so rebuild afterward
    // once the new style is ready.
    unsubscribeBasemap = app.onBasemapChange(() => {
      if (!map) return;
      map.once("idle", () => {
        if (!map || status !== "ready" || frames.length === 0) return;
        ensureLayer(map);
        showFrame(frameIndex);
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
    if (map) teardownLayer(map);
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
