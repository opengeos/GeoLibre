import { act, fireEvent, render, screen, stubLayout, useAppStore, within } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { createEmptyProject } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { geojsonLayer } from "./helpers/layer-fixtures";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { AttributeTable } =
  await import("../apps/geolibre-desktop/src/components/panels/AttributeTable");

const { commitPendingAttributeDrafts } =
  await import("../apps/geolibre-desktop/src/lib/attribute-draft-commit");

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
function renderTable(
  collection: FeatureCollection = cities,
  layerPatch: Parameters<typeof geojsonLayer>[0] = {},
) {
  // The rows are virtualized, and happy-dom does no layout: without a box
  // size the virtualizer thinks the viewport is 0px tall and renders nothing.
  stubLayout(1024, 600);
  useAppStore.setState({
    layers: [geojsonLayer({ id: "cities", name: "Cities", geojson: collection, ...layerPatch })],
    selectedLayerId: "cities",
  });
  useAppStore.getState().setAttributeTableOpen(true);
  return render(createElement(AttributeTable, { mapControllerRef: { current: null } }));
}

/** Open the table on a URL-backed GeoJSON layer, which the layer menu can refresh. */
function renderRefreshableTable(props: Record<string, unknown>) {
  stubLayout(1024, 600);
  useAppStore.setState({
    layers: [
      geojsonLayer({
        id: "cities",
        name: "Cities",
        geojson: cities,
        source: { type: "geojson", url: "https://example.com/cities.geojson" },
      }),
    ],
    selectedLayerId: "cities",
  });
  useAppStore.getState().setAttributeTableOpen(true);
  return render(createElement(AttributeTable, { mapControllerRef: { current: null }, ...props }));
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

  it("clips long structured values to their column and exposes the full value", () => {
    const values = [0.7364, 0.7268, 0.7149, 0.702];
    renderTable({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: 1902789,
          properties: { ndvi: values, metadata: { source: "sentinel" } },
          geometry: { type: "Point", coordinates: [0, 0] },
        },
      ],
    });

    const cells = table().querySelectorAll("tbody td");
    const ndviValue = cells[1]?.querySelector("span");
    const metadataValue = cells[2]?.querySelector("span");

    assert.ok(ndviValue?.classList.contains("truncate"));
    assert.equal(ndviValue?.getAttribute("title"), JSON.stringify(values));
    assert.ok(metadataValue?.classList.contains("truncate"));
    assert.equal(metadataValue?.getAttribute("title"), '{"source":"sentinel"}');
  });

  it("keeps a coded-value label and its stored code in the truncated tooltip", () => {
    renderTable(
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: 1,
            properties: { status: 7 },
            geometry: { type: "Point", coordinates: [0, 0] },
          },
        ],
      },
      {
        metadata: {
          sourceKind: "arcgis-feature-query",
          arcgisEditInfo: {
            fields: [
              {
                name: "status",
                type: "esriFieldTypeInteger",
                domain: {
                  type: "codedValue",
                  codedValues: [{ name: "Available for field inspection", code: 7 }],
                },
              },
            ],
          },
        },
      },
    );

    const statusValue = table().querySelector("tbody td:nth-child(2) span");
    assert.equal(statusValue?.textContent, "Available for field inspection");
    assert.ok(statusValue?.classList.contains("truncate"));
    assert.equal(statusValue?.getAttribute("title"), "Available for field inspection (7)");
  });

  it("keeps a derived column's hint in the value tooltip", () => {
    renderTable(
      {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: 1,
            properties: { density: 42.5 },
            geometry: { type: "Point", coordinates: [0, 0] },
          },
        ],
      },
      {
        virtualFields: [
          { id: "vf", name: "density", expression: '["get", "pop"]', addedField: "density" },
        ],
      },
    );

    const cell = table().querySelector("tbody td:nth-child(2)");
    const value = cell?.querySelector("span");
    const hint = cell?.getAttribute("title");
    assert.ok(hint, "the cell keeps its column hint");
    assert.equal(value?.getAttribute("title"), `42.5\n${hint}`);
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

  it("refreshes a refreshable layer through the shared handler", () => {
    const refreshed: string[] = [];
    renderRefreshableTable({
      refresh: {
        handleRefreshLayer: (layer: { id: string }) => {
          refreshed.push(layer.id);
        },
        refreshStatuses: {},
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh features" }));

    assert.deepEqual(refreshed, ["cities"]);
  });

  it("offers no Refresh for a layer with nothing to re-read", () => {
    renderTable();
    assert.equal(screen.queryByRole("button", { name: "Refresh features" }), null);

    // Nor without a handler, even when the layer has a source URL.
    renderRefreshableTable({});
    assert.equal(screen.queryByRole("button", { name: "Refresh features" }), null);
  });

  it("disables Refresh while one is running and shows the layer's refresh note", () => {
    const view = renderRefreshableTable({
      refresh: {
        handleRefreshLayer: () => {},
        refreshStatuses: { cities: { type: "refreshing", message: "Refreshing..." } },
      },
    });
    const button = screen.getByRole("button", { name: "Refresh features" });
    assert.equal((button as HTMLButtonElement).disabled, true);

    view.rerender(
      createElement(AttributeTable, {
        mapControllerRef: { current: null },
        refresh: {
          handleRefreshLayer: () => {},
          refreshStatuses: { cities: { type: "error", message: "HTTP 503" } },
        },
      }),
    );
    const settled = screen.getByRole("button", { name: "Refresh features" });
    assert.equal((settled as HTMLButtonElement).disabled, false);
    assert.ok(screen.getByText("HTTP 503"));
  });

  it("closes from its close button", () => {
    renderTable();

    fireEvent.click(screen.getByRole("button", { name: "Close attribute table" }));

    assert.equal(useAppStore.getState().ui.attributeTableOpen, false);
  });
});

describe("attribute drafts survive navigation (#3509)", () => {
  function editName(value: string) {
    fireEvent.change(screen.getByRole("textbox", { name: "Edit name for feature 1" }), {
      target: { value },
    });
  }

  function addSecondLayer() {
    act(() => useAppStore.getState().addLayer(geojsonLayer({ id: "other", geojson: cities })));
    act(() => useAppStore.getState().selectLayer("cities"));
  }

  it("retains independent drafts on two layers and saves only the current layer", () => {
    renderTable();
    addSecondLayer();
    fireEvent.click(screen.getByRole("button", { name: "Edit attribute values" }));
    editName("First draft");
    act(() => useAppStore.getState().selectLayer("other"));
    fireEvent.click(screen.getByRole("button", { name: "Edit attribute values" }));
    editName("Second draft");
    act(() => useAppStore.getState().selectLayer("cities"));
    assert.equal(
      (screen.getByRole("textbox", { name: "Edit name for feature 1" }) as HTMLInputElement).value,
      "First draft",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save attribute edits" }));
    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === "cities")?.geojson?.features[0].properties
        ?.name,
      "First draft",
    );
    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === "other")?.geojson?.features[0].properties
        ?.name,
      "Oslo",
    );
    act(() => useAppStore.getState().selectLayer("other"));
    assert.equal(
      (screen.getByRole("textbox", { name: "Edit name for feature 1" }) as HTMLInputElement).value,
      "Second draft",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel attribute edits" }));
    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === "other")?.geojson?.features[0].properties
        ?.name,
      "Oslo",
    );
  });

  it("keeps drafts across closing and remounting the table", () => {
    const view = renderTable();
    fireEvent.click(screen.getByRole("button", { name: "Edit attribute values" }));
    editName("Retained draft");
    fireEvent.click(screen.getByRole("button", { name: "Close attribute table" }));
    view.unmount();
    assert.equal(commitPendingAttributeDrafts("cities"), "blocked");
    act(() => useAppStore.getState().setAttributeTableOpen(true));
    render(createElement(AttributeTable, { mapControllerRef: { current: null } }));
    assert.equal(
      (screen.getByRole("textbox", { name: "Edit name for feature 1" }) as HTMLInputElement).value,
      "Retained draft",
    );
    act(() => assert.equal(commitPendingAttributeDrafts("cities"), "committed"));
    assert.equal(
      useAppStore.getState().layers[0].geojson?.features[0].properties?.name,
      "Retained draft",
    );
  });
});

describe("attribute draft lifecycle", () => {
  it("keeps invalid JSON drafts when switching layers and still blocks saving", () => {
    renderTable({
      ...cities,
      features: [{ ...cities.features[0], properties: { name: { value: "original" } } }],
    });
    act(() => useAppStore.getState().addLayer(geojsonLayer({ id: "other", geojson: cities })));
    act(() => useAppStore.getState().selectLayer("cities"));
    fireEvent.click(screen.getByRole("button", { name: "Edit attribute values" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit name for feature 1" }), {
      target: { value: "{" },
    });
    act(() => useAppStore.getState().selectLayer("other"));
    act(() => useAppStore.getState().selectLayer("cities"));
    assert.equal(
      (screen.getByRole("textbox", { name: "Edit name for feature 1" }) as HTMLInputElement).value,
      "{",
    );
    assert.equal(
      (screen.getByRole("button", { name: "Save attribute edits" }) as HTMLButtonElement).disabled,
      true,
    );
    assert.deepEqual(
      useAppStore.getState().layers.find((l) => l.id === "cities")?.geojson?.features[0].properties
        ?.name,
      { value: "original" },
    );
  });

  it("clears drafts on project replacement even when layer ids are reused", () => {
    renderTable();
    act(() =>
      useAppStore.getState().setAttributeTableDrafts("cities", { "1": { name: "Old project" } }),
    );
    act(() =>
      useAppStore.getState().loadProject({
        ...createEmptyProject("Replacement"),
        layers: [geojsonLayer({ id: "cities", geojson: cities })],
      }),
    );
    assert.deepEqual(useAppStore.getState().ui.attributeTableDrafts, {});
    act(() =>
      useAppStore.getState().setAttributeTableDrafts("cities", { "1": { name: "New draft" } }),
    );
    act(() => useAppStore.getState().newProject());
    assert.deepEqual(useAppStore.getState().ui.attributeTableDrafts, {});
  });

  it("clears drafts when deleting layers individually or with their group", () => {
    renderTable();
    act(() =>
      useAppStore.getState().setAttributeTableDrafts("cities", { "1": { name: "Deleted" } }),
    );
    act(() => useAppStore.getState().removeLayer("cities"));
    assert.deepEqual(useAppStore.getState().ui.attributeTableDrafts, {});
    act(() => {
      const groupId = useAppStore.getState().addLayerGroup("Group");
      useAppStore.getState().addLayer(geojsonLayer({ id: "group-child", groupId }));
      useAppStore.getState().setAttributeTableDrafts("group-child", { "1": { name: "Deleted" } });
      useAppStore.getState().removeLayerGroup(groupId, { removeChildren: true });
    });
    assert.deepEqual(useAppStore.getState().ui.attributeTableDrafts, {});
  });
});

describe("attribute draft targets after external data changes", () => {
  it("blocks a partial save when a drafted row disappears and keeps both drafts", () => {
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: "Edit attribute values" }));
    for (const featureId of [1, 2]) {
      fireEvent.change(
        screen.getByRole("textbox", { name: `Edit name for feature ${featureId}` }),
        {
          target: { value: `Draft ${featureId}` },
        },
      );
    }
    const drafts = useAppStore.getState().ui.attributeTableDrafts.cities;
    const reduced = { ...cities, features: cities.features.slice(0, 1) };
    act(() => {
      useAppStore.getState().selectLayer(null);
      useAppStore.getState().updateLayer("cities", { geojson: reduced });
    });
    act(() => useAppStore.getState().selectLayer("cities"));
    assert.equal(
      (screen.getByRole("button", { name: "Save attribute edits" }) as HTMLButtonElement).disabled,
      true,
    );
    act(() => assert.equal(commitPendingAttributeDrafts("cities"), "blocked"));
    assert.equal(useAppStore.getState().layers[0].geojson, reduced);
    assert.equal(useAppStore.getState().ui.attributeTableDrafts.cities, drafts);
    act(() => useAppStore.getState().updateLayer("cities", { geojson: cities }));
    act(() => assert.equal(commitPendingAttributeDrafts("cities"), "committed"));
    assert.deepEqual(
      useAppStore
        .getState()
        .layers[0].geojson?.features.slice(0, 2)
        .map((f) => f.properties?.name),
      ["Draft 1", "Draft 2"],
    );
  });

  it("blocks index-based drafts after a reorder, including after table remount", () => {
    const idless = {
      ...cities,
      features: cities.features.map(({ id: _id, ...feature }) => feature),
    };
    const view = renderTable(idless);
    fireEvent.click(screen.getByRole("button", { name: "Edit attribute values" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit name for feature 0" }), {
      target: { value: "Draft for Oslo" },
    });
    view.unmount();
    const reordered = { ...idless, features: [...idless.features].reverse() };
    act(() => useAppStore.getState().updateLayer("cities", { geojson: reordered }));
    render(createElement(AttributeTable, { mapControllerRef: { current: null } }));
    act(() => assert.equal(commitPendingAttributeDrafts("cities"), "blocked"));
    assert.equal(useAppStore.getState().layers[0].geojson, reordered);
    // A refresh returning equivalent feature objects at their original positions is safe.
    act(() => useAppStore.getState().updateLayer("cities", { geojson: structuredClone(idless) }));
    act(() => assert.equal(commitPendingAttributeDrafts("cities"), "committed"));
    assert.equal(
      useAppStore.getState().layers[0].geojson?.features[0].properties?.name,
      "Draft for Oslo",
    );
  });

  it("allows an ID-based draft to follow its feature through a reorder", () => {
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: "Edit attribute values" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit name for feature 1" }), {
      target: { value: "Draft for Oslo" },
    });
    act(() =>
      useAppStore.getState().updateLayer("cities", {
        geojson: { ...cities, features: [...cities.features].reverse() },
      }),
    );
    act(() => assert.equal(commitPendingAttributeDrafts("cities"), "committed"));
    assert.equal(
      useAppStore.getState().layers[0].geojson?.features.find((f) => f.id === 1)?.properties?.name,
      "Draft for Oslo",
    );
  });
});
