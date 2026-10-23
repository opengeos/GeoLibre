import { isTauri } from "./tauri-io";
import { invoke } from "@tauri-apps/api/core";
import { addProtocol, type RequestParameters } from "maplibre-gl";
import type { Database } from "sql.js";
import { loadSqlJs } from "./gpkg-ogr-contents";
import {
  createMbtilesTileReader,
  readMbtilesMetadataFromDb,
  type MbtilesMetadata,
  type MbtilesTileReader,
} from "./mbtiles-sqljs";

export type { MbtilesMetadata };

const MBTILES_PROTOCOL = "geolibre-mbtiles";

/**
 * Prefix of the synthetic "path" a browser-opened MBTiles file is addressed by.
 * A browser file has no filesystem path, so the tile URL's `path` query holds a
 * key into {@link browserMbtiles} instead.
 */
const BROWSER_KEY_PREFIX = "browser-mbtiles-";

interface BrowserMbtilesEntry {
  db: Database;
  reader: MbtilesTileReader;
}

// Databases opened from in-memory bytes (the web build). Tiles are served from
// here by the protocol handler; desktop files go through the Tauri commands.
const browserMbtiles = new Map<string, BrowserMbtilesEntry>();
let browserMbtilesCounter = 0;

let protocolRegistered = false;

export function mbtilesTileUrl(path: string): string {
  return `${MBTILES_PROTOCOL}://tile/{z}/{x}/{y}?path=${encodeURIComponent(path)}`;
}

/** Read an MBTiles file's metadata through the desktop (Tauri) backend. */
export async function readMbtilesMetadata(path: string): Promise<MbtilesMetadata> {
  if (!isTauri()) {
    throw new Error("Reading an MBTiles file by path requires GeoLibre Desktop.");
  }

  return invoke<MbtilesMetadata>("read_mbtiles_metadata", { path });
}

function stemOf(fileName: string): string {
  return fileName.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "") || "MBTiles Layer";
}

/**
 * Open an MBTiles file from its bytes with sql.js, so it works without the
 * desktop backend. The database stays in memory and is addressed by the
 * returned `key`, which stands in for a filesystem path in {@link mbtilesTileUrl}.
 * Call {@link releaseBrowserMbtiles} when the file will no longer be used.
 *
 * @param data - The whole `.mbtiles` file.
 * @param fileName - The original file name (used for the fallback layer name).
 * @returns The path-like `key` and the file's metadata.
 * @throws When the bytes are not an MBTiles database.
 */
export async function openBrowserMbtiles(
  data: ArrayBuffer | Uint8Array,
  fileName: string,
): Promise<{ key: string; metadata: MbtilesMetadata }> {
  const SQL = await loadSqlJs();
  const db = new SQL.Database(data instanceof Uint8Array ? data : new Uint8Array(data));
  let reader: MbtilesTileReader | null = null;
  try {
    const metadata = readMbtilesMetadataFromDb(db, stemOf(fileName));
    reader = createMbtilesTileReader(db, metadata.scheme);
    // The counter keeps two files with the same name from sharing a database.
    const key = `${BROWSER_KEY_PREFIX}${++browserMbtilesCounter}/${fileName}`;
    browserMbtiles.set(key, { db, reader });
    return { key, metadata };
  } catch (error) {
    reader?.close();
    db.close();
    throw error;
  }
}

/** Close and forget a database opened by {@link openBrowserMbtiles}. */
export function releaseBrowserMbtiles(key: string): void {
  const entry = browserMbtiles.get(key);
  if (!entry) return;
  browserMbtiles.delete(key);
  entry.reader.close();
  entry.db.close();
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function registerMbtilesProtocol(): void {
  if (protocolRegistered) return;

  addProtocol(MBTILES_PROTOCOL, async (request) => {
    const params = parseMbtilesTileRequest(request);

    const browserEntry = browserMbtiles.get(params.path);
    if (browserEntry) {
      return { data: toArrayBuffer(browserEntry.reader.readTile(params.z, params.x, params.y)) };
    }
    if (!isTauri()) {
      // A reopened project (or a released file) names a browser key that no
      // longer exists; there is no file on disk to fall back to.
      throw new Error("This MBTiles file is no longer loaded. Add it again to view its tiles.");
    }

    const bytes = await invoke<number[] | Uint8Array>("read_mbtiles_tile", params);
    const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return {
      data: array.buffer.slice(array.byteOffset, array.byteOffset + array.byteLength),
    };
  });
  protocolRegistered = true;
}

function parseMbtilesTileRequest(request: RequestParameters): {
  path: string;
  z: number;
  x: number;
  y: number;
} {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3) {
    throw new Error("Invalid MBTiles tile URL.");
  }
  const path = url.searchParams.get("path");
  if (!path) {
    throw new Error("Invalid MBTiles tile path.");
  }

  return {
    path,
    z: parseTileCoordinate(parts[0], "z"),
    x: parseTileCoordinate(parts[1], "x"),
    y: parseTileCoordinate(parts[2], "y"),
  };
}

function parseTileCoordinate(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid MBTiles ${label} coordinate.`);
  }
  return parsed;
}
