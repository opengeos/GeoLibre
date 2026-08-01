// IndexedDB persistence for the app-level Template Library.
// The template library survives across projects and app restarts.

import type { ProjectTemplateEntry } from "@geolibre/core";

const DB_NAME = "geolibre-template-library";
const DB_VERSION = 1;
const STORE_NAME = "templates";

function templateLibraryStorageAvailable(): boolean {
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
      reject(request.error ?? new Error("Could not open the template library database."));
  });
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Template library request failed."));
  });
}

/**
 * Read every persisted app-level template library entry. Returns an empty list
 * when IndexedDB is unavailable.
 */
export async function loadTemplateLibraryEntries(): Promise<ProjectTemplateEntry[]> {
  if (!templateLibraryStorageAvailable()) return [];
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readonly");
    return await promisifyRequest(
      transaction.objectStore(STORE_NAME).getAll() as IDBRequest<ProjectTemplateEntry[]>,
    );
  } finally {
    db.close();
  }
}

let writeQueue: Promise<void> = Promise.resolve();

/**
 * Replace the persisted app-level template library with `entries`.
 */
export function persistTemplateLibraryEntries(entries: ProjectTemplateEntry[]): Promise<void> {
  const run = () => writeTemplateLibraryEntries(entries);
  const result = writeQueue.then(run, run);
  writeQueue = result.catch(() => {});
  return result;
}

async function writeTemplateLibraryEntries(entries: ProjectTemplateEntry[]): Promise<void> {
  if (!templateLibraryStorageAvailable()) return;
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
        reject(transaction.error ?? new Error("Template library request failed."));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Template library write was aborted."));
    });
  } finally {
    db.close();
  }
}
