import assert from "node:assert/strict";
import { it } from "node:test";
import type { StyleSpecification } from "mapbox-gl";
import {
  withStandardOpacity,
  standardOpacityExpression,
  STANDARD_OPACITY,
  prepareMapboxStandard,
} from "../packages/map/src/mapbox-standard-style";

it("adds opacity to imported ocean labels and 3D layers without changing the original style", () => {
  const style: StyleSpecification = {
    version: 8,
    sources: {},
    schema: { lightPreset: { type: "string", default: "day" } },
    layers: [
      { id: "land", type: "background", paint: { "background-color": "#eeeeee" } },
      {
        id: "ocean",
        type: "symbol",
        source: "composite",
        "source-layer": "water",
        paint: { "text-opacity": 0.7 },
      },
      {
        id: "buildings",
        type: "fill-extrusion",
        source: "composite",
        paint: { "fill-extrusion-opacity": 0.9 },
      },
    ],
  };
  const prepared = withStandardOpacity(style);
  assert.equal(prepared.schema?.lightPreset?.default, "day");
  assert.deepEqual(prepared.layers[1].paint?.["text-opacity" as never], [
    "*",
    0.7,
    ["config", STANDARD_OPACITY],
  ]);
  assert.deepEqual(prepared.layers[2].paint?.["fill-extrusion-opacity" as never], [
    "*",
    0.9,
    ["config", STANDARD_OPACITY],
  ]);
  assert.equal(style.schema?.[STANDARD_OPACITY], undefined);
  assert.equal((style.layers[0].paint as Record<string, unknown>)["background-color"], "#eeeeee");
});
it("preserves top-level zoom stops while multiplying their outputs", () => {
  const zoom = ["interpolate", ["linear"], ["zoom"], 5, 0, 10, ["get", "opacity"]];
  assert.deepEqual(standardOpacityExpression(zoom), [
    "interpolate",
    ["linear"],
    ["zoom"],
    5,
    ["*", 0, ["config", STANDARD_OPACITY]],
    10,
    ["*", ["get", "opacity"], ["config", STANDARD_OPACITY]],
  ]);
});
it("leaves other Mapbox basemaps on their existing style path", async () => {
  const streets = "mapbox://styles/mapbox/streets-v12";
  assert.equal(await prepareMapboxStandard(streets, ""), streets);
  const style: StyleSpecification = { version: 8, sources: {}, layers: [] };
  assert.equal(await prepareMapboxStandard(style, ""), style);
});
