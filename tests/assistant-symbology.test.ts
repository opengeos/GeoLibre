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

  it("uses explicit breaks verbatim instead of a computed scheme", () => {
    const layer = layerWith("pm25", [3, 12, 30, 44, 61, 120]);
    const style = buildSymbologyStyle(layer, {
      mode: "graduated",
      property: "pm25",
      // Thailand's official PM2.5 health bands: unevenly spaced, and no
      // statistical scheme reproduces them.
      breaks: [0, 25, 37, 50, 90],
    });
    assert.equal(style.vectorStyleMode, "graduated");
    assert.equal(style.vectorStyleClassCount, 5);
    assert.deepEqual(
      style.vectorStyleStops?.map((stop) => stop.value),
      [0, 25, 37, 50, 90],
    );
  });

  it("ignores class_count and scheme when explicit breaks are given", () => {
    const layer = layerWith("pm25", [3, 12, 30, 44, 61, 120]);
    const style = buildSymbologyStyle(layer, {
      mode: "graduated",
      property: "pm25",
      classCount: 3,
      scheme: "quantile",
      breaks: [0, 25, 37, 50, 90],
    });
    assert.deepEqual(
      style.vectorStyleStops?.map((stop) => stop.value),
      [0, 25, 37, 50, 90],
    );
    // No scheme produced these breaks, so the patch does not carry one; the
    // layer keeps whatever scheme it already had (setLayerStyle merges shallowly).
    assert.equal(style.vectorStyleClassificationScheme, undefined);
  });

  it("sorts and de-duplicates explicit breaks so MapLibre accepts them", () => {
    const layer = layerWith("pm25", [3, 12, 30, 44, 61, 120]);
    const style = buildSymbologyStyle(layer, {
      mode: "graduated",
      property: "pm25",
      breaks: [50, 0, 37, 25, 37, Number.NaN],
    });
    assert.deepEqual(
      style.vectorStyleStops?.map((stop) => stop.value),
      [0, 25, 37, 50],
    );
    assert.equal(style.vectorStyleClassCount, 4);
  });

  it("accepts explicit breaks against a single-value property", () => {
    // Deriving classes from one value is meaningless, but explicit thresholds
    // do not come from the sample, so the two-value floor must not apply.
    const layer = layerWith("pm25", [42]);
    const style = buildSymbologyStyle(layer, {
      mode: "graduated",
      property: "pm25",
      breaks: [0, 25, 50],
    });
    assert.equal(style.vectorStyleStops?.length, 3);
  });

  it("throws when explicit breaks hold fewer than two usable values", () => {
    const layer = layerWith("pm25", [3, 12, 30]);
    assert.throws(() =>
      buildSymbologyStyle(layer, { mode: "graduated", property: "pm25", breaks: [] }),
    );
    assert.throws(() =>
      buildSymbologyStyle(layer, {
        mode: "graduated",
        property: "pm25",
        breaks: [Number.NaN, Number.POSITIVE_INFINITY],
      }),
    );
    // vectorColorExpression paints a flat fallback below two graduated stops,
    // so one break would report success and render nothing.
    assert.throws(() =>
      buildSymbologyStyle(layer, { mode: "graduated", property: "pm25", breaks: [25] }),
    );
    assert.throws(() =>
      buildSymbologyStyle(layer, { mode: "graduated", property: "pm25", breaks: [25, 25] }),
    );
  });

  it("still rejects a non-numeric property when breaks are supplied", () => {
    const layer = layerWith("kind", ["red", "green"]);
    assert.throws(() =>
      buildSymbologyStyle(layer, { mode: "graduated", property: "kind", breaks: [0, 25] }),
    );
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

  it("lists the layer's real fields when the property does not exist", () => {
    const layer = layerWith("population", [1, 2, 3]);
    assert.throws(
      () => buildSymbologyStyle(layer, { mode: "graduated", property: "pop_est" }),
      (error: Error) =>
        /does not exist on layer "Test layer"/.test(error.message) &&
        /Available fields: "population"\./.test(error.message) &&
        !/Did you mean/.test(error.message),
    );
  });

  it("suggests a field that differs only in case", () => {
    const layer = layerWith("population", [1, 2, 3]);
    assert.throws(
      () => buildSymbologyStyle(layer, { mode: "graduated", property: "Population" }),
      /Did you mean "population"\?/,
    );
  });

  it("truncates a long field list", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`f${index}`, index]),
    );
    const layer = {
      id: "wide",
      name: "Wide",
      type: "geojson",
      geojson: {
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: null, properties }],
      },
    } as unknown as GeoLibreLayer;
    assert.throws(
      () => buildSymbologyStyle(layer, { mode: "categorized", property: "missing" }),
      (error: Error) =>
        /"f49" \(and 10 more\)\.$/.test(error.message) && !/"f50"/.test(error.message),
    );
  });

  it("says the field is all-null rather than missing when it exists", () => {
    const layer = layerWith("pop", [null, null]);
    assert.throws(
      () => buildSymbologyStyle(layer, { mode: "graduated", property: "pop" }),
      /has no values on layer "Test layer"; it is null on every feature/,
    );
  });

  it("throws when graduated mode is asked for non-numeric data", () => {
    const layer = layerWith("kind", ["red", "green", "blue"]);
    assert.throws(() => buildSymbologyStyle(layer, { mode: "graduated", property: "kind" }));
  });
});
