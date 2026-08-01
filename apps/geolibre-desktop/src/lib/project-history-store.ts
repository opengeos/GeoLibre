import { parseProject, type GeoLibreProject } from "@geolibre/core";

const DB_NAME = "geolibre-project-history";
const DB_VERSION = 2;
const STORE_NAME = "snapshots";
const METADATA_STORE_NAME = "snapshot-metadata";
const MAX_SNAPSHOTS = 20;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;

export interface ProjectHistorySnapshot {
  id: string;
  createdAt: string;
  content: string;
  size: number;
  name: string;
  layerCount: number;
  basemap: string;
  camera: GeoLibreProject["mapView"];
  contentHash?: string;
}

type ProjectHistoryMetadata = Omit<ProjectHistorySnapshot, "content">;

function snapshotMetadata(snapshot: ProjectHistorySnapshot): ProjectHistoryMetadata {
  return {
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    size: snapshot.size,
    name: snapshot.name,
    layerCount: snapshot.layerCount,
    basemap: snapshot.basemap,
    camera: snapshot.camera,
    contentHash: snapshot.contentHash,
  };
}

function available(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!request.result.objectStoreNames.contains(METADATA_STORE_NAME)) {
        const metadataStore = request.result.createObjectStore(METADATA_STORE_NAME, {
          keyPath: "id",
        });
        if (request.transaction && request.result.objectStoreNames.contains(STORE_NAME)) {
          const cursorRequest = request.transaction.objectStore(STORE_NAME).openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            metadataStore.put(snapshotMetadata(cursor.value as ProjectHistorySnapshot));
            cursor.continue();
          };
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open project history."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Project history request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Project history transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Project history transaction was aborted."));
  });
}

export async function listProjectSnapshots(): Promise<ProjectHistorySnapshot[]> {
  if (!available()) return [];
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const snapshots = await requestResult(
      transaction.objectStore(STORE_NAME).getAll() as IDBRequest<ProjectHistorySnapshot[]>,
    );
    return snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } finally {
    db.close();
  }
}

async function listProjectSnapshotMetadata(): Promise<ProjectHistoryMetadata[]> {
  if (!available()) return [];
  const db = await openDatabase();
  try {
    const transaction = db.transaction(METADATA_STORE_NAME, "readonly");
    const entries = await requestResult(
      transaction.objectStore(METADATA_STORE_NAME).getAll() as IDBRequest<ProjectHistoryMetadata[]>,
    );
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } finally {
    db.close();
  }
}

export type AddProjectSnapshotResult = "added" | "duplicate" | "too-large";

export async function addProjectSnapshot(content: string): Promise<AddProjectSnapshotResult> {
  if (!available()) return "duplicate";
  const size = new Blob([content]).size;
  if (size > MAX_SNAPSHOT_BYTES) {
    console.warn(
      `Project autosave skipped: snapshot is ${size} bytes, above the ${MAX_SNAPSHOT_BYTES}-byte limit.`,
    );
    return "too-large";
  }
  const project = parseProject(content);
  const contentHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const existing = await listProjectSnapshotMetadata();
  if (existing[0]?.contentHash === contentHash) return "duplicate";
  const snapshot: ProjectHistorySnapshot = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    content,
    size,
    name: project.name,
    layerCount: project.layers.length,
    basemap: project.basemapStyleUrl,
    camera: project.mapView,
    contentHash,
  };
  const retained = [snapshot, ...existing];
  let total = 0;
  const keepIds = new Set<string>();
  for (const entry of retained) {
    if (keepIds.size >= MAX_SNAPSHOTS || total + entry.size > MAX_TOTAL_BYTES) break;
    keepIds.add(entry.id);
    total += entry.size;
  }
  const db = await openDatabase();
  try {
    const transaction = db.transaction([STORE_NAME, METADATA_STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const metadataStore = transaction.objectStore(METADATA_STORE_NAME);
    store.put(snapshot);
    metadataStore.put(snapshotMetadata(snapshot));
    existing
      .filter((entry) => !keepIds.has(entry.id))
      .forEach((entry) => {
        store.delete(entry.id);
        metadataStore.delete(entry.id);
      });
    await transactionDone(transaction);
    return "added";
  } finally {
    db.close();
  }
}

export async function deleteProjectSnapshot(id: string): Promise<void> {
  if (!available()) return;
  const db = await openDatabase();
  try {
    const transaction = db.transaction([STORE_NAME, METADATA_STORE_NAME], "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.objectStore(METADATA_STORE_NAME).delete(id);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function clearProjectSnapshots(): Promise<void> {
  if (!available()) return;
  const db = await openDatabase();
  try {
    const transaction = db.transaction([STORE_NAME, METADATA_STORE_NAME], "readwrite");
    transaction.objectStore(STORE_NAME).clear();
    transaction.objectStore(METADATA_STORE_NAME).clear();
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}
