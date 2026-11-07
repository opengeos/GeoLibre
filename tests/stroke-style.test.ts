import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  STROKE_DASH_PRESETS,
  sanitizeLayerStylePatch,
  strokeDashPresetName,
  strokeDashValue,
  type LayerStyle,
} from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import { syncLayer } from "../packages/map/src/layer-sync";
import { createFeatureStyleResolver } from "../packages/map/src/feature-style";
import { circlePaint, fillPaint, linePaint } from "../packages/map/src/style-mapper";

/** A fake map that reads paint back, as MapLibre does, and logs dash writes. */
function makeMap() {
  const sources = new Map<string, Record<string, unknown>>();
  const layers = new Map<string, Record<string, unknown> & { paint: Record<string, unknown> }>();
  const dashWrites: unknown[] = [];
  const map = {
    getSource: (id: string) =>
      sources.has(id) ? { type: sources.get(id)?.type, setData: () => {} } : undefined,
    addSource: (id: string, spec: Record<string, unknown>) => void sources.set(id, spec),
    removeSource: (id: string) => sources.delete(id),
    getLayer: (id: string) => (layers.has(id) ? { id, ...layers.get(id) } : undefined),
    addLayer: (spec: Record<string, unknown>) => {
      // MapLibre drops a layer whose paint carries an explicit null on add;
      // ensureLayer strips it, and this fails loudly if it ever stops.
      if (Object.values((spec.paint as Record<string, unknown>) ?? {}).includes(null)) {
        throw new Error(`null paint on add: ${String(spec.id)}`);
      }
      layers.set(spec.id as string, {
        ...spec,
        paint: { ...((spec.paint as Record<string, unknown>) ?? {}) },
      });
    },
    removeLayer: (id: string) => layers.delete(id),
    getFilter: (id: string) => layers.get(id)?.filter,
    setFilter: () => {},
    // An unset (or reset) property reads back as undefined.
    getPaintProperty: (id: string, key: string) => layers.get(id)?.paint[key] ?? undefined,
    setPaintProperty: (id: string, key: string, value: unknown) => {
      if (key === "line-dasharray") dashWrites.push(value);
      const layer = layers.get(id);
      if (layer) layer.paint[key] = value;
    },
    getLayoutProperty: () => undefined,
    setLayoutProperty: () => {},
    setLayerZoomRange: () => {},
    moveLayer: () => {},
    getStyle: () => ({ layers: [], sources: Object.fromEntries(sources) }),
    once: () => {},
  };
  return { map, dashWrites };
}

function lineLayer(patch: Partial<LayerStyle>): GeoLibreLayer {
  return {
    id: "lyr",
    name: "Layer",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE, ...patch },
    metadata: {},
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
        },
      ],
    },
  };
}

function style(patch: Partial<LayerStyle> = {}): LayerStyle {
  return { ...DEFAULT_LAYER_STYLE, ...patch };
}

describe("line opacity, dashes and blur (#3350)", () => {
  it("draws a solid, sharp, opaque line by default and resets the dash with null", () => {
    const paint = linePaint(style(), 1);
    assert.equal(paint["line-opacity"], 1);
    assert.equal(paint["line-dasharray"], null);
    assert.equal(paint["line-blur"], null);
  });

  it("folds the stroke opacity into the layer opacity and passes dashes and blur through", () => {
    const paint = linePaint(style({ strokeOpacity: 0.5, strokeDash: [4, 2], strokeBlur: 3 }), 0.8);
    assert.equal(paint["line-opacity"], 0.4);
    assert.deepEqual(paint["line-dasharray"], [4, 2]);
    assert.equal(paint["line-blur"], 3);
  });

  it("drops the fill's hairline outline under a dashed or translucent stroke", () => {
    assert.equal(fillPaint(style(), 1)["fill-outline-color"], DEFAULT_LAYER_STYLE.strokeColor);
    assert.equal(fillPaint(style({ strokeDash: [4, 2] }), 1)["fill-outline-color"], null);
    assert.equal(fillPaint(style({ strokeOpacity: 0.5 }), 1)["fill-outline-color"], null);
    // A simplestyle feature's own stroke-opacity can make its outline
    // translucent, so a simplestyle layer drops the hairline too.
    assert.equal(fillPaint(style({ simpleStyleEnabled: true }), 1)["fill-outline-color"], null);
  });

  it("fades point outlines with the stroke opacity", () => {
    assert.equal(circlePaint(style({ strokeOpacity: 0.5 }), 0.5)["circle-stroke-opacity"], 0.25);
  });

  it("uses the stroke opacity as the base a simplestyle stroke-opacity replaces", () => {
    const paint = linePaint(style({ strokeOpacity: 0.3, simpleStyleEnabled: true }), 1);
    assert.deepEqual(paint["line-opacity"], [
      "*",
      ["to-number", ["coalesce", ["get", "stroke-opacity"], 0.3], 0.3],
      1,
    ]);
  });

  it("reads a project without the new fields, or with bad values, as before", () => {
    const legacy = { ...DEFAULT_LAYER_STYLE } as Partial<LayerStyle>;
    delete legacy.strokeOpacity;
    delete legacy.strokeDash;
    delete legacy.strokeBlur;
    const paint = linePaint(legacy as LayerStyle, 1);
    assert.equal(paint["line-opacity"], 1);
    assert.equal(paint["line-dasharray"], null);
    assert.equal(paint["line-blur"], null);
    const bad = linePaint(style({ strokeOpacity: 4, strokeDash: [0, 0], strokeBlur: -2 }), 1);
    assert.equal(bad["line-opacity"], 1);
    assert.equal(bad["line-dasharray"], null);
    assert.equal(bad["line-blur"], null);
  });

  it("names the preset a pattern matches", () => {
    for (const [name, pattern] of Object.entries(STROKE_DASH_PRESETS)) {
      assert.equal(strokeDashPresetName([...pattern]), name);
    }
    assert.equal(strokeDashPresetName([5, 1]), "custom");
    assert.equal(strokeDashPresetName(undefined), "solid");
    assert.equal(strokeDashValue(style({ strokeDash: [5, 1] }))?.join(), "5,1");
  });

  it("keeps a drawable dash pattern from a hand-edited file and drops a broken one", () => {
    assert.deepEqual(sanitizeLayerStylePatch({ strokeDash: [4, 2] }), { strokeDash: [4, 2] });
    assert.deepEqual(sanitizeLayerStylePatch({ strokeDash: [] }), { strokeDash: [] });
    for (const strokeDash of [[-1, 2], [0, 0], ["4", 2], "4 2"]) {
      assert.deepEqual(sanitizeLayerStylePatch({ strokeDash }), {}, JSON.stringify(strokeDash));
    }
    assert.deepEqual(sanitizeLayerStylePatch({ strokeOpacity: 0.5, strokeBlur: 2 }), {
      strokeOpacity: 0.5,
      strokeBlur: 2,
    });
  });

  it("resets a cleared dash once, and never re-sends the reset for a solid line", () => {
    const { map, dashWrites } = makeMap();
    syncLayer(map as never, lineLayer({}));
    syncLayer(map as never, lineLayer({}));
    // A solid line never had a dash: nothing to reset on either sync.
    assert.deepEqual(dashWrites, []);
    syncLayer(map as never, lineLayer({ strokeDash: [4, 2] }));
    syncLayer(map as never, lineLayer({}));
    syncLayer(map as never, lineLayer({}));
    // The dash is set, then reset exactly once.
    assert.deepEqual(dashWrites, [[4, 2], null]);
  });

  it("never resets a plugin layer's own dash, only one GeoLibre set", () => {
    const writes: unknown[] = [];
    const blurWrites: unknown[] = [];
    // A real map returns the same layer object until the layer is removed.
    let nativeLayer = { id: "plugin-line", type: "line" };
    const map = {
      getStyle: () => ({ layers: [{ id: "plugin-line", type: "line" }] }),
      getLayer: (id: string) => (id === "plugin-line" ? nativeLayer : undefined),
      getSource: () => undefined,
      // The plugin drew its line dashed and blurred.
      getPaintProperty: (_id: string, key: string) =>
        key === "line-dasharray" ? [2, 2] : key === "line-blur" ? 3 : undefined,
      setPaintProperty: (_id: string, key: string, value: unknown) => {
        if (key === "line-dasharray") writes.push(value);
        if (key === "line-blur") blurWrites.push(value);
      },
      setLayoutProperty: () => {},
      setLayerZoomRange: () => {},
      moveLayer: () => {},
      removeLayer: () => {},
      addLayer: () => {},
      addSource: () => {},
      getFilter: () => undefined,
      setFilter: () => {},
    };
    const pluginLayer = (patch: Partial<LayerStyle>): GeoLibreLayer => ({
      id: "plugin-line-store",
      name: "Plugin line",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE, ...patch },
      metadata: {
        externalNativeLayer: true,
        nativeLayerIds: ["plugin-line"],
        sourceIds: ["plugin-line"],
      },
    });
    // A solid, sharp layer style leaves the plugin's dash and blur alone.
    syncLayer(map as never, pluginLayer({}));
    assert.deepEqual(writes, []);
    assert.deepEqual(blurWrites, []);
    // A dash the user sets is written, and clearing it resets it once.
    syncLayer(map as never, pluginLayer({ strokeDash: [4, 2] }));
    syncLayer(map as never, pluginLayer({}));
    syncLayer(map as never, pluginLayer({}));
    assert.deepEqual(writes, [[4, 2], null]);
    // A plugin that recreates its layer under the same id draws a new one, so
    // what GeoLibre set on the old layer is not reset on it.
    syncLayer(map as never, pluginLayer({ strokeDash: [4, 2] }));
    nativeLayer = { id: "plugin-line", type: "line" };
    syncLayer(map as never, pluginLayer({}));
    assert.deepEqual(writes, [[4, 2], null, [4, 2]]);
  });

  it("gives the 3D and ArcGIS feature symbols the stroke opacity too", () => {
    const point = {
      type: "Feature" as const,
      properties: {},
      geometry: { type: "Point" as const, coordinates: [0, 0] },
    };
    assert.equal(
      createFeatureStyleResolver(style({ strokeOpacity: 0.4 })).resolve(point, 5).strokeOpacity,
      0.4,
    );
    // A per-feature simplestyle stroke-opacity still wins for that feature.
    const simple = createFeatureStyleResolver(
      style({ strokeOpacity: 0.4, simpleStyleEnabled: true }),
    );
    assert.equal(
      simple.resolve({ ...point, properties: { "stroke-opacity": 0.9 } }, 5).strokeOpacity,
      0.9,
    );
    assert.equal(simple.resolve(point, 5).strokeOpacity, 0.4);
  });
});
