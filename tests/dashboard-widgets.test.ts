import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_BASEMAP,
  createEmptyProject,
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
      { id: "y", layerId: "a", type: "pie" },
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

  it("ignores updates and moves for an unknown widget id", () => {
    useAppStore.getState().addWidget(widget({ id: "a" }));
    useAppStore.getState().updateWidget("missing", { title: "x" });
    useAppStore.getState().moveWidget("missing", 3);
    assert.deepEqual(
      useAppStore.getState().widgets.map((w) => w.id),
      ["a"],
    );
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

  it("returns an empty result when the required field is missing", () => {
    const result = computeChart(rows, { type: "histogram" });
    assert.equal(chartResultHasData(result), false);
  });
});
