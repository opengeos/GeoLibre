// Listing the renderable arrays of a Zarr store, so a picker can offer them.
//
// The Zarr panel's own "Fetch" button returns variable *names* only, which is
// enough for a free-text selector but not for a form that wants one input per
// non-spatial dimension. This module reads the same metadata documents and
// keeps each array's dimension names and shape.
//
// It is deliberately transport-free: callers hand in a reader that resolves a
// store key to a parsed JSON document, so the same code serves a store over
// HTTP and a store on local disk (see `zarr-directory-store.ts`). A store with
// no consolidated metadata can additionally supply a directory lister, and the
// nodes are walked instead.

/** A renderable array found in a Zarr store. */
export interface ZarrStoreVariable {
  /**
   * The name the renderer takes: the array's leaf path segment, so a multiscale
   * pyramid's `0/climate` is offered as `climate`.
   */
  name: string;
  /**
   * The array's full store path (`0/climate`). Kept because a variable's
   * coordinate arrays are its *siblings*, so resolving them needs the group the
   * array actually lives in, not the name the renderer is given.
   */
  path: string;
  /** Dimension names in order, when the store declares them. */
  dims: string[];
  /**
   * Array shape, index-aligned with {@link dims}. In a multiscale pyramid this
   * is the first level's, so the *spatial* extents are level-dependent; the
   * non-spatial sizes (the ones a dimension picker needs) are not.
   */
  shape: number[];
}

/** What {@link readZarrStoreMetadata} found out about a store. */
export interface ZarrStoreMetadata {
  /** Zarr metadata version the store was read as. */
  version: 2 | 3;
  /** The renderable arrays, sorted by name. */
  variables: ZarrStoreVariable[];
}

/**
 * Reads one metadata document out of a store.
 *
 * @param key - Store-relative key, e.g. `.zmetadata` or `climate/.zarray`.
 * @returns The parsed JSON document, or undefined when the key is absent.
 */
export type ZarrMetadataReader = (key: string) => Promise<unknown | undefined>;

/**
 * Lists the immediate children of a store-relative directory. Only a store
 * backed by a real filesystem can offer this; over HTTP there is no listing.
 *
 * @param path - Store-relative directory path (`""` for the root).
 * @returns The entries, or an empty list when the path is not a directory.
 */
export type ZarrDirectoryLister = (
  path: string,
) => Promise<Array<{ name: string; isDirectory: boolean }>>;

/** Options for {@link readZarrStoreMetadata}. */
export interface ReadZarrStoreMetadataOptions {
  /** Enables the node walk used when a store has no consolidated metadata. */
  listEntries?: ZarrDirectoryLister;
}

/**
 * How far the node walk descends and how many nodes it visits. A pyramid keeps
 * its arrays one level down (`0/climate`), and a group of groups one more, so
 * three levels covers real stores while keeping a pathological tree bounded.
 */
const MAX_WALK_DEPTH = 3;
const MAX_WALK_NODES = 512;

/** An array needs a spatial pair to be renderable; 1-D arrays are coordinates. */
const MIN_RENDERABLE_DIMS = 2;

/**
 * List a Zarr store's renderable arrays.
 *
 * Reads the cheapest description first: the v2 consolidated `.zmetadata`, then
 * a v3 root `zarr.json` (whose `consolidated_metadata` describes the whole tree
 * in one document). A store with neither is walked node by node, which needs a
 * `listEntries` and so only works for a store on local disk.
 *
 * Arrays with fewer than two dimensions are left out: they are the coordinate
 * axes (`lat`, `time`, `spatial_ref`), never something to draw. A name that
 * appears at several pyramid levels is offered once.
 *
 * @param read - Reads a store key to a parsed JSON document.
 * @param options - Optional directory lister enabling the node walk.
 * @returns The store's metadata version and its renderable arrays.
 * @throws If the location is not a Zarr store, if it cannot be listed (no
 *   consolidated metadata and no lister), or if it holds no renderable array.
 */
export async function readZarrStoreMetadata(
  read: ZarrMetadataReader,
  options: ReadZarrStoreMetadataOptions = {},
): Promise<ZarrStoreMetadata> {
  const consolidatedV2 = await read(".zmetadata");
  if (consolidatedV2 !== undefined) {
    const variables = variablesFromConsolidatedV2(consolidatedV2);
    if (variables.length > 0) return { version: 2, variables };
  }

  const rootV3 = await read("zarr.json");
  if (rootV3 !== undefined) {
    const variables = variablesFromConsolidatedV3(rootV3);
    if (variables.length > 0) return { version: 3, variables };
  }

  // Either the store is not consolidated, or its consolidated listing held no
  // renderable array. Walking the nodes settles both, where the transport can.
  const version: 2 | 3 = rootV3 !== undefined ? 3 : 2;
  if (options.listEntries) {
    const variables = await walkStoreVariables(read, options.listEntries);
    if (variables.length > 0) return { version, variables };
  }

  const isStore =
    consolidatedV2 !== undefined ||
    rootV3 !== undefined ||
    (await read(".zgroup")) !== undefined ||
    (await read(".zarray")) !== undefined;
  if (!isStore) {
    throw new Error(
      "Not a Zarr store: no .zmetadata, zarr.json, .zgroup or .zarray document was found.",
    );
  }
  if (!options.listEntries) {
    // Over HTTP there is no listing to fall back on, so name the real cause
    // rather than reporting the store as empty.
    throw new Error(
      "This store's variables could not be listed: it has no consolidated metadata (.zmetadata, or a zarr.json carrying consolidated_metadata). Open it from a local folder instead, or consolidate the store's metadata.",
    );
  }
  throw new Error("No renderable (2-D or higher) arrays found in this Zarr store.");
}

/**
 * Pull the renderable arrays out of v2 consolidated metadata, whose keys are
 * store paths (`"0/climate/.zarray"`).
 *
 * @param document - The parsed `.zmetadata`.
 * @returns The renderable arrays, sorted by name.
 */
export function variablesFromConsolidatedV2(document: unknown): ZarrStoreVariable[] {
  const metadata = asRecord((document as { metadata?: unknown } | null)?.metadata);
  if (!metadata) return [];
  const found: ZarrStoreVariable[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (!key.endsWith("/.zarray") && key !== ".zarray") continue;
    const path = key === ".zarray" ? "" : key.slice(0, -"/.zarray".length);
    const shape = readShape(value);
    if (!shape) continue;
    const attrs = metadata[path ? `${path}/.zattrs` : ".zattrs"];
    found.push({ name: leafName(path), path, dims: readArrayDimensions(attrs), shape });
  }
  return dedupe(found);
}

/**
 * Pull the renderable arrays out of a v3 root `zarr.json` carrying
 * `consolidated_metadata`, whose entries are keyed by node path.
 *
 * @param document - The parsed root `zarr.json`.
 * @returns The renderable arrays, sorted by name.
 */
export function variablesFromConsolidatedV3(document: unknown): ZarrStoreVariable[] {
  const consolidated = asRecord(
    (document as { consolidated_metadata?: unknown } | null)?.consolidated_metadata,
  );
  const metadata = asRecord(consolidated?.metadata);
  if (!metadata) return [];
  const found: ZarrStoreVariable[] = [];
  for (const [path, value] of Object.entries(metadata)) {
    const node = asRecord(value);
    if (!node || node.node_type !== "array") continue;
    const shape = readShape(node);
    if (!shape) continue;
    found.push({ name: leafName(path), path, dims: readV3Dimensions(node), shape });
  }
  return dedupe(found);
}

/**
 * Walk a store's nodes when it has no consolidated metadata, reading each
 * child's `.zarray`/`zarr.json`. Descends into groups so a pyramid's arrays are
 * found, bounded by {@link MAX_WALK_DEPTH} and {@link MAX_WALK_NODES}.
 */
async function walkStoreVariables(
  read: ZarrMetadataReader,
  listEntries: ZarrDirectoryLister,
): Promise<ZarrStoreVariable[]> {
  const found: ZarrStoreVariable[] = [];
  let visited = 0;

  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH || visited >= MAX_WALK_NODES) return;
    const entries = await listEntries(path);
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (visited >= MAX_WALK_NODES) return;
      visited += 1;
      const childPath = path ? `${path}/${entry.name}` : entry.name;

      const zarray = await read(`${childPath}/.zarray`);
      const shape = readShape(zarray);
      if (shape) {
        const attrs = await read(`${childPath}/.zattrs`);
        found.push({
          name: leafName(childPath),
          path: childPath,
          dims: readArrayDimensions(attrs),
          shape,
        });
        continue;
      }

      const nodeV3 = asRecord(await read(`${childPath}/zarr.json`));
      if (nodeV3?.node_type === "array") {
        const v3Shape = readShape(nodeV3);
        if (v3Shape) {
          found.push({
            name: leafName(childPath),
            path: childPath,
            dims: readV3Dimensions(nodeV3),
            shape: v3Shape,
          });
        }
        continue;
      }

      // Not an array: a group (or a chunk directory, which simply yields
      // nothing). Descend, so `0/climate` in a pyramid is reached.
      await visit(childPath, depth + 1);
    }
  };

  await visit("", 1);
  return dedupe(found);
}

/** The last path segment: `"0/climate"` -> `"climate"`. */
function leafName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/** Read a `shape` of finite non-negative integers off a metadata document. */
function readShape(document: unknown): number[] | null {
  const shape = asRecord(document)?.shape;
  if (!Array.isArray(shape)) return null;
  if (!shape.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  return shape as number[];
}

/** Read v2 `_ARRAY_DIMENSIONS` (the xarray convention) off an attributes doc. */
function readArrayDimensions(attributes: unknown): string[] {
  const dims = asRecord(attributes)?._ARRAY_DIMENSIONS;
  if (!Array.isArray(dims)) return [];
  return dims.every((value) => typeof value === "string") ? (dims as string[]) : [];
}

/**
 * Read a v3 array's dimension names: the spec's own `dimension_names`, falling
 * back to `_ARRAY_DIMENSIONS` in the node attributes, which writers that came
 * from v2 still emit.
 */
function readV3Dimensions(node: Record<string, unknown>): string[] {
  const names = node.dimension_names;
  if (Array.isArray(names) && names.every((value) => typeof value === "string")) {
    return names as string[];
  }
  return readArrayDimensions(node.attributes);
}

/**
 * Drop coordinate arrays and pyramid duplicates, then sort by name. The first
 * occurrence of a name wins, which for a pyramid is its coarsest level (paths
 * arrive in document order, and writers emit `0/` first).
 */
function dedupe(found: ZarrStoreVariable[]): ZarrStoreVariable[] {
  const byName = new Map<string, ZarrStoreVariable>();
  for (const variable of found) {
    if (variable.shape.length < MIN_RENDERABLE_DIMS) continue;
    if (!variable.name || byName.has(variable.name)) continue;
    byName.set(variable.name, variable);
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Build a {@link ZarrMetadataReader} that fetches a store's documents over HTTP.
 *
 * A missing document is the normal case for most keys (a v2 store has no
 * `zarr.json`), so a 404 — and any transport error — resolves to undefined
 * rather than rejecting.
 *
 * @param baseUrl - The store's base URL.
 * @param options - Optional request headers and injected fetch (for tests).
 * @returns A reader over that store.
 */
export function createHttpZarrMetadataReader(
  baseUrl: string,
  options: { headers?: Record<string, string>; fetchImpl?: typeof fetch } = {},
): ZarrMetadataReader {
  const base = baseUrl.replace(/\/+$/, "");
  return async (key: string) => {
    const doFetch = options.fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== "function") return undefined;
    try {
      const response = await doFetch(`${base}/${key}`, {
        ...(options.headers ? { headers: options.headers } : {}),
      });
      if (!response.ok) return undefined;
      return (await response.json()) as unknown;
    } catch {
      return undefined;
    }
  };
}
