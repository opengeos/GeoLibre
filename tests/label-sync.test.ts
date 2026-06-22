import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  type LabelStyle,
} from "@geolibre/core";
import { syncLayer } from "../packages/map/src/layer-sync";

// Stateful fake MapLibre map (mirrors point-renderer-sync.test.ts) so a test can
// assert which native layers a labels config produces.
function makeMap() {
  const sources = new Map<string, Record<string, unknown>>();
  const layers = new Map<string, Record<string, unknown>>();
  const map = {
    getSource: (id: string) =>
      sources.has(id) ? { setData: () => {} } : undefined,
    addSource: (id: string, spec: Record<string, unknown>) => {
      sources.set(id, spec);
    },
    removeSource: (id: string) => sources.delete(id),
    getLayer: (id: string) =>
      layers.has(id) ? { id, ...layers.get(id) } : undefined,
    addLayer: (spec: Record<string, unknown>) => {
      layers.set(spec.id as string, spec);
    },
    removeLayer: (id: string) => layers.delete(id),
    getFilter: (id: string) => layers.get(id)?.filter,
    setFilter: () => {},
    setPaintProperty: () => {},
    setLayoutProperty: () => {},
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

function labeledLayer(
  labelPatch: Partial<LabelStyle>,
  geometry: Geom = "point",
): GeoLibreLayer {
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
      features: [
        { type: "Feature", properties: { name: "A", pop: 5 }, geometry: coords },
      ],
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
    assert.deepEqual(label.layout["text-field"], [
      "to-string",
      ["coalesce", ["get", "name"], ""],
    ]);
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
    assert.deepEqual(label.layout["text-field"], [
      "to-string",
      ["coalesce", ["get", "name"], ""],
    ]);
  });

  it("falls back to the field when the expression is valid JSON but not an array", () => {
    const { map, layers } = makeMap();
    // `42` / `{"k":1}` parse cleanly but are not MapLibre expressions.
    syncLayer(
      map as never,
      labeledLayer({ enabled: true, field: "name", expression: '{"k":1}' }),
    );

    const label = layers.get(LABEL_ID) as { layout: Record<string, unknown> };
    assert.deepEqual(label.layout["text-field"], [
      "to-string",
      ["coalesce", ["get", "name"], ""],
    ]);
  });

  it("does not create a label layer when the expression is invalid and no field is set", () => {
    const { map, layers } = makeMap();
    // Invalid expression + empty field would fall back to an empty text-field;
    // the layer must be skipped rather than added with invisible text.
    syncLayer(
      map as never,
      labeledLayer({ enabled: true, field: "", expression: "{not json" }),
    );
    assert.ok(!layers.has(LABEL_ID));
  });

  it("removes an existing label layer when the expression becomes invalid with no field", () => {
    const { map, layers } = makeMap();
    syncLayer(map as never, labeledLayer({ enabled: true, field: "name" }));
    assert.ok(layers.has(LABEL_ID));

    syncLayer(
      map as never,
      labeledLayer({ enabled: true, field: "", expression: "{not json" }),
    );
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

  function colocatedPointLayer(
    labelPatch: Partial<LabelStyle>,
  ): GeoLibreLayer {
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
    const data = (sources.get(LABEL_SOURCE_ID) as { data: GeoJSON.FeatureCollection })
      .data;
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

    assert.ok(
      !sources.has(LABEL_SOURCE_ID),
      "no dedup source while time-filtered",
    );
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
    assert.deepEqual(label.layout["text-field"], [
      "to-string",
      ["coalesce", ["get", "name"], ""],
    ]);
  });

  it("removes the dedup source when dedup is turned back off", () => {
    const { map, layers, sources } = makeMap();
    syncLayer(
      map as never,
      colocatedPointLayer({ enabled: true, field: "name", dedupe: "unique" }),
    );
    assert.ok(sources.has(LABEL_SOURCE_ID));

    syncLayer(
      map as never,
      colocatedPointLayer({ enabled: true, field: "name", dedupe: "off" }),
    );
    assert.ok(!sources.has(LABEL_SOURCE_ID), "dedup source should be removed");
    const label = layers.get(LABEL_ID) as { source: string };
    assert.equal(label.source, "source-lyr");
  });
});
