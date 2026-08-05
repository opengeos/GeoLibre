// Read a *local* NetCDF/HDF5 file entirely in the browser (no server) and turn a
// chosen 2-D slice into an in-memory Zarr v2 store, so it can render through the
// exact same kerchunk/Zarr pipeline as a Cloud-Optimized NetCDF.
//
// The cloud path (see kerchunk-reference-store.ts) resolves each Zarr key to an
// HTTP byte range inside the remote file. Here there is no HTTP: the file is
// decoded client-side, we extract the selected slice (plus its lat/lon
// coordinate arrays) as plain typed arrays, and emit a *self-contained* Zarr v2
// reference map whose chunks are inlined as `base64:` data with no compression.
// That map is a {@link KerchunkRefs}, so it drops straight into
// `addCloudNetcdfLayer({ refs, ... })` and the @carbonplan/zarr-layer renderer
// draws it like any other kerchunk store.
//
// Two backends, chosen by the file's magic bytes:
//   - HDF5 / NetCDF-4 (`\x89HDF...`) -> h5wasm
//   - classic NetCDF-3 (`CDF\x01`)   -> netcdfjs (pure JS)

import type { NetCDFReader } from "netcdfjs";
import type { KerchunkRefs } from "./kerchunk-reference-store";

// h5wasm's structural types, kept minimal so this module does not need the
// package at type-check time in consumers. The real shapes come from the
// dynamic import in {@link loadH5wasm}.
interface H5Metadata {
  type: number; // HDF5 type class: 0 = integer, 1 = float
  size: number; // bytes per element
  signed: boolean;
  shape: number[] | null;
}
interface H5Dataset {
  metadata: H5Metadata;
  shape: number[] | null;
  attrs: Record<string, { value: unknown }>;
  value: unknown;
  slice(ranges: Array<[] | [number] | [number, number]>): unknown;
  get_dimension_labels(): Array<string | null>;
}
interface H5Group {
  keys(): string[];
  get(path: string): unknown;
}
interface H5File extends H5Group {
  close(): void;
}
interface H5FS {
  writeFile(path: string, data: Uint8Array): void;
  unlink(path: string): void;
}
/** The h5wasm surface we use: the File constructor plus the ready filesystem. */
interface H5wasmModule {
  FS: H5FS;
  File: new (name: string, mode: string) => H5File;
}
/** Shape of the dynamically imported `h5wasm` module. */
interface H5wasmNamespace {
  default?: {
    ready: Promise<{ FS: H5FS }>;
    File: new (name: string, mode: string) => H5File;
  };
  ready?: Promise<{ FS: H5FS }>;
  File?: new (name: string, mode: string) => H5File;
}

/** A NetCDF-3 variable (netcdfjs types `attributes` too loosely, so narrow it). */
interface Nc3Variable {
  name: string;
  /** Indices into the reader's `dimensions` array, in order. */
  dimensions: number[];
  attributes: Array<{ name: string; value: unknown }>;
  /** netcdfjs type tag: byte/char/short/int/float/double. */
  type: string;
}

/** HDF5 datatype classes we can render (numeric grids only). */
const H5T_INTEGER = 0;
const H5T_FLOAT = 1;

/** NetCDF-3 numeric types → Zarr v2 dtype + typed-array constructor. */
const NC3_DTYPES: Record<
  string,
  { dtype: string; make: (a: ArrayLike<number>) => TypedArrayLike }
> = {
  byte: { dtype: "<i1", make: (a) => new Int8Array(a) },
  short: { dtype: "<i2", make: (a) => new Int16Array(a) },
  int: { dtype: "<i4", make: (a) => new Int32Array(a) },
  float: { dtype: "<f4", make: (a) => new Float32Array(a) },
  double: { dtype: "<f8", make: (a) => new Float64Array(a) },
};

/** Common coordinate-variable names, longest/most-specific first. */
const LAT_NAMES = ["latitude", "lat", "y", "nav_lat"];
const LON_NAMES = ["longitude", "lon", "lng", "x", "nav_lon"];

// Generic axis names that are only trusted as geographic coordinates when the
// variable also carries a geographic units/standard_name attribute — a bare
// `x`/`y` often holds projected metres or plain pixel indices.
const GENERIC_COORD_NAMES = new Set(["x", "y"]);

// Plausible geographic value ranges, with a small tolerance for grids whose
// cell centers sit slightly outside the nominal extent. Longitude allows both
// the -180..180 and 0..360 conventions.
const LAT_RANGE = [-91, 91] as const;
const LON_RANGE = [-181, 361] as const;

// File-format signatures (first bytes).
const HDF5_MAGIC = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];

/** A renderable variable discovered in a local NetCDF/HDF file. */
export interface LocalNetcdfVariable {
  /** Dataset path (e.g. `air` or `group/temperature`). */
  name: string;
  /** Dimension names in order (best effort). */
  dims: string[];
  /** Array shape. */
  shape: number[];
  /** CF `long_name`, when the variable declares one. */
  longName?: string;
  /** CF `units`, when the variable declares one. */
  units?: string;
}

/**
 * One *leading* (non-spatial) axis of a variable — the axes a caller has to fix
 * an index on before a 2-D slice exists. `values` carries the axis' own
 * coordinate variable when the file has one, so a picker can label the choices
 * with what they mean (EMIT's `bands` axis reads back as wavelengths in nm)
 * instead of a bare index.
 */
export interface LocalNetcdfAxis {
  /** Dimension name (e.g. `bands`, `time`). */
  name: string;
  /** Number of entries along the axis. */
  size: number;
  /** The axis' coordinate values, when a matching 1-D variable exists. */
  values?: number[];
  /** The coordinate variable's CF `units` (e.g. `nm`). */
  units?: string;
  /** The coordinate variable's CF `long_name`. */
  longName?: string;
}

/** Result of building a Zarr store from a local variable slice. */
export interface LocalNetcdfLayerRefs {
  /** Self-contained Zarr v2 reference map (inline base64 chunks). */
  refs: KerchunkRefs;
  /** Variable name to render (matches a key prefix in {@link refs}). */
  variable: string;
  /** Geographic extent `[west, south, east, north]` of the emitted grid. */
  bounds: [number, number, number, number];
  /**
   * Robust color limits for the slice (see {@link percentileClim}), or null when
   * the slice holds no usable spread. Callers use this when the user did not
   * enter their own: the renderer's stock 0-300 default paints a 0-1
   * reflectance grid as a uniform blank.
   */
  clim: [number, number] | null;
}

/** How to compose three slices of one variable into an RGB image. */
export interface LocalNetcdfRgbOptions {
  /** Leading axis whose indices name the three channels (e.g. `bands`). */
  axis: string;
  /** Indices into {@link axis} for the red, green, and blue channels. */
  indices: [number, number, number];
  /** Index for every *other* leading dimension, keyed by dimension name. */
  selector?: Record<string, number>;
  /**
   * Percentile clipped off each end of every channel before scaling to 0-255.
   * The usual remote-sensing 2% stretch by default; 0 uses the full range.
   */
  stretchPercent?: number;
  /** Longest output edge; a larger grid is decimated to fit. */
  maxSize?: number;
}

/** A georeferenced RGBA image, ready to add as a MapLibre `image` source. */
export interface LocalNetcdfImage {
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /**
   * RGBA bytes, row-major and north-up; fill/nodata cells are transparent.
   * Backed by a plain `ArrayBuffer` (never shared) so it can be handed straight
   * to `new ImageData(...)`.
   */
  pixels: Uint8ClampedArray<ArrayBuffer>;
  /** Geographic extent `[west, south, east, north]`. */
  bounds: [number, number, number, number];
  /** Image-source corners in MapLibre order: NW, NE, SE, SW. */
  coordinates: [number, number][];
}

/** A georeferenced RGB composite. */
export interface LocalNetcdfRgbImage extends LocalNetcdfImage {
  /** The `[min, max]` actually used to scale each channel, red first. */
  channelRanges: Array<[number, number]>;
}

/** A georeferenced single-band image painted through a colormap. */
export interface LocalNetcdfColormappedImage extends LocalNetcdfImage {
  /** The `[min, max]` the colormap was stretched across. */
  clim: [number, number];
}

/**
 * One decoded 2-D slice with everything needed to draw it, and to *re*-draw it
 * later with different symbology without re-reading the file.
 *
 * Deliberately the same shape {@link composeColormappedImage} takes, minus the
 * ramp: `composeColormappedImage({ ...grid, colors })`.
 */
export interface LocalNetcdfGrid {
  /** Rows (y/lat extent). */
  ny: number;
  /** Columns (x/lon extent). */
  nx: number;
  /** The `ny * nx` grid values, still packed. */
  values: TypedArrayLike;
  /** Latitude cell centres, length `ny`. */
  lat: TypedArrayLike;
  /** Longitude cell centres, length `nx`. */
  lon: TypedArrayLike;
  /** Fill/nodata value, in the Zarr-normalized form. */
  fillValue?: number | string | null;
  /** CF `scale_factor`, when the values are packed. */
  scaleFactor?: number;
  /** CF `add_offset`, when the values are packed. */
  addOffset?: number;
  /** The slice's robust range (see {@link percentileClim}), for a first stretch. */
  dataClim: [number, number];
}

/**
 * A rectangular sub-region of a variable's grid, optionally decimated.
 *
 * Reading a *window* rather than the whole plane is what makes stacking many
 * planes affordable. A chunked cube (EMIT writes 10x256x256) decompresses whole
 * chunks whatever is asked of it, so the cost of a read is set by how many
 * chunks it touches: a 512x512 window over a 1875x2442 grid touches 4 spatial
 * chunks instead of 80, which is the difference between a cube read taking
 * seconds and taking minutes.
 *
 * {@link maxSize} then bounds what comes *back* — decimation happens after the
 * read, so it trims memory and draw cost, not I/O.
 */
export interface LocalNetcdfWindow {
  /** First row of the window, into the variable's y extent. */
  row: number;
  /** First column of the window, into the variable's x extent. */
  column: number;
  /** Rows in the window. */
  rows: number;
  /** Columns in the window. */
  columns: number;
  /**
   * Longest edge of the returned grid. A larger window is decimated by a
   * whole-number stride, so the result is a subset of the source cells and
   * never an interpolation of them.
   */
  maxSize?: number;
}

/**
 * A local NetCDF/HDF file opened in the browser. List its renderable variables,
 * build a Zarr store for a chosen slice, then {@link close} it to release any
 * backend resources.
 */
export interface LocalNetcdfFile {
  /** Renderable variables (numeric, 2-D or higher), sorted by name. */
  listVariables(): LocalNetcdfVariable[];
  /**
   * The variable's leading (non-spatial) axes, in order, with their coordinate
   * values where the file provides them. Empty for a plain 2-D grid.
   */
  listAxes(variable: string): LocalNetcdfAxis[];
  /** Build a self-contained Zarr v2 store for one 2-D slice of a variable. */
  buildLayerRefs(variable: string, selector?: Record<string, number>): LocalNetcdfLayerRefs;
  /** Compose three slices of one variable into a georeferenced RGB image. */
  buildRgbImage(variable: string, options: LocalNetcdfRgbOptions): LocalNetcdfRgbImage;
  /**
   * Read one 2-D slice plus its coordinates and packing, ready to hand to
   * {@link composeColormappedImage} (now, and again later with new symbology).
   *
   * Pass `window` to read a sub-region, decimated to a bounded size; omit it for
   * the whole plane at full resolution.
   */
  readGrid(
    variable: string,
    selector?: Record<string, number>,
    window?: LocalNetcdfWindow,
  ): LocalNetcdfGrid;
  /**
   * Read one variable's values along a leading axis at a single pixel: the
   * spectral signature of a hyperspectral cube, or a time series of one cell.
   */
  readProfile(variable: string, options: LocalNetcdfProfileOptions): LocalNetcdfProfile;
  /** Release backend resources (e.g. the WASM filesystem entry). */
  close(): void;
}

/** Which pixel, along which axis, to read a profile from. */
export interface LocalNetcdfProfileOptions {
  /** The leading axis to walk (e.g. `bands`). */
  axis: string;
  /** Row into the grid's y/lat extent. */
  row: number;
  /** Column into the grid's x/lon extent. */
  column: number;
  /** Index for every *other* leading dimension, keyed by dimension name. */
  selector?: Record<string, number>;
}

/** One pixel's values along a leading axis, in physical units. */
export interface LocalNetcdfProfile {
  /** The axis walked, with its coordinate values where the file has them. */
  axis: LocalNetcdfAxis;
  /**
   * One value per axis entry, already unpacked by `scale_factor`/`add_offset`.
   * Fill and non-finite readings are null so a chart can break the line rather
   * than plotting a spike at the nodata value.
   */
  values: Array<number | null>;
}

let modulePromise: Promise<H5wasmModule> | null = null;
let fileCounter = 0;

/**
 * Lazily load and initialize h5wasm. The (~5.6 MB) single-file WASM module is
 * only fetched the first time a user opens a local HDF5/NetCDF-4 file, keeping
 * it out of the main bundle.
 *
 * @returns The initialized h5wasm module namespace.
 */
async function loadH5wasm(): Promise<H5wasmModule> {
  modulePromise ??= (async () => {
    const ns = (await import("h5wasm")) as unknown as H5wasmNamespace;
    const api = ns.default ?? ns;
    // `ready` resolves to the emscripten Module, whose `.FS` is the in-memory
    // filesystem. The top-level `FS` export is null until then, so read it from
    // the resolved module rather than the namespace.
    const ready = api.ready ?? ns.ready;
    const File = api.File ?? ns.File;
    if (!ready || !File) {
      throw new Error("h5wasm did not expose the expected File/ready API.");
    }
    const module = await ready;
    return { FS: module.FS, File };
  })();
  try {
    return await modulePromise;
  } catch (err) {
    // A transient failure (network/cache hiccup) leaves a rejected promise
    // cached; clear it so the next open retries instead of failing forever.
    modulePromise = null;
    throw err;
  }
}

/**
 * A local HDF5/NetCDF-4 file backed by h5wasm.
 */
class Hdf5NetcdfFile implements LocalNetcdfFile {
  /** Memoized dimension-id -> name map; see {@link dimensionScaleNames}. */
  private scaleNames: Map<number, string> | null = null;

  private constructor(
    private readonly mod: H5wasmModule,
    private readonly file: H5File,
    private readonly fsPath: string,
  ) {}

  /**
   * Open a local file's bytes with h5wasm.
   *
   * @param buffer The raw file bytes.
   * @returns An open file. Call {@link close} when done.
   * @throws If the bytes are not a readable HDF5 file.
   */
  static async open(buffer: ArrayBuffer): Promise<Hdf5NetcdfFile> {
    const mod = await loadH5wasm();
    const fsPath = `geolibre-netcdf-${fileCounter++}.h5`;
    mod.FS.writeFile(fsPath, new Uint8Array(buffer));
    let file: H5File | null = null;
    try {
      file = new mod.File(fsPath, "r");
      // The File constructor does NOT throw for non-HDF5 input; force a read so
      // an invalid handle surfaces here as a clean error rather than a cryptic
      // h5wasm failure ("name not defined") deep in the listing later.
      file.keys();
      return new Hdf5NetcdfFile(mod, file, fsPath);
    } catch (err) {
      try {
        file?.close();
      } catch {
        /* best effort */
      }
      try {
        mod.FS.unlink(fsPath);
      } catch {
        /* best effort */
      }
      throw new Error(
        `Could not read the file as HDF5/NetCDF-4. (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }

  /**
   * Mount a remote file lazily and open it. See {@link openRemoteNetcdf} for the
   * constraints; this assumes they have already been checked.
   */
  static async openLazy(url: string, fsPath: string): Promise<Hdf5NetcdfFile> {
    const mod = await loadH5wasm();
    const fs = mod.FS as H5FS & {
      createLazyFile?: (
        parent: string,
        name: string,
        url: string,
        canRead: boolean,
        canWrite: boolean,
      ) => unknown;
    };
    if (typeof fs.createLazyFile !== "function") {
      throw new Error("This h5wasm build cannot read a file over HTTP without downloading it.");
    }
    let file: H5File | null = null;
    try {
      fs.createLazyFile("/", fsPath, url, true, false);
      file = new mod.File(fsPath, "r");
      // Force a read so an unreadable or non-HDF5 response surfaces here rather
      // than deep in a later listing, exactly as the local path does.
      file.keys();
      return new Hdf5NetcdfFile(mod, file, fsPath);
    } catch (err) {
      try {
        file?.close();
      } catch {
        /* best effort */
      }
      try {
        mod.FS.unlink(fsPath);
      } catch {
        /* best effort */
      }
      throw new Error(
        `Could not read ${url} as HDF5/NetCDF-4 over HTTP. The server must allow cross-origin range requests. (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }

  close(): void {
    try {
      this.file.close();
    } catch {
      /* best effort */
    }
    try {
      this.mod.FS.unlink(this.fsPath);
    } catch {
      /* best effort */
    }
  }

  /** Recursively collect every dataset path in the file (no leading slash). */
  private datasetPaths(): string[] {
    const out: string[] = [];
    const visit = (group: H5Group, prefix: string) => {
      for (const key of group.keys()) {
        // h5wasm resolves get() relative to the group, so look up the child by
        // its own `key`; `path` is only the accumulated label for output and
        // recursion. A broken/unresolved link may throw; skip it via tryGet.
        const entity = tryGet(group, key);
        if (!entity) continue;
        const path = prefix ? `${prefix}/${key}` : key;
        if (isDataset(entity)) {
          out.push(path);
        } else if (isGroup(entity)) {
          visit(entity, path);
        }
      }
    };
    visit(this.file, "");
    return out;
  }

  listVariables(): LocalNetcdfVariable[] {
    const out: LocalNetcdfVariable[] = [];
    for (const path of this.datasetPaths()) {
      const ds = tryGet(this.file, path);
      if (!isDataset(ds)) continue;
      const shape = ds.shape ?? ds.metadata.shape ?? [];
      if (shape.length < 2) continue;
      if (!isRenderableH5Dtype(ds.metadata)) continue;
      out.push({
        name: path,
        dims: this.dimensionNames(ds, shape),
        shape,
        ...optionalText("longName", h5StringAttr(ds, "long_name")),
        ...optionalText("units", h5StringAttr(ds, "units")),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  listAxes(variable: string): LocalNetcdfAxis[] {
    const { ds, shape, dims } = this.openVariable(variable);
    void ds;
    return dims
      .slice(0, Math.max(0, shape.length - 2))
      .map((name, index) => this.describeAxis(name, shape[index], variable));
  }

  /** One axis with its coordinate values, when the file provides them. */
  private describeAxis(name: string, size: number, variable: string): LocalNetcdfAxis {
    return { name, size, ...(this.findAxisCoordinate(name, size, variable) ?? {}) };
  }

  buildLayerRefs(variable: string, selector: Record<string, number> = {}): LocalNetcdfLayerRefs {
    const { ds, shape, dims } = this.openVariable(variable);
    const ny = shape[shape.length - 2];
    const nx = shape[shape.length - 1];

    const sliceData = this.readPlane(
      ds,
      shape,
      dims,
      selector,
      variable,
      resolveWindow(undefined, ny, nx),
    );
    const fillValue = h5FillValue(ds);
    const { lat, lon } = this.readCoordinates(ny, nx, variable);
    const { refs, bounds } = buildInlineZarrStore({
      variable,
      ny,
      nx,
      data: sliceData,
      dtype: h5ZarrDtype(ds.metadata),
      lat: lat.data,
      latDtype: lat.dtype,
      lon: lon.data,
      lonDtype: lon.dtype,
      fillValue,
      scaleFactor: h5NumericAttr(ds, "scale_factor"),
      addOffset: h5NumericAttr(ds, "add_offset"),
    });
    return {
      refs,
      variable,
      bounds,
      clim: percentileClim(sliceData, {
        fillValue,
        scale: h5NumericAttr(ds, "scale_factor"),
        offset: h5NumericAttr(ds, "add_offset"),
      }),
    };
  }

  buildRgbImage(variable: string, options: LocalNetcdfRgbOptions): LocalNetcdfRgbImage {
    const { ds, shape, dims } = this.openVariable(variable);
    const ny = shape[shape.length - 2];
    const nx = shape[shape.length - 1];
    const axisPosition = leadingAxisPosition(dims, shape, options.axis);
    const fillValue = h5FillValue(ds);
    const whole = resolveWindow(undefined, ny, nx);

    const channels = options.indices.map((index) =>
      this.readPlane(
        ds,
        shape,
        dims,
        { ...options.selector, [dims[axisPosition]]: index },
        variable,
        whole,
      ),
    );
    const { lat, lon } = this.readCoordinates(ny, nx, variable);
    return composeRgbImage({
      ny,
      nx,
      channels,
      lat: lat.data,
      lon: lon.data,
      fillValue,
      scaleFactor: h5NumericAttr(ds, "scale_factor"),
      addOffset: h5NumericAttr(ds, "add_offset"),
      stretchPercent: options.stretchPercent,
      maxSize: options.maxSize,
    });
  }

  readGrid(
    variable: string,
    selector: Record<string, number> = {},
    window?: LocalNetcdfWindow,
  ): LocalNetcdfGrid {
    const { ds, shape, dims } = this.openVariable(variable);
    const ny = shape[shape.length - 2];
    const nx = shape[shape.length - 1];
    const view = resolveWindow(window, ny, nx);
    const { lat, lon } = this.readCoordinates(ny, nx, variable);
    const values = this.readPlane(ds, shape, dims, selector, variable, view);
    const fillValue = h5FillValue(ds);
    const scaleFactor = h5NumericAttr(ds, "scale_factor");
    const addOffset = h5NumericAttr(ds, "add_offset");
    return {
      ny: view.outRows,
      nx: view.outColumns,
      values,
      lat: decimateCoordinate(lat.data, view.row, view.outRows, view.step),
      lon: decimateCoordinate(lon.data, view.column, view.outColumns, view.step),
      fillValue,
      scaleFactor,
      addOffset,
      dataClim: percentileClim(values, { fillValue, scale: scaleFactor, offset: addOffset }) ?? [
        0, 1,
      ],
    };
  }

  readProfile(variable: string, options: LocalNetcdfProfileOptions): LocalNetcdfProfile {
    const { ds, shape, dims } = this.openVariable(variable);
    const axisPosition = leadingAxisPosition(dims, shape, options.axis);
    const ny = shape[shape.length - 2];
    const nx = shape[shape.length - 1];
    const row = clampIndex(options.row, ny);
    const column = clampIndex(options.column, nx);

    // One hyperslab spanning the whole profile axis at a single cell. Reading
    // the axis in one call matters: a chunked cube would otherwise fault in the
    // same chunks once per band.
    const ranges: Array<[] | [number, number]> = [];
    for (let i = 0; i < shape.length - 2; i++) {
      if (i === axisPosition) {
        ranges.push([0, shape[i]]);
        continue;
      }
      const index = clampIndex(options.selector?.[dims[i]] ?? 0, shape[i]);
      ranges.push([index, index + 1]);
    }
    ranges.push([row, row + 1]);
    ranges.push([column, column + 1]);

    const raw = ds.slice(ranges);
    if (!isTypedArray(raw)) {
      throw new Error(`Could not read a profile for variable "${variable}".`);
    }
    return {
      axis: this.describeAxis(dims[axisPosition], shape[axisPosition], variable),
      values: unpackProfile(raw, {
        fillValue: h5FillValue(ds),
        scale: h5NumericAttr(ds, "scale_factor"),
        offset: h5NumericAttr(ds, "add_offset"),
      }),
    };
  }

  /** Resolve a variable path to its dataset, shape, and dimension names. */
  private openVariable(variable: string): {
    ds: H5Dataset;
    shape: number[];
    dims: string[];
  } {
    const ds = tryGet(this.file, variable);
    if (!isDataset(ds)) {
      throw new Error(`Variable "${variable}" not found in the file.`);
    }
    const shape = ds.shape ?? ds.metadata.shape ?? [];
    if (shape.length < 2) {
      throw new Error(`Variable "${variable}" is not a 2-D+ grid.`);
    }
    // Re-checked here (not only in listVariables) because these entry points are
    // public API and may be called with a variable that never passed that filter.
    if (!isRenderableH5Dtype(ds.metadata)) {
      throw new Error(`Variable "${variable}" has an unsupported data type.`);
    }
    return { ds, shape, dims: this.dimensionNames(ds, shape) };
  }

  /**
   * Read one 2-D plane, fixing every leading dimension from `selector` and
   * restricting the spatial extent to `view`.
   */
  private readPlane(
    ds: H5Dataset,
    shape: number[],
    dims: string[],
    selector: Record<string, number>,
    variable: string,
    view: ResolvedWindow,
  ): TypedArrayLike {
    // The hyperslab: one index per leading dim, the window's extent for y and x.
    // Asking HDF5 for only the window is what keeps a cube read affordable —
    // the library faults in whole chunks, so a narrow request touches far fewer
    // of them than a full plane does.
    const ranges: Array<[] | [number, number]> = [];
    for (let i = 0; i < shape.length - 2; i++) {
      const idx = clampIndex(selector[dims[i]] ?? 0, shape[i]);
      ranges.push([idx, idx + 1]);
    }
    ranges.push([view.row, view.row + view.rows]);
    ranges.push([view.column, view.column + view.columns]);

    const data = ds.slice(ranges);
    if (!isTypedArray(data)) {
      throw new Error(`Could not read data for variable "${variable}".`);
    }
    return decimatePlane(data, view);
  }

  /**
   * Dimension names for a dataset, best effort and in this order:
   *
   * 1. HDF5 dimension *labels*, when the writer set them.
   * 2. The NetCDF-4 dimension ids in `_Netcdf4Coordinates`, resolved through the
   *    file's dimension scales. This is the case that matters in practice —
   *    netCDF-4 writers (EMIT among them) attach dimension *scales* and leave the
   *    label list empty, so without this every axis reads back as `dim_0`.
   * 3. `dim_<i>` for an axis nothing names.
   */
  private dimensionNames(ds: H5Dataset, shape: number[]): string[] {
    let labels: Array<string | null> = [];
    try {
      labels = ds.get_dimension_labels() ?? [];
    } catch {
      labels = [];
    }
    const dimIds = h5NumericArrayAttr(ds, "_Netcdf4Coordinates");
    const scales = dimIds ? this.dimensionScaleNames() : null;
    return shape.map((_, i) => {
      if (labels[i]) return labels[i] as string;
      const scaleName = dimIds && scales ? scales.get(dimIds[i]) : undefined;
      return scaleName ?? `dim_${i}`;
    });
  }

  /** NetCDF-4 dimension id -> dimension name, from the file's dimension scales. */
  private dimensionScaleNames(): Map<number, string> {
    if (this.scaleNames) return this.scaleNames;
    const names = new Map<number, string>();
    for (const path of this.datasetPaths()) {
      const ds = tryGet(this.file, path);
      if (!isDataset(ds)) continue;
      if (h5StringAttr(ds, "CLASS") !== "DIMENSION_SCALE") continue;
      const id = h5NumericAttr(ds, "_Netcdf4Dimid");
      if (id === undefined) continue;
      // A scale's own NAME is the netCDF dimension name; fall back to the
      // dataset's base name for a scale that omits it.
      const name = h5StringAttr(ds, "NAME") ?? path.split("/").pop() ?? path;
      // Ids are file-wide, so the first scale claiming one wins; a later
      // duplicate would be a malformed file.
      if (!names.has(id)) names.set(id, name);
    }
    this.scaleNames = names;
    return names;
  }

  /** The 1-D coordinate variable that labels an axis, when the file has one. */
  private findAxisCoordinate(
    name: string,
    size: number,
    variablePath: string,
  ): Pick<LocalNetcdfAxis, "values" | "units" | "longName"> | null {
    const slash = variablePath.lastIndexOf("/");
    const group = slash >= 0 ? variablePath.slice(0, slash) : "";
    for (const path of group ? [`${group}/${name}`, name] : [name]) {
      const entity = tryGet(this.file, path);
      if (!isDataset(entity)) continue;
      const shape = entity.shape ?? entity.metadata.shape ?? [];
      if (shape.length !== 1 || shape[0] !== size) continue;
      if (!isRenderableH5Dtype(entity.metadata)) continue;
      const raw = entity.value;
      if (!isTypedArray(raw)) continue;
      const scale = h5NumericAttr(entity, "scale_factor");
      const offset = h5NumericAttr(entity, "add_offset");
      const scaled =
        scale !== undefined || offset !== undefined
          ? applyScale(raw, scale ?? 1, offset ?? 0)
          : raw;
      return {
        values: Array.from(scaled, Number),
        ...optionalText("units", h5StringAttr(entity, "units")),
        ...optionalText("longName", h5StringAttr(entity, "long_name")),
      };
    }
    return null;
  }

  /** Read the variable's lat/lon coordinate arrays (see {@link acceptCoordinate}). */
  private readCoordinates(
    ny: number,
    nx: number,
    variable: string,
  ): { lat: Coordinate; lon: Coordinate } {
    const lat = this.readCoordinate(LAT_NAMES, ny, variable, LAT_RANGE);
    const lon = this.readCoordinate(LON_NAMES, nx, variable, LON_RANGE);
    if (!lat || !lon) {
      throw new Error(NO_COORDINATES_MESSAGE);
    }
    return { lat, lon };
  }

  /**
   * Find a 1-D coordinate variable by common names. Grouped files often keep
   * `lat`/`lon` in the same subgroup as the variable, so every candidate name in
   * the variable's own group is tried before falling back to root.
   */
  private readCoordinate(
    names: string[],
    length: number,
    variablePath: string,
    range: readonly [number, number],
  ): Coordinate | null {
    const slash = variablePath.lastIndexOf("/");
    const group = slash >= 0 ? variablePath.slice(0, slash) : "";
    const candidates = group ? [...names.map((name) => `${group}/${name}`), ...names] : names;
    for (const path of candidates) {
      const entity = tryGet(this.file, path);
      if (!isDataset(entity)) continue;
      const shape = entity.shape ?? entity.metadata.shape ?? [];
      if (shape.length !== 1 || shape[0] !== length) continue;
      if (!isRenderableH5Dtype(entity.metadata)) continue;
      const baseName = path.split("/").pop() ?? path;
      if (
        !isTrustedCoordinate(
          baseName,
          h5StringAttr(entity, "units"),
          h5StringAttr(entity, "standard_name"),
        )
      ) {
        continue;
      }
      const raw = entity.value;
      if (!isTypedArray(raw)) continue;
      const accepted = acceptCoordinate(
        raw,
        h5ZarrDtype(entity.metadata),
        h5NumericAttr(entity, "scale_factor"),
        h5NumericAttr(entity, "add_offset"),
        range,
      );
      if (accepted) return accepted;
    }
    return null;
  }
}

/**
 * A local classic NetCDF-3 file backed by netcdfjs (pure JS).
 */
class Netcdf3File implements LocalNetcdfFile {
  /**
   * Decoded variables, kept so repeated plane and profile reads decode once.
   * netcdfjs has no hyperslab read, so every read otherwise decodes and copies
   * the whole variable again — which the identify path would pay on each click.
   */
  private readonly decoded = new Map<string, TypedArrayLike>();

  private constructor(private readonly reader: NetCDFReader) {}

  /** The whole variable as a typed array, decoded at most once. */
  private fullVariable(v: Nc3Variable, info: (typeof NC3_DTYPES)[string]): TypedArrayLike {
    let cached = this.decoded.get(v.name);
    if (!cached) {
      cached = info.make(this.reader.getDataVariable(v.name) as number[]);
      this.decoded.set(v.name, cached);
    }
    return cached;
  }

  static async open(buffer: ArrayBuffer): Promise<Netcdf3File> {
    const { NetCDFReader } = await import("netcdfjs");
    try {
      return new Netcdf3File(new NetCDFReader(new Uint8Array(buffer)));
    } catch (err) {
      throw new Error(
        `Could not read the file as NetCDF-3. (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }

  close(): void {
    // netcdfjs is pure JS with no external resources to release, but the decode
    // cache holds a full copy of every variable read.
    this.decoded.clear();
  }

  private variables(): Nc3Variable[] {
    return this.reader.variables as unknown as Nc3Variable[];
  }

  private dims(v: Nc3Variable): string[] {
    return v.dimensions.map((i) => this.reader.dimensions[i]?.name ?? `dim_${i}`);
  }

  private shape(v: Nc3Variable): number[] {
    return v.dimensions.map((i) => {
      const dim = this.reader.dimensions[i];
      // A record (unlimited) dimension reports size 0; use the record length.
      return dim ? dim.size || this.reader.recordDimension.length : 0;
    });
  }

  listVariables(): LocalNetcdfVariable[] {
    const out: LocalNetcdfVariable[] = [];
    for (const v of this.variables()) {
      const shape = this.shape(v);
      if (shape.length < 2) continue;
      if (!NC3_DTYPES[v.type]) continue;
      out.push({
        name: v.name,
        dims: this.dims(v),
        shape,
        ...optionalText("longName", nc3StringAttr(v, "long_name")),
        ...optionalText("units", nc3StringAttr(v, "units")),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  listAxes(variable: string): LocalNetcdfAxis[] {
    const { shape, dims } = this.openVariable(variable);
    return dims
      .slice(0, Math.max(0, shape.length - 2))
      .map((name, index) => this.describeAxis(name, shape[index]));
  }

  /** One axis with its coordinate values, when the file provides them. */
  private describeAxis(name: string, size: number): LocalNetcdfAxis {
    return { name, size, ...(this.findAxisCoordinate(name, size) ?? {}) };
  }

  buildLayerRefs(variable: string, selector: Record<string, number> = {}): LocalNetcdfLayerRefs {
    const { v, shape, dims, info } = this.openVariable(variable);
    const ny = shape[shape.length - 2];
    const nx = shape[shape.length - 1];

    const sliceData = this.readPlane(
      v,
      shape,
      dims,
      info,
      selector,
      resolveWindow(undefined, ny, nx),
    );
    const fillValue = normalizeFillValue(
      nc3NumericAttr(v, "_FillValue", true) ?? nc3NumericAttr(v, "missing_value", true),
    );
    const lat = this.readCoordinate(LAT_NAMES, ny, LAT_RANGE);
    const lon = this.readCoordinate(LON_NAMES, nx, LON_RANGE);
    if (!lat || !lon) throw new Error(NO_COORDINATES_MESSAGE);

    const { refs, bounds } = buildInlineZarrStore({
      variable,
      ny,
      nx,
      data: sliceData,
      dtype: info.dtype,
      lat: lat.data,
      latDtype: lat.dtype,
      lon: lon.data,
      lonDtype: lon.dtype,
      fillValue,
      scaleFactor: nc3NumericAttr(v, "scale_factor"),
      addOffset: nc3NumericAttr(v, "add_offset"),
    });
    return {
      refs,
      variable,
      bounds,
      clim: percentileClim(sliceData, {
        fillValue,
        scale: nc3NumericAttr(v, "scale_factor"),
        offset: nc3NumericAttr(v, "add_offset"),
      }),
    };
  }

  buildRgbImage(variable: string, options: LocalNetcdfRgbOptions): LocalNetcdfRgbImage {
    const { v, shape, dims, info } = this.openVariable(variable);
    const ny = shape[shape.length - 2];
    const nx = shape[shape.length - 1];
    const axisPosition = leadingAxisPosition(dims, shape, options.axis);
    const whole = resolveWindow(undefined, ny, nx);

    const channels = options.indices.map((index) =>
      this.readPlane(
        v,
        shape,
        dims,
        info,
        { ...options.selector, [dims[axisPosition]]: index },
        whole,
      ),
    );
    const lat = this.readCoordinate(LAT_NAMES, ny, LAT_RANGE);
    const lon = this.readCoordinate(LON_NAMES, nx, LON_RANGE);
    if (!lat || !lon) throw new Error(NO_COORDINATES_MESSAGE);

    return composeRgbImage({
      ny,
      nx,
      channels,
      lat: lat.data,
      lon: lon.data,
      fillValue: normalizeFillValue(
        nc3NumericAttr(v, "_FillValue", true) ?? nc3NumericAttr(v, "missing_value", true),
      ),
      scaleFactor: nc3NumericAttr(v, "scale_factor"),
      addOffset: nc3NumericAttr(v, "add_offset"),
      stretchPercent: options.stretchPercent,
      maxSize: options.maxSize,
    });
  }

  readGrid(
    variable: string,
    selector: Record<string, number> = {},
    window?: LocalNetcdfWindow,
  ): LocalNetcdfGrid {
    const { v, shape, dims, info } = this.openVariable(variable);
    const ny = shape[shape.length - 2];
    const nx = shape[shape.length - 1];
    const lat = this.readCoordinate(LAT_NAMES, ny, LAT_RANGE);
    const lon = this.readCoordinate(LON_NAMES, nx, LON_RANGE);
    if (!lat || !lon) throw new Error(NO_COORDINATES_MESSAGE);

    const view = resolveWindow(window, ny, nx);
    const values = this.readPlane(v, shape, dims, info, selector, view);
    const fillValue = normalizeFillValue(
      nc3NumericAttr(v, "_FillValue", true) ?? nc3NumericAttr(v, "missing_value", true),
    );
    const scaleFactor = nc3NumericAttr(v, "scale_factor");
    const addOffset = nc3NumericAttr(v, "add_offset");
    return {
      ny: view.outRows,
      nx: view.outColumns,
      values,
      lat: decimateCoordinate(lat.data, view.row, view.outRows, view.step),
      lon: decimateCoordinate(lon.data, view.column, view.outColumns, view.step),
      fillValue,
      scaleFactor,
      addOffset,
      dataClim: percentileClim(values, { fillValue, scale: scaleFactor, offset: addOffset }) ?? [
        0, 1,
      ],
    };
  }

  readProfile(variable: string, options: LocalNetcdfProfileOptions): LocalNetcdfProfile {
    const { v, shape, dims, info } = this.openVariable(variable);
    const axisPosition = leadingAxisPosition(dims, shape, options.axis);
    const ny = shape[shape.length - 2];
    const nx = shape[shape.length - 1];
    const row = clampIndex(options.row, ny);
    const column = clampIndex(options.column, nx);

    // netcdfjs has no hyperslab read, so index the whole variable in JS.
    const full = this.fullVariable(v, info);
    const size = shape[axisPosition];
    const raw = info.make(new Array(size).fill(0));
    for (let step = 0; step < size; step++) {
      let lead = 0; // C-order flattening of the leading indices
      for (let i = 0; i < shape.length - 2; i++) {
        const index =
          i === axisPosition ? step : clampIndex(options.selector?.[dims[i]] ?? 0, shape[i]);
        lead = lead * shape[i] + index;
      }
      raw[step] = full[lead * ny * nx + row * nx + column];
    }

    return {
      axis: this.describeAxis(dims[axisPosition], size),
      values: unpackProfile(raw, {
        fillValue: normalizeFillValue(
          nc3NumericAttr(v, "_FillValue", true) ?? nc3NumericAttr(v, "missing_value", true),
        ),
        scale: nc3NumericAttr(v, "scale_factor"),
        offset: nc3NumericAttr(v, "add_offset"),
      }),
    };
  }

  private openVariable(variable: string): {
    v: Nc3Variable;
    shape: number[];
    dims: string[];
    info: (typeof NC3_DTYPES)[string];
  } {
    const v = this.variables().find((x) => x.name === variable);
    if (!v) throw new Error(`Variable "${variable}" not found in the file.`);
    const shape = this.shape(v);
    if (shape.length < 2) {
      throw new Error(`Variable "${variable}" is not a 2-D+ grid.`);
    }
    const info = NC3_DTYPES[v.type];
    if (!info) {
      throw new Error(`Variable "${variable}" has an unsupported data type.`);
    }
    return { v, shape, dims: this.dims(v), info };
  }

  /**
   * Read one 2-D plane, fixing every leading dimension from `selector` and
   * restricting the spatial extent to `view`.
   */
  private readPlane(
    v: Nc3Variable,
    shape: number[],
    dims: string[],
    info: (typeof NC3_DTYPES)[string],
    selector: Record<string, number>,
    view: ResolvedWindow,
  ): TypedArrayLike {
    const ny = shape[shape.length - 2];
    const nx = shape[shape.length - 1];
    // netcdfjs reads the whole variable; slice the selected 2-D plane in JS.
    const full = this.fullVariable(v, info);
    let lead = 0; // C-order flattening of the leading (non-spatial) indices
    for (let i = 0; i < shape.length - 2; i++) {
      lead = lead * shape[i] + clampIndex(selector[dims[i]] ?? 0, shape[i]);
    }
    const start = lead * ny * nx;
    const plane = full.subarray(start, start + ny * nx);
    // Unlike HDF5 there is nothing to save on the read itself (the variable is
    // already decoded whole), so the window is a pure crop-and-decimate of the
    // plane, applied here so both backends return the same shape.
    if (view.row === 0 && view.column === 0 && view.rows === ny && view.columns === nx) {
      return decimatePlane(plane, view);
    }
    const cropped = makeLike(plane, view.rows * view.columns);
    for (let y = 0; y < view.rows; y++) {
      const source = (view.row + y) * nx + view.column;
      const target = y * view.columns;
      for (let x = 0; x < view.columns; x++) cropped[target + x] = plane[source + x];
    }
    return decimatePlane(cropped, view);
  }

  /** The 1-D coordinate variable that labels an axis, when the file has one. */
  private findAxisCoordinate(
    name: string,
    size: number,
  ): Pick<LocalNetcdfAxis, "values" | "units" | "longName"> | null {
    const v = this.variables().find((x) => x.name === name);
    if (!v) return null;
    const shape = this.shape(v);
    if (shape.length !== 1 || shape[0] !== size) return null;
    const info = NC3_DTYPES[v.type];
    if (!info) return null;
    const raw = info.make(this.reader.getDataVariable(v.name) as number[]);
    const scale = nc3NumericAttr(v, "scale_factor");
    const offset = nc3NumericAttr(v, "add_offset");
    const scaled =
      scale !== undefined || offset !== undefined ? applyScale(raw, scale ?? 1, offset ?? 0) : raw;
    return {
      values: Array.from(scaled, Number),
      ...optionalText("units", nc3StringAttr(v, "units")),
      ...optionalText("longName", nc3StringAttr(v, "long_name")),
    };
  }

  private readCoordinate(
    names: string[],
    length: number,
    range: readonly [number, number],
  ): Coordinate | null {
    for (const name of names) {
      const v = this.variables().find((x) => x.name === name);
      if (!v) continue;
      const shape = this.shape(v);
      if (shape.length !== 1 || shape[0] !== length) continue;
      const info = NC3_DTYPES[v.type];
      if (!info) continue;
      if (
        !isTrustedCoordinate(name, nc3StringAttr(v, "units"), nc3StringAttr(v, "standard_name"))
      ) {
        continue;
      }
      const raw = info.make(this.reader.getDataVariable(v.name) as number[]);
      const accepted = acceptCoordinate(
        raw,
        info.dtype,
        nc3NumericAttr(v, "scale_factor"),
        nc3NumericAttr(v, "add_offset"),
        range,
      );
      if (accepted) return accepted;
    }
    return null;
  }
}

/**
 * Open a local NetCDF/HDF file from its raw bytes, choosing the backend by the
 * file's magic bytes: classic NetCDF-3 via netcdfjs, HDF5/NetCDF-4 via h5wasm.
 *
 * @param buffer The file bytes.
 * @returns An open {@link LocalNetcdfFile}.
 * @throws If the file is neither a readable NetCDF-3 nor HDF5/NetCDF-4 file.
 */
export async function openLocalNetcdf(buffer: ArrayBuffer): Promise<LocalNetcdfFile> {
  const head = new Uint8Array(buffer.slice(0, HDF5_MAGIC.length));
  if (isNetcdf3Signature(head)) return Netcdf3File.open(buffer);
  if (isHdf5Signature(head)) return Hdf5NetcdfFile.open(buffer);
  // Unknown signature (e.g. an HDF5 file with a user block): try HDF5, then
  // fall back to NetCDF-3 before giving up.
  try {
    return await Hdf5NetcdfFile.open(buffer);
  } catch {
    return Netcdf3File.open(buffer);
  }
}

/**
 * Open a **remote** HDF5/NetCDF-4 file over HTTP without downloading it, reading
 * only the byte ranges the caller actually touches.
 *
 * Backed by emscripten's lazy filesystem, which faults in 1 MiB ranges on
 * demand. Two consequences the caller has to live with:
 *
 * - It uses **synchronous** `XMLHttpRequest`, which browsers forbid on the main
 *   thread, so this only runs inside a Web Worker. It throws a clear error
 *   rather than emscripten's `abort()` when called anywhere else.
 * - Those requests are issued one at a time with no readahead, so a read that
 *   touches many ranges is latency-bound. Reading one 285-band EMIT scene's
 *   band plane pulls ~135 MB of a 1.1 GB file (an 8x saving) but takes ~20 s,
 *   and a whole-band-axis profile at one pixel takes ~35 s. It is the right
 *   trade for a cube far larger than the slice wanted, and the wrong one for a
 *   file small enough to just fetch (see {@link openLocalNetcdf}).
 *
 * The server must send `Accept-Ranges: bytes` and permit the origin via CORS;
 * without byte serving emscripten silently falls back to fetching everything, so
 * {@link assertByteServing} checks for it up front rather than letting a 1 GB
 * cube download itself one blocking chunk at a time.
 *
 * @param url The file's URL.
 * @param name A filesystem name for the mount, unique per open.
 * @returns An open {@link LocalNetcdfFile}, identical in behaviour to a local one.
 * @throws If called outside a worker, the server does not serve byte ranges, or
 *   the file is not readable as HDF5.
 */
export async function openRemoteNetcdf(url: string, name?: string): Promise<LocalNetcdfFile> {
  // `WorkerGlobalScope` is absent on the main thread, where the sync XHR below
  // would abort the whole WASM module rather than throw something catchable.
  if (typeof WorkerGlobalScope === "undefined") {
    throw new Error(
      "Reading a NetCDF/HDF file over HTTP without downloading it needs a Web Worker (it uses synchronous range requests).",
    );
  }
  await assertByteServing(url);
  return Hdf5NetcdfFile.openLazy(url, name ?? `geolibre-remote-${fileCounter++}.h5`);
}

/**
 * Reject a URL whose server will not serve byte ranges, before anything mounts it.
 *
 * The lazy filesystem has no way to report this: a server that ignores `Range`
 * answers with the whole entity, which emscripten accepts, so the "read only what
 * you look at" mount quietly becomes a full download — issued as blocking
 * synchronous requests, which for a 1 GB cube is an unresponsive worker with no
 * error and no progress. One 1-byte request up front turns that into a message.
 *
 * The status is the check that matters: `206` cannot be faked by a server that
 * ignored the header, and unlike `Content-Range` it is readable cross-origin
 * regardless of `Access-Control-Expose-Headers` — so a range-capable server that
 * simply does not expose that header must still pass. It is validated only when
 * the response actually carries it.
 *
 * @param url The file's URL.
 * @throws If the URL is unreachable, errors, or answers a range request whole.
 */
export async function assertByteServing(url: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Range: "bytes=0-0" } });
  } catch (err) {
    throw new Error(
      `Could not reach ${url}. The server must allow cross-origin requests. (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  // A server that ignored the range is answering with the entire file; drop the
  // body before it streams rather than after.
  void response.body?.cancel().catch(() => {});
  if (!response.ok) {
    throw new Error(`The server answered ${response.status} ${response.statusText} for ${url}.`);
  }
  if (response.status !== 206) {
    throw new Error(
      `${url} cannot be read in place: the server ignored a byte-range request (answered ${response.status}, not 206). Download the file and open it locally instead.`,
    );
  }
  const contentRange = response.headers.get("content-range");
  if (contentRange && !/^\s*bytes\s+0-0\//i.test(contentRange)) {
    throw new Error(
      `${url} cannot be read in place: the server answered a byte-range request with an unexpected range ("${contentRange}").`,
    );
  }
}

/** Whether the bytes start with the HDF5 signature. */
function isHdf5Signature(bytes: Uint8Array): boolean {
  if (bytes.length < HDF5_MAGIC.length) return false;
  return HDF5_MAGIC.every((b, i) => bytes[i] === b);
}

/** Whether the bytes start with a classic NetCDF-3 signature (`CDF` + version). */
function isNetcdf3Signature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x43 && // C
    bytes[1] === 0x44 && // D
    bytes[2] === 0x46 && // F
    (bytes[3] === 1 || bytes[3] === 2 || bytes[3] === 5)
  );
}

// --- Shared coordinate + fill helpers ----------------------------------------

/** A resolved coordinate array plus its emitted Zarr dtype. */
interface Coordinate {
  data: TypedArrayLike;
  dtype: string;
}

const NO_COORDINATES_MESSAGE =
  "Could not find geographic latitude/longitude coordinate variables. Only NetCDF/HDF grids on a WGS84 lat/lon axis are supported.";

/**
 * Apply a coordinate's scale_factor/add_offset (so packed scaled-integer lat/lon
 * become degrees) and reject it unless every value is finite and inside the
 * geographic range (guards generic `x`/`y` projected axes in metres).
 */
function acceptCoordinate(
  raw: TypedArrayLike,
  nativeDtype: string,
  scale: number | undefined,
  offset: number | undefined,
  range: readonly [number, number],
): Coordinate | null {
  const { data, dtype }: Coordinate =
    scale !== undefined || offset !== undefined
      ? { data: applyScale(raw, scale ?? 1, offset ?? 0), dtype: "<f8" }
      : { data: raw, dtype: nativeDtype };
  return valuesWithin(data, range) ? { data, dtype } : null;
}

/**
 * Whether a candidate coordinate should be accepted for the given name. A
 * strong name (lat/latitude/lon/longitude/...) is trusted directly; a generic
 * `x`/`y` is only trusted when a CF `units` ("degrees_north"/"degrees_east"/...)
 * or `standard_name` ("latitude"/"longitude") attribute confirms it is
 * geographic, so projected/pixel-index axes are not read as degrees.
 *
 * @param name The candidate variable's base name (case-insensitive).
 * @param units The variable's `units` attribute, if any.
 * @param standardName The variable's `standard_name` attribute, if any.
 */
function isTrustedCoordinate(
  name: string,
  units: string | undefined,
  standardName: string | undefined,
): boolean {
  if (!GENERIC_COORD_NAMES.has(name.toLowerCase())) return true;
  if (units && /degree/i.test(units)) return true;
  const s = standardName?.toLowerCase();
  return s === "latitude" || s === "longitude";
}

/**
 * Normalize a fill/nodata value into a Zarr v2 fill value. Non-finite values
 * need their string form; a bare Infinity would otherwise be turned into null
 * by JSON.stringify, dropping the marker.
 */
function normalizeFillValue(value: number | undefined): number | string | null {
  if (typeof value !== "number") return null;
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  return value;
}

// --- Zarr v2 emission ---------------------------------------------------------

/** A single georeferenced 2-D grid ready to inline as a Zarr v2 store. */
export interface InlineZarrGrid {
  /** Variable (array) name to render. */
  variable: string;
  /** Number of rows (y/lat extent). */
  ny: number;
  /** Number of columns (x/lon extent). */
  nx: number;
  /** Row-major (C-order) grid values, length `ny * nx`. */
  data: TypedArrayLike;
  /** Zarr v2 dtype for the data array (e.g. `<f4`). */
  dtype: string;
  /** Latitude coordinate values, length `ny`. */
  lat: TypedArrayLike;
  /** Zarr v2 dtype for the latitude array. */
  latDtype: string;
  /** Longitude coordinate values, length `nx`. */
  lon: TypedArrayLike;
  /** Zarr v2 dtype for the longitude array. */
  lonDtype: string;
  /** Fill/nodata value (number, `"NaN"`, or null). */
  fillValue?: number | string | null;
  /** Optional `scale_factor` attribute (applied by the renderer). */
  scaleFactor?: number;
  /** Optional `add_offset` attribute (applied by the renderer). */
  addOffset?: number;
}

/**
 * Build a self-contained Zarr v2 reference map for one georeferenced 2-D grid.
 *
 * The data variable is emitted as a single `[ny, nx]` uncompressed chunk with
 * `_ARRAY_DIMENSIONS: ["lat", "lon"]`, alongside `lat` and `lon` coordinate
 * arrays keyed by those exact names so @carbonplan/zarr-layer identifies the
 * spatial dimensions and derives bounds/orientation from the coordinates.
 *
 * @param grid The grid values, coordinate arrays, dtypes, and optional
 *   fill/scale/offset attributes.
 * @returns A {@link KerchunkRefs} map (inline `base64:` chunks) ready for
 *   `addCloudNetcdfLayer({ refs })`.
 */
export function buildInlineZarrRefs(grid: InlineZarrGrid): KerchunkRefs {
  return buildInlineZarrStore(grid).refs;
}

/**
 * {@link buildInlineZarrRefs} plus the grid's geographic extent.
 *
 * The extent has to come from here rather than from the caller's own lat/lon,
 * because the longitude roll below can move the data: reporting the pre-roll
 * extent would fly the camera to the wrong hemisphere. It is what makes "Zoom
 * to layer" work for the resulting layer — the renderer never tells the host
 * where the grid landed.
 *
 * @param grid The grid values, coordinate arrays, dtypes, and optional
 *   fill/scale/offset attributes.
 * @returns The reference map and its `[west, south, east, north]` extent.
 */
export function buildInlineZarrStore(grid: InlineZarrGrid): {
  refs: KerchunkRefs;
  bounds: [number, number, number, number];
} {
  // The coordinate arrays are always written under the fixed keys `lat`/`lon`,
  // so a data variable literally named `lat`/`lon` would collide with them.
  if (grid.variable === "lat" || grid.variable === "lon") {
    throw new Error(`Variable name "${grid.variable}" collides with a coordinate array.`);
  }
  const refs: KerchunkRefs = { ".zgroup": '{"zarr_format":2}' };

  // The map spans -180..180. Data on a 0..360 longitude grid would otherwise
  // render in the eastern hemisphere only, so roll it to -180..180 first.
  const rolled = rollLongitude(grid);
  const data = rolled?.data ?? grid.data;
  const lon = rolled?.lon ?? grid.lon;
  const lonDtype = rolled ? "<f8" : grid.lonDtype;

  const attrs: Record<string, unknown> = { _ARRAY_DIMENSIONS: ["lat", "lon"] };
  if (grid.scaleFactor !== undefined) attrs.scale_factor = grid.scaleFactor;
  if (grid.addOffset !== undefined) attrs.add_offset = grid.addOffset;

  writeZarrArray(refs, grid.variable, {
    shape: [grid.ny, grid.nx],
    dtype: grid.dtype,
    data: typedArrayBytes(data),
    fillValue: grid.fillValue ?? null,
    attrs,
  });
  writeZarrArray(refs, "lat", {
    shape: [grid.ny],
    dtype: grid.latDtype,
    data: typedArrayBytes(grid.lat),
    attrs: { _ARRAY_DIMENSIONS: ["lat"] },
  });
  writeZarrArray(refs, "lon", {
    shape: [grid.nx],
    dtype: lonDtype,
    data: typedArrayBytes(lon),
    attrs: { _ARRAY_DIMENSIONS: ["lon"] },
  });
  return { refs, bounds: gridBounds(grid.lat, lon) };
}

/**
 * The geographic extent covered by a grid, from its cell-centre coordinates.
 *
 * Coordinate arrays name cell *centres*, so the extent runs half a cell past the
 * first and last entry — without that a single-row grid would have zero height
 * and `fitBounds` would refuse it.
 *
 * @param lat Latitude cell centres.
 * @param lon Longitude cell centres.
 * @returns `[west, south, east, north]`, clamped to valid WGS84 ranges.
 */
export function gridBounds(
  lat: ArrayLike<number>,
  lon: ArrayLike<number>,
): [number, number, number, number] {
  const [south, north] = centresToEdges(lat);
  const [west, east] = centresToEdges(lon);
  return [Math.max(-180, west), Math.max(-90, south), Math.min(180, east), Math.min(90, north)];
}

/** Min/max of cell centres, expanded by half the mean cell size. */
function centresToEdges(values: ArrayLike<number>): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 0];
  // A one-cell axis has no spacing to derive; leave it as a degenerate point
  // rather than inventing a width.
  const half = values.length > 1 ? (max - min) / (values.length - 1) / 2 : 0;
  return [min - half, max + half];
}

/**
 * Roll a grid whose longitude runs 0..360 into a -180..180 layout, reordering
 * both the longitude coordinate and the data columns. Returns null (no change)
 * for grids already on a -180..180 (or non-monotonic) longitude axis.
 *
 * @param grid The grid to inspect.
 * @returns The rolled data and longitude, or null if no roll is needed.
 */
function rollLongitude(grid: InlineZarrGrid): { data: TypedArrayLike; lon: Float64Array } | null {
  const { nx, ny } = grid;
  const split = longitudeRollSplit(grid.lon, nx);
  if (split === null) return null;

  const newLon = rollLongitudeValues(grid.lon, split);
  const src = grid.data;
  const dst = emptyLike(src);
  for (let r = 0; r < ny; r++) {
    const row = r * nx;
    for (let j = 0; j < nx - split; j++) dst[row + j] = src[row + split + j];
    for (let j = 0; j < split; j++) dst[row + nx - split + j] = src[row + j];
  }
  return { data: dst, lon: newLon };
}

/**
 * The column a 0..360 longitude axis has to be rotated about to become
 * -180..180, or null when the axis needs no roll.
 *
 * Shared by the Zarr and RGB paths so a global grid lands in the same place
 * whichever one draws it.
 *
 * @param lon The longitude cell centres.
 * @param nx Their count.
 * @returns The index of the first entry at or past 180, or null.
 */
function longitudeRollSplit(lon: ArrayLike<number>, nx: number): number | null {
  let min = Infinity;
  let max = -Infinity;
  let ascending = true;
  for (let i = 0; i < nx; i++) {
    const v = Number(lon[i]);
    // A non-finite entry disables rolling (leaving the array untouched) rather
    // than silently mis-splitting: NaN comparisons are always false.
    if (!Number.isFinite(v)) {
      ascending = false;
      continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
    if (i > 0 && v <= Number(lon[i - 1])) ascending = false;
  }
  // Only the clean, common case: strictly-increasing longitudes in [0, 360)
  // that cross the 180 meridian. Grids that reach exactly 360 (an inclusive
  // 0..360 axis, sometimes with a duplicated 0/360 seam column) are left
  // un-rolled: rolling them correctly needs seam handling that is out of scope
  // here, and they render at their native longitudes rather than incorrectly.
  if (!ascending || min < 0 || max <= 180 || max >= 360) return null;
  let split = 0;
  while (split < nx && Number(lon[split]) < 180) split++;
  return split === 0 || split >= nx ? null : split;
}

/** Rotate a longitude axis about `split`, wrapping the tail to negative degrees. */
function rollLongitudeValues(lon: ArrayLike<number>, split: number): Float64Array {
  const nx = lon.length;
  const rolled = new Float64Array(nx);
  for (let j = 0; j < nx - split; j++) rolled[j] = Number(lon[split + j]) - 360;
  for (let j = 0; j < split; j++) rolled[nx - split + j] = Number(lon[j]);
  return rolled;
}

/** Allocate a new, zero-filled typed array of the same kind and length. */
function emptyLike(a: TypedArrayLike): TypedArrayLike {
  const Ctor = a.constructor as { new (length: number): TypedArrayLike };
  return new Ctor(a.length);
}

interface ZarrArraySpec {
  shape: number[];
  dtype: string;
  data: Uint8Array;
  fillValue?: number | string | null;
  attrs: Record<string, unknown>;
}

/**
 * Write the `.zarray`, `.zattrs`, and single inline chunk for one array into a
 * reference map. The chunk spans the whole array (chunks == shape), so the key
 * is `name/0`, `name/0.0`, ... depending on rank.
 */
function writeZarrArray(refs: KerchunkRefs, name: string, spec: ZarrArraySpec): void {
  refs[`${name}/.zarray`] = JSON.stringify({
    zarr_format: 2,
    shape: spec.shape,
    chunks: spec.shape,
    dtype: spec.dtype,
    compressor: null,
    fill_value: spec.fillValue ?? null,
    filters: null,
    order: "C",
  });
  refs[`${name}/.zattrs`] = JSON.stringify(spec.attrs);
  const chunkKey = `${name}/${spec.shape.map(() => "0").join(".")}`;
  refs[chunkKey] = `base64:${base64Encode(spec.data)}`;
}

type TypedArrayLike =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

// --- Value statistics + RGB composition ---------------------------------------

/** Default percentile trimmed off each end of a channel/color range. */
const DEFAULT_STRETCH_PERCENT = 2;
/** Default cap on the longest edge of a composed RGB image. */
const DEFAULT_MAX_IMAGE_SIZE = 4096;
/** Ceiling on the sample drawn for a percentile; larger grids are strided. */
const MAX_PERCENTILE_SAMPLES = 200_000;

/** How to read physical values back out of a packed/fill-coded grid. */
interface ValueDecoding {
  /** The grid's `_FillValue`/`missing_value`, in its Zarr-normalized form. */
  fillValue?: number | string | null;
  /** CF `scale_factor`, when the grid is packed. */
  scale?: number;
  /** CF `add_offset`, when the grid is packed. */
  offset?: number;
}

/**
 * Robust color limits for a grid: the `stretchPercent`/`100 - stretchPercent`
 * percentiles of its finite, non-fill values, in physical units.
 *
 * A NetCDF grid's natural range is rarely the renderer's stock 0-300 default —
 * reflectance is 0-1, a sensor zenith angle 0-90 — so without this the first
 * paint is a flat wash and the layer reads as broken. Percentiles rather than
 * min/max so a handful of outliers do not flatten everything else.
 *
 * @param data The raw (still packed) grid values.
 * @param decoding Fill value and any `scale_factor`/`add_offset`.
 * @param stretchPercent Percentile trimmed off each end (default 2).
 * @returns `[min, max]` in physical units, or null when the sample has no
 *   spread (an all-fill or constant grid).
 */
export function percentileClim(
  data: TypedArrayLike,
  decoding: ValueDecoding = {},
  stretchPercent = DEFAULT_STRETCH_PERCENT,
): [number, number] | null {
  const sample = sampleValues(data, decoding);
  if (sample.length === 0) return null;
  sample.sort((a, b) => a - b);
  const fraction = Math.min(Math.max(stretchPercent, 0), 49) / 100;
  const min = quantile(sample, fraction);
  const max = quantile(sample, 1 - fraction);
  // A constant (or near-constant) grid gives min === max, which the renderer
  // reads as a degenerate ramp; fall back to the untrimmed extremes, then give
  // up so the caller can leave the limits alone.
  if (min < max) return [min, max];
  const low = sample[0];
  const high = sample[sample.length - 1];
  return low < high ? [low, high] : null;
}

/** Finite, non-fill values in physical units, strided down to a bounded sample. */
function sampleValues(data: TypedArrayLike, decoding: ValueDecoding): number[] {
  const fill = typeof decoding.fillValue === "number" ? decoding.fillValue : null;
  const scale = decoding.scale ?? 1;
  const offset = decoding.offset ?? 0;
  const stride = Math.max(1, Math.ceil(data.length / MAX_PERCENTILE_SAMPLES));
  const out: number[] = [];
  for (let i = 0; i < data.length; i += stride) {
    const raw = Number(data[i]);
    if (!Number.isFinite(raw)) continue;
    if (fill !== null && raw === fill) continue;
    const value = raw * scale + offset;
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

/** Linearly interpolated quantile of an ascending sample. */
function quantile(sorted: number[], fraction: number): number {
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(sorted.length - 1, Math.ceil(position));
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** Inputs for {@link composeRgbImage}. */
export interface RgbComposition {
  /** Number of rows (y/lat extent) in every channel. */
  ny: number;
  /** Number of columns (x/lon extent) in every channel. */
  nx: number;
  /** Three same-shaped `ny * nx` planes: red, green, blue. */
  channels: TypedArrayLike[];
  /** Latitude cell centres, length `ny`, either ascending or descending. */
  lat: TypedArrayLike;
  /** Longitude cell centres, length `nx`. */
  lon: TypedArrayLike;
  /** Fill/nodata value shared by the channels; those cells go transparent. */
  fillValue?: number | string | null;
  /** CF `scale_factor`, when the channels are packed. */
  scaleFactor?: number;
  /** CF `add_offset`, when the channels are packed. */
  addOffset?: number;
  /** Percentile trimmed off each end of every channel (default 2). */
  stretchPercent?: number;
  /** Longest output edge; a larger grid is decimated to fit (default 4096). */
  maxSize?: number;
}

/**
 * Compose three grid planes into a north-up RGBA image plus the corner
 * coordinates a MapLibre `image` source needs.
 *
 * Each channel is stretched independently (the usual per-band percentile
 * stretch), so a natural-color composite from a hyperspectral cube is legible
 * without the user hand-tuning three sets of limits. Fill/nodata cells become
 * fully transparent rather than black, so the scene's ragged swath edges do not
 * paint a rectangle over the basemap.
 *
 * The output is always north-up and west-first regardless of how the file
 * orders its coordinates, because an `image` source's corners are fixed points
 * and cannot express a flipped axis.
 *
 * @param input The three channels, their coordinates, and the stretch options.
 * @returns The RGBA image, its extent, and the per-channel ranges used.
 * @throws If `channels` does not hold exactly three `ny * nx` planes.
 */
export function composeRgbImage(input: RgbComposition): LocalNetcdfRgbImage {
  const { ny, nx, channels } = input;
  if (channels.length !== 3) {
    throw new Error("An RGB composite needs exactly three channels.");
  }
  for (const channel of channels) {
    if (channel.length < ny * nx) {
      throw new Error("A channel is smaller than the grid it belongs to.");
    }
  }

  const decoding: ValueDecoding = {
    fillValue: input.fillValue,
    scale: input.scaleFactor,
    offset: input.addOffset,
  };
  const fill = typeof input.fillValue === "number" ? input.fillValue : null;
  const scale = input.scaleFactor ?? 1;
  const offset = input.addOffset ?? 0;
  const ranges = channels.map(
    (channel) => percentileClim(channel, decoding, input.stretchPercent) ?? [0, 1],
  ) as Array<[number, number]>;

  const layout = imageLayout(input);
  const pixels = new Uint8ClampedArray(layout.width * layout.height * 4);

  for (let row = 0; row < layout.height; row++) {
    for (let col = 0; col < layout.width; col++) {
      const index = layout.sourceIndex(row, col);
      const target = (row * layout.width + col) * 4;
      let opaque = true;
      for (let c = 0; c < 3; c++) {
        const raw = Number(channels[c][index]);
        if (!Number.isFinite(raw) || (fill !== null && raw === fill)) {
          opaque = false;
          break;
        }
        const [min, max] = ranges[c];
        const value = raw * scale + offset;
        pixels[target + c] = Math.round(((value - min) / (max - min)) * 255);
      }
      // Any missing channel makes the whole pixel transparent: a partly-filled
      // pixel would otherwise show as a saturated red/green/blue speck.
      if (!opaque) {
        pixels[target] = 0;
        pixels[target + 1] = 0;
        pixels[target + 2] = 0;
      }
      pixels[target + 3] = opaque ? 255 : 0;
    }
  }

  return {
    ...layout.frame(),
    width: layout.width,
    height: layout.height,
    pixels,
    channelRanges: ranges,
  };
}

/** Inputs for {@link composeColormappedImage}. */
export interface ColormapComposition {
  /** Number of rows (y/lat extent). */
  ny: number;
  /** Number of columns (x/lon extent). */
  nx: number;
  /** The `ny * nx` grid values. */
  values: TypedArrayLike;
  /** Latitude cell centres, length `ny`, either ascending or descending. */
  lat: TypedArrayLike;
  /** Longitude cell centres, length `nx`. */
  lon: TypedArrayLike;
  /** The ramp, sampled low-to-high. */
  colors: string[];
  /** Fill/nodata value; those cells go transparent. */
  fillValue?: number | string | null;
  /** CF `scale_factor`, when the values are packed. */
  scaleFactor?: number;
  /** CF `add_offset`, when the values are packed. */
  addOffset?: number;
  /** Color limits; defaults to {@link percentileClim} of the grid. */
  clim?: [number, number];
  /** Percentile trimmed off each end when `clim` is not given (default 2). */
  stretchPercent?: number;
  /** Longest output edge; a larger grid is decimated to fit (default 4096). */
  maxSize?: number;
}

/**
 * Paint a grid through a colormap into a north-up RGBA image plus the corner
 * coordinates a MapLibre `image` source needs — the CPU counterpart of the Zarr
 * renderer's GPU colormapping.
 *
 * This exists because the GPU path is not available everywhere: `@carbonplan/
 * zarr-layer` 0.7.0 looks up its `shift_x` uniform with a throwing getter, and
 * in the source-projected flat variant that uniform feeds only
 * `v_mercatorPos.x`, which the fragment shader never reads. Drivers that do
 * per-component varying elimination (Mesa, so most Linux Intel/AMD machines)
 * drop it, the lookup throws every frame, and the layer never paints. Rendering
 * the pixels here instead is driver-independent.
 *
 * Fill/nodata and non-finite cells become fully transparent, so a swath's ragged
 * edges do not paint a rectangle over the basemap.
 *
 * @param input The grid, its coordinates, the ramp, and the stretch options.
 * @returns The RGBA image, its extent, and the `[min, max]` actually used.
 * @throws If `colors` is empty or `values` is smaller than the grid.
 */
export function composeColormappedImage(input: ColormapComposition): LocalNetcdfColormappedImage {
  const { ny, nx, values } = input;
  if (input.colors.length === 0) {
    throw new Error("A colormapped image needs at least one color.");
  }
  if (values.length < ny * nx) {
    throw new Error("The value grid is smaller than the extent it belongs to.");
  }

  const fill = typeof input.fillValue === "number" ? input.fillValue : null;
  const scale = input.scaleFactor ?? 1;
  const offset = input.addOffset ?? 0;
  const clim =
    input.clim ??
    percentileClim(
      values,
      { fillValue: input.fillValue, scale: input.scaleFactor, offset: input.addOffset },
      input.stretchPercent,
    ) ??
    ([0, 1] as [number, number]);
  const ramp = input.colors.map(parseRampColor);
  const [min, max] = clim;
  // A degenerate range would divide by zero; pin every value to the ramp's
  // bottom rather than emitting NaN indices.
  const span = max - min || 1;

  const layout = imageLayout(input);
  const pixels = new Uint8ClampedArray(layout.width * layout.height * 4);

  for (let row = 0; row < layout.height; row++) {
    for (let col = 0; col < layout.width; col++) {
      const raw = Number(values[layout.sourceIndex(row, col)]);
      const target = (row * layout.width + col) * 4;
      if (!Number.isFinite(raw) || (fill !== null && raw === fill)) {
        pixels[target + 3] = 0;
        continue;
      }
      const value = raw * scale + offset;
      const ratio = Math.min(Math.max((value - min) / span, 0), 1);
      const [r, g, b] = ramp[Math.round(ratio * (ramp.length - 1))];
      pixels[target] = r;
      pixels[target + 1] = g;
      pixels[target + 2] = b;
      pixels[target + 3] = 255;
    }
  }

  return { ...layout.frame(), width: layout.width, height: layout.height, pixels, clim };
}

/** A `#rrggbb` (or `#rgb`) ramp stop as RGB channels; unparseable stops read black. */
function parseRampColor(color: string): [number, number, number] {
  let hex = color.trim().replace(/^#/, "");
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((channel) => channel + channel)
      .join("");
  }
  const numeric = Number.parseInt(hex, 16);
  if (hex.length !== 6 || !Number.isFinite(numeric)) return [0, 0, 0];
  return [(numeric >> 16) & 255, (numeric >> 8) & 255, numeric & 255];
}

/**
 * Whether a coordinate axis runs high-to-low, decided from its first and last
 * **finite** entries.
 *
 * The endpoints cannot be trusted blindly: a swath-edge quality artifact can
 * leave `NaN` in the first or last cell centre while the rest of the axis is
 * monotonic, and every comparison against `NaN` is false — which would read a
 * descending axis as ascending and mirror the image, over a `gridBounds` extent
 * computed from the same array that still comes out right. `centresToEdges`
 * already skips non-finite entries for exactly this reason.
 *
 * @param values The cell centres.
 * @param count How many of them the grid uses.
 * @returns True when the axis descends; false when it ascends, is flat, or has
 *   fewer than two finite entries to compare.
 */
function axisDescends(values: TypedArrayLike, count: number): boolean {
  let first: number | null = null;
  let last: number | null = null;
  for (let i = 0; i < count; i++) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) continue;
    if (first === null) first = v;
    last = v;
  }
  if (first === null || last === null) return false;
  return first > last;
}

/**
 * The output size and the source-index mapping shared by both image composers:
 * decimation to `maxSize`, the 0..360 longitude roll, and the row/column flips
 * that make the result north-up and west-first (an `image` source's corners are
 * fixed points and cannot express a flipped axis).
 */
function imageLayout(input: {
  ny: number;
  nx: number;
  lat: TypedArrayLike;
  lon: TypedArrayLike;
  maxSize?: number;
}): {
  width: number;
  height: number;
  sourceIndex: (row: number, col: number) => number;
  frame: () => Pick<LocalNetcdfImage, "bounds" | "coordinates">;
} {
  const { ny, nx } = input;
  // A 0..360 grid is rolled the same way the Zarr path rolls it, so the image
  // does not land in the wrong hemisphere.
  const split = longitudeRollSplit(input.lon, nx);
  const columnOf = (x: number): number => (split === null ? x : (x + split) % nx);
  const rolledLon = split === null ? input.lon : rollLongitudeValues(input.lon, split);

  const latDescending = axisDescends(input.lat, ny);
  const lonDescending = axisDescends(rolledLon, nx);

  const step = Math.max(
    1,
    Math.ceil(Math.max(ny, nx) / Math.max(1, input.maxSize ?? DEFAULT_MAX_IMAGE_SIZE)),
  );
  const height = Math.ceil(ny / step);
  const width = Math.ceil(nx / step);

  return {
    width,
    height,
    sourceIndex: (row, col) => {
      const sourceRow = latDescending ? row * step : ny - 1 - row * step;
      const sourceCol = lonDescending ? nx - 1 - col * step : col * step;
      return sourceRow * nx + columnOf(sourceCol);
    },
    frame: () => {
      const bounds = gridBounds(input.lat, rolledLon);
      const [west, south, east, north] = bounds;
      return {
        bounds,
        // MapLibre image-source order: top-left, top-right, bottom-right, bottom-left.
        coordinates: [
          [west, north],
          [east, north],
          [east, south],
          [west, south],
        ],
      };
    },
  };
}

/**
 * Unpack raw profile readings into physical units, nulling out fill and
 * non-finite entries so a chart breaks its line instead of plotting a spike at
 * the nodata value.
 *
 * @param raw The readings straight from the file.
 * @param decoding Fill value and any `scale_factor`/`add_offset`.
 * @returns One value (or null) per reading.
 */
function unpackProfile(raw: TypedArrayLike, decoding: ValueDecoding): Array<number | null> {
  const fill = typeof decoding.fillValue === "number" ? decoding.fillValue : null;
  const scale = decoding.scale ?? 1;
  const offset = decoding.offset ?? 0;
  return Array.from(raw, (entry) => {
    const value = Number(entry);
    if (!Number.isFinite(value) || (fill !== null && value === fill)) return null;
    const physical = value * scale + offset;
    return Number.isFinite(physical) ? physical : null;
  });
}

/** A grid cell, as row/column indices into the retained slice. */
export interface GridPixel {
  row: number;
  column: number;
  /** The cell centre's coordinates, which may differ from where the user clicked. */
  lng: number;
  lat: number;
  /** The cell's value in physical units, or null when it is fill/nodata. */
  value: number | null;
}

/**
 * The grid cell under a map click, by nearest cell centre.
 *
 * Nearest-neighbour rather than arithmetic from an origin and step, because a
 * NetCDF grid's coordinates are only usually regular; a search is a few thousand
 * comparisons and is exact either way.
 *
 * @param grid - The retained slice.
 * @param lng - Clicked longitude, in -180..180.
 * @param lat - Clicked latitude.
 * @returns The cell, or null when the click is outside the grid.
 */
export function gridPixelAt(grid: LocalNetcdfGrid, lng: number, lat: number): GridPixel | null {
  const row = nearestIndex(grid.lat, lat);
  // A grid written on a 0..360 axis keeps those longitudes even though the map
  // reports the click in -180..180, so try the wrapped value too.
  const column =
    nearestIndex(grid.lon, lng) ??
    (lng < 0 ? nearestIndex(grid.lon, lng + 360) : nearestIndex(grid.lon, lng - 360));
  if (row === null || column === null) return null;

  const raw = Number(grid.values[row * grid.nx + column]);
  const fill = typeof grid.fillValue === "number" ? grid.fillValue : null;
  const missing = !Number.isFinite(raw) || (fill !== null && raw === fill);
  const value = missing ? null : raw * (grid.scaleFactor ?? 1) + (grid.addOffset ?? 0);
  return {
    row,
    column,
    lng: Number(grid.lon[column]),
    lat: Number(grid.lat[row]),
    value: value !== null && Number.isFinite(value) ? value : null,
  };
}

/**
 * Index of the coordinate nearest `target`, or null when `target` falls more
 * than half a cell outside the axis (the click missed the grid).
 */
function nearestIndex(coordinates: ArrayLike<number>, target: number): number | null {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < coordinates.length; i++) {
    const distance = Math.abs(Number(coordinates[i]) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  if (best < 0) return null;
  // Half a cell of tolerance past the edge, so a click on the outermost row
  // still reads it while a click well outside reports a miss.
  const span =
    coordinates.length > 1
      ? Math.abs(Number(coordinates[coordinates.length - 1]) - Number(coordinates[0])) /
        (coordinates.length - 1)
      : 0;
  return bestDistance <= span / 2 + Number.EPSILON || span === 0 ? best : null;
}

/** Index of the leading dimension named `axis`, or a thrown explanation. */
function leadingAxisPosition(dims: string[], shape: number[], axis: string): number {
  const leading = Math.max(0, shape.length - 2);
  const position = dims.slice(0, leading).indexOf(axis);
  if (position < 0) {
    throw new Error(
      `"${axis}" is not one of this variable's non-spatial dimensions (${
        dims.slice(0, leading).join(", ") || "none"
      }).`,
    );
  }
  return position;
}

/** A `{ key: value }` fragment, or nothing when the value is absent/blank. */
function optionalText<K extends string>(
  key: K,
  value: string | undefined,
): Record<K, string> | Record<string, never> {
  return value ? ({ [key]: value } as Record<K, string>) : {};
}

/** Map an h5wasm datatype to a little-endian Zarr v2 dtype string. */
function h5ZarrDtype(meta: H5Metadata): string {
  if (meta.type === H5T_FLOAT) return `<f${meta.size}`;
  if (meta.type === H5T_INTEGER) return `${meta.signed ? "<i" : "<u"}${meta.size}`;
  throw new Error(`Unsupported HDF5 datatype (class ${meta.type}).`);
}

/** Whether an HDF5 datatype is a numeric class we can render. */
function isRenderableH5Dtype(meta: H5Metadata): boolean {
  // Floats: only 4/8 bytes (no 1-byte float; h5wasm throws "Float16 not
  // supported" for 2-byte). Integers: 1/2/4 bytes — 8-byte ints come back as
  // BigInt64Array, which the numeric helpers and Zarr renderer can't handle.
  if (meta.type === H5T_FLOAT) {
    return meta.size === 4 || meta.size === 8;
  }
  if (meta.type === H5T_INTEGER) {
    return meta.size === 1 || meta.size === 2 || meta.size === 4;
  }
  return false;
}

/**
 * Copy a typed array's raw bytes. x86/ARM hosts are little-endian, which
 * matches the `<`-prefixed Zarr dtypes we emit, so no byte-swapping is needed.
 */
function typedArrayBytes(arr: TypedArrayLike): Uint8Array {
  return new Uint8Array(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength));
}

/** Encode bytes as base64 in chunks (avoids String.fromCharCode arg limits). */
function base64Encode(bytes: Uint8Array): string {
  // Collect per-chunk strings and join once: repeated `+=` on a growing string
  // is O(n^2) and spikes memory for large grids; this stays linear.
  const parts: string[] = [];
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

/** Read a numeric scalar HDF5 attribute, or undefined if absent/non-numeric. */
function h5NumericAttr(ds: H5Dataset, name: string): number | undefined {
  const value = unwrapScalar(ds.attrs[name]?.value);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read a numeric *vector* HDF5 attribute (e.g. NetCDF-4's `_Netcdf4Coordinates`,
 * the dimension ids of each axis), or undefined when absent or non-numeric.
 */
function h5NumericArrayAttr(ds: H5Dataset, name: string): number[] | undefined {
  const value = ds.attrs[name]?.value;
  if (isTypedArray(value)) return Array.from(value, Number);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) {
    return value as number[];
  }
  return undefined;
}

/** Read a string HDF5 attribute, or undefined if absent/non-string. */
function h5StringAttr(ds: H5Dataset, name: string): string | undefined {
  const value = unwrapScalar(ds.attrs[name]?.value);
  return typeof value === "string" ? value : undefined;
}

/** Determine the Zarr fill value from an HDF5 `_FillValue`/`missing_value`. */
function h5FillValue(ds: H5Dataset): number | string | null {
  for (const key of ["_FillValue", "missing_value"]) {
    const value = unwrapScalar(ds.attrs[key]?.value);
    if (typeof value === "number") return normalizeFillValue(value);
  }
  return null;
}

/**
 * Read a numeric NetCDF-3 attribute. When `allowNonFinite` is set, NaN/Infinity
 * pass through (for fill values); otherwise only finite numbers are returned.
 */
function nc3NumericAttr(v: Nc3Variable, name: string, allowNonFinite = false): number | undefined {
  const value = v.attributes.find((a) => a.name === name)?.value;
  if (typeof value !== "number") return undefined;
  return allowNonFinite || Number.isFinite(value) ? value : undefined;
}

/** Read a string NetCDF-3 attribute, or undefined if absent/non-string. */
function nc3StringAttr(v: Nc3Variable, name: string): string | undefined {
  const value = v.attributes.find((a) => a.name === name)?.value;
  return typeof value === "string" ? value : undefined;
}

/** Reduce a possibly-array attribute value to its first scalar. */
function unwrapScalar(value: unknown): unknown {
  if (isTypedArray(value)) return value.length > 0 ? value[0] : undefined;
  if (Array.isArray(value)) return value.length > 0 ? value[0] : undefined;
  return value;
}

/** Apply `value * scale + offset` to every element, into a new Float64Array. */
function applyScale(arr: TypedArrayLike, scale: number, offset: number): Float64Array {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = Number(arr[i]) * scale + offset;
  return out;
}

/** Whether every value in the array is finite and falls within `[min, max]`. */
function valuesWithin(arr: TypedArrayLike, [min, max]: readonly [number, number]): boolean {
  for (let i = 0; i < arr.length; i++) {
    const v = Number(arr[i]);
    if (!Number.isFinite(v) || v < min || v > max) return false;
  }
  return true;
}

/** Look up a child entity, returning null if h5wasm throws (broken link). */
function tryGet(group: H5Group, name: string): unknown {
  try {
    return group.get(name);
  } catch {
    return null;
  }
}

/** Clamp a selector index into `[0, size)`. */
function clampIndex(index: number, size: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), Math.max(0, size - 1));
}

/** A {@link LocalNetcdfWindow} clamped to a grid, with its stride worked out. */
interface ResolvedWindow {
  /** First row to read. */
  row: number;
  /** First column to read. */
  column: number;
  /** Rows to read, after clamping to the grid. */
  rows: number;
  /** Columns to read, after clamping to the grid. */
  columns: number;
  /** Whole-number decimation stride applied to both axes. */
  step: number;
  /** Rows in the decimated result. */
  outRows: number;
  /** Columns in the decimated result. */
  outColumns: number;
}

/**
 * Clamp a requested window to a grid and resolve its decimation stride.
 *
 * One stride for both axes rather than one each, so the result keeps the
 * window's aspect ratio: a cube drawn from a stretched grid would be visibly
 * wrong, and there is no cheap way to un-stretch it afterwards.
 *
 * @param window - The requested window, or undefined for the whole plane.
 * @param ny - The variable's row count.
 * @param nx - The variable's column count.
 * @returns The window actually readable, and the result's size.
 */
function resolveWindow(
  window: LocalNetcdfWindow | undefined,
  ny: number,
  nx: number,
): ResolvedWindow {
  const row = window ? clampIndex(window.row, ny) : 0;
  const column = window ? clampIndex(window.column, nx) : 0;
  const span = (requested: number, start: number, size: number): number =>
    Number.isFinite(requested)
      ? Math.min(Math.max(1, Math.trunc(requested)), size - start)
      : size - start;
  const rows = window ? span(window.rows, row, ny) : ny;
  const columns = window ? span(window.columns, column, nx) : nx;
  const maxSize = window?.maxSize;
  const step =
    maxSize !== undefined && Number.isFinite(maxSize) && maxSize >= 1
      ? Math.max(1, Math.ceil(Math.max(rows, columns) / Math.trunc(maxSize)))
      : 1;
  return {
    row,
    column,
    rows,
    columns,
    step,
    outRows: Math.ceil(rows / step),
    outColumns: Math.ceil(columns / step),
  };
}

/** A new typed array of the same kind as `like`. */
function makeLike(like: TypedArrayLike, length: number): TypedArrayLike {
  const Ctor = (like as { constructor: unknown }).constructor as new (n: number) => TypedArrayLike;
  return new Ctor(length);
}

/**
 * Decimate a window-sized plane by its stride, taking every `step`-th cell.
 *
 * Nearest neighbour, not an average: the values may be packed integers or carry
 * a fill value, and averaging either would invent readings the file does not
 * contain.
 *
 * @param plane - The `window.rows * window.columns` cells, row-major.
 * @param window - The resolved window the plane was read for.
 * @returns The decimated plane, or `plane` itself when the stride is 1.
 */
function decimatePlane(plane: TypedArrayLike, window: ResolvedWindow): TypedArrayLike {
  if (window.step === 1) return plane;
  const out = makeLike(plane, window.outRows * window.outColumns);
  for (let y = 0; y < window.outRows; y++) {
    const sourceRow = y * window.step * window.columns;
    const targetRow = y * window.outColumns;
    for (let x = 0; x < window.outColumns; x++) {
      out[targetRow + x] = plane[sourceRow + x * window.step];
    }
  }
  return out;
}

/** The window's slice of a coordinate axis, decimated to match the plane. */
function decimateCoordinate(
  coordinate: TypedArrayLike,
  start: number,
  count: number,
  step: number,
): TypedArrayLike {
  if (step === 1 && start === 0 && count === coordinate.length) return coordinate;
  const out = makeLike(coordinate, count);
  for (let i = 0; i < count; i++) out[i] = coordinate[start + i * step];
  return out;
}

function isTypedArray(value: unknown): value is TypedArrayLike {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function isDataset(value: unknown): value is H5Dataset {
  return (
    typeof value === "object" &&
    value !== null &&
    "metadata" in value &&
    typeof (value as H5Dataset).slice === "function"
  );
}

function isGroup(value: unknown): value is H5Group {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as H5Group).keys === "function" &&
    typeof (value as H5Group).get === "function"
  );
}
