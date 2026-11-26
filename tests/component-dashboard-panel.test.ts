import { act, fireEvent, render, screen, useAppStore, waitFor, within } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { DashboardWidget, GeoLibreLayer } from "@geolibre/core";

// Loaded after the harness so the panel's CSS imports and Vite globals resolve.
const { DashboardPanel } =
  await import("../apps/geolibre-desktop/src/components/panels/DashboardPanel");

const CITIES = [
  { name: "Ames", state: "IA", pop: 66000 },
  { name: "Boone", state: "IA", pop: 12000 },
  { name: "Omaha", state: "NE", pop: 486000 },
  { name: "Lincoln", state: "NE", pop: 291000 },
];

const cities = {
  id: "cities",
  name: "Cities",
  type: "geojson",
  visible: true,
  opacity: 1,
  geojson: {
    type: "FeatureCollection",
    features: CITIES.map((properties, index) => ({
      type: "Feature",
      properties,
      geometry: { type: "Point", coordinates: [-95 + index, 41] },
    })),
  },
} as unknown as GeoLibreLayer;

function seed(widgets: DashboardWidget[]) {
  act(() => useAppStore.setState({ layers: [cities], widgets }));
}

const text = () => document.body.textContent ?? "";
const cards = () => screen.queryAllByRole("button", { name: "Remove widget" });
/** The formatted value of each indicator tile, in widget order. */
const indicatorValues = () =>
  Array.from(document.querySelectorAll("span.text-3xl"), (span) => span.textContent);

describe("DashboardPanel", () => {
  it("explains what to add when the project has no chartable layer", () => {
    render(createElement(DashboardPanel));
    assert.ok(text().includes("No compatible layers found"));
    assert.equal(screen.getByRole("button", { name: /Add widget/ }).hasAttribute("disabled"), true);
  });

  it("computes indicator widgets and labels each card", () => {
    seed([
      { id: "w1", layerId: "cities", type: "indicator", indicatorAggregation: "sum", field: "pop" },
      {
        id: "w2",
        layerId: "cities",
        type: "indicator",
        indicatorAggregation: "count",
        title: "Places",
        prefix: "#",
      },
    ]);
    render(createElement(DashboardPanel));
    assert.ok(text().includes("2 widgets"));
    assert.ok(text().includes("Places"));
    // Sum of 66,000 + 12,000 + 486,000 + 291,000, then a prefixed count.
    assert.deepEqual(indicatorValues(), [(855000).toLocaleString(), "#4"]);
  });

  it("filters other widgets on the same layer from a selector", async () => {
    seed([
      { id: "sel", layerId: "cities", type: "selector", category: "state" },
      {
        id: "kpi",
        layerId: "cities",
        type: "indicator",
        indicatorAggregation: "count",
        title: "Places",
      },
    ]);
    render(createElement(DashboardPanel));
    assert.deepEqual(indicatorValues(), ["4"]);
    fireEvent.click(screen.getByRole("button", { name: /^NE/ }));
    await waitFor(() => assert.deepEqual(indicatorValues(), ["2"]));
    assert.ok(text().includes("2 of 4 features"));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => assert.deepEqual(indicatorValues(), ["4"]));
  });

  it("reorders and removes widgets, and changes the column count", () => {
    seed([
      {
        id: "a",
        layerId: "cities",
        type: "indicator",
        indicatorAggregation: "count",
        title: "First",
      },
      {
        id: "b",
        layerId: "cities",
        type: "indicator",
        indicatorAggregation: "count",
        title: "Second",
      },
    ]);
    render(createElement(DashboardPanel));
    fireEvent.click(screen.getAllByRole("button", { name: "Move forward" })[0]!);
    assert.deepEqual(
      useAppStore.getState().widgets.map((w) => w.id),
      ["b", "a"],
    );
    // Remove "Second" (id b), which Move forward placed first.
    const second = useAppStore.getState().widgets.findIndex((w) => w.id === "b");
    fireEvent.click(cards()[second]!);
    assert.deepEqual(
      useAppStore.getState().widgets.map((w) => w.id),
      ["a"],
    );
    const columns = screen.getByRole("combobox", { name: "Columns" }) as HTMLSelectElement;
    fireEvent.change(columns, { target: { value: "3" } });
    assert.equal(useAppStore.getState().dashboardColumns, 3);
  });

  it("adds a widget through the editor and edits it in place", async () => {
    seed([]);
    render(createElement(DashboardPanel));
    assert.ok(text().includes("No widgets yet"));
    fireEvent.click(screen.getByRole("button", { name: /Add widget/ }));
    const dialog = await screen.findByRole("dialog", { name: "Add widget" });
    fireEvent.change(within(dialog).getByLabelText("Chart type"), {
      target: { value: "indicator" },
    });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Total" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => assert.equal(useAppStore.getState().widgets.length, 1));
    const widget = useAppStore.getState().widgets[0]!;
    assert.equal(widget.type, "indicator");
    assert.equal(widget.title, "Total");
    assert.equal(widget.layerId, "cities");

    fireEvent.click(screen.getByRole("button", { name: "Edit widget" }));
    const edit = await screen.findByRole("dialog", { name: "Edit widget" });
    fireEvent.change(within(edit).getByLabelText("Title"), { target: { value: "Renamed" } });
    fireEvent.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() => assert.equal(useAppStore.getState().widgets[0]!.title, "Renamed"));
    assert.equal(useAppStore.getState().widgets[0]!.id, widget.id);
  });

  it("collapses and closes", () => {
    act(() => useAppStore.getState().setDashboardOpen(true));
    render(createElement(DashboardPanel));
    fireEvent.click(screen.getByRole("button", { name: "Collapse dashboard" }));
    assert.ok(screen.getByRole("button", { name: "Expand dashboard" }));
    fireEvent.click(screen.getByRole("button", { name: "Close dashboard" }));
    assert.equal(useAppStore.getState().ui.dashboardOpen, false);
  });
});
