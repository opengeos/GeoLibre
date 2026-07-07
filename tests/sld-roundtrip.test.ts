import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type LayerStyle } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { buildSld, type SldExportableLayer } from "../packages/map/src/sld-export";
import { applySldImport, parseSld } from "../packages/map/src/sld-import";

function style(patch: Partial<LayerStyle> = {}): LayerStyle {
  return { ...DEFAULT_LAYER_STYLE, ...patch };
}

function layer(style_: LayerStyle): SldExportableLayer {
  return {
    id: "layer-1",
    name: "Round Trip",
    type: "geojson",
    opacity: 1,
    visible: true,
    style: style_,
  };
}

type Geometry = "point" | "polygon" | "line";

function fc(geometry: Geometry): FeatureCollection {
  const geom: FeatureCollection["features"][number]["geometry"] =
    geometry === "point"
      ? { type: "Point", coordinates: [0, 0] }
      : geometry === "line"
        ? { type: "LineString", coordinates: [[0, 0], [1, 1]] }
        : { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry }],
  };
}

/** Export a style to SLD, re-import it, and merge back onto the defaults. */
function roundTrip(input: LayerStyle, geometry: Geometry): LayerStyle {
  const { sld } = buildSld(layer(input), fc(geometry));
  const parsed = parseSld(sld);
  return applySldImport(DEFAULT_LAYER_STYLE, parsed);
}

describe("SLD round-trip (style → SLD → style)", () => {
  it("preserves a single-symbol polygon style", () => {
    const input = style({
      fillColor: "#e63946",
      fillOpacity: 0.55,
      strokeColor: "#1d3557",
      strokeWidth: 4,
    });
    const out = roundTrip(input, "polygon");
    assert.equal(out.vectorStyleMode, "single");
    assert.equal(out.fillColor, "#e63946");
    assert.equal(out.fillOpacity, 0.55);
    assert.equal(out.strokeColor, "#1d3557");
    assert.equal(out.strokeWidth, 4);
  });

  it("preserves a point radius", () => {
    const input = style({ circleRadius: 7, fillColor: "#457b9d" });
    const out = roundTrip(input, "point");
    assert.equal(out.circleRadius, 7);
    assert.equal(out.fillColor, "#457b9d");
  });

  it("preserves a point stroke width (not clamped to a hairline)", () => {
    const input = style({ circleRadius: 6, strokeWidth: 5, strokeColor: "#222222" });
    const out = roundTrip(input, "point");
    assert.equal(out.strokeWidth, 5);
    assert.equal(out.strokeColor, "#222222");
  });

  it("preserves a shape marker", () => {
    const input = style({
      markerEnabled: true,
      markerShape: "star",
      markerColor: "#ff8800",
      markerSize: 22,
    });
    const out = roundTrip(input, "point");
    assert.equal(out.markerEnabled, true);
    assert.equal(out.markerShape, "star");
    assert.equal(out.markerColor, "#ff8800");
    assert.equal(out.markerSize, 22);
  });

  it("preserves a categorized renderer", () => {
    const input = style({
      vectorStyleMode: "categorized",
      vectorStyleProperty: "landuse",
      fillColor: "#999999",
      vectorStyleStops: [
        { value: "residential", color: "#ffcc00" },
        { value: "commercial", color: "#cc0000" },
        { value: "industrial", color: "#663399" },
      ],
    });
    const out = roundTrip(input, "polygon");
    assert.equal(out.vectorStyleMode, "categorized");
    assert.equal(out.vectorStyleProperty, "landuse");
    assert.deepEqual(out.vectorStyleStops, input.vectorStyleStops);
    assert.equal(out.fillColor, "#999999");
  });

  it("preserves a categorized renderer on a line layer (per-class line color)", () => {
    const input = style({
      vectorStyleMode: "categorized",
      vectorStyleProperty: "road",
      fillColor: "#999999",
      vectorStyleStops: [
        { value: "primary", color: "#e41a1c" },
        { value: "secondary", color: "#377eb8" },
      ],
    });
    const out = roundTrip(input, "line");
    assert.equal(out.vectorStyleMode, "categorized");
    assert.equal(out.vectorStyleProperty, "road");
    // The per-class colors come back from the LineSymbolizer strokes.
    assert.deepEqual(out.vectorStyleStops, input.vectorStyleStops);
  });

  it("preserves graduated stop values and colors as class breaks", () => {
    const input = style({
      vectorStyleMode: "graduated",
      vectorStyleProperty: "density",
      vectorStyleStops: [
        { value: 0, color: "#f7fbff" },
        { value: 25, color: "#6baed6" },
        { value: 75, color: "#2171b5" },
        { value: 150, color: "#08306b" },
      ],
    });
    const out = roundTrip(input, "polygon");
    assert.equal(out.vectorStyleMode, "graduated");
    assert.equal(out.vectorStyleProperty, "density");
    assert.deepEqual(out.vectorStyleStops, input.vectorStyleStops);
  });

  it("preserves a rule-based renderer with translatable filters", () => {
    const input = style({
      vectorStyleMode: "rule-based",
      fillColor: "#dddddd",
      vectorRules: [
        {
          id: "a",
          label: "big cities",
          filter: JSON.stringify([">", ["get", "pop"], 1000000]),
          color: "#d62728",
          isElse: false,
        },
        {
          id: "b",
          label: "capitals",
          filter: JSON.stringify(["==", ["get", "capital"], "yes"]),
          color: "#1f77b4",
          isElse: false,
        },
        { id: "else", label: "", filter: "", color: "#cccccc", isElse: true },
      ],
    });
    const out = roundTrip(input, "point");
    assert.equal(out.vectorStyleMode, "rule-based");
    const rules = out.vectorRules;
    // Two rules plus the else rule survive.
    assert.equal(rules.length, 3);
    assert.equal(rules[0].filter, JSON.stringify([">", ["get", "pop"], 1000000]));
    assert.equal(rules[0].color, "#d62728");
    assert.equal(rules[1].filter, JSON.stringify(["==", ["get", "capital"], "yes"]));
    assert.equal(rules[2].isElse, true);
    assert.equal(rules[2].color, "#cccccc");
  });

  it("preserves per-rule labels in a rule-based renderer", () => {
    const input = style({
      vectorStyleMode: "rule-based",
      fillColor: "#dddddd",
      vectorRules: [
        {
          id: "a",
          label: "Big cities",
          filter: JSON.stringify([">", ["get", "pop"], 1000000]),
          color: "#d62728",
          isElse: false,
        },
        { id: "else", label: "", filter: "", color: "#cccccc", isElse: true },
      ],
    });
    const out = roundTrip(input, "point");
    assert.equal(out.vectorRules[0].label, "Big cities");
  });

  it("preserves a custom categorized stop label", () => {
    const input = style({
      vectorStyleMode: "categorized",
      vectorStyleProperty: "zone",
      fillColor: "#999999",
      vectorStyleStops: [
        { value: "a", color: "#ff0000", label: "Zone A" },
        { value: "b", color: "#00ff00" },
      ],
    });
    const out = roundTrip(input, "polygon");
    assert.deepEqual(out.vectorStyleStops, input.vectorStyleStops);
  });

  it("preserves an all/not filter rule (semantically)", () => {
    const input = style({
      vectorStyleMode: "rule-based",
      fillColor: "#dddddd",
      vectorRules: [
        {
          id: "a",
          label: "",
          filter: JSON.stringify([
            "all",
            ["==", ["get", "type"], "city"],
            ["!", ["==", ["get", "hidden"], "yes"]],
          ]),
          color: "#d62728",
          isElse: false,
        },
        { id: "else", label: "", filter: "", color: "#cccccc", isElse: true },
      ],
    });
    const out = roundTrip(input, "point");
    assert.equal(out.vectorStyleMode, "rule-based");
    assert.equal(
      out.vectorRules[0].filter,
      JSON.stringify([
        "all",
        ["==", ["get", "type"], "city"],
        ["!", ["==", ["get", "hidden"], "yes"]],
      ]),
    );
  });

  it("preserves a boolean filter literal in a rule-based renderer", () => {
    // A second, non-equality rule keeps this a rule-based renderer (a lone `==`
    // rule is indistinguishable from a one-category categorized renderer).
    const input = style({
      vectorStyleMode: "rule-based",
      fillColor: "#dddddd",
      vectorRules: [
        {
          id: "a",
          label: "",
          filter: JSON.stringify(["==", ["get", "flag"], true]),
          color: "#d62728",
          isElse: false,
        },
        {
          id: "b",
          label: "",
          filter: JSON.stringify([">", ["get", "n"], 5]),
          color: "#1f77b4",
          isElse: false,
        },
        { id: "else", label: "", filter: "", color: "#cccccc", isElse: true },
      ],
    });
    const out = roundTrip(input, "point");
    assert.equal(out.vectorStyleMode, "rule-based");
    assert.equal(
      out.vectorRules[0].filter,
      JSON.stringify(["==", ["get", "flag"], true]),
    );
  });

  it("round-trips a circle marker as a plain circle without corrupting the stroke", () => {
    const input = style({
      markerEnabled: true,
      markerShape: "circle",
      markerColor: "#ff8800",
      strokeColor: "#123456",
      strokeWidth: 2,
    });
    const out = roundTrip(input, "point");
    // A circle marker is indistinguishable from a plain circle in SLD, so it
    // comes back as a plain circle — but the real stroke is not clobbered with
    // the white marker halo.
    assert.equal(out.strokeColor, "#123456");
    assert.notEqual(out.strokeColor, "#ffffff");
  });

  it("preserves labels", () => {
    const input = style({
      labels: {
        ...DEFAULT_LAYER_STYLE.labels,
        enabled: true,
        field: "name",
        size: 15,
        color: "#202020",
        haloColor: "#fefefe",
        haloWidth: 2,
      },
    });
    const out = roundTrip(input, "polygon");
    assert.equal(out.labels.enabled, true);
    assert.equal(out.labels.field, "name");
    assert.equal(out.labels.size, 15);
    assert.equal(out.labels.color, "#202020");
    assert.equal(out.labels.haloColor, "#fefefe");
    assert.equal(out.labels.haloWidth, 2);
  });

  it("preserves a narrowed zoom window", () => {
    const input = style({ minZoom: 5, maxZoom: 14 });
    const out = roundTrip(input, "polygon");
    assert.equal(out.minZoom, 5);
    assert.equal(out.maxZoom, 14);
  });
});
