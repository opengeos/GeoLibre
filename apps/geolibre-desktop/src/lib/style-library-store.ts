// IndexedDB persistence for the app-level Style Manager library (issue #1294).
// The library must survive across projects and app restarts, and IndexedDB is
// available in both the browser build and the Tauri webview, so one code path
// covers web and desktop. Mirrors the thin self-contained wrapper style of
// plugin-archive-store.ts; project-scoped entries are NOT stored here (they
// serialize into the .geolibre.json file instead).

import type { StyleLibraryEntry } from "@geolibre/core";

const DB_NAME = "geolibre-style-library";
const DB_VERSION = 1;
const STORE_NAME = "entries";

function styleLibraryStorageAvailable(): boolean {
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
      reject(
        request.error ?? new Error("Could not open the style library database."),
      );
  });
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Style library request failed."));
  });
}

/**
 * Read every persisted app-level style library entry. Returns an empty list
 * when IndexedDB is unavailable (private browsing, non-browser environment) so
 * the Style Manager degrades to an in-memory library instead of failing.
 *
 * @returns The persisted entries, unordered.
 */
export async function loadStyleLibraryEntries(): Promise<StyleLibraryEntry[]> {
  if (!styleLibraryStorageAvailable()) return [];
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readonly");
    return await promisifyRequest(
      transaction.objectStore(STORE_NAME).getAll() as IDBRequest<
        StyleLibraryEntry[]
      >,
    );
  } finally {
    db.close();
  }
}

/**
 * Replace the persisted app-level library with `entries` (clear + put in one
 * transaction). The library is small JSON, so a wholesale write per change is
 * simpler and safer than diffing puts/deletes against the store.
 *
 * @param entries - The complete app-level library to persist.
 */
export async function persistStyleLibraryEntries(
  entries: StyleLibraryEntry[],
): Promise<void> {
  if (!styleLibraryStorageAvailable()) return;
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.clear();
    for (const entry of entries) {
      store.put(entry);
    }
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(
          transaction.error ?? new Error("Style library request failed."),
        );
      transaction.onabort = () =>
        reject(
          transaction.error ?? new Error("Style library write was aborted."),
        );
    });
  } finally {
    db.close();
  }
}
