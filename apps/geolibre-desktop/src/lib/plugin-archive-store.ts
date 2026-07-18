// IndexedDB persistence for plugins installed from an uploaded `.zip` on the web
// build. The desktop build persists installed archives on disk (the Rust loader
// re-scans the app-data `plugins/` directory at startup); the browser has no
// such directory, so the unpacked bundle is stored here and replayed on load by
// the external-plugin loader. Kept free of other imports so it stays a thin,
// self-contained wrapper around IndexedDB.

import type { GeoLibreExternalPluginManifest } from "@geolibre/plugins";

export interface StoredPluginArchive {
  // The plugin id, used as the IndexedDB key so a reinstall overwrites the
  // previous copy rather than accumulating duplicates.
  id: string;
  // The original uploaded file name, kept only for display in the UI.
  archiveName: string;
  manifest: GeoLibreExternalPluginManifest;
  entrySource: string;
  styleSource: string | null;
  installedAt: number;
}

const DB_NAME = "geolibre-plugins";
const DB_VERSION = 1;
const STORE_NAME = "archives";

function pluginArchiveStorageAvailable(): boolean {
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
      reject(request.error ?? new Error("Could not open the plugin database."));
  });
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Plugin database request failed."));
  });
}

/** Persist (or overwrite) an installed plugin archive. */
export async function putPluginArchive(record: StoredPluginArchive): Promise<void> {
  if (!pluginArchiveStorageAvailable()) {
    throw new Error("Installing plugins from a file is not supported here.");
  }
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const done = promisifyRequest(transaction.objectStore(STORE_NAME).put(record));
    await done;
  } finally {
    db.close();
  }
}

/**
 * Read every persisted plugin archive. Returns an empty list when IndexedDB is
 * unavailable (e.g. a private-browsing context or a non-browser environment) so
 * the plugin loader degrades gracefully instead of failing the whole scan.
 */
export async function getAllPluginArchives(): Promise<StoredPluginArchive[]> {
  if (!pluginArchiveStorageAvailable()) return [];
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readonly");
    return await promisifyRequest(
      transaction.objectStore(STORE_NAME).getAll() as IDBRequest<StoredPluginArchive[]>,
    );
  } finally {
    db.close();
  }
}

/** Remove a persisted plugin archive by id. */
export async function deletePluginArchive(id: string): Promise<void> {
  if (!pluginArchiveStorageAvailable()) return;
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    await promisifyRequest(transaction.objectStore(STORE_NAME).delete(id));
  } finally {
    db.close();
  }
}
