import { fireEvent, render, screen, stubLayout, useAppStore, within } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { FeatureCollection } from "geojson";
import { geojsonLayer } from "./helpers/layer-fixtures";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { AttributeTable } =
  await import("../apps/geolibre-desktop/src/components/panels/AttributeTable");

const cities: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: 1,
      properties: { name: "Oslo", population: 709000 },
      geometry: { type: "Point", coordinates: [10.75, 59.91] },
    },
    {
      type: "Feature",
      id: 2,
      properties: { name: "Bergen", population: 286000 },
      geometry: { type: "Point", coordinates: [5.32, 60.39] },
    },
    {
      type: "Feature",
      id: 3,
      properties: { name: "Trondheim", population: 212000 },
      geometry: { type: "Point", coordinates: [10.4, 63.43] },
    },
  ],
};

/** Open the table on a GeoJSON layer and render it with no map behind it. */
function renderTable() {
  // The rows are virtualized, and happy-dom does no layout: without a box
  // size the virtualizer thinks the viewport is 0px tall and renders nothing.
  stubLayout(1024, 600);
  useAppStore.setState({
    layers: [geojsonLayer({ id: "cities", name: "Cities", geojson: cities })],
    selectedLayerId: "cities",
  });
  useAppStore.getState().setAttributeTableOpen(true);
  return render(createElement(AttributeTable, { mapControllerRef: { current: null } }));
}

function table(): HTMLElement {
  return screen.getByTestId("attribute-table");
}

/** Column header labels, left to right, including the row-number column. */
function headers(): string[] {
  return within(table())
    .getAllByRole("columnheader")
    .map((cell) => cell.querySelector("button span")?.textContent ?? "");
}

/** The body rows as arrays of cell text. */
function rows(): string[][] {
  return [...table().querySelectorAll("tbody tr")]
    .filter((row) => row.querySelectorAll("td").length > 1)
    .map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim() ?? ""));
}

function status(): string {
  return screen.getByTestId("attribute-table-status").textContent ?? "";
}

describe("AttributeTable", () => {
  it("renders a column per attribute and a row per feature", () => {
    renderTable();

    assert.deepEqual(headers(), ["#", "name", "population"]);
    const names = rows().map((cells) => cells[1]);
    assert.deepEqual(names, ["Oslo", "Bergen", "Trondheim"]);
    assert.match(status(), /3 features/);
  });

  it("titles the table with the selected layer", () => {
    renderTable();

    assert.match(
      screen.getByRole("region", { name: "Attribute table" }).textContent ?? "",
      /Cities/,
    );
  });

  it("filters rows with the search box", () => {
    renderTable();

    fireEvent.change(screen.getByRole("textbox", { name: "Search attributes" }), {
      target: { value: "berg" },
    });

    assert.deepEqual(
      rows().map((cells) => cells[1]),
      ["Bergen"],
    );
  });

  it("sorts by a column when its header is clicked", () => {
    renderTable();

    fireEvent.click(within(table()).getByRole("button", { name: "name" }));

    assert.deepEqual(
      rows().map((cells) => cells[1]),
      ["Bergen", "Oslo", "Trondheim"],
    );
  });

  it("selects a feature in the store when its row is clicked", () => {
    renderTable();

    const bergen = [...table().querySelectorAll("tbody tr")].find((row) =>
      row.textContent?.includes("Bergen"),
    );
    assert.ok(bergen, "no Bergen row");
    fireEvent.click(bergen);

    assert.equal(useAppStore.getState().selectedFeatureId, "2");
    assert.match(status(), /1 selected/);
  });

  it("closes from its close button", () => {
    renderTable();

    fireEvent.click(screen.getByRole("button", { name: "Close attribute table" }));

    assert.equal(useAppStore.getState().ui.attributeTableOpen, false);
  });
});
