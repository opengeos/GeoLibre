import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { createWeatherLayer, type WeatherAnimationState, type WeatherFrame } from "./weather-layer";

/**
 * Realtime precipitation (weather radar) overlay.
 *
 * Backed by **RainViewer**'s public weather-maps API (no key, CORS-enabled),
 * which returns a global radar composite as a series of timestamped frames over
 * roughly the past two hours at ~10-minute steps. It is one of the two Weather
 * overlays (with Clouds) and shares the store-layer + time-scrub engine in
 * {@link createWeatherLayer}, so scrubbing/playing animates the radar loop.
 */

export const PRECIPITATION_PLUGIN_ID = "maplibre-gl-precipitation";

/** Marks the store layer as the one this plugin owns (for adopt-on-restore). */
const PRECIPITATION_LAYER_FLAG = "precipitationLayer";

/** RainViewer weather-maps metadata endpoint (radar + satellite frame index). */
const RAINVIEWER_API = "https://api.rainviewer.com/public/weather-maps.json";
const RAINVIEWER_ATTRIBUTION =
  'Radar &copy; <a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>';
const RAINVIEWER_SERVICE_URL = "https://www.rainviewer.com/";
/**
 * 512-px tiles cover the viewport with ~4× fewer tiles than 256-px, and the
 * z6 cap (MapLibre overzooms above it) means zooming in reuses cached tiles
 * instead of fetching new ones. Together they keep the animated radar source
 * well under RainViewer's public rate limit — the earlier defaults flooded it
 * and requests started failing ("Failed to fetch") while zooming/playing.
 */
const RAINVIEWER_TILE_SIZE = 512;
const RAINVIEWER_MAXZOOM = 6;
/** Colour scheme (4 = "Weather Channel") and options (`{smooth}_{snow}`). */
const RADAR_COLOR = 4;
const RADAR_OPTIONS = "1_1";
/** Gentler cadence so tile loads for one frame settle before the next swap. */
const FRAME_MS = 1000;

interface RainViewerFrame {
  time: number;
  path: string;
}
interface RainViewerResponse {
  host?: string;
  radar?: { past?: RainViewerFrame[]; nowcast?: RainViewerFrame[] };
}

/** Local `HH:MM` label for a RainViewer unix-second timestamp. */
function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Descriptive metadata shown in the Layers panel's metadata view. `time` /
 * `timestamp` reflect the frame currently displayed.
 */
function precipitationMetadata(unixSeconds: number, label: string): Record<string, unknown> {
  return {
    title: "Precipitation (weather radar)",
    description:
      "Near-real-time global radar composite of precipitation. Play a radar loop from the Controls → Weather → Precipitation menu.",
    provider: "RainViewer",
    product: "Global radar composite",
    time: label,
    timestamp: new Date(unixSeconds * 1000).toISOString(),
    updateFrequency: "~10 minutes (last ~2 hours)",
    coverage: "Global",
    attribution: "RainViewer",
    license: "Free public API — attribution required",
    documentation: "https://www.rainviewer.com/api.html",
  };
}

/**
 * Whether `host` is an `https://` URL whose authority is a rainviewer.com host.
 * Parsed via `URL` (not a regex) so the userinfo trick
 * (`https://tilecache.rainviewer.com@evil.example/x`, whose real host is
 * `evil.example`) is rejected. Defense-in-depth: the API response is untrusted
 * and the Tauri CSP has no per-host tile allowlist, and `host` is spliced
 * straight into the tile URL.
 */
function isTrustedRainviewerHost(host: string): boolean {
  try {
    const url = new URL(host);
    return (
      url.protocol === "https:" &&
      (url.hostname === "rainviewer.com" || url.hostname.endsWith(".rainviewer.com"))
    );
  } catch {
    return false;
  }
}

/**
 * Turn a parsed RainViewer weather-maps response into {@link WeatherFrame}s.
 * A missing/untrusted `host` (see {@link isTrustedRainviewerHost}) or no frames
 * yields an empty list. Exported for unit testing.
 */
export function radarFramesFromResponse(data: RainViewerResponse): WeatherFrame[] {
  const host = typeof data.host === "string" && isTrustedRainviewerHost(data.host) ? data.host : "";
  const past = Array.isArray(data.radar?.past) ? data.radar.past : [];
  if (!host || past.length === 0) return [];
  return (
    past
      .filter(
        (f): f is RainViewerFrame =>
          !!f && typeof f.path === "string" && typeof f.time === "number",
      )
      // `path` is also untrusted: validate the combined `host + path` still
      // resolves to a rainviewer.com host, so a crafted path (e.g. "@evil.example/…"
      // making the validated host the userinfo) can't redirect tile requests.
      .filter((f) => isTrustedRainviewerHost(`${host}${f.path}`))
      // Sort oldest → newest so the engine's "newest = last" contract holds even
      // if the API ever returns `past` out of order (it's currently ordered).
      .sort((a, b) => a.time - b.time)
      .map((f) => {
        const label = formatTime(f.time);
        return {
          tileUrl: `${host}${f.path}/${RAINVIEWER_TILE_SIZE}/{z}/{x}/{y}/${RADAR_COLOR}/${RADAR_OPTIONS}.png`,
          label,
          metadata: precipitationMetadata(f.time, label),
        };
      })
  );
}

/**
 * Fetch RainViewer's radar frames. Returns an empty list on any failure so
 * activation fails cleanly (the toggle rolls back) rather than adding a layer
 * that renders nothing. A timeout guards against a hung endpoint leaving the
 * toggle stuck optimistically "on" with no layer ever added.
 */
async function loadRadarFrames(): Promise<WeatherFrame[]> {
  try {
    const response = await fetch(RAINVIEWER_API, {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return [];
    return radarFramesFromResponse((await response.json()) as RainViewerResponse);
  } catch {
    return [];
  }
}

const controller = createWeatherLayer({
  layerName: "Precipitation",
  layerFlag: PRECIPITATION_LAYER_FLAG,
  attribution: RAINVIEWER_ATTRIBUTION,
  serviceUrl: RAINVIEWER_SERVICE_URL,
  maxzoom: RAINVIEWER_MAXZOOM,
  tileSize: RAINVIEWER_TILE_SIZE,
  opacity: 0.8,
  frameMs: FRAME_MS,
  loadFrames: loadRadarFrames,
});

export function getPrecipitationAnimationState(): WeatherAnimationState {
  return controller.getState();
}
export function setPrecipitationFrame(index: number): void {
  controller.setFrame(index);
}
export function togglePrecipitationPlaying(): void {
  controller.togglePlaying();
}
export function subscribePrecipitation(listener: () => void): () => void {
  return controller.subscribe(listener);
}

export const maplibrePrecipitationPlugin: GeoLibrePlugin = {
  id: PRECIPITATION_PLUGIN_ID,
  name: "Precipitation",
  version: "0.1.0",
  activate: (app: GeoLibreAppAPI) => controller.activate(app),
  deactivate: () => controller.deactivate(),
};
