import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type LayerStyle } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  buildSld,
  OGC_SCALE_DENOMINATOR_AT_ZOOM_0,
  type SldExportableLayer,
} from "../packages/map/src/sld-export";

function style(patch: Partial<LayerStyle> = {}): LayerStyle {
  return { ...DEFAULT_LAYER_STYLE, ...patch };
}

/** Collapse the pretty-printer's inter-tag whitespace so compound tag patterns
 * (e.g. `<A><B>…</B></A>`) match regardless of formatting. */
function compact(sld: string): string {
  return sld.replace(/>\s+</g, "><");
}

function layer(
  patch: Partial<SldExportableLayer> & { style?: LayerStyle } = {},
): SldExportableLayer {
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
          coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
        },
      },
    ],
  };
}

describe("buildSld", () => {
  it("emits a well-formed SLD 1.0.0 document", () => {
    const { sld, warnings } = buildSld(layer(), polygons());
    assert.match(sld, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(sld, /<StyledLayerDescriptor version="1\.0\.0"/);
    assert.match(sld, /xmlns:ogc="http:\/\/www\.opengis\.net\/ogc"/);
    assert.match(sld, /<NamedLayer>[\s\S]*<Name>My Layer<\/Name>/);
    assert.match(sld, /<UserStyle>/);
    assert.match(sld, /<FeatureTypeStyle>/);
    assert.deepEqual(warnings, []);
  });

  it("writes a PolygonSymbolizer with fill and stroke for polygons", () => {
    const { sld } = buildSld(
      layer({ style: style({ fillColor: "#ff0000", strokeColor: "#00ff00", strokeWidth: 3 }) }),
      polygons(),
    );
    assert.match(sld, /<PolygonSymbolizer>/);
    assert.match(sld, /<CssParameter name="fill">#ff0000<\/CssParameter>/);
    assert.match(sld, /<CssParameter name="stroke">#00ff00<\/CssParameter>/);
    assert.match(sld, /<CssParameter name="stroke-width">3<\/CssParameter>/);
    // A polygon layer has no PointSymbolizer.
    assert.doesNotMatch(sld, /<PointSymbolizer>/);
  });

  it("writes a PointSymbolizer with a circle mark sized to the diameter", () => {
    const { sld } = buildSld(
      layer({ style: style({ circleRadius: 8 }) }),
      points(),
    );
    assert.match(compact(sld), /<PointSymbolizer><Graphic><Mark>/);
    assert.match(sld, /<WellKnownName>circle<\/WellKnownName>/);
    // circleRadius 8 → diameter 16.
    assert.match(sld, /<Size>16<\/Size>/);
    assert.doesNotMatch(sld, /<PolygonSymbolizer>/);
  });

  it("folds the layer opacity into the point mark outline opacity", () => {
    const { sld } = buildSld(layer({ opacity: 0.5 }), points());
    // The mark's Stroke carries the folded stroke-opacity like the other symbolizers.
    assert.match(
      compact(sld),
      /<Mark>.*<Stroke>.*<CssParameter name="stroke-opacity">0\.5<\/CssParameter>/,
    );
  });

  it("folds the layer opacity into the fill opacity", () => {
    const { sld } = buildSld(
      layer({ opacity: 0.5, style: style({ fillOpacity: 0.6 }) }),
      polygons(),
    );
    // 0.6 * 0.5 = 0.3.
    assert.match(sld, /<CssParameter name="fill-opacity">0\.3<\/CssParameter>/);
  });

  it("maps a categorized renderer to PropertyIsEqualTo rules plus an ElseFilter", () => {
    const { sld } = buildSld(
      layer({
        style: style({
          vectorStyleMode: "categorized",
          vectorStyleProperty: "type",
          fillColor: "#cccccc",
          vectorStyleStops: [
            { value: "park", color: "#00ff00" },
            { value: "lake", color: "#0000ff" },
          ],
        }),
      }),
      polygons(),
    );
    assert.match(compact(sld), /<ogc:PropertyIsEqualTo><ogc:PropertyName>type<\/ogc:PropertyName><ogc:Literal>park<\/ogc:Literal>/);
    assert.match(compact(sld), /<ogc:Literal>lake<\/ogc:Literal>/);
    assert.match(sld, /<ElseFilter\/>/);
    // The else rule carries the fallback color.
    assert.match(sld, /<CssParameter name="fill">#cccccc<\/CssParameter>/);
  });

  it("does not emit a LineSymbolizer for a polygon-only layer", () => {
    // The PolygonSymbolizer's own Stroke draws the border; a separate
    // LineSymbolizer would draw it twice.
    const { sld } = buildSld(layer(), polygons());
    assert.match(sld, /<PolygonSymbolizer>/);
    assert.doesNotMatch(sld, /<LineSymbolizer>/);
  });

  it("emits a LineSymbolizer for line geometry", () => {
    const lines: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
        },
      ],
    };
    const { sld } = buildSld(layer(), lines);
    assert.match(sld, /<LineSymbolizer>/);
    assert.doesNotMatch(sld, /<PolygonSymbolizer>/);
  });

  it("deduplicates a per-rule warning across a multi-rule renderer", () => {
    const { warnings } = buildSld(
      layer({
        style: style({
          vectorStyleMode: "categorized",
          vectorStyleProperty: "zone",
          markerEnabled: true,
          markerShape: "diamond", // no SLD WellKnownName → warns per point rule
          vectorStyleStops: [
            { value: "a", color: "#111111" },
            { value: "b", color: "#222222" },
          ],
        }),
      }),
      points(),
    );
    const markerWarnings = warnings.filter((w) => /diamond/.test(w));
    assert.equal(markerWarnings.length, 1);
  });

  it("emits a below-first-break guard rule for a graduated renderer", () => {
    const { sld } = buildSld(
      layer({
        style: style({
          vectorStyleMode: "graduated",
          vectorStyleProperty: "pop",
          vectorStyleStops: [
            { value: 10, color: "#eeeeee" },
            { value: 100, color: "#111111" },
          ],
        }),
      }),
      polygons(),
    );
    // A leading `< 10` rule clamps below-minimum features to the first color.
    assert.match(
      compact(sld),
      /<ogc:PropertyIsLessThan><ogc:PropertyName>pop<\/ogc:PropertyName><ogc:Literal>10<\/ogc:Literal>/,
    );
  });

  it("skips categorized stops with an invalid color", () => {
    const { sld } = buildSld(
      layer({
        style: style({
          vectorStyleMode: "categorized",
          vectorStyleProperty: "zone",
          vectorStyleStops: [
            { value: "a", color: "#112233" },
            { value: "b", color: "not-a-color" },
          ],
        }),
      }),
      polygons(),
    );
    assert.match(compact(sld), /<ogc:Literal>a<\/ogc:Literal>/);
    assert.doesNotMatch(compact(sld), /<ogc:Literal>b<\/ogc:Literal>/);
  });

  it("translates all/any/not/in rule filters to ogc predicates", () => {
    const { sld } = buildSld(
      layer({
        style: style({
          vectorStyleMode: "rule-based",
          vectorRules: [
            {
              id: "r1",
              label: "",
              filter: JSON.stringify([
                "all",
                ["==", ["get", "a"], "x"],
                ["!", ["==", ["get", "b"], "y"]],
                ["in", ["get", "c"], 1, 2],
              ]),
              color: "#ff0000",
              isElse: false,
            },
            { id: "else", label: "", filter: "", color: "#dddddd", isElse: true },
          ],
        }),
      }),
      polygons(),
    );
    assert.match(compact(sld), /<ogc:And>/);
    assert.match(compact(sld), /<ogc:Not>/);
    // `in` expands to an Or of equality tests.
    assert.match(compact(sld), /<ogc:Or>/);
  });

  it("skips a rule whose filter has no SLD equivalent, with a warning", () => {
    const { sld, warnings } = buildSld(
      layer({
        style: style({
          vectorStyleMode: "rule-based",
          vectorRules: [
            {
              id: "r1",
              label: "bad",
              // `>` needs a scalar literal, not another expression → untranslatable.
              filter: JSON.stringify([">", ["get", "a"], ["get", "b"]]),
              color: "#ff0000",
              isElse: false,
            },
            { id: "else", label: "", filter: "", color: "#dddddd", isElse: true },
          ],
        }),
      }),
      polygons(),
    );
    assert.ok(warnings.some((w) => /no SLD equivalent/.test(w)));
    // Only the else rule remains.
    assert.match(sld, /<ElseFilter\/>/);
  });

  it("skips a rule-based rule with an invalid color", () => {
    const { sld } = buildSld(
      layer({
        style: style({
          vectorStyleMode: "rule-based",
          vectorRules: [
            {
              id: "r1",
              label: "",
              filter: JSON.stringify(["==", ["get", "a"], "x"]),
              color: "not-a-color",
              isElse: false,
            },
            {
              id: "r2",
              label: "",
              filter: JSON.stringify(["==", ["get", "a"], "y"]),
              color: "#00ff00",
              isElse: false,
            },
            { id: "else", label: "", filter: "", color: "#dddddd", isElse: true },
          ],
        }),
      }),
      polygons(),
    );
    // The invalid-color rule is dropped; the valid one survives.
    assert.doesNotMatch(compact(sld), /<ogc:Literal>x<\/ogc:Literal>/);
    assert.match(compact(sld), /<ogc:Literal>y<\/ogc:Literal>/);
  });

  it("translates the modern two-operand `in` filter form", () => {
    const { sld } = buildSld(
      layer({
        style: style({
          vectorStyleMode: "rule-based",
          vectorRules: [
            {
              id: "r1",
              label: "",
              filter: JSON.stringify([
                "in",
                ["get", "t"],
                ["literal", ["a", "b"]],
              ]),
              color: "#ff0000",
              isElse: false,
            },
            { id: "else", label: "", filter: "", color: "#dddddd", isElse: true },
          ],
        }),
      }),
      polygons(),
    );
    // The two literal-array members expand to equality tests, not a stringified
    // "a,b".
    assert.match(compact(sld), /<ogc:Literal>a<\/ogc:Literal>/);
    assert.match(compact(sld), /<ogc:Literal>b<\/ogc:Literal>/);
    assert.doesNotMatch(compact(sld), /<ogc:Literal>a,b<\/ogc:Literal>/);
  });

  it("warns for heatmap and cluster point renderers", () => {
    const heat = buildSld(
      layer({ style: style({ pointRenderer: "heatmap" }) }),
      points(),
    );
    assert.ok(heat.warnings.some((w) => /heatmap/.test(w)));
    const cluster = buildSld(
      layer({ style: style({ pointRenderer: "cluster" }) }),
      points(),
    );
    assert.ok(cluster.warnings.some((w) => /cluster/.test(w)));
  });

  it("maps a graduated renderer to class-break ranges and warns", () => {
    const { sld, warnings } = buildSld(
      layer({
        style: style({
          vectorStyleMode: "graduated",
          vectorStyleProperty: "pop",
          vectorStyleStops: [
            { value: 0, color: "#eeeeee" },
            { value: 100, color: "#888888" },
            { value: 1000, color: "#111111" },
          ],
        }),
      }),
      polygons(),
    );
    assert.match(compact(sld), /<ogc:PropertyIsGreaterThanOrEqualTo><ogc:PropertyName>pop<\/ogc:PropertyName><ogc:Literal>0<\/ogc:Literal>/);
    assert.match(compact(sld), /<ogc:PropertyIsLessThan><ogc:PropertyName>pop<\/ogc:PropertyName><ogc:Literal>100<\/ogc:Literal>/);
    assert.ok(warnings.some((w) => /discrete SLD class breaks/.test(w)));
  });

  it("translates a rule-based renderer's filters to ogc:Filter", () => {
    const { sld } = buildSld(
      layer({
        style: style({
          vectorStyleMode: "rule-based",
          vectorRules: [
            {
              id: "r1",
              label: "Big",
              filter: JSON.stringify([">", ["get", "pop"], 1000]),
              color: "#ff0000",
              isElse: false,
            },
            { id: "else", label: "", filter: "", color: "#dddddd", isElse: true },
          ],
        }),
      }),
      polygons(),
    );
    assert.match(compact(sld), /<ogc:PropertyIsGreaterThan><ogc:PropertyName>pop<\/ogc:PropertyName><ogc:Literal>1000<\/ogc:Literal>/);
    assert.match(sld, /<ElseFilter\/>/);
  });

  it("uses the layer stroke (not fill) for the rule-based else line color", () => {
    const lines: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
        },
      ],
    };
    const { sld } = buildSld(
      layer({
        style: style({
          vectorStyleMode: "rule-based",
          fillColor: "#111111",
          strokeColor: "#222222",
          vectorRules: [
            {
              id: "r1",
              label: "",
              filter: JSON.stringify(["==", ["get", "a"], "x"]),
              color: "#ff0000",
              isElse: false,
            },
            // No else rule, so the else line color must fall back to strokeColor.
          ],
        }),
      }),
      lines,
    );
    // The Other rule's LineSymbolizer uses strokeColor (#222222), not fillColor.
    assert.match(compact(sld), /<CssParameter name="stroke">#222222<\/CssParameter>/);
  });

  it("degrades an expression renderer to a single symbol with a warning", () => {
    const { sld, warnings } = buildSld(
      layer({
        style: style({
          vectorStyleMode: "expression",
          vectorStyleExpression: JSON.stringify(["get", "color"]),
          fillColor: "#abcdef",
        }),
      }),
      polygons(),
    );
    assert.match(sld, /<CssParameter name="fill">#abcdef<\/CssParameter>/);
    assert.ok(warnings.some((w) => /custom color expression has no SLD/.test(w)));
    assert.doesNotMatch(sld, /<ogc:Filter>/);
  });

  it("writes a TextSymbolizer when labels are enabled", () => {
    const { sld } = buildSld(
      layer({
        style: style({
          labels: {
            ...DEFAULT_LAYER_STYLE.labels,
            enabled: true,
            field: "name",
            size: 14,
            color: "#222222",
          },
        }),
      }),
      polygons(),
    );
    assert.match(sld, /<TextSymbolizer>/);
    assert.match(compact(sld), /<Label><ogc:PropertyName>name<\/ogc:PropertyName><\/Label>/);
    assert.match(sld, /<CssParameter name="font-size">14<\/CssParameter>/);
  });

  it("emits scale denominators only for a narrowed zoom window", () => {
    const full = buildSld(layer(), polygons()).sld;
    assert.doesNotMatch(full, /ScaleDenominator/);

    const { sld } = buildSld(
      layer({ style: style({ minZoom: 4, maxZoom: 12 }) }),
      polygons(),
    );
    const minAtZoom12 = OGC_SCALE_DENOMINATOR_AT_ZOOM_0 / 2 ** 12;
    assert.match(sld, /<MinScaleDenominator>/);
    assert.match(sld, /<MaxScaleDenominator>/);
    assert.ok(sld.includes(String(Number(minAtZoom12.toFixed(6)))));
  });

  it("warns for meters-scaled and proportional (data-driven) sizing", () => {
    const meters = buildSld(
      layer({ style: style({ strokeWidthUnit: "meters" }) }),
      polygons(),
    );
    assert.ok(meters.warnings.some((w) => /map units \(meters\)/.test(w)));
    const proportional = buildSld(
      layer({
        style: style({
          proportionalSizeEnabled: true,
          proportionalSizeProperty: "pop",
        }),
      }),
      points(),
    );
    assert.ok(
      proportional.warnings.some((w) => /Proportional .*symbol size/.test(w)),
    );
  });

  it("does not crash on an invalid (non-string) stop color", () => {
    // Reachable via a hand-edited .geolibre.json; the exporter must not throw.
    const { sld } = buildSld(
      layer({
        style: style({
          vectorStyleMode: "categorized",
          vectorStyleProperty: "zone",
          vectorStyleStops: [
            { value: "a", color: "#112233" },
            // deliberately malformed to exercise the isHexColor guard
            { value: "b", color: null as unknown as string },
          ],
        }),
      }),
      polygons(),
    );
    assert.match(compact(sld), /<ogc:Literal>a<\/ogc:Literal>/);
    assert.doesNotMatch(compact(sld), /<ogc:Literal>b<\/ogc:Literal>/);
  });

  it("warns for features SLD cannot represent", () => {
    const { warnings } = buildSld(
      layer({
        style: style({
          extrusionEnabled: true,
          fillPattern: "hatch",
        }),
      }),
      polygons(),
    );
    assert.ok(warnings.some((w) => /3D extrusion/.test(w)));
    assert.ok(warnings.some((w) => /fill pattern/.test(w)));
  });

  it("exports a hidden layer with its real opacity, not fully transparent", () => {
    const { sld } = buildSld(
      layer({ visible: false, opacity: 1, style: style({ fillOpacity: 0.6 }) }),
      polygons(),
    );
    // Visibility is not folded into opacity, so the fill stays visible (0.6),
    // not 0.
    assert.match(sld, /<CssParameter name="fill-opacity">0\.6<\/CssParameter>/);
    assert.doesNotMatch(sld, /<CssParameter name="fill-opacity">0<\/CssParameter>/);
  });

  it("warns when an attribute-driven renderer has no valid classes", () => {
    const { warnings } = buildSld(
      layer({
        style: style({
          vectorStyleMode: "categorized",
          vectorStyleProperty: "zone",
          vectorStyleStops: [], // no classes → falls back to single
        }),
      }),
      polygons(),
    );
    assert.ok(warnings.some((w) => /no valid classes/.test(w)));
  });

  it("gives a shape marker a white halo outline, not the layer stroke", () => {
    const { sld } = buildSld(
      layer({
        style: style({
          markerEnabled: true,
          markerShape: "star",
          markerColor: "#ff0000",
          strokeColor: "#00ff00",
        }),
      }),
      points(),
    );
    assert.match(compact(sld), /<WellKnownName>star<\/WellKnownName>/);
    // The halo is white; the layer's green stroke is not used on the mark.
    assert.match(
      compact(sld),
      /<Mark>.*<Stroke>.*<CssParameter name="stroke">#ffffff<\/CssParameter>/,
    );
    assert.doesNotMatch(
      compact(sld),
      /<Mark>.*<CssParameter name="stroke">#00ff00<\/CssParameter>/,
    );
  });

  it("escapes XML-special characters in the layer name", () => {
    const { sld } = buildSld(layer({ name: "A & B <test>" }), polygons());
    assert.match(sld, /<Name>A &amp; B &lt;test&gt;<\/Name>/);
  });
});
