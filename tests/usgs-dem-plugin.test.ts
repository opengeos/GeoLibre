import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";

const installDom = () => {
  const { document, window } = parseHTML("<html><body></body></html>");
  class TestCustomEvent<T = unknown> extends Event {
    detail: T;
    constructor(type: string, init?: CustomEventInit<T>) {
      super(type);
      this.detail = init?.detail as T;
    }
  }
  Object.assign(globalThis, {
    document,
    window,
    CustomEvent: TestCustomEvent,
    CSS: { escape: (value: string) => value },
  });
  return { document, window };
};

installDom();

import {
  DEFAULT_USGS_DEM_LABELS,
  maplibreUsgsDemPlugin,
  setUsgsDemLabels,
  USGS_DEM_PLUGIN_ID,
} from "../packages/plugins/src/plugins/maplibre-usgs-dem";
import { WEB_SERVICE_PLUGIN_IDS } from "../packages/plugins/src/plugins/web-service-sync";
import { pluginTier } from "../apps/geolibre-desktop/src/lib/ui-profile";
import type { GeoLibreAppAPI, GeoLibreRightPanelRegistration } from "../packages/plugins/src/types";

describe("USGS 3DEP built-in plugin", () => {
  it("is registered as an advanced Web Services plugin", () => {
    assert.equal(USGS_DEM_PLUGIN_ID, "maplibre-gl-usgs-dem");
    assert.equal(maplibreUsgsDemPlugin.id, USGS_DEM_PLUGIN_ID);
    assert.equal(maplibreUsgsDemPlugin.name, "USGS 3DEP");
    assert.ok(WEB_SERVICE_PLUGIN_IDS.includes(USGS_DEM_PLUGIN_ID));
    assert.equal(pluginTier(USGS_DEM_PLUGIN_ID), "advanced");
  });

  it("activates, registers its right panel, and opens it in the host application", () => {
    let panelRegistered = false;
    // `as`, not an annotation: the fake assigns it in a callback TS cannot follow.
    let panelOptions = null as GeoLibreRightPanelRegistration | null;
    let unregisterCalled = false;
    let openRightPanelCalledWith: string | null = null;
    let closeRightPanelCalledWith: string | null = null;

    const mockApp = {
      getMap: () => ({
        getSource: () => null,
        getLayer: () => null,
        addSource: () => {},
        addLayer: () => {},
        removeLayer: () => {},
        removeSource: () => {},
        on: () => {},
        off: () => {},
      }),
      registerRightPanel: (opts: GeoLibreRightPanelRegistration) => {
        panelRegistered = true;
        panelOptions = opts;
        return () => {
          unregisterCalled = true;
        };
      },
      openRightPanel: (id: string) => {
        openRightPanelCalledWith = id;
      },
      closeRightPanel: (id: string) => {
        closeRightPanelCalledWith = id;
      },
      unregisterExternalNativeLayer: () => {},
    } as unknown as GeoLibreAppAPI;

    maplibreUsgsDemPlugin.activate(mockApp);
    assert.equal(panelRegistered, true);
    assert.equal(panelOptions?.id, USGS_DEM_PLUGIN_ID);
    assert.equal(panelOptions?.dock, "replace-style");
    assert.equal(openRightPanelCalledWith, USGS_DEM_PLUGIN_ID);

    // Test render container mount
    const container = document.createElement("div");
    const cleanup = panelOptions?.render(container);
    assert.ok(
      container.querySelector(".geolibre-usgs-dem-panel") ||
        container.classList.contains("geolibre-usgs-dem-panel"),
    );
    if (typeof cleanup === "function") cleanup();

    maplibreUsgsDemPlugin.deactivate?.(mockApp);
    assert.equal(unregisterCalled, true);
    assert.equal(closeRightPanelCalledWith, USGS_DEM_PLUGIN_ID);
  });

  it("binds its footprint handlers on the control map when there is no MapLibre map", () => {
    const bound = new Map<string, unknown>();
    const controlMap = {
      getSource: () => null,
      getLayer: () => null,
      addSource: () => {},
      addLayer: () => {},
      removeLayer: () => {},
      removeSource: () => {},
      on: (type: string, layerId: string, fn: unknown) => bound.set(`${type}:${layerId}`, fn),
      off: (type: string, layerId: string, fn: unknown) => {
        if (bound.get(`${type}:${layerId}`) === fn) bound.delete(`${type}:${layerId}`);
      },
    };
    const app = {
      getMap: () => null,
      getCesiumControlMap: () => controlMap,
      registerRightPanel: () => () => {},
    } as unknown as GeoLibreAppAPI;

    maplibreUsgsDemPlugin.activate(app);
    assert.deepEqual([...bound.keys()].sort(), [
      "click:geolibre-usgs-dem-footprints-fill",
      "mouseenter:geolibre-usgs-dem-footprints-fill",
      "mouseleave:geolibre-usgs-dem-footprints-fill",
    ]);
    maplibreUsgsDemPlugin.deactivate?.(app);
    assert.equal(bound.size, 0, "deactivate unbinds from the map it bound to");
  });

  it("supports updating localized labels dynamically", () => {
    // `as`, not an annotation: the fake assigns it in a callback TS cannot follow.
    let panelOptions = null as GeoLibreRightPanelRegistration | null;
    const mockApp = {
      registerRightPanel: (opts: GeoLibreRightPanelRegistration) => {
        panelOptions = opts;
        return () => {};
      },
    } as unknown as GeoLibreAppAPI;
    maplibreUsgsDemPlugin.activate(mockApp);
    const container = document.createElement("div");
    const cleanup = panelOptions?.render(container);
    try {
      setUsgsDemLabels({ title: "Custom DEM Title", search: "Find Elev" });
      const title = panelOptions?.title;
      assert.equal(typeof title === "function" ? title() : title, "Custom DEM Title");
      assert.equal(container.querySelector("h3")?.textContent, "Custom DEM Title");
    } finally {
      setUsgsDemLabels(DEFAULT_USGS_DEM_LABELS);
      if (typeof cleanup === "function") cleanup();
      maplibreUsgsDemPlugin.deactivate?.(mockApp);
    }
  });

  it("shows example coordinates as placeholders and keeps typed input across a relabel", () => {
    // `as`, not an annotation: the fake assigns it in a callback TS cannot follow.
    let panelOptions = null as GeoLibreRightPanelRegistration | null;
    const mockApp = {
      registerRightPanel: (opts: GeoLibreRightPanelRegistration) => {
        panelOptions = opts;
        return () => {};
      },
    } as unknown as GeoLibreAppAPI;
    maplibreUsgsDemPlugin.activate(mockApp);
    const container = document.createElement("div");
    const cleanup = panelOptions?.render(container);
    try {
      const coordsTab = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === DEFAULT_USGS_DEM_LABELS.modeBbox,
      );
      assert.ok(coordsTab);
      coordsTab.click();
      const west = container.querySelector("input[type=text]") as HTMLInputElement;
      assert.equal(west.value, "");
      assert.equal(west.placeholder, "-122.5");
      west.value = "-120";
      west.dispatchEvent(new (window.Event as typeof Event)("input"));

      setUsgsDemLabels({ title: "Relabeled" });
      const remounted = container.querySelector("input[type=text]") as HTMLInputElement;
      assert.notEqual(remounted, west);
      assert.equal(remounted.value, "-120");
    } finally {
      setUsgsDemLabels(DEFAULT_USGS_DEM_LABELS);
      if (typeof cleanup === "function") cleanup();
      maplibreUsgsDemPlugin.deactivate?.(mockApp);
    }
  });
});
