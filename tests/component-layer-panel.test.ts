import { act, fireEvent, render, screen, useAppStore, within } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { geojsonLayer } from "./helpers/layer-fixtures";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { LayerPanel } = await import("../apps/geolibre-desktop/src/components/panels/LayerPanel");

const noop = () => {};

/** Render the Layers panel with no map behind it (`mapControllerRef` is null). */
function renderLayerPanel() {
  return render(
    createElement(LayerPanel, {
      themeMode: "light",
      mapControllerRef: { current: null },
      onResizeStart: noop,
      geometryEditLayerId: null,
      onToggleGeometryEdit: noop,
      onCancelGeometryEdit: noop,
      onMaterializeDuckDBLayer: noop,
      onOpenRasterStylePanel: noop,
      onOpenRasterSubset: noop,
    }),
  );
}

/** The rendered layer rows, top to bottom, as their displayed names. */
function rowNames(): string[] {
  return screen
    .queryAllByTestId("layer-row")
    .map((row) => row.getAttribute("data-layer-name") ?? "");
}

/** The row element for the layer shown as `name`. */
function row(name: string): HTMLElement {
  const match = screen.getAllByTestId("layer-row").find((el) => el.dataset.layerName === name);
  assert.ok(match, `no layer row named ${name}`);
  return match;
}

function layer(id: string) {
  return useAppStore.getState().layers.find((entry) => entry.id === id);
}

describe("LayerPanel", () => {
  it("lists the store's layers with the topmost map layer first", () => {
    useAppStore.setState({
      layers: [
        geojsonLayer({ id: "rivers", name: "Rivers" }),
        geojsonLayer({ id: "parks", name: "Parks" }),
      ],
    });
    renderLayerPanel();

    // The store keeps draw order (last = top), the panel shows top first.
    assert.deepEqual(rowNames(), ["Parks", "Rivers"]);
  });

  it("follows the store when a layer is added after the first render", () => {
    renderLayerPanel();
    assert.deepEqual(rowNames(), []);

    // A store write from outside React (a map event, a plugin) goes through
    // `act` so React flushes the re-render before the assertion.
    act(() => {
      useAppStore.setState({ layers: [geojsonLayer({ id: "roads", name: "Roads" })] });
    });

    assert.deepEqual(rowNames(), ["Roads"]);
  });

  it("toggles a layer's visibility in the store from its eye button", () => {
    useAppStore.setState({ layers: [geojsonLayer({ id: "parks", name: "Parks" })] });
    renderLayerPanel();

    fireEvent.click(within(row("Parks")).getByRole("button", { name: "Hide layer" }));
    assert.equal(layer("parks")?.visible, false);

    // The button flips to the opposite action once the layer is hidden.
    fireEvent.click(within(row("Parks")).getByRole("button", { name: "Show layer" }));
    assert.equal(layer("parks")?.visible, true);
  });

  it("renames a layer on double-click and Enter", () => {
    useAppStore.setState({ layers: [geojsonLayer({ id: "parks", name: "Parks" })] });
    renderLayerPanel();

    fireEvent.doubleClick(within(row("Parks")).getByText("Parks"));
    const input = screen.getByRole("textbox", { name: "Rename Parks" });
    fireEvent.change(input, { target: { value: "  City parks  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    assert.equal(layer("parks")?.name, "City parks");
    assert.deepEqual(rowNames(), ["City parks"]);
    assert.equal(screen.queryAllByRole("textbox", { name: /^Rename / }).length, 0);
  });

  it("keeps the old name when a rename is cancelled with Escape", () => {
    useAppStore.setState({ layers: [geojsonLayer({ id: "parks", name: "Parks" })] });
    renderLayerPanel();

    fireEvent.doubleClick(within(row("Parks")).getByText("Parks"));
    const input = screen.getByRole("textbox", { name: "Rename Parks" });
    fireEvent.change(input, { target: { value: "Something else" } });
    fireEvent.keyDown(input, { key: "Escape" });

    assert.equal(layer("parks")?.name, "Parks");
    assert.deepEqual(rowNames(), ["Parks"]);
  });

  it("ignores a rename to a blank name", () => {
    useAppStore.setState({ layers: [geojsonLayer({ id: "parks", name: "Parks" })] });
    renderLayerPanel();

    fireEvent.doubleClick(within(row("Parks")).getByText("Parks"));
    const input = screen.getByRole("textbox", { name: "Rename Parks" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    assert.equal(layer("parks")?.name, "Parks");
  });

  it("selects a layer in the store when its row is clicked", () => {
    useAppStore.setState({
      layers: [
        geojsonLayer({ id: "rivers", name: "Rivers" }),
        geojsonLayer({ id: "parks", name: "Parks" }),
      ],
    });
    renderLayerPanel();

    fireEvent.click(row("Rivers"));

    assert.equal(useAppStore.getState().selectedLayerId, "rivers");
    assert.equal(row("Rivers").getAttribute("aria-pressed"), "true");
    assert.equal(row("Parks").getAttribute("aria-pressed"), "false");
  });

  it("moves a layer up the draw order", () => {
    useAppStore.setState({
      layers: [
        geojsonLayer({ id: "rivers", name: "Rivers" }),
        geojsonLayer({ id: "parks", name: "Parks" }),
      ],
    });
    renderLayerPanel();

    fireEvent.click(within(row("Rivers")).getByRole("button", { name: "Move up" }));

    assert.deepEqual(
      useAppStore.getState().layers.map((entry) => entry.id),
      ["parks", "rivers"],
    );
    assert.deepEqual(rowNames(), ["Rivers", "Parks"]);
  });
});
