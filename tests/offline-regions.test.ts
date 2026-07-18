import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  deleteOfflineRegion,
  describeBboxCenter,
  exclusiveTileUrls,
  formatBytes,
  loadOfflineRegions,
  type OfflineRegion,
  regionAllUrls,
  regionId,
  renameOfflineRegion,
  touchOfflineRegion,
  upsertOfflineRegion,
  urlHosts,
} from "../apps/geolibre-desktop/src/lib/offline-regions";

/** Minimal in-memory Storage for testing persistence without a browser. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => map.delete(k),
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

function makeRegion(over: Partial<OfflineRegion> = {}): OfflineRegion {
  return {
    id: "r1",
    name: "Region 1",
    bbox: [-10, -10, 10, 10],
    minZoom: 4,
    maxZoom: 6,
    tileUrls: ["https://openfreemap.org/4/1/1.pbf"],
    assetUrls: ["https://openfreemap.org/style.json"],
    tileCount: 1,
    hosts: ["openfreemap.org"],
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

describe("regionId", () => {
  it("is stable for the same bounds and zoom range", () => {
    const a = regionId([-10, -10, 10, 10], 4, 6);
    const b = regionId([-10, -10, 10, 10], 4, 6);
    assert.equal(a, b);
  });

  it("collapses sub-10m viewport jitter to the same id", () => {
    const a = regionId([-10, -10, 10, 10], 4, 6);
    const b = regionId([-10.00001, -10.00001, 10.00001, 10.00001], 4, 6);
    assert.equal(a, b);
  });

  it("differs when the zoom range differs", () => {
    assert.notEqual(regionId([-10, -10, 10, 10], 4, 6), regionId([-10, -10, 10, 10], 4, 7));
  });
});

describe("urlHosts", () => {
  it("returns distinct hostnames and ignores unparseable URLs", () => {
    const hosts = urlHosts([
      "https://a.openfreemap.org/x",
      "https://a.openfreemap.org/y",
      "not a url",
      "https://b.cartocdn.com/z",
    ]);
    assert.deepEqual(hosts.sort(), ["a.openfreemap.org", "b.cartocdn.com"]);
  });
});

describe("exclusiveTileUrls", () => {
  it("returns all tiles when no other region overlaps", () => {
    const region = makeRegion({ tileUrls: ["t1", "t2"] });
    assert.deepEqual(exclusiveTileUrls(region, []), ["t1", "t2"]);
  });

  it("excludes tiles shared with another retained region", () => {
    const region = makeRegion({ id: "r1", tileUrls: ["t1", "t2", "t3"] });
    const other = makeRegion({ id: "r2", tileUrls: ["t2"] });
    assert.deepEqual(exclusiveTileUrls(region, [other]), ["t1", "t3"]);
  });

  it("ignores the region's own entry in the others list", () => {
    const region = makeRegion({ id: "r1", tileUrls: ["t1"] });
    assert.deepEqual(exclusiveTileUrls(region, [region]), ["t1"]);
  });
});

describe("regionAllUrls", () => {
  it("concatenates tile and asset URLs", () => {
    const region = makeRegion({ tileUrls: ["t1"], assetUrls: ["a1"] });
    assert.deepEqual(regionAllUrls(region), ["t1", "a1"]);
  });
});

describe("persistence round-trip", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = fakeStorage();
  });

  it("returns an empty list when nothing is stored", () => {
    assert.deepEqual(loadOfflineRegions(storage), []);
  });

  it("upserts and loads a region, newest first", () => {
    upsertOfflineRegion(makeRegion({ id: "old", updatedAt: 1 }), storage);
    upsertOfflineRegion(makeRegion({ id: "new", updatedAt: 2 }), storage);
    const loaded = loadOfflineRegions(storage);
    assert.deepEqual(
      loaded.map((r) => r.id),
      ["new", "old"],
    );
  });

  it("replaces an existing region by id without duplicating", () => {
    upsertOfflineRegion(makeRegion({ id: "r1", tileCount: 1 }), storage);
    upsertOfflineRegion(makeRegion({ id: "r1", tileCount: 5, updatedAt: 2000 }), storage);
    const loaded = loadOfflineRegions(storage);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].tileCount, 5);
  });

  it("preserves a custom name and original createdAt on re-download", () => {
    upsertOfflineRegion(makeRegion({ id: "r1", name: "My City", createdAt: 100 }), storage);
    upsertOfflineRegion(
      makeRegion({
        id: "r1",
        name: "auto-generated",
        createdAt: 999,
        updatedAt: 2000,
      }),
      storage,
    );
    const loaded = loadOfflineRegions(storage);
    assert.equal(loaded[0].name, "My City");
    assert.equal(loaded[0].createdAt, 100);
    assert.equal(loaded[0].updatedAt, 2000);
  });

  it("renames a region in place", () => {
    upsertOfflineRegion(makeRegion({ id: "r1", name: "Old" }), storage);
    renameOfflineRegion("r1", "New", storage);
    assert.equal(loadOfflineRegions(storage)[0].name, "New");
  });

  it("ignores a corrupt stored value", () => {
    storage.setItem("geolibre.offlineRegions.v1", "{ not json");
    assert.deepEqual(loadOfflineRegions(storage), []);
  });

  it("drops structurally invalid records", () => {
    storage.setItem(
      "geolibre.offlineRegions.v1",
      JSON.stringify([{ id: "x" }, makeRegion({ id: "ok" })]),
    );
    const loaded = loadOfflineRegions(storage);
    assert.deepEqual(
      loaded.map((r) => r.id),
      ["ok"],
    );
  });

  it("drops records with non-numeric bbox or missing numeric fields", () => {
    storage.setItem(
      "geolibre.offlineRegions.v1",
      JSON.stringify([
        makeRegion({ id: "bad-bbox", bbox: [null, "a", {}, 1] as never }),
        { ...makeRegion({ id: "no-hosts" }), hosts: undefined },
        { ...makeRegion({ id: "no-updated" }), updatedAt: undefined },
        makeRegion({ id: "good" }),
      ]),
    );
    assert.deepEqual(
      loadOfflineRegions(storage).map((r) => r.id),
      ["good"],
    );
  });
});

describe("touchOfflineRegion", () => {
  it("bumps updatedAt and reorders newest-first", () => {
    const storage = fakeStorage();
    upsertOfflineRegion(makeRegion({ id: "a", updatedAt: 1 }), storage);
    upsertOfflineRegion(makeRegion({ id: "b", updatedAt: 2 }), storage);
    touchOfflineRegion("a", 100, storage);
    const loaded = loadOfflineRegions(storage);
    assert.deepEqual(
      loaded.map((r) => r.id),
      ["a", "b"],
    );
    assert.equal(loaded[0].updatedAt, 100);
  });

  it("no-ops for an unknown id", () => {
    const storage = fakeStorage();
    upsertOfflineRegion(makeRegion({ id: "a", updatedAt: 1 }), storage);
    touchOfflineRegion("missing", 100, storage);
    assert.equal(loadOfflineRegions(storage)[0].updatedAt, 1);
  });
});

describe("deleteOfflineRegion", () => {
  it("removes the record from the manifest", async () => {
    const storage = fakeStorage();
    upsertOfflineRegion(makeRegion({ id: "r1" }), storage);
    upsertOfflineRegion(makeRegion({ id: "r2", updatedAt: 2 }), storage);
    const { regions } = await deleteOfflineRegion("r1", storage);
    assert.deepEqual(
      regions.map((r) => r.id),
      ["r2"],
    );
    assert.deepEqual(
      loadOfflineRegions(storage).map((r) => r.id),
      ["r2"],
    );
  });
});

describe("describeBboxCenter", () => {
  it("formats the center with hemisphere suffixes", () => {
    assert.equal(describeBboxCenter([10, 20, 30, 40]), "30.00°N, 20.00°E");
  });

  it("uses S/W for negative hemispheres", () => {
    assert.equal(describeBboxCenter([-30, -40, -10, -20]), "30.00°S, 20.00°W");
  });
});

describe("formatBytes", () => {
  it("formats KB, MB, and GB", () => {
    assert.equal(formatBytes(0), "0 KB");
    assert.equal(formatBytes(2048), "2 KB");
    assert.equal(formatBytes(5 * 1024 * 1024), "5 MB");
    assert.equal(formatBytes(3 * 1024 * 1024 * 1024), "3.0 GB");
  });
});
