import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_BASEMAP,
  DEFAULT_DASHBOARD_COLUMNS,
  createEmptyProject,
  normalizeDashboardColumns,
  normalizeWidgets,
  parseProject,
  projectFromStore,
  serializeProject,
  useAppStore,
  type DashboardWidget,
} from "@geolibre/core";
import {
  computeChart,
  chartResultHasData,
} from "../apps/geolibre-desktop/src/components/panels/charts/chart-spec";
import {
  CHART_PALETTE,
  categoryColors,
  isHexColor,
  shadeRamp,
} from "../apps/geolibre-desktop/src/components/panels/charts/chart-colors";
import type { ChartRow } from "../apps/geolibre-desktop/src/lib/attribute-charts";

function widget(patch: Partial<DashboardWidget> = {}): DashboardWidget {
  return {
    id: "w1",
    layerId: "layer-a",
    type: "histogram",
    field: "pop",
    bins: 10,
    ...patch,
  };
}

describe("normalizeWidgets", () => {
  it("keeps a valid widget with all of its options", () => {
    const widgets: DashboardWidget[] = [
      {
        id: "bar-1",
        layerId: "layer-a",
        type: "bar",
        category: "kind",
        aggregation: "sum",
        valueField: "pop",
        title: "By kind",
      },
    ];
    assert.deepEqual(normalizeWidgets(widgets), widgets);
  });

  it("drops widgets without an id, layer id, or known type", () => {
    const result = normalizeWidgets([
      { id: "", layerId: "a", type: "bar" },
      { id: "x", layerId: "", type: "bar" },
      { id: "y", layerId: "a", type: "donut" },
      widget({ id: "good", layerId: "a", type: "box", field: "pop" }),
    ] as never);
    assert.deepEqual(
      result?.map((w) => w.id),
      ["good"],
    );
  });

  it("de-duplicates widgets by id, keeping the first", () => {
    const result = normalizeWidgets([
      widget({ id: "dup", title: "first" }),
      widget({ id: "dup", title: "second" }),
    ]);
    assert.equal(result?.length, 1);
    assert.equal(result?.[0].title, "first");
  });

  it("keeps a valid hex color and drops an invalid one", () => {
    const result = normalizeWidgets([
      widget({ id: "a", color: "#ff0000" }),
      widget({ id: "b", color: "red" }),
      widget({ id: "c", color: "#abc" }),
    ]);
    assert.equal(result?.find((w) => w.id === "a")?.color, "#ff0000");
    assert.equal("color" in (result?.find((w) => w.id === "b") ?? {}), false);
    assert.equal(result?.find((w) => w.id === "c")?.color, "#abc");
  });

  it("coerces bins to an integer and drops a bad aggregation", () => {
    const result = normalizeWidgets([
      { id: "a", layerId: "l", type: "histogram", field: "pop", bins: 7.9 },
      {
        id: "b",
        layerId: "l",
        type: "bar",
        category: "kind",
        aggregation: "median",
      },
    ] as never);
    assert.equal(result?.[0].bins, 7);
    assert.equal("aggregation" in (result?.[1] ?? {}), false);
  });

  it("drops a non-positive bin count and caps a huge one", () => {
    const result = normalizeWidgets([
      { id: "a", layerId: "l", type: "histogram", field: "pop", bins: 0 },
      { id: "b", layerId: "l", type: "histogram", field: "pop", bins: 999 },
    ] as never);
    assert.equal("bins" in (result?.find((w) => w.id === "a") ?? {}), false);
    assert.equal(result?.find((w) => w.id === "b")?.bins, 50);
  });

  it("drops a mean aggregation on a pie widget", () => {
    const result = normalizeWidgets([
      { id: "p", layerId: "l", type: "pie", category: "kind", aggregation: "mean" },
      { id: "b", layerId: "l", type: "bar", category: "kind", aggregation: "mean" },
    ] as never);
    assert.equal("aggregation" in (result?.find((w) => w.id === "p") ?? {}), false);
    assert.equal(result?.find((w) => w.id === "b")?.aggregation, "mean");
  });

  it("returns null for a non-array or an all-invalid list", () => {
    assert.equal(normalizeWidgets(undefined), null);
    assert.equal(normalizeWidgets("nope"), null);
    assert.equal(normalizeWidgets([{ id: "", layerId: "" }] as never), null);
  });
});

describe("widgets in the project file", () => {
  it("round-trips through projectFromStore and parseProject", () => {
    const widgets: DashboardWidget[] = [
      { id: "w1", layerId: "layer-a", type: "histogram", field: "pop", bins: 12 },
      { id: "w2", layerId: "layer-a", type: "scatter", xField: "pop", yField: "area" },
    ];
    const project = projectFromStore({
      projectName: "Widgets",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [],
      preferences: createEmptyProject().preferences,
      widgets,
      metadata: {},
    });
    assert.deepEqual(project.widgets, widgets);
    const reparsed = parseProject(serializeProject(project));
    assert.deepEqual(reparsed.widgets, widgets);
  });

  it("persists a non-default column count and omits the default", () => {
    const base = {
      projectName: "Widgets",
      mapView: { center: [0, 0] as [number, number], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [],
      preferences: createEmptyProject().preferences,
      metadata: {},
    };
    const custom = projectFromStore({ ...base, dashboardColumns: 3 });
    assert.equal(custom.dashboardColumns, 3);
    assert.equal(parseProject(serializeProject(custom)).dashboardColumns, 3);

    const defaulted = projectFromStore({
      ...base,
      dashboardColumns: DEFAULT_DASHBOARD_COLUMNS,
    });
    assert.equal("dashboardColumns" in defaulted, false);
  });

  it("omits the widgets key when none are valid", () => {
    const project = projectFromStore({
      projectName: "Widgets",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [],
      preferences: createEmptyProject().preferences,
      widgets: [{ id: "", layerId: "", type: "bar" }] as never,
      metadata: {},
    });
    assert.equal("widgets" in project, false);
  });
});

describe("chart colors", () => {
  it("recognizes hex colors and rejects other strings", () => {
    assert.equal(isHexColor("#fff"), true);
    assert.equal(isHexColor("#3fb1ce"), true);
    assert.equal(isHexColor("blue"), false);
    assert.equal(isHexColor("#12"), false);
    assert.equal(isHexColor(undefined), false);
  });

  it("builds a ramp that starts at the base and lightens", () => {
    const ramp = shadeRamp("#000000", 3);
    assert.equal(ramp.length, 3);
    assert.equal(ramp[0], "#000000");
    // Later shades are lighter than the base.
    assert.notEqual(ramp[2], "#000000");
  });

  it("falls back to the palette when no valid color is given", () => {
    const palette = categoryColors(undefined, 3);
    assert.deepEqual(palette, CHART_PALETTE.slice(0, 3));
    const ramp = categoryColors("#3fb1ce", 4);
    assert.equal(ramp.length, 4);
    assert.equal(ramp[0], "#3fb1ce");
  });
});

describe("normalizeDashboardColumns", () => {
  it("clamps into range and falls back to the default", () => {
    assert.equal(normalizeDashboardColumns(3), 3);
    assert.equal(normalizeDashboardColumns(0), 1);
    assert.equal(normalizeDashboardColumns(99), 6);
    assert.equal(normalizeDashboardColumns(2.9), 2);
    assert.equal(normalizeDashboardColumns(undefined), DEFAULT_DASHBOARD_COLUMNS);
    assert.equal(normalizeDashboardColumns("x"), DEFAULT_DASHBOARD_COLUMNS);
  });
});

describe("app store widget actions", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Test Project" });
  });

  it("adds, updates, moves, and removes widgets", () => {
    const store = useAppStore.getState();
    store.addWidget(widget({ id: "a" }));
    store.addWidget(widget({ id: "b", type: "box", field: "area" }));
    assert.deepEqual(
      useAppStore.getState().widgets.map((w) => w.id),
      ["a", "b"],
    );
    assert.equal(useAppStore.getState().isDirty, true);

    useAppStore.getState().updateWidget("a", { title: "Renamed", bins: 20 });
    const a = useAppStore.getState().widgets.find((w) => w.id === "a");
    assert.equal(a?.title, "Renamed");
    assert.equal(a?.bins, 20);
    assert.equal(a?.id, "a");

    // Move "b" to the front; clamps and reorders.
    useAppStore.getState().moveWidget("b", 0);
    assert.deepEqual(
      useAppStore.getState().widgets.map((w) => w.id),
      ["b", "a"],
    );

    useAppStore.getState().removeWidget("a");
    assert.deepEqual(
      useAppStore.getState().widgets.map((w) => w.id),
      ["b"],
    );
  });

  it("ignores a duplicate widget id in addWidget", () => {
    useAppStore.getState().addWidget(widget({ id: "a", title: "first" }));
    useAppStore.getState().addWidget(widget({ id: "a", title: "second" }));
    const widgets = useAppStore.getState().widgets;
    assert.equal(widgets.length, 1);
    assert.equal(widgets[0].title, "first");
  });

  it("ignores updates and moves for an unknown widget id", () => {
    useAppStore.getState().addWidget(widget({ id: "a" }));
    useAppStore.getState().updateWidget("missing", { title: "x" });
    useAppStore.getState().moveWidget("missing", 3);
    assert.deepEqual(
      useAppStore.getState().widgets.map((w) => w.id),
      ["a"],
    );
  });

  it("clamps the dashboard column count", () => {
    useAppStore.getState().setDashboardColumns(3);
    assert.equal(useAppStore.getState().dashboardColumns, 3);
    useAppStore.getState().setDashboardColumns(99);
    assert.equal(useAppStore.getState().dashboardColumns, 6);
    useAppStore.getState().setDashboardColumns(0);
    assert.equal(useAppStore.getState().dashboardColumns, 1);
    // Non-finite input is ignored, leaving the last valid value intact.
    useAppStore.getState().setDashboardColumns(Number.NaN);
    assert.equal(useAppStore.getState().dashboardColumns, 1);
  });
});

describe("computeChart", () => {
  const rows: ChartRow[] = [
    { properties: { pop: 10, kind: "a" } },
    { properties: { pop: 20, kind: "a" } },
    { properties: { pop: 30, kind: "b" } },
  ];

  it("dispatches a histogram and reports it has data", () => {
    const result = computeChart(rows, { type: "histogram", field: "pop", bins: 4 });
    assert.equal(result.type, "histogram");
    assert.ok(chartResultHasData(result));
    if (result.type === "histogram") assert.equal(result.result?.total, 3);
  });

  it("dispatches a bar count grouped by a category", () => {
    const result = computeChart(rows, {
      type: "bar",
      category: "kind",
      aggregation: "count",
    });
    assert.equal(result.type, "bar");
    if (result.type === "bar") {
      assert.equal(result.result?.bars.length, 2);
    }
  });

  it("dispatches a pie of category shares that sum to the whole", () => {
    const result = computeChart(rows, {
      type: "pie",
      category: "kind",
      aggregation: "count",
    });
    assert.equal(result.type, "pie");
    if (result.type === "pie") {
      assert.equal(result.result?.total, 3);
      assert.equal(result.result?.slices.length, 2);
    }
  });

  it("returns an empty result when the required field is missing", () => {
    const result = computeChart(rows, { type: "histogram" });
    assert.equal(chartResultHasData(result), false);
  });
});
