import assert from "node:assert/strict";
import { it } from "node:test";
import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import {
  applyTimeSliderConfig,
  provideTimeSliderRuntime,
} from "../packages/plugins/src/time-slider-state";

for (const change of ["none", "project", "renderer"] as const) {
  it(`${change === "none" ? "applies" : "rejects"} a timeline handoff after ${change} changes during activation`, async () => {
    let applied = 0;
    let renderer: "maplibre" | "mapbox" = "maplibre";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provideTimeSliderRuntime({
      getActiveTimeSliderControl: () => null,
      applyTimeSliderConfig: async () => {
        applied++;
        return true;
      },
    });
    const app = {
      getMapRenderer: () => renderer,
      activatePlugin: async () => {
        await gate;
        return true;
      },
    } as unknown as GeoLibreAppAPI;
    const pending = applyTimeSliderConfig(app, () => {
      throw new Error("The runtime owns config construction.");
    });
    if (change === "project")
      useAppStore.setState({ projectGeneration: useAppStore.getState().projectGeneration + 1 });
    if (change === "renderer") renderer = "mapbox";
    release();
    assert.equal(await pending, change === "none");
    assert.equal(applied, change === "none" ? 1 : 0);
  });
}
