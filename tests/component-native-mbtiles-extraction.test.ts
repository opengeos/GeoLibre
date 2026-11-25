import { render, screen, fireEvent, waitFor, useAppStore } from "./helpers/dom";
import { createElement } from "react";
import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { NativeOfflinePackage } from "../apps/geolibre-desktop/src/lib/native-offline-packages";
const { BasemapExtractPanel } =
  await import("../apps/geolibre-desktop/src/components/layout/BasemapExtractPanel");

const entry: NativeOfflinePackage = {
  id: "pkg-77777777777777777777777777777777",
  name: "Berkeley subset",
  bbox: [-122.2614, 37.8698, -122.258, 37.8729],
  minZoom: 19,
  maxZoom: 19,
  flavor: null,
  tileType: "raster",
  bytes: 3514368,
  savedPath: "/data/offline-packages/pkg-77777777777777777777777777777777/archive.mbtiles",
  createdAt: 1,
  managed: true,
  archiveFormat: "mbtiles",
  sha256: "a".repeat(64),
};
const rasterMetadata = {
  name: "Berkeley",
  tileType: "raster",
  format: "png",
  sourceLayers: [],
  bounds: [-122.2614, 37.8698, -122.2543, 37.8729],
  minZoom: 19,
  maxZoom: 19,
  scheme: "tms",
};

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  Reflect.deleteProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__");
});

function mountPanel() {
  Reflect.set(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", { unregisterListener: () => {} });
  return render(
    createElement(BasemapExtractPanel, {
      open: true,
      onClose: () => {},
      mapControllerRef: { current: null },
      mapReadyGeneration: 0,
    }),
  );
}

async function chooseSource() {
  fireEvent.change(screen.getByRole("combobox", { name: "Source" }), {
    target: { value: "mbtiles" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Choose MBTiles file…" }));
  await waitFor(() =>
    assert.equal((screen.getByLabelText("Max zoom") as HTMLInputElement).value, "19"),
  );
  fireEvent.change(screen.getByLabelText("East"), { target: { value: "-122.258" } });
}

for (const maximum of [18, 24]) {
  it(`refuses a saved package above the supported maximum zoom ${maximum} before changing the map`, async () => {
    const minimum = maximum === 24 ? 25 : 19;
    const saved = { ...entry, minZoom: minimum, maxZoom: minimum };
    const preferences = useAppStore.getState().preferences;
    useAppStore.setState({
      preferences: { ...preferences, map: { ...preferences.map, maxZoom: maximum } },
    });
    mockIPC((command) => {
      if (command === "list_native_offline_packages") return { packages: [saved], problems: [] };
      if (command === "verify_native_offline_package") return saved;
      throw new Error(`Unexpected command: ${command}`);
    });
    const before = useAppStore.getState().basemapStyleUrl;
    mountPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Use as basemap" }));
    await screen.findByText(new RegExp(`This package needs zoom ${minimum}`));
    assert.equal(useAppStore.getState().basemapStyleUrl, before);
    assert.equal(useAppStore.getState().layers.length, 0);
    assert.equal(screen.queryByText("Using the package saved on this device.") === null, true);
  });
}

it("extracts a raster area by native path and reapplies the persisted package as a basemap", async () => {
  let saved = false;
  let verified = false;
  const commands: string[] = [];
  mockIPC((command, args) => {
    commands.push(command);
    if (command === "list_native_offline_packages")
      return { packages: saved ? [entry] : [], problems: [] };
    if (command === "plugin:dialog|open") return "/data/source.mbtiles";
    if (command === "prepare_native_offline_extraction") return "extract-fixture";
    if (command === "inspect_native_mbtiles_source") return rasterMetadata;
    if (command === "extract_native_mbtiles_package") {
      assert.deepEqual(args, {
        jobId: "extract-fixture",
        path: "/data/source.mbtiles",
        name: "Berkeley",
        options: { bbox: entry.bbox, minZoom: 19, maxZoom: 19 },
        flavor: null,
      });
      saved = true;
      return {
        package: entry,
        tileCount: 42,
        payloadBytes: 3471132,
        tileFormat: "png",
        sourceLayers: [],
      };
    }
    if (command === "verify_native_offline_package") {
      verified = true;
      return entry;
    }
    if (command === "cancel_native_offline_extraction" || command.startsWith("plugin:event|"))
      return 1;
    throw new Error(`Unexpected command: ${command}`);
  });
  mountPanel();
  await chooseSource();
  const before = useAppStore.getState().basemapStyleUrl;
  fireEvent.click(screen.getByRole("button", { name: "Extract" }));
  await screen.findByText("Saved 42 tiles in a package on this device.");
  assert.equal(
    useAppStore.getState().basemapStyleUrl,
    `geolibre://offline-basemap/${entry.id}/light`,
  );
  assert.equal(commands.includes("plugin:fs|read_file"), false);
  useAppStore.getState().setBasemapStyleUrl(before);
  fireEvent.click(screen.getByRole("button", { name: "Use as basemap" }));
  await waitFor(() => assert.equal(verified, true));
  await waitFor(() =>
    assert.equal(
      useAppStore.getState().basemapStyleUrl,
      `geolibre://offline-basemap/${entry.id}/light`,
    ),
  );
});

it("adds generic vector packages as owned layers and restores them from the saved list", async () => {
  const vector = { ...entry, tileType: "vector" as const };
  let saved = false;
  mockIPC((command) => {
    if (command === "list_native_offline_packages")
      return { packages: saved ? [vector] : [], problems: [] };
    if (command === "plugin:dialog|open") return "/data/source.mbtiles";
    if (command === "prepare_native_offline_extraction") return "extract-vector";
    if (command === "inspect_native_mbtiles_source")
      return { ...rasterMetadata, tileType: "vector", format: "pbf", sourceLayers: ["counties"] };
    if (command === "extract_native_mbtiles_package") {
      saved = true;
      return {
        package: vector,
        tileCount: 42,
        payloadBytes: 100,
        tileFormat: "pbf",
        sourceLayers: ["counties"],
      };
    }
    if (command === "verify_native_offline_package") return vector;
    if (command === "cancel_native_offline_extraction" || command.startsWith("plugin:event|"))
      return 1;
    throw new Error(`Unexpected command: ${command}`);
  });
  mountPanel();
  await chooseSource();
  fireEvent.click(screen.getByRole("button", { name: "Extract" }));
  await waitFor(() => assert.equal(useAppStore.getState().layers.length, 1));
  const layer = useAppStore.getState().layers[0];
  assert.equal(layer.type, "mbtiles");
  assert.equal(layer.metadata.nativeOfflinePackageId, vector.id);
  assert.equal(layer.sourcePath, vector.savedPath);
  assert.deepEqual(layer.source.sourceLayers, ["counties"]);
  fireEvent.click(await screen.findByRole("button", { name: "Add package to map" }));
  await screen.findByText("Using the package saved on this device.");
  assert.equal(useAppStore.getState().layers.length, 1);
  assert.equal(useAppStore.getState().layers[0].id, layer.id);
  useAppStore.getState().removeLayer(layer.id);
  fireEvent.click(await screen.findByRole("button", { name: "Add package to map" }));
  await waitFor(() => assert.equal(useAppStore.getState().layers.length, 1));
  assert.equal(useAppStore.getState().layers[0].metadata.nativeOfflinePackageId, vector.id);
  assert.notEqual(useAppStore.getState().layers[0].id, layer.id);
});

it("uses an overlay when familiar layer names declare incompatible classification fields", async () => {
  let extracted = false;
  mockIPC((command, args) => {
    if (command === "list_native_offline_packages") return { packages: [], problems: [] };
    if (command === "plugin:dialog|open") return "/data/source.mbtiles";
    if (command === "prepare_native_offline_extraction") return "extract-schema";
    if (command === "inspect_native_mbtiles_source")
      return {
        ...rasterMetadata,
        tileType: "vector",
        format: "pbf",
        sourceLayers: ["water", "roads"],
        sourceLayerFields: { water: ["category"], roads: ["category"] },
      };
    if (command === "extract_native_mbtiles_package") {
      assert.equal(Reflect.get(args ?? {}, "flavor"), null);
      extracted = true;
      return {
        package: { ...entry, tileType: "vector" },
        tileCount: 1,
        payloadBytes: 1,
        tileFormat: "pbf",
        sourceLayers: ["water", "roads"],
      };
    }
    if (command === "cancel_native_offline_extraction" || command.startsWith("plugin:event|"))
      return 1;
    throw new Error(`Unexpected command: ${command}`);
  });
  const before = useAppStore.getState().basemapStyleUrl;
  mountPanel();
  await chooseSource();
  fireEvent.click(screen.getByRole("button", { name: "Extract" }));
  await waitFor(() => assert.equal(useAppStore.getState().layers.length, 1));
  assert.equal(extracted, true);
  assert.equal(useAppStore.getState().basemapStyleUrl, before);
});

for (const canceled of [true, false]) {
  it(`fences a completed native extraction after ${canceled ? "cancel" : "project replacement"}`, async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    let started = false;
    let saved = false;
    let cancels = 0;
    mockIPC((command) => {
      if (command === "list_native_offline_packages")
        return { packages: saved ? [entry] : [], problems: [] };
      if (command === "plugin:dialog|open") return "/data/source.mbtiles";
      if (command === "prepare_native_offline_extraction") return "extract-late";
      if (command === "inspect_native_mbtiles_source") return rasterMetadata;
      if (command === "extract_native_mbtiles_package") {
        started = true;
        return pending;
      }
      if (command === "cancel_native_offline_extraction") {
        cancels++;
        return;
      }
      if (command.startsWith("plugin:event|")) return 1;
      throw new Error(`Unexpected command: ${command}`);
    });
    mountPanel();
    await chooseSource();
    fireEvent.click(screen.getByRole("button", { name: "Extract" }));
    await waitFor(() => assert.equal(started, true));
    if (canceled) fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    else useAppStore.getState().newProject({ name: "Replacement" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const before = useAppStore.getState().basemapStyleUrl;
    saved = true;
    finish({
      package: entry,
      tileCount: 42,
      payloadBytes: 100,
      tileFormat: "png",
      sourceLayers: [],
    });
    await screen.findByText(entry.name);
    assert.equal(useAppStore.getState().basemapStyleUrl, before);
    assert.equal(screen.queryByText("Saved 42 tiles in a package on this device.") === null, true);
    assert.ok(cancels >= 3);
    if (!canceled) assert.equal(useAppStore.getState().projectName, "Replacement");
  });
}

it("keeps a native extraction current across deletion's unrelated active-basemap fallback", async () => {
  const { nativeOfflineBasemapStyleUrl } =
    await import("../apps/geolibre-desktop/src/lib/native-offline-packages");
  const old: NativeOfflinePackage = {
    ...entry,
    id: "pkg-66666666666666666666666666666666",
    name: "Old package",
    savedPath: "/data/old.mbtiles",
  };
  useAppStore.getState().setBasemapStyleUrl(nativeOfflineBasemapStyleUrl(old, "light"));
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  let started = false;
  let oldPresent = true;
  let committed = false;
  let canceledExtraction = false;
  let preparation = 0;
  mockIPC((command, args) => {
    if (command === "list_native_offline_packages")
      return {
        packages: [...(oldPresent ? [old] : []), ...(committed ? [entry] : [])],
        problems: [],
      };
    if (command === "plugin:dialog|open") return "/data/source.mbtiles";
    if (command === "prepare_native_offline_extraction") return `extract-${++preparation}`;
    if (command === "inspect_native_mbtiles_source") return rasterMetadata;
    if (command === "extract_native_mbtiles_package") {
      started = true;
      return pending;
    }
    if (command === "delete_native_offline_package") {
      oldPresent = false;
      return;
    }
    if (command === "cancel_native_offline_extraction") {
      assert.ok(args && typeof args === "object");
      if (Reflect.get(args, "jobId") === "extract-2" && !committed) canceledExtraction = true;
      return;
    }
    if (command.startsWith("plugin:event|")) return 1;
    throw new Error(`Unexpected command: ${command}`);
  });
  mountPanel();
  await chooseSource();
  fireEvent.click(screen.getByRole("button", { name: "Extract" }));
  await waitFor(() => assert.equal(started, true));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => assert.equal(screen.queryByText(old.name) === null, true));
  assert.equal(canceledExtraction, false);
  committed = true;
  finish({ package: entry, tileCount: 42, payloadBytes: 100, tileFormat: "png", sourceLayers: [] });
  await waitFor(() =>
    assert.equal(
      useAppStore.getState().basemapStyleUrl,
      `geolibre://offline-basemap/${entry.id}/light`,
    ),
  );
});
