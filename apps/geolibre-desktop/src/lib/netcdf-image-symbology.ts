import { interpolateColors, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  colormapColors,
  composeColormappedImage,
  type LocalNetcdfGrid,
  type LocalNetcdfImage,
} from "@geolibre/plugins";

/**
 * Marks a layer as a NetCDF grid baked into an `image` overlay, as opposed to
 * the KML ground overlays that otherwise use that layer type. The Style panel
 * gates its NetCDF symbology section on this.
 */
export const NETCDF_IMAGE_SOURCE_KIND = "netcdf-image";

/** Ramp stops resampled for the CPU colormapper (8-bit lookup depth). */
export const COLORMAP_STOPS = 256;

/**
 * The decoded slice behind one baked NetCDF image, kept so the Style panel can
 * re-colormap it without re-reading the file.
 *
 * Held in memory rather than in the project, because the values are large (tens
 * of MB for a satellite scene) and a browser cannot silently re-open the source
 * file after a reload. A reloaded project therefore keeps its baked pixels and
 * simply loses the live controls, which the section handles by hiding itself.
 */
export type NetcdfImageSource = LocalNetcdfGrid;

const sources = new Map<string, NetcdfImageSource>();
let unsubscribe: (() => void) | null = null;

/**
 * Remember the values behind a baked NetCDF image so its symbology stays
 * editable, and start pruning entries whose layer is gone.
 *
 * @param layerId - The image layer's id.
 * @param source - The decoded slice and its coordinates.
 */
export function registerNetcdfImageSource(layerId: string, source: NetcdfImageSource): void {
  sources.set(layerId, source);
  // A removed layer would otherwise strand its grid (tens of MB) for the rest of
  // the session. One subscription serves every registration.
  unsubscribe ??= useAppStore.subscribe((state) => {
    if (sources.size === 0) return;
    const live = new Set(state.layers.map((layer) => layer.id));
    for (const id of sources.keys()) {
      if (!live.has(id)) sources.delete(id);
    }
  });
}

/**
 * The values behind a baked NetCDF image, or null when this layer is not one
 * (or its values were lost with a project reload).
 *
 * @param layerId - The layer's id.
 * @returns The registered slice, or null.
 */
export function getNetcdfImageSource(layerId: string): NetcdfImageSource | null {
  return sources.get(layerId) ?? null;
}

/** Drop a layer's retained grid, e.g. when its symbology is no longer editable. */
export function unregisterNetcdfImageSource(layerId: string): void {
  sources.delete(layerId);
}

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
 * A colormap's anchor colors resampled to {@link COLORMAP_STOPS}.
 *
 * Sprite colormaps only resolve once the shared catalogue has warmed them; an
 * unwarmed one falls back to viridis rather than painting the grid flat black,
 * which is what an empty ramp would do.
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
