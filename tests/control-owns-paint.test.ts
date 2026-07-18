import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { syncLayer } from "../packages/map/src/layer-sync";

// Records the maplibre calls a layer sync makes so a test can assert which
// native operations ran (visibility/ordering) versus which were skipped (paint).
interface MapCall {
  method: string;
  args: unknown[];
}

function makeMapStub(nativeLayerId: string, nativeType: string) {
  const calls: MapCall[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const map = {
    getStyle: () => ({ layers: [{ id: nativeLayerId, type: nativeType }] }),
    getLayer: (id: string) => (id === nativeLayerId ? { id, type: nativeType } : undefined),
    getSource: () => undefined,
    setLayoutProperty: record("setLayoutProperty"),
    setPaintProperty: record("setPaintProperty"),
    setLayerZoomRange: record("setLayerZoomRange"),
    moveLayer: record("moveLayer"),
    removeLayer: record("removeLayer"),
    addLayer: record("addLayer"),
    addSource: record("addSource"),
  };
  return { map, calls };
}

function externalNativeLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "mub-deliveries",
    name: "Deliveries",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      externalNativeLayer: true,
      nativeLayerIds: ["mub-deliveries"],
      sourceIds: ["mub-deliveries"],
    },
    ...patch,
  };
}

describe("controlOwnsPaint external native layers", () => {
  it("syncs visibility and ordering but never overwrites the control's paint", () => {
    const { map, calls } = makeMapStub("mub-deliveries", "circle");
    const layer = externalNativeLayer({
      visible: false,
      metadata: {
        externalNativeLayer: true,
        nativeLayerIds: ["mub-deliveries"],
        sourceIds: ["mub-deliveries"],
        controlOwnsPaint: true,
      },
    });

    syncLayer(map as never, layer);

    // Visibility is a layout property and must still be applied so the panel's
    // show/hide toggle works.
    const visibility = calls.find((c) => c.method === "setLayoutProperty");
    assert.ok(visibility, "expected visibility to be synced");
    assert.deepEqual(visibility.args, ["mub-deliveries", "visibility", "none"]);

    // Ordering must still be applied so the panel's reorder works.
    assert.ok(
      calls.some((c) => c.method === "moveLayer"),
      "expected layer ordering to be synced",
    );

    // The control owns the paint, so the host must not touch it.
    assert.ok(
      !calls.some((c) => c.method === "setPaintProperty"),
      "expected paint to be left untouched",
    );
  });

  it("still manages a non-default zoom range without touching paint", () => {
    // A distinct id keeps this layer out of the module-level
    // managedZoomRangeLayerIds set the other tests touch.
    const { map, calls } = makeMapStub("mub-zoomed", "circle");
    const layer = externalNativeLayer({
      id: "mub-zoomed",
      style: { ...DEFAULT_LAYER_STYLE, minZoom: 5 },
      metadata: {
        externalNativeLayer: true,
        nativeLayerIds: ["mub-zoomed"],
        sourceIds: ["mub-zoomed"],
        controlOwnsPaint: true,
      },
    });

    syncLayer(map as never, layer);

    assert.ok(
      calls.some((c) => c.method === "setLayerZoomRange"),
      "expected the non-default zoom range to be applied",
    );
    assert.ok(
      !calls.some((c) => c.method === "setPaintProperty"),
      "expected paint to be left untouched",
    );
  });

  it("still rebuilds paint for ordinary external native layers", () => {
    const { map, calls } = makeMapStub("mub-deliveries", "circle");

    syncLayer(map as never, externalNativeLayer());

    assert.ok(
      calls.some((c) => c.method === "setPaintProperty"),
      "expected the host to apply paint when the control does not own it",
    );
  });
});
