import type { GeoTiffInfo } from "@geolibre/processing";

/**
 * Hard ceiling for the browser GeoTIFF-to-COG converter.
 *
 * Conversion currently decodes every sample to Float64, creates a second
 * typed pixel buffer, and then allocates the encoded COG. Past this point the
 * transient working set approaches a gigabyte even for byte rasters, which is
 * unreliable in browser and desktop webviews. Large rasters that are already
 * COGs never enter this path and remain unrestricted.
 */
export const MAX_BROWSER_COG_CONVERSION_SAMPLES = 100_000_000;

/** Sample count above which conversion requires an extra memory warning. */
export const LARGE_BROWSER_COG_CONVERSION_SAMPLES = 40_000_000;

/** Return the decoded sample count used by the conversion memory guard. */
export function geoTiffSampleCount(info: Pick<GeoTiffInfo, "width" | "height" | "bands">): number {
  return info.width * info.height * Math.max(info.bands, 1);
}

/** Whether a decoded sample count exceeds the safe conversion memory cap. */
export function exceedsBrowserCogConversionLimit(samples: number): boolean {
  return !Number.isSafeInteger(samples) || samples > MAX_BROWSER_COG_CONVERSION_SAMPLES;
}
