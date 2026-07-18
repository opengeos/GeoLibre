import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { GeoLibreExternalNativeLayerRegistration } from "@geolibre/plugins";
import { createExternalNativeStoreLayer } from "../apps/geolibre-desktop/src/lib/external-native-layer";

const baseRegistration = (
  overrides: Partial<GeoLibreExternalNativeLayerRegistration> = {},
): GeoLibreExternalNativeLayerRegistration => ({
  id: "plugin-layer",
  name: "Plugin Layer",
  nativeLayerIds: ["plugin-layer-fill", "plugin-layer-outline"],
  ...overrides,
});

describe("createExternalNativeStoreLayer", () => {
  it("keeps the registration style over an existing default-seeded style", () => {
    // addGeoJsonLayer seeds the layer with the full DEFAULT_LAYER_STYLE before
    // the plugin registers its own colors, so the registration must win.
    const existing: GeoLibreLayer = {
      id: "plugin-layer",
      name: "Plugin Layer",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    };

    const layer = createExternalNativeStoreLayer(
      baseRegistration({ style: { fillColor: "#ff0000", strokeColor: "#990000" } }),
      existing,
    );

    assert.equal(layer.style.fillColor, "#ff0000");
    assert.equal(layer.style.strokeColor, "#990000");
    assert.notEqual(layer.style.fillColor, DEFAULT_LAYER_STYLE.fillColor);
  });

  it("preserves user-edited existing style for keys the registration omits", () => {
    const existing: GeoLibreLayer = {
      id: "plugin-layer",
      name: "Plugin Layer",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE, strokeWidth: 5 },
      metadata: {},
    };

    const layer = createExternalNativeStoreLayer(
      baseRegistration({ style: { fillColor: "#00ff00" } }),
      existing,
    );

    assert.equal(layer.style.fillColor, "#00ff00");
    assert.equal(layer.style.strokeWidth, 5);
  });

  it("lets the registration own overlapping style keys over a user edit", () => {
    // External native layers are plugin-owned: a re-registration's style wins
    // even over a non-default user value on the same key, not just over defaults.
    const existing: GeoLibreLayer = {
      id: "plugin-layer",
      name: "Plugin Layer",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE, fillColor: "#abcdef" },
      metadata: {},
    };

    const layer = createExternalNativeStoreLayer(
      baseRegistration({ style: { fillColor: "#ff0000" } }),
      existing,
    );

    assert.equal(layer.style.fillColor, "#ff0000");
  });

  it("keeps the registration opacity over an existing default-seeded opacity", () => {
    const existing: GeoLibreLayer = {
      id: "plugin-layer",
      name: "Plugin Layer",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1, // seeded by addGeoJsonLayer
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    };

    const layer = createExternalNativeStoreLayer(baseRegistration({ opacity: 0.5 }), existing);

    assert.equal(layer.opacity, 0.5);
  });

  it("falls back to existing opacity when the registration omits opacity", () => {
    const existing: GeoLibreLayer = {
      id: "plugin-layer",
      name: "Plugin Layer",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 0.7,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    };

    const layer = createExternalNativeStoreLayer(baseRegistration(), existing);

    assert.equal(layer.opacity, 0.7);
  });

  it("lets the registration own opacity over a non-default user-edited value", () => {
    const existing: GeoLibreLayer = {
      id: "plugin-layer",
      name: "Plugin Layer",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 0.3, // user-edited
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    };

    const layer = createExternalNativeStoreLayer(baseRegistration({ opacity: 0.8 }), existing);

    assert.equal(layer.opacity, 0.8);
  });

  it("applies the registration style over defaults for a brand-new layer", () => {
    const layer = createExternalNativeStoreLayer(
      baseRegistration({ style: { fillColor: "#123456" } }),
    );

    assert.equal(layer.style.fillColor, "#123456");
    assert.equal(layer.style.strokeColor, DEFAULT_LAYER_STYLE.strokeColor);
    assert.equal(layer.metadata?.externalNativeLayer, true);
    assert.deepEqual(layer.metadata?.nativeLayerIds, ["plugin-layer-fill", "plugin-layer-outline"]);
  });

  it("preserves existing visibility when false", () => {
    const existing: GeoLibreLayer = {
      id: "plugin-layer",
      name: "Plugin Layer",
      type: "geojson",
      source: { type: "geojson" },
      visible: false,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    };

    const layer = createExternalNativeStoreLayer(baseRegistration(), existing);

    assert.equal(layer.visible, false);
  });
});
