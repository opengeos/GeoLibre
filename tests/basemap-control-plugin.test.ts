import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import {
  BASEMAP_CONTROL_PLUGIN_ID,
  getActiveBasemapControl,
  maplibreBasemapControlPlugin as plugin,
} from "../packages/plugins/src/plugins/maplibre-basemap-control";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

/** A raster basemap layer as the control leaves it in the store when stacked. */
function stackedRasterBasemap(basemapId: string): GeoLibreLayer {
  return {
    id: `basemap-${basemapId}`,
    name: basemapId,
    type: "raster",
    source: { type: "raster", tiles: [`https://example.com/${basemapId}.png`] },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: { sourceKind: "maplibre-basemap-control", basemapId },
  };
}

/**
 * A fake app that records every unregisterExternalNativeLayer call and mirrors
 * the real one (which removes the store layer), so a test can assert whether
 * deactivate wiped the stacked basemaps or left them alone.
 */
function fakeApp(unregistered: string[]): GeoLibreAppAPI {
  return {
    getMap: () => ({}),
    addMapControl: () => true,
    removeMapControl: () => {},
    getActiveBasemap: () => "https://tiles.openfreemap.org/styles/liberty",
    unregisterExternalNativeLayer: (id: string) => {
      unregistered.push(id);
      useAppStore.getState().removeLayer(id);
    },
  } as unknown as GeoLibreAppAPI;
}

describe("maplibreBasemapControlPlugin lifecycle", () => {
  beforeEach(() => {
    useAppStore.setState({ layers: [] });
  });

  afterEach(() => {
    // Tear the control down so module-level state never leaks between tests.
    if (getActiveBasemapControl()) plugin.deactivate?.(fakeApp([]));
    useAppStore.setState({ layers: [] });
  });

  it("has the exported id", () => {
    assert.equal(plugin.id, BASEMAP_CONTROL_PLUGIN_ID);
  });

  it("keeps stacked raster basemaps in the store when deactivated", () => {
    useAppStore.getState().addLayer(stackedRasterBasemap("google-satellite"));
    const unregistered: string[] = [];
    const app = fakeApp(unregistered);

    plugin.activate(app);
    plugin.deactivate?.(app);

    // The layer survives and nothing was unregistered/removed.
    assert.deepEqual(unregistered, []);
    assert.equal(
      useAppStore
        .getState()
        .layers.filter((l) => l.metadata?.sourceKind === "maplibre-basemap-control").length,
      1,
    );
  });

  it("relinks and highlights restored rasters on reactivation", () => {
    useAppStore.getState().addLayer(stackedRasterBasemap("google-satellite"));
    const app = fakeApp([]);

    plugin.activate(app);
    plugin.deactivate?.(app);
    plugin.activate(app);

    const control = getActiveBasemapControl();
    assert.ok(control, "control should be active after reactivation");
    const state = control.getState();
    // The reopened panel highlights the restored raster (not just the style
    // basemap) and is back in overlay/stack mode.
    assert.ok(state.activeBasemapIds.includes("google-satellite"));
    assert.equal(state.allowMultiple, true);
  });
});
