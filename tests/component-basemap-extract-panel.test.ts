import { render, screen, fireEvent, waitFor, useAppStore } from "./helpers/dom";
import { createElement } from "react";
import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import type { NativeOfflinePackage } from "../apps/geolibre-desktop/src/lib/native-offline-packages";

const { BasemapExtractPanel } =
  await import("../apps/geolibre-desktop/src/components/layout/BasemapExtractPanel");
const { nativeOfflineBasemapStyleUrl } =
  await import("../apps/geolibre-desktop/src/lib/native-offline-packages");
const { getOfflineBasemapStyle } = await import("../packages/map/src/protomaps-basemap");
const { hasPMTilesArchive } = await import("../packages/map/src/pmtiles-archive");
const { nativeLocalPmtilesProtocolUrl } =
  await import("../apps/geolibre-desktop/src/lib/local-media-url");

/** Minimal PMTiles v3 metadata archive; this flow reads no tile payload. */
function vectorArchive(): Uint8Array {
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      vector_layers: [{ id: "earth" }, { id: "water" }],
    }),
  );
  const bytes = new Uint8Array(128 + metadata.length);
  bytes.set(new TextEncoder().encode("PMTiles"));
  bytes[7] = 3;
  const header = new DataView(bytes.buffer);
  header.setBigUint64(8, 127n, true);
  header.setBigUint64(16, 1n, true); // one-byte empty root directory
  header.setBigUint64(24, 128n, true);
  header.setBigUint64(32, BigInt(metadata.length), true);
  bytes[97] = 1; // uncompressed metadata
  bytes[98] = 1;
  bytes[99] = 1; // MVT
  bytes[101] = 8;
  header.setInt32(102, -1230000000, true);
  header.setInt32(106, 370000000, true);
  header.setInt32(110, -1220000000, true);
  header.setInt32(114, 380000000, true);
  bytes.set(metadata, 128);
  return bytes;
}

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

it("refreshes the inventory after a deletion reports a post-rename failure", async () => {
  const entry: NativeOfflinePackage = {
    id: "pkg-ffffffffffffffffffffffffffffffff",
    name: "Pending deletion",
    bbox: [-123, 37, -122, 38],
    minZoom: 0,
    maxZoom: 8,
    flavor: "light",
    tileType: "vector",
    bytes: 200,
    savedPath: "/data/pending.pmtiles",
    createdAt: 1,
    managed: true,
    archiveFormat: "pmtiles",
    sha256: "a".repeat(64),
  };
  let removed = false;
  mockIPC((command) => {
    if (command === "list_native_offline_packages")
      return { packages: removed ? [] : [entry], problems: [] };
    if (command === "delete_native_offline_package") {
      removed = true;
      throw new Error("Deletion durability could not be confirmed");
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
  const defaultBasemap = useAppStore.getState().basemapStyleUrl;
  const styleUrl = nativeOfflineBasemapStyleUrl(entry, "light");
  useAppStore.getState().setBasemapStyleUrl(styleUrl);
  render(
    createElement(BasemapExtractPanel, {
      open: true,
      onClose: () => {},
      mapControllerRef: { current: null },
      mapReadyGeneration: 0,
    }),
  );
  await screen.findByText("Pending deletion");
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => assert.equal(screen.queryByText("Pending deletion") === null, true));
  assert.ok(screen.getByText("Deletion durability could not be confirmed"));
  assert.equal(useAppStore.getState().basemapStyleUrl, defaultBasemap);
  assert.equal(getOfflineBasemapStyle(styleUrl), null);
  assert.equal(hasPMTilesArchive(nativeLocalPmtilesProtocolUrl(entry.savedPath)), false);
});

it("applies a successfully saved native basemap when the catalog refresh fails", async () => {
  const bytes = vectorArchive();
  const id = "pkg-cccccccccccccccccccccccccccccccc";
  let saved = false;
  let catalogFailures = 0;
  mockIPC((command) => {
    if (command === "list_native_offline_packages") {
      if (saved) {
        catalogFailures++;
        throw new Error("Catalog refresh unavailable");
      }
      return { packages: [], problems: [] };
    }
    if (command === "plugin:dialog|open") return "/data/picked.pmtiles";
    if (command === "plugin:fs|read_file") return bytes.buffer;
    if (command === "save_native_offline_package") {
      saved = true;
      return {
        id,
        name: "picked",
        bbox: [-123, 37, -122, 38],
        minZoom: 0,
        maxZoom: 8,
        flavor: "light",
        tileType: "vector",
        bytes: bytes.length,
        savedPath: `/data/offline-packages/${id}/archive.pmtiles`,
        createdAt: 1,
        managed: true,
        archiveFormat: "pmtiles",
        sha256: "a".repeat(64),
      };
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
  render(
    createElement(BasemapExtractPanel, {
      open: true,
      onClose: () => {},
      mapControllerRef: { current: null },
      mapReadyGeneration: 0,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open file…" }));
  await waitFor(
    () =>
      assert.equal(
        useAppStore.getState().basemapStyleUrl,
        `geolibre://offline-basemap/${id}/light`,
      ),
    { timeout: 5000, onTimeout: (error) => error },
  ).catch((error: unknown) => {
    throw new Error(`${String(error)}\nPanel: ${document.body.textContent}`);
  });
  assert.equal(saved, true);
  assert.equal(catalogFailures, 1);
  assert.ok(await screen.findByText("Catalog refresh unavailable"));
  await waitFor(
    () => assert.match(document.body.textContent ?? "", /Using the package saved on this device/),
    { onTimeout: (error) => new Error(`${error.message}\nPanel: ${document.body.textContent}`) },
  );
});

it("clears a superseded verification indicator when Open is canceled", async () => {
  const entry = {
    id: "pkg-dddddddddddddddddddddddddddddddd",
    name: "Saved map",
    bbox: [-123, 37, -122, 38],
    minZoom: 0,
    maxZoom: 8,
    flavor: "light",
    tileType: "vector",
    bytes: 200,
    savedPath: "/data/saved.pmtiles",
    createdAt: 1,
    managed: true,
    archiveFormat: "pmtiles",
    sha256: "a".repeat(64),
  };
  let completeVerification!: (value: typeof entry) => void;
  const verification = new Promise<typeof entry>((resolve) => {
    completeVerification = resolve;
  });
  mockIPC((command) => {
    if (command === "list_native_offline_packages") return { packages: [entry], problems: [] };
    if (command === "verify_native_offline_package") return verification;
    if (command === "plugin:dialog|open") return null;
    throw new Error(`Unexpected native command: ${command}`);
  });
  render(
    createElement(BasemapExtractPanel, {
      open: true,
      onClose: () => {},
      mapControllerRef: { current: null },
      mapReadyGeneration: 0,
    }),
  );
  const apply = await screen.findByRole("button", { name: "Use as basemap" });
  fireEvent.click(apply);
  await waitFor(() => assert.equal(apply.hasAttribute("disabled"), true));
  fireEvent.click(screen.getByRole("button", { name: "Open file…" }));
  await waitFor(() => assert.equal(apply.hasAttribute("disabled"), false));
  completeVerification(entry);
  await verification;
  assert.notEqual(
    useAppStore.getState().basemapStyleUrl,
    `geolibre://offline-basemap/${entry.id}/light`,
  );
});
