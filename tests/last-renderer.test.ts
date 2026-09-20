import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readLastRenderer,
  writeLastRenderer,
} from "../apps/geolibre-desktop/src/lib/last-renderer";
import { LAST_RENDERER_STORAGE_KEY } from "../apps/geolibre-desktop/src/lib/storage-keys";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("last rendering engine persistence", () => {
  it("round-trips every supported rendering engine", () => {
    const storage = new MemoryStorage() as unknown as Storage;

    for (const renderer of ["maplibre", "cesium", "mapbox", "arcgis"] as const) {
      writeLastRenderer(renderer, storage);
      assert.equal(readLastRenderer(storage), renderer);
      assert.equal(storage.getItem(LAST_RENDERER_STORAGE_KEY), renderer);
    }
  });

  it("ignores an unknown persisted engine", () => {
    const storage = new MemoryStorage() as unknown as Storage;
    storage.setItem(LAST_RENDERER_STORAGE_KEY, "unknown");

    assert.equal(readLastRenderer(storage), null);
  });

  it("returns null when nothing has been persisted", () => {
    const storage = new MemoryStorage() as unknown as Storage;
    assert.equal(readLastRenderer(storage), null);
  });

  it("treats unavailable storage as no saved preference", () => {
    const storage = new MemoryStorage();
    storage.getItem = () => {
      throw new Error("blocked");
    };

    assert.equal(readLastRenderer(storage as unknown as Storage), null);
  });
});
