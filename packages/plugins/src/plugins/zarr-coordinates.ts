// Reading the coordinate values of a Zarr cube's non-spatial dimensions.
//
// `@carbonplan/zarr-layer` selects a slice by coordinate *value*, not by index:
// `{ band: "prec", month: 12 }` picks December precipitation because `prec` and
// `12` are entries in the `band` and `month` coordinate arrays. A picker that
// offered indices would therefore be quietly wrong wherever the two differ (in
// a `month` of 1-12 they differ by one), so the dialog offers the real values —
// which means reading them.
//
// They are cheap to read: a coordinate is a 1-D array of one chunk, next to the
// variable in the same group. zarrita decodes it, so this works over HTTP and
// over a local folder alike.

// zarrita (and the codecs it pulls in) is only needed once the user actually
// loads a store, so it is imported on demand rather than at module load. That
// keeps it out of the initial bundle and off the import path of anything that
// merely wants the pure helpers below.
// Type-only: erased at compile time, so it adds no runtime import.
import type { Readable } from "zarrita";

type Zarrita = typeof import("zarrita");
let zarritaModule: Promise<Zarrita> | null = null;

function loadZarrita(): Promise<Zarrita> {
  zarritaModule ??= import("zarrita");
  return zarritaModule;
}

/** The minimum of zarrita's `Readable` needed to open an array. */
export interface ZarrCoordinateStore {
  get(key: string): Promise<Uint8Array | undefined>;
}

/**
 * Values are read for a picker, so an axis too long to choose from in a dropdown
 * is not worth downloading. Past this, the dimension is reported as
 * unenumerable and the caller falls back to a free-text value.
 */
const MAX_COORDINATE_VALUES = 5000;

/** A dimension's coordinate values, or null when they could not be read. */
export type ZarrCoordinateValues = Record<string, Array<number | string> | null>;

/**
 * Read the coordinate values of the given dimensions of a variable.
 *
 * Each coordinate is looked up as a sibling of the variable, so a multiscale
 * pyramid's `0/climate` resolves `month` to `0/month` rather than to a
 * non-existent root array.
 *
 * Failure is per dimension and never thrown: a store may simply not ship a
 * coordinate array for a dimension, and a dimension too long to enumerate is
 * deliberately skipped. Either way that dimension maps to null and the caller
 * asks the user for a value instead.
 *
 * @param store - A zarrita `Readable` over the Zarr store.
 * @param variablePath - The variable's full store path, e.g. `0/climate`.
 * @param dims - The dimension names to read.
 * @returns Each dimension's values, or null where they are unavailable.
 */
export async function readZarrCoordinateValues(
  store: ZarrCoordinateStore,
  variablePath: string,
  dims: string[],
): Promise<ZarrCoordinateValues> {
  const zarr = await loadZarrita();
  const root = zarr.root(store as Readable);
  const group = variablePath.replace(/[^/]*$/, "");
  const entries = await Promise.all(
    dims.map(async (dim) => {
      try {
        const array = await zarr.open(root.resolve(`/${group}${dim}`), { kind: "array" });
        const total = array.shape.reduce((product, size) => product * size, 1);
        if (array.shape.length !== 1 || total === 0 || total > MAX_COORDINATE_VALUES) {
          return [dim, null] as const;
        }
        const chunk = await zarr.get(array);
        return [dim, normalizeCoordinateValues(chunk.data)] as const;
      } catch {
        return [dim, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Turn a decoded coordinate chunk into plain values a selector can carry.
 *
 * A `BigInt64Array` (an `int64` axis, which xarray writes for a plain integer
 * coordinate) becomes numbers, because the renderer compares the selector with
 * `indexOf` and `1n !== 1`. Values beyond `Number.MAX_SAFE_INTEGER` are dropped
 * rather than silently rounded into a value that would match the wrong slice.
 */
function normalizeCoordinateValues(data: unknown): Array<number | string> | null {
  if (!data || typeof data !== "object" || !("length" in data)) return null;
  const values: Array<number | string> = [];
  for (const value of data as ArrayLike<unknown> & Iterable<unknown>) {
    if (typeof value === "number" || typeof value === "string") {
      values.push(value);
    } else if (typeof value === "bigint") {
      if (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) return null;
      values.push(Number(value));
    } else {
      return null;
    }
  }
  return values;
}

/**
 * Build a zarrita store that reads a Zarr store over HTTP, so the host does not
 * have to depend on zarrita itself just to read a coordinate.
 *
 * @param url - The Zarr store's base URL.
 * @param headers - Request headers for an authenticated store.
 * @returns A readable store rooted at that URL.
 */
export async function createHttpZarrStore(
  url: string,
  headers?: Record<string, string>,
): Promise<ZarrCoordinateStore> {
  const zarr = await loadZarrita();
  return new zarr.FetchStore(url.replace(/\/+$/, ""), {
    // The `overrides` option zarrita used to take for this is deprecated in
    // favor of a request handler, so set the headers on the request itself.
    ...(headers
      ? {
          fetch: (request: Request) => {
            for (const [name, value] of Object.entries(headers)) {
              request.headers.set(name, value);
            }
            return globalThis.fetch(request);
          },
        }
      : {}),
  }) as unknown as ZarrCoordinateStore;
}

/**
 * Read a selector value typed into a free-text field, matching how the renderer
 * compares it: a numeric coordinate is a number, anything else is a string.
 *
 * @param raw - The field's text.
 * @returns The value to put in the selector, or null when the field is empty.
 */
export function parseZarrSelectorValue(raw: string): number | string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const asNumber = Number(trimmed);
  return Number.isFinite(asNumber) ? asNumber : trimmed;
}
