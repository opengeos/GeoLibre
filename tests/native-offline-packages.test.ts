import "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";

const {
  assertNativeOfflinePackageSize,
  MAX_NATIVE_OFFLINE_PACKAGE_BYTES,
  listSavedOfflineBasemaps,
  saveNativeOfflinePackage,
  renameSavedOfflineBasemap,
  setSavedOfflineBasemapFlavor,
  deleteSavedOfflineBasemap,
  verifyNativeOfflinePackage,
  initializeNativeOfflinePackages,
  nativeOfflineBasemapStyleUrl,
} = await import("../apps/geolibre-desktop/src/lib/native-offline-packages");
const { getOfflineBasemapStyle } = await import("../packages/map/src/protomaps-basemap");
const {
  hasPMTilesArchive,
  getRegisteredPMTilesArchive,
  getPMTilesArchive,
  unregisterPMTilesArchive,
  unregisterPMTilesSource,
} = await import("../packages/map/src/pmtiles-archive");
const { nativeLocalPmtilesProtocolUrl } =
  await import("../apps/geolibre-desktop/src/lib/local-media-url");
const { upsertOfflineBasemap, loadOfflineBasemaps } =
  await import("../apps/geolibre-desktop/src/lib/offline-basemaps");
import type { NativeOfflinePackage } from "../apps/geolibre-desktop/src/lib/native-offline-packages";

const entry: NativeOfflinePackage = {
  id: "pkg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  name: "Berkeley",
  bbox: [-123, 37, -122, 38],
  minZoom: 0,
  maxZoom: 8,
  flavor: "light",
  tileType: "vector",
  bytes: 673299,
  savedPath: "/data/org.geolibre.app/offline-packages/package/archive.pmtiles",
  createdAt: 10,
  managed: true,
  archiveFormat: "pmtiles",
  sha256: "a".repeat(64),
};

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

it("loads native inventory without reading archive bytes and preserves legacy exports", async () => {
  const legacy = { ...entry, id: "legacy", managed: false, savedPath: "content://documents/1" };
  upsertOfflineBasemap(legacy);
  const calls: string[] = [];
  mockIPC((command) => {
    calls.push(command);
    assert.equal(command, "list_native_offline_packages");
    return {
      packages: [entry],
      problems: [{ id: "pkg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", error: "missing archive" }],
    };
  });
  const entries = await listSavedOfflineBasemaps();
  assert.deepEqual(
    entries.map((item) => item.id),
    [entry.id, "pkg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", legacy.id],
  );
  assert.equal(entries[1].unavailableReason, "missing archive");
  assert.equal(entries[1].flavor, null, "damaged entries cannot be applied");
  assert.deepEqual(calls, ["list_native_offline_packages"]);
});

it("sends archive bytes through binary IPC and metadata through an encoded header", async () => {
  const bytes = Uint8Array.of(0, 255, 1);
  const details = {
    name: "São Paulo",
    bbox: entry.bbox,
    minZoom: 0,
    maxZoom: 8,
    flavor: "light",
    tileType: "vector" as const,
    archiveFormat: "pmtiles" as const,
  };
  let expected = details;
  mockIPC(() => entry);
  Reflect.set(
    Reflect.get(window, "__TAURI_INTERNALS__"),
    "invoke",
    (command: string, payload: unknown, options?: { headers?: Record<string, string> }) => {
      assert.equal(command, "save_native_offline_package");
      assert.deepEqual(payload, bytes);
      const headers = options?.headers as Record<string, string>;
      const metadata = JSON.parse(decodeURIComponent(headers["x-package-metadata"]));
      assert.deepEqual(metadata, expected);
      assert.ok(new TextEncoder().encode(metadata.name).length <= 512);
      return Promise.resolve(entry);
    },
  );
  assert.deepEqual(await saveNativeOfflinePackage(bytes, details), entry);
  expected = { ...details, name: "🗺".repeat(128) };
  assert.deepEqual(
    await saveNativeOfflinePackage(bytes, { ...details, name: "🗺".repeat(300) }),
    entry,
  );
});

it("keeps managed rename, flavor, verify, and deletion out of browser storage", async () => {
  const calls: [string, unknown][] = [];
  mockIPC((command, payload) => {
    calls.push([command, payload]);
    return entry;
  });
  await renameSavedOfflineBasemap(entry, "New name");
  await setSavedOfflineBasemapFlavor(entry, "dark");
  await verifyNativeOfflinePackage(entry.id);
  await deleteSavedOfflineBasemap(entry);
  assert.deepEqual(calls, [
    ["update_native_offline_package", { id: entry.id, name: "New name" }],
    ["update_native_offline_package", { id: entry.id, flavor: "dark" }],
    ["verify_native_offline_package", { id: entry.id }],
    ["delete_native_offline_package", { id: entry.id }],
  ]);
  assert.deepEqual(loadOfflineBasemaps(), []);
});

it("releases a managed range reader on deletion even after its manifest becomes unavailable", async () => {
  mockIPC(() => undefined);
  const key = nativeLocalPmtilesProtocolUrl(entry.savedPath);
  const styleUrl = nativeOfflineBasemapStyleUrl(entry, "light");
  assert.ok(getOfflineBasemapStyle(styleUrl));
  assert.equal(hasPMTilesArchive(key), true);
  assert.ok(getRegisteredPMTilesArchive(key));
  await deleteSavedOfflineBasemap({ ...entry, savedPath: null });
  assert.equal(hasPMTilesArchive(key), false);
  assert.equal(getRegisteredPMTilesArchive(key), undefined);
});

it("owns and releases range readers for overlay packages without a style resolver", async () => {
  const overlay = {
    ...entry,
    id: "pkg-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    flavor: null,
    savedPath: "/data/offline-packages/overlay/archive.pmtiles",
  };
  mockIPC((command) => {
    if (command === "list_native_offline_packages") return { packages: [overlay], problems: [] };
    if (command === "delete_native_offline_package") return;
    throw new Error(`Unexpected command: ${command}`);
  });
  await listSavedOfflineBasemaps();
  const key = nativeLocalPmtilesProtocolUrl(overlay.savedPath);
  assert.equal(hasPMTilesArchive(key), true);
  // Removing one layer can clear the owned registration while another layer
  // recreates a range reader. Explicit package deletion must release that too.
  unregisterPMTilesArchive(key);
  const recreated = getPMTilesArchive(key);
  assert.ok(recreated);
  assert.equal(hasPMTilesArchive(key), false);
  await deleteSavedOfflineBasemap({ ...overlay, savedPath: null });
  assert.equal(hasPMTilesArchive(key), false);
  assert.equal(getRegisteredPMTilesArchive(key), undefined);
  assert.notEqual(getPMTilesArchive(key), recreated);
  unregisterPMTilesSource(key);
});

it("keeps legacy catalog deletion from deleting an exported provider document", async () => {
  const legacy = { ...entry, managed: false };
  upsertOfflineBasemap(legacy);
  mockIPC(() => {
    throw new Error("Legacy exports must not call native deletion");
  });
  await renameSavedOfflineBasemap(legacy, "Renamed");
  await setSavedOfflineBasemapFlavor(legacy, "dark");
  assert.equal(loadOfflineBasemaps()[0].name, "Renamed");
  await deleteSavedOfflineBasemap(legacy);
  assert.deepEqual(loadOfflineBasemaps(), []);
});

it("serializes rapid updates for one package without resending stale fields", async () => {
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: unknown[] = [];
  mockIPC(async (command, payload) => {
    calls.push([command, payload]);
    if (calls.length === 1) await wait;
    return entry;
  });
  const flavor = setSavedOfflineBasemapFlavor(entry, "dark");
  const rename = renameSavedOfflineBasemap(entry, "Renamed");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 1, "a later update waits for the first native write");
  finish();
  await Promise.all([flavor, rename]);
  assert.deepEqual(calls, [
    ["update_native_offline_package", { id: entry.id, flavor: "dark" }],
    ["update_native_offline_package", { id: entry.id, name: "Renamed" }],
  ]);
});

it("propagates catalog failures and does not substitute an empty native inventory", async () => {
  mockIPC(() => {
    throw new Error("storage unavailable");
  });
  await assert.rejects(listSavedOfflineBasemaps(), /storage unavailable/);
  await assert.rejects(initializeNativeOfflinePackages(), /storage unavailable/);
});

it("initializes lightweight package styles while reporting unavailable entries", async () => {
  const calls: string[] = [];
  mockIPC((command) => {
    calls.push(command);
    return {
      packages: [entry],
      problems: [{ id: "pkg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", error: "missing manifest" }],
    };
  });
  assert.equal(await initializeNativeOfflinePackages(), 1);
  assert.deepEqual(calls, ["list_native_offline_packages"]);
});

it("rejects oversized native plans and payloads before binary IPC", async () => {
  assert.doesNotThrow(() => assertNativeOfflinePackageSize(MAX_NATIVE_OFFLINE_PACKAGE_BYTES));
  assert.throws(
    () => assertNativeOfflinePackageSize(MAX_NATIVE_OFFLINE_PACKAGE_BYTES + 1),
    /512 MiB/,
  );
  let called = false;
  mockIPC(() => {
    called = true;
    throw new Error("Oversized bytes reached IPC");
  });
  // A view over untouched virtual memory needs no download or copied payload.
  const oversized = new Uint8Array(MAX_NATIVE_OFFLINE_PACKAGE_BYTES + 1);
  await assert.rejects(
    saveNativeOfflinePackage(oversized, {
      name: entry.name,
      bbox: entry.bbox,
      minZoom: 0,
      maxZoom: 8,
      flavor: "light",
      tileType: "vector",
      archiveFormat: "pmtiles",
    }),
    /512 MiB/,
  );
  assert.equal(called, false);
});

it("restores vector MBTiles flavors through native tile templates without PMTiles readers", () => {
  const mbtiles: NativeOfflinePackage = {
    ...entry,
    id: "pkg-33333333333333333333333333333333",
    archiveFormat: "mbtiles",
    savedPath: "/data/vector.mbtiles",
  };
  for (const flavor of ["light", "dark"] as const) {
    const url = nativeOfflineBasemapStyleUrl(mbtiles, flavor);
    const style = getOfflineBasemapStyle(url);
    assert.ok(style);
    assert.equal(style.sources.protomaps.type, "vector");
    assert.deepEqual(Reflect.get(style.sources.protomaps, "tiles"), [
      "geolibre-native-mbtiles://tile/{z}/{x}/{y}?path=%2Fdata%2Fvector.mbtiles",
    ]);
    assert.equal(Reflect.get(style.sources.protomaps, "url"), undefined);
    assert.match(Reflect.get(style.sources.protomaps, "attribution") ?? "", /OpenStreetMap/);
    assert.ok(style.layers.length > 10);
  }
  assert.equal(hasPMTilesArchive(nativeLocalPmtilesProtocolUrl(mbtiles.savedPath)), false);
});

it("restores raster package basemaps with bounded native tile sources and no font requests", () => {
  const raster: NativeOfflinePackage = {
    ...entry,
    id: "pkg-44444444444444444444444444444444",
    archiveFormat: "mbtiles",
    tileType: "raster",
    flavor: null,
    savedPath: "/data/raster.mbtiles",
    minZoom: 19,
    maxZoom: 19,
  };
  const style = getOfflineBasemapStyle(nativeOfflineBasemapStyleUrl(raster, "light"));
  assert.ok(style);
  assert.equal(style.sources.offlineRaster.type, "raster");
  assert.equal(Reflect.get(style.sources.offlineRaster, "minzoom"), 19);
  assert.equal(Reflect.get(style.sources.offlineRaster, "maxzoom"), 19);
  assert.equal(style.glyphs, undefined);
  assert.equal(style.sprite, undefined);
  assert.equal(style.layers[1].type, "raster");
});
