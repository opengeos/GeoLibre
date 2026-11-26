/**
 * Persisted state of the offline edit outbox (#3530).
 *
 * Entries live in IndexedDB, which both the browser build and the Tauri
 * webview provide (in the desktop app it is kept in the app's own data
 * directory), so queued edits survive a reload, a crash, or an app restart on
 * every platform. When IndexedDB is unavailable (a private window) the outbox
 * still works in memory for the session and reports that it is not durable.
 *
 * The store is a tiny external store (subscribe + snapshot) so React reads it
 * with `useSyncExternalStore` and the sync runner reads it without React.
 */

import type { OutboxEntry } from "./edit-outbox";

const DB_NAME = "geolibre-edit-outbox";
const DB_VERSION = 1;
const STORE_NAME = "entries";

/** Where entries are persisted. Swappable for tests. */
export interface OutboxPersistence {
  load(): Promise<OutboxEntry[]>;
  put(entry: OutboxEntry): Promise<void>;
  remove(id: string): Promise<void>;
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open the edit outbox database."));
  });
}

function settle(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Edit outbox transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Edit outbox transaction aborted."));
  });
}

/**
 * IndexedDB-backed persistence. Each call opens and closes its own
 * connection, which keeps a blocked upgrade in another tab from wedging the
 * app's long-lived state.
 *
 * @param factory The IndexedDB factory (defaults to the global one).
 * @returns A persistence implementation.
 */
export function indexedDbOutboxPersistence(
  factory: IDBFactory = globalThis.indexedDB,
): OutboxPersistence {
  const withStore = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T | undefined> => {
    const db = await openDatabase(factory);
    try {
      const transaction = db.transaction(STORE_NAME, mode);
      const done = settle(transaction);
      const request = run(transaction.objectStore(STORE_NAME));
      await done;
      return request ? request.result : undefined;
    } finally {
      db.close();
    }
  };
  return {
    async load() {
      const rows = await withStore("readonly", (store) => store.getAll() as IDBRequest<unknown[]>);
      return (rows ?? []).filter(isOutboxEntry);
    },
    async put(entry) {
      await withStore("readwrite", (store) => {
        store.put(entry);
      });
    },
    async remove(id) {
      await withStore("readwrite", (store) => {
        store.delete(id);
      });
    },
  };
}

/** In-memory persistence: the fallback when IndexedDB is missing, and a test seam. */
export function memoryOutboxPersistence(initial: OutboxEntry[] = []): OutboxPersistence {
  const rows = new Map(initial.map((entry) => [entry.id, structuredClone(entry)]));
  return {
    async load() {
      return [...rows.values()].map((entry) => structuredClone(entry));
    },
    async put(entry) {
      rows.set(entry.id, structuredClone(entry));
    },
    async remove(id) {
      rows.delete(id);
    },
  };
}

/** Structural check for rows read back from storage written by any version. */
export function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<OutboxEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.backend === "string" &&
    typeof entry.layerId === "string" &&
    Array.isArray(entry.ops) &&
    typeof entry.target === "object" &&
    entry.target !== null
  );
}

/** Snapshot the UI reads. */
export interface OutboxSnapshot {
  entries: readonly OutboxEntry[];
  /** True once persisted entries have been read. */
  loaded: boolean;
  /** False when entries live only in memory and will not survive a reload. */
  durable: boolean;
  /**
   * Set when the queue stored on this device could not be read at startup:
   * entries saved earlier are still on disk but not in this session's list.
   */
  storageError?: string;
  /** The last failed write to storage, if any (entries then live in memory). */
  writeError?: string;
}

type Listener = () => void;

let persistence: OutboxPersistence | null = null;
let snapshot: OutboxSnapshot = { entries: [], loaded: false, durable: true };
const listeners = new Set<Listener>();
let loadPromise: Promise<void> | null = null;
// Serializes writes so the last call for an entry always wins on disk.
let writeChain: Promise<void> = Promise.resolve();

function emit(next: OutboxSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function resolvePersistence(): OutboxPersistence {
  if (persistence) return persistence;
  if (typeof indexedDB === "undefined") {
    persistence = memoryOutboxPersistence();
    snapshot = { ...snapshot, durable: false };
  } else {
    persistence = indexedDbOutboxPersistence();
  }
  return persistence;
}

/**
 * Replace the persistence backend and reset the in-memory state (tests, or a
 * fallback after IndexedDB fails).
 *
 * @param next The backend, or null to pick the default again.
 * @param durable Whether the backend survives a reload.
 */
export function setOutboxPersistence(next: OutboxPersistence | null, durable = true): void {
  persistence = next;
  loadPromise = null;
  writeChain = Promise.resolve();
  emit({ entries: [], loaded: false, durable });
}

/** Subscribe to outbox changes. Returns the unsubscribe function. */
export function subscribeOutbox(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current outbox snapshot (stable between changes). */
export function getOutboxSnapshot(): OutboxSnapshot {
  return snapshot;
}

/** Read one entry by id. */
export function getOutboxEntry(id: string): OutboxEntry | undefined {
  return snapshot.entries.find((entry) => entry.id === id);
}

/**
 * Load persisted entries once. Entries left `syncing` by a crash or a closed
 * tab go back to `pending`, since that attempt is gone.
 *
 * @returns Resolves when the snapshot reflects storage.
 */
export function loadOutbox(): Promise<void> {
  if (loadPromise) return loadPromise;
  const backend = resolvePersistence();
  loadPromise = backend
    .load()
    .then((rows) => {
      const known = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
      for (const row of rows) {
        if (known.has(row.id)) continue;
        known.set(row.id, row.status === "syncing" ? { ...row, status: "pending" } : row);
      }
      emit({ ...snapshot, entries: [...known.values()], loaded: true });
    })
    .catch((error: unknown) => {
      // Storage refused (quota, blocked, private mode): keep working in memory.
      persistence = memoryOutboxPersistence(snapshot.entries as OutboxEntry[]);
      emit({
        ...snapshot,
        loaded: true,
        durable: false,
        storageError: error instanceof Error ? error.message : String(error),
      });
    });
  return loadPromise;
}

function persist(run: (backend: OutboxPersistence) => Promise<void>): Promise<void> {
  const backend = resolvePersistence();
  const next = writeChain.then(() => run(backend));
  writeChain = next.catch((error: unknown) => {
    emit({
      ...snapshot,
      durable: false,
      writeError: error instanceof Error ? error.message : String(error),
    });
  });
  return writeChain;
}

/**
 * Insert or replace an entry, in memory immediately and on disk in order.
 *
 * @param entry The entry.
 * @returns Resolves once the write reached storage (or failed and was recorded).
 */
export function putOutboxEntry(entry: OutboxEntry): Promise<void> {
  const entries = snapshot.entries.some((candidate) => candidate.id === entry.id)
    ? snapshot.entries.map((candidate) => (candidate.id === entry.id ? entry : candidate))
    : [...snapshot.entries, entry];
  emit({ ...snapshot, entries });
  return persist((backend) => backend.put(entry));
}

/**
 * Remove an entry (synced, or discarded by the user).
 *
 * @param id The entry id.
 * @returns Resolves once the delete reached storage.
 */
export function removeOutboxEntry(id: string): Promise<void> {
  emit({ ...snapshot, entries: snapshot.entries.filter((entry) => entry.id !== id) });
  return persist((backend) => backend.remove(id));
}
