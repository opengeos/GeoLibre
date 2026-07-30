import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import { projectChanged } from "../apps/geolibre-desktop/src/lib/project-broadcast-changed";

function geojsonLayer(id: string): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: { type: "FeatureCollection", features: [] },
  };
}

describe("collaboration projectChanged", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Collab" });
  });

  it("detects map-grid and model-only edits that must broadcast", () => {
    const before = useAppStore.getState();
    useAppStore.getState().setMapGrid(1, 2);
    assert.equal(projectChanged(before, useAppStore.getState()), true);

    useAppStore.getState().newProject({ name: "Collab" });
    const beforeModels = useAppStore.getState();
    useAppStore.getState().saveModel({
      id: "model-1",
      name: "Pipeline",
      steps: [],
    });
    assert.equal(projectChanged(beforeModels, useAppStore.getState()), true);
  });

  it("detects processing history, widgets, style library, metadata, layers, and plugins", () => {
    const beforeHistory = useAppStore.getState();
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
    assert.equal(projectChanged(beforeHistory, useAppStore.getState()), true);

    useAppStore.getState().newProject({ name: "Collab" });
    const beforeWidgets = useAppStore.getState();
    useAppStore.getState().addWidget({
      id: "w1",
      type: "indicator",
      title: "Count",
      layerId: "layer-a",
      indicatorAggregation: "count",
    });
    assert.equal(projectChanged(beforeWidgets, useAppStore.getState()), true);

    useAppStore.getState().newProject({ name: "Collab" });
    const beforeStyle = useAppStore.getState();
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
    assert.equal(projectChanged(beforeStyle, useAppStore.getState()), true);

    useAppStore.getState().newProject({ name: "Collab" });
    const beforeMeta = useAppStore.getState();
    useAppStore.setState({ metadata: { author: "test" }, isDirty: true });
    assert.equal(projectChanged(beforeMeta, useAppStore.getState()), true);

    useAppStore.getState().newProject({ name: "Collab" });
    const beforeLayers = useAppStore.getState();
    useAppStore.getState().addLayer(geojsonLayer("layer-a"));
    assert.equal(projectChanged(beforeLayers, useAppStore.getState()), true);

    useAppStore.getState().newProject({ name: "Collab" });
    const beforePlugins = useAppStore.getState();
    useAppStore.setState({
      projectPlugins: { manifestUrls: ["https://example.com/plugin.json"] },
      isDirty: true,
    });
    assert.equal(projectChanged(beforePlugins, useAppStore.getState()), true);
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
