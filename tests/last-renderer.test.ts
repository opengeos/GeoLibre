import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readLastRenderer,
  writeLastRenderer,
} from "../apps/geolibre-desktop/src/lib/last-renderer";
import { LAST_RENDERER_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";

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

describe("last rendering engine persistence", () => {
  it("round-trips every supported rendering engine", () => {
    const storage = memoryStorage();

    for (const renderer of ["maplibre", "cesium", "mapbox", "arcgis"] as const) {
      writeLastRenderer(renderer, storage);
      assert.equal(readLastRenderer(storage), renderer);
      assert.equal(storage.getItem(LAST_RENDERER_STORAGE_KEY), renderer);
    }
  });

  it("ignores an unknown persisted engine", () => {
    const storage = memoryStorage();
    storage.setItem(LAST_RENDERER_STORAGE_KEY, "unknown");

    assert.equal(readLastRenderer(storage), null);
  });

  it("returns null when nothing has been persisted", () => {
    const storage = memoryStorage();
    assert.equal(readLastRenderer(storage), null);
  });

  it("treats unavailable storage as no saved preference", () => {
    const storage = memoryStorage();
    storage.getItem = () => {
      throw new Error("blocked");
    };

    assert.equal(readLastRenderer(storage), null);
  });
});
