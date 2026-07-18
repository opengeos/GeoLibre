import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type LayerStyle, type VectorRule } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { buildQml, type QmlExportableLayer } from "../packages/map/src/qml-export";
import { applyQmlImport, parseQml } from "../packages/map/src/qml-import";

function style(patch: Partial<LayerStyle> = {}): LayerStyle {
  return { ...DEFAULT_LAYER_STYLE, ...patch };
}

function layer(style_: LayerStyle): QmlExportableLayer {
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

function roundTrip(input: LayerStyle, geometry: Geometry): LayerStyle {
  const { qml } = buildQml(layer(input), fc(geometry));
  const parsed = parseQml(qml);
  return applyQmlImport(DEFAULT_LAYER_STYLE, parsed);
}

/** Alpha folds fillOpacity into an 8-bit channel, so a round-tripped opacity is
 * only accurate to ~1/255; compare within that tolerance. */
function approx(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1 / 255 + 1e-9;
}

describe("QML round-trip (style → QML → style)", () => {
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
    assert.ok(approx(out.fillOpacity, 0.55));
    assert.equal(out.strokeColor, "#1d3557");
    assert.equal(out.strokeWidth, 4);
  });

  it("preserves a line layer's stroke color and width", () => {
    const input = style({ strokeColor: "#e63946", strokeWidth: 3 });
    const out = roundTrip(input, "line");
    // A line symbol's color must round-trip through strokeColor, not fillColor.
    assert.equal(out.strokeColor, "#e63946");
    assert.equal(out.strokeWidth, 3);
  });

  it("preserves a point circle radius", () => {
    const input = style({ circleRadius: 7, fillColor: "#457b9d" });
    const out = roundTrip(input, "point");
    assert.equal(out.circleRadius, 7);
    assert.equal(out.fillColor, "#457b9d");
    assert.notEqual(out.markerEnabled, true);
  });

  it("preserves a shape marker", () => {
    const input = style({
      markerEnabled: true,
      markerShape: "diamond",
      markerColor: "#ff8800",
      markerSize: 22,
    });
    const out = roundTrip(input, "point");
    assert.equal(out.markerEnabled, true);
    assert.equal(out.markerShape, "diamond");
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
      ],
    });
    const out = roundTrip(input, "polygon");
    assert.equal(out.vectorStyleMode, "categorized");
    assert.equal(out.vectorStyleProperty, "landuse");
    assert.deepEqual(out.vectorStyleStops, input.vectorStyleStops);
    assert.equal(out.fillColor, "#999999");
  });

  it("preserves a categorized renderer on a line layer", () => {
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
    assert.deepEqual(out.vectorStyleStops, input.vectorStyleStops);
  });

  it("preserves graduated stop values and colors", () => {
    const input = style({
      vectorStyleMode: "graduated",
      vectorStyleProperty: "density",
      vectorStyleStops: [
        { value: 0, color: "#f7fbff" },
        { value: 25, color: "#6baed6" },
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
          label: "big",
          filter: JSON.stringify([">", ["get", "pop"], 1000000]),
          color: "#d62728",
          isElse: false,
        },
        {
          id: "b",
          label: "cap",
          filter: JSON.stringify(["==", ["get", "capital"], "yes"]),
          color: "#1f77b4",
          isElse: false,
        },
        { id: "else", label: "", filter: "", color: "#cccccc", isElse: true },
      ],
    });
    const out = roundTrip(input, "point");
    assert.equal(out.vectorStyleMode, "rule-based");
    assert.equal(out.vectorRules.length, 3);
    assert.equal(out.vectorRules[0].filter, JSON.stringify([">", ["get", "pop"], 1000000]));
    assert.equal(out.vectorRules[0].label, "big");
    assert.equal(out.vectorRules[1].filter, JSON.stringify(["==", ["get", "capital"], "yes"]));
    assert.equal(out.vectorRules[2].isElse, true);
    assert.equal(out.vectorRules[2].color, "#cccccc");
  });

  it("preserves an all/not filter rule semantically", () => {
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
});

describe("QML round-trip of extended rule-based symbology (#1305)", () => {
  it("preserves nesting, zoom ranges, toggles, and symbol overrides", () => {
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
        strokeColor: "#00ffff",
      },
      {
        id: "minor",
        label: "Minor",
        filter: '["==", ["get", "type"], "minor"]',
        color: "#00ff00",
        isElse: false,
        parentId: "g",
        enabled: false,
      },
      { id: "e", label: "Other", filter: "", color: "#cccccc", isElse: true },
    ];
    const input = style({ vectorStyleMode: "rule-based", vectorRules: rules });
    const out = roundTrip(input, "polygon");
    assert.equal(out.vectorStyleMode, "rule-based");
    const concrete = out.vectorRules.filter((rule) => !rule.isElse);
    assert.equal(concrete.length, 3);
    const [group, hw, minor] = concrete;
    assert.equal(group.label, "Roads");
    assert.equal(hw.parentId, group.id);
    assert.equal(minor.parentId, group.id);
    assert.equal(hw.color, "#ff0000");
    assert.equal(hw.minZoom, 5);
    assert.equal(hw.maxZoom, 12);
    // The first leaf's symbol becomes the layer's flat style, so its own
    // overrides normalize away while the other rules (and the else rule)
    // recover the original layer stroke as per-rule overrides. The rendered
    // result is identical to the input.
    assert.equal(out.strokeWidth, 5);
    assert.equal(out.strokeColor, "#00ffff");
    assert.equal(hw.strokeWidth, undefined);
    assert.equal(hw.strokeColor, undefined);
    assert.equal(minor.enabled, false);
    assert.equal(minor.strokeWidth, 2);
    assert.equal(minor.strokeColor, "#1e40af");
    const elseRule = out.vectorRules.find((rule) => rule.isElse);
    assert.equal(elseRule?.color, "#cccccc");
    assert.equal(elseRule?.label, "Other");
    assert.equal(elseRule?.strokeWidth, 2);
    assert.equal(elseRule?.strokeColor, "#1e40af");
  });

  it("preserves a per-rule circle size override on a point layer", () => {
    const rules: VectorRule[] = [
      {
        id: "a",
        label: "Capital",
        filter: '["==", ["get", "capital"], true]',
        color: "#ff0000",
        isElse: false,
        circleRadius: 12,
        fillOpacity: 0.4,
      },
      {
        id: "b",
        label: "City",
        filter: '["==", ["get", "capital"], false]',
        color: "#00ff00",
        isElse: false,
      },
      { id: "e", label: "", filter: "", color: "#cccccc", isElse: true },
    ];
    const input = style({ vectorStyleMode: "rule-based", vectorRules: rules });
    const out = roundTrip(input, "point");
    const [capital, city] = out.vectorRules.filter((rule) => !rule.isElse);
    // The first rule's symbol becomes the layer's flat style, so its own
    // values import override-free while the second rule and the else rule pick
    // up overrides that restore their original look.
    assert.equal(out.circleRadius, 12);
    assert.equal(capital.circleRadius, undefined);
    assert.equal(city.circleRadius, 6);
    const elseRule = out.vectorRules.find((rule) => rule.isElse);
    assert.equal(elseRule?.circleRadius, 6);
    assert.ok(Math.abs((elseRule?.fillOpacity ?? 0) - 0.6) <= 1 / 255 + 1e-9);
  });

  it("round-trips a disabled else rule via checkstate", () => {
    const rules: VectorRule[] = [
      {
        id: "a",
        label: "A",
        filter: '["==", ["get", "x"], 1]',
        color: "#ff0000",
        isElse: false,
      },
      {
        id: "e",
        label: "",
        filter: "",
        color: "#cccccc",
        isElse: true,
        enabled: false,
      },
    ];
    const input = style({ vectorStyleMode: "rule-based", vectorRules: rules });
    const out = roundTrip(input, "polygon");
    const elseRule = out.vectorRules.find((rule) => rule.isElse);
    assert.equal(elseRule?.enabled, false);
  });
});

describe("QML round-trip of a switched-off else rule (#1312)", () => {
  it("keeps the else rule disabled so unmatched features stay hidden", () => {
    const input = style({
      vectorStyleMode: "rule-based",
      vectorRules: [
        {
          id: "a",
          label: "big",
          filter: JSON.stringify([">", ["get", "pop"], 1000]),
          color: "#d62728",
          isElse: false,
        },
        {
          id: "e",
          label: "",
          filter: "",
          color: "#cccccc",
          isElse: true,
          enabled: false,
        },
      ],
    });
    const out = roundTrip(input, "polygon");
    assert.equal(out.vectorStyleMode, "rule-based");
    assert.equal(out.vectorRules.find((rule) => rule.isElse)?.enabled, false);
  });
});
