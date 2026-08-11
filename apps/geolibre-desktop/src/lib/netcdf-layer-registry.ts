import { useAppStore } from "@geolibre/core";
import type {
  LocalNetcdfAxis,
  LocalNetcdfGrid,
  LocalNetcdfProfile,
  LocalNetcdfWindow,
} from "@geolibre/plugins/local-netcdf";

import { closeNetcdfCubeForLayer } from "./netcdf-cube-store";

/**
 * What every baked NetCDF layer keeps in memory: its decoded slices, and the
 * open file behind a cube.
 *
 * Its own module, reachable without `netcdf-image-symbology` — that one pulls in
 * the plugin barrel for the colormapper, which drags a browser-only dependency
 * graph behind it. Everything here is plain state, so keeping it separate is
 * what lets it be exercised outside a browser.
 */

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
  /**
   * The displayed slice: backs both re-colormapping and pixel identify.
   *
   * For an RGB composite this is the red channel — the three share one geometry,
   * and every consumer that reads this field (identify's cell lookup, the cube
   * view's window) wants the geometry rather than the values.
   */
  grid: LocalNetcdfGrid;
  /** The variable the layer was built from, for labelling readouts. */
  variable: string;
  /** The variable's CF `units`, when it declares any. */
  units?: string;
  /**
   * Present only for a layer built from a cube. Reading a spectral signature
   * needs the whole band axis at one pixel, and the 3-D cube view needs many
   * band planes; only the source file has either, so it stays open for as long
   * as the layer does.
   *
   * Functions rather than the file itself, because the two sources answer
   * differently: a local file reads synchronously in place, a remote one round
   * trips to the worker that owns its range-request mount.
   */
  cube?: {
    /** The leading axis the bands run along, with its coordinate values. */
    axis: LocalNetcdfAxis;
    /** Read one pixel's values along {@link axis}. */
    readProfile: (row: number, column: number) => Promise<LocalNetcdfProfile>;
    /** Read one band's plane, optionally windowed and decimated. */
    readBand: (bandIndex: number, window?: LocalNetcdfWindow) => Promise<LocalNetcdfGrid>;
    /** Release the underlying file or worker. */
    close: () => void;
  };
  /**
   * Present only for a layer drawn as an RGB composite: the three slices its
   * pixels were composed from, so a click can report all three readings at once
   * instead of the one channel {@link grid} happens to be.
   *
   * Its presence is also what tells the Style panel there is no colormap to
   * edit — re-baking a composite with one would replace it with a single-band
   * image. See {@link getNetcdfImageSource}.
   */
  rgb?: {
    /** Indices into {@link cube}'s axis, red first. */
    bands: [number, number, number];
    /** The channel slices, in the same order as {@link bands}. */
    channels: [LocalNetcdfGrid, LocalNetcdfGrid, LocalNetcdfGrid];
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
 * layer keeps its own grids, which are far smaller.
 *
 * @param layerId - The image layer's id.
 * @param state - The decoded slices, and the open file when it came from a cube.
 */
export function registerNetcdfLayer(layerId: string, state: NetcdfLayerState): void {
  if (state.cube) {
    for (const [id, existing] of states) {
      if (id !== layerId && existing.cube) {
        existing.cube.close();
        states.set(id, { ...existing, cube: undefined });
        // The window renders from that file; leaving it open would strand a
        // frame whose "reload" can no longer read anything.
        closeNetcdfCubeForLayer(id);
      }
    }
  }
  states.set(layerId, state);
  // A removed layer would otherwise strand its grids, and its file, for the rest
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

/**
 * The slice a layer's symbology can be re-applied to, or null.
 *
 * Null for an RGB composite even though it retains its grids: its pixels come
 * from three channels, and re-baking any one of them with a colormap would
 * silently replace the composite with a single-band image. Callers asking
 * "is anything retained for this layer?" — identify, the spectral profile —
 * want {@link getNetcdfLayerState} instead.
 *
 * @param layerId - The layer's id.
 * @returns The slice, or null.
 */
export function getNetcdfImageSource(layerId: string): NetcdfImageSource | null {
  const state = states.get(layerId);
  return state && !state.rgb ? state.grid : null;
}

/** Drop a layer's retained grids and close its file, if it had one. */
export function releaseNetcdfLayer(layerId: string): void {
  states.get(layerId)?.cube?.close();
  states.delete(layerId);
  closeNetcdfCubeForLayer(layerId);
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
  if (!state?.cube) return null;
  try {
    return await state.cube.readProfile(row, column);
  } catch {
    // A profile is an extra on top of the pixel readout, and the caller reads it
    // outside the click handler; a failed read must degrade to "no chart", not
    // surface as an unhandled rejection on every click.
    return null;
  }
}
