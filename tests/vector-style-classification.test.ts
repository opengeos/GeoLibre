import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCategorizedStops,
  createGraduatedStops,
  countCategorizedValues,
  MAX_MANUAL_CATEGORIZED_VALUES,
  proportionalSizeBounds,
} from "../apps/geolibre-desktop/src/lib/vector-style-classification";
import {
  GRADUATED_CLASSIFICATION_SCHEMES,
  graduatedSchemeLabelKey,
  MANUAL_CLASSIFICATION_SCHEME,
  normalizeClassificationScheme,
  regeneratingClassificationScheme,
} from "../apps/geolibre-desktop/src/components/panels/style-panel/classification-helpers";

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

  it("does not coerce blank or non-scalar values to zero", () => {
    const stops = createGraduatedStops(tiledLayer, "height", 2, "viridis", "equal-interval", [
      "",
      false,
      [],
      10,
      "20",
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

  it("counts distinct categorized values by scalar type", () => {
    assert.equal(countCategorizedValues(["1", 1, "1", null, Number.NaN, {}]), 2);
  });

  it("creates more than twelve categorized stops when all values are requested", () => {
    const values = Array.from({ length: 14 }, (_, index) => `category-${index + 1}`);
    const stops = createCategorizedStops(
      tiledLayer,
      "category",
      values.length,
      "viridis",
      "alphabetical",
      values,
    );

    assert.equal(stops.length, 14);
  });

  it("bounds manual categorized stops to the editor safety limit", () => {
    const values = Array.from(
      { length: MAX_MANUAL_CATEGORIZED_VALUES + 10 },
      (_, index) => `category-${index + 1}`,
    );
    const stops = createCategorizedStops(
      tiledLayer,
      "category",
      values.length,
      "viridis",
      "first-values",
      values,
    );

    assert.equal(stops.length, MAX_MANUAL_CATEGORIZED_VALUES);
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

describe("proportionalSizeBounds", () => {
  it("returns the numeric min and max of a property", () => {
    const layer = {
      geojson: {
        features: [
          { properties: { count: 12 } },
          { properties: { count: 4 } },
          { properties: { count: "40" } },
          { properties: { count: null } },
        ],
      },
    };
    assert.deepEqual(proportionalSizeBounds(layer, "count"), { min: 4, max: 40 });
  });

  it("returns null for an empty, missing, or constant column", () => {
    assert.equal(proportionalSizeBounds({}, "count"), null);
    assert.equal(proportionalSizeBounds({ geojson: { features: [] } }, "count"), null);
    assert.equal(
      proportionalSizeBounds(
        {
          geojson: {
            features: [{ properties: { count: 7 } }, { properties: { count: 7 } }],
          },
        },
        "count",
      ),
      null,
    );
  });

  it("accepts separately loaded property values", () => {
    assert.deepEqual(proportionalSizeBounds({}, "height", [1, 5, 9]), { min: 1, max: 9 });
  });
});

describe("graduated classification schemes", () => {
  it("offers standard deviation, geometric interval and manual in the Style panel", () => {
    for (const scheme of ["standard-deviation", "geometric-interval", "manual"]) {
      assert.ok(
        GRADUATED_CLASSIFICATION_SCHEMES.some((option) => option.value === scheme),
        scheme,
      );
      assert.equal(normalizeClassificationScheme("graduated", scheme), scheme);
    }
    // Graduated-only schemes are not categorized ones.
    assert.equal(normalizeClassificationScheme("categorized", "manual"), "top-values");
  });

  it("regenerates hand-edited breaks by equal interval and leaves other schemes alone", () => {
    assert.equal(regeneratingClassificationScheme(MANUAL_CLASSIFICATION_SCHEME), "equal-interval");
    assert.equal(regeneratingClassificationScheme("quantile"), "quantile");
  });

  it("resolves the legend label key of a graduated scheme", () => {
    assert.equal(graduatedSchemeLabelKey("quantile"), "style.symbology.schemeQuantile");
    assert.equal(graduatedSchemeLabelKey("manual"), "style.symbology.schemeManual");
    assert.equal(graduatedSchemeLabelKey("top-values"), null);
  });

  it("classifies graduated stops with the new schemes", () => {
    const values = [1, 10, 100, 1000];
    const stops = createGraduatedStops(
      tiledLayer,
      "pop",
      3,
      "viridis",
      "geometric-interval",
      values,
    );
    assert.equal(stops.length, 3);
    assert.ok(Math.abs(Number(stops[1].value) - 10) < 1e-9);
  });
});
