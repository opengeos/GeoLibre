import { cleanup, fireEvent, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { createElement } from "react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import {
  captureLayerLibraryEntry,
  createEmptyProject,
  createProjectTemplate,
} from "@geolibre/core";
import { geojsonLayer } from "./helpers/layer-fixtures";
import { clearNotifications, useNotificationStore } from "../apps/geolibre-desktop/src/lib/notify";

const { NewProjectDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/NewProjectDialog");
const { BrowserPanel } =
  await import("../apps/geolibre-desktop/src/components/panels/BrowserPanel");
const { pickLocalRasterFiles } =
  await import("../apps/geolibre-desktop/src/lib/file-io/raster-photo-files");
const { pickNativeDataFiles } =
  await import("../apps/geolibre-desktop/src/lib/file-io/native-data-copy");
const internals = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
const path =
  "/private/var/mobile/Containers/Data/Application/old/Library/Application Support/org.geolibre.app/picked-documents/3cb9b477-d563-4d3e-8503-263ec23c01c5/data/roads.tif";
const failure = "Imported-file access is unavailable. Restart to retry.";

beforeEach(() => {
  useAppStore.getState().setNativeDocumentCopyRoot(null);
  useAppStore.getState().newProject({ name: "Keep this workspace", layers: [geojsonLayer()] });
  useAppStore.getState().setNativeDocumentCopyError(failure);
  clearNotifications();
});

afterEach(() => {
  cleanup();
  clearMocks();
  if (internals) Object.defineProperty(window, "__TAURI_INTERNALS__", internals);
  else Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  useAppStore.getState().setNativeDocumentCopyRoot(null);
  useAppStore.getState().setTemplateLibrary([]);
  useAppStore.getState().setLayerLibrary([]);
  clearNotifications();
});

it("reports a held template without closing the dialog or changing the workspace", () => {
  const project = createEmptyProject("Retained template");
  project.layers = [geojsonLayer({ sourcePath: path })];
  useAppStore.getState().setTemplateLibrary([
    {
      id: "retained",
      name: "Retained template",
      project: createProjectTemplate(project, { stripDataLayers: false }),
      createdAt: "2026-11-25T00:00:00Z",
      updatedAt: "2026-11-25T00:00:00Z",
    },
  ]);
  let closed = 0;
  render(
    createElement(NewProjectDialog, {
      open: true,
      onOpenChange: () => closed++,
      onSaveCurrentProject: async () => true,
    }),
  );
  const before = useAppStore.getState();
  fireEvent.click(screen.getByRole("button", { name: "Retained template" }));
  assert.equal(closed, 0);
  assert.equal(useAppStore.getState().layers, before.layers);
  assert.equal(useAppStore.getState().projectGeneration, before.projectGeneration);
  assert.equal(useNotificationStore.getState().notifications.at(-1)?.message, failure);
});

it("reports a held library layer inline and releases the busy state", async () => {
  const captured = captureLayerLibraryEntry(
    geojsonLayer({
      name: "Retained roads",
      sourcePath: path.replace(/tif$/, "geojson"),
      metadata: { localFileReloadable: true },
      geojson: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [-83, 35] } },
        ],
      },
    }),
    {
      id: "retained",
      addedAt: "2026-11-25T00:00:00Z",
    },
  );
  assert.equal(captured.ok, true);
  if (!captured.ok) throw new Error("Expected a saved layer");
  useAppStore.getState().setLayerLibrary([captured.entry]);
  render(
    createElement(BrowserPanel, {
      mapControllerRef: { current: null },
      onOpenRecentProject: async () => null,
    }),
  );
  const before = useAppStore.getState();
  const row = await screen.findByText("Retained roads");
  fireEvent.click(row);
  await waitFor(() => assert.ok(screen.getByText(failure)));
  assert.equal(useAppStore.getState().layers, before.layers);
  assert.equal(useAppStore.getState().projectGeneration, before.projectGeneration);
  assert.equal(row.closest('[role="treeitem"]')?.getAttribute("aria-busy"), null);
});

it("reports held native raster picks before authorizing or reading their bytes", async () => {
  const commands: string[] = [];
  mockIPC((command) => {
    commands.push(command);
    if (command === "plugin:dialog|open") return [path];
    throw new Error(`Unexpected command: ${command}`);
  });
  const before = useAppStore.getState();
  await assert.rejects(pickLocalRasterFiles(), /Imported-file access is unavailable/);
  assert.deepEqual(commands, ["plugin:dialog|open"]);
  assert.equal(useAppStore.getState().layers, before.layers);
  assert.equal(useNotificationStore.getState().notifications.length, 1);
  assert.equal(useNotificationStore.getState().notifications[0].description, failure);
});

for (const selected of [null, []]) {
  it(`keeps native picker cancellation quiet during an initialization failure (${JSON.stringify(selected)})`, async () => {
    mockIPC(() => selected);
    assert.deepEqual(await pickNativeDataFiles({ multiple: true }), selected);
    assert.equal(useNotificationStore.getState().notifications.length, 0);
  });
}

it("allows native picks after access initialization succeeds", async () => {
  useAppStore
    .getState()
    .setNativeDocumentCopyRoot(
      path.slice(0, path.indexOf("/picked-documents/")) + "/picked-documents",
    );
  mockIPC(() => [path]);
  assert.deepEqual(await pickNativeDataFiles({ multiple: true }), [path]);
  assert.equal(useNotificationStore.getState().notifications.length, 0);
});
