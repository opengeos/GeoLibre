// IndexedDB persistence for the app-level Layer Library (issue #1520) — the
// Browser panel's My Data section. The library must survive across projects and
// app restarts, and IndexedDB is available in both the browser build and the
// Tauri webview, so one code path covers web and desktop. Mirrors the thin
// self-contained wrapper style of style-library-store.ts.

import type { LayerLibraryEntry } from "@geolibre/core";

const DB_NAME = "geolibre-layer-library";
const DB_VERSION = 1;
const STORE_NAME = "entries";

function layerLibraryStorageAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open the layer library database."));
  });
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Layer library request failed."));
  });
}

/**
 * Read every persisted Layer Library entry. Returns an empty list when
 * IndexedDB is unavailable (private browsing, non-browser environment) so the
 * My Data section degrades to an in-memory library instead of failing.
 *
 * @returns The persisted entries, unordered.
 */
export async function loadLayerLibraryEntries(): Promise<LayerLibraryEntry[]> {
  if (!layerLibraryStorageAvailable()) return [];
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readonly");
    return await promisifyRequest(
      transaction.objectStore(STORE_NAME).getAll() as IDBRequest<LayerLibraryEntry[]>,
    );
  } finally {
    db.close();
  }
}

// Chains writes so two rapid library changes can never interleave their
// clear+put transactions out of order (each call opens its own connection, and
// IndexedDB does not guarantee cross-connection transaction creation order
// matches call order). The chain swallows failures so one failed write does not
// poison every later one.
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Replace the persisted Layer Library with `entries` (clear + put in one
 * transaction). Entries hold source specs rather than data, so a wholesale
 * write per change stays cheap and is simpler than diffing puts/deletes.
 * Writes are queued so the last call always wins.
 *
 * @param entries - The complete library to persist.
 */
export function persistLayerLibraryEntries(entries: LayerLibraryEntry[]): Promise<void> {
  const run = () => writeLayerLibraryEntries(entries);
  const result = writeQueue.then(run, run);
  writeQueue = result.catch(() => {});
  return result;
}

async function writeLayerLibraryEntries(entries: LayerLibraryEntry[]): Promise<void> {
  if (!layerLibraryStorageAvailable()) return;
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.clear();
    // Persist the display order too: the store keeps the library
    // most-recently-saved first, but `getAll()` returns entries in key order,
    // so the order has to travel with the records.
    entries.forEach((entry, index) => {
      store.put({ ...entry, order: index });
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Layer library request failed."));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Layer library write was aborted."));
    });
  } finally {
    db.close();
  }
}

/**
 * Restore the saved display order of entries read back from IndexedDB, which
 * returns them in key (id) order. Entries written before the order field
 * existed, or hand-inserted ones, sort last while keeping their relative order.
 *
 * @param entries - Entries as read from the database.
 * @returns The entries in their persisted display order.
 */
export function sortLayerLibraryEntriesByStoredOrder(
  entries: readonly LayerLibraryEntry[],
): LayerLibraryEntry[] {
  return entries
    .map((entry, index) => {
      const stored = (entry as { order?: unknown }).order;
      return {
        entry,
        // Fall back to a value past every real index so unordered entries trail.
        order: typeof stored === "number" && Number.isFinite(stored) ? stored : entries.length,
        index,
      };
    })
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ entry }) => entry);
}
