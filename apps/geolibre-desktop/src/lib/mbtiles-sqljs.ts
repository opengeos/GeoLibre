// MBTiles reading on top of sql.js (SQLite compiled to WASM), so MBTiles work in
// the browser build where the Tauri `read_mbtiles_*` commands do not exist. The
// behaviour deliberately mirrors the Rust commands in `src-tauri/src/lib.rs`
// (metadata keys, tile type detection, TMS row flip, gzip/zlib inflation) so a
// file renders identically on the web and on desktop.
//
// Kept free of Tauri / MapLibre imports so it can be unit-tested under Node.

import type { GeoLibreLayer } from "@geolibre/core";
import { gunzipSync, unzlibSync } from "fflate";
import type { Database, SqlValue, Statement } from "sql.js";

/**
 * Largest `.mbtiles` the browser will open. The whole file is read into an
 * ArrayBuffer and then copied into sql.js's WebAssembly heap, so it is briefly
 * held twice; past about this size tabs run out of memory (and WASM memory is
 * capped at 2 GiB regardless). Desktop reads tiles from disk and has no limit.
 */
export const MAX_BROWSER_MBTILES_BYTES = 1024 * 1024 * 1024;

/**
 * Prefix of the synthetic "path" a browser-opened MBTiles file is addressed by.
 * A browser file has no filesystem path, so the tile URL's `path` query holds
 * a key into the in-memory database registry instead.
 */
export const BROWSER_MBTILES_KEY_PREFIX = "browser-mbtiles-";

function randomSessionId(): string {
  // getRandomValues (unlike randomUUID) also exists on insecure origins.
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Create a generator of browser-database keys. Each key carries a random id for
 * the page session plus a counter. The counter alone is not enough: it restarts
 * at 1 on every load, so a saved project's `browser-mbtiles-1/a.mbtiles` layer
 * would match whatever different `a.mbtiles` is opened first in a later session
 * and quietly show the wrong tiles instead of reporting its file as unavailable.
 *
 * @param sessionId - Override for tests; defaults to a fresh random id.
 */
export function createBrowserMbtilesKeyGenerator(
  sessionId: string = randomSessionId(),
): (fileName: string) => string {
  let counter = 0;
  return (fileName) => `${BROWSER_MBTILES_KEY_PREFIX}${sessionId}-${++counter}/${fileName}`;
}

/** The browser-database key a tile URL points at, or null for any other URL. */
export function browserMbtilesKeyFromTileUrl(url: string): string | null {
  const query = url.indexOf("?");
  if (query === -1) return null;
  const path = new URLSearchParams(url.slice(query + 1)).get("path");
  return path?.startsWith(BROWSER_MBTILES_KEY_PREFIX) ? path : null;
}

/**
 * Every browser-database key referenced by the tile URLs of the given layer
 * sets (the live layers plus any undo/redo snapshots, which can bring a removed
 * layer back).
 */
export function browserMbtilesKeysInLayers(
  layerSets: Iterable<readonly Pick<GeoLibreLayer, "source">[]>,
): Set<string> {
  const keys = new Set<string>();
  for (const layers of layerSets) {
    for (const layer of layers) {
      const tiles: unknown = layer.source?.tiles;
      if (!Array.isArray(tiles)) continue;
      for (const tile of tiles) {
        const key = typeof tile === "string" ? browserMbtilesKeyFromTileUrl(tile) : null;
        if (key !== null) keys.add(key);
      }
    }
  }
  return keys;
}

export interface MbtilesMetadata {
  name: string;
  format: string;
  tileType: "raster" | "vector";
  sourceLayers: string[];
  minZoom?: number | null;
  maxZoom?: number | null;
  bounds?: [number, number, number, number] | null;
  center?: [number, number, number] | null;
  scheme: string;
}

/** Reads (decoded) tiles out of one open MBTiles database. */
export interface MbtilesTileReader {
  /** The decoded tile bytes, or an empty array when the tile does not exist. */
  readTile(z: number, x: number, y: number): Uint8Array;
  /** Free the prepared statement. Does not close the database. */
  close(): void;
}

const VECTOR_FORMATS = new Set(["pbf", "mvt", "protobuf"]);

// SQLite quoting is not needed for the fixed names below; they are constants.
const TILES_COLUMNS = "zoom_level, tile_column, tile_row, tile_data";

function tableOrViewExists(db: Database, name: string): boolean {
  const result = db.exec(
    "SELECT name FROM sqlite_master WHERE name = ? AND type IN ('table', 'view') LIMIT 1",
    [name],
  );
  return result.length > 0 && result[0].values.length > 0;
}

function parseNumberList(value: string): number[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

function parseInteger(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function readMetadataRows(db: Database): Map<string, string> {
  const rows = new Map<string, string>();
  // The metadata table is required by the spec but real-world files omit it, so
  // treat a missing/unreadable one as "no metadata" rather than a failure.
  if (!tableOrViewExists(db, "metadata")) return rows;
  try {
    const result = db.exec("SELECT name, value FROM metadata");
    for (const [name, value] of result[0]?.values ?? []) {
      rows.set(String(name).toLowerCase(), value == null ? "" : String(value));
    }
  } catch (error) {
    console.warn("[GeoLibre] Could not read optional MBTiles metadata:", error);
  }
  return rows;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sourceLayerIds(metadata: Map<string, string>): string[] {
  const json = parseJsonObject(metadata.get("json"));
  let layers: unknown = json?.vector_layers ?? json?.layers;
  if (!Array.isArray(layers)) {
    // Some writers put the layer list straight in a `vector_layers` row.
    const direct = metadata.get("vector_layers");
    try {
      layers = direct ? JSON.parse(direct) : null;
    } catch {
      layers = null;
    }
  }
  if (!Array.isArray(layers)) return [];
  return layers.flatMap((layer) => {
    const id = layer && typeof layer === "object" ? (layer as { id?: unknown }).id : null;
    return typeof id === "string" && id !== "" ? [id] : [];
  });
}

/** Guess the tile format from magic bytes when the metadata omits `format`. */
export function sniffTileFormat(sample: Uint8Array | null): string {
  if (sample && sample.length > 3) {
    if (sample[0] === 0x89 && sample[1] === 0x50) return "png";
    if (sample[0] === 0xff && sample[1] === 0xd8) return "jpg";
    if (sample[0] === 0x52 && sample[1] === 0x49 && sample[2] === 0x46 && sample[3] === 0x46) {
      return "webp";
    }
    // gzip-compressed vector tiles are the common case.
    if (sample[0] === 0x1f && sample[1] === 0x8b) return "pbf";
  }
  return "pbf";
}

/**
 * Throw a readable error unless the database has a usable `tiles` table/view.
 * A non-SQLite file makes the first query throw, which is re-worded here.
 */
function assertTilesTable(db: Database): void {
  let exists: boolean;
  try {
    exists = tableOrViewExists(db, "tiles");
  } catch {
    throw new Error("The selected file is not a valid MBTiles (SQLite) database.");
  }
  if (!exists) {
    throw new Error(
      'Unsupported MBTiles schema: a "tiles" table or view with zoom_level, tile_column, tile_row and tile_data is required.',
    );
  }
  try {
    // LIMIT 0 validates the columns (tables *and* views) without reading tiles.
    db.exec(`SELECT ${TILES_COLUMNS} FROM tiles LIMIT 0`);
  } catch {
    throw new Error(
      'The "tiles" object must contain zoom_level, tile_column, tile_row and tile_data.',
    );
  }
}

function sampleTile(db: Database): Uint8Array | null {
  try {
    const value = db.exec("SELECT tile_data FROM tiles LIMIT 1")[0]?.values[0]?.[0];
    return value instanceof Uint8Array ? value : null;
  } catch {
    return null;
  }
}

/**
 * Read the layer-defining metadata of an open MBTiles database.
 *
 * @param db - An open sql.js database.
 * @param fallbackName - Layer name used when the metadata has no `name`.
 * @throws When the database has no usable `tiles` table or view.
 */
export function readMbtilesMetadataFromDb(db: Database, fallbackName: string): MbtilesMetadata {
  assertTilesTable(db);
  const metadata = readMetadataRows(db);

  const declaredFormat = metadata.get("format")?.trim().toLowerCase();
  const format = declaredFormat || sniffTileFormat(sampleTile(db));
  const bounds = parseNumberList(metadata.get("bounds") ?? "");
  const center = parseNumberList(metadata.get("center") ?? "");

  return {
    name: metadata.get("name")?.trim() || fallbackName,
    format,
    tileType: VECTOR_FORMATS.has(format) ? "vector" : "raster",
    sourceLayers: sourceLayerIds(metadata),
    minZoom: parseInteger(metadata.get("minzoom")),
    maxZoom: parseInteger(metadata.get("maxzoom")),
    bounds: bounds.length === 4 ? [bounds[0], bounds[1], bounds[2], bounds[3]] : null,
    center: center.length >= 2 ? [center[0], center[1], center[2] ?? 0] : null,
    scheme: metadata.get("scheme")?.trim().toLowerCase() || "tms",
  };
}

/** Inflate gzip- or zlib-wrapped tile payloads; anything else is returned as-is. */
export function decompressTileData(data: Uint8Array): Uint8Array {
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    return gunzipSync(data);
  }
  if (data.length > 2 && data[0] === 0x78) {
    try {
      const inflated = unzlibSync(data);
      // fflate yields an empty result (rather than throwing) for some bogus
      // streams; a real zlib tile never inflates to nothing.
      if (inflated.length > 0) return inflated;
    } catch {
      // Not actually zlib (e.g. a raster payload that merely starts with 'x').
    }
  }
  return data;
}

/**
 * Open a tile reader over a database. Holds one prepared statement, so call
 * {@link MbtilesTileReader.close} before closing the database.
 *
 * @param db - An open sql.js database with a `tiles` table or view.
 * @param scheme - `"xyz"` when rows are stored top-down; anything else is TMS
 *   (the MBTiles default), whose rows are flipped from MapLibre's XYZ `y`.
 */
export function createMbtilesTileReader(db: Database, scheme: string): MbtilesTileReader {
  const statement: Statement = db.prepare(
    "SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ? LIMIT 1",
  );
  const isXyz = scheme === "xyz";

  return {
    readTile(z, x, y) {
      // 2 ** z (not 1 << z) so z >= 31 cannot wrap around to a negative count.
      const rowCount = 2 ** z;
      const row = isXyz ? y : rowCount - 1 - y;
      if (row < 0) return new Uint8Array(0);

      let value: SqlValue | undefined;
      try {
        statement.bind([z, x, row]);
        if (statement.step()) value = statement.get()[0];
      } finally {
        // Always release the cursor, so a failed step cannot leave the shared
        // statement mid-iteration for the next tile.
        statement.reset();
      }
      // Inflated after the statement is reset. A corrupt gzip tile throws, which
      // rejects that one tile request (as the desktop command does) rather than
      // rendering silently blank.
      return value instanceof Uint8Array ? decompressTileData(value) : new Uint8Array(0);
    },
    close() {
      statement.free();
    },
  };
}
