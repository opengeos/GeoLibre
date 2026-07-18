// A kerchunk-reference store for rendering Cloud-Optimized NetCDF/HDF5 through
// the Zarr layer pipeline. A kerchunk reference manifest maps Zarr keys to
// either inline metadata/data or an [url, offset, length] byte range inside the
// original HDF5/NetCDF file. This store implements the minimal zarrita
// `Readable` interface (`get(key)`) so it can be handed to
// `ZarrLayerControl.addLayer(url, variable, { store })`, letting the existing
// Zarr renderer draw HDF5/NetCDF data over HTTP range requests with no rewrite.
//
// Reference: https://guide.cloudnativegeo.org/cloud-optimized-netcdf4-hdf5/

/** A single kerchunk reference value. */
export type KerchunkRef =
  | string // inline: JSON metadata, raw text, or "base64:<...>" binary
  | [string] // whole referenced file
  | [string, number, number]; // [url, offset, length] byte range

/** The `refs` map of a kerchunk manifest: Zarr key -> reference value. */
export type KerchunkRefs = Record<string, KerchunkRef>;

/** A parsed kerchunk document (v1 `{ version, refs }` or a flat v0 map). */
export interface KerchunkDocument {
  version?: number;
  refs?: KerchunkRefs;
  // v1 may include templates/gen for parametrized URLs (unsupported here).
  templates?: Record<string, string>;
  gen?: unknown[];
  [key: string]: unknown;
}

type FetchImpl = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
}>;

const BASE64_PREFIX = "base64:";

// Best-effort guard against a user-supplied URL pointing at an oversized
// manifest exhausting memory. Honored only when Content-Length is present.
const MAX_MANIFEST_BYTES = 256 * 1024 * 1024;

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Normalize a parsed kerchunk document into a flat `refs` map with every
 * referenced chunk URL resolved to an absolute URL.
 *
 * Handles both the v1 `{ version, refs }` envelope and the v0 flat map. Chunk
 * URLs that are relative are resolved against `referenceUrl` (the location the
 * manifest was loaded from), matching how cloud-native references are shipped
 * alongside, or pointing at, the original data file. Inline values are left
 * untouched.
 *
 * @param doc Parsed kerchunk JSON.
 * @param referenceUrl URL the manifest was fetched from; used to resolve
 *   relative chunk URLs.
 * @returns A flat `refs` map ready to back a {@link KerchunkReferenceStore}.
 * @throws If the document uses unsupported `templates`/`gen` URL generation, or
 *   has no `refs`.
 */
export function normalizeKerchunkReference(
  doc: KerchunkDocument,
  referenceUrl?: string,
): KerchunkRefs {
  const refs: KerchunkRefs | undefined =
    doc.refs ?? (looksLikeFlatRefs(doc) ? (doc as KerchunkRefs) : undefined);
  if (!refs) {
    throw new Error("Invalid kerchunk reference: no `refs` found.");
  }
  if (
    (doc.templates && Object.keys(doc.templates).length > 0) ||
    (Array.isArray(doc.gen) && doc.gen.length > 0)
  ) {
    throw new Error("Templated kerchunk references (templates/gen) are not supported.");
  }

  const resolved: KerchunkRefs = {};
  for (const [key, value] of Object.entries(refs)) {
    if (Array.isArray(value) && typeof value[0] === "string") {
      // The declared type is a lie for untrusted input; validate the raw array.
      const arr = value as unknown[];
      const url = resolveUrl(arr[0] as string, referenceUrl);
      if (arr.length === 2) {
        throw new Error(
          `Invalid kerchunk reference for key "${key}": array refs must have 1 element (whole file) or 3 (url, offset, length), got 2.`,
        );
      }
      if (arr.length >= 3 && (typeof arr[1] !== "number" || typeof arr[2] !== "number")) {
        throw new Error(
          `Invalid kerchunk reference for key "${key}": offset and length must be numbers.`,
        );
      }
      resolved[key] = arr.length >= 3 ? [url, arr[1] as number, arr[2] as number] : [url];
    } else if (typeof value === "string") {
      resolved[key] = value;
    } else {
      throw new Error(
        `Invalid kerchunk reference for key "${key}": unexpected value type "${typeof value}".`,
      );
    }
  }
  return resolved;
}

function looksLikeFlatRefs(doc: KerchunkDocument): boolean {
  // Sufficient heuristic: real v0 manifests always include at least one Zarr
  // metadata key at the root. A chunk-keys-only manifest would fall through to
  // the "no `refs` found" error, which is acceptable since real stores always
  // include `.zgroup`.
  return ".zgroup" in doc || ".zattrs" in doc || ".zarray" in doc;
}

function resolveUrl(url: string, base?: string): string {
  if (!url) return url; // empty URL: don't resolve to the manifest itself
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url; // already absolute
  if (!base) return url;
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

/**
 * A zarrita-compatible `Readable` backed by a kerchunk reference map. Resolves
 * each Zarr key to inline bytes (metadata or `base64:` data) or an HTTP byte
 * range read into the referenced HDF5/NetCDF file.
 */
export class KerchunkReferenceStore {
  private readonly refs: KerchunkRefs;
  private readonly fetchImpl: FetchImpl;
  private readonly headers?: Record<string, string>;

  constructor(
    refs: KerchunkRefs,
    options: { fetchImpl?: FetchImpl; headers?: Record<string, string> } = {},
  ) {
    this.refs = refs;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
    this.headers = options.headers;
  }

  /**
   * Resolve a Zarr key to its bytes.
   *
   * @param key Zarr key, with or without a leading slash (e.g. `/air/0.0.0`).
   * @returns The bytes for the key, or `undefined` if the key is not present.
   */
  async get(key: string): Promise<Uint8Array | undefined> {
    const normalized = key.startsWith("/") ? key.slice(1) : key;
    const value = this.refs[normalized];
    if (value === undefined) return undefined;

    if (typeof value === "string") {
      return value.startsWith(BASE64_PREFIX)
        ? decodeBase64(value.slice(BASE64_PREFIX.length))
        : new TextEncoder().encode(value);
    }

    const [url, offset, length] = value;
    const init =
      value.length >= 3
        ? {
            headers: {
              ...this.headers,
              Range: `bytes=${offset}-${(offset as number) + (length as number) - 1}`,
            },
          }
        : this.headers
          ? { headers: { ...this.headers } }
          : undefined;
    const res = await this.fetchImpl(url, init);
    if (res.status !== 206 && res.status !== 200) {
      throw new Error(`Kerchunk range read failed: ${url} -> HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** A renderable array discovered in a kerchunk reference. */
export interface KerchunkVariable {
  /** Array name (Zarr path, e.g. `air` or `group/temperature`). */
  name: string;
  /** Dimension names in order, when present (`_ARRAY_DIMENSIONS`). */
  dims: string[];
  /** Array shape. */
  shape: number[];
}

/**
 * List the renderable variables in a kerchunk reference: arrays with at least
 * two dimensions (gridded data), excluding 1-D coordinate arrays such as
 * lat/lon/time. Used to populate the variable picker.
 *
 * @param refs A normalized kerchunk `refs` map.
 * @returns The renderable variables, sorted by name.
 */
export function listKerchunkVariables(refs: KerchunkRefs): KerchunkVariable[] {
  const out: KerchunkVariable[] = [];
  for (const [key, value] of Object.entries(refs)) {
    if (!key.endsWith("/.zarray") || typeof value !== "string") continue;
    const name = key.slice(0, -"/.zarray".length);
    let shape: number[] = [];
    try {
      const parsed = JSON.parse(value).shape;
      shape = Array.isArray(parsed) && parsed.every((n) => typeof n === "number") ? parsed : [];
    } catch {
      continue;
    }
    if (shape.length < 2) continue; // skip coordinate / scalar arrays

    let dims: string[] = [];
    const attrs = refs[`${name}/.zattrs`];
    if (typeof attrs === "string") {
      try {
        const parsed = JSON.parse(attrs)._ARRAY_DIMENSIONS;
        dims = Array.isArray(parsed) && parsed.every((d) => typeof d === "string") ? parsed : [];
      } catch {
        dims = [];
      }
    }
    out.push({ name, dims, shape });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read a response body into bytes, rejecting once it exceeds the size cap. */
async function readCappedBody(res: {
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: ReadableStream<Uint8Array> | null;
}): Promise<Uint8Array> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    // No streamable body (e.g. a mocked fetch): buffer, then size-check.
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_MANIFEST_BYTES) throw manifestTooLargeError();
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MANIFEST_BYTES) {
      await reader.cancel();
      throw manifestTooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function manifestTooLargeError(): Error {
  return new Error(`Kerchunk manifest too large (limit ${MAX_MANIFEST_BYTES} bytes).`);
}

/**
 * Fetch and normalize a kerchunk reference manifest from a URL.
 *
 * @param url URL of the kerchunk reference JSON.
 * @param options Optional `fetchImpl` (for testing) and request `headers`.
 * @returns The normalized `refs` map.
 */
export async function loadKerchunkReference(
  url: string,
  options: { fetchImpl?: FetchImpl; headers?: Record<string, string> } = {},
): Promise<KerchunkRefs> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  const res = await fetchImpl(url, options.headers ? { headers: options.headers } : undefined);
  if (res.status !== 200) {
    throw new Error(`Failed to fetch kerchunk reference: HTTP ${res.status}`);
  }
  // Fast reject when the server advertises a too-large body...
  const contentLength = Number(res.headers?.get?.("content-length") ?? 0);
  if (contentLength > MAX_MANIFEST_BYTES) {
    throw new Error(
      `Kerchunk manifest too large: ${contentLength} bytes (limit ${MAX_MANIFEST_BYTES}).`,
    );
  }
  // ...and cap the actual bytes read, so chunked/compressed/header-less
  // responses can't buffer an unbounded body into memory.
  const text = new TextDecoder().decode(await readCappedBody(res));
  const doc = JSON.parse(text) as KerchunkDocument;
  return normalizeKerchunkReference(doc, url);
}
