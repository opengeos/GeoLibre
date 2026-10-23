// Imported from the reader module directly, never the package barrel: the
// barrel reaches maplibre-gl, deck.gl and other modules that touch
// window/document while evaluating, which puts this module (and anything
// testing it) out of reach of a plain Node test run.
import {
  percentileClim,
  type LocalNetcdfAxis,
  type LocalNetcdfGrid,
  type LocalNetcdfWindow,
} from "@geolibre/plugins/local-netcdf";

/**
 * A hyperspectral cube read into memory as a stack of band planes, and the
 * six exterior faces drawn from it.
 *
 * The cube is deliberately *not* the whole variable: an EMIT L3 reflectance
 * grid is 285 x 1875 x 2442 float32, or 5.2 GB, which neither the WebAssembly
 * heap nor a texture can hold. Callers read a spatial window decimated to a few
 * hundred cells a side (see `LocalNetcdfWindow`), which is both what fits and
 * what a viewer can resolve on screen.
 */

/** Longest edge, in cells, the cube reader decimates a window down to. */
export const DEFAULT_CUBE_SIZE = 192;

/**
 * Band planes read by default.
 *
 * Every plane is a separate hyperslab, and HDF5 decompresses whole chunks for
 * each one, so read time is very close to linear in this number: EMIT's full
 * 285 bands take about 100 s over a whole scene, and 64 take about 25 s. The
 * default therefore buys a cube quickly and leaves reading the full spectrum to
 * an explicit choice.
 */
export const DEFAULT_CUBE_BANDS = 64;

/**
 * Hard ceiling on band planes, whatever the axis holds and whatever the caller
 * asks for.
 *
 * Not just a default. Nothing about this feature is EMIT-specific — it runs off
 * any band axis a NetCDF or HDF file declares — and a variable with a few
 * thousand entries on that axis would otherwise read every one of them
 * sequentially into a single unbounded `Float32Array`, which is the exact
 * failure the windowing and striding exist to prevent.
 */
export const MAX_CUBE_BANDS = 512;

/** One band plane in a cube, and where it came from. */
export interface NetcdfCubeBand {
  /** Index into the source variable's band axis. */
  index: number;
  /** The axis' coordinate value (a wavelength, for EMIT), when it has one. */
  value?: number;
}

/**
 * A decoded cube: every value in physical units, band-major.
 *
 * Values are `NaN` wherever the file held its fill value or a non-finite
 * reading, so the faces can leave those cells transparent instead of painting
 * -9999 as the darkest color in the ramp.
 */
export interface NetcdfCube {
  /** Columns (x/lon extent). */
  nx: number;
  /** Rows (y/lat extent), north first. */
  ny: number;
  /** Band planes. */
  nz: number;
  /** `nz * ny * nx` values; index `z * ny * nx + y * nx + x`. */
  values: Float32Array;
  /** The bands actually read, in order, one per z. */
  bands: NetcdfCubeBand[];
  /** The band axis, for labelling. */
  axis: Pick<LocalNetcdfAxis, "name" | "units" | "longName">;
  /** The variable the cube was read from. */
  variable: string;
  /** The variable's CF `units`, when it declares any. */
  units?: string;
  /** Geographic extent `[west, south, east, north]` of the window read. */
  bounds: [number, number, number, number];
  /** The cube's robust range (2% trimmed), for a first stretch. */
  dataClim: [number, number];
  /**
   * A true-colour (or false-colour) composite of three chosen bands, laid over
   * the cube's top face. HyperCoast's `rgb_bands`/`rgb_wavelengths`: the cube
   * itself is one variable through one colormap, and the top band alone is
   * rarely recognisable, so an image the eye can read anchors it to the ground.
   */
  rgb?: CubeFaceImage;
  /** The band indices {@link rgb} was composed from, red first. */
  rgbBands?: [number, number, number];
  /**
   * The window every plane was read with.
   *
   * Kept so the overlay can be recomposed from different bands without
   * rebuilding the cube: three more plane reads through this same window land
   * exactly on the cube's own cells, where a window derived afresh from the map
   * would not.
   */
  readWindow?: LocalNetcdfWindow;
  /**
   * Where the cube holds any reading at all, for skipping hopeless rays (see
   * {@link CubeFootprint}). Optional: a cube without one still paints
   * correctly, just more slowly.
   */
  footprint?: CubeFootprint;
}

/**
 * Which parts of a cube hold data, collapsed across the band axis.
 *
 * {@link faceSampleIndex} walks inward from each face until it finds a reading,
 * and the rays that cost the most are the ones that find nothing: a nodata
 * corner walks the cube's full depth before giving up, once per texel. Because
 * a satellite scene's nodata is the same shape at every band, one collapsed mask
 * answers "could this ray hit anything?" in O(1) and skips exactly those.
 *
 * Built during the read, which already touches every cell, so it costs nothing
 * extra. Conservative by construction: a cell marked empty is empty at every
 * band, so skipping it can never hide a reading. A slice inherits its parent's
 * mask, which stays valid because a superset only ever costs a walk that would
 * have failed anyway.
 */
export interface CubeFootprint {
  /** `ny * nx` flags: 1 where some band at this cell has a reading. */
  cell: Uint8Array;
  /** `ny` flags: 1 where some cell in this row has a reading. */
  row: Uint8Array;
  /** `nx` flags: 1 where some cell in this column has a reading. */
  column: Uint8Array;
  /** Per row, the first and last column holding a reading; -1 for an empty row. */
  rowFirst: Int32Array;
  rowLast: Int32Array;
  /** Per column, the first and last row holding a reading; -1 for an empty one. */
  columnFirst: Int32Array;
  columnLast: Int32Array;
}

/** How to read a cube: the source, the extent, and how coarsely. */
export interface ReadNetcdfCubeOptions {
  /** Reads one band plane, already windowed and decimated by the reader. */
  readBand: (bandIndex: number) => Promise<LocalNetcdfGrid>;
  /** The window {@link readBand} applies, recorded on the cube for later reads. */
  readWindow?: LocalNetcdfWindow;
  /** The variable being read, for labelling. */
  variable: string;
  /** The variable's CF `units`. */
  units?: string;
  /** The full band axis, whose entries this walks. */
  axis: LocalNetcdfAxis;
  /** Cap on planes read; the axis is strided down to fit. */
  maxBands?: number;
  /**
   * Band indices for a red/green/blue composite laid over the top face. Read as
   * three extra planes rather than taken from the cube: the cube's bands are
   * strided, so the ones that make a good true-colour image are usually not
   * among them.
   */
  rgbBands?: [number, number, number];
  /** Called after each plane lands, so a caller can show progress. */
  onProgress?: (done: number, total: number) => void;
  /** Abandons the read between planes. */
  signal?: AbortSignal;
}

/**
 * Read a cube one band plane at a time.
 *
 * Sequential rather than concurrent, and yielding to the event loop between
 * planes, because the local reader is synchronous h5wasm on the main thread: a
 * cube is tens of plane reads, and without the yield the window would freeze
 * solid for the whole read with no progress and no way to cancel.
 *
 * @param options - Where to read from, and how much.
 * @returns The decoded cube.
 * @throws If the read is aborted, or no plane could be read.
 */
export async function readNetcdfCube(options: ReadNetcdfCubeOptions): Promise<NetcdfCube> {
  const indices = strideBands(
    options.axis.size,
    Math.min(options.maxBands ?? MAX_CUBE_BANDS, MAX_CUBE_BANDS),
  );
  // The overlay's planes are read in the same pass, so one progress bar covers
  // the whole wait rather than the window sitting apparently finished while
  // three more reads run.
  const rgbIndices = options.rgbBands ?? null;
  const total = indices.length + (rgbIndices ? rgbIndices.length : 0);
  let values: Float32Array | null = null;
  let cells: Uint8Array | null = null;
  let nx = 0;
  let ny = 0;
  let bounds: [number, number, number, number] = [0, 0, 0, 0];
  const bands: NetcdfCubeBand[] = [];

  for (let z = 0; z < indices.length; z++) {
    if (options.signal?.aborted) throw new CubeReadAbortedError();
    const grid = await options.readBand(indices[z]);
    if (!values) {
      nx = grid.nx;
      ny = grid.ny;
      values = new Float32Array(indices.length * ny * nx);
      cells = new Uint8Array(ny * nx);
      bounds = gridExtent(grid);
    } else if (grid.nx !== nx || grid.ny !== ny) {
      // Every plane is read with the same window, so a mismatch means the file
      // changed shape underneath us; stacking it would silently misalign the
      // faces rather than fail.
      throw new CubeError("shapeMismatch", "The cube's band planes do not share one shape.");
    }
    unpackInto(values, z * ny * nx, grid, cells);
    bands.push({
      index: indices[z],
      ...(options.axis.values?.[indices[z]] !== undefined
        ? { value: options.axis.values[indices[z]] }
        : {}),
    });
    options.onProgress?.(z + 1, total);
    // A macrotask, not a microtask: only this lets the browser paint the
    // progress it was just handed.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (!values) throw new CubeError("noBands", "The cube has no bands to read.");

  let rgb: CubeFaceImage | undefined;
  if (rgbIndices) {
    const channels: LocalNetcdfGrid[] = [];
    for (const index of rgbIndices) {
      if (options.signal?.aborted) throw new CubeReadAbortedError();
      const plane = await options.readBand(index);
      // Against the *cube*, not just against each other: the overlay is laid
      // over the top face at the cube's own size, so a caller reading the
      // channels through a different window would silently stretch the image
      // across the cube rather than fail.
      if (plane.nx !== nx || plane.ny !== ny) {
        throw new CubeError("rgbShapeMismatch", "The RGB bands do not share the cube's shape.");
      }
      channels.push(plane);
      options.onProgress?.(indices.length + channels.length, total);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    rgb = composeCubeRgb(channels);
  }

  return {
    nx,
    ny,
    nz: indices.length,
    values,
    bands,
    axis: {
      name: options.axis.name,
      ...(options.axis.units ? { units: options.axis.units } : {}),
      ...(options.axis.longName ? { longName: options.axis.longName } : {}),
    },
    variable: options.variable,
    ...(options.units ? { units: options.units } : {}),
    bounds,
    // Over the whole cube rather than per plane: one stretch has to serve every
    // face, and a per-plane range would make the same reflectance read as a
    // different color on the top face than on the sides.
    dataClim: percentileClim(values) ?? [0, 1],
    ...(cells ? { footprint: buildFootprint(cells, ny, nx) } : {}),
    ...(rgb ? { rgb } : {}),
    ...(rgbIndices ? { rgbBands: rgbIndices } : {}),
    ...(options.readWindow ? { readWindow: options.readWindow } : {}),
  };
}

/**
 * A cube truncated to its lowest `bands` planes.
 *
 * The slice HyperCoast gets from `widget="plane"` with an inverted +z normal:
 * cutting down from the top exposes the interior at the cut, which is the only
 * way to see into a cube whose faces are opaque. Cheap because the values are
 * band-major, so the visible part is a prefix of the same buffer and a slider
 * costs a subarray rather than a re-read.
 *
 * @param cube - The full cube.
 * @param bands - Planes to keep, counted up from the first.
 * @returns A view onto the same values, or the cube itself when nothing is cut.
 */
export function sliceCube(cube: NetcdfCube, bands: number): NetcdfCube {
  const kept = Math.min(cube.nz, Math.max(1, Math.trunc(bands)));
  if (kept === cube.nz) return cube;
  return {
    ...cube,
    nz: kept,
    values: cube.values.subarray(0, kept * cube.ny * cube.nx),
    bands: cube.bands.slice(0, kept),
  };
}

/** Percentile trimmed off each end of every RGB channel before scaling. */
const RGB_STRETCH_PERCENT = 2;

/**
 * Compose three band planes into an RGB image for the cube's top face.
 *
 * Each channel is stretched across its own robust range, the usual remote
 * -sensing 2% stretch, because raw reflectance in three bands spans very
 * different values and a shared stretch would come out a single hue. A cell is
 * transparent unless all three channels have a reading, so the composite masks
 * exactly where the cube does.
 *
 * Rows run south first, matching {@link faceSampleIndex}'s top-face mapping and
 * three.js' `DataTexture` (which does not flip Y), so the image lands on the
 * cube the same way up as the grid it came from.
 *
 * @param channels - The red, green, and blue planes, all the same shape.
 * @returns The composite, ready to use as a texture.
 * @throws If the three planes do not share one shape.
 */
export function composeCubeRgb(channels: LocalNetcdfGrid[]): CubeFaceImage {
  const [red] = channels;
  if (channels.length !== 3) throw new Error("An RGB composite needs exactly three bands.");
  if (channels.some((channel) => channel.nx !== red.nx || channel.ny !== red.ny)) {
    throw new Error("The RGB bands do not share one shape.");
  }
  const width = red.nx;
  const height = red.ny;
  const ranges = channels.map((channel) => {
    const decoding = {
      fillValue: channel.fillValue,
      scale: channel.scaleFactor,
      offset: channel.addOffset,
    };
    return percentileClim(channel.values, decoding, RGB_STRETCH_PERCENT) ?? [0, 1];
  });
  const pixels = new Uint8Array(width * height * 4);
  for (let v = 0; v < height; v++) {
    // Row 0 of a grid is north; texel row 0 is south.
    const sourceRow = (height - 1 - v) * width;
    for (let u = 0; u < width; u++) {
      const target = (v * width + u) * 4;
      let visible = true;
      for (let c = 0; c < 3 && visible; c++) {
        const channel = channels[c];
        const raw = Number(channel.values[sourceRow + u]);
        const fill = typeof channel.fillValue === "number" ? channel.fillValue : null;
        if (!Number.isFinite(raw) || (fill !== null && raw === fill)) {
          visible = false;
          break;
        }
        const value = raw * (channel.scaleFactor ?? 1) + (channel.addOffset ?? 0);
        // After scaling, not before: an extreme `scale_factor`/`add_offset` can
        // take a perfectly good raw reading to Infinity, and `Math.round(NaN)`
        // coerces into the byte array as 0 — an opaque black pixel where every
        // other absent reading here is transparent.
        if (!Number.isFinite(value)) {
          visible = false;
          break;
        }
        const [min, max] = ranges[c];
        const span = max - min;
        const scaled = span > 0 ? ((value - min) / span) * 255 : 0;
        pixels[target + c] = Math.max(0, Math.min(255, Math.round(scaled)));
      }
      pixels[target + 3] = visible ? 255 : 0;
    }
  }
  return { width, height, pixels };
}

/**
 * Recompose a cube's top-face overlay from different bands.
 *
 * Three plane reads rather than the tens a cube costs, so changing which bands
 * make the image is a couple of seconds instead of another full rebuild. The
 * planes are read through the cube's own {@link NetcdfCube.readWindow}, so they
 * land on its cells exactly; a cube read before that was recorded cannot be
 * updated this way and the caller has to rebuild.
 *
 * @param cube - The cube whose overlay to replace.
 * @param readBand - Reads one plane through a given window.
 * @param bands - The red, green, and blue band indices.
 * @param signal - Abandons the read between planes.
 * @returns A cube sharing this one's values, with the new overlay.
 * @throws If the cube has no recorded window, or the read is aborted.
 */
export async function recomposeCubeRgb(
  cube: NetcdfCube,
  readBand: (bandIndex: number, window?: LocalNetcdfWindow) => Promise<LocalNetcdfGrid>,
  bands: [number, number, number],
  signal?: AbortSignal,
): Promise<NetcdfCube> {
  if (!cube.readWindow) {
    throw new CubeError(
      "noReadWindow",
      "This cube did not record how it was read, so it must be rebuilt.",
    );
  }
  const channels: LocalNetcdfGrid[] = [];
  for (const index of bands) {
    if (signal?.aborted) throw new CubeReadAbortedError();
    const plane = await readBand(index, cube.readWindow);
    if (plane.nx !== cube.nx || plane.ny !== cube.ny) {
      throw new CubeError("rgbShapeMismatch", "The RGB bands do not share the cube's shape.");
    }
    channels.push(plane);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (signal?.aborted) throw new CubeReadAbortedError();
  // A new object, not a mutation: the view keys its texture effect on
  // `cube.rgb`, so replacing the reference is what makes it repaint.
  return { ...cube, rgb: composeCubeRgb(channels), rgbBands: bands };
}

/** Thrown when a cube read is abandoned; callers treat it as "no result". */
export class CubeReadAbortedError extends Error {
  constructor() {
    super("The cube read was cancelled.");
    this.name = "CubeReadAbortedError";
  }
}

/** The ways a cube read can fail that a user might actually see. */
export type CubeErrorCode =
  /** The band planes came back with different shapes. */
  | "shapeMismatch"
  /** The overlay's planes do not match the cube they sit on. */
  | "rgbShapeMismatch"
  /** The variable's band axis is empty. */
  | "noBands"
  /** The cube predates the window being recorded, so it cannot be re-read. */
  | "noReadWindow";

/**
 * A cube failure the UI can translate.
 *
 * This module has no `t()` — it is a plain library, deliberately usable from a
 * test run with no i18n — so it carries a code the window maps to a catalog key
 * instead. The message stays English for logs and for a caller that does not
 * know the code.
 */
export class CubeError extends Error {
  constructor(
    readonly code: CubeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CubeError";
  }
}

/**
 * Band indices to read, strided evenly to at most `maxBands`.
 *
 * Even striding rather than the first N, so a truncated cube still spans the
 * whole spectrum: taking EMIT's first 320 of 285 bands is a no-op, but taking
 * the first 320 of a 2000-band axis would show only the blue end.
 *
 * @param size - Entries on the band axis.
 * @param maxBands - The most planes to read.
 * @returns Ascending source indices.
 */
export function strideBands(size: number, maxBands: number): number[] {
  const total = Math.max(0, Math.trunc(size));
  const cap = Math.max(1, Math.trunc(maxBands));
  if (total <= cap) return Array.from({ length: total }, (_, i) => i);
  const step = total / cap;
  const out: number[] = [];
  for (let i = 0; i < cap; i++) out.push(Math.min(total - 1, Math.round(i * step)));
  return out;
}

/** A rectangle of cells, in a grid's own row/column indices. */
export interface CellRect {
  row: number;
  column: number;
  rows: number;
  columns: number;
}

/**
 * The smallest rectangle of cells holding every non-fill reading in a grid.
 *
 * A satellite scene is a rotated footprint stored in an axis-aligned lat/lon
 * grid, so its outermost rows and columns are usually pure nodata. Those are
 * exactly the cells the cube's four side faces are made of, and painting them
 * transparent (which is right) leaves a cube that appears to have no sides at
 * all. Cropping to the data first is what HyperCoast's `crop=` argument does by
 * hand; doing it from the grid means the caller does not have to guess a
 * pixel count.
 *
 * @param grid - The layer's displayed slice, at full resolution.
 * @returns The tight rectangle, or null when the grid is entirely fill.
 */
export function validDataRect(grid: LocalNetcdfGrid): CellRect | null {
  const fill = typeof grid.fillValue === "number" ? grid.fillValue : null;
  let minRow = Number.POSITIVE_INFINITY;
  let maxRow = -1;
  let minColumn = Number.POSITIVE_INFINITY;
  let maxColumn = -1;
  for (let y = 0; y < grid.ny; y++) {
    const rowStart = y * grid.nx;
    for (let x = 0; x < grid.nx; x++) {
      const raw = Number(grid.values[rowStart + x]);
      if (!Number.isFinite(raw) || (fill !== null && raw === fill)) continue;
      if (y < minRow) minRow = y;
      if (y > maxRow) maxRow = y;
      if (x < minColumn) minColumn = x;
      if (x > maxColumn) maxColumn = x;
    }
  }
  if (maxRow < 0 || maxColumn < 0) return null;
  return {
    row: minRow,
    column: minColumn,
    rows: maxRow - minRow + 1,
    columns: maxColumn - minColumn + 1,
  };
}

/** The overlap of two cell rectangles, or null when they do not meet. */
export function intersectRect(a: CellRect, b: CellRect): CellRect | null {
  const row = Math.max(a.row, b.row);
  const column = Math.max(a.column, b.column);
  const endRow = Math.min(a.row + a.rows, b.row + b.rows);
  const endColumn = Math.min(a.column + a.columns, b.column + b.columns);
  if (endRow <= row || endColumn <= column) return null;
  return { row, column, rows: endRow - row, columns: endColumn - column };
}

/** A grid's geographic extent, from its cell centres outward by half a cell. */
function gridExtent(grid: LocalNetcdfGrid): [number, number, number, number] {
  const lon = grid.lon;
  const lat = grid.lat;
  const halfX = lon.length > 1 ? Math.abs(Number(lon[1]) - Number(lon[0])) / 2 : 0;
  const halfY = lat.length > 1 ? Math.abs(Number(lat[1]) - Number(lat[0])) / 2 : 0;
  const west = Math.min(Number(lon[0]), Number(lon[lon.length - 1])) - halfX;
  const east = Math.max(Number(lon[0]), Number(lon[lon.length - 1])) + halfX;
  const south = Math.min(Number(lat[0]), Number(lat[lat.length - 1])) - halfY;
  const north = Math.max(Number(lat[0]), Number(lat[lat.length - 1])) + halfY;
  return [west, south, east, north];
}

/**
 * Copy one plane into the cube, unpacked to physical units with NaN fill, and
 * mark every cell it had a reading for.
 *
 * The marking rides along here because this loop already visits every cell, so
 * the footprint (see {@link CubeFootprint}) costs one array write per reading
 * rather than a second pass over the whole cube.
 */
function unpackInto(
  target: Float32Array,
  offset: number,
  grid: LocalNetcdfGrid,
  cells: Uint8Array | null,
): void {
  const scale = grid.scaleFactor ?? 1;
  const add = grid.addOffset ?? 0;
  const fill = typeof grid.fillValue === "number" ? grid.fillValue : null;
  const count = grid.ny * grid.nx;
  for (let i = 0; i < count; i++) {
    const raw = Number(grid.values[i]);
    if (!Number.isFinite(raw) || (fill !== null && raw === fill)) {
      target[offset + i] = Number.NaN;
      continue;
    }
    const value = raw * scale + add;
    const finite = Number.isFinite(value);
    target[offset + i] = finite ? value : Number.NaN;
    if (finite && cells) cells[i] = 1;
  }
}

/**
 * Collapse a cell mask into the row and column summaries the faces use.
 *
 * The first/last edges are what turn a side face's inward walk into a jump: a
 * ray entering from the east already knows the outermost column in its row that
 * could hold anything, so it starts there instead of stepping across the nodata
 * margin one cell at a time.
 */
function buildFootprint(cell: Uint8Array, ny: number, nx: number): CubeFootprint {
  const row = new Uint8Array(ny);
  const column = new Uint8Array(nx);
  const rowFirst = new Int32Array(ny).fill(-1);
  const rowLast = new Int32Array(ny).fill(-1);
  const columnFirst = new Int32Array(nx).fill(-1);
  const columnLast = new Int32Array(nx).fill(-1);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      if (!cell[y * nx + x]) continue;
      row[y] = 1;
      column[x] = 1;
      if (rowFirst[y] < 0) rowFirst[y] = x;
      rowLast[y] = x;
      if (columnFirst[x] < 0) columnFirst[x] = y;
      columnLast[x] = y;
    }
  }
  return { cell, row, column, rowFirst, rowLast, columnFirst, columnLast };
}

/**
 * The six exterior faces of the cube, named for the direction each one faces in
 * the viewer's world: +x east, +y north, +z the far end of the band axis.
 */
export type CubeFace = "top" | "bottom" | "north" | "south" | "east" | "west";

export const CUBE_FACES: CubeFace[] = ["top", "bottom", "north", "south", "east", "west"];

/** One face rasterized into RGBA bytes, ready for a texture. */
export interface CubeFaceImage {
  /** Texels across the face (its u axis). */
  width: number;
  /** Texels up the face (its v axis). */
  height: number;
  /**
   * RGBA bytes, row `v = 0` first, matching a three.js `DataTexture` (which
   * unlike an image texture does not flip Y). Backed by a plain `ArrayBuffer`
   * (never shared) so it can be handed straight to the GPU.
   */
  pixels: Uint8Array<ArrayBuffer>;
}

/** The texel grid of a face, before any values are read. */
export function cubeFaceSize(cube: NetcdfCube, face: CubeFace): { width: number; height: number } {
  switch (face) {
    case "top":
    case "bottom":
      return { width: cube.nx, height: cube.ny };
    case "north":
    case "south":
      return { width: cube.nx, height: cube.nz };
    case "east":
    case "west":
      return { width: cube.nz, height: cube.ny };
  }
}

/**
 * Where a face's texel starts, and which way it looks into the cube.
 *
 * Each face is drawn as a plane whose u axis runs along world +x (or the band
 * axis, for the two that face east/west) and whose v axis runs up the plane, so
 * `base` maps (u, v) to a world position and then to the outermost cell at that
 * position, and `step` walks from there towards the middle of the cube.
 * Deriving these from world directions rather than from how a face happens to
 * look on screen is what keeps the six mappings independent of the camera; the
 * rotations in `NetcdfCubeView.placeFace` are chosen to match them.
 *
 * @param cube - The cube being drawn.
 * @param face - Which face.
 * @param u - Texel across the face.
 * @param v - Texel up the face.
 * @returns The outermost cell's index, the inward step, and how far it can go.
 */
function faceRay(
  cube: NetcdfCube,
  face: CubeFace,
  u: number,
  v: number,
): { base: number; step: number; depth: number } {
  const { nx, ny, nz } = cube;
  const plane = ny * nx;
  switch (face) {
    // Looking down: u east, v north. Row 0 is north, so v counts back from it;
    // inward is down the band axis.
    case "top":
      return { base: (nz - 1) * plane + (ny - 1 - v) * nx + u, step: -plane, depth: nz };
    // Looking up: u east, v south-to-north reversed, so v indexes rows directly.
    case "bottom":
      return { base: v * nx + u, step: plane, depth: nz };
    // The north edge row, with v running down the band axis from the top;
    // inward is southward.
    case "north":
      return { base: (nz - 1 - v) * plane + u, step: nx, depth: ny };
    // The south edge row, v running up the band axis from the bottom.
    case "south":
      return { base: v * plane + (ny - 1) * nx + u, step: -nx, depth: ny };
    // The east edge column; u runs down the band axis, v north from the south,
    // and inward is westward.
    case "east":
      return { base: (nz - 1 - u) * plane + (ny - 1 - v) * nx + (nx - 1), step: -1, depth: nx };
    // The west edge column; u runs up the band axis.
    case "west":
      return { base: u * plane + (ny - 1 - v) * nx, step: 1, depth: nx };
  }
}

/**
 * The cube cell a face's texel shows: the outermost one holding a reading.
 *
 * Not simply the cell on the face. A satellite scene is a rotated footprint
 * inside an axis-aligned grid, so a cube's outermost rows and columns are
 * mostly nodata even after cropping — and painting those transparent (which is
 * right) would leave a cube whose four sides are invisible. Walking inward to
 * the first real reading is what a volume renderer would show looking from that
 * direction, and it costs nothing when the array is full: the very first cell
 * is a hit, so a well-behaved cube samples exactly its own surface.
 *
 * @param cube - The cube being drawn.
 * @param face - Which face.
 * @param u - Texel across the face.
 * @param v - Texel up the face.
 * @returns The cell's index into {@link NetcdfCube.values}; the face cell itself
 *   (still nodata, so still transparent) when the ray finds nothing.
 */
export function faceSampleIndex(cube: NetcdfCube, face: CubeFace, u: number, v: number): number {
  const { base, step, depth } = faceRay(cube, face, u, v);
  // Two costs the footprint removes. A ray that can hit nothing walks the
  // cube's whole extent to prove it — most of the corners, on a rotated
  // footprint. And a ray that *will* hit still crosses the nodata margin one
  // cell at a time, which is the bulk of the remaining work on the side faces.
  let skip = 0;
  if (cube.footprint) {
    if (!rayCanHit(cube, cube.footprint, face, u, v)) return base;
    skip = raySkip(cube, cube.footprint, face, u, v);
  }
  const start = base + skip * step;
  for (let i = skip, index = start; i < depth; i++, index += step) {
    if (Number.isFinite(cube.values[index])) return index;
  }
  return base;
}

/**
 * How many cells a ray can jump before the first one that could hold anything.
 *
 * Zero for the top and bottom faces: they look along the band axis, which the
 * footprint deliberately collapses, and their first cell is a hit whenever the
 * column has data at all.
 *
 * @returns A non-negative number of steps, never past the ray's own extent.
 */
function raySkip(
  cube: NetcdfCube,
  footprint: CubeFootprint,
  face: CubeFace,
  u: number,
  v: number,
): number {
  const { nx, ny } = cube;
  switch (face) {
    case "top":
    case "bottom":
      return 0;
    // Sweeping south from row 0 down column u.
    case "north":
      return Math.max(0, footprint.columnFirst[u]);
    // Sweeping north from row ny-1.
    case "south":
      return Math.max(0, ny - 1 - footprint.columnLast[u]);
    // Sweeping west from column nx-1 along row ny-1-v.
    case "east":
      return Math.max(0, nx - 1 - footprint.rowLast[ny - 1 - v]);
    // Sweeping east from column 0.
    case "west":
      return Math.max(0, footprint.rowFirst[ny - 1 - v]);
  }
}

/**
 * Whether a face's ray passes through any cell that holds a reading.
 *
 * Collapsed along the ray's own direction: the top and bottom faces look down a
 * single cell's column of bands, the north and south faces sweep a grid column,
 * and the east and west faces sweep a grid row.
 *
 * @returns False only when every cell the ray could reach is nodata.
 */
function rayCanHit(
  cube: NetcdfCube,
  footprint: CubeFootprint,
  face: CubeFace,
  u: number,
  v: number,
): boolean {
  const { nx, ny } = cube;
  switch (face) {
    case "top":
      return footprint.cell[(ny - 1 - v) * nx + u] === 1;
    case "bottom":
      return footprint.cell[v * nx + u] === 1;
    case "north":
    case "south":
      return footprint.column[u] === 1;
    case "east":
    case "west":
      return footprint.row[ny - 1 - v] === 1;
  }
}

/**
 * Paint one face of the cube through a colormap.
 *
 * @param cube - The decoded cube.
 * @param face - Which face to paint.
 * @param colors - The ramp, as `[r, g, b]` triples low to high.
 * @param clim - The `[min, max]` the ramp is stretched across.
 * @returns The face's RGBA texels.
 */
export function paintCubeFace(
  cube: NetcdfCube,
  face: CubeFace,
  colors: Array<[number, number, number]>,
  clim: [number, number],
): CubeFaceImage {
  const { width, height } = cubeFaceSize(cube, face);
  const pixels = new Uint8Array(width * height * 4);
  const [min, max] = clim;
  const span = max - min;
  const last = colors.length - 1;
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      const value = cube.values[faceSampleIndex(cube, face, u, v)];
      const target = (v * width + u) * 4;
      if (!Number.isFinite(value)) continue; // leave it transparent
      // A zero-width range has no gradient; paint it as the ramp's low end
      // rather than dividing by zero into NaN and dropping the face entirely.
      const t = span > 0 ? (value - min) / span : 0;
      const [r, g, b] = colors[Math.min(last, Math.max(0, Math.round(t * last)))];
      pixels[target] = r;
      pixels[target + 1] = g;
      pixels[target + 2] = b;
      pixels[target + 3] = 255;
    }
  }
  return { width, height, pixels };
}
