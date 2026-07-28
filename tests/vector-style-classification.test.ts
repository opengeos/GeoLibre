import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCategorizedStops,
  createGraduatedStops,
} from "../apps/geolibre-desktop/src/lib/vector-style-classification";

const tiledLayer = {};

describe("vector style classification", () => {
  it("classifies separately loaded values for a tiled layer", () => {
    const stops = createCategorizedStops(tiledLayer, "Cluster Name", 3, "viridis", "top-values", [
      "South",
      "Central",
      "North",
      "Central",
      "South",
      "Central",
    ]);

    assert.deepEqual(
      stops.map((stop) => stop.value),
      ["Central", "South", "North"],
    );
  });

  it("handles more values than function argument limits allow", () => {
    const values = Array.from({ length: 150_000 }, (_, index) => index);
    const stops = createGraduatedStops(
      tiledLayer,
      "height",
      5,
      "viridis",
      "equal-interval",
      values,
    );

    assert.equal(stops.length, 5);
    assert.deepEqual(
      stops.map((stop) => stop.value),
      [0, 29_999.8, 59_999.6, 89_999.4, 119_999.2],
    );
  });

  it("ignores nullish numeric values", () => {
    const stops = createGraduatedStops(tiledLayer, "height", 2, "viridis", "equal-interval", [
      null,
      10,
      20,
    ]);

    assert.deepEqual(
      stops.map((stop) => stop.value),
      [10, 15],
    );
  });

  it("preserves numeric category values", () => {
    const stops = createCategorizedStops(tiledLayer, "rank", 2, "viridis", "top-values", [1, 2, 1]);

    assert.deepEqual(
      stops.map((stop) => stop.value),
      [1, 2],
    );
  });

  it("keeps adjacent high-magnitude breaks distinct", () => {
    const stops = createGraduatedStops(
      tiledLayer,
      "population",
      3,
      "viridis",
      "equal-interval",
      [1_000_000_000, 1_000_000_000.5, 1_000_000_001],
    );

    assert.equal(stops.length, 3);
    assert.equal(new Set(stops.map((stop) => stop.value)).size, 3);
  });
});
