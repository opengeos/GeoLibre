import { interpolateColors, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  colormapColors,
  composeColormappedImage,
  warmColormapColors,
  type LocalNetcdfGrid,
  type LocalNetcdfImage,
  type LocalNetcdfProfile,
} from "@geolibre/plugins";

export { NETCDF_IMAGE_SOURCE_KIND } from "@geolibre/core";
// Re-exported so callers reach one module for everything about these layers.
export { gridPixelAt, type GridPixel } from "@geolibre/plugins";

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

/** Everything retained in memory for one baked NetCDF layer. */
export interface NetcdfLayerState {
  /** The displayed slice: backs both re-colormapping and pixel identify. */
  grid: LocalNetcdfGrid;
  /** The variable the layer was built from, for labelling readouts. */
  variable: string;
  /** The variable's CF `units`, when it declares any. */
  units?: string;
  /**
   * Present only for a layer built from a cube. Reading a spectral signature
   * needs the whole band axis at one pixel, which only the source file has, so
   * the file stays open for as long as the layer does.
   *
   * A function rather than the file itself, because the two sources answer
   * differently: a local file reads synchronously in place, a remote one round
   * trips to the worker that owns its range-request mount.
   */
  profile?: {
    /** Read one pixel's values along the layer's profile axis. */
    read: (row: number, column: number) => Promise<LocalNetcdfProfile>;
    /** Release the underlying file or worker. */
    close: () => void;
  };
}

const states = new Map<string, NetcdfLayerState>();
let unsubscribe: (() => void) | null = null;
/** The layer array the pruner last saw, so unrelated store writes cost nothing. */
let lastLayers: unknown = null;

/**
 * Remember what a baked NetCDF layer was made from, so its symbology stays
 * editable and its pixels stay readable, and start releasing entries whose
 * layer is gone.
 *
 * An open file is large (a hyperspectral cube runs to ~1 GB in the WebAssembly
 * heap), and the address space is 4 GB, so **only one** file is retained: adding
 * a second cube closes the first, which loses only its spectral profiles. Every
 * layer keeps its own grid, which is far smaller.
 *
 * @param layerId - The image layer's id.
 * @param state - The decoded slice, and the open file when it came from a cube.
 */
export function registerNetcdfLayer(layerId: string, state: NetcdfLayerState): void {
  if (state.profile) {
    for (const [id, existing] of states) {
      if (id !== layerId && existing.profile) {
        existing.profile.close();
        states.set(id, { ...existing, profile: undefined });
      }
    }
  }
  states.set(layerId, state);
  // A removed layer would otherwise strand its grid, and its file, for the rest
  // of the session. One subscription serves every registration.
  unsubscribe ??= useAppStore.subscribe((current) => {
    // Every store write lands here, including the pointer coordinates the map
    // writes on each mouse move, so do nothing until the layer array itself is
    // replaced. Without this guard a registered grid costs a Set of every layer
    // id per mouse move.
    if (current.layers === lastLayers) return;
    lastLayers = current.layers;
    if (states.size === 0) return;
    const live = new Set(current.layers.map((layer) => layer.id));
    for (const id of states.keys()) {
      if (!live.has(id)) releaseNetcdfLayer(id);
    }
    // Nothing left to prune: stop listening entirely rather than waking on
    // every layer edit for the rest of the session. The next register
    // re-subscribes, because `unsubscribe` is cleared here.
    if (states.size === 0) {
      unsubscribe?.();
      unsubscribe = null;
    }
  });
}

/**
 * What a baked NetCDF layer was made from, or null when this layer is not one
 * (or its state was lost with a project reload).
 *
 * @param layerId - The layer's id.
 * @returns The retained state, or null.
 */
export function getNetcdfLayerState(layerId: string): NetcdfLayerState | null {
  return states.get(layerId) ?? null;
}

/** The displayed slice for a layer, or null. */
export function getNetcdfImageSource(layerId: string): NetcdfImageSource | null {
  return states.get(layerId)?.grid ?? null;
}

/** Drop a layer's retained grid and close its file, if it had one. */
export function releaseNetcdfLayer(layerId: string): void {
  states.get(layerId)?.profile?.close();
  states.delete(layerId);
}

/**
 * Read one pixel's values along the layer's profile axis.
 *
 * @param layerId - The layer's id.
 * @param row - Row into the grid's y extent.
 * @param column - Column into the grid's x extent.
 * @returns The profile, or null when this layer has no retained file or the
 *   read failed.
 */
export async function readNetcdfProfile(
  layerId: string,
  row: number,
  column: number,
): Promise<LocalNetcdfProfile | null> {
  const state = states.get(layerId);
  if (!state?.profile) return null;
  try {
    return await state.profile.read(row, column);
  } catch {
    // A profile is an extra on top of the pixel readout, and the caller reads it
    // outside the click handler; a failed read must degrade to "no chart", not
    // surface as an unhandled rejection on every click.
    return null;
  }
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
