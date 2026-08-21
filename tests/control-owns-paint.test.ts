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
  it("waits for maplibre-gl-vector to restore its own source and layers", () => {
    const { map, calls } = makeMapStub("some-other-layer", "circle");
    const layer = externalNativeLayer({
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "Point", coordinates: [0, 0] },
          },
        ],
      },
      metadata: {
        // Every store layer the control creates carries customLayerType, so
        // the fixture must too: without it the layer takes a branch of
        // syncExternalNativeLayer that no real control layer reaches.
        customLayerType: "circle",
        externalNativeLayer: true,
        nativeLayerIds: ["mub-deliveries-circle"],
        sourceIds: ["mub-deliveries-source"],
        sourceKind: "maplibre-gl-vector",
        controlOwnsPaint: true,
      },
    });

    syncLayer(map as never, layer);

    assert.ok(
      !calls.some((call) => call.method === "addSource" || call.method === "addLayer"),
      "expected the host not to race the control's style-load restoration",
    );
  });

  it("waits through the window where the control has cleared its layer ids", () => {
    // Mid-restore the control empties its record's layerIds and awaits a
    // re-read of the source data, and the store mirrors that empty list. The
    // layer must still be recognized as the control's, or the ordinary GeoJSON
    // path rebuilds it underneath the one the control is about to restore
    // (opengeos/GeoLibre#1902).
    const { map, calls } = makeMapStub("some-other-layer", "circle");
    const layer = externalNativeLayer({
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "Point", coordinates: [0, 0] },
          },
        ],
      },
      metadata: {
        customLayerType: "circle",
        externalNativeLayer: true,
        nativeLayerIds: [],
        sourceIds: [],
        sourceKind: "maplibre-gl-vector",
        controlOwnsPaint: true,
      },
    });

    syncLayer(map as never, layer);

    assert.ok(
      !calls.some((call) => call.method === "addSource" || call.method === "addLayer"),
      "expected no duplicate source or layer while the control's ids are empty",
    );
  });

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

// A store layer can outlive its map layers: restore now keeps a layer whose
// replay failed (opengeos/GeoLibre discussion #1757), and its saved
// `nativeLayerIds` still name layers the control never recreated. Styling those
// raises "Cannot get style of non-existing layer" on the map's error channel,
// which floods the Diagnostics panel with entries the user cannot act on.
describe("external native layers whose map layers are missing", () => {
  it("touches nothing when the native layer is not on the map", () => {
    // The stub only knows "some-other-layer", so getLayer("mub-deliveries")
    // returns undefined, standing in for a failed restore.
    const { map, calls } = makeMapStub("some-other-layer", "circle");

    assert.doesNotThrow(() => syncLayer(map as never, externalNativeLayer()));

    assert.deepEqual(
      calls.map((call) => call.method),
      [],
      "expected no style, visibility, or ordering calls against a layer that is not on the map",
    );
  });

  it("still syncs the layers that are present alongside a missing one", () => {
    const { map, calls } = makeMapStub("mub-deliveries", "circle");
    const layer = externalNativeLayer({
      metadata: {
        externalNativeLayer: true,
        // The first id is stale; only the second exists on the map.
        nativeLayerIds: ["mub-deliveries-gone", "mub-deliveries"],
        sourceIds: ["mub-deliveries"],
      },
    });

    syncLayer(map as never, layer);

    const touched = calls.flatMap((call) =>
      typeof call.args[0] === "string" ? [call.args[0]] : [],
    );
    assert.ok(touched.includes("mub-deliveries"), "expected the present layer to still be synced");
    assert.ok(
      !touched.includes("mub-deliveries-gone"),
      "expected the missing layer to be skipped rather than dropping the whole sync",
    );
  });
});
