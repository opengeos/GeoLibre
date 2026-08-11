import { DEFAULT_CUBE_BANDS, DEFAULT_CUBE_SIZE, MAX_CUBE_BANDS } from "./netcdf-cube";

/**
 * Which NetCDF layer has its 3-D cube open, how it should be read, and whether
 * the user is still choosing.
 *
 * A store rather than shell state because the three parts sit in different
 * subtrees: the opener (the Style panel's NetCDF symbology section), the setup
 * dialog (the shell), and the cube window (mounted over the map, so it is
 * positioned against the map rather than the shell). One layer at a time: the
 * window holds a decoded cube, which is tens of megabytes.
 *
 * Reading is deliberately gated behind {@link NetcdfCubePhase} `setup`. A cube
 * read is tens of seconds, so it must be something the user asks for with the
 * settings they want, not something that starts the moment a window opens and
 * then has to be redone.
 */

/** Where the cube's spatial extent comes from. */
export type CubeExtentMode =
  /** Whatever the map is showing when the read starts. */
  | "view"
  /** A rectangle the user dragged on the map. */
  | "draw"
  /** The layer's whole grid (slow for a scene-sized cube). */
  | "full";

/** How to read a cube: everything the setup dialog collects. */
export interface NetcdfCubeSettings {
  /** Where the spatial extent comes from. */
  extent: CubeExtentMode;
  /** The drawn rectangle `[west, south, east, north]`, for `extent: "draw"`. */
  bbox: [number, number, number, number] | null;
  /** Longest edge, in cells, the window is decimated to. */
  maxSize: number;
  /** Band planes to read; the axis is strided evenly to fit. */
  maxBands: number;
  /** Band indices for the top-face RGB overlay, or null for no overlay. */
  rgbBands: [number, number, number] | null;
}

/** Whether the user is still choosing settings, or the cube is being shown. */
export type NetcdfCubePhase = "setup" | "cube";

/** The whole store, handed to `useSyncExternalStore` as one frozen snapshot. */
export interface NetcdfCubeState {
  /** The layer the cube belongs to, or null when nothing is open. */
  layerId: string | null;
  phase: NetcdfCubePhase;
  settings: NetcdfCubeSettings;
  /**
   * Bumped only when a read is actually asked for.
   *
   * The window watches this rather than the phase, so returning from the
   * settings dialog without changing anything keeps the cube already in memory
   * instead of spending another half-minute rebuilding it.
   */
  readToken: number;
  /** Whether this layer has a cube to go back to; false before the first read. */
  started: boolean;
}

const CLOSED: NetcdfCubeState = Object.freeze({
  layerId: null,
  phase: "setup" as const,
  settings: Object.freeze({
    extent: "view" as const,
    bbox: null,
    maxSize: DEFAULT_CUBE_SIZE,
    maxBands: DEFAULT_CUBE_BANDS,
    rgbBands: null,
  }),
  readToken: 0,
  started: false,
});

let state: NetcdfCubeState = CLOSED;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Open the setup dialog for a layer, seeded with the last settings used.
 *
 * Carrying the settings over matters for the common loop of reading a cube,
 * moving the map, and reading again: only the extent has changed, and re-picking
 * the band count and overlay every time would be the whole cost of the dialog
 * with none of its benefit.
 *
 * @param layerId - The NetCDF image layer to build a cube from.
 * @param settings - Overrides for the remembered settings.
 */
export function openNetcdfCubeSetup(
  layerId: string,
  settings: Partial<NetcdfCubeSettings> = {},
): void {
  const sameLayer = state.layerId === layerId;
  state = {
    ...state,
    layerId,
    phase: "setup",
    // From the *current* settings, not the defaults, unless the caller says
    // otherwise: reopening the dialog should show what was read last.
    settings: { ...state.settings, ...settings },
    // A different layer has had no read of its own, so it starts at zero. This
    // is what stops the window inheriting the previous layer's token and firing
    // an expensive read on the new layer the moment the dialog opens, using
    // settings (an extent, a drawn bbox) chosen for a different scene.
    readToken: sameLayer ? state.readToken : 0,
    // And with no read there is no cube, so cancelling has nowhere to go back to.
    started: sameLayer && state.started,
  };
  emit();
}

/**
 * Accept the settings and read the cube.
 *
 * @param settings - What the dialog collected.
 */
export function startNetcdfCube(settings: NetcdfCubeSettings): void {
  if (!state.layerId) return;
  state = {
    ...state,
    phase: "cube",
    settings,
    readToken: state.readToken + 1,
    started: true,
  };
  emit();
}

/** Reopen the settings dialog over the cube already showing. */
export function reopenNetcdfCubeSetup(): void {
  if (!state.layerId || state.phase === "setup") return;
  state = { ...state, phase: "setup" };
  emit();
}

/**
 * Go back to the cube without reading again.
 *
 * What cancelling the *reopened* settings dialog does: the cube is still in
 * memory, and discarding it because the user changed their mind about editing
 * the settings would be the most expensive possible way to say "never mind".
 */
export function resumeNetcdfCube(): void {
  if (!state.layerId || !state.started) {
    closeNetcdfCube();
    return;
  }
  state = { ...state, phase: "cube" };
  emit();
}

/** Close the dialog and the window, dropping the decoded cube with them. */
export function closeNetcdfCube(): void {
  if (state.layerId === null) return;
  // The settings survive the close, so the next cube on any layer starts from
  // what this one used. The read token does not: the window unmounts and drops
  // its cube, so the next open has to read again.
  state = { ...CLOSED, settings: state.settings };
  emit();
}

/**
 * Close if one particular layer is open.
 *
 * What a layer removal calls: closing unconditionally would shut a window the
 * user has open on some other cube.
 *
 * @param id - The layer being removed.
 */
export function closeNetcdfCubeForLayer(id: string): void {
  if (state.layerId === id) closeNetcdfCube();
}

/** Cube sizes offered, as the longest spatial edge in cells. */
export const SIZE_CHOICES = [96, DEFAULT_CUBE_SIZE, 288, 384] as const;

/**
 * Band counts offered, on top of "every band". Read time is close to linear in
 * this, so it is the control that decides whether a cube takes seconds or
 * minutes; the axis is strided evenly, so a subset still spans the spectrum.
 */
export const BAND_CHOICES = [16, 32, DEFAULT_CUBE_BANDS, 128, 256] as const;

/**
 * The band counts offered for one axis: the presets it can reach, then "all".
 *
 * "All" is capped at {@link MAX_CUBE_BANDS}, so a variable with a few thousand
 * entries on its band axis cannot offer a read the reader would refuse to make
 * anyway — the dropdown would otherwise promise something it does not deliver.
 */
export function bandChoicesFor(axisSize: number): number[] {
  const all = Math.min(axisSize, MAX_CUBE_BANDS);
  return [...BAND_CHOICES.filter((choice) => choice < all), all];
}

/**
 * Bring settings carried over from another layer back into range for this one.
 *
 * Carrying settings forward is what makes the read-move-read loop bearable, but
 * three of them only mean anything relative to a particular layer:
 *
 * - a drawn `bbox` is geography, and pointing it at a scene somewhere else
 *   clamps to a corner of the new grid — a slow, near-empty cube with nothing
 *   to say it went wrong;
 * - `rgbBands` are indices into a band axis, and indices past the end of a
 *   shorter one are clamped to its last band, quietly making all three channels
 *   the same and the "colour" image grey;
 * - `maxBands` has to name one of the counts actually offered, or the dropdown
 *   shows an empty field while the read uses something else.
 *
 * @param settings - What the previous layer left behind.
 * @param axisSize - The new layer's band-axis length.
 * @param keepExtent - True when this is the same layer, so its bbox still means
 *   what it did; false drops back to the map view.
 * @param fallbackRgb - The band triple to use when the carried one does not fit
 *   this axis; the caller supplies it because choosing well needs the axis'
 *   wavelengths, which this module does not see.
 * @returns Settings safe to seed the dialog with.
 */
export function normalizeCubeSettings(
  settings: NetcdfCubeSettings,
  axisSize: number,
  keepExtent: boolean,
  fallbackRgb: [number, number, number],
): NetcdfCubeSettings {
  const choices = bandChoicesFor(axisSize);
  // The nearest offered count, so a carried-over value always names a real
  // option rather than leaving the field blank.
  const maxBands = choices.reduce((best, choice) =>
    Math.abs(choice - settings.maxBands) < Math.abs(best - settings.maxBands) ? choice : best,
  );
  const rgbInRange =
    settings.rgbBands !== null && settings.rgbBands.every((index) => index < axisSize);
  return {
    ...settings,
    extent: keepExtent || settings.extent !== "draw" ? settings.extent : "view",
    bbox: keepExtent ? settings.bbox : null,
    maxBands,
    // Null (the overlay is off) stays null; an out-of-range triple is replaced
    // with this axis' own default rather than dropped, so a checked box still
    // produces a real colour image.
    rgbBands: settings.rgbBands === null ? null : rgbInRange ? settings.rgbBands : fallbackRgb,
  };
}

/** The current state, for `useSyncExternalStore`. */
export function getNetcdfCubeState(): NetcdfCubeState {
  return state;
}

/** Subscribe to changes, for `useSyncExternalStore`. */
export function subscribeNetcdfCube(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
