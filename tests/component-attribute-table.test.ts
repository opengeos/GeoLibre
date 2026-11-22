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

/** The toolbar's overflow menu, opened the way Radix listens for it (a primary-button press). */
function openMoreMenu(): HTMLElement {
  const trigger = screen.getByRole("button", { name: "More table actions" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  return screen.getByRole("menu");
}

/** The visible text of each entry in an open menu, top to bottom. */
function menuEntries(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')].map(
    (item) => item.textContent?.trim() ?? "",
  );
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

    fireEvent.click(within(openMoreMenu()).getByRole("menuitem", { name: "Refresh features" }));

    assert.deepEqual(refreshed, ["cities"]);
  });

  it("offers no Refresh for a layer with nothing to re-read", () => {
    const view = renderTable();
    assert.equal(
      within(openMoreMenu()).queryByRole("menuitem", { name: "Refresh features" }),
      null,
    );
    view.unmount();

    // Nor without a handler, even when the layer has a source URL.
    renderRefreshableTable({});
    assert.equal(
      within(openMoreMenu()).queryByRole("menuitem", { name: "Refresh features" }),
      null,
    );
  });

  it("disables Refresh while one is running and shows the layer's refresh note", () => {
    const view = renderRefreshableTable({
      refresh: {
        handleRefreshLayer: () => {},
        refreshStatuses: { cities: { type: "refreshing", message: "Refreshing..." } },
      },
    });
    const item = within(openMoreMenu()).getByRole("menuitem", { name: "Refresh features" });
    assert.equal(item.getAttribute("aria-disabled"), "true");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    view.rerender(
      createElement(AttributeTable, {
        mapControllerRef: { current: null },
        refresh: {
          handleRefreshLayer: () => {},
          refreshStatuses: { cities: { type: "error", message: "HTTP 503" } },
        },
      }),
    );
    const settled = within(openMoreMenu()).getByRole("menuitem", { name: "Refresh features" });
    assert.equal(settled.getAttribute("aria-disabled"), null);
    assert.ok(screen.getByText("HTTP 503"));
  });

  it("keeps the table's own controls in the toolbar and the rest in one overflow menu", () => {
    renderTable();
    const panel = screen.getByRole("region", { name: "Attribute table" });

    for (const name of [
      "Edit attribute values",
      "Save attribute edits",
      "Clear selection",
      "More table actions",
      "Collapse attribute table",
      "Close attribute table",
    ]) {
      assert.ok(within(panel).getByRole("button", { name }), `missing ${name}`);
    }
    assert.ok(within(panel).getByRole("combobox", { name: "Feature view" }));
    assert.ok(within(panel).getByRole("textbox", { name: "Search attributes" }));
    // The moved actions are no longer toolbar buttons.
    for (const name of [
      "Add field",
      "Calculate field values from an expression",
      "Manage fields",
      "Explore all fields at a glance",
      "Field statistics",
      "Charts",
      "Dashboard",
      "Export selected layer",
    ]) {
      assert.equal(within(panel).queryByRole("button", { name }), null, `${name} still a button`);
    }
    assert.equal(within(panel).queryByRole("checkbox", { name: "Zoom to selection" }), null);

    assert.deepEqual(menuEntries(openMoreMenu()), [
      "Add field",
      "Field calculator",
      "Manage fields",
      "Column explorer",
      "Field statistics",
      "Charts",
      "Dashboard",
      "Export",
      "Zoom to selection",
    ]);
  });

  it("toggles Zoom to selection from the overflow menu", () => {
    renderTable();
    useAppStore.getState().setZoomToSelectedFeature(false);

    const toggle = within(openMoreMenu()).getByRole("menuitemcheckbox", {
      name: "Zoom to selection",
    });
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    fireEvent.click(toggle);
    assert.equal(useAppStore.getState().ui.zoomToSelectedFeature, true);

    const reopened = within(openMoreMenu()).getByRole("menuitemcheckbox", {
      name: "Zoom to selection",
    });
    assert.equal(reopened.getAttribute("aria-checked"), "true");
    fireEvent.click(reopened);
    assert.equal(useAppStore.getState().ui.zoomToSelectedFeature, false);
  });

  it("opens the field and analysis dialogs from the overflow menu", () => {
    renderTable();

    fireEvent.click(within(openMoreMenu()).getByRole("menuitem", { name: "Add field" }));
    assert.ok(screen.getByRole("dialog", { name: "Add field" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    fireEvent.click(within(openMoreMenu()).getByRole("menuitem", { name: "Field calculator" }));
    assert.ok(screen.getByRole("dialog", { name: "Field calculator" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    fireEvent.click(within(openMoreMenu()).getByRole("menuitem", { name: "Field statistics" }));
    assert.ok(screen.getByRole("dialog", { name: "Field statistics" }));
  });

  it("keeps only Export and Zoom to selection in the menu while editing", () => {
    renderTable();

    fireEvent.click(screen.getByRole("button", { name: "Edit attribute values" }));

    assert.ok(screen.getByRole("button", { name: "Cancel attribute edits" }));
    assert.deepEqual(menuEntries(openMoreMenu()), ["Export", "Zoom to selection"]);
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

describe("draft target edge cases", () => {
  for (const id of ["constructor", "toString", "__proto__"]) {
    it(`saves a draft for the literal feature ID ${id}`, () => {
      renderTable({ ...cities, features: [{ ...cities.features[0], id }] });
      fireEvent.click(screen.getByRole("button", { name: "Edit attribute values" }));
      const input = screen.getByRole("textbox", { name: `Edit name for feature ${id}` });
      assert.equal((input as HTMLInputElement).value, "Oslo");
      fireEvent.change(input, { target: { value: "Updated Oslo" } });
      act(() => assert.equal(commitPendingAttributeDrafts("cities"), "committed"));
      assert.equal(
        useAppStore.getState().layers[0].geojson?.features[0].properties?.name,
        "Updated Oslo",
      );
    });
  }

  it("reuses captured targets without rereading features on subsequent keystrokes", () => {
    let idReads = 0;
    const feature = { ...cities.features[0] };
    Object.defineProperty(feature, "id", {
      get: () => {
        idReads++;
        return 1;
      },
    });
    useAppStore.setState({
      layers: [geojsonLayer({ id: "cities", geojson: { ...cities, features: [feature] } })],
    });
    useAppStore.getState().setAttributeTableDrafts("cities", { "1": { name: "First" } });
    assert.ok(idReads > 0);
    const targets = useAppStore.getState().ui.attributeTableDrafts.cities.targets;
    idReads = 0;
    useAppStore.getState().setAttributeTableDrafts("cities", { "1": { name: "Second" } });
    assert.equal(idReads, 0);
    assert.equal(useAppStore.getState().ui.attributeTableDrafts.cities.targets, targets);
    assert.equal(targets["1"], feature);
  });

  it("snapshots draft targets from supplied rows for a layer without geojson", () => {
    useAppStore.setState({
      layers: [geojsonLayer({ id: "query", geojson: undefined })],
    });
    const row = {
      type: "Feature" as const,
      geometry: null,
      properties: { name: "Row zero" },
    };
    useAppStore
      .getState()
      .setAttributeTableDrafts("query", { "0": { name: "Edited" } }, new Map([["0", row]]));
    assert.equal(useAppStore.getState().ui.attributeTableDrafts.query.targets["0"], row);
  });

  it("retains but blocks an ID-less draft after geometry changes until its original row is restored", () => {
    const { id: _id, ...feature } = cities.features[0];
    const original = { ...cities, features: [feature] };
    renderTable(original);
    fireEvent.click(screen.getByRole("button", { name: "Edit attribute values" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit name for feature 0" }), {
      target: { value: "Retained draft" },
    });
    const changed = {
      ...original,
      features: [{ ...feature, geometry: { type: "Point" as const, coordinates: [12, 60] } }],
    };
    act(() => useAppStore.getState().updateLayer("cities", { geojson: changed }));
    act(() => assert.equal(commitPendingAttributeDrafts("cities"), "blocked"));
    assert.equal(useAppStore.getState().layers[0].geojson, changed);
    assert.equal(
      (screen.getByRole("textbox", { name: "Edit name for feature 0" }) as HTMLInputElement).value,
      "Retained draft",
    );
    act(() => useAppStore.getState().updateLayer("cities", { geojson: structuredClone(original) }));
    act(() => assert.equal(commitPendingAttributeDrafts("cities"), "committed"));
    assert.equal(
      useAppStore.getState().layers[0].geojson?.features[0].properties?.name,
      "Retained draft",
    );
  });
});

describe("GeoEditor Sketches attributes (#3534)", () => {
  it("adds a styling field and saves edits on the sketches layer", () => {
    renderTable(cities, { metadata: { sourceKind: "geoeditor-sketches" } });
    fireEvent.click(within(openMoreMenu()).getByRole("menuitem", { name: "Add field" }));
    const dialog = screen.getByRole("dialog", { name: "Add field" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Field name" }), {
      target: { value: "stroke" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Default value" }), {
      target: { value: "#ff0000" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add field" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit attribute values" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit stroke for feature 1" }), {
      target: { value: "#00ff00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save attribute edits" }));
    const layer = useAppStore.getState().layers[0];
    assert.equal(layer.geojson?.features[0].properties?.stroke, "#00ff00");
    assert.equal(layer.geojson?.features[1].properties?.stroke, "#ff0000");
    assert.deepEqual(
      layer.geojson?.features.map((f) => f.geometry),
      cities.features.map((f) => f.geometry),
    );
    assert.equal(layer.metadata.sourceKind, "geoeditor-sketches");
  });
});

describe("Sketches internal properties", () => {
  it("hides Geoman columns without stripping the metadata needed to edit shapes", () => {
    const collection: FeatureCollection = {
      ...cities,
      features: [
        {
          ...cities.features[0],
          properties: {
            name: "Rectangle",
            __gm_id: "feature-1",
            __gm_shape: "rectangle",
            __gm_width: 100,
            __gm_height: 50,
          },
        },
      ],
    };
    renderTable(collection, { metadata: { sourceKind: "geoeditor-sketches" } });
    assert.deepEqual(headers(), ["#", "name"]);
    fireEvent.click(screen.getByRole("button", { name: "Edit attribute values" }));
    assert.equal(screen.queryByRole("textbox", { name: "Edit __gm_width for feature 1" }), null);
    fireEvent.change(screen.getByRole("textbox", { name: "Edit name for feature 1" }), {
      target: { value: "Renamed rectangle" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save attribute edits" }));
    assert.deepEqual(useAppStore.getState().layers[0].geojson?.features[0].properties, {
      name: "Renamed rectangle",
      __gm_id: "feature-1",
      __gm_shape: "rectangle",
      __gm_width: 100,
      __gm_height: 50,
    });
  });
  it("keeps similarly named user columns on ordinary data layers", () => {
    renderTable({
      ...cities,
      features: [{ ...cities.features[0], properties: { __gm_width: 100 } }],
    });
    assert.deepEqual(headers(), ["#", "__gm_width"]);
  });
});

describe("protect hidden Sketches fields", () => {
  const sketch: FeatureCollection = {
    ...cities,
    features: [
      { ...cities.features[0], properties: { name: "Rectangle", __gm_shape: "rectangle" } },
    ],
  };
  it("rejects existing and new internal names when adding a field while allowing stroke", () => {
    renderTable(sketch, { metadata: { sourceKind: "geoeditor-sketches" } });
    fireEvent.click(within(openMoreMenu()).getByRole("menuitem", { name: "Add field" }));
    const dialog = screen.getByRole("dialog", { name: "Add field" });
    const name = within(dialog).getByRole("textbox", { name: "Field name" });
    for (const value of ["__gm_shape", "__gm_custom"]) {
      fireEvent.change(name, { target: { value } });
      assert.equal(
        (within(dialog).getByRole("button", { name: "Add field" }) as HTMLButtonElement).disabled,
        true,
      );
    }
    fireEvent.change(name, { target: { value: "stroke" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add field" }));
    assert.equal(
      useAppStore.getState().layers[0].geojson?.features[0].properties?.__gm_shape,
      "rectangle",
    );
    assert.ok(
      Object.hasOwn(useAppStore.getState().layers[0].geojson!.features[0].properties!, "stroke"),
    );
  });
  it("rejects internal calculator targets while allowing ordinary fields", () => {
    renderTable(sketch, { metadata: { sourceKind: "geoeditor-sketches" } });
    fireEvent.click(within(openMoreMenu()).getByRole("menuitem", { name: "Field calculator" }));
    const dialog = screen.getByRole("dialog", { name: "Field calculator" });
    fireEvent.change(dialog.querySelector("#calc-target-mode")!, { target: { value: "create" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Expression" }), {
      target: { value: "1" },
    });
    for (const value of ["__gm_shape", "__gm_custom"]) {
      fireEvent.change(within(dialog).getByRole("textbox", { name: "Target field" }), {
        target: { value },
      });
      assert.equal(
        (within(dialog).getByRole("button", { name: "Calculate" }) as HTMLButtonElement).disabled,
        true,
      );
    }
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Target field" }), {
      target: { value: "stroke" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Calculate" }));
    assert.equal(
      useAppStore.getState().layers[0].geojson?.features[0].properties?.__gm_shape,
      "rectangle",
    );
    assert.equal(useAppStore.getState().layers[0].geojson?.features[0].properties?.stroke, 1);
  });
});

it("rejects renaming a Sketches field to existing or new internal names", () => {
  renderTable(
    {
      ...cities,
      features: [
        { ...cities.features[0], properties: { name: "Rectangle", __gm_shape: "rectangle" } },
      ],
    },
    { metadata: { sourceKind: "geoeditor-sketches" } },
  );
  for (const nextName of ["__gm_shape", "__gm_custom", "stroke"]) {
    fireEvent.pointerDown(screen.getByRole("button", { name: "Manage field name" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename field" }));
    const input = screen.getByRole("textbox", { name: "Rename field name" });
    fireEvent.change(input, { target: { value: nextName } });
    fireEvent.keyDown(input, { key: "Enter" });
    const properties = useAppStore.getState().layers[0].geojson?.features[0].properties;
    assert.equal(properties?.__gm_shape, "rectangle");
    assert.equal(properties?.[nextName === "stroke" ? "stroke" : "name"], "Rectangle");
  }
});
