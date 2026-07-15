import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deleteOfflineBasemap,
  loadOfflineBasemaps,
  type OfflineBasemap,
  OFFLINE_BASEMAPS_KEY,
  renameOfflineBasemap,
  setOfflineBasemapFlavor,
  upsertOfflineBasemap,
} from "../apps/geolibre-desktop/src/lib/offline-basemaps";

/** Minimal in-memory Storage so the catalogue helpers can be tested without a
 * DOM/localStorage. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  } as Storage;
}

function entry(overrides: Partial<OfflineBasemap> = {}): OfflineBasemap {
  return {
    id: "a",
    name: "Area A",
    bbox: [0, 0, 1, 1],
    minZoom: 0,
    maxZoom: 10,
    flavor: "light",
    tileType: "vector",
    bytes: 1234,
    savedPath: null,
    createdAt: 1,
    ...overrides,
  };
}

describe("offline-basemaps catalogue", () => {
  it("returns an empty list before anything is saved", () => {
    assert.deepEqual(loadOfflineBasemaps(memoryStorage()), []);
  });

  it("upserts newest-first and replaces by id", () => {
    const store = memoryStorage();
    upsertOfflineBasemap(entry({ id: "a", name: "A" }), store);
    upsertOfflineBasemap(entry({ id: "b", name: "B" }), store);
    assert.deepEqual(
      loadOfflineBasemaps(store).map((b) => b.id),
      ["b", "a"],
    );
    // Re-upserting an existing id replaces it and moves it to the front.
    upsertOfflineBasemap(entry({ id: "a", name: "A2" }), store);
    const list = loadOfflineBasemaps(store);
    assert.deepEqual(
      list.map((b) => b.id),
      ["a", "b"],
    );
    assert.equal(list[0].name, "A2");
  });

  it("renames, ignoring a blank name, and changes flavor", () => {
    const store = memoryStorage();
    upsertOfflineBasemap(entry({ id: "a", name: "A", flavor: "light" }), store);
    renameOfflineBasemap("a", "  Renamed  ", store);
    assert.equal(loadOfflineBasemaps(store)[0].name, "Renamed");
    renameOfflineBasemap("a", "   ", store);
    assert.equal(loadOfflineBasemaps(store)[0].name, "Renamed");
    setOfflineBasemapFlavor("a", "dark", store);
    assert.equal(loadOfflineBasemaps(store)[0].flavor, "dark");
  });

  it("deletes by id", () => {
    const store = memoryStorage();
    upsertOfflineBasemap(entry({ id: "a" }), store);
    upsertOfflineBasemap(entry({ id: "b" }), store);
    deleteOfflineBasemap("a", store);
    assert.deepEqual(
      loadOfflineBasemaps(store).map((b) => b.id),
      ["b"],
    );
  });

  it("ignores malformed persisted data", () => {
    const store = memoryStorage();
    store.setItem(OFFLINE_BASEMAPS_KEY, "not json");
    assert.deepEqual(loadOfflineBasemaps(store), []);
    store.setItem(OFFLINE_BASEMAPS_KEY, JSON.stringify({ not: "an array" }));
    assert.deepEqual(loadOfflineBasemaps(store), []);
    // Entries missing required shape are filtered out; valid ones survive.
    store.setItem(
      OFFLINE_BASEMAPS_KEY,
      JSON.stringify([{ id: 1 }, entry({ id: "ok" }), { name: "no id" }]),
    );
    assert.deepEqual(
      loadOfflineBasemaps(store).map((b) => b.id),
      ["ok"],
    );
  });
});
