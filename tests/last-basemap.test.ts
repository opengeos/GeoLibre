import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readLastBasemap, writeLastBasemap } from "../apps/geolibre-desktop/src/lib/last-basemap";
import { LAST_BASEMAP_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("last basemap persistence", () => {
  it("round-trips a selected basemap", () => {
    const storage = memoryStorage();
    writeLastBasemap("https://example.com/style.json", storage);
    assert.equal(readLastBasemap(storage), "https://example.com/style.json");
    assert.equal(storage.getItem(LAST_BASEMAP_STORAGE_KEY), "https://example.com/style.json");
  });

  it("preserves the empty string used by the blank basemap", () => {
    const storage = memoryStorage();
    writeLastBasemap("", storage);
    assert.equal(readLastBasemap(storage), "");
  });

  it("treats unavailable storage as no saved preference", () => {
    const storage = memoryStorage();
    storage.getItem = () => {
      throw new Error("blocked");
    };
    assert.equal(readLastBasemap(storage), null);
  });
});
