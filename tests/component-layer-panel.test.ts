import { act, fireEvent, render, screen, useAppStore, within } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
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

/** Supply hit testing and capture, which the non-layout DOM cannot perform. */
function pointerDrag(t: TestContext, name: string) {
  const handle = within(row(name)).getByRole("button", { name: `Drag ${name} to reorder` });
  let hit: Element | null = null;
  let captured = false;
  Object.assign(handle, {
    setPointerCapture: () => {
      captured = true;
    },
    hasPointerCapture: () => captured,
    releasePointerCapture: () => {
      captured = false;
    },
  });
  t.mock.method(document, "elementFromPoint", () => hit);
  const send = (type: string, x: number, target: Element | null = hit) => {
    hit = target;
    fireEvent(
      handle,
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX: x,
        clientY: 20,
      }),
    );
  };
  return { send };
}

describe("LayerPanel", () => {
  it("turns all hover tips off and restores their saved choices from the header", () => {
    useAppStore.getState().newProject({ name: "Hover panel" });
    const id = useAppStore.getState().addGeoJsonLayer("Rivers", {
      type: "FeatureCollection",
      features: [],
    });
    useAppStore.getState().setLayerPopup(id, { hover: true });
    renderLayerPanel();

    const toggle = screen.getByRole("checkbox", { name: "Hover tooltips" });
    fireEvent.click(toggle);
    assert.equal(useAppStore.getState().hoverTooltipsEnabled, false);
    assert.equal(layer(id)?.popup?.hover, true);
    fireEvent.click(toggle);
    assert.equal(useAppStore.getState().hoverTooltipsEnabled, true);
    assert.equal(layer(id)?.popup?.hover, true);
  });

  it("hides the hover row when no layer shows hover tips", () => {
    useAppStore.getState().newProject({ name: "No hovers" });
    useAppStore.getState().addGeoJsonLayer("Rivers", { type: "FeatureCollection", features: [] });
    renderLayerPanel();
    assert.equal(screen.queryByText("Hover tooltips"), null);
  });

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

  it("reorders using captured pointer movement in both directions", (t) => {
    useAppStore.setState({
      layers: [
        geojsonLayer({ id: "rivers", name: "Rivers" }),
        geojsonLayer({ id: "parks", name: "Parks" }),
      ],
    });
    renderLayerPanel();
    const drag = pointerDrag(t, "Rivers");
    drag.send("pointerdown", 10);
    drag.send("pointermove", 30, row("Parks"));
    drag.send("pointerup", 30);
    assert.deepEqual(rowNames(), ["Rivers", "Parks"]);
    assert.deepEqual(
      useAppStore.getState().layers.map((layer) => layer.id),
      ["parks", "rivers"],
    );
    drag.send("pointerdown", 10);
    drag.send("pointermove", 30, row("Parks"));
    drag.send("pointerup", 30);
    assert.deepEqual(rowNames(), ["Parks", "Rivers"]);
  });

  it("does not reorder on a click, cancelled drag, or release outside the list", (t) => {
    useAppStore.setState({
      layers: [
        geojsonLayer({ id: "rivers", name: "Rivers" }),
        geojsonLayer({ id: "parks", name: "Parks" }),
      ],
    });
    renderLayerPanel();
    const drag = pointerDrag(t, "Rivers");
    drag.send("pointerdown", 10);
    drag.send("pointerup", 11, row("Parks"));
    assert.deepEqual(rowNames(), ["Parks", "Rivers"]);
    drag.send("pointerdown", 10);
    drag.send("pointermove", 30, row("Parks"));
    drag.send("pointercancel", 30);
    drag.send("pointerup", 30);
    assert.deepEqual(rowNames(), ["Parks", "Rivers"]);
    drag.send("pointerdown", 10);
    drag.send("pointermove", 30, row("Parks"));
    drag.send("pointerup", 30, document.body);
    assert.deepEqual(rowNames(), ["Parks", "Rivers"]);
  });

  it("moves selected layers together when dragging one of their handles", (t) => {
    useAppStore.setState({
      layers: [
        geojsonLayer({ id: "rivers", name: "Rivers" }),
        geojsonLayer({ id: "parks", name: "Parks" }),
        geojsonLayer({ id: "roads", name: "Roads" }),
      ],
    });
    renderLayerPanel();
    fireEvent.click(row("Rivers"));
    fireEvent.click(row("Parks"), { ctrlKey: true });
    const drag = pointerDrag(t, "Rivers");
    drag.send("pointerdown", 10);
    drag.send("pointermove", 30, row("Roads"));
    drag.send("pointerup", 30);
    assert.deepEqual(rowNames(), ["Parks", "Rivers", "Roads"]);
  });

  it("drops into a collapsed group and back out onto an ungrouped row", (t) => {
    useAppStore.setState({
      layers: [
        geojsonLayer({ id: "rivers", name: "Rivers" }),
        geojsonLayer({ id: "parks", name: "Parks" }),
      ],
      layerGroups: [{ id: "group", name: "Folder", collapsed: true, visible: true, opacity: 1 }],
    });
    renderLayerPanel();
    const drag = pointerDrag(t, "Rivers");
    drag.send("pointerdown", 10);
    drag.send("pointermove", 30, screen.getByTestId("layer-group-header"));
    drag.send("pointerup", 30);
    assert.equal(layer("rivers")?.groupId, "group");
    assert.deepEqual(rowNames(), ["Parks"]);
    act(() => useAppStore.getState().toggleLayerGroupCollapsed("group"));
    const outward = pointerDrag(t, "Rivers");
    outward.send("pointerdown", 10);
    outward.send("pointermove", 30, row("Parks"));
    outward.send("pointerup", 30);
    assert.equal(layer("rivers")?.groupId ?? null, null);
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

  it("keeps the metadata dialog in step with the live layer", () => {
    useAppStore.setState({
      layers: [geojsonLayer({ id: "parks", name: "Parks", metadata: { featureCount: 3 } })],
    });
    renderLayerPanel();

    fireEvent.click(within(row("Parks")).getByRole("button", { name: "Metadata" }));
    let dialog = screen.getByRole("dialog");
    within(dialog).getByText("Parks Metadata");

    // A rename and a metadata change made while the dialog is open (the row's
    // rename, a refresh) show up in it rather than the snapshot taken on open.
    act(() => {
      useAppStore.getState().updateLayer("parks", {
        name: "City parks",
        metadata: { featureCount: 5 },
      });
    });
    dialog = screen.getByRole("dialog");
    within(dialog).getByText("City parks Metadata");
    const json = JSON.parse(dialog.querySelector("pre")?.textContent ?? "{}");
    assert.equal(json.layerName, "City parks");
    assert.equal(json.featureCount, 5);

    // Removing the layer closes the dialog instead of leaving it on a ghost.
    act(() => {
      useAppStore.getState().removeLayer("parks");
    });
    assert.equal(screen.queryAllByRole("dialog").length, 0);

    // The id was dropped too: a new layer that reuses it does not reopen it.
    act(() => {
      useAppStore.setState({ layers: [geojsonLayer({ id: "parks", name: "Parks again" })] });
    });
    assert.equal(screen.queryAllByRole("dialog").length, 0);
  });
});
