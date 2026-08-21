import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import { projectChanged } from "../apps/geolibre-desktop/src/lib/project-broadcast-changed";
import { geojsonLayer } from "./helpers/layer-fixtures";

describe("collaboration projectChanged", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Collab" });
  });

  // One field per test: a failure in any single broadcast field must not hide
  // regressions in the others.
  it("detects map-grid edits", () => {
    const before = useAppStore.getState();
    useAppStore.getState().setMapGrid(1, 2);
    assert.equal(projectChanged(before, useAppStore.getState()), true);
  });

  it("detects model-only edits", () => {
    const before = useAppStore.getState();
    useAppStore.getState().saveModel({
      id: "model-1",
      name: "Pipeline",
      steps: [],
    });
    assert.equal(projectChanged(before, useAppStore.getState()), true);
  });

  it("detects processing-history edits", () => {
    const before = useAppStore.getState();
    useAppStore.getState().addProcessingRun({
      id: "run-1",
      kind: "vector",
      toolId: "buffer",
      toolName: "Buffer",
      engine: "client",
      parameters: {},
      startedAt: "2026-07-30T00:00:00.000Z",
      durationMs: 1,
      status: "success",
    });
    assert.equal(projectChanged(before, useAppStore.getState()), true);
  });

  it("detects widget edits", () => {
    const before = useAppStore.getState();
    useAppStore.getState().addWidget({
      id: "w1",
      type: "indicator",
      title: "Count",
      layerId: "layer-a",
      indicatorAggregation: "count",
    });
    assert.equal(projectChanged(before, useAppStore.getState()), true);
  });

  it("detects style-library edits", () => {
    const before = useAppStore.getState();
    useAppStore.getState().saveStyleLibraryEntry(
      {
        id: "style-1",
        name: "Preset",
        kind: "symbol",
        tags: [],
        style: {},
        updatedAt: "2026-07-30T00:00:00.000Z",
      },
      "project",
    );
    assert.equal(projectChanged(before, useAppStore.getState()), true);
  });

  it("detects metadata edits", () => {
    const before = useAppStore.getState();
    useAppStore.setState({ metadata: { author: "test" }, isDirty: true });
    assert.equal(projectChanged(before, useAppStore.getState()), true);
  });

  it("detects layer edits", () => {
    const before = useAppStore.getState();
    useAppStore.getState().addLayer(geojsonLayer({ id: "layer-a", name: "layer-a" }));
    assert.equal(projectChanged(before, useAppStore.getState()), true);
  });

  it("keeps plugin activation and settings local to each participant", () => {
    const before = useAppStore.getState();
    useAppStore.setState({
      projectPlugins: {
        manifestUrls: ["https://example.com/plugin.json"],
        activePluginIds: [],
        mapControlPositions: {},
        settings: {},
      },
      isDirty: true,
    });
    assert.equal(projectChanged(before, useAppStore.getState()), false);
  });

  it("leaves comment synchronization to the dedicated mutation protocol", () => {
    const before = useAppStore.getState();
    useAppStore.getState().addComment({
      id: "comment-1",
      anchor: { type: "point", lngLat: [12, 34] },
      author: { name: "Ada", color: "#123456" },
      body: "Check this location",
      createdAt: "2026-08-06T00:00:00.000Z",
      resolved: false,
      replies: [],
    });
    assert.equal(projectChanged(before, useAppStore.getState()), false);
  });

  it("ignores camera-only and UI-only churn", () => {
    const before = useAppStore.getState();
    useAppStore.getState().setMapView({
      center: [12, 34],
      zoom: 8,
      bearing: 10,
      pitch: 20,
    });
    assert.equal(projectChanged(before, useAppStore.getState()), false);

    const beforeUi = useAppStore.getState();
    useAppStore.getState().setCollaborateDialogOpen(true);
    assert.equal(projectChanged(beforeUi, useAppStore.getState()), false);
  });
});
