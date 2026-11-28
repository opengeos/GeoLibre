import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import { setHistoryCoalesceMs } from "../packages/core/src/history";
import { type AppState, redo, undo, useAppStore } from "../packages/core/src/store";
import { pinSelectedFeature } from "../apps/geolibre-desktop/src/lib/selection-actions";

function store(): AppState {
  return useAppStore.getState();
}

const parcels: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", id: "a", properties: { lot: "1", acres: 0.5 }, geometry: null as never },
    { type: "Feature", id: "b", properties: { lot: "2", acres: 0.4 }, geometry: null as never },
  ],
};

describe("the compare pin", () => {
  let layerId: string;
  beforeEach(() => {
    setHistoryCoalesceMs(0);
    store().newProject({ name: "compare" });
    layerId = store().addGeoJsonLayer("Parcels", parcels);
    useAppStore.temporal.getState().clear();
  });

  it("pins the one selected feature, as a snapshot of its attributes", () => {
    store().selectLayer(layerId);
    store().selectFeatures(["b"]);
    assert.equal(pinSelectedFeature(), true);
    assert.deepEqual(store().comparePin, {
      layerId,
      featureId: "b",
      properties: { lot: "2", acres: 0.4 },
    });
    // Not an edit: nothing to undo.
    assert.equal(useAppStore.temporal.getState().pastStates.length, 0);
  });

  it("turns Identify off, which would hide the comparison", () => {
    store().selectLayer(layerId);
    store().selectFeatures(["a"]);
    store().setIdentifyLayer(layerId);
    assert.equal(pinSelectedFeature(), true);
    assert.equal(store().identifyLayerId, null);
  });

  it("pins nothing unless exactly one feature is selected", () => {
    store().selectLayer(layerId);
    assert.equal(pinSelectedFeature(), false);
    store().selectFeatures(["a", "b"]);
    assert.equal(pinSelectedFeature(), false);
    assert.equal(store().comparePin, null);
  });

  it("is cleared with its layer, and kept when another layer goes", () => {
    const other = store().addGeoJsonLayer("Roads", parcels);
    store().setComparePin({ layerId, featureId: "a", properties: {} });
    store().removeLayer(other);
    assert.equal(store().comparePin?.layerId, layerId);
    store().removeLayer(layerId);
    assert.equal(store().comparePin, null);
  });

  it("is cleared when its layer's group is deleted with its layers", () => {
    const groupId = store().addLayerGroup("Lots", [layerId]);
    store().setComparePin({ layerId, featureId: "a", properties: {} });
    store().removeLayerGroup(groupId);
    assert.equal(store().comparePin?.layerId, layerId, "ungrouping keeps the layer");
    const regrouped = store().addLayerGroup("Lots", [layerId]);
    store().removeLayerGroup(regrouped, { removeChildren: true });
    assert.equal(store().comparePin, null);
  });

  it("records the matched feature's id when a stale id is selected too", () => {
    store().selectLayer(layerId);
    store().selectFeatures(["gone", "b"]);
    assert.equal(pinSelectedFeature(), true);
    assert.equal(store().comparePin?.featureId, "b");
  });

  it("is cleared when undo removes its layer, and stays cleared on redo", () => {
    const added = store().addGeoJsonLayer("Roads", parcels);
    store().setComparePin({ layerId: added, featureId: "a", properties: {} });
    undo();
    assert.equal(
      store().layers.some((layer) => layer.id === added),
      false,
    );
    assert.equal(store().comparePin, null);
    redo();
    assert.equal(
      store().layers.some((layer) => layer.id === added),
      true,
    );
    assert.equal(store().comparePin, null);
  });

  it("is cleared by a new project", () => {
    store().setComparePin({ layerId, featureId: "a", properties: {} });
    store().newProject({ name: "next" });
    assert.equal(store().comparePin, null);
  });
});
