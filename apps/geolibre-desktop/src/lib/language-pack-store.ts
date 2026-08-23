import type { InstalledLanguagePack } from "./language-pack";

const DB_NAME = "geolibre-language-packs";
const DB_VERSION = 1;
const STORE_NAME = "packs";

// Tests, server-side rendering, and storage-restricted browsers still get a
// working session-only pack rather than failing merely because IndexedDB is
// unavailable. Normal browser and Tauri sessions use the durable database.
const memoryPacks = new Map<string, InstalledLanguagePack>();

function storageAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "locale" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open the language-pack database."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Language-pack storage failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Language-pack storage failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Language-pack storage was aborted."));
  });
}

export async function loadInstalledLanguagePack(
  locale: string,
): Promise<InstalledLanguagePack | null> {
  if (!storageAvailable()) return memoryPacks.get(locale) ?? null;
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    return (
      (await requestResult(
        transaction.objectStore(STORE_NAME).get(locale) as IDBRequest<
          InstalledLanguagePack | undefined
        >,
      )) ?? null
    );
  } finally {
    database.close();
  }
}

export async function saveInstalledLanguagePack(record: InstalledLanguagePack): Promise<void> {
  memoryPacks.set(record.locale, record);
  if (!storageAvailable()) return;
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function deleteInstalledLanguagePack(locale: string): Promise<void> {
  memoryPacks.delete(locale);
  if (!storageAvailable()) return;
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(locale);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}
