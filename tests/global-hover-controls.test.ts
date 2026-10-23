import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { projectFromStore, useAppStore } from "@geolibre/core";
import { setHistoryCoalesceMs } from "../packages/core/src/history";

const emptyFC = { type: "FeatureCollection" as const, features: [] };
const state = () => useAppStore.getState();

describe("global hover controls", () => {
  beforeEach(() => {
    setHistoryCoalesceMs(0);
    state().newProject({ name: "Hover controls" });
    const id = state().addGeoJsonLayer("First", emptyFC);
    state().setLayerPopup(id, {
      hover: true,
      click: false,
      fields: [{ field: "distance_km", hover: true }],
    });
    state().loadProject(projectFromStore(state()));
    useAppStore.temporal.getState().clear();
  });

  it("temporarily hides hovers without editing the project or undo history", () => {
    state().setHoverTooltipsEnabled(false);
    assert.equal(state().hoverTooltipsEnabled, false);
    assert.equal(state().layers[0].popup?.hover, true);
    assert.equal(state().isDirty, false);
    assert.equal(useAppStore.temporal.getState().pastStates.length, 0);
    state().setHoverTooltipsEnabled(true);
    assert.equal(state().layers[0].popup?.hover, true);
  });

  it("resets the temporary switch when a project opens", () => {
    state().setHoverTooltipsEnabled(false);
    state().newProject({ name: "Next" });
    assert.equal(state().hoverTooltipsEnabled, true);
    state().setHoverTooltipsEnabled(false);
    state().loadProject(projectFromStore(state()));
    assert.equal(state().hoverTooltipsEnabled, true);
  });
});
