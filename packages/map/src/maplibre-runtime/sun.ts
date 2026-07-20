import {
  DEFAULT_SUN_SETTINGS,
  localDayStart,
  normalizeSunSettings,
  SUN_MS_PER_DAY,
  SUN_MS_PER_MINUTE,
  subsolarPoint,
  sunPositionAt,
  type SunSettings,
} from "@geolibre/core";
import type { CanvasSource, LightSpecification, Map as MapLibreMap } from "maplibre-gl";
import type { MapLibreHostedRuntime } from "./types";

const NIGHT_SOURCE_ID = "geolibre-sun-night-source";
const NIGHT_LAYER_ID = "geolibre-sun-night-layer";
const NIGHT_LAYER_PREFIX = "geolibre-sun-night-layer-";
const NIGHT_CANVAS_WIDTH = 960;
const NIGHT_CANVAS_HEIGHT = 480;
const NIGHT_CANVAS_NORTH = 85;
const NIGHT_CANVAS_SOUTH = -85;
const NIGHT_TWILIGHT_DEPTH = 24;
const D2R = Math.PI / 180;
const NIGHT_TWILIGHT_SIN_DEPTH = Math.sin(NIGHT_TWILIGHT_DEPTH * D2R);
const MASK_LNG_EPSILON = 0.25;
const NIGHT_RGB = { r: 10, g: 16, b: 32 };

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

function advanceSunSettings(settings: SunSettings, deltaMs: number): SunSettings {
  const dayStart = localDayStart(settings.dateMs);
  let dateMs = settings.dateMs + deltaMs;
  let playing = settings.playing;
  if (dateMs >= dayStart + SUN_MS_PER_DAY) {
    if (settings.loop) {
      dateMs = dayStart + ((dateMs - dayStart) % SUN_MS_PER_DAY);
    } else {
      dateMs = dayStart + SUN_MS_PER_DAY - 1;
      playing = false;
    }
  }
  return { ...settings, dateMs, playing };
}

/** MapLibre-only canvas/light renderer for the renderer-neutral Sun descriptor. */
class MapLibreSunRenderer {
  private settings: SunSettings;
  private onSettingsChange: (settings: SunSettings) => void;
  private readonly previousLight: LightSpecification | undefined;
  private readonly nightCanvas: HTMLCanvasElement;
  private readonly nightContext: CanvasRenderingContext2D | null;
  private nightImageData: ImageData | null = null;
  private maskDrawn = false;
  private lastMaskLng = 0;
  private lastMaskLat = 0;
  private lastMaskShade = -1;
  private rafId: number | null = null;
  private lastFrame: number | null = null;
  private destroyed = false;

  constructor(
    private readonly map: MapLibreMap,
    settings: SunSettings,
    onSettingsChange: (settings: SunSettings) => void,
  ) {
    this.settings = settings;
    this.onSettingsChange = onSettingsChange;
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
    this.nightContext = this.nightCanvas.getContext("2d", { willReadFrequently: true });

    this.handleStyleData = this.handleStyleData.bind(this);
    this.tick = this.tick.bind(this);
    map.on("styledata", this.handleStyleData);
    this.ensureLayers();
    this.render();
    if (settings.playing) this.play();
  }

  isForMap(map: MapLibreMap): boolean {
    return this.map === map;
  }

  setOnSettingsChange(onSettingsChange: (settings: SunSettings) => void): void {
    this.onSettingsChange = onSettingsChange;
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
    try {
      if (this.previousLight) this.map.setLight(this.previousLight);
    } catch {
      // The style may already be tearing down; there is nothing to restore.
    }
  }

  private handleStyleData(): void {
    if (this.destroyed) return;
    if (!this.map.getSource(NIGHT_SOURCE_ID)) {
      this.ensureLayers();
      this.render();
    }
  }

  private ensureLayers(): void {
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
    if (this.map.getSource(NIGHT_SOURCE_ID)) this.map.removeSource(NIGHT_SOURCE_ID);
  }

  private removeLegacyBandLayers(): void {
    for (let index = 0; index < 128; index += 1) {
      const layerId = `${NIGHT_LAYER_PREFIX}${index}`;
      if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    }
  }

  private render(): void {
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

  private applyLight(): void {
    let center: { lat: number; lng: number };
    try {
      center = this.map.getCenter();
    } catch {
      return;
    }
    const { altitude, azimuth } = sunPositionAt(this.settings.dateMs, center.lat, center.lng);
    const polar = Math.min(90, Math.max(0, 90 - altitude));
    const daylight = Math.max(0, Math.sin(altitude * D2R));
    const intensity = 0.2 + 0.6 * daylight;
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
      // Older styles with no light support still show the night overlay.
    }
  }

  private play(): void {
    if (this.destroyed || this.rafId !== null) return;
    this.lastFrame = null;
    this.rafId = window.requestAnimationFrame(this.tick);
  }

  private pause(): void {
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
      const next = advanceSunSettings(
        this.settings,
        elapsedSec * this.settings.speed * SUN_MS_PER_MINUTE,
      );
      this.applySettings(next);
      this.onSettingsChange(next);
    }
    this.lastFrame = now;
    this.rafId = window.requestAnimationFrame(this.tick);
  }
}

let renderer: MapLibreSunRenderer | null = null;
let settings: SunSettings = { ...DEFAULT_SUN_SETTINGS };
let onStateChange: ((state: unknown) => void) | null = null;

function applySettings(next: SunSettings, publish = true): void {
  settings = next;
  renderer?.applySettings(next);
  if (publish) onStateChange?.(next);
}

/** Adapter-private lazy runtime for the renderer-neutral Sun Simulation plugin. */
export const maplibreSunRuntime: MapLibreHostedRuntime = {
  activate: (context, { state, onStateChange: nextOnStateChange }) => {
    if (!context.map) return false;
    if (state !== undefined) settings = normalizeSunSettings(state, DEFAULT_SUN_SETTINGS);
    onStateChange = nextOnStateChange ?? null;
    if (renderer && !renderer.isForMap(context.map)) {
      renderer.destroy();
      renderer = null;
    }
    if (!renderer) {
      renderer = new MapLibreSunRenderer(context.map, settings, (next) => applySettings(next));
    } else {
      renderer.setOnSettingsChange((next) => applySettings(next));
      renderer.applySettings(settings);
    }
    return true;
  },
  deactivate: () => {
    renderer?.destroy();
    renderer = null;
    onStateChange = null;
  },
  getState: () => settings,
  applyState: (_context, state) => {
    applySettings(normalizeSunSettings(state, DEFAULT_SUN_SETTINGS));
    return true;
  },
};
