import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";

describe("map view store synchronization", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "map view reset" });
  });

  it("does not notify subscribers for an equal programmatic camera echo", () => {
    const initialView = useAppStore.getState().mapView;
    let notifications = 0;
    const unsubscribe = useAppStore.subscribe(() => {
      notifications++;
    });

    useAppStore.getState().setMapView({ ...initialView });
    unsubscribe();

    assert.equal(useAppStore.getState().mapView, initialView);
    assert.equal(notifications, 0);
  });

  it("still marks the project dirty when an equal camera write requests it", () => {
    const initialView = useAppStore.getState().mapView;
    assert.equal(useAppStore.getState().isDirty, false);

    useAppStore.getState().setMapView({ ...initialView }, true);

    assert.equal(useAppStore.getState().mapView, initialView);
    assert.equal(useAppStore.getState().isDirty, true);
  });
});
