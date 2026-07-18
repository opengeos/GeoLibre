import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { createWeatherLayer, type WeatherAnimationState, type WeatherFrame } from "./weather-layer";

/**
 * Realtime clouds overlay — "clouds like Google Earth".
 *
 * Backed by **NASA GIBS VIIRS Corrected Reflectance (true colour)**, a
 * near-realtime daily photographic satellite mosaic (no key, CORS-enabled). It
 * is one of the two Weather overlays (with Precipitation) and shares the
 * store-layer + time-scrub engine in {@link createWeatherLayer}. VIIRS is a
 * once-daily mosaic, so scrubbing plays cloud evolution day by day.
 */

export const CLOUDS_PLUGIN_ID = "maplibre-gl-clouds";

/** Marks the store layer as the one this plugin owns (for adopt-on-restore). */
const CLOUDS_LAYER_FLAG = "cloudsLayer";

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

/** How many complete UTC days the scrubber covers. */
const HISTORY_DAYS = 10;
/** Animation frame interval while playing. */
const FRAME_MS = 900;

function utcDaysAgo(days: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));
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

/**
 * Descriptive metadata shown in the Layers panel's "Layer metadata and source
 * information" view. `date` reflects the frame currently displayed; the rest is
 * static provider/product info so the layer is self-describing.
 */
function cloudsMetadata(date: string): Record<string, unknown> {
  return {
    title: "Realtime Clouds",
    description:
      "Near-real-time global satellite imagery of cloud cover. Play a day-by-day animation from the Controls → Weather → Clouds menu.",
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

const controller = createWeatherLayer({
  layerName: "Clouds",
  layerFlag: CLOUDS_LAYER_FLAG,
  attribution: NASA_ATTRIBUTION,
  serviceUrl: NASA_SERVICE_URL,
  maxzoom: NASA_MAXZOOM,
  opacity: 0.85,
  frameMs: FRAME_MS,
  loadFrames: (): WeatherFrame[] =>
    buildDates().map((date) => ({
      tileUrl: nasaTileUrl(date),
      label: date,
      metadata: cloudsMetadata(date),
    })),
});

export function getCloudsAnimationState(): WeatherAnimationState {
  return controller.getState();
}
export function setCloudsFrame(index: number): void {
  controller.setFrame(index);
}
export function toggleCloudsPlaying(): void {
  controller.togglePlaying();
}
export function subscribeClouds(listener: () => void): () => void {
  return controller.subscribe(listener);
}

export const maplibreCloudsPlugin: GeoLibrePlugin = {
  id: CLOUDS_PLUGIN_ID,
  name: "Clouds",
  version: "0.3.0",
  activate: (app: GeoLibreAppAPI) => controller.activate(app),
  deactivate: () => controller.deactivate(),
};
