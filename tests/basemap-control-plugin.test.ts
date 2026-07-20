import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import {
  BASEMAP_CONTROL_PLUGIN_ID,
  maplibreBasemapControlPlugin as plugin,
} from "../packages/plugins/src/plugins/maplibre-basemap-control";
import {
  getActiveBasemapControl,
  maplibreBasemapControlRuntime,
} from "../packages/map/src/maplibre-runtime/basemap-control";
import type { MapEngineExtensionMap } from "../packages/map/src/engine/extensions";
import type { MapEngineClient } from "../packages/map/src/engine/types";
import type { MapLibreHostedRuntimeContext } from "../packages/map/src/maplibre-runtime/types";
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
 * Route the renderer-neutral descriptor's engine commands into the adapter
 * runtime with a fake private control host. This deliberately gives the plugin
 * no `getMap`/native-control escape hatch.
 */
function fakeApp(): GeoLibreAppAPI {
  const context: MapLibreHostedRuntimeContext = {
    client: {} as MapEngineClient,
    addControl: () => true,
    removeControl: () => undefined,
  };
  return {
    map: {
      invoke: (command: string, input: unknown) => {
        if (command === "hosted-plugin.activate") {
          return maplibreBasemapControlRuntime.activate(
            context,
            input as MapEngineExtensionMap["hosted-plugin.activate"]["input"],
          );
        }
        if (command === "hosted-plugin.deactivate") {
          maplibreBasemapControlRuntime.deactivate?.(context);
          return undefined;
        }
        if (command === "hosted-plugin.set-position") {
          const position = (input as MapEngineExtensionMap["hosted-plugin.set-position"]["input"])
            .position;
          return maplibreBasemapControlRuntime.setPosition?.(context, position) ?? false;
        }
        return undefined;
      },
    } as unknown as MapEngineClient,
  } as GeoLibreAppAPI;
}

function deactivateRuntime(): void {
  if (getActiveBasemapControl()) {
    maplibreBasemapControlRuntime.deactivate?.({
      client: {} as MapEngineClient,
      removeControl: () => undefined,
    });
  }
}

describe("maplibreBasemapControlPlugin lifecycle", () => {
  beforeEach(() => {
    useAppStore.setState({ layers: [] });
  });

  afterEach(() => {
    // Tear the control down so module-level state never leaks between tests.
    deactivateRuntime();
    useAppStore.setState({ layers: [] });
  });

  it("has the exported id", () => {
    assert.equal(plugin.id, BASEMAP_CONTROL_PLUGIN_ID);
  });

  it("keeps stacked raster basemaps in the store when deactivated", () => {
    useAppStore.getState().addLayer(stackedRasterBasemap("google-satellite"));
    const app = fakeApp();

    plugin.activate(app);
    plugin.deactivate?.(app);

    // The layer survives the adapter-runtime teardown.
    assert.equal(
      useAppStore
        .getState()
        .layers.filter((l) => l.metadata?.sourceKind === "maplibre-basemap-control").length,
      1,
    );
  });

  it("relinks and highlights restored rasters on reactivation", () => {
    useAppStore.getState().addLayer(stackedRasterBasemap("google-satellite"));
    const app = fakeApp();

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
