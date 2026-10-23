import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type LayerStyle } from "@geolibre/core";
import {
  compileTilesetStyle,
  tilesetExpression,
  tilesetStyleKey,
} from "../packages/map/src/cesium-tileset-style";

function tileset(style: Partial<LayerStyle> = {}): GeoLibreLayer {
  return {
    id: "buildings",
    name: "Buildings",
    type: "3d-tiles",
    source: { type: "3d-tiles", url: "https://example.test/tileset.json" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE, ...style },
    metadata: {},
  } as unknown as GeoLibreLayer;
}

describe("tilesetExpression", () => {
  it("translates property reads, casts, and comparisons", () => {
    assert.equal(tilesetExpression(["get", "height"]), "${height}");
    assert.equal(tilesetExpression(["to-number", ["get", "height"]]), "Number(${height})");
    assert.equal(
      tilesetExpression([">=", ["to-number", ["get", "height"]], 30]),
      "(Number(${height}) >= 30)",
    );
    assert.equal(tilesetExpression(["==", ["get", "type"], "school"]), '(${type} === "school")');
  });

  it("quotes a property name that is not an identifier", () => {
    assert.equal(tilesetExpression(["get", "building height"]), '${feature["building height"]}');
    assert.equal(tilesetExpression(["get", "2020"]), '${feature["2020"]}');
  });

  it("translates the boolean combinators, has, and in", () => {
    assert.equal(
      tilesetExpression(["all", ["has", "name"], ["!", ["==", ["get", "kind"], "shed"]]]),
      '(defined(${name}) && (!(${kind} === "shed")))',
    );
    assert.equal(
      tilesetExpression(["in", ["get", "kind"], ["literal", ["a", "b"]]]),
      '((${kind} === "a") || (${kind} === "b"))',
    );
  });

  it("refuses a node it has no equivalent for", () => {
    assert.equal(tilesetExpression(["interpolate", ["linear"], ["zoom"], 0, 1]), null);
    assert.equal(tilesetExpression(["get", "a", ["properties"]]), null);
    assert.equal(tilesetExpression(["feature-state", "hover"]), null);
  });
});

describe("compileTilesetStyle", () => {
  it("carries opacity as a white multiply when nothing classifies", () => {
    assert.equal(compileTilesetStyle(tileset(), 1, null), null);
    assert.deepEqual(compileTilesetStyle(tileset(), 0.4, null), {
      color: "color('#ffffff', 0.4)",
    });
  });

  it("compiles a categorized style into first-match-wins conditions", () => {
    const style = compileTilesetStyle(
      tileset({
        vectorStyleMode: "categorized",
        vectorStyleProperty: "kind",
        vectorStyleStops: [
          { value: "school", color: "#ff0000" },
          { value: "hospital", color: "#00ff00" },
        ],
        fillColor: "#cccccc",
      }),
      1,
      null,
    );
    assert.deepEqual(style?.color, {
      conditions: [
        ['(String(${kind}) === "school")', "color('#ff0000', 1)"],
        ['(String(${kind}) === "hospital")', "color('#00ff00', 1)"],
        ["true", "color('#cccccc', 1)"],
      ],
    });
  });

  it("inverts graduated breaks so the highest class a feature clears wins", () => {
    const style = compileTilesetStyle(
      tileset({
        vectorStyleMode: "graduated",
        vectorStyleProperty: "height",
        vectorStyleStops: [
          { value: 0, color: "#eeeeee" },
          { value: 25, color: "#999999" },
          { value: 50, color: "#333333" },
        ],
      }),
      1,
      null,
    );
    assert.deepEqual(style?.color, {
      conditions: [
        ["(Number(${height}) >= 50)", "color('#333333', 1)"],
        ["(Number(${height}) >= 25)", "color('#999999', 1)"],
        ["true", "color('#eeeeee', 1)"],
      ],
    });
  });

  it("bakes the layer opacity into every classified colour", () => {
    const style = compileTilesetStyle(
      tileset({
        vectorStyleMode: "categorized",
        vectorStyleProperty: "kind",
        vectorStyleStops: [{ value: "school", color: "#ff0000" }],
        fillColor: "#cccccc",
      }),
      0.5,
      null,
    );
    const conditions = (style?.color as { conditions: [string, string][] }).conditions;
    assert.ok(conditions.every(([, colour]) => colour.endsWith(", 0.5)")));
  });

  it("compiles a rule-based renderer in rule order", () => {
    const style = compileTilesetStyle(
      tileset({
        vectorStyleMode: "rule-based",
        vectorRules: [
          {
            id: "tall",
            label: "Tall",
            filter: JSON.stringify([">", ["get", "height"], 100]),
            color: "#ff0000",
            isElse: false,
          },
          { id: "rest", label: "Rest", filter: "", color: "#0000ff", isElse: true },
        ],
      }),
      1,
      null,
    );
    assert.deepEqual(style?.color, {
      conditions: [
        ["(${height} > 100)", "color('#ff0000', 1)"],
        ["true", "color('#0000ff', 1)"],
      ],
    });
  });

  it("leaves the tileset's own colours alone when the classification cannot translate", () => {
    const style = compileTilesetStyle(
      tileset({
        vectorStyleMode: "expression",
        vectorStyleExpression: JSON.stringify([
          "interpolate",
          ["linear"],
          ["get", "height"],
          0,
          "#fff",
          100,
          "#000",
        ]),
      }),
      1,
      null,
    );
    assert.equal(style, null);
  });

  it("translates the layer filter into show, and shows everything when it cannot", () => {
    const shown = compileTilesetStyle(tileset(), 1, [">", ["get", "height"], 10]);
    assert.equal(shown?.show, "(${height} > 10)");

    const untranslatable = compileTilesetStyle(tileset(), 1, [
      ">",
      ["interpolate", ["linear"], ["zoom"], 0, 1],
      10,
    ]);
    assert.equal(untranslatable, null);
  });

  it("keys a spec so an unchanged style is not reapplied", () => {
    const layer = tileset({
      vectorStyleMode: "categorized",
      vectorStyleProperty: "kind",
      vectorStyleStops: [{ value: "school", color: "#ff0000" }],
    });
    assert.equal(
      tilesetStyleKey(compileTilesetStyle(layer, 1, null)),
      tilesetStyleKey(compileTilesetStyle(layer, 1, null)),
    );
    assert.notEqual(
      tilesetStyleKey(compileTilesetStyle(layer, 1, null)),
      tilesetStyleKey(compileTilesetStyle(layer, 0.5, null)),
    );
    assert.equal(tilesetStyleKey(null), "");
  });
});
