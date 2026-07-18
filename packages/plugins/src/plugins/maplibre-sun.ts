import type { CanvasSource, LightSpecification, Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

/**
 * GeoLibre sun-position simulation plugin.
 *
 * Reproduces the core of Google Earth's "sun" feature: pick a date and time and
 * the map shades its night hemisphere, with the day/night terminator sweeping
 * across the globe as time advances. A floating panel (rendered by the desktop
 * shell) drives the clock — scrub the slider to move the sun, or press play to
 * animate. The illuminated/dark split is drawn as a generated MapLibre canvas
 * raster, with per-pixel alpha based on solar altitude so the day/night edge is
 * continuous instead of a stack of visible bands. In parallel the plugin drives
 * `map.setLight()` so 3D buildings and models are lit from the sun's real
 * azimuth/altitude.
 *
 * The astronomy (subsolar point, terminator latitude, solar altitude/azimuth)
 * is a compact port of the low-precision NOAA solar-position equations, the
 * same ones used by the well-known Leaflet.Terminator plugin.
 */

export const SUN_PLUGIN_ID = "geolibre-sun";

const NIGHT_SOURCE_ID = "geolibre-sun-night-source";
const NIGHT_LAYER_ID = "geolibre-sun-night-layer";
// Legacy layer ids used by the first polygon-band renderer.
const NIGHT_LAYER_PREFIX = "geolibre-sun-night-layer-";
const NIGHT_CANVAS_WIDTH = 960;
const NIGHT_CANVAS_HEIGHT = 480;
const NIGHT_CANVAS_NORTH = 85;
const NIGHT_CANVAS_SOUTH = -85;
const NIGHT_TWILIGHT_DEPTH = 24;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const NIGHT_TWILIGHT_SIN_DEPTH = Math.sin(NIGHT_TWILIGHT_DEPTH * D2R);
const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
// Minimum subsolar-longitude movement (degrees, ~1 min of time) that warrants a
// night-mask redraw; smaller playback steps reuse the last painted mask.
const MASK_LNG_EPSILON = 0.25;

/** Local midnight (device time zone) of the day containing `dateMs`. */
export function localDayStart(dateMs: number): number {
  const d = new Date(dateMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Persisted, user-tunable state of the sun simulation. */
export interface SunSettings {
  /** Simulated instant, epoch milliseconds (UTC under the hood). */
  dateMs: number;
  /** Whether the clock is animating forward. */
  playing: boolean;
  /**
   * Animation rate: simulated minutes advanced per real second of playback.
   * A full day (1440 min) sweeps by in `1440 / speed` seconds.
   */
  speed: number;
  /** When true, playback wraps to the start of the day instead of stopping. */
  loop: boolean;
  /** Opacity of the deep-night core (0 = no shading, 1 = fully dark). */
  shadeOpacity: number;
}

export const SUN_SPEED_MIN = 5;
export const SUN_SPEED_MAX = 480;
export const SUN_SHADE_MIN = 0;
export const SUN_SHADE_MAX = 0.85;

/**
 * Default clock is midday UTC on an arbitrary fixed date rather than "now": the
 * plugin is pure and must not read the wall clock at module load, and a stable
 * default keeps project files deterministic. The panel offers a "Now" button to
 * jump to the current time on demand.
 */
export const DEFAULT_SUN_SETTINGS: SunSettings = {
  dateMs: Date.UTC(2024, 5, 21, 12, 0, 0), // June solstice, noon UTC
  playing: false,
  speed: 60,
  loop: true,
  shadeOpacity: 0.55,
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Coerce arbitrary persisted/partial input into a complete SunSettings. */
export function normalizeSunSettings(
  value: unknown,
  base: SunSettings = DEFAULT_SUN_SETTINGS,
): SunSettings {
  const c = (value ?? {}) as Partial<SunSettings>;
  return {
    dateMs: typeof c.dateMs === "number" && Number.isFinite(c.dateMs) ? c.dateMs : base.dateMs,
    playing: typeof c.playing === "boolean" ? c.playing : base.playing,
    speed: clampNumber(c.speed, SUN_SPEED_MIN, SUN_SPEED_MAX, base.speed),
    loop: typeof c.loop === "boolean" ? c.loop : base.loop,
    shadeOpacity: clampNumber(c.shadeOpacity, SUN_SHADE_MIN, SUN_SHADE_MAX, base.shadeOpacity),
  };
}

function sunSettingsEqual(a: SunSettings, b: SunSettings): boolean {
  return (
    a.dateMs === b.dateMs &&
    a.playing === b.playing &&
    a.speed === b.speed &&
    a.loop === b.loop &&
    a.shadeOpacity === b.shadeOpacity
  );
}

// ---------------------------------------------------------------------------
// Solar position (low-precision NOAA equations).
// ---------------------------------------------------------------------------

function julianDay(dateMs: number): number {
  return dateMs / MS_PER_DAY + 2440587.5;
}

/** Greenwich Mean Sidereal Time, in hours. */
function greenwichMeanSiderealTime(jd: number): number {
  const d = jd - 2451545.0;
  return (18.697374558 + 24.06570982441908 * d) % 24;
}

interface SunEquatorial {
  /** Right ascension, degrees. */
  alpha: number;
  /** Declination, degrees. */
  delta: number;
}

/** Sun's apparent right ascension and declination for the given instant. */
export function sunEquatorialPosition(dateMs: number): SunEquatorial {
  const jd = julianDay(dateMs);
  const n = jd - 2451545.0;
  const meanLng = (280.46 + 0.9856474 * n) % 360;
  const meanAnomaly = ((357.528 + 0.9856003 * n) % 360) * D2R;
  const eclipticLng = meanLng + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly);
  const obliquity = 23.439 - 0.0000004 * n;
  const lngRad = eclipticLng * D2R;
  const obRad = obliquity * D2R;

  let alpha = Math.atan2(Math.cos(obRad) * Math.sin(lngRad), Math.cos(lngRad)) * R2D;
  alpha = ((alpha % 360) + 360) % 360;
  const delta = Math.asin(Math.sin(obRad) * Math.sin(lngRad)) * R2D;
  return { alpha, delta };
}

/**
 * Subsolar point: the lat/long where the sun is directly overhead. Latitude is
 * the solar declination; longitude is derived from sidereal time so it walks
 * ~15°/hour westward through the day.
 */
export function subsolarPoint(dateMs: number): { lat: number; lng: number } {
  const jd = julianDay(dateMs);
  const gst = greenwichMeanSiderealTime(jd);
  const { alpha, delta } = sunEquatorialPosition(dateMs);
  // Longitude where the local hour angle is zero (sun on the meridian).
  let lng = alpha - gst * 15;
  lng = ((((lng + 180) % 360) + 360) % 360) - 180;
  return { lat: delta, lng };
}

/**
 * Solar altitude (degrees above the horizon; negative below) and azimuth
 * (degrees clockwise from true north) as seen from `lat`/`lng` at `dateMs`.
 */
export function sunPositionAt(
  dateMs: number,
  lat: number,
  lng: number,
): { altitude: number; azimuth: number } {
  const jd = julianDay(dateMs);
  const gst = greenwichMeanSiderealTime(jd);
  const { alpha, delta } = sunEquatorialPosition(dateMs);
  // Local hour angle, degrees, normalized to [-180, 180].
  let ha = gst * 15 + lng - alpha;
  ha = ((((ha + 180) % 360) + 360) % 360) - 180;
  const haR = ha * D2R;
  const latR = lat * D2R;
  const decR = delta * D2R;
  // Clamp before asin: the bracketed term is mathematically within [-1, 1] but
  // floating-point rounding can push it fractionally past 1 (e.g. sun at zenith
  // for the current center at local noon), which would make asin return NaN.
  const sinAltitude =
    Math.sin(latR) * Math.sin(decR) + Math.cos(latR) * Math.cos(decR) * Math.cos(haR);
  const altitude = Math.asin(Math.min(1, Math.max(-1, sinAltitude))) * R2D;
  // Azimuth measured clockwise from north.
  const azimuth =
    (Math.atan2(Math.sin(haR), Math.cos(haR) * Math.sin(latR) - Math.tan(decR) * Math.cos(latR)) *
      R2D +
      180) %
    360;
  return { altitude, azimuth };
}

// ---------------------------------------------------------------------------
// Map engine: owns the night layers, the sun light, and the animation loop.
// ---------------------------------------------------------------------------

const NIGHT_RGB = { r: 10, g: 16, b: 32 };

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

class SunEngine {
  private readonly map: MapLibreMap;
  private settings: SunSettings;
  private readonly previousLight: LightSpecification | undefined;
  private readonly nightCanvas: HTMLCanvasElement;
  private readonly nightContext: CanvasRenderingContext2D | null;
  private nightImageData: ImageData | null = null;
  // Subsolar point / shading depth of the last painted mask, so playback can
  // skip the full per-pixel recompute until the sun has actually moved.
  private maskDrawn = false;
  private lastMaskLng = 0;
  private lastMaskLat = 0;
  private lastMaskShade = -1;
  private rafId: number | null = null;
  // Wall-clock timestamp of the previous animation frame; null while paused.
  private lastFrame: number | null = null;
  private destroyed = false;

  constructor(map: MapLibreMap, settings: SunSettings) {
    this.map = map;
    this.settings = settings;
    let saved: LightSpecification | undefined;
    try {
      saved = map.getLight();
    } catch {
      saved = undefined;
    }
    this.previousLight = saved;
    this.nightCanvas = document.createElement("canvas");
    this.nightCanvas.width = NIGHT_CANVAS_WIDTH;
    this.nightCanvas.height = NIGHT_CANVAS_HEIGHT;
    this.nightContext = this.nightCanvas.getContext("2d", {
      willReadFrequently: true,
    });

    this.handleStyleData = this.handleStyleData.bind(this);
    this.tick = this.tick.bind(this);
    map.on("styledata", this.handleStyleData);

    this.ensureLayers();
    this.render();
    if (settings.playing) this.play();
  }

  getMapInstance(): MapLibreMap {
    return this.map;
  }

  applySettings(settings: SunSettings): void {
    const wasPlaying = this.settings.playing;
    this.settings = settings;
    this.render();
    if (settings.playing && !wasPlaying) this.play();
    else if (!settings.playing && wasPlaying) this.pause();
  }

  destroy(): void {
    this.destroyed = true;
    this.pause();
    this.map.off("styledata", this.handleStyleData);
    this.removeLayers();
    // Restore the light the map had before the simulation took over.
    try {
      if (this.previousLight) this.map.setLight(this.previousLight);
    } catch {
      // The style may already be tearing down; nothing to restore onto.
    }
  }

  // A basemap style swap wipes custom layers; re-add them on the next styledata.
  private handleStyleData(): void {
    if (this.destroyed) return;
    if (!this.map.getSource(NIGHT_SOURCE_ID)) {
      this.ensureLayers();
      this.render();
    }
  }

  private ensureLayers(): void {
    // Adding sources/layers before the style is ready throws; the styledata
    // handler re-runs this the moment the style finishes loading.
    if (!this.map.isStyleLoaded()) return;
    this.removeLegacyBandLayers();
    if (this.map.getSource(NIGHT_SOURCE_ID)) return;
    this.drawNightMask();
    this.map.addSource(NIGHT_SOURCE_ID, {
      type: "canvas",
      canvas: this.nightCanvas,
      animate: true,
      coordinates: [
        [-180, NIGHT_CANVAS_NORTH],
        [180, NIGHT_CANVAS_NORTH],
        [180, NIGHT_CANVAS_SOUTH],
        [-180, NIGHT_CANVAS_SOUTH],
      ],
    });
    this.map.addLayer({
      id: NIGHT_LAYER_ID,
      type: "raster",
      source: NIGHT_SOURCE_ID,
      paint: {
        "raster-opacity": 1,
        "raster-fade-duration": 0,
        "raster-resampling": "linear",
      },
    });
  }

  private removeLayers(): void {
    if (this.map.getLayer(NIGHT_LAYER_ID)) this.map.removeLayer(NIGHT_LAYER_ID);
    this.removeLegacyBandLayers();
    if (this.map.getSource(NIGHT_SOURCE_ID)) {
      this.map.removeSource(NIGHT_SOURCE_ID);
    }
  }

  private removeLegacyBandLayers(): void {
    for (let index = 0; index < 128; index += 1) {
      const layerId = `${NIGHT_LAYER_PREFIX}${index}`;
      if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    }
  }

  /** Recompute the night polygons and the sun light for the current instant. */
  render(): void {
    if (this.destroyed) return;
    const source = this.map.getSource(NIGHT_SOURCE_ID) as CanvasSource | undefined;
    if (!source) return;
    this.drawNightMask();
    this.applyLight();
  }

  private drawNightMask(): void {
    if (!this.nightContext) return;
    const subsolar = subsolarPoint(this.settings.dateMs);
    const subLng = subsolar.lng;
    const shadeAlpha = Math.round(Math.min(1, Math.max(0, this.settings.shadeOpacity)) * 255);
    // Throttle: playing the clock re-renders every animation frame, but the
    // subsolar point creeps only a fraction of a degree per frame. Skip the
    // 460k-pixel recompute until it (or the shading depth) moves enough to be
    // visible; a scrub or date change jumps well past the epsilon and redraws.
    const lngDelta = Math.abs(((subLng - this.lastMaskLng + 540) % 360) - 180);
    if (
      this.maskDrawn &&
      lngDelta < MASK_LNG_EPSILON &&
      subsolar.lat === this.lastMaskLat &&
      shadeAlpha === this.lastMaskShade
    ) {
      return;
    }

    const width = this.nightCanvas.width;
    const height = this.nightCanvas.height;
    if (
      !this.nightImageData ||
      this.nightImageData.width !== width ||
      this.nightImageData.height !== height
    ) {
      this.nightImageData = this.nightContext.createImageData(width, height);
    }

    const data = this.nightImageData.data;
    const decR = subsolar.lat * D2R;
    const sinDec = Math.sin(decR);
    const cosDec = Math.cos(decR);
    const cosHourAngles = new Float64Array(width);
    for (let x = 0; x < width; x += 1) {
      const lng = -180 + ((x + 0.5) / width) * 360;
      const hourAngle = ((((lng - subLng + 180) % 360) + 360) % 360) - 180;
      cosHourAngles[x] = Math.cos(hourAngle * D2R);
    }

    let offset = 0;
    for (let y = 0; y < height; y += 1) {
      const lat =
        NIGHT_CANVAS_NORTH - ((y + 0.5) / height) * (NIGHT_CANVAS_NORTH - NIGHT_CANVAS_SOUTH);
      const latR = lat * D2R;
      const sinLat = Math.sin(latR);
      const cosLat = Math.cos(latR);
      for (let x = 0; x < width; x += 1) {
        const sinAltitude = sinLat * sinDec + cosLat * cosDec * cosHourAngles[x];
        const twilight = smoothstep(-sinAltitude / NIGHT_TWILIGHT_SIN_DEPTH);
        data[offset] = NIGHT_RGB.r;
        data[offset + 1] = NIGHT_RGB.g;
        data[offset + 2] = NIGHT_RGB.b;
        data[offset + 3] = Math.round(shadeAlpha * twilight);
        offset += 4;
      }
    }

    this.nightContext.putImageData(this.nightImageData, 0, 0);
    this.maskDrawn = true;
    this.lastMaskLng = subLng;
    this.lastMaskLat = subsolar.lat;
    this.lastMaskShade = shadeAlpha;
  }

  /** Point the 3D scene light at the sun as seen from the current map center. */
  private applyLight(): void {
    let center: { lat: number; lng: number };
    try {
      center = this.map.getCenter();
    } catch {
      return;
    }
    const { altitude, azimuth } = sunPositionAt(this.settings.dateMs, center.lat, center.lng);
    // Polar angle: 0 = light straight overhead, 90 = at the horizon. Below the
    // horizon we keep it grazing and dim the intensity to read as night.
    const polar = Math.min(90, Math.max(0, 90 - altitude));
    const daylight = Math.max(0, Math.sin(altitude * D2R));
    const intensity = 0.2 + 0.6 * daylight;
    // Warm the light near the horizon (sunrise/sunset), cool toward midday.
    const warmth = 1 - daylight;
    const r = 255;
    const g = Math.round(255 - 40 * warmth);
    const b = Math.round(255 - 90 * warmth);
    try {
      this.map.setLight({
        anchor: "map",
        position: [1.5, azimuth, polar],
        color: `rgb(${r}, ${g}, ${b})`,
        intensity,
      });
    } catch {
      // Older style with no light support; the night overlay still conveys time.
    }
  }

  play(): void {
    if (this.destroyed || this.rafId !== null) return;
    this.lastFrame = null;
    this.rafId = window.requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.lastFrame = null;
  }

  private tick(now: number): void {
    this.rafId = null;
    if (this.destroyed || !this.settings.playing) return;
    if (this.lastFrame !== null) {
      const elapsedSec = (now - this.lastFrame) / 1000;
      const advancedMs = elapsedSec * this.settings.speed * MS_PER_MINUTE;
      advanceSunClock(advancedMs);
    }
    this.lastFrame = now;
    this.rafId = window.requestAnimationFrame(this.tick);
  }
}

// ---------------------------------------------------------------------------
// Module store: single source of truth shared by the engine and the React panel.
// ---------------------------------------------------------------------------

let engine: SunEngine | null = null;
let panelVisible = false;
let settings: SunSettings = { ...DEFAULT_SUN_SETTINGS };

const panelListeners = new Set<() => void>();
const stateListeners = new Set<() => void>();

function notifyPanel(): void {
  for (const listener of panelListeners) listener();
}
function notifyState(): void {
  for (const listener of stateListeners) listener();
}

function attachEngine(app: GeoLibreAppAPI): boolean {
  const map = app.getMap?.();
  if (!map) return false;
  if (engine && engine.getMapInstance() !== map) detachEngine();
  if (!engine) engine = new SunEngine(map, settings);
  return true;
}

function detachEngine(): void {
  engine?.destroy();
  engine = null;
}

/** Open the sun panel and start shading the map. Idempotent. */
export function openSunPanel(app: GeoLibreAppAPI): void {
  if (!panelVisible) {
    panelVisible = true;
    notifyPanel();
  }
  attachEngine(app);
}

/** Close the sun panel, stop the animation, and clear the shading. */
export function closeSunPanel(_app?: GeoLibreAppAPI): void {
  if (settings.playing) {
    settings = { ...settings, playing: false };
  }
  detachEngine();
  if (panelVisible) {
    panelVisible = false;
    notifyPanel();
    notifyState();
  }
}

export function isSunPanelVisible(): boolean {
  return panelVisible;
}

export function subscribeSunPanel(listener: () => void): () => void {
  panelListeners.add(listener);
  return () => panelListeners.delete(listener);
}

/** Current simulation settings (a copy callers may freely read). */
export function getSunSettings(): SunSettings {
  return { ...settings };
}

/**
 * Stable settings reference for `useSyncExternalStore`. `settings` is replaced
 * immutably on every change, so the identity is constant between changes — which
 * is exactly what React needs to avoid a re-render loop. Do not mutate it.
 */
export function getSunSettingsSnapshot(): SunSettings {
  return settings;
}

export function subscribeSunSettings(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/**
 * Apply a partial settings change: normalize, push to the engine, and notify
 * React subscribers. Returns true when something actually changed.
 */
export function setSunSettings(next: Partial<SunSettings>): boolean {
  const normalized = normalizeSunSettings({ ...settings, ...next }, DEFAULT_SUN_SETTINGS);
  if (sunSettingsEqual(normalized, settings)) return false;
  settings = normalized;
  engine?.applySettings(settings);
  notifyState();
  return true;
}

/**
 * Advance the simulated clock by `deltaMs`, honoring the loop setting. Called by
 * the engine's animation loop each frame; stops at end-of-day when not looping.
 */
export function advanceSunClock(deltaMs: number): void {
  const dayStart = localDayStart(settings.dateMs);
  let next = settings.dateMs + deltaMs;
  if (next >= dayStart + MS_PER_DAY) {
    if (settings.loop) {
      // Wrap back into the same displayed local day so the panel and engine
      // agree about the playback boundary.
      next = dayStart + ((next - dayStart) % MS_PER_DAY);
    } else {
      next = dayStart + MS_PER_DAY - 1;
      setSunSettings({ dateMs: next, playing: false });
      return;
    }
  }
  // dateMs-only update; avoid the equality short-circuit churn from setSunSettings
  // by writing directly and pushing to the engine.
  settings = { ...settings, dateMs: next };
  engine?.applySettings(settings);
  notifyState();
}

/**
 * Apply a saved project's sun state: adopt its settings and open or close the
 * panel to match the persisted `open` flag. This is the genuine project-load
 * path (invoked via the plugin's applyProjectState), so it is the one place
 * allowed to change open/closed state from stored data. Returns whether
 * anything changed. See {@link reattachSun} for the map-reinit path.
 */
export function restoreSun(app: GeoLibreAppAPI, state?: unknown): boolean {
  const next = normalizeSunSettings(state, DEFAULT_SUN_SETTINGS);
  const shouldOpen = Boolean(
    state && typeof state === "object" && (state as { open?: unknown }).open,
  );
  let changed = false;
  if (!sunSettingsEqual(next, settings)) {
    settings = next;
    notifyState();
    changed = true;
  }
  const wasVisible = panelVisible;
  if (shouldOpen) openSunPanel(app);
  else closeSunPanel(app);
  return changed || panelVisible !== wasVisible;
}

/**
 * Re-bind the engine to the current map without touching open/closed state.
 * Called after a map re-init or basemap change (which bump the map generation
 * independently of project loads), so it must never reset the panel: a
 * collaborator's unrelated remote edit or a basemap swap should not close a
 * locally-opened Sun panel. The project-load case is handled by
 * {@link restoreSun} via applyProjectState.
 */
export function reattachSun(app: GeoLibreAppAPI): void {
  if (panelVisible) attachEngine(app);
  else detachEngine();
}

export const maplibreSunPlugin: GeoLibrePlugin = {
  id: SUN_PLUGIN_ID,
  name: "Sun Simulation",
  version: "1.0.0",
  activeByDefault: false,
  activate: (app: GeoLibreAppAPI) => openSunPanel(app),
  deactivate: (app: GeoLibreAppAPI) => closeSunPanel(app),
  // Persist the panel-open flag plus settings so a saved project reopens with
  // the same sun state. Nothing is stored while the panel is closed and the
  // settings match defaults.
  getProjectState: () => {
    if (!panelVisible && sunSettingsEqual(settings, DEFAULT_SUN_SETTINGS)) {
      return undefined;
    }
    return { open: panelVisible, ...settings };
  },
  applyProjectState: (app: GeoLibreAppAPI, state: unknown) => restoreSun(app, state),
};
