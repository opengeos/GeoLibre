import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import {
  BASEMAP_CONTROL_PLUGIN_ID,
  getActiveBasemapControl,
  maplibreBasemapControlPlugin as plugin,
} from "../packages/plugins/src/plugins/maplibre-basemap-control";
import { isPluginEngineSupported } from "../packages/plugins/src/types";
import type { GeoLibreAppAPI, GeoLibreRightPanelRegistration } from "../packages/plugins/src/types";

// The docked panel mounts the control's real DOM, so give the plugin a
// minimal document for the duration of this file.
const dom = parseHTML("<html><body></body></html>");
const globals = globalThis as unknown as Record<string, unknown>;
for (const key of ["document", "window", "HTMLElement", "Event"]) {
  if (globals[key] === undefined) {
    globals[key] =
      key === "window"
        ? dom.window
        : ((dom as unknown as Record<string, unknown>)[key] ??
          (dom.window as unknown as Record<string, unknown>)[key]);
  }
}
// linkedom has no <select> value setter; the panel's filters use one.
const selectProto = (dom.window as unknown as { HTMLSelectElement: { prototype: object } })
  .HTMLSelectElement.prototype;
Object.defineProperty(selectProto, "value", {
  configurable: true,
  get(this: Element) {
    return this.getAttribute("data-test-value") ?? "";
  },
  set(this: Element, value: unknown) {
    this.setAttribute("data-test-value", String(value));
  },
});
globals.requestAnimationFrame ??= (callback: () => void) => setTimeout(callback, 0);
globals.MutationObserver ??= class {
  observe() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
};
globals.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
  unobserve() {}
};

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
  const container = dom.document.createElement("div");
  const map = {
    getContainer: () => container,
    on: () => {},
    off: () => {},
    once: () => {},
  };
  const panels = new Map<string, GeoLibreRightPanelRegistration>();
  const cleanups = new Map<string, () => void>();
  return {
    getMap: () => map,
    registerRightPanel: (registration: GeoLibreRightPanelRegistration) => {
      panels.set(registration.id, registration);
      return () => panels.delete(registration.id);
    },
    openRightPanel: (id: string) => {
      const cleanup = panels.get(id)?.render(dom.document.createElement("div"));
      if (typeof cleanup === "function") cleanups.set(id, cleanup);
      return panels.has(id);
    },
    closeRightPanel: (id: string) => {
      cleanups.get(id)?.();
      cleanups.delete(id);
    },
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

describe("Mapbox basemap control", () => {
  it("supports Mapbox and restores its native style selection", () => {
    assert.equal(isPluginEngineSupported(plugin, "mapbox"), true);
    const app = fakeApp([]);
    const mapboxMap = app.getMap() as unknown as NonNullable<
      ReturnType<NonNullable<GeoLibreAppAPI["getMapboxMap"]>>
    >;
    app.getMapboxMap = () => mapboxMap;
    app.getActiveBasemap = () => "mapbox://styles/mapbox/satellite-v9";
    try {
      plugin.activate(app);
      const control = getActiveBasemapControl()!;
      assert.equal(control.getState().activeBasemapId, "mapbox-satellite");
      assert.ok(control.getBasemaps().some((b) => b.id === "mapbox-standard"));
      assert.ok(control.getBasemaps().some((b) => b.id === "openfreemap-liberty"));
    } finally {
      plugin.deactivate?.(app);
    }
  });
});
