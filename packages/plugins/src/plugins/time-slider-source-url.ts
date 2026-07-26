import type { CogSourceSpec, MosaicSourceSpec } from "maplibre-gl-time-slider";

/**
 * How to interpret the URL a Time Slider raster source resolves to for a date.
 *
 * This lives in its own leaf module because both the pixel readers
 * (`time-slider-pixel-identify`) and the plugin itself (`maplibre-time-slider`,
 * resolving a source's extent for "Zoom to layer") need the rule, and the
 * plugin cannot import the readers without a cycle. It is the single home for
 * the rule: a second copy would be the one that goes stale.
 */

/** A Time Slider source whose URL resolves to raster data (as opposed to a
 * pre-rendered XYZ/WMS tile or a GeoJSON document). */
export type RasterSourceSpec = CogSourceSpec | MosaicSourceSpec;

/**
 * Matches a URL whose path ends in a GeoTIFF extension, ignoring any query
 * string or fragment.
 */
const GEOTIFF_URL = /\.tiff?($|[?#])/i;

/**
 * Whether a source's resolved URL has to be fetched and parsed as a mosaic
 * manifest rather than opened directly as a COG.
 *
 * `spec.type` alone cannot answer this. `maplibre-gl-time-slider` renders a COG
 * source through its mosaic adapter whenever the engine is `gpu` or `wasm` (the
 * dock's COG form defaults to `gpu`), and the adapter rewrites its own spec to
 * `type: 'mosaic'` — which is what `getSources()` hands back. So a plain
 * single-COG source routinely reports itself as a mosaic while its URL still
 * points at one `.tif`. Deciding on the URL instead keeps both readings correct:
 * a real mosaic resolves to a `.json` manifest, an engine-rewritten COG to a
 * GeoTIFF.
 *
 * Getting this wrong is not merely a failed read: a manifest fetch downloads the
 * whole response body to parse it as JSON, so treating a COG as a manifest would
 * pull the entire GeoTIFF over the wire.
 *
 * @param spec - The source spec, as reported by the control.
 * @param url - The URL the spec resolved to for the date being read.
 * @returns True when the URL should be parsed as a mosaic manifest.
 */
export function usesMosaicManifest(spec: { type?: string }, url: string): boolean {
  return spec.type === "mosaic" && !GEOTIFF_URL.test(url);
}
