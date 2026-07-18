import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { setExternalDeckLayerOrderHandler, syncLayer } from "../packages/map/src/layer-sync";

// A deck.gl raster (maplibre-gl-raster COG) registers as an external custom
// layer but has no real MapLibre style layer to move, so layer-sync forwards
// the computed beforeId to a handler that pushes it into the owning control.

function makeMapStub() {
  const map = {
    getStyle: () => ({ layers: [{ id: "vector-line", type: "line" }] }),
    getLayer: (id: string) => (id === "vector-line" ? { id, type: "line" } : undefined),
    getSource: () => undefined,
    setLayoutProperty: () => {},
    setPaintProperty: () => {},
    moveLayer: () => {},
    removeLayer: () => {},
    addLayer: () => {},
    addSource: () => {},
  };
  return map;
}

function rasterDeckLayer(): GeoLibreLayer {
  return {
    id: "raster-1",
    name: "cog.tif",
    type: "cog",
    source: { type: "raster" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "raster",
      externalDeckLayer: true,
      externalNativeLayer: true,
      nativeLayerIds: ["raster-1"],
      sourceIds: [],
    },
  };
}

afterEach(() => setExternalDeckLayerOrderHandler(null));

describe("external deck-layer order handler", () => {
  it("forwards the computed beforeId for a deck raster layer", () => {
    const calls: Array<[string, string | undefined]> = [];
    setExternalDeckLayerOrderHandler((id, beforeId) => calls.push([id, beforeId]));

    syncLayer(makeMapStub() as never, rasterDeckLayer(), "vector-line");

    assert.deepEqual(calls, [["raster-1", "vector-line"]]);
  });

  it("forwards undefined when the raster is on top (no beforeId)", () => {
    const calls: Array<[string, string | undefined]> = [];
    setExternalDeckLayerOrderHandler((id, beforeId) => calls.push([id, beforeId]));

    syncLayer(makeMapStub() as never, rasterDeckLayer());

    assert.deepEqual(calls, [["raster-1", undefined]]);
  });

  it("does not fire for a non-deck external custom layer", () => {
    const calls: unknown[] = [];
    setExternalDeckLayerOrderHandler((id, beforeId) => calls.push([id, beforeId]));

    const layer = rasterDeckLayer();
    // A 3D-tiles-style custom layer is external custom but not a deck raster.
    layer.metadata = {
      customLayerType: "3d-tiles",
      externalNativeLayer: true,
      nativeLayerIds: ["raster-1"],
      sourceIds: [],
    };
    syncLayer(makeMapStub() as never, layer, "vector-line");

    assert.deepEqual(calls, []);
  });
});
