// Read a *local* HDF5 / NetCDF-4 file entirely in the browser (no server) and
// turn a chosen 2-D slice into an in-memory Zarr v2 store, so it can render
// through the exact same kerchunk/Zarr pipeline as a Cloud-Optimized NetCDF.
//
// The cloud path (see kerchunk-reference-store.ts) resolves each Zarr key to an
// HTTP byte range inside the remote file. Here there is no HTTP: h5wasm decodes
// the file client-side, we extract the selected slice (plus its lat/lon
// coordinate arrays) as plain typed arrays, and emit a *self-contained* Zarr v2
// reference map whose chunks are inlined as `base64:` data with no compression.
// That map is a {@link KerchunkRefs}, so it drops straight into
// `addCloudNetcdfLayer({ refs, ... })` and the @carbonplan/zarr-layer renderer
// draws it like any other kerchunk store.
//
// Scope: HDF5-backed files (that includes NetCDF-4, which is HDF5 underneath).
// The classic NetCDF-3 (`CDF\x01`) format is not HDF5 and is not handled here.

import type { KerchunkRefs } from "./kerchunk-reference-store";

// h5wasm's structural types, kept minimal so this module does not need the
// package at type-check time in consumers. The real shapes come from the
// dynamic import in {@link openLocalNetcdf}.
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

/** HDF5 datatype classes we can render (numeric grids only). */
const H5T_INTEGER = 0;
const H5T_FLOAT = 1;

/** Common coordinate-variable names, longest/most-specific first. */
const LAT_NAMES = ["latitude", "lat", "y", "nav_lat"];
const LON_NAMES = ["longitude", "lon", "lng", "x", "nav_lon"];

/** A renderable variable discovered in a local HDF5/NetCDF file. */
export interface LocalNetcdfVariable {
  /** Dataset path (e.g. `air` or `group/temperature`). */
  name: string;
  /** Dimension names in order (from HDF5 dimension scales, best effort). */
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

let modulePromise: Promise<H5wasmModule> | null = null;
let fileCounter = 0;

/**
 * Lazily load and initialize h5wasm. The (~5.6 MB) single-file WASM module is
 * only fetched the first time a user opens a local NetCDF/HDF file, keeping it
 * out of the main bundle.
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
 * A local HDF5/NetCDF-4 file opened in the browser via h5wasm. List its
 * renderable variables, build a Zarr store for a chosen slice, then
 * {@link close} it to release the WASM filesystem entry.
 */
export class LocalNetcdfFile {
  private constructor(
    private readonly mod: H5wasmModule,
    private readonly file: H5File,
    private readonly fsPath: string
  ) {}

  /**
   * Open a local file's bytes with h5wasm.
   *
   * @param buffer The raw file bytes (from a file input or drag-and-drop).
   * @returns An open {@link LocalNetcdfFile}. Call {@link close} when done.
   * @throws If the bytes are not a readable HDF5 file (e.g. NetCDF-3 classic).
   */
  static async open(buffer: ArrayBuffer): Promise<LocalNetcdfFile> {
    const mod = await loadH5wasm();
    const fsPath = `geolibre-netcdf-${fileCounter++}.h5`;
    mod.FS.writeFile(fsPath, new Uint8Array(buffer));
    try {
      const file = new mod.File(fsPath, "r");
      return new LocalNetcdfFile(mod, file, fsPath);
    } catch (err) {
      try {
        mod.FS.unlink(fsPath);
      } catch {
        /* best effort */
      }
      throw new Error(
        `Could not read the file as HDF5/NetCDF-4. Classic NetCDF-3 files are not supported. (${
          err instanceof Error ? err.message : String(err)
        })`
      );
    }
  }

  /** Close the file and remove it from the WASM in-memory filesystem. */
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

  /**
   * Recursively collect every dataset path in the file.
   *
   * @returns Absolute-ish dataset paths (no leading slash), e.g. `group/air`.
   */
  private datasetPaths(): string[] {
    const out: string[] = [];
    const visit = (group: H5Group, prefix: string) => {
      for (const key of group.keys()) {
        // h5wasm resolves get() relative to the group, so look up the child by
        // its own `key`; `path` is only the accumulated label for output and
        // recursion. Passing the full path here would fail on nested groups.
        const entity = group.get(key);
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

  /**
   * List renderable variables: numeric datasets with at least two dimensions
   * (gridded data), excluding 1-D coordinate arrays such as lat/lon/time.
   *
   * @returns The renderable variables, sorted by name.
   */
  listVariables(): LocalNetcdfVariable[] {
    const out: LocalNetcdfVariable[] = [];
    for (const path of this.datasetPaths()) {
      const ds = this.file.get(path);
      if (!isDataset(ds)) continue;
      const shape = ds.shape ?? ds.metadata.shape ?? [];
      if (shape.length < 2) continue;
      if (!isRenderableDtype(ds.metadata)) continue;
      out.push({ name: path, dims: dimensionNames(ds, shape), shape });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Build a self-contained Zarr v2 store for one 2-D slice of a variable.
   *
   * The trailing two axes are treated as (y, x); any leading axes (time, band,
   * level, ...) are collapsed to the indices given in `selector`. The variable's
   * matching latitude/longitude coordinate variables are extracted too, so the
   * renderer can georeference the grid. Emitted chunks are uncompressed and
   * inlined as `base64:` data.
   *
   * @param variable Variable path returned by {@link listVariables}.
   * @param selector Fixed index per leading dimension name (default 0).
   * @returns The reference map and variable name for `addCloudNetcdfLayer`.
   * @throws If the variable is missing, not 2-D+, or has no lat/lon coordinates.
   */
  buildLayerRefs(
    variable: string,
    selector: Record<string, number> = {}
  ): LocalNetcdfLayerRefs {
    const ds = this.file.get(variable);
    if (!isDataset(ds)) {
      throw new Error(`Variable "${variable}" not found in the file.`);
    }
    const shape = ds.shape ?? ds.metadata.shape ?? [];
    if (shape.length < 2) {
      throw new Error(`Variable "${variable}" is not a 2-D+ grid.`);
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

    // Coordinate arrays keyed exactly `lat` / `lon` so the renderer reads them
    // to derive bounds and latitude orientation (see _loadSpatialMetadata).
    const lat = this.readCoordinate(LAT_NAMES, ny);
    const lon = this.readCoordinate(LON_NAMES, nx);
    if (!lat || !lon) {
      throw new Error(
        "Could not find latitude/longitude coordinate variables. Only georeferenced NetCDF/HDF grids are supported."
      );
    }

    const refs = buildInlineZarrRefs({
      variable,
      ny,
      nx,
      data: sliceData,
      dtype: zarrDtype(ds.metadata),
      lat: lat.data,
      latDtype: lat.dtype,
      lon: lon.data,
      lonDtype: lon.dtype,
      fillValue: fillValueFor(ds),
      scaleFactor: numericAttr(ds, "scale_factor"),
      addOffset: numericAttr(ds, "add_offset"),
    });
    return { refs, variable };
  }

  /**
   * Find and read a 1-D coordinate variable by common names, matching the
   * expected length.
   *
   * @param names Candidate variable names, most specific first.
   * @param length Required array length (matches the grid's y or x extent).
   * @returns The coordinate values and their Zarr dtype, or null if not found.
   */
  private readCoordinate(
    names: string[],
    length: number
  ): { data: TypedArrayLike; dtype: string } | null {
    for (const name of names) {
      const entity = this.file.get(name);
      if (!isDataset(entity)) continue;
      const shape = entity.shape ?? entity.metadata.shape ?? [];
      if (shape.length !== 1 || shape[0] !== length) continue;
      if (!isRenderableDtype(entity.metadata)) continue;
      const value = entity.value;
      if (!isTypedArray(value)) continue;
      return { data: value, dtype: zarrDtype(entity.metadata) };
    }
    return null;
  }
}

/**
 * Open a local HDF5/NetCDF-4 file from its raw bytes.
 *
 * @param buffer The file bytes.
 * @returns An open {@link LocalNetcdfFile}.
 */
export function openLocalNetcdf(buffer: ArrayBuffer): Promise<LocalNetcdfFile> {
  return LocalNetcdfFile.open(buffer);
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
function rollLongitude(
  grid: InlineZarrGrid
): { data: TypedArrayLike; lon: Float64Array } | null {
  const { nx, ny, lon } = grid;
  let min = Infinity;
  let max = -Infinity;
  let ascending = true;
  for (let i = 0; i < nx; i++) {
    const v = Number(lon[i]);
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
function writeZarrArray(
  refs: KerchunkRefs,
  name: string,
  spec: ZarrArraySpec
): void {
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
function zarrDtype(meta: H5Metadata): string {
  if (meta.type === H5T_FLOAT) return `<f${meta.size}`;
  if (meta.type === H5T_INTEGER) return `${meta.signed ? "<i" : "<u"}${meta.size}`;
  throw new Error(`Unsupported HDF5 datatype (class ${meta.type}).`);
}

/** Whether a datatype is a numeric class we can render. */
function isRenderableDtype(meta: H5Metadata): boolean {
  return (
    (meta.type === H5T_FLOAT || meta.type === H5T_INTEGER) &&
    (meta.size === 1 || meta.size === 2 || meta.size === 4 || meta.size === 8)
  );
}

/**
 * Copy a typed array's raw bytes. x86/ARM hosts are little-endian, which
 * matches the `<`-prefixed Zarr dtypes we emit, so no byte-swapping is needed.
 */
function typedArrayBytes(arr: TypedArrayLike): Uint8Array {
  return new Uint8Array(
    arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength)
  );
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
 * Best-effort dimension names for a dataset: prefer HDF5 dimension-scale labels
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

/** Read a numeric scalar attribute, or undefined if absent/non-numeric. */
function numericAttr(ds: H5Dataset, name: string): number | undefined {
  const attr = ds.attrs[name];
  const value = unwrapScalar(attr?.value);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Determine the Zarr fill value from `_FillValue`/`missing_value`. NaN is
 * emitted as the string `"NaN"` (a valid Zarr v2 fill value).
 */
function fillValueFor(ds: H5Dataset): number | string | null {
  for (const key of ["_FillValue", "missing_value"]) {
    const value = unwrapScalar(ds.attrs[key]?.value);
    if (typeof value === "number") {
      return Number.isNaN(value) ? "NaN" : value;
    }
  }
  return null;
}

/** Reduce a possibly-array attribute value to its first scalar. */
function unwrapScalar(value: unknown): unknown {
  if (isTypedArray(value)) return value.length > 0 ? value[0] : undefined;
  if (Array.isArray(value)) return value.length > 0 ? value[0] : undefined;
  return value;
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
