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
}

/** Result of building a Zarr store from a local variable slice. */
export interface LocalNetcdfLayerRefs {
  /** Self-contained Zarr v2 reference map (inline base64 chunks). */
  refs: KerchunkRefs;
  /** Variable name to render (matches a key prefix in {@link refs}). */
  variable: string;
}

/**
 * A local NetCDF/HDF file opened in the browser. List its renderable variables,
 * build a Zarr store for a chosen slice, then {@link close} it to release any
 * backend resources.
 */
export interface LocalNetcdfFile {
  /** Renderable variables (numeric, 2-D or higher), sorted by name. */
  listVariables(): LocalNetcdfVariable[];
  /** Build a self-contained Zarr v2 store for one 2-D slice of a variable. */
  buildLayerRefs(variable: string, selector?: Record<string, number>): LocalNetcdfLayerRefs;
  /** Release backend resources (e.g. the WASM filesystem entry). */
  close(): void;
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
      out.push({ name: path, dims: dimensionNames(ds, shape), shape });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  buildLayerRefs(variable: string, selector: Record<string, number> = {}): LocalNetcdfLayerRefs {
    const ds = tryGet(this.file, variable);
    if (!isDataset(ds)) {
      throw new Error(`Variable "${variable}" not found in the file.`);
    }
    const shape = ds.shape ?? ds.metadata.shape ?? [];
    if (shape.length < 2) {
      throw new Error(`Variable "${variable}" is not a 2-D+ grid.`);
    }
    // Re-check the dtype here too: buildLayerRefs is public API and may be
    // called with a variable that did not pass listVariables' filter.
    if (!isRenderableH5Dtype(ds.metadata)) {
      throw new Error(`Variable "${variable}" has an unsupported data type.`);
    }
    const ny = shape[shape.length - 2];
    const nx = shape[shape.length - 1];
    const dims = dimensionNames(ds, shape);

    // Build the hyperslab: one index per leading dim, full extent for y and x.
    const ranges: Array<[] | [number, number]> = [];
    for (let i = 0; i < shape.length - 2; i++) {
      const idx = clampIndex(selector[dims[i]] ?? 0, shape[i]);
      ranges.push([idx, idx + 1]);
    }
    ranges.push([0, ny]);
    ranges.push([0, nx]);

    const sliceData = ds.slice(ranges);
    if (!isTypedArray(sliceData)) {
      throw new Error(`Could not read data for variable "${variable}".`);
    }

    const { lat, lon } = this.readCoordinates(ny, nx, variable);
    return {
      refs: buildInlineZarrRefs({
        variable,
        ny,
        nx,
        data: sliceData,
        dtype: h5ZarrDtype(ds.metadata),
        lat: lat.data,
        latDtype: lat.dtype,
        lon: lon.data,
        lonDtype: lon.dtype,
        fillValue: h5FillValue(ds),
        scaleFactor: h5NumericAttr(ds, "scale_factor"),
        addOffset: h5NumericAttr(ds, "add_offset"),
      }),
      variable,
    };
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
  private constructor(private readonly reader: NetCDFReader) {}

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
    // netcdfjs is pure JS with no external resources to release.
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
      out.push({ name: v.name, dims: this.dims(v), shape });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  buildLayerRefs(variable: string, selector: Record<string, number> = {}): LocalNetcdfLayerRefs {
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
    const ny = shape[shape.length - 2];
    const nx = shape[shape.length - 1];
    const dims = this.dims(v);

    // netcdfjs reads the whole variable; slice the selected 2-D plane in JS.
    const full = info.make(this.reader.getDataVariable(v.name) as number[]);
    let lead = 0; // C-order flattening of the leading (non-spatial) indices
    for (let i = 0; i < shape.length - 2; i++) {
      lead = lead * shape[i] + clampIndex(selector[dims[i]] ?? 0, shape[i]);
    }
    const start = lead * ny * nx;
    const sliceData = full.subarray(start, start + ny * nx);

    const lat = this.readCoordinate(LAT_NAMES, ny, LAT_RANGE);
    const lon = this.readCoordinate(LON_NAMES, nx, LON_RANGE);
    if (!lat || !lon) throw new Error(NO_COORDINATES_MESSAGE);

    return {
      refs: buildInlineZarrRefs({
        variable,
        ny,
        nx,
        data: sliceData,
        dtype: info.dtype,
        lat: lat.data,
        latDtype: lat.dtype,
        lon: lon.data,
        lonDtype: lon.dtype,
        fillValue: normalizeFillValue(
          nc3NumericAttr(v, "_FillValue", true) ?? nc3NumericAttr(v, "missing_value", true),
        ),
        scaleFactor: nc3NumericAttr(v, "scale_factor"),
        addOffset: nc3NumericAttr(v, "add_offset"),
      }),
      variable,
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
  return refs;
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
  const { nx, ny, lon } = grid;
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
  if (split === 0 || split >= nx) return null;

  const newLon = new Float64Array(nx);
  for (let j = 0; j < nx - split; j++) newLon[j] = Number(lon[split + j]) - 360;
  for (let j = 0; j < split; j++) newLon[nx - split + j] = Number(lon[j]);

  const src = grid.data;
  const dst = emptyLike(src);
  for (let r = 0; r < ny; r++) {
    const row = r * nx;
    for (let j = 0; j < nx - split; j++) dst[row + j] = src[row + split + j];
    for (let j = 0; j < split; j++) dst[row + nx - split + j] = src[row + j];
  }
  return { data: dst, lon: newLon };
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

/**
 * Best-effort dimension names for an HDF5 dataset: prefer dimension-scale labels
 * (set by NetCDF-4), falling back to `dim_<i>` for unlabeled axes.
 */
function dimensionNames(ds: H5Dataset, shape: number[]): string[] {
  let labels: Array<string | null> = [];
  try {
    labels = ds.get_dimension_labels() ?? [];
  } catch {
    labels = [];
  }
  return shape.map((_, i) => labels[i] || `dim_${i}`);
}

/** Read a numeric scalar HDF5 attribute, or undefined if absent/non-numeric. */
function h5NumericAttr(ds: H5Dataset, name: string): number | undefined {
  const value = unwrapScalar(ds.attrs[name]?.value);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
