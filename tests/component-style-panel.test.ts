import { act, fireEvent, render, screen, useAppStore, within } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { FeatureCollection } from "geojson";
import { geojsonLayer } from "./helpers/layer-fixtures";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { StylePanel } = await import("../apps/geolibre-desktop/src/components/panels/StylePanel");

const polygons: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Block A", area: 12 },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    },
  ],
};

/**
 * Render the Style panel expanded (controlled `collapsed={false}`; standalone
 * it starts collapsed) with no map behind it.
 */
function renderStylePanel() {
  return render(
    createElement(StylePanel, {
      mapControllerRef: { current: null },
      onResizeStart: () => {},
      collapsed: false,
      onCollapsedChange: () => {},
    }),
  );
}

function selectPolygonLayer() {
  useAppStore.setState({
    layers: [
      geojsonLayer({ id: "blocks", name: "Blocks", geojson: polygons }),
      geojsonLayer({ id: "other", name: "Other" }),
    ],
    selectedLayerId: "blocks",
  });
}

/** A fresh copy of the default layer style. */
function style0() {
  return { ...geojsonLayer().style };
}

function style(id: string) {
  const layer = useAppStore.getState().layers.find((entry) => entry.id === id);
  assert.ok(layer, `no layer ${id}`);
  return layer.style;
}

function input(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

describe("StylePanel", () => {
  it("shows the selected layer's name and current style values", () => {
    selectPolygonLayer();
    renderStylePanel();

    assert.equal(screen.getByText(/^Style - /).textContent, "Style - Blocks");
    assert.equal(input("Fill color").value, style("blocks").fillColor);
    assert.equal(input("Outline color").value, style("blocks").strokeColor);
    assert.equal(Number(input("Fill opacity").value), style("blocks").fillOpacity);
    assert.equal(Number(input("Stroke width").value), style("blocks").strokeWidth);
  });

  it("writes a new fill color to the selected layer only", () => {
    selectPolygonLayer();
    const otherBefore = structuredClone(style("other"));
    renderStylePanel();

    fireEvent.change(input("Fill color"), { target: { value: "#ff0000" } });

    assert.equal(style("blocks").fillColor, "#ff0000");
    assert.equal(input("Fill color").value, "#ff0000");
    assert.deepEqual(style("other"), otherBefore);
  });

  it("writes a typed fill opacity to the store", () => {
    selectPolygonLayer();
    renderStylePanel();

    fireEvent.change(input("Fill opacity"), { target: { value: "0.25" } });

    assert.equal(style("blocks").fillOpacity, 0.25);
  });

  it("steps stroke width with the increase button", () => {
    selectPolygonLayer();
    const before = style("blocks").strokeWidth;
    renderStylePanel();

    fireEvent.click(screen.getByRole("button", { name: "Increase Stroke width" }));

    // The Stroke width input steps by 0.5.
    assert.equal(style("blocks").strokeWidth, before + 0.5);
  });

  it("marks a fill transparent from its checkbox", () => {
    selectPolygonLayer();
    renderStylePanel();

    // ColorField renders the swatch in its own wrapper next to the checkbox,
    // so the swatch's grandparent is the field holding this color's checkbox.
    const fillField = input("Fill color").parentElement?.parentElement;
    assert.ok(fillField, "fill color field not found");
    fireEvent.click(within(fillField).getByLabelText("Transparent"));

    assert.equal(style("blocks").fillColor, "transparent");
  });

  it("switches to the newly selected layer", () => {
    selectPolygonLayer();
    renderStylePanel();

    act(() => {
      useAppStore.getState().selectLayer("other");
    });

    assert.equal(screen.getByText(/^Style - /).textContent, "Style - Other");
  });

  it("offers the layer's attribute fields as popup title choices", () => {
    selectPolygonLayer();
    renderStylePanel();

    const titleField = screen.getByLabelText("Title field") as HTMLSelectElement;
    // "Layer name" (the empty value) first, then the fields sorted by name.
    assert.deepEqual(
      [...titleField.options].map((option) => option.value),
      ["", "area", "name"],
    );
  });

  it("opens the Expression Builder from a 3D tileset's symbology and applies to its draft", () => {
    // A tileset has no MapLibre paint controls, so it takes the no-paint panel;
    // the builder dialog used to be drawn only in the full vector panel, so
    // this button set a target and nothing opened.
    useAppStore.setState({
      layers: [
        geojsonLayer({
          id: "buildings",
          name: "Buildings",
          type: "3d-tiles",
          source: { type: "3d-tiles", url: "https://example.test/tileset.json" },
          geojson: undefined,
          style: { ...style0(), vectorStyleMode: "expression" },
          metadata: { fields: [{ name: "height", type: "number" }] },
        }),
      ],
      selectedLayerId: "buildings",
    });
    renderStylePanel();

    assert.equal(screen.queryAllByRole("dialog").length, 0);
    fireEvent.click(screen.getByRole("button", { name: "Open expression builder" }));

    const dialog = screen.getByRole("dialog");
    within(dialog).getByText("Expression Builder");
    const expression = '["case", [">", ["get", "height"], 50], "#ff0000", "#0000ff"]';
    fireEvent.change(within(dialog).getByLabelText("Expression"), {
      target: { value: expression },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));

    assert.equal(screen.queryAllByRole("dialog").length, 0);
    // The builder re-serializes the expression compactly on apply.
    assert.deepEqual(
      JSON.parse((screen.getByLabelText("Color expression") as HTMLTextAreaElement).value),
      JSON.parse(expression),
    );
  });
});
