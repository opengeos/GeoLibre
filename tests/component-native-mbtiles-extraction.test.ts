import { render, screen, fireEvent, waitFor, act, useAppStore } from "./helpers/dom";
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

async function chooseSource(maximum = 19) {
  fireEvent.change(screen.getByRole("combobox", { name: "Source" }), {
    target: { value: "mbtiles" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Choose MBTiles file…" }));
  await waitFor(() =>
    assert.equal((screen.getByLabelText("Max zoom") as HTMLInputElement).value, String(maximum)),
  );
  fireEvent.change(screen.getByLabelText("East"), { target: { value: "-122.258" } });
}

it("clears a previous source after a failed replacement but preserves it after a canceled picker", async () => {
  let picks = 0;
  let extracts = 0;
  mockIPC((command, args) => {
    if (command === "list_native_offline_packages") return { packages: [], problems: [] };
    if (command === "plugin:dialog|open")
      return ++picks === 1 ? "/data/first.mbtiles" : picks === 2 ? null : "/data/invalid.mbtiles";
    if (command === "prepare_native_offline_extraction") return `inspect-${picks}`;
    if (command === "inspect_native_mbtiles_source") {
      if (Reflect.get(args ?? {}, "path") === "/data/invalid.mbtiles")
        throw new Error("Invalid replacement archive");
      return rasterMetadata;
    }
    if (command === "extract_native_mbtiles_package") {
      extracts++;
      return undefined;
    }
    if (command === "cancel_native_offline_extraction" || command.startsWith("plugin:event|"))
      return 1;
    throw new Error(`Unexpected command: ${command}`);
  });
  mountPanel();
  await chooseSource();
  assert.equal(
    (screen.getByRole("button", { name: "Extract" }) as HTMLButtonElement).disabled,
    false,
  );
  fireEvent.click(screen.getByRole("button", { name: "Choose MBTiles file…" }));
  await waitFor(() => assert.equal(picks, 2));
  await waitFor(() =>
    assert.equal(
      (screen.getByRole("button", { name: "Extract" }) as HTMLButtonElement).disabled,
      false,
    ),
  );
  assert.ok(screen.getByText("Berkeley", { exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Choose MBTiles file…" }));
  await screen.findByText("Invalid replacement archive");
  assert.equal(screen.queryByText("Berkeley", { exact: true }) === null, true);
  const extract = screen.getByRole("button", { name: "Extract" }) as HTMLButtonElement;
  assert.equal(extract.disabled, true);
  fireEvent.click(extract);
  assert.equal(extracts, 0);
});

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
    const error = await screen.findByText(new RegExp(`This package needs zoom ${minimum}`));
    if (minimum > 24) {
      assert.match(error.textContent ?? "", /supported maximum of 24/);
      assert.equal(error.textContent?.includes("Increase"), false);
    }
    assert.equal(useAppStore.getState().basemapStyleUrl, before);
    assert.equal(useAppStore.getState().layers.length, 0);
    assert.equal(screen.queryByText("Using the package saved on this device.") === null, true);
  });
}

for (const actualMinimumHigher of [false, true]) {
  it(`${actualMinimumHigher ? "identifies the committed package when copied tiles start above the project limit" : "rejects an unsupported requested zoom before starting extraction"}`, async () => {
    const preferences = useAppStore.getState().preferences;
    useAppStore.setState({
      preferences: { ...preferences, map: { ...preferences.map, maxZoom: 18 } },
    });
    let saved = false;
    let extractions = 0;
    mockIPC((command) => {
      if (command === "list_native_offline_packages")
        return { packages: saved ? [entry] : [], problems: [] };
      if (command === "plugin:dialog|open") return "/data/source.mbtiles";
      if (command === "prepare_native_offline_extraction") return "extract-zoom";
      if (command === "inspect_native_mbtiles_source") return rasterMetadata;
      if (command === "extract_native_mbtiles_package") {
        extractions++;
        saved = true;
        return {
          package: entry,
          tileCount: 42,
          payloadBytes: 100,
          tileFormat: "png",
          sourceLayers: [],
        };
      }
      if (command === "cancel_native_offline_extraction" || command.startsWith("plugin:event|"))
        return 1;
      throw new Error(`Unexpected command: ${command}`);
    });
    const before = useAppStore.getState().basemapStyleUrl;
    mountPanel();
    await chooseSource();
    if (actualMinimumHigher)
      fireEvent.change(screen.getByLabelText("Min zoom"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Extract" }));
    await screen.findByText(
      actualMinimumHigher
        ? /Saved "Berkeley subset" on this device, but it needs zoom 19/
        : /This package needs zoom 19/,
    );
    assert.equal(extractions, actualMinimumHigher ? 1 : 0);
    assert.equal(saved, actualMinimumHigher);
    assert.equal(useAppStore.getState().basemapStyleUrl, before);
    assert.equal(useAppStore.getState().layers.length, 0);
    if (actualMinimumHigher)
      assert.ok(await screen.findByRole("button", { name: "Use as basemap" }));
  });
}

it("gives lower-zoom guidance when the committed package exceeds the renderer's hard limit", async () => {
  const unsupported = { ...entry, minZoom: 25, maxZoom: 25 };
  let saved = false;
  mockIPC((command) => {
    if (command === "list_native_offline_packages")
      return { packages: saved ? [unsupported] : [], problems: [] };
    if (command === "plugin:dialog|open") return "/data/detail-only.mbtiles";
    if (command === "prepare_native_offline_extraction") return "extract-above-renderer";
    if (command === "inspect_native_mbtiles_source")
      return { ...rasterMetadata, minZoom: 0, maxZoom: 25 };
    if (command === "extract_native_mbtiles_package") {
      saved = true;
      return {
        package: unsupported,
        tileCount: 1,
        payloadBytes: 100,
        tileFormat: "png",
        sourceLayers: [],
      };
    }
    if (command === "cancel_native_offline_extraction" || command.startsWith("plugin:event|"))
      return 1;
    throw new Error(`Unexpected command: ${command}`);
  });
  const before = useAppStore.getState().basemapStyleUrl;
  mountPanel();
  await chooseSource(25);
  fireEvent.click(screen.getByRole("button", { name: "Extract" }));
  const error = await screen.findByText(
    /Saved "Berkeley subset" on this device, but this map cannot display tiles starting at zoom 25/,
  );
  assert.match(error.textContent ?? "", /Choose an archive with tiles at zoom 24 or below/);
  assert.equal(error.textContent?.includes("Increase"), false);
  assert.equal(saved, true);
  assert.equal(useAppStore.getState().basemapStyleUrl, before);
});

it("an unsupported extract supersedes an older pending saved-package apply", async () => {
  const preferences = useAppStore.getState().preferences;
  useAppStore.setState({
    preferences: { ...preferences, map: { ...preferences.map, maxZoom: 18 } },
  });
  const saved = { ...entry, id: "pkg-88888888888888888888888888888888", minZoom: 0 };
  let finishVerify!: (value: NativeOfflinePackage) => void;
  let verifying = false;
  const pending = new Promise<NativeOfflinePackage>((resolve) => {
    finishVerify = resolve;
  });
  mockIPC((command) => {
    if (command === "list_native_offline_packages") return { packages: [saved], problems: [] };
    if (command === "plugin:dialog|open") return "/data/source.mbtiles";
    if (command === "prepare_native_offline_extraction") return "extract-rejected";
    if (command === "inspect_native_mbtiles_source") return rasterMetadata;
    if (command === "verify_native_offline_package") {
      verifying = true;
      return pending;
    }
    if (command === "cancel_native_offline_extraction" || command.startsWith("plugin:event|"))
      return 1;
    throw new Error(`Unexpected command: ${command}`);
  });
  mountPanel();
  await chooseSource();
  const before = useAppStore.getState().basemapStyleUrl;
  fireEvent.click(screen.getByRole("button", { name: "Use as basemap" }));
  await waitFor(() => assert.equal(verifying, true));
  fireEvent.click(screen.getByRole("button", { name: "Extract" }));
  await screen.findByText(/This package needs zoom 19/);
  await act(async () => {
    finishVerify(saved);
    await pending;
  });
  assert.equal(useAppStore.getState().basemapStyleUrl, before);
  assert.equal(screen.queryByText("Using the package saved on this device.") === null, true);
  assert.ok(screen.getByText(/This package needs zoom 19/));
});

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
