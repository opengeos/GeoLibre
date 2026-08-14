import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  clearExternalNativePaintBridge,
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  getExternalNativePaintBridge,
  pluginOwnsPaint,
  setExternalNativePaintBridge,
  supportsBridgedOpacity,
} from "@geolibre/core";
import type { GeoLibreExternalNativeLayerRegistration } from "@geolibre/plugins";
import { removeLayerFromMap, syncLayer } from "../packages/map/src/layer-sync";
import { createExternalNativeStoreLayer } from "../apps/geolibre-desktop/src/lib/external-native-layer";

// A plugin's MapLibre CustomLayerInterface layer has no paint properties, so
// GeoLibre must not offer (or apply) MapLibre paint for it, and the panel's
// generic controls only reach it through the setters the registration supplied
// (opengeos/GeoLibre#1445).

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

function customLayer(id: string, patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id,
    name: "Zarr (plugin rendered)",
    type: "raster",
    source: { type: "raster" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      externalNativeLayer: true,
      nativeLayerIds: [id],
      paintMode: "plugin",
    },
    ...patch,
  };
}

const registration = (
  overrides: Partial<GeoLibreExternalNativeLayerRegistration> = {},
): GeoLibreExternalNativeLayerRegistration => ({
  id: "plugin-zarr",
  name: "Plugin Zarr",
  nativeLayerIds: ["plugin-zarr"],
  ...overrides,
});

// Bridges live in a module-level registry, so a failed assertion must not leak
// one into a later test: clear every id this file registers after each test.
const REGISTERED_BRIDGE_IDS = [
  "bridge-a",
  "bridge-b",
  "bridge-empty",
  "relisted-layer",
  "sync-bridged",
  "sync-rebridged",
  "sync-reuse-id",
];

afterEach(() => {
  for (const id of REGISTERED_BRIDGE_IDS) clearExternalNativePaintBridge(id);
});

describe("plugin-owned paint registration", () => {
  it("records paintMode in the store layer's metadata", () => {
    const layer = createExternalNativeStoreLayer(registration({ paintMode: "plugin" }));
    assert.equal(layer.metadata.paintMode, "plugin");
    assert.equal(pluginOwnsPaint(layer), true);
  });

  it("infers plugin-owned paint from a supplied bridge", () => {
    // A bridge is only meaningful for a layer GeoLibre cannot paint, so it must
    // not require the plugin to also spell out paintMode.
    const layer = createExternalNativeStoreLayer(
      registration({ paintBridge: { setOpacity: () => {} } }),
    );
    assert.equal(layer.metadata.paintMode, "plugin");
  });

  it("leaves an ordinary registration painted by GeoLibre", () => {
    const layer = createExternalNativeStoreLayer(registration());
    assert.equal(layer.metadata.paintMode, undefined);
    assert.equal(pluginOwnsPaint(layer), false);
  });

  it("clears a stale paintMode when a re-registration drops it", () => {
    // registerExternalNativeLayer also drops the bridge, so inheriting the flag
    // would leave the layer plugin-owned with nothing to paint it: every
    // control would be permanently inert.
    const existing = createExternalNativeStoreLayer(registration({ paintMode: "plugin" }));
    const relisted = createExternalNativeStoreLayer(registration(), existing);

    assert.equal(relisted.metadata.paintMode, undefined);
    assert.equal(pluginOwnsPaint(relisted), false);
  });

  it("keeps a paintMode the plugin re-declares through metadata", () => {
    const layer = createExternalNativeStoreLayer(
      registration({ metadata: { paintMode: "plugin" } }),
    );
    assert.equal(pluginOwnsPaint(layer), true);
  });
});

describe("external native paint bridge registry", () => {
  it("reports bridged opacity only when a setter was supplied", () => {
    setExternalNativePaintBridge("bridge-a", { setOpacity: () => {} });
    setExternalNativePaintBridge("bridge-b", { setVisibility: () => {} });

    assert.equal(supportsBridgedOpacity("bridge-a"), true);
    assert.equal(supportsBridgedOpacity("bridge-b"), false);
    assert.equal(supportsBridgedOpacity("bridge-missing"), false);
  });

  it("drops the bridge when a re-registration omits it", () => {
    // How the host mirrors a registration: `registerExternalNativeLayer` passes
    // `registration.paintBridge` straight through, so a re-registration without
    // one must leave nothing behind for the next renderer to inherit.
    setExternalNativePaintBridge("relisted-layer", { setOpacity: () => {} });
    assert.ok(getExternalNativePaintBridge("relisted-layer"));

    const existing = createExternalNativeStoreLayer(
      registration({ id: "relisted-layer", paintMode: "plugin" }),
    );
    setExternalNativePaintBridge("relisted-layer", undefined);
    const relisted = createExternalNativeStoreLayer(
      registration({ id: "relisted-layer" }),
      existing,
    );

    assert.equal(getExternalNativePaintBridge("relisted-layer"), undefined);
    assert.equal(pluginOwnsPaint(relisted), false);
  });

  it("drops a bridge that supplies no setters at all", () => {
    setExternalNativePaintBridge("bridge-empty", {});
    assert.equal(getExternalNativePaintBridge("bridge-empty"), undefined);
  });
});

describe("layer-sync paint bridge", () => {
  it("forwards opacity and visibility to the plugin's setters", () => {
    const opacities: number[] = [];
    const visibilities: boolean[] = [];
    setExternalNativePaintBridge("sync-bridged", {
      setOpacity: (opacity) => opacities.push(opacity),
      setVisibility: (visible) => visibilities.push(visible),
    });

    const { map } = makeMapStub("sync-bridged", "custom");
    syncLayer(map as never, customLayer("sync-bridged", { opacity: 0.4 }));

    assert.deepEqual(opacities, [0.4]);
    assert.deepEqual(visibilities, [true]);

    // A sync pass that changed nothing must not call the setters again: each
    // call typically triggers a WebGL repaint.
    syncLayer(map as never, customLayer("sync-bridged", { opacity: 0.4 }));
    assert.deepEqual(opacities, [0.4]);
    assert.deepEqual(visibilities, [true]);

    syncLayer(map as never, customLayer("sync-bridged", { opacity: 0.2, visible: false }));
    assert.deepEqual(opacities, [0.4, 0.2]);
    assert.deepEqual(visibilities, [true, false]);
  });

  it("re-applies the current values to a freshly registered bridge", () => {
    // A project reload (or unregister → register) installs a new bridge whose
    // renderer has never been told the layer's opacity/visibility, so an
    // unchanged store value must still be pushed once.
    setExternalNativePaintBridge("sync-rebridged", { setOpacity: () => {} });
    const { map } = makeMapStub("sync-rebridged", "custom");
    syncLayer(map as never, customLayer("sync-rebridged", { opacity: 0.5 }));

    const reapplied: number[] = [];
    setExternalNativePaintBridge("sync-rebridged", {
      setOpacity: (opacity) => reapplied.push(opacity),
    });
    syncLayer(map as never, customLayer("sync-rebridged", { opacity: 0.5 }));

    assert.deepEqual(reapplied, [0.5]);
  });

  it("re-applies after removeLayerFromMap when the same layer id is reused", () => {
    // Without clearing appliedBridgeState on remove, a later layer that reuses
    // the id with the same bridge object and opacity would skip the apply.
    // The cache is shared by both setters, so assert visibility too.
    const applied: number[] = [];
    const visibilities: boolean[] = [];
    const bridge = {
      setOpacity: (opacity: number) => {
        applied.push(opacity);
      },
      setVisibility: (visible: boolean) => {
        visibilities.push(visible);
      },
    };
    setExternalNativePaintBridge("sync-reuse-id", bridge);
    const { map } = makeMapStub("sync-reuse-id", "custom");
    const layer = customLayer("sync-reuse-id", { opacity: 0.5 });
    syncLayer(map as never, layer);
    assert.deepEqual(applied, [0.5]);
    assert.deepEqual(visibilities, [true]);

    removeLayerFromMap(map as never, "sync-reuse-id", layer);
    applied.length = 0;
    visibilities.length = 0;
    setExternalNativePaintBridge("sync-reuse-id", bridge);
    syncLayer(map as never, customLayer("sync-reuse-id", { opacity: 0.5 }));
    assert.deepEqual(applied, [0.5]);
    assert.deepEqual(visibilities, [true]);
  });

  it("never writes MapLibre paint for a plugin-painted layer", () => {
    const { map, calls } = makeMapStub("sync-unpainted", "custom");
    syncLayer(map as never, customLayer("sync-unpainted"));

    assert.ok(
      !calls.some((call) => call.method === "setPaintProperty"),
      "expected the plugin's paint to be left untouched",
    );
    // Visibility and ordering are still GeoLibre's to apply: MapLibre honors
    // both on a custom layer.
    assert.ok(calls.some((call) => call.method === "setLayoutProperty"));
    assert.ok(calls.some((call) => call.method === "moveLayer"));
  });

  it("still paints an external native layer that did not opt in", () => {
    const { map, calls } = makeMapStub("sync-painted", "circle");
    const layer = customLayer("sync-painted", {
      type: "geojson",
      source: { type: "geojson" },
      geojson: { type: "FeatureCollection", features: [] },
      metadata: { externalNativeLayer: true, nativeLayerIds: ["sync-painted"] },
    });

    syncLayer(map as never, layer);

    assert.ok(calls.some((call) => call.method === "setPaintProperty"));
  });
});
