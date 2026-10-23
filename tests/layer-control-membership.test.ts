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
