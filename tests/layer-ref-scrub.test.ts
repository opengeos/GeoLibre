import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_LEGEND_CONFIG,
  applyProjectToStore,
  createEmptyProject,
  scrubWidgetsForRemovedLayers,
  scrubCommentsForRemovedLayers,
  scrubLegendForRemovedLayers,
  useAppStore,
  type DashboardWidget,
  type LegendConfig,
  type ProjectComment,
} from "@geolibre/core";
import { geojsonLayer } from "./helpers/layer-fixtures";

// ---------------------------------------------------------------------------
// Unit tests for pure scrub helpers
// ---------------------------------------------------------------------------

describe("scrubWidgetsForRemovedLayers", () => {
  it("removes widgets whose layerId is in the removed set", () => {
    const widgets: DashboardWidget[] = [
      { id: "w1", layerId: "gone", type: "histogram", field: "x" },
      { id: "w2", layerId: "keep", type: "bar", category: "y" },
    ];
    const result = scrubWidgetsForRemovedLayers(widgets, "gone");
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "w2");
  });

  it("returns same reference when nothing changes", () => {
    const widgets: DashboardWidget[] = [
      { id: "w1", layerId: "keep", type: "histogram", field: "x" },
    ];
    const result = scrubWidgetsForRemovedLayers(widgets, "other");
    assert.equal(result, widgets);
  });

  it("handles multiple removed ids", () => {
    const widgets: DashboardWidget[] = [
      { id: "w1", layerId: "a", type: "histogram", field: "x" },
      { id: "w2", layerId: "b", type: "bar", category: "y" },
      { id: "w3", layerId: "c", type: "pie", category: "z" },
    ];
    const result = scrubWidgetsForRemovedLayers(widgets, new Set(["a", "c"]));
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "w2");
  });
});

describe("scrubCommentsForRemovedLayers", () => {
  const pointComment: ProjectComment = {
    id: "c-point",
    anchor: { type: "point", lngLat: [0, 0] },
    author: { name: "A", color: "#f00" },
    body: "map note",
    createdAt: "2026-01-01T00:00:00Z",
    resolved: false,
    replies: [],
  };

  const featureComment: ProjectComment = {
    id: "c-feat",
    anchor: { type: "feature", layerId: "gone", featureId: "f1" },
    author: { name: "B", color: "#0f0" },
    body: "on feature",
    createdAt: "2026-01-01T00:00:00Z",
    resolved: false,
    replies: [],
  };

  const keepFeatureComment: ProjectComment = {
    id: "c-feat-keep",
    anchor: { type: "feature", layerId: "keep", featureId: "f2" },
    author: { name: "C", color: "#00f" },
    body: "different layer",
    createdAt: "2026-01-01T00:00:00Z",
    resolved: false,
    replies: [],
  };

  it("drops feature comments on removed layers but keeps point comments", () => {
    const comments = [pointComment, featureComment, keepFeatureComment];
    const result = scrubCommentsForRemovedLayers(comments, "gone");
    assert.equal(result.length, 2);
    assert.equal(result[0].id, "c-point");
    assert.equal(result[1].id, "c-feat-keep");
  });

  it("returns same reference when nothing changes", () => {
    const comments = [pointComment, keepFeatureComment];
    const result = scrubCommentsForRemovedLayers(comments, "gone");
    assert.equal(result, comments);
  });
});

describe("scrubLegendForRemovedLayers", () => {
  it("removes layer id from order", () => {
    const legend: LegendConfig = {
      ...DEFAULT_LEGEND_CONFIG,
      order: ["a", "gone", "b"],
      overrides: {},
    };
    const result = scrubLegendForRemovedLayers(legend, "gone");
    assert.deepEqual(result.order, ["a", "b"]);
  });

  it("drops overrides keyed by removed id or starting with id::", () => {
    const legend: LegendConfig = {
      ...DEFAULT_LEGEND_CONFIG,
      order: [],
      overrides: {
        gone: { label: "x" },
        "gone::0": { hidden: true },
        "gone::1": { label: "y" },
        keep: { label: "z" },
        "keep::0": { label: "w" },
      },
    };
    const result = scrubLegendForRemovedLayers(legend, "gone");
    assert.deepEqual(Object.keys(result.overrides), ["keep", "keep::0"]);
  });

  it("drops customEntries keyed by removed layer id but keeps custom: keys", () => {
    const legend: LegendConfig = {
      ...DEFAULT_LEGEND_CONFIG,
      order: [],
      overrides: {},
      customEntries: {
        gone: { items: [{ color: "#f00", label: "A" }] },
        "custom:my-legend": { items: [{ color: "#0f0", label: "B" }] },
        keep: { items: [{ color: "#00f", label: "C" }] },
      },
    };
    const result = scrubLegendForRemovedLayers(legend, "gone");
    assert.deepEqual(Object.keys(result.customEntries!), ["custom:my-legend", "keep"]);
  });

  it("returns same reference when nothing changes", () => {
    const legend: LegendConfig = {
      ...DEFAULT_LEGEND_CONFIG,
      order: ["keep"],
      overrides: { keep: { label: "hi" } },
    };
    const result = scrubLegendForRemovedLayers(legend, "gone");
    assert.equal(result, legend);
  });
});

// ---------------------------------------------------------------------------
// Store integration tests: removeLayer
// ---------------------------------------------------------------------------

describe("removeLayer cross-ref scrub", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Scrub test" });
  });

  it("drops widgets referencing the removed layer", () => {
    const store = useAppStore.getState();
    store.addLayer(geojsonLayer({ id: "keep", name: "keep" }));
    store.addLayer(geojsonLayer({ id: "gone", name: "gone" }));
    store.addWidget({ id: "w1", layerId: "gone", type: "histogram", field: "x" });
    store.addWidget({ id: "w2", layerId: "keep", type: "bar", category: "y" });

    useAppStore.getState().removeLayer("gone");
    const widgets = useAppStore.getState().widgets;
    assert.equal(widgets.length, 1);
    assert.equal(widgets[0].id, "w2");
  });

  it("drops feature-anchored comments on the removed layer", () => {
    const store = useAppStore.getState();
    store.addLayer(geojsonLayer({ id: "keep", name: "keep" }));
    store.addLayer(geojsonLayer({ id: "gone", name: "gone" }));
    store.addComment({
      id: "c1",
      anchor: { type: "feature", layerId: "gone", featureId: "f1" },
      author: { name: "A", color: "#f00" },
      body: "gone",
      createdAt: "2026-01-01T00:00:00Z",
      resolved: false,
      replies: [],
    });
    store.addComment({
      id: "c2",
      anchor: { type: "point", lngLat: [0, 0] },
      author: { name: "B", color: "#0f0" },
      body: "stays",
      createdAt: "2026-01-01T00:00:00Z",
      resolved: false,
      replies: [],
    });

    useAppStore.getState().removeLayer("gone");
    const comments = useAppStore.getState().comments;
    assert.equal(comments.length, 1);
    assert.equal(comments[0].id, "c2");
  });

  it("scrubs legend order, overrides, and customEntries", () => {
    const store = useAppStore.getState();
    store.addLayer(geojsonLayer({ id: "keep", name: "keep" }));
    store.addLayer(geojsonLayer({ id: "gone", name: "gone" }));
    store.setLegend({
      ...DEFAULT_LEGEND_CONFIG,
      order: ["gone", "keep"],
      overrides: { gone: { label: "x" }, "gone::0": { hidden: true }, keep: { label: "y" } },
      customEntries: {
        gone: { items: [{ color: "#f00", label: "A" }] },
        "custom:standalone": { items: [{ color: "#0f0", label: "B" }] },
      },
    });

    useAppStore.getState().removeLayer("gone");
    const legend = useAppStore.getState().legend;
    assert.deepEqual(legend.order, ["keep"]);
    assert.deepEqual(Object.keys(legend.overrides), ["keep"]);
    assert.deepEqual(Object.keys(legend.customEntries!), ["custom:standalone"]);
  });
});

// ---------------------------------------------------------------------------
// Store integration tests: removeLayerGroup
// ---------------------------------------------------------------------------

describe("removeLayerGroup cross-ref scrub", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Group scrub" });
  });

  it("scrubs widgets and comments when group deletes children", () => {
    const store = useAppStore.getState();
    const groupId = store.addLayerGroup("G");
    store.addLayer({ ...geojsonLayer({ id: "child", name: "child" }), groupId });
    store.addLayer(geojsonLayer({ id: "keep", name: "keep" }));
    store.addWidget({ id: "w1", layerId: "child", type: "histogram", field: "x" });
    store.addWidget({ id: "w2", layerId: "keep", type: "bar", category: "y" });
    store.addComment({
      id: "c1",
      anchor: { type: "feature", layerId: "child", featureId: "f1" },
      author: { name: "A", color: "#f00" },
      body: "bye",
      createdAt: "2026-01-01T00:00:00Z",
      resolved: false,
      replies: [],
    });

    useAppStore.getState().removeLayerGroup(groupId, { removeChildren: true });
    assert.equal(useAppStore.getState().widgets.length, 1);
    assert.equal(useAppStore.getState().widgets[0].id, "w2");
    assert.equal(useAppStore.getState().comments.length, 0);
  });

  it("does not scrub widgets/comments when group keeps children", () => {
    const store = useAppStore.getState();
    const groupId = store.addLayerGroup("G");
    store.addLayer({ ...geojsonLayer({ id: "child", name: "child" }), groupId });
    store.addWidget({ id: "w1", layerId: "child", type: "histogram", field: "x" });
    store.addComment({
      id: "c1",
      anchor: { type: "feature", layerId: "child", featureId: "f1" },
      author: { name: "A", color: "#f00" },
      body: "stays",
      createdAt: "2026-01-01T00:00:00Z",
      resolved: false,
      replies: [],
    });

    useAppStore.getState().removeLayerGroup(groupId, { removeChildren: false });
    assert.equal(useAppStore.getState().widgets.length, 1);
    assert.equal(useAppStore.getState().comments.length, 1);
  });
});

// ---------------------------------------------------------------------------
// applyProjectToStore orphan scrub
// ---------------------------------------------------------------------------

describe("applyProjectToStore orphan ref scrub", () => {
  it("drops widgets referencing non-existent layers", () => {
    const project = createEmptyProject("Test");
    project.layers = [geojsonLayer({ id: "real", name: "real" })];
    project.widgets = [
      { id: "w1", layerId: "real", type: "histogram", field: "x" },
      { id: "w2", layerId: "orphan", type: "bar", category: "y" },
    ];
    const applied = applyProjectToStore(project);
    assert.equal(applied.widgets.length, 1);
    assert.equal(applied.widgets[0].id, "w1");
  });

  it("drops feature comments referencing non-existent layers but keeps point comments", () => {
    const project = createEmptyProject("Test");
    project.layers = [geojsonLayer({ id: "real", name: "real" })];
    project.comments = [
      {
        id: "c1",
        anchor: { type: "feature", layerId: "orphan", featureId: "f1" },
        author: { name: "A", color: "#f00" },
        body: "orphan",
        createdAt: "2026-01-01T00:00:00Z",
        resolved: false,
        replies: [],
      },
      {
        id: "c2",
        anchor: { type: "point", lngLat: [10, 20] },
        author: { name: "B", color: "#0f0" },
        body: "kept",
        createdAt: "2026-01-01T00:00:00Z",
        resolved: false,
        replies: [],
      },
    ];
    const applied = applyProjectToStore(project);
    assert.equal(applied.comments.length, 1);
    assert.equal(applied.comments[0].id, "c2");
  });

  it("scrubs legend keys referencing non-existent layers but keeps custom: entries", () => {
    const project = createEmptyProject("Test");
    project.layers = [geojsonLayer({ id: "real", name: "real" })];
    project.legend = {
      ...DEFAULT_LEGEND_CONFIG,
      order: ["orphan", "real"],
      overrides: { orphan: { label: "x" }, "orphan::0": { hidden: true }, real: { label: "y" } },
      customEntries: {
        orphan: { items: [{ color: "#f00", label: "A" }] },
        "custom:standalone": { items: [{ color: "#0f0", label: "B" }] },
      },
    };
    const applied = applyProjectToStore(project);
    assert.deepEqual(applied.legend.order, ["real"]);
    assert.deepEqual(Object.keys(applied.legend.overrides), ["real"]);
    assert.deepEqual(Object.keys(applied.legend.customEntries!), ["custom:standalone"]);
  });
});
