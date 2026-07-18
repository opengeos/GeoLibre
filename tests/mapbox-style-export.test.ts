import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type LayerStyle } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  buildMapboxStyle,
  mapboxStyleToJson,
  type ExportableLayer,
} from "../packages/map/src/mapbox-style-export";

function style(patch: Partial<LayerStyle> = {}): LayerStyle {
  return { ...DEFAULT_LAYER_STYLE, ...patch };
}

function layer(patch: Partial<ExportableLayer> & { style?: LayerStyle } = {}): ExportableLayer {
  return {
    id: patch.id ?? "layer-1",
    name: patch.name ?? "My Layer",
    type: patch.type ?? "geojson",
    opacity: patch.opacity ?? 1,
    visible: patch.visible ?? true,
    style: patch.style ?? style(),
  };
}

function points(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { category: "a", value: 5 },
        geometry: { type: "Point", coordinates: [0, 0] },
      },
      {
        type: "Feature",
        properties: { category: "b", value: 40 },
        geometry: { type: "Point", coordinates: [1, 1] },
      },
    ],
  };
}

function polygons(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
      },
    ],
  };
}

function mixedGeom(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [...points().features, ...polygons().features],
  };
}

function layerById(style_: ReturnType<typeof buildMapboxStyle>["style"], id: string) {
  return style_.layers.find((l) => l.id === id);
}

describe("buildMapboxStyle base document", () => {
  it("emits a version 8 style with the layer's features embedded", () => {
    const { style: doc, warnings } = buildMapboxStyle(layer(), points());
    assert.equal(doc.version, 8);
    assert.equal(doc.name, "My Layer");
    const sourceKey = Object.keys(doc.sources)[0];
    assert.equal(sourceKey, "my-layer-source");
    const source = doc.sources[sourceKey] as { type: string; data: unknown };
    assert.equal(source.type, "geojson");
    assert.deepEqual(source.data, points());
    assert.deepEqual(warnings, []);
    // Serializes to valid JSON.
    assert.doesNotThrow(() => JSON.parse(mapboxStyleToJson({ style: doc, warnings })));
  });

  it("emits a circle layer for point single symbology with a flat color", () => {
    const { style: doc } = buildMapboxStyle(
      layer({ style: style({ fillColor: "#ff0000" }) }),
      points(),
    );
    const circle = layerById(doc, "my-layer-circle");
    assert.ok(circle, "circle layer present");
    assert.equal(circle?.type, "circle");
    const paint = (circle as { paint: Record<string, unknown> }).paint;
    assert.equal(paint["circle-color"], "#ff0000");
  });
});

describe("data-driven renderers", () => {
  it("categorized maps to a match expression on circle-color", () => {
    const { style: doc } = buildMapboxStyle(
      layer({
        style: style({
          vectorStyleMode: "categorized",
          vectorStyleProperty: "category",
          vectorStyleStops: [
            { value: "a", color: "#111111" },
            { value: "b", color: "#222222" },
          ],
        }),
      }),
      points(),
    );
    const circle = layerById(doc, "my-layer-circle");
    const color = (circle as { paint: Record<string, unknown> }).paint["circle-color"];
    assert.ok(Array.isArray(color));
    assert.equal((color as unknown[])[0], "match");
  });

  it("graduated maps to an interpolate expression", () => {
    const { style: doc } = buildMapboxStyle(
      layer({
        style: style({
          vectorStyleMode: "graduated",
          vectorStyleProperty: "value",
          vectorStyleStops: [
            { value: 0, color: "#111111" },
            { value: 50, color: "#222222" },
          ],
        }),
      }),
      points(),
    );
    const color = (layerById(doc, "my-layer-circle") as { paint: Record<string, unknown> }).paint[
      "circle-color"
    ];
    assert.ok(Array.isArray(color));
    assert.equal((color as unknown[])[0], "interpolate");
  });

  it("rule-based maps to a case expression", () => {
    const { style: doc } = buildMapboxStyle(
      layer({
        style: style({
          vectorStyleMode: "rule-based",
          vectorRules: [
            {
              id: "r1",
              label: "big",
              filter: JSON.stringify([">", ["get", "value"], 10]),
              color: "#abcdef",
              isElse: false,
            },
            {
              id: "r2",
              label: "rest",
              filter: "",
              color: "#000000",
              isElse: true,
            },
          ],
        }),
      }),
      points(),
    );
    const color = (layerById(doc, "my-layer-circle") as { paint: Record<string, unknown> }).paint[
      "circle-color"
    ];
    assert.ok(Array.isArray(color));
    assert.equal((color as unknown[])[0], "case");
  });
});

describe("geometry handling", () => {
  it("emits fill + line for polygons", () => {
    const { style: doc } = buildMapboxStyle(layer(), polygons());
    assert.ok(layerById(doc, "my-layer-fill"), "fill layer");
    assert.ok(layerById(doc, "my-layer-line"), "line layer");
    assert.equal(layerById(doc, "my-layer-circle"), undefined);
  });

  it("emits a fill-extrusion layer when extrusion is enabled", () => {
    const { style: doc } = buildMapboxStyle(
      layer({ style: style({ extrusionEnabled: true }) }),
      polygons(),
    );
    assert.ok(layerById(doc, "my-layer-fill-extrusion"), "extrusion layer");
    assert.equal(layerById(doc, "my-layer-fill"), undefined);
    assert.equal(layerById(doc, "my-layer-line"), undefined);
  });

  it("without data emits fill, line, and circle as a safe superset and warns", () => {
    const { style: doc, warnings } = buildMapboxStyle(layer(), null);
    assert.ok(layerById(doc, "my-layer-fill"));
    assert.ok(layerById(doc, "my-layer-line"));
    assert.ok(layerById(doc, "my-layer-circle"));
    const source = doc.sources["my-layer-source"] as { data: FeatureCollection };
    assert.equal(source.data.features.length, 0);
    assert.ok(warnings.some((w) => w.includes("not embedded")));
  });
});

describe("point renderers", () => {
  it("emits a heatmap layer for a point-only heatmap renderer", () => {
    const { style: doc } = buildMapboxStyle(
      layer({ style: style({ pointRenderer: "heatmap" }) }),
      points(),
    );
    assert.ok(layerById(doc, "my-layer-heatmap"), "heatmap layer");
    assert.equal(layerById(doc, "my-layer-circle"), undefined);
  });

  it("falls back to plain points for a cluster renderer and warns", () => {
    const { style: doc, warnings } = buildMapboxStyle(
      layer({ style: style({ pointRenderer: "cluster" }) }),
      points(),
    );
    assert.ok(layerById(doc, "my-layer-circle"), "circle layer");
    assert.equal(layerById(doc, "my-layer-heatmap"), undefined);
    assert.ok(warnings.some((w) => w.toLowerCase().includes("cluster")));
  });

  it("ignores heatmap/cluster on mixed-geometry layers (renders single)", () => {
    const { style: doc } = buildMapboxStyle(
      layer({ style: style({ pointRenderer: "heatmap" }) }),
      mixedGeom(),
    );
    // A mixed layer keeps fill + line + a plain circle, never a heatmap.
    assert.ok(layerById(doc, "my-layer-fill"));
    assert.ok(layerById(doc, "my-layer-line"));
    assert.ok(layerById(doc, "my-layer-circle"));
    assert.equal(layerById(doc, "my-layer-heatmap"), undefined);
  });
});

describe("geometry-gated warnings", () => {
  it("does not warn about fill patterns on a point-only layer", () => {
    const { warnings } = buildMapboxStyle(
      layer({ style: style({ fillPattern: "hatch" }) }),
      points(),
    );
    assert.ok(!warnings.some((w) => w.toLowerCase().includes("fill pattern")));
  });

  it("only warns about dedupe on point-only layers", () => {
    const labels = {
      ...DEFAULT_LAYER_STYLE.labels,
      enabled: true,
      field: "category",
      dedupe: "unique" as const,
    };
    const mixed = buildMapboxStyle(layer({ style: style({ labels }) }), mixedGeom());
    assert.ok(!mixed.warnings.some((w) => w.toLowerCase().includes("duplicate-label")));
    const pointsOnly = buildMapboxStyle(layer({ style: style({ labels }) }), points());
    assert.ok(pointsOnly.warnings.some((w) => w.toLowerCase().includes("duplicate-label")));
  });

  it("does not warn about dedupe when labeling by expression (no field)", () => {
    const labels = {
      ...DEFAULT_LAYER_STYLE.labels,
      enabled: true,
      field: "",
      expression: JSON.stringify(["get", "name"]),
      dedupe: "unique" as const,
    };
    const { warnings } = buildMapboxStyle(layer({ style: style({ labels }) }), points());
    assert.ok(!warnings.some((w) => w.toLowerCase().includes("duplicate-label")));
  });
});

describe("glyphs dependency", () => {
  it("warns about the default demo font server when labels are enabled", () => {
    const { warnings } = buildMapboxStyle(
      layer({
        style: style({
          labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "category" },
        }),
      }),
      points(),
    );
    assert.ok(warnings.some((w) => w.toLowerCase().includes("font server")));
  });

  it("uses a custom glyphs URL without warning when provided", () => {
    const { style: doc, warnings } = buildMapboxStyle(
      layer({
        style: style({
          labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "category" },
        }),
      }),
      points(),
      { glyphsUrl: "https://fonts.example.com/{fontstack}/{range}.pbf" },
    );
    assert.equal(
      (doc as { glyphs?: string }).glyphs,
      "https://fonts.example.com/{fontstack}/{range}.pbf",
    );
    assert.ok(!warnings.some((w) => w.toLowerCase().includes("font server")));
  });

  it("treats a blank glyphsUrl as absent and keeps the default", () => {
    const { style: doc, warnings } = buildMapboxStyle(
      layer({
        style: style({
          labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "category" },
        }),
      }),
      points(),
      { glyphsUrl: "  " },
    );
    // Never writes an invalid empty glyphs; falls back to the default and warns.
    assert.ok((doc as { glyphs?: string }).glyphs?.startsWith("https://"));
    assert.ok(warnings.some((w) => w.toLowerCase().includes("font server")));
  });
});

describe("labels", () => {
  it("emits a symbol layer and a glyphs endpoint when labels are enabled", () => {
    const { style: doc } = buildMapboxStyle(
      layer({
        style: style({
          labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "category" },
        }),
      }),
      points(),
    );
    const label = layerById(doc, "my-layer-label");
    assert.ok(label, "label layer present");
    assert.equal(label?.type, "symbol");
    const textField = (label as { layout: Record<string, unknown> }).layout["text-field"];
    assert.ok(Array.isArray(textField));
    assert.ok(typeof (doc as { glyphs?: string }).glyphs === "string");
  });

  it("intersects the label zoom range with the layer's own zoom window", () => {
    const { style: doc } = buildMapboxStyle(
      layer({
        style: style({
          maxZoom: 10,
          labels: {
            ...DEFAULT_LAYER_STYLE.labels,
            enabled: true,
            field: "category",
            // default label range is 0/24, which should inherit the layer's max.
          },
        }),
      }),
      points(),
    );
    const label = layerById(doc, "my-layer-label") as {
      maxzoom?: number;
      minzoom?: number;
    };
    assert.equal(label.maxzoom, 10);
    assert.equal(label.minzoom, undefined);
  });

  it("suppresses labels on extruded layers, matching the live map", () => {
    const { style: doc } = buildMapboxStyle(
      layer({
        style: style({
          extrusionEnabled: true,
          labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "category" },
        }),
      }),
      polygons(),
    );
    assert.equal(layerById(doc, "my-layer-label"), undefined);
    assert.equal((doc as { glyphs?: string }).glyphs, undefined);
  });

  it("suppresses labels on heatmap layers, matching the live map", () => {
    const { style: doc } = buildMapboxStyle(
      layer({
        style: style({
          pointRenderer: "heatmap",
          labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "category" },
        }),
      }),
      points(),
    );
    assert.equal(layerById(doc, "my-layer-label"), undefined);
  });

  it("omits the label layer (and glyphs) when labels are disabled", () => {
    const { style: doc } = buildMapboxStyle(layer(), points());
    assert.equal(layerById(doc, "my-layer-label"), undefined);
    assert.equal((doc as { glyphs?: string }).glyphs, undefined);
  });
});

describe("graceful degradation warnings", () => {
  it("warns when a fill pattern is set", () => {
    const { warnings } = buildMapboxStyle(
      layer({ style: style({ fillPattern: "hatch" }) }),
      polygons(),
    );
    assert.ok(warnings.some((w) => w.toLowerCase().includes("fill pattern")));
  });

  it("warns when a custom marker is enabled", () => {
    const { warnings } = buildMapboxStyle(
      layer({ style: style({ markerEnabled: true }) }),
      points(),
    );
    assert.ok(warnings.some((w) => w.toLowerCase().includes("marker")));
  });

  it("honors layer visibility in the exported layout", () => {
    const { style: doc } = buildMapboxStyle(layer({ visible: false }), points());
    const circle = layerById(doc, "my-layer-circle") as {
      layout: Record<string, unknown>;
    };
    assert.equal(circle.layout.visibility, "none");
  });
});

describe("switched-off else rule (#1312)", () => {
  it("folds the hide-unmatched filter into every render layer", () => {
    const { style: doc } = buildMapboxStyle(
      layer({
        style: style({
          vectorStyleMode: "rule-based",
          vectorRules: [
            {
              id: "r1",
              label: "big",
              filter: JSON.stringify([">", ["get", "value"], 10]),
              color: "#abcdef",
              isElse: false,
            },
            {
              id: "r2",
              label: "",
              filter: "",
              color: "#000000",
              isElse: true,
              enabled: false,
            },
          ],
        }),
      }),
      points(),
    );
    const circle = layerById(doc, "my-layer-circle") as { filter: unknown };
    assert.deepEqual(circle.filter, [
      "all",
      ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
      ["any", [">", ["get", "value"], 10]],
    ]);
  });

  it("keeps the plain geometry filter while the else rule is enabled", () => {
    const { style: doc } = buildMapboxStyle(
      layer({
        style: style({
          vectorStyleMode: "rule-based",
          vectorRules: [
            {
              id: "r1",
              label: "big",
              filter: JSON.stringify([">", ["get", "value"], 10]),
              color: "#abcdef",
              isElse: false,
            },
            { id: "r2", label: "", filter: "", color: "#000000", isElse: true },
          ],
        }),
      }),
      points(),
    );
    const circle = layerById(doc, "my-layer-circle") as { filter: unknown };
    assert.deepEqual(circle.filter, [
      "match",
      ["geometry-type"],
      ["Point", "MultiPoint"],
      true,
      false,
    ]);
  });
});
