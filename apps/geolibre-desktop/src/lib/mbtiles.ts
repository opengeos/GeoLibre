import { useAppStore } from "@geolibre/core";
import { isTauri } from "./tauri-io";
import { invoke } from "@tauri-apps/api/core";
import { addProtocol, type RequestParameters } from "maplibre-gl";
import type { Database } from "sql.js";
import { loadSqlJs } from "./gpkg-ogr-contents";
import {
  browserMbtilesKeysInLayers,
  createBrowserMbtilesKeyGenerator,
  createMbtilesTileReader,
  readMbtilesMetadataFromDb,
  type MbtilesMetadata,
  type MbtilesTileReader,
} from "./mbtiles-sqljs";

export type { MbtilesMetadata };

const MBTILES_PROTOCOL = "geolibre-mbtiles";

interface BrowserMbtilesEntry {
  db: Database;
  reader: MbtilesTileReader;
}

// Databases opened from in-memory bytes (the web build). Tiles are served from
// here by the protocol handler; desktop files go through the Tauri commands.
const browserMbtiles = new Map<string, BrowserMbtilesEntry>();
const nextBrowserMbtilesKey = createBrowserMbtilesKeyGenerator();

// Keys that a layer has referenced at least once. Only these are pruned: a file
// opened in the Add Data form is not on any layer yet, and the form frees it
// itself if it is never added.
const claimedBrowserKeys = new Set<string>();
let pruneSubscriptionInstalled = false;
let pruneScheduled = false;

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
    // Unique per file and per page session, so neither two same-named files nor
    // a saved project's key from an earlier session can resolve to this database.
    const key = nextBrowserMbtilesKey(fileName);
    browserMbtiles.set(key, { db, reader });
    ensurePruneSubscription();
    return { key, metadata };
  } catch (error) {
    reader?.close();
    db.close();
    throw error;
  }
}

/** Close and forget a database opened by {@link openBrowserMbtiles}. */
export function releaseBrowserMbtiles(key: string): void {
  claimedBrowserKeys.delete(key);
  const entry = browserMbtiles.get(key);
  if (!entry) return;
  browserMbtiles.delete(key);
  entry.reader.close();
  entry.db.close();
}

/**
 * Free every browser database that a layer used to reference but no layer
 * references any more. "Referenced" includes the undo/redo snapshots, so undoing
 * a layer removal still finds its tiles; a database is released only once the
 * layer is gone from the live state *and* from history.
 */
export function pruneBrowserMbtiles(): void {
  if (browserMbtiles.size === 0) return;
  const { pastStates, futureStates } = useAppStore.temporal.getState();
  const live = browserMbtilesKeysInLayers([
    useAppStore.getState().layers,
    ...pastStates.map((state) => state.layers ?? []),
    ...futureStates.map((state) => state.layers ?? []),
  ]);
  for (const key of live) {
    if (browserMbtiles.has(key)) claimedBrowserKeys.add(key);
  }
  for (const key of [...browserMbtiles.keys()]) {
    if (claimedBrowserKeys.has(key) && !live.has(key)) releaseBrowserMbtiles(key);
  }
}

// A layer can disappear through paths that never touch the layer panel (the
// scripting API, plugin teardown, New Project resetting `layers`), and the undo
// history can later drop the snapshots that kept it alive. Watching the store
// and its history frees the database whichever way the last reference went.
// The prune is deferred to a microtask because zundo records the previous state
// *after* the store notifies its subscribers: pruning synchronously would free a
// database whose removal is about to become an undo entry.
function schedulePrune(): void {
  if (pruneScheduled) return;
  pruneScheduled = true;
  queueMicrotask(() => {
    pruneScheduled = false;
    pruneBrowserMbtiles();
  });
}

function ensurePruneSubscription(): void {
  if (pruneSubscriptionInstalled) return;
  pruneSubscriptionInstalled = true;
  useAppStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) schedulePrune();
  });
  useAppStore.temporal.subscribe((state, previous) => {
    if (state.pastStates !== previous.pastStates || state.futureStates !== previous.futureStates) {
      schedulePrune();
    }
  });
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
