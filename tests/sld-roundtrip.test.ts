import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type LayerStyle, type VectorRule } from "@geolibre/core";
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
        ? {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          }
        : {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          };
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: geom }],
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
    assert.equal(out.vectorRules[0].filter, JSON.stringify(["==", ["get", "flag"], true]));
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

describe("SLD round-trip of extended rule-based symbology (#1305)", () => {
  it("preserves per-rule zoom ranges and symbol overrides (flattened nesting)", () => {
    const rules: VectorRule[] = [
      {
        id: "g",
        label: "Roads",
        filter: '["==", ["get", "class"], "road"]',
        color: "#111111",
        isElse: false,
      },
      {
        id: "hw",
        label: "Highway",
        filter: '["==", ["get", "type"], "hw"]',
        color: "#ff0000",
        isElse: false,
        parentId: "g",
        minZoom: 5,
        maxZoom: 12,
        strokeWidth: 5,
      },
      { id: "e", label: "Other", filter: "", color: "#cccccc", isElse: true },
    ];
    const input = style({ vectorStyleMode: "rule-based", vectorRules: rules });
    const { sld, warnings } = buildSld(layer(input), fc("polygon"));
    // Nesting has no SLD representation; the exporter reports the flattening.
    assert.ok(
      warnings.some((warning) => warning.includes("flattened")),
      warnings.join("; "),
    );
    const out = applySldImport(DEFAULT_LAYER_STYLE, parseSld(sld));
    assert.equal(out.vectorStyleMode, "rule-based");
    const concrete = out.vectorRules.filter((rule) => !rule.isElse);
    // The group itself does not draw; only the flattened leaf comes back, with
    // its parent's filter ANDed in.
    assert.equal(concrete.length, 1);
    const [hw] = concrete;
    assert.deepEqual(JSON.parse(hw.filter), [
      "all",
      ["==", ["get", "class"], "road"],
      ["==", ["get", "type"], "hw"],
    ]);
    assert.equal(hw.color, "#ff0000");
    assert.equal(hw.minZoom, 5);
    assert.equal(hw.maxZoom, 12);
    // The single rule's stroke width became the layer's flat width; the else
    // rule recovers the original width as an override. Rendered output is
    // identical to the input.
    assert.equal(out.strokeWidth, 5);
    assert.equal(hw.strokeWidth, undefined);
    const elseRule = out.vectorRules.find((rule) => rule.isElse);
    assert.equal(elseRule?.color, "#cccccc");
    assert.equal(elseRule?.strokeWidth, 2);
    // The layer window stays full-range even though one rule is zoom-bounded.
    assert.equal(out.minZoom, 0);
    assert.equal(out.maxZoom, 24);
  });

  it("preserves per-rule outline color and opacity on a polygon layer", () => {
    const rules: VectorRule[] = [
      {
        id: "a",
        label: "Zoned",
        filter: '["==", ["get", "zoned"], true]',
        color: "#ff0000",
        isElse: false,
        strokeColor: "#00ffff",
        fillOpacity: 0.3,
      },
      {
        id: "b",
        label: "Open",
        filter: '["==", ["get", "zoned"], false]',
        color: "#00ff00",
        isElse: false,
      },
      { id: "e", label: "", filter: "", color: "#cccccc", isElse: true },
    ];
    const input = style({ vectorStyleMode: "rule-based", vectorRules: rules });
    const out = roundTrip(input, "polygon");
    const [zoned, open] = out.vectorRules.filter((rule) => !rule.isElse);
    // First rule's symbol defines the flat layer style; the second and else
    // rules carry overrides restoring their original look.
    assert.equal(out.strokeColor, "#00ffff");
    assert.ok(Math.abs(out.fillOpacity - 0.3) < 1e-9);
    assert.equal(open.strokeColor, "#1e40af");
    assert.ok(Math.abs((open.fillOpacity ?? 0) - 0.6) < 1e-9);
    const elseRule = out.vectorRules.find((rule) => rule.isElse);
    assert.equal(elseRule?.strokeColor, "#1e40af");
    assert.ok(Math.abs((elseRule?.fillOpacity ?? 0) - 0.6) < 1e-9);
  });

  it("skips disabled rules on export with a warning", () => {
    const rules: VectorRule[] = [
      {
        id: "a",
        label: "On",
        filter: '["all", ["==", ["get", "a"], 1], ["==", ["get", "b"], 2]]',
        color: "#ff0000",
        isElse: false,
      },
      {
        id: "b",
        label: "Off",
        filter: '["==", ["get", "b"], 2]',
        color: "#00ff00",
        isElse: false,
        enabled: false,
      },
      { id: "e", label: "", filter: "", color: "#cccccc", isElse: true },
    ];
    const input = style({ vectorStyleMode: "rule-based", vectorRules: rules });
    const { sld, warnings } = buildSld(layer(input), fc("polygon"));
    assert.ok(warnings.some((warning) => warning.includes("Disabled rules")));
    const out = applySldImport(DEFAULT_LAYER_STYLE, parseSld(sld));
    const concrete = out.vectorRules.filter((rule) => !rule.isElse);
    assert.equal(concrete.length, 1);
    assert.equal(concrete[0].label, "On");
  });

  it("skips a rule whose zoom range lies outside the layer window", () => {
    const rules: VectorRule[] = [
      {
        id: "a",
        label: "Deep zoom",
        filter: '["all", ["==", ["get", "a"], 1], ["==", ["get", "b"], 2]]',
        color: "#ff0000",
        isElse: false,
        minZoom: 5,
        maxZoom: 10,
      },
      { id: "e", label: "", filter: "", color: "#cccccc", isElse: true },
    ];
    // Layer window [16, 24] never overlaps the rule window [5, 10): on the
    // live map the layer's zoom clipping hides the rule entirely, so the SLD
    // must not fabricate a visible scale range for it.
    const input = style({
      vectorStyleMode: "rule-based",
      vectorRules: rules,
      minZoom: 16,
      maxZoom: 24,
    });
    const { sld, warnings } = buildSld(layer(input), fc("polygon"));
    assert.ok(warnings.some((warning) => warning.includes("never visible")));
    assert.ok(!sld.includes("Deep zoom"));
  });

  it("a disabled else rule exports no catch-all rule (unmatched features hide, #1312)", () => {
    const rules: VectorRule[] = [
      {
        id: "a",
        label: "A",
        filter: '["all", ["==", ["get", "a"], 1], ["==", ["get", "b"], 2]]',
        color: "#ff0000",
        isElse: false,
      },
      {
        id: "e",
        label: "",
        filter: "",
        color: "#00ff00",
        isElse: true,
        enabled: false,
      },
    ];
    // Matching the live map: with the else rule switched off, features
    // matching no rule are hidden, and an SLD expresses that by having no
    // ElseFilter rule at all.
    const input = style({
      vectorStyleMode: "rule-based",
      vectorRules: rules,
      fillColor: "#123456",
    });
    const { sld } = buildSld(layer(input), fc("polygon"));
    assert.ok(!sld.includes("<ElseFilter/>"));
    assert.ok(!sld.includes("#00ff00"));
  });
});

describe("SLD round-trip of a switched-off else rule (#1312)", () => {
  it("omits the ElseFilter rule and re-imports as a disabled else record", () => {
    const input = style({
      vectorStyleMode: "rule-based",
      fillColor: "#dddddd",
      vectorRules: [
        {
          id: "a",
          label: "big",
          filter: JSON.stringify([">", ["get", "pop"], 1000000]),
          color: "#d62728",
          isElse: false,
        },
        {
          id: "else",
          label: "",
          filter: "",
          color: "#cccccc",
          isElse: true,
          enabled: false,
        },
      ],
    });
    const sld = buildSld(layer(input), fc("polygon"));
    // SLD expresses hidden-unmatched by simply having no ElseFilter rule.
    assert.ok(!sld.sld.includes("<ElseFilter"));
    const out = roundTrip(input, "polygon");
    assert.equal(out.vectorStyleMode, "rule-based");
    assert.equal(out.vectorRules.find((rule) => rule.isElse)?.enabled, false);
  });
});
