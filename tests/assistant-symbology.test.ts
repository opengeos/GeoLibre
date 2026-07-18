import type { GeoLibreLayer } from "@geolibre/core";
import type { Feature } from "geojson";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSymbologyStyle } from "../apps/geolibre-desktop/src/lib/assistant/symbology";

/** Build a minimal point layer carrying the given property values. */
function layerWith(property: string, values: unknown[]): GeoLibreLayer {
  const features: Feature[] = values.map((value) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    properties: { [property]: value },
  }));
  return {
    id: "layer-1",
    name: "Test layer",
    type: "geojson",
    geojson: { type: "FeatureCollection", features },
  } as unknown as GeoLibreLayer;
}

describe("buildSymbologyStyle", () => {
  it("builds a graduated style from numeric values", () => {
    const layer = layerWith("pop", [1, 10, 100, 1000, 5000]);
    const style = buildSymbologyStyle(layer, {
      mode: "graduated",
      property: "pop",
      colorRamp: "reds",
      classCount: 5,
    });
    assert.equal(style.vectorStyleMode, "graduated");
    assert.equal(style.vectorStyleProperty, "pop");
    assert.equal(style.vectorStyleColorRamp, "reds");
    assert.equal(style.vectorStyleStops?.length, 5);
    for (const stop of style.vectorStyleStops ?? []) {
      assert.equal(typeof stop.value, "number");
      assert.match(stop.color, /^#[0-9a-fA-F]{6}$/);
    }
  });

  it("clamps the graduated class count into a sane range", () => {
    const layer = layerWith(
      "pop",
      Array.from({ length: 30 }, (_, index) => index + 1),
    );
    const style = buildSymbologyStyle(layer, {
      mode: "graduated",
      property: "pop",
      classCount: 99,
    });
    assert.equal(style.vectorStyleStops?.length, 12);
  });

  it("never asks for more classes than the data has values", () => {
    const layer = layerWith("pop", [10, 20, 30]);
    const style = buildSymbologyStyle(layer, {
      mode: "graduated",
      property: "pop",
      classCount: 8,
    });
    assert.equal(style.vectorStyleStops?.length, 3);
  });

  it("builds a categorized style with one stop per distinct value", () => {
    const layer = layerWith("kind", ["a", "b", "a", "c", "b"]);
    const style = buildSymbologyStyle(layer, {
      mode: "categorized",
      property: "kind",
    });
    assert.equal(style.vectorStyleMode, "categorized");
    assert.equal(style.vectorStyleStops?.length, 3);
    assert.deepEqual(
      style.vectorStyleStops?.map((stop) => stop.value),
      ["a", "b", "c"],
    );
  });

  it("defaults the color ramp to viridis", () => {
    const layer = layerWith("kind", ["x", "y"]);
    const style = buildSymbologyStyle(layer, {
      mode: "categorized",
      property: "kind",
    });
    assert.equal(style.vectorStyleColorRamp, "viridis");
  });

  it("throws when the property has no values", () => {
    const layer = layerWith("pop", []);
    assert.throws(() => buildSymbologyStyle(layer, { mode: "graduated", property: "pop" }));
  });

  it("throws when graduated mode is asked for non-numeric data", () => {
    const layer = layerWith("kind", ["red", "green", "blue"]);
    assert.throws(() => buildSymbologyStyle(layer, { mode: "graduated", property: "kind" }));
  });
});
