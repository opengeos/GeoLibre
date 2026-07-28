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
});
