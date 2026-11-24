import "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";

const { openLocalDataFileWithFallback, openLocalDataFilesWithFallback } =
  await import("../apps/geolibre-desktop/src/lib/file-io/file-dialogs");
const { pickLocalRasterFiles } =
  await import("../apps/geolibre-desktop/src/lib/file-io/raster-photo-files");
const { pickVectorFilesWithSidecars } =
  await import("../apps/geolibre-desktop/src/lib/file-io/vector-loader");
const { clearNotifications, useNotificationStore } =
  await import("../apps/geolibre-desktop/src/lib/notify");

const previous = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
const calls: { command: string; args?: Record<string, unknown> }[] = [];
let selected: string | string[] | null;
let selectionError: Error | undefined;
const bytes = new TextEncoder().encode('{"type":"FeatureCollection","features":[]}');

beforeEach(() => {
  calls.length = 0;
  selected = null;
  selectionError = undefined;
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === "plugin:dialog|open") {
          const options = args?.options;
          assert.ok(options && typeof options === "object" && "fileAccessMode" in options);
          assert.equal(options.fileAccessMode, "copy", "data picks must request managed files");
          if (selectionError) throw selectionError;
          return selected;
        }
        if (command === "plugin:fs|read_file") return bytes;
        if (command === "allow_raster_asset") return;
        throw new Error(`Unexpected native call: ${command}`);
      },
      convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
    },
  });
});

afterEach(() => {
  clearNotifications();
  if (previous) Object.defineProperty(window, "__TAURI_INTERNALS__", previous);
  else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

it("keeps the managed MBTiles path without reading the archive through IPC", async () => {
  selected = "/data/user/0/org.geolibre.app/files/picked-documents/selection/data/map.mbtiles";
  const result = await openLocalDataFileWithFallback({
    filters: [{ name: "MBTiles", extensions: ["mbtiles"] }],
    accept: ".mbtiles",
  });
  assert.equal(result?.path, selected);
  assert.equal(result?.data, undefined);
  assert.deepEqual(
    calls.map(({ command }) => command),
    ["plugin:dialog|open"],
  );
});

it("reads every managed data file under its retained filename", async () => {
  selected = [
    "/private/Documents/selection/data/one.gpkg",
    "/private/Documents/selection/data/two.gpkg",
  ];
  const files = await openLocalDataFilesWithFallback({
    filters: [{ name: "GeoPackage", extensions: ["gpkg"] }],
    accept: ".gpkg",
  });
  assert.deepEqual(
    files.map(({ path }) => path),
    selected,
  );
  assert.deepEqual(
    files.map(({ data }) => [...new Uint8Array(data)]),
    [[...bytes], [...bytes]],
  );
});

it("grants the picked raster's managed path before returning its range-readable asset URL", async () => {
  const path = "/data/user/0/org.geolibre.app/files/picked-documents/selection/data/Berkeley.tif";
  selected = [path];
  const files = await pickLocalRasterFiles();
  assert.deepEqual(
    calls.map(({ command }) => command),
    ["plugin:dialog|open", "allow_raster_asset"],
  );
  assert.deepEqual(calls[1].args, { path });
  assert.deepEqual(files, [{ path, file: `asset://localhost/${encodeURIComponent(path)}` }]);
});

it("retains a managed vector path for project restoration", async () => {
  const path = "/private/Documents/selection/data/cities.geojson";
  selected = [path];
  const files = await pickVectorFilesWithSidecars();
  assert.equal(files.length, 1);
  assert.equal(files[0].file.name, "cities.geojson");
  assert.equal(files[0].sourcePath, path);
  assert.equal(await files[0].file.text(), new TextDecoder().decode(bytes));
});

it("returns no files when a managed data selection is cancelled", async () => {
  assert.deepEqual(await pickLocalRasterFiles(), []);
  assert.deepEqual(await pickVectorFilesWithSidecars(), []);
  assert.deepEqual(useNotificationStore.getState().notifications, []);
});

it("preserves a genuine copy error instead of treating it as cancellation", async () => {
  selectionError = new Error("The selected document could not be copied");
  await assert.rejects(
    openLocalDataFileWithFallback({
      filters: [{ name: "MBTiles", extensions: ["mbtiles"] }],
      accept: ".mbtiles",
    }),
    /could not be copied/,
  );
  assert.equal(useNotificationStore.getState().notifications.at(-1)?.kind, "error");
  assert.equal(
    useNotificationStore.getState().notifications.at(-1)?.description,
    "The selected document could not be copied",
  );
});

it("explains that mobile edits stay in the imported files", async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Android" });
  selected =
    "/data/user/0/org.geolibre.app/files/picked-documents/3cb9b477-d563-4d3e-8503-263ec23c01c5/data/map.mbtiles";
  clearNotifications();
  try {
    await openLocalDataFileWithFallback({
      filters: [{ name: "MBTiles", extensions: ["mbtiles"] }],
      accept: ".mbtiles",
    });
    const notification = useNotificationStore.getState().notifications.at(-1);
    assert.equal(notification?.message, "Imported 1 file into GeoLibre.");
    assert.match(notification?.description ?? "", /Export edited data to a new file/);
  } finally {
    clearNotifications();
    if (original) Object.defineProperty(navigator, "userAgent", original);
    else Reflect.deleteProperty(navigator, "userAgent");
  }
});
