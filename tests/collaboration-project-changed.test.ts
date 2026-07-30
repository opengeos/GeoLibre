import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import { projectChanged } from "../apps/geolibre-desktop/src/lib/project-broadcast-changed";

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

  it("ignores camera-only churn", () => {
    const before = useAppStore.getState();
    useAppStore.getState().setMapView({
      center: [12, 34],
      zoom: 8,
      bearing: 10,
      pitch: 20,
    });
    assert.equal(projectChanged(before, useAppStore.getState()), false);
  });
});
