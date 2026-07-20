import type {
  BandOption,
  LabeledPixelTimeSeries,
  PixelSeries,
  PixelSeriesPoint,
  PixelTimeSeriesOptions,
  PixelTimeSeriesRequest,
  PixelTimeSeriesResult,
} from "@geolibre/core";
import type { MapEngineClient } from "@geolibre/map";
import { getTimeSliderProjectState } from "./maplibre-time-slider";

export {
  bandOptionsFromResults,
  downsampleSteps,
  seriesToFeatureCollection,
  valueAtBand,
} from "@geolibre/core";
export type {
  BandOption,
  LabeledPixelTimeSeries,
  PixelSeries,
  PixelSeriesPoint,
  PixelTimeSeriesOptions,
  PixelTimeSeriesRequest,
  PixelTimeSeriesResult,
} from "@geolibre/core";

/** Whether the active Time Slider state contains at least one COG source. */
export function hasTimeSliderRasterStack(): boolean {
  const config = getTimeSliderProjectState() as { sources?: unknown } | undefined;
  return (
    Array.isArray(config?.sources) &&
    config.sources.some(
      (source) =>
        !!source && typeof source === "object" && (source as { type?: unknown }).type === "cog",
    )
  );
}

/**
 * Query the active renderer's Time Slider raster stack through the typed engine
 * seam. The adapter owns URL expansion and COG range reads.
 */
export function queryPixelTimeSeries(
  map: MapEngineClient,
  lngLat: [number, number],
  options: PixelTimeSeriesOptions = {},
): Promise<PixelTimeSeriesResult> {
  const request: PixelTimeSeriesRequest = { lngLat, options };
  return map.invoke("time-slider.query-pixel-series", request);
}
