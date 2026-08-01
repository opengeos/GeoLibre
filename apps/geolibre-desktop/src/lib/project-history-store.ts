import { parseProject, type GeoLibreProject } from "@geolibre/core";

const DB_NAME = "geolibre-project-history";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";
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

export async function addProjectSnapshot(content: string): Promise<boolean> {
  if (!available()) return false;
  const size = new Blob([content]).size;
  if (size > MAX_SNAPSHOT_BYTES) return false;
  const project = parseProject(content);
  const existing = await listProjectSnapshots();
  if (existing[0]?.content === content) return false;
  const snapshot: ProjectHistorySnapshot = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    content,
    size,
    name: project.name,
    layerCount: project.layers.length,
    basemap: project.basemapStyleUrl,
    camera: project.mapView,
  };
  const retained = [snapshot, ...existing];
  let total = 0;
  const keepIds = new Set<string>();
  for (const entry of retained) {
    if (keepIds.size >= MAX_SNAPSHOTS || total + entry.size > MAX_TOTAL_BYTES) continue;
    keepIds.add(entry.id);
    total += entry.size;
  }
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.put(snapshot);
    existing.filter((entry) => !keepIds.has(entry.id)).forEach((entry) => store.delete(entry.id));
    await transactionDone(transaction);
    return true;
  } finally {
    db.close();
  }
}

export async function deleteProjectSnapshot(id: string): Promise<void> {
  if (!available()) return;
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function clearProjectSnapshots(): Promise<void> {
  if (!available()) return;
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).clear();
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}
