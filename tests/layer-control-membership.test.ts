import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import type { GeoLibreLayer } from "@geolibre/core";
import type { CustomLayerAdapter } from "maplibre-gl-layer-control";
import {
  LayerControlHost,
  type LayerControlHostAdapter,
} from "../packages/map/src/layer-control-host";
import { geojsonLayer } from "./helpers/layer-fixtures";
import { MapController } from "../packages/map/src/map-controller";

it("lists all 85 project layers before any native style layer is mounted", () => {
  const layers = Array.from({ length: 85 }, (_, index) =>
    geojsonLayer({ id: `layer-${index}`, name: `Layer ${index}`, visible: false }),
  );
  const adapter: LayerControlHostAdapter = {
    getMap: () => ({
      getLayer: () => undefined,
      getStyle: () => ({ layers: [] }),
      getSource: () => undefined,
      getContainer: () => document.createElement("div"),
    }),
    addControl: () => {},
    removeControl: () => {},
    getLayers: () => layers,
    getNativeLayerIds: () => [],
    getCandidateNativeLayerIds: (layer) => [`native-${layer.id}`],
    getSourceIds: () => [],
    excludedLayerIds: [],
    getBasemapStyleUrl: () => null,
    getBasemapLayerIds: () => [],
    getBasemapState: () => ({ visible: true, opacity: 1 }),
  };
  const host = new LayerControlHost(adapter);
  const config = (
    host as unknown as {
      createConfig: (layers: GeoLibreLayer[]) => { customLayerAdapters?: CustomLayerAdapter[] };
    }
  ).createConfig(layers);
  const controlAdapter = config.customLayerAdapters?.[0];
  assert.ok(controlAdapter);
  assert.deepEqual(
    controlAdapter.getLayerIds(),
    layers.map((layer) => layer.id),
  );
  assert.equal(controlAdapter.getLayerState("layer-0")?.visible, false);
  assert.equal(controlAdapter.getLayerState("layer-84")?.name, "Layer 84");
});

it("mounts one row per project layer, mapped or not, top-most first", () => {
  const { window } = parseHTML('<div id="map"><div class="maplibregl-ctrl-top-right"></div></div>');
  const globals = globalThis as { document?: unknown; window?: unknown };
  const previous = { document: globals.document, window: globals.window };
  globals.document = window.document;
  globals.window = window;
  try {
    const container = window.document.getElementById("map")!;
    // Even layers have a mounted native style layer; odd ones are hidden or
    // still loading and have none yet.
    const layers = Array.from({ length: 85 }, (_, index) =>
      geojsonLayer({ id: `layer-${index}`, name: `Layer ${index}`, visible: index % 2 === 0 }),
    );
    const isMapped = (layer: GeoLibreLayer) => Number(layer.id.slice(6)) % 2 === 0;
    const styleLayers = layers
      .filter(isMapped)
      .map((layer) => ({ id: `native-${layer.id}`, type: "circle", source: layer.id }));
    const map = {
      getLayer: (id: string) => styleLayers.find((layer) => layer.id === id),
      getStyle: () => ({ version: 8, sources: {}, layers: styleLayers }),
      getSource: () => undefined,
      getContainer: () => container,
      getLayoutProperty: () => undefined,
      getPaintProperty: () => undefined,
      on: () => {},
      off: () => {},
    };
    let mounted: { onRemove?: (map: unknown) => void } | null = null;
    const adapter: LayerControlHostAdapter = {
      getMap: () => map,
      addControl: (control) => {
        mounted = control as typeof mounted;
        container.firstElementChild!.appendChild(control.onAdd(map as never));
      },
      removeControl: (control) => {
        control.onRemove?.(map as never);
      },
      getLayers: () => layers,
      getNativeLayerIds: (layer) => (isMapped(layer) ? [`native-${layer.id}`] : []),
      getCandidateNativeLayerIds: (layer) => [`native-${layer.id}`],
      getSourceIds: () => [],
      excludedLayerIds: [],
      getBasemapStyleUrl: () => null,
      getBasemapLayerIds: () => [],
      getBasemapState: () => ({ visible: true, opacity: 1 }),
    };
    const host = new LayerControlHost(adapter);
    assert.equal(host.add("top-right"), true);
    assert.ok(mounted);
    const originalControl = mounted;
    // The engine mounts this control before lazy default-plugin activation.
    // Enabling it again must report success without creating a second control.
    const controller = new MapController();
    Object.assign(controller, { map, layerControlHost: host });
    assert.equal(controller.setBuiltInControlVisible("layer-control", true), true);
    assert.equal(mounted, originalControl);
    const rows = Array.from(container.querySelectorAll(".layer-control-item"))
      .map((item) => item.getAttribute("data-layer-id"))
      .filter((id) => id !== "Background");
    // The panel lists the top-most layer first; the store is bottom-to-top.
    assert.deepEqual(rows, layers.map((layer) => layer.id).reverse());
    host.destroy();
  } finally {
    globals.document = previous.document;
    globals.window = previous.window;
  }
});

it("keeps project layers out of the basemap when the basemap has no root layers", () => {
  // A style whose basemap lives in imports (Mapbox Standard) reports no basemap
  // layer ids. The control must honour that empty list rather than treating
  // every layer on the map at mount as basemap, or the Background toggle would
  // hide GeoLibre's own layers.
  const { window } = parseHTML('<div id="map"><div class="maplibregl-ctrl-top-right"></div></div>');
  const globals = globalThis as { document?: unknown; window?: unknown };
  const previous = { document: globals.document, window: globals.window };
  globals.document = window.document;
  globals.window = window;
  try {
    const container = window.document.getElementById("map")!;
    const layers = [geojsonLayer({ id: "roads", name: "Roads" })];
    const styleLayers = [{ id: "native-roads", type: "line", source: "roads" }];
    const map = {
      getLayer: (id: string) => styleLayers.find((layer) => layer.id === id),
      getStyle: () => ({ version: 8, sources: { roads: {} }, layers: styleLayers }),
      getSource: () => undefined,
      getContainer: () => container,
      getLayoutProperty: () => "visible",
      getPaintProperty: () => undefined,
      on: () => {},
      off: () => {},
    };
    let mounted: { getBackgroundLayerVisibility(): Record<string, boolean> } | null = null;
    const adapter: LayerControlHostAdapter = {
      getMap: () => map,
      addControl: (control) => {
        mounted = control as unknown as typeof mounted;
        container.firstElementChild!.appendChild(control.onAdd(map as never));
      },
      removeControl: (control) => {
        control.onRemove?.(map as never);
      },
      getLayers: () => layers,
      getNativeLayerIds: () => ["native-roads"],
      getCandidateNativeLayerIds: () => ["native-roads"],
      getSourceIds: () => ["roads"],
      excludedLayerIds: [],
      getBasemapStyleUrl: () => null,
      getBasemapLayerIds: () => [],
      getBasemapState: () => ({ visible: false, opacity: 0.5 }),
    };
    const host = new LayerControlHost(adapter);
    assert.equal(host.add("top-right"), true);
    host.syncState();
    const control = mounted as unknown as {
      getBackgroundLayerVisibility(): Record<string, boolean>;
    };
    assert.deepEqual(Object.keys(control.getBackgroundLayerVisibility()), []);
    // GeoLibre still gets a Background row to drive its basemap from.
    const background = container.querySelector<HTMLElement>(
      '.layer-control-item[data-layer-id="Background"] .layer-control-checkbox',
    ) as HTMLInputElement | null;
    assert.ok(background, "the host adds a Background row");
    assert.equal(background.checked, false);
    host.destroy();
  } finally {
    globals.document = previous.document;
    globals.window = previous.window;
  }
});
