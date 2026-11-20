import { render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { fireEvent, waitFor } from "@testing-library/react";
import type { GeoLibreLayer } from "@geolibre/core";
import type { WritableLayerCandidate } from "../apps/geolibre-desktop/src/lib/batch-layer-save";

const { SaveLayerEditsDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/toolbar/SaveLayerEditsDialog");
const { EmbedVectorDataDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/toolbar/EmbedVectorDataDialog");

function makeLayer(id: string, name: string): GeoLibreLayer {
  return {
    id,
    name,
    type: "geojson",
    visible: true,
    opacity: 1,
    source: {},
    style: {},
    sourcePath: `/maps/${id}.geojson`,
    geojson: {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: {} },
      ],
    },
    metadata: {},
  } as GeoLibreLayer;
}

function makeCandidate(
  id: string,
  name: string,
  overrides: Partial<WritableLayerCandidate> = {},
): WritableLayerCandidate {
  return {
    layer: makeLayer(id, name),
    kind: "geojson",
    destinationLabel: `/maps/${id}.geojson`,
    hasPendingEdits: false,
    ...overrides,
  };
}

describe("SaveLayerEditsDialog", () => {
  it("pre-selects edited layers, supports Select all, and invokes onSaveSelected", async () => {
    const edited = makeCandidate("roads", "Roads", { hasPendingEdits: true });
    const clean = makeCandidate("rivers", "Rivers", { hasPendingEdits: false });
    const blocked = makeCandidate("borders", "Borders", {
      disabledReason: "geometryEditActive",
    });

    useAppStore.setState({ layers: [edited.layer, clean.layer, blocked.layer] });

    const savedIds: string[][] = [];
    const openChanges: boolean[] = [];

    render(
      createElement(SaveLayerEditsDialog, {
        open: true,
        onOpenChange: (open) => openChanges.push(open),
        candidatesOverride: [edited, clean, blocked],
        onSaveSelected: async (ids, callbacks) => {
          savedIds.push(ids);
          for (const id of ids) {
            callbacks.onLayerStart(id);
            callbacks.onLayerDone({
              layerId: id,
              layerName: id,
              status: "success",
              message: "Saved",
            });
          }
          return { hasIssues: false, aborted: false };
        },
        onExportGeojsonZip: async () => true,
      }),
    );

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    // 0: Select all, 1: Roads (edited), 2: Rivers (clean), 3: Borders (disabled)
    assert.equal(checkboxes.length, 4);
    assert.equal(checkboxes[1].checked, true);
    assert.equal(checkboxes[2].checked, false);
    assert.equal(checkboxes[3].disabled, true);
    assert.ok(screen.getByText("Edited"));

    // Toggle Select all to select both enabled layers.
    fireEvent.click(checkboxes[0]);
    assert.equal(checkboxes[1].checked, true);
    assert.equal(checkboxes[2].checked, true);

    // Click "Select edited (1)" to narrow back to edited layers.
    fireEvent.click(screen.getByRole("button", { name: "Select edited (1)" }));
    assert.equal(checkboxes[1].checked, true);
    assert.equal(checkboxes[2].checked, false);

    // Click Save 1 layer -> calls onSaveSelected and closes dialog on clean success.
    fireEvent.click(screen.getByRole("button", { name: "Save 1 layer" }));
    await waitFor(() => {
      assert.deepEqual(savedIds, [["roads"]]);
      assert.deepEqual(openChanges, [false]);
    });
  });

  it("keeps the dialog open and shows per-layer errors when a save fails", async () => {
    const edited = makeCandidate("roads", "Roads", { hasPendingEdits: true });
    useAppStore.setState({ layers: [edited.layer] });
    const openChanges: boolean[] = [];

    render(
      createElement(SaveLayerEditsDialog, {
        open: true,
        onOpenChange: (open) => openChanges.push(open),
        candidatesOverride: [edited],
        onSaveSelected: async (ids, callbacks) => {
          callbacks.onLayerDone({
            layerId: ids[0],
            layerName: "Roads",
            status: "error",
            message: "Permission denied",
          });
          return { hasIssues: true, aborted: false };
        },
        onExportGeojsonZip: async () => true,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save 1 layer" }));
    await waitFor(() => {
      assert.ok(screen.getByText("Permission denied"));
    });
    assert.deepEqual(openChanges, []);
    assert.equal(screen.queryByRole("button", { name: "Cancel" }), null);
    assert.equal(screen.getAllByRole("button", { name: "Close" }).length, 2);
  });

  it("offers GeoJSON ZIP export in the empty state when exportable layers exist", () => {
    useAppStore.setState({ layers: [makeLayer("a", "Cities")] });
    let zipTriggered = false;

    render(
      createElement(SaveLayerEditsDialog, {
        open: true,
        onOpenChange: () => {},
        candidatesOverride: [],
        onSaveSelected: async () => ({ hasIssues: false, aborted: false }),
        onExportGeojsonZip: async () => {
          zipTriggered = true;
          return true;
        },
      }),
    );

    const zipBtn = screen.getByRole("button", { name: "Export layers as GeoJSON ZIP…" });
    fireEvent.click(zipBtn);
    assert.equal(zipTriggered, true);
  });

  it("hides ZIP export when export:data is withheld", () => {
    useAppStore.setState({ layers: [makeLayer("a", "Cities")] });
    useAppStore.getState().setDeploymentCapabilities(["project:edit"]);

    render(
      createElement(SaveLayerEditsDialog, {
        open: true,
        onOpenChange: () => {},
        candidatesOverride: [],
        onSaveSelected: async () => ({ hasIssues: false, aborted: false }),
        onExportGeojsonZip: async () => true,
      }),
    );

    assert.equal(screen.queryByRole("button", { name: "Export layers as GeoJSON ZIP…" }), null);
  });
});

describe("EmbedVectorDataDialog", () => {
  it("renders Save edits to sources and Save external copies on desktop when allowed", () => {
    const choices: string[] = [];
    render(
      createElement(EmbedVectorDataDialog, {
        prompt: {
          hasGeometryEdits: true,
          count: 2,
          writableEditedCount: 2,
          exportableEditedCount: 2,
          editedExportableLayerIds: ["a", "b"],
          bytes: 2048,
          desktop: true,
          allowFileReferences: true,
          allowExportData: true,
          projectGeneration: 1,
          resolve: () => {},
        },
        exportingEditedCopiesZip: false,
        onResolve: (choice) => choices.push(choice),
        onExportEditedCopiesZip: async () => true,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save edits to sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Save external copies…" }));
    assert.deepEqual(choices, ["overwrite-sources", "save-copies"]);
  });

  it("disables Export copies (ZIP) while exporting and hides it when export:data is withheld", () => {
    const { rerender } = render(
      createElement(EmbedVectorDataDialog, {
        prompt: {
          hasGeometryEdits: true,
          count: 1,
          writableEditedCount: 0,
          exportableEditedCount: 1,
          editedExportableLayerIds: ["a"],
          bytes: 512,
          desktop: false,
          allowFileReferences: false,
          allowExportData: true,
          projectGeneration: 1,
          resolve: () => {},
        },
        exportingEditedCopiesZip: true,
        onResolve: () => {},
        onExportEditedCopiesZip: async () => true,
      }),
    );
    const btn = screen.getByRole("button", { name: "Export copies (ZIP)…" }) as HTMLButtonElement;
    assert.equal(btn.disabled, true);

    rerender(
      createElement(EmbedVectorDataDialog, {
        prompt: {
          hasGeometryEdits: true,
          count: 1,
          writableEditedCount: 0,
          exportableEditedCount: 1,
          editedExportableLayerIds: ["a"],
          bytes: 512,
          desktop: false,
          allowFileReferences: false,
          allowExportData: false,
          projectGeneration: 1,
          resolve: () => {},
        },
        exportingEditedCopiesZip: false,
        onResolve: () => {},
        onExportEditedCopiesZip: async () => true,
      }),
    );
    assert.equal(screen.queryByRole("button", { name: "Export copies (ZIP)…" }), null);
  });
});
