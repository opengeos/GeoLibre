import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type LabelStyle } from "@geolibre/core";
import { syncLayer } from "../packages/map/src/layer-sync";

// Stateful fake MapLibre map (mirrors point-renderer-sync.test.ts) so a test can
// assert which native layers a labels config produces.
function makeMap() {
  const sources = new Map<string, Record<string, unknown>>();
  const layers = new Map<string, Record<string, unknown>>();
  const map = {
    // Expose the stored source type: without it the inline-geojson path treats
    // the source as wrong-typed and recreates every render layer on each sync,
    // so re-sync tests would never exercise ensureLayer's update branch.
    getSource: (id: string) =>
      sources.has(id) ? { type: sources.get(id)?.type, setData: () => {} } : undefined,
    addSource: (id: string, spec: Record<string, unknown>) => {
      sources.set(id, spec);
    },
    removeSource: (id: string) => sources.delete(id),
    getLayer: (id: string) => (layers.has(id) ? { id, ...layers.get(id) } : undefined),
    addLayer: (spec: Record<string, unknown>) => {
      layers.set(spec.id as string, spec);
    },
    removeLayer: (id: string) => layers.delete(id),
    getFilter: (id: string) => layers.get(id)?.filter,
    // Record updates into the stored spec so a test can observe the second
    // sync's property/filter changes (ensureLayer updates in place).
    setFilter: (id: string, filter: unknown) => {
      const layer = layers.get(id);
      if (layer) layer.filter = filter;
    },
    setPaintProperty: (id: string, key: string, value: unknown) => {
      const layer = layers.get(id);
      if (layer) (layer.paint as Record<string, unknown>)[key] = value;
    },
    setLayoutProperty: (id: string, key: string, value: unknown) => {
      const layer = layers.get(id);
      if (layer) (layer.layout as Record<string, unknown>)[key] = value;
    },
    setLayerZoomRange: () => {},
    moveLayer: () => {},
    getStyle: () => ({
      layers: [{ type: "symbol", layout: { "text-field": ["get", "x"] } }],
      sources: Object.fromEntries(sources),
    }),
    once: () => {},
  };
  return { map, layers, sources };
}

type Geom = "point" | "line";

function labeledLayer(labelPatch: Partial<LabelStyle>, geometry: Geom = "point"): GeoLibreLayer {
  const coords =
    geometry === "line"
      ? {
          type: "LineString" as const,
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        }
      : { type: "Point" as const, coordinates: [0, 0] };
  return {
    id: "lyr",
    name: "Layer",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: {
      ...DEFAULT_LAYER_STYLE,
      labels: { ...DEFAULT_LAYER_STYLE.labels, ...labelPatch },
    },
    metadata: {},
    geojson: {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { name: "A", pop: 5 }, geometry: coords }],
    },
  };
}

const LABEL_ID = "layer-lyr-label";

describe("label sync", () => {
  it("creates a label symbol layer from the configured field", () => {
    const { map, layers } = makeMap();
    syncLayer(map as never, labeledLayer({ enabled: true, field: "name" }));

    const label = layers.get(LABEL_ID) as {
      type: string;
      layout: Record<string, unknown>;
    };
    assert.ok(label, "label layer should exist");
    assert.equal(label.type, "symbol");
    assert.deepEqual(label.layout["text-field"], ["to-string", ["coalesce", ["get", "name"], ""]]);
    assert.equal(label.layout["symbol-placement"], "point");
  });

  it("does not create a label layer when labels are disabled", () => {
    const { map, layers } = makeMap();
    syncLayer(map as never, labeledLayer({ enabled: false, field: "name" }));
    assert.ok(!layers.has(LABEL_ID));
  });

  it("does not create a label layer when no field or expression is set", () => {
    const { map, layers } = makeMap();
    syncLayer(map as never, labeledLayer({ enabled: true, field: "" }));
    assert.ok(!layers.has(LABEL_ID));
  });

  it("removes the label layer when labels are turned off", () => {
    const { map, layers } = makeMap();
    syncLayer(map as never, labeledLayer({ enabled: true, field: "name" }));
    assert.ok(layers.has(LABEL_ID));

    syncLayer(map as never, labeledLayer({ enabled: false, field: "name" }));
    assert.ok(!layers.has(LABEL_ID));
  });

  it("uses the expression, overriding the field", () => {
    const { map, layers } = makeMap();
    syncLayer(
      map as never,
      labeledLayer({
        enabled: true,
        field: "name",
        expression: '["get", "pop"]',
      }),
    );

    const label = layers.get(LABEL_ID) as { layout: Record<string, unknown> };
    assert.deepEqual(label.layout["text-field"], ["get", "pop"]);
  });

  it("falls back to the field when the expression is invalid JSON", () => {
    const { map, layers } = makeMap();
    syncLayer(
      map as never,
      labeledLayer({ enabled: true, field: "name", expression: "{not json" }),
    );

    const label = layers.get(LABEL_ID) as { layout: Record<string, unknown> };
    assert.deepEqual(label.layout["text-field"], ["to-string", ["coalesce", ["get", "name"], ""]]);
  });

  it("falls back to the field when the expression is valid JSON but not an array", () => {
    const { map, layers } = makeMap();
    // `42` / `{"k":1}` parse cleanly but are not MapLibre expressions.
    syncLayer(map as never, labeledLayer({ enabled: true, field: "name", expression: '{"k":1}' }));

    const label = layers.get(LABEL_ID) as { layout: Record<string, unknown> };
    assert.deepEqual(label.layout["text-field"], ["to-string", ["coalesce", ["get", "name"], ""]]);
  });

  it("does not create a label layer when the expression is invalid and no field is set", () => {
    const { map, layers } = makeMap();
    // Invalid expression + empty field would fall back to an empty text-field;
    // the layer must be skipped rather than added with invisible text.
    syncLayer(map as never, labeledLayer({ enabled: true, field: "", expression: "{not json" }));
    assert.ok(!layers.has(LABEL_ID));
  });

  it("removes an existing label layer when the expression becomes invalid with no field", () => {
    const { map, layers } = makeMap();
    syncLayer(map as never, labeledLayer({ enabled: true, field: "name" }));
    assert.ok(layers.has(LABEL_ID));

    syncLayer(map as never, labeledLayer({ enabled: true, field: "", expression: "{not json" }));
    assert.ok(!layers.has(LABEL_ID));
  });

  it("places labels along the line when placement is line", () => {
    const { map, layers } = makeMap();
    syncLayer(
      map as never,
      labeledLayer({ enabled: true, field: "name", placement: "line" }, "line"),
    );

    const label = layers.get(LABEL_ID) as { layout: Record<string, unknown> };
    assert.equal(label.layout["symbol-placement"], "line");
  });

  it("applies the label appearance and scale range", () => {
    const { map, layers } = makeMap();
    syncLayer(
      map as never,
      labeledLayer({
        enabled: true,
        field: "name",
        size: 20,
        color: "#ff0000",
        minZoom: 5,
        maxZoom: 12,
      }),
    );

    const label = layers.get(LABEL_ID) as {
      layout: Record<string, unknown>;
      paint: Record<string, unknown>;
      minzoom: number;
      maxzoom: number;
    };
    assert.equal(label.layout["text-size"], 20);
    assert.equal(label.paint["text-color"], "#ff0000");
    // The label's scale range is intersected with the layer's own zoom range
    // (default 0-24), so the tighter 5-12 wins.
    assert.equal(label.minzoom, 5);
    assert.equal(label.maxzoom, 12);
  });

  it("applies the ArcGIS-style label layout options", () => {
    const { map, layers } = makeMap();
    syncLayer(
      map as never,
      labeledLayer({
        enabled: true,
        field: "name",
        anchor: "top",
        offsetX: 1.5,
        offsetY: -2,
        rotation: 30,
        maxWidth: 6,
        transform: "uppercase",
      }),
    );

    const label = layers.get(LABEL_ID) as { layout: Record<string, unknown> };
    assert.equal(label.layout["text-anchor"], "top");
    assert.deepEqual(label.layout["text-offset"], [1.5, -2]);
    assert.equal(label.layout["text-rotate"], 30);
    assert.equal(label.layout["text-max-width"], 6);
    assert.equal(label.layout["text-transform"], "uppercase");
  });

  function colocatedPointLayer(labelPatch: Partial<LabelStyle>): GeoLibreLayer {
    return {
      id: "lyr",
      name: "Layer",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: {
        ...DEFAULT_LAYER_STYLE,
        labels: { ...DEFAULT_LAYER_STYLE.labels, ...labelPatch },
      },
      metadata: {},
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "A" },
            geometry: { type: "Point", coordinates: [0, 0] },
          },
          {
            type: "Feature",
            properties: { name: "B" },
            geometry: { type: "Point", coordinates: [0, 0] },
          },
        ],
      },
    };
  }

  const LABEL_SOURCE_ID = "source-lyr-label";

  it("builds a dedicated label source for unique-label mode", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(
      map as never,
      colocatedPointLayer({ enabled: true, field: "name", dedupe: "unique" }),
    );

    const label = layers.get(LABEL_ID) as {
      source: string;
      layout: Record<string, unknown>;
    };
    assert.ok(sources.has(LABEL_SOURCE_ID), "dedup source should exist");
    assert.equal(label.source, LABEL_SOURCE_ID);
    assert.deepEqual(label.layout["text-field"], ["get", "__geolibre_label"]);
    const data = (sources.get(LABEL_SOURCE_ID) as { data: GeoJSON.FeatureCollection }).data;
    assert.equal(data.features.length, 1);
  });

  it("does not dedup while a time filter is active", () => {
    const { map, layers, sources } = makeMap();
    const layer = colocatedPointLayer({
      enabled: true,
      field: "name",
      dedupe: "unique",
    });
    // A time-bound layer carries a MapLibre filter expression; the dedup source
    // is unfiltered, so dedup is skipped to avoid showing time-excluded labels.
    layer.timeFilter = ["<=", ["get", "t"], 5] as unknown[];
    syncLayer(map as never, layer);

    assert.ok(!sources.has(LABEL_SOURCE_ID), "no dedup source while time-filtered");
    const label = layers.get(LABEL_ID) as { source: string };
    assert.equal(label.source, "source-lyr");
  });

  it("does not dedup a mixed-geometry layer (would drop non-point labels)", () => {
    const { map, layers, sources } = makeMap();
    const mixed: GeoLibreLayer = {
      id: "lyr",
      name: "Layer",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: {
        ...DEFAULT_LAYER_STYLE,
        labels: {
          ...DEFAULT_LAYER_STYLE.labels,
          enabled: true,
          field: "name",
          dedupe: "unique",
        },
      },
      metadata: {},
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "P" },
            geometry: { type: "Point", coordinates: [0, 0] },
          },
          {
            type: "Feature",
            properties: { name: "L" },
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
    syncLayer(map as never, mixed);

    assert.ok(!sources.has(LABEL_SOURCE_ID), "no dedup source for mixed layer");
    const label = layers.get(LABEL_ID) as {
      source: string;
      layout: Record<string, unknown>;
    };
    assert.equal(label.source, "source-lyr");
    assert.deepEqual(label.layout["text-field"], ["to-string", ["coalesce", ["get", "name"], ""]]);
  });

  it("removes the dedup source when dedup is turned back off", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(
      map as never,
      colocatedPointLayer({ enabled: true, field: "name", dedupe: "unique" }),
    );
    assert.ok(sources.has(LABEL_SOURCE_ID));

    syncLayer(map as never, colocatedPointLayer({ enabled: true, field: "name", dedupe: "off" }));
    assert.ok(!sources.has(LABEL_SOURCE_ID), "dedup source should be removed");
    const label = layers.get(LABEL_ID) as { source: string };
    assert.equal(label.source, "source-lyr");
  });

  // --- Data-defined overrides (GH #1320) ---

  it("applies data-defined size, color, opacity, and priority expressions", () => {
    const { map, layers } = makeMap();
    syncLayer(
      map as never,
      labeledLayer({
        enabled: true,
        field: "name",
        sizeExpression: '["+", ["get", "pop"], 8]',
        colorExpression: '["case", [">", ["get", "pop"], 3], "#ff0000", "#00ff00"]',
        opacityExpression: '["case", [">", ["get", "pop"], 3], 1, 0.5]',
        priorityExpression: '["-", 0, ["get", "pop"]]',
      }),
    );

    const label = layers.get(LABEL_ID) as {
      layout: Record<string, unknown>;
      paint: Record<string, unknown>;
    };
    assert.deepEqual(label.layout["text-size"], ["+", ["get", "pop"], 8]);
    assert.deepEqual(label.layout["symbol-sort-key"], ["-", 0, ["get", "pop"]]);
    assert.deepEqual(label.paint["text-color"], [
      "case",
      [">", ["get", "pop"], 3],
      "#ff0000",
      "#00ff00",
    ]);
    assert.deepEqual(label.paint["text-opacity"], ["case", [">", ["get", "pop"], 3], 1, 0.5]);
  });

  it("falls back to the literal controls when an override is invalid", () => {
    const { map, layers } = makeMap();
    syncLayer(
      map as never,
      labeledLayer({
        enabled: true,
        field: "name",
        // Invalid JSON and valid-JSON-but-not-an-expression must both fall
        // back to the literal control instead of breaking the layer.
        sizeExpression: "{not json",
        colorExpression: '{"k":1}',
        opacityExpression: "42",
      }),
    );

    const label = layers.get(LABEL_ID) as {
      layout: Record<string, unknown>;
      paint: Record<string, unknown>;
    };
    assert.equal(label.layout["text-size"], DEFAULT_LAYER_STYLE.labels.size);
    assert.equal(label.paint["text-color"], DEFAULT_LAYER_STYLE.labels.color);
    assert.equal(label.paint["text-opacity"], 1);
    // The null symbol-sort-key reset must be stripped on first add (MapLibre
    // silently drops a layer whose layout carries an explicit null).
    assert.ok(!("symbol-sort-key" in label.layout));
  });

  it("falls back when an override is well-formed but wrong for its destination", () => {
    const { map, layers } = makeMap();
    syncLayer(
      map as never,
      labeledLayer({
        enabled: true,
        field: "name",
        // A JSON array that is not an expression (no operator), and an
        // expression whose result type cannot fit the destination. Both must
        // fall back to the literal control: addLayer validates the whole
        // layer spec, so passing them through would reject the entire label
        // layer, not just the property.
        sizeExpression: "[1, 2, 3]",
        colorExpression: '["literal", 5]',
      }),
    );

    const label = layers.get(LABEL_ID) as {
      layout: Record<string, unknown>;
      paint: Record<string, unknown>;
    };
    assert.equal(label.layout["text-size"], DEFAULT_LAYER_STYLE.labels.size);
    assert.equal(label.paint["text-color"], DEFAULT_LAYER_STYLE.labels.color);
  });

  it("ANDs the visibility expression into the label filter", () => {
    const { map, layers } = makeMap();
    syncLayer(
      map as never,
      labeledLayer({
        enabled: true,
        field: "name",
        visibilityExpression: '[">", ["get", "pop"], 3]',
      }),
    );

    const label = layers.get(LABEL_ID) as { filter: unknown[] };
    assert.equal(label.filter[0], "all");
    assert.equal(label.filter.length, 3);
    assert.deepEqual(label.filter[2], [">", ["get", "pop"], 3]);

    // Clearing the expression restores the plain marker-exclusion filter.
    syncLayer(map as never, labeledLayer({ enabled: true, field: "name" }));
    const updated = layers.get(LABEL_ID) as { filter: unknown[] };
    assert.notEqual(updated.filter[0], "all");
  });

  it("resets the placement priority when the expression is cleared", () => {
    const { map, layers } = makeMap();
    syncLayer(
      map as never,
      labeledLayer({
        enabled: true,
        field: "name",
        priorityExpression: '["get", "pop"]',
      }),
    );
    const label = layers.get(LABEL_ID) as { layout: Record<string, unknown> };
    assert.deepEqual(label.layout["symbol-sort-key"], ["get", "pop"]);

    syncLayer(map as never, labeledLayer({ enabled: true, field: "name" }));
    const updated = layers.get(LABEL_ID) as {
      layout: Record<string, unknown>;
    };
    // The update path pushes an explicit null, which setLayoutProperty treats
    // as a reset to the default.
    assert.equal(updated.layout["symbol-sort-key"], null);
  });

  it("keeps literal styling on the dedup path (synthetic features carry no attributes)", () => {
    const { map, layers } = makeMap();
    syncLayer(
      map as never,
      colocatedPointLayer({
        enabled: true,
        field: "name",
        dedupe: "unique",
        sizeExpression: '["+", ["get", "pop"], 8]',
        colorExpression: '["case", ["has", "pop"], "#ff0000", "#00ff00"]',
        visibilityExpression: '[">", ["get", "pop"], 3]',
      }),
    );

    const label = layers.get(LABEL_ID) as {
      source: string;
      filter?: unknown;
      layout: Record<string, unknown>;
      paint: Record<string, unknown>;
    };
    assert.equal(label.source, LABEL_SOURCE_ID);
    assert.equal(label.layout["text-size"], DEFAULT_LAYER_STYLE.labels.size);
    assert.equal(label.paint["text-color"], DEFAULT_LAYER_STYLE.labels.color);
    assert.equal(label.filter, undefined);
  });
});
