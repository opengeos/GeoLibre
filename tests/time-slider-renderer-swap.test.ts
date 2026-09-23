import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getActiveTimeSliderControl,
  maplibreTimeSliderPlugin,
} from "../packages/plugins/src/plugins/maplibre-time-slider";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// A renderer swap tears the whole map down, which removes the dock control
// (its onRemove destroys the adapters its sources are read from) before the
// plugin manager deactivates the plugin. The config must be captured as the
// control is removed, or the user's stack does not survive the swap (#2475).
describe("Time Slider across a renderer swap", () => {
  it("keeps the sources its map removed", () => {
    const controls: unknown[] = [];
    const host = {
      addMapControl: (control: unknown) => {
        controls.push(control);
        return true;
      },
      removeMapControl: () => {},
      getMapRenderer: () => "maplibre",
    } as unknown as GeoLibreAppAPI;
    assert.notEqual(maplibreTimeSliderPlugin.activate(host), false);
    const control = getActiveTimeSliderControl()!;
    assert.ok(control);
    const live = control.getConfig();
    const source = { id: "landsat", type: "cog", url: "https://example.com/{date}.tif" };
    // While attached, the control reports its live sources...
    control.getConfig = () => ({ ...live, sources: [source] }) as never;
    // ...then its map removes it, destroying the adapters it reads them from.
    control.onRemove();
    control.getConfig = () => ({ ...live, sources: [] }) as never;

    const state = maplibreTimeSliderPlugin.getProjectState?.() as { sources: unknown[] };
    assert.deepEqual(state.sources, [source]);
    maplibreTimeSliderPlugin.deactivate(host);
    const saved = maplibreTimeSliderPlugin.getProjectState?.() as { sources: unknown[] };
    assert.deepEqual(saved.sources, [source]);
  });
});
