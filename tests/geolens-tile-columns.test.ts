import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { tileColumnsOf } from "../packages/plugins/src/plugins/geolens-api";
import {
  desiredTileColumns,
  MAX_GEOLENS_TILE_COLUMNS,
} from "../packages/plugins/src/plugins/maplibre-geolens";

/**
 * The `cols=` opt-in that makes a GeoLens vector-tile layer carry attributes.
 *
 * GeoLens projects no attribute columns below zoom 10, so without this a layer
 * viewed at world zoom hands MapLibre `properties: {}` on every feature and
 * everything that reads attributes off the map — categorized styling, the Time
 * Slider bind dialog, labels, popups — finds nothing (GeoLibre#1854).
 */

const BASE_URL = "https://datasets.example.com";
const DATASET = "ds-1";
const FIELDS = ["name", "nature", "year", "month", "day"];

function tileUrl(cols?: string): string {
  const query = `sig=abc&exp=9999999999&scope=tracks${cols ? `&cols=${cols}` : ""}`;
  return `${BASE_URL}/api/tiles/data.tracks/{z}/{x}/{y}.pbf?${query}`;
}

/** A GeoLens vector-tile layer as `addVectorTilesLayer` builds it. */
function addTileLayer(overrides: Partial<GeoLibreLayer> = {}, fields = FIELDS): string {
  const layer: GeoLibreLayer = {
    id: `layer-${Math.random().toString(36).slice(2)}`,
    name: "Hurricane tracks",
    type: "vector-tiles",
    source: {
      type: "vector",
      tiles: [tileUrl(fields.join(","))],
      sourceLayer: "data.tracks",
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      sourceKind: "geolens-vector-tiles",
      geolensBaseUrl: BASE_URL,
      geolensDatasetId: DATASET,
      fields,
    },
    ...overrides,
  } as GeoLibreLayer;
  useAppStore.getState().addLayer(layer);
  return layer.id;
}

function storedLayer(id: string): GeoLibreLayer {
  const layer = useAppStore.getState().layers.find((l) => l.id === id);
  assert.ok(layer);
  return layer;
}

function storedTileColumns(id: string): string[] {
  const tiles = storedLayer(id).source.tiles;
  assert.ok(Array.isArray(tiles) && typeof tiles[0] === "string");
  return tileColumnsOf(tiles[0]);
}

beforeEach(() => {
  for (const layer of [...useAppStore.getState().layers]) {
    useAppStore.getState().removeLayer(layer.id);
  }
});

describe("desiredTileColumns", () => {
  it("requests the whole attribute table for an ordinary dataset", () => {
    // Nothing has been styled yet: this is exactly the case the opt-in has to
    // cover, since the user cannot pick a column they cannot see.
    const id = addTileLayer();
    assert.deepEqual(desiredTileColumns(storedLayer(id)), [...FIELDS].sort());
  });

  it("adds the attributes the layer's own style points at", () => {
    const id = addTileLayer();
    useAppStore.getState().setLayerStyle(id, {
      vectorStyleMode: "categorized",
      vectorStyleProperty: "nature",
      labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "name" },
    });
    assert.deepEqual(desiredTileColumns(storedLayer(id)), [...FIELDS].sort());
  });

  it("keeps a too-wide dataset on the server's own budget", () => {
    // The whole-table opt-in is what the server's low-zoom budget exists to
    // prevent for wide tables, so past the ceiling only what is in use is asked
    // for — enough to render an applied style, not to discover a new one.
    const wide = Array.from({ length: MAX_GEOLENS_TILE_COLUMNS + 1 }, (_, i) => `col_${i}`);
    const id = addTileLayer({}, wide);
    assert.deepEqual(desiredTileColumns(storedLayer(id)), []);

    useAppStore
      .getState()
      .setLayerStyle(id, { vectorStyleMode: "categorized", vectorStyleProperty: "col_3" });
    assert.deepEqual(desiredTileColumns(storedLayer(id)), ["col_3"]);
  });

  it("ignores style fields whose feature is switched off", () => {
    const wide = Array.from({ length: MAX_GEOLENS_TILE_COLUMNS + 1 }, (_, i) => `col_${i}`);
    const id = addTileLayer({}, wide);
    // `extrusionHeightProperty` defaults to "height" and the label field can
    // outlive the labels being turned off; neither is being drawn, so neither
    // is worth a column.
    useAppStore.getState().setLayerStyle(id, {
      extrusionEnabled: false,
      extrusionHeightProperty: "col_1",
      labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: false, field: "col_2" },
    });
    assert.deepEqual(desiredTileColumns(storedLayer(id)), []);

    useAppStore.getState().setLayerStyle(id, { extrusionEnabled: true });
    assert.deepEqual(desiredTileColumns(storedLayer(id)), ["col_1"]);

    // An advanced height expression replaces the property, and the column it
    // reads is requested in its place.
    useAppStore.getState().setLayerStyle(id, {
      extrusionAdvancedStyleEnabled: true,
      extrusionHeightExpression: '["get", "col_9"]',
    });
    assert.deepEqual(desiredTileColumns(storedLayer(id)), ["col_9"]);

    // ...but it only wins while it parses; an unfinished one still renders from
    // the property, so that column has to come back.
    useAppStore.getState().setLayerStyle(id, { extrusionHeightExpression: "[" });
    assert.deepEqual(desiredTileColumns(storedLayer(id)), ["col_1"]);
  });

  it("follows the properties an in-effect expression reads", () => {
    const wide = Array.from({ length: MAX_GEOLENS_TILE_COLUMNS + 1 }, (_, i) => `col_${i}`);
    const id = addTileLayer({}, wide);
    useAppStore.getState().setLayerStyle(id, {
      vectorStyleMode: "expression",
      vectorStyleExpression:
        '["case", ["<", ["get", "col_2"], 10], "#111111", ["has", "col_6"], "#222222", "#333333"]',
    });
    assert.deepEqual(desiredTileColumns(storedLayer(id)), ["col_2", "col_6"]);

    // Rule filters drive the paint the same way in rule-based mode.
    useAppStore.getState().setLayerStyle(id, {
      vectorStyleMode: "rule-based",
      vectorRules: [
        { id: "r1", label: "a", filter: '["==", ["get", "col_4"], "x"]', color: "#2563eb" },
        { id: "r2", label: "else", filter: "", color: "#dc2626", isElse: true },
      ],
    });
    assert.deepEqual(desiredTileColumns(storedLayer(id)), ["col_4"]);

    // A `literal` payload is data: the expression matches `col_3` against a
    // fixed list, and a `get`-shaped array inside that list is just an element.
    useAppStore.getState().setLayerStyle(id, {
      vectorStyleMode: "expression",
      vectorStyleExpression:
        '["case", ["in", ["get", "col_3"], ["literal", ["a", "b"]]], "#111111", "#222222"]',
    });
    assert.deepEqual(desiredTileColumns(storedLayer(id)), ["col_3"]);
    useAppStore.getState().setLayerStyle(id, {
      vectorStyleExpression:
        '["case", ["==", ["literal", ["get", "col_9"]], 1], "#111111", "#222222"]',
    });
    assert.deepEqual(desiredTileColumns(storedLayer(id)), []);

    // A key computed at render time names no column, and `["get", key, object]`
    // reads from a supplied object rather than the feature.
    useAppStore.getState().setLayerStyle(id, {
      vectorStyleMode: "expression",
      vectorStyleExpression:
        '["case", ["==", ["get", ["concat", "col", "_1"]], 1], "#111111", ["get", "k", ["literal", {"k": "#222222"}]]]',
    });
    assert.deepEqual(desiredTileColumns(storedLayer(id)), []);
  });

  it("drops the classification property when nothing paints from it", () => {
    // The property survives a switch back to a fixed color, so reading it
    // ungated would keep a column alive for a style that no longer uses it.
    const wide = Array.from({ length: MAX_GEOLENS_TILE_COLUMNS + 1 }, (_, i) => `col_${i}`);
    const id = addTileLayer({}, wide);
    useAppStore
      .getState()
      .setLayerStyle(id, { vectorStyleMode: "categorized", vectorStyleProperty: "col_5" });
    assert.deepEqual(desiredTileColumns(storedLayer(id)), ["col_5"]);

    useAppStore.getState().setLayerStyle(id, { vectorStyleMode: "single" });
    assert.deepEqual(desiredTileColumns(storedLayer(id)), []);
  });

  it("includes a diagram's slice fields and its attribute size property", () => {
    const wide = Array.from({ length: MAX_GEOLENS_TILE_COLUMNS + 1 }, (_, i) => `col_${i}`);
    const id = addTileLayer({}, wide);
    useAppStore.getState().setLayerStyle(id, {
      diagramType: "pie",
      diagramFields: [{ property: "col_2", color: "#2563eb" }],
      diagramSizeMode: "attribute",
      diagramSizeProperty: "col_8",
    });
    assert.deepEqual(desiredTileColumns(storedLayer(id)), ["col_2", "col_8"]);

    // Sizing from the slice total reads no extra column.
    useAppStore.getState().setLayerStyle(id, { diagramSizeMode: "sum" });
    assert.deepEqual(desiredTileColumns(storedLayer(id)), ["col_2"]);
  });

  it("includes the Time Slider binding's property", () => {
    const wide = Array.from({ length: MAX_GEOLENS_TILE_COLUMNS + 1 }, (_, i) => `col_${i}`);
    const id = addTileLayer({}, wide);
    const layer = storedLayer(id);
    useAppStore.getState().updateLayer(id, {
      metadata: { ...layer.metadata, timeBinding: { property: "col_7", valueKind: "year" } },
    });
    assert.deepEqual(desiredTileColumns(storedLayer(id)), ["col_7"]);
  });

  it("resolves a layer once and re-resolves when it changes", () => {
    // The sync runs on every store update that replaces the layers array — an
    // opacity drag on another layer included — so an untouched layer must not
    // re-parse its expressions.
    const id = addTileLayer();
    const first = desiredTileColumns(storedLayer(id));
    assert.equal(desiredTileColumns(storedLayer(id)), first, "same layer object, same result");

    useAppStore.getState().setLayerStyle(id, { vectorStyleMode: "categorized" });
    const after = desiredTileColumns(storedLayer(id));
    assert.notEqual(after, first, "a patched layer is a new object, so it resolves again");
    assert.deepEqual(after, first);
  });

  it("falls back to the columns in use when the field list is unknown", () => {
    // A project saved before the field list was recorded still styles by name.
    const id = addTileLayer({}, []);
    useAppStore
      .getState()
      .setLayerStyle(id, { vectorStyleMode: "categorized", vectorStyleProperty: "nature" });
    assert.deepEqual(desiredTileColumns(storedLayer(id)), ["nature"]);
  });
});

describe("tile column sync", () => {
  it("restamps a layer whose tiles do not carry the attribute it needs", () => {
    // A layer restored from a project saved before the opt-in: its URL asks for
    // nothing, so its categorized style renders against empty properties.
    const wide = Array.from({ length: MAX_GEOLENS_TILE_COLUMNS + 1 }, (_, i) => `col_${i}`);
    const id = addTileLayer({ source: { type: "vector", tiles: [tileUrl()] } }, wide);
    assert.deepEqual(storedTileColumns(id), []);

    useAppStore
      .getState()
      .setLayerStyle(id, { vectorStyleMode: "categorized", vectorStyleProperty: "col_3" });

    assert.deepEqual(storedTileColumns(id), ["col_3"]);
    // The signature rides along untouched — restamping must not cost a re-mint.
    const tiles = storedLayer(id).source.tiles as string[];
    assert.ok(tiles[0].includes("sig=abc"));
    assert.ok(tiles[0].includes("/{z}/{x}/{y}.pbf?"));
  });

  it("leaves a layer alone once its tiles already carry what it needs", () => {
    const id = addTileLayer();
    const before = (storedLayer(id).source.tiles as string[])[0];
    useAppStore
      .getState()
      .setLayerStyle(id, { vectorStyleMode: "categorized", vectorStyleProperty: "nature" });
    // `nature` is already in the opt-in, so the URL must not churn — a changed
    // URL is a full tile refetch.
    assert.equal((storedLayer(id).source.tiles as string[])[0], before);
  });

  it("does not touch layers from other sources", () => {
    const id = addTileLayer({
      metadata: { sourceKind: "ogc-vector-tiles", fields: FIELDS },
      source: { type: "vector", tiles: [tileUrl()] },
    });
    useAppStore
      .getState()
      .setLayerStyle(id, { vectorStyleMode: "categorized", vectorStyleProperty: "nature" });
    assert.deepEqual(storedTileColumns(id), []);
  });

  it("restamps every stale layer in one pass", () => {
    // `updateLayer` notifies the sync's own subscription synchronously, so a
    // second stale layer is the case where a mid-loop patch would spread a
    // `source` the nested pass already replaced.
    const wide = Array.from({ length: MAX_GEOLENS_TILE_COLUMNS + 1 }, (_, i) => `col_${i}`);
    const a = addTileLayer({ source: { type: "vector", tiles: [tileUrl()] } }, wide);
    const b = addTileLayer({ source: { type: "vector", tiles: [tileUrl()] } }, wide);
    useAppStore
      .getState()
      .setLayerStyle(a, { vectorStyleMode: "categorized", vectorStyleProperty: "col_3" });
    useAppStore
      .getState()
      .setLayerStyle(b, { vectorStyleMode: "categorized", vectorStyleProperty: "col_4" });

    assert.deepEqual(storedTileColumns(a), ["col_3"]);
    assert.deepEqual(storedTileColumns(b), ["col_4"]);
    for (const id of [a, b]) {
      assert.ok((storedLayer(id).source.tiles as string[])[0].includes("sig=abc"));
    }
  });
});
