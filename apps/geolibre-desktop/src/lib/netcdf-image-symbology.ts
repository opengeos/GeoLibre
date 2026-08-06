import { interpolateColors, parseHexColor, type GeoLibreLayer } from "@geolibre/core";
import {
  colormapColors,
  composeColormappedImage,
  warmColormapColors,
  type LocalNetcdfImage,
} from "@geolibre/plugins";
import type { NetcdfImageSource } from "./netcdf-layer-registry";

export { NETCDF_IMAGE_SOURCE_KIND } from "@geolibre/core";
// Re-exported so callers reach one module for everything about these layers.
export { gridPixelAt, gridValueAt, type GridPixel } from "@geolibre/plugins";
// The retained grids live in their own module, which stays clear of the plugin
// barrel this one needs for the colormapper; re-exported here so a caller that
// wants both still reaches for one import.
export {
  getNetcdfImageSource,
  getNetcdfLayerState,
  readNetcdfProfile,
  registerNetcdfLayer,
  releaseNetcdfLayer,
  type NetcdfLayerState,
} from "./netcdf-layer-registry";
export type { NetcdfImageSource };

/** Ramp stops resampled for the CPU colormapper (8-bit lookup depth). */
export const COLORMAP_STOPS = 256;

/** The symbology a baked NetCDF image is currently drawn with. */
export interface NetcdfImageSymbology {
  /** Colormap name from the shared catalogue. */
  colormap: string;
  /** Whether the ramp is applied high-to-low. */
  reversed: boolean;
  /** Color limits. */
  clim: [number, number];
}

/**
 * Read a layer's stored NetCDF symbology, falling back to the defaults it was
 * created with.
 *
 * @param layer - The image layer.
 * @param fallbackClim - The range to assume when the layer records none.
 * @returns The symbology to show in the panel.
 */
export function netcdfImageSymbology(
  layer: GeoLibreLayer,
  fallbackClim: [number, number],
): NetcdfImageSymbology {
  const stored = layer.metadata.netcdfSymbology;
  const record =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const clim = Array.isArray(record.clim) && record.clim.length === 2 ? record.clim : null;
  return {
    colormap: typeof record.colormap === "string" ? record.colormap : "viridis",
    reversed: record.reversed === true,
    clim:
      clim && clim.every((value) => typeof value === "number" && Number.isFinite(value))
        ? ([clim[0], clim[1]] as [number, number])
        : fallbackClim,
  };
}

/**
 * Sample a colormap into the shared cache, so a following {@link bakeNetcdfImage}
 * paints the chosen ramp instead of {@link rampStops}' viridis fallback.
 *
 * Only the ~100 sprite-sampled matplotlib ramps need this; GeoLibre's own curated
 * ramps resolve synchronously and this returns immediately for them. Baking is a
 * one-shot write of pixels into a PNG data URL with nothing that re-runs when a
 * sample lands later, so an unwarmed ramp would otherwise persist as a permanent
 * mismatch: the panel showing the picked name over viridis pixels.
 *
 * Failure is not an error — a ramp that cannot be sampled (headless, unknown
 * name) still bakes on the fallback, which is better than refusing the layer.
 *
 * @param name - The colormap name.
 */
export async function warmNetcdfColormap(name: string): Promise<void> {
  await warmColormapColors(name);
}

/**
 * A colormap's anchor colors resampled to {@link COLORMAP_STOPS}.
 *
 * Sprite colormaps only resolve once the shared catalogue has warmed them; an
 * unwarmed one falls back to viridis rather than painting the grid flat black,
 * which is what an empty ramp would do. Callers that can await should go through
 * {@link warmNetcdfColormap} first so that fallback stays unreachable.
 *
 * @param name - The colormap name.
 * @param reversed - Whether to apply the ramp high-to-low.
 * @returns `COLORMAP_STOPS` hex colors, low to high.
 */
export function rampStops(name: string, reversed = false): string[] {
  const anchors = colormapColors(name) ?? colormapColors("viridis") ?? ["#000000", "#ffffff"];
  const ordered = reversed ? [...anchors].reverse() : anchors;
  return interpolateColors(ordered, COLORMAP_STOPS);
}

/**
 * {@link rampStops} as `[r, g, b]` triples.
 *
 * What a consumer painting pixels itself wants: the 3-D cube view looks a color
 * up per texel across six faces, and re-parsing the same hex string hundreds of
 * thousands of times is pure waste.
 *
 * @param name - The colormap name.
 * @param reversed - Whether to apply the ramp high-to-low.
 * @returns `COLORMAP_STOPS` triples, low to high, each channel 0-255.
 */
export function rampRgb(name: string, reversed = false): Array<[number, number, number]> {
  return rampStops(name, reversed).map((hex) => {
    const { r, g, b } = parseHexColor(hex);
    return [r, g, b] as [number, number, number];
  });
}

/**
 * Re-bake a registered NetCDF grid with new symbology.
 *
 * @param source - The retained slice.
 * @param symbology - The colormap, direction, and limits to draw with.
 * @returns The composed image, ready to encode.
 */
export function bakeNetcdfImage(
  source: NetcdfImageSource,
  symbology: NetcdfImageSymbology,
): LocalNetcdfImage {
  return composeColormappedImage({
    ny: source.ny,
    nx: source.nx,
    values: source.values,
    lat: source.lat,
    lon: source.lon,
    colors: rampStops(symbology.colormap, symbology.reversed),
    fillValue: source.fillValue,
    scaleFactor: source.scaleFactor,
    addOffset: source.addOffset,
    clim: symbology.clim,
  });
}

/**
 * Encode a composed grid as a PNG data URL for a MapLibre `image` source.
 *
 * A data URL rather than a blob URL so the layer survives a project save and
 * reload: a blob URL is scoped to the document that created it, and a composed
 * image has no file on disk to re-read.
 *
 * @param image - The composed image.
 * @returns A `data:image/png;base64,...` URL.
 * @throws If a 2-D canvas context cannot be created.
 */
export function encodeImageOverlay(image: LocalNetcdfImage): string {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a 2-D canvas for the NetCDF image.");
  context.putImageData(new ImageData(image.pixels, image.width, image.height), 0, 0);
  return canvas.toDataURL("image/png");
}

// Lives in its own dependency-free module so the profile CSV builder can reach
// it without importing this one, which pulls in the plugin barrel.
export { displayUnits } from "./cf-units";
