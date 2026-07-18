import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type LayerStyle } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { buildQml, type QmlExportableLayer } from "../packages/map/src/qml-export";

function style(patch: Partial<LayerStyle> = {}): LayerStyle {
  return { ...DEFAULT_LAYER_STYLE, ...patch };
}

function layer(
  patch: Partial<QmlExportableLayer> & { style?: LayerStyle } = {},
): QmlExportableLayer {
  return {
    id: patch.id ?? "layer-1",
    name: patch.name ?? "My Layer",
    type: patch.type ?? "geojson",
    opacity: patch.opacity ?? 1,
    visible: patch.visible ?? true,
    style: patch.style ?? style(),
  };
}

/** Collapse the pretty-printer's inter-tag whitespace. */
function compact(qml: string): string {
  return qml.replace(/>\s+</g, "><");
}

function points(): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
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

describe("buildQml", () => {
  it("emits a QGIS QML document with a renderer-v2", () => {
    const { qml, warnings } = buildQml(layer(), polygons());
    assert.match(qml, /<!DOCTYPE qgis>/);
    assert.match(qml, /<qgis version="3\.34\.0"/);
    assert.match(qml, /<renderer-v2 type="singleSymbol"/);
    assert.deepEqual(warnings, []);
  });

  it("uses a SimpleFill symbol with r,g,b,a color for polygons", () => {
    const { qml } = buildQml(
      layer({ style: style({ fillColor: "#ff0000", fillOpacity: 0.6, strokeColor: "#00ff00" }) }),
      polygons(),
    );
    assert.match(compact(qml), /<symbol type="fill"/);
    assert.match(compact(qml), /<layer class="SimpleFill"/);
    // #ff0000 at 0.6 opacity → 255,0,0,153.
    assert.match(compact(qml), /<Option name="color" type="QString" value="255,0,0,153"\/>/);
    assert.match(
      compact(qml),
      /<Option name="outline_color" type="QString" value="0,255,0,255"\/>/,
    );
  });

  it("uses a SimpleMarker for points, sized from the circle diameter", () => {
    const { qml } = buildQml(layer({ style: style({ circleRadius: 8 }) }), points());
    assert.match(compact(qml), /<symbol type="marker"/);
    assert.match(compact(qml), /<Option name="name" type="QString" value="circle"\/>/);
    // circleRadius 8 → diameter 16.
    assert.match(compact(qml), /<Option name="size" type="QString" value="16"\/>/);
  });

  it("maps a categorized renderer to categories + a default category", () => {
    const { qml } = buildQml(
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
    assert.match(compact(qml), /<renderer-v2 type="categorizedSymbol" attr="type"/);
    assert.match(compact(qml), /<category value="park" symbol="0"/);
    assert.match(compact(qml), /<category value="lake" symbol="1"/);
    // The empty-value default category is the fallback.
    assert.match(compact(qml), /<category value="" symbol="2"/);
  });

  it("maps a graduated renderer to ranges and warns", () => {
    const { qml, warnings } = buildQml(
      layer({
        style: style({
          vectorStyleMode: "graduated",
          vectorStyleProperty: "pop",
          vectorStyleStops: [
            { value: 0, color: "#eeeeee" },
            { value: 100, color: "#888888" },
          ],
        }),
      }),
      polygons(),
    );
    assert.match(compact(qml), /<renderer-v2 type="graduatedSymbol" attr="pop"/);
    assert.match(compact(qml), /<range lower="0" upper="100" symbol="0"/);
    assert.ok(warnings.some((w) => /discrete QML class ranges/.test(w)));
  });

  it("maps a rule-based renderer to QGIS-expression rules and an ELSE", () => {
    const { qml } = buildQml(
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
    assert.match(compact(qml), /<renderer-v2 type="RuleRenderer"/);
    // The filter is XML-escaped: "pop" > 1000.
    assert.match(qml, /filter="&quot;pop&quot; &gt; 1000"/);
    assert.match(qml, /filter="ELSE"/);
  });

  it("degrades an expression renderer to a single symbol with a warning", () => {
    const { qml, warnings } = buildQml(
      layer({
        style: style({
          vectorStyleMode: "expression",
          vectorStyleExpression: JSON.stringify(["get", "color"]),
          fillColor: "#abcdef",
        }),
      }),
      polygons(),
    );
    assert.match(compact(qml), /<renderer-v2 type="singleSymbol"/);
    assert.ok(warnings.some((w) => /custom color expression has no QML/.test(w)));
  });

  it("emits a simple labeling block when labels are enabled", () => {
    const { qml } = buildQml(
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
    assert.match(compact(qml), /<labeling type="simple">/);
    assert.match(compact(qml), /<settings fieldName="name" isExpression="0">/);
    assert.match(compact(qml), /<Option name="color"[^/]*\/>|fontSize="14"/);
  });

  it("exports a hidden layer with its real opacity", () => {
    const { qml } = buildQml(
      layer({ visible: false, opacity: 1, style: style({ fillOpacity: 0.6 }) }),
      polygons(),
    );
    // 0.6 * 1 → alpha 153, not 0.
    assert.match(compact(qml), /value="59,130,246,153"/);
  });

  it("does not crash on an invalid (non-string) stop color", () => {
    const { qml } = buildQml(
      layer({
        style: style({
          vectorStyleMode: "categorized",
          vectorStyleProperty: "z",
          vectorStyleStops: [
            { value: "a", color: "#112233" },
            { value: "b", color: null as unknown as string },
          ],
        }),
      }),
      polygons(),
    );
    assert.match(compact(qml), /<category value="a"/);
    assert.doesNotMatch(compact(qml), /<category value="b"/);
  });

  it("warns when a categorized stop is skipped for an invalid color", () => {
    const { warnings } = buildQml(
      layer({
        style: style({
          vectorStyleMode: "categorized",
          vectorStyleProperty: "z",
          vectorStyleStops: [
            { value: "a", color: "#112233" },
            { value: "b", color: "nope" },
          ],
        }),
      }),
      polygons(),
    );
    assert.ok(warnings.some((w) => /categories had a blank value or invalid color/.test(w)));
  });

  it("warns when a rule is skipped for an invalid color", () => {
    const { warnings } = buildQml(
      layer({
        style: style({
          vectorStyleMode: "rule-based",
          vectorRules: [
            {
              id: "r1",
              label: "bad",
              filter: JSON.stringify([">", ["get", "p"], 1]),
              color: "notacolor",
              isElse: false,
            },
            {
              id: "r2",
              label: "",
              filter: JSON.stringify([">", ["get", "p"], 2]),
              color: "#00ff00",
              isElse: false,
            },
            { id: "else", label: "", filter: "", color: "#dddddd", isElse: true },
          ],
        }),
      }),
      polygons(),
    );
    assert.ok(warnings.some((w) => /invalid color and was skipped/.test(w)));
  });

  it("escapes XML-special characters in the layer attribute", () => {
    const { qml } = buildQml(
      layer({
        style: style({
          vectorStyleMode: "categorized",
          vectorStyleProperty: "a&b",
          vectorStyleStops: [{ value: "x", color: "#111111" }],
        }),
      }),
      polygons(),
    );
    assert.match(qml, /attr="a&amp;b"/);
  });
});
