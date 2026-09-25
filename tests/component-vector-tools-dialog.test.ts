import {
  act,
  fireEvent,
  mockFetch,
  render,
  screen,
  useAppStore,
  waitFor,
  within,
} from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { FeatureCollection } from "geojson";
import type { VectorToolKind } from "@geolibre/core";
import { geojsonLayer } from "./helpers/layer-fixtures";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { VectorToolsDialog } =
  await import("../apps/geolibre-desktop/src/components/processing/VectorToolsDialog");

const points: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "A" },
      geometry: { type: "Point", coordinates: [10, 60] },
    },
    {
      type: "Feature",
      properties: { name: "B" },
      geometry: { type: "Point", coordinates: [10.5, 60.2] },
    },
  ],
};

const lines: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    },
  ],
};

/**
 * Render the dialog (mounted but closed, as in the app shell). Opening it asks
 * the Python sidecar whether its vector engine is installed; the stand-in
 * sidecar answers `sidecarAvailable`.
 */
function renderDialog(sidecarAvailable = false) {
  mockFetch(async (input) => {
    assert.match(String(input), /\/vector\/status$/);
    return Response.json({ available: sidecarAvailable, message: "" });
  });
  useAppStore.setState({
    layers: [
      geojsonLayer({ id: "wells", name: "Wells", geojson: points }),
      geojsonLayer({ id: "roads", name: "Roads", geojson: lines }),
    ],
  });
  return render(createElement(VectorToolsDialog, { mapControllerRef: { current: null } }));
}

/** Open the dialog on `toolId` the way the Processing menu does. */
function openTool(toolId: VectorToolKind): HTMLElement {
  act(() => useAppStore.getState().setVectorToolOpen(toolId));
  return screen.getByRole("dialog", { name: "Vector tools" });
}

/** The Engine picker, the one select that offers the sidecar. */
function engineSelect(dialog: HTMLElement): HTMLSelectElement {
  const select = within(dialog)
    .getAllByRole("combobox")
    .find((el) => [...(el as HTMLSelectElement).options].some((o) => o.value === "sidecar"));
  assert.ok(select, "no Engine select");
  return select as HTMLSelectElement;
}

function optionLabels(select: HTMLElement): string[] {
  return [...(select as HTMLSelectElement).options].map((option) => option.textContent ?? "");
}

describe("VectorToolsDialog", () => {
  it("stays closed until a tool is requested", () => {
    renderDialog();

    assert.equal(screen.queryAllByRole("dialog").length, 0);
  });

  it("lists the vector tools and preselects the requested one", () => {
    renderDialog();
    const dialog = openTool("buffer");

    const toolButtons = within(dialog)
      .getAllByRole("button")
      .map((button) => button.textContent ?? "");
    for (const name of ["Buffer", "Centroids", "Dissolve"]) {
      assert.ok(toolButtons.includes(name), `tool list is missing ${name}`);
    }
    assert.ok(
      within(dialog).getByText(/Create a buffer polygon around each feature/),
      "the Buffer description is not shown",
    );
  });

  it("renders the selected tool's parameters with their defaults", () => {
    renderDialog();
    const dialog = openTool("buffer");

    const distance = within(dialog).getByLabelText(/^Distance/) as HTMLInputElement;
    assert.equal(distance.value, "1");
    const units = within(dialog).getByLabelText(/^Units/) as HTMLSelectElement;
    assert.equal(units.value, "kilometers");
    // Every GeoJSON layer in the project is a candidate input for Buffer.
    const input = within(dialog).getByLabelText(/^Input layer/);
    assert.ok(optionLabels(input).includes("Wells"));
    assert.ok(optionLabels(input).includes("Roads"));
  });

  it("swaps the parameter form when another tool is picked", () => {
    renderDialog();
    const dialog = openTool("buffer");

    fireEvent.click(within(dialog).getByRole("button", { name: "Centroids" }));

    assert.equal(within(dialog).queryAllByLabelText(/^Distance/).length, 0);
    assert.ok(within(dialog).getByLabelText(/^Input layer/));
  });

  it("refuses to run without a required input and says why", () => {
    renderDialog();
    const dialog = openTool("buffer");

    fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));

    assert.ok(within(dialog).getByText('Error: "Input layer" is required'));
    assert.equal(useAppStore.getState().layers.length, 2);
  });

  it("runs Buffer in the browser and adds the result as a new layer", async () => {
    renderDialog();
    const dialog = openTool("buffer");

    fireEvent.change(within(dialog).getByLabelText(/^Input layer/), {
      target: { value: "wells" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));

    await waitFor(() => assert.equal(useAppStore.getState().layers.length, 3));
    const result = useAppStore.getState().layers[2];
    assert.equal(result.name, "Buffer");
    assert.equal(result.geojson?.features.length, 2);
    assert.deepEqual(
      result.geojson?.features.map((feature) => feature.geometry.type),
      ["Polygon", "Polygon"],
    );
  });

  it("blocks the sidecar engine when the sidecar has no vector support", async () => {
    renderDialog(false);
    const dialog = openTool("buffer");

    fireEvent.change(engineSelect(dialog), { target: { value: "sidecar" } });

    await waitFor(() =>
      assert.ok(within(dialog).getByText(/The GeoPandas sidecar is not available/)),
    );
    assert.equal(
      (within(dialog).getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled,
      true,
    );
  });

  it("allows the sidecar engine once the sidecar reports vector support", async () => {
    renderDialog(true);
    const dialog = openTool("buffer");

    fireEvent.change(engineSelect(dialog), { target: { value: "sidecar" } });

    const run = within(dialog).getByRole("button", { name: "Run" }) as HTMLButtonElement;
    await waitFor(() => assert.equal(run.disabled, false));
  });

  it("closes through the store when dismissed", () => {
    renderDialog();
    openTool("buffer");

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    assert.equal(useAppStore.getState().ui.vectorToolOpen, null);
    assert.equal(screen.queryAllByRole("dialog").length, 0);
  });
});
