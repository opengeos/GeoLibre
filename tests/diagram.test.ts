import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import {
  DEFAULT_LAYER_STYLE,
  MAX_DIAGRAM_FEATURES,
  MIN_DIAGRAM_SIZE,
  collectDiagramData,
  diagramAnchor,
  diagramPixelSize,
  isDiagramStyleEnabled,
  type LayerStyle,
} from "../packages/core/src/index";

function style(overrides: Partial<LayerStyle> = {}): LayerStyle {
  return {
    ...DEFAULT_LAYER_STYLE,
    diagramType: "pie",
    diagramFields: [
      { property: "a", color: "#ff0000" },
      { property: "b", color: "#00ff00" },
    ],
    ...overrides,
  };
}

function pointFeature(
  properties: Record<string, unknown>,
  coordinates: [number, number] = [10, 20],
): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates },
    properties,
  };
}

function collection(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

describe("isDiagramStyleEnabled", () => {
  it("requires a chart type and at least one mapped attribute", () => {
    assert.equal(isDiagramStyleEnabled(style()), true);
    assert.equal(isDiagramStyleEnabled(style({ diagramType: "none" })), false);
    assert.equal(isDiagramStyleEnabled(style({ diagramFields: [] })), false);
    assert.equal(
      isDiagramStyleEnabled(
        style({ diagramFields: [{ property: "", color: "#fff" }] }),
      ),
      false,
    );
  });
});

describe("diagramAnchor", () => {
  it("anchors points at their own coordinates", () => {
    assert.deepEqual(
      diagramAnchor({ type: "Point", coordinates: [1, 2] }),
      [1, 2],
    );
  });

  it("anchors a polygon at its centroid", () => {
    const square: Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
          [0, 0],
        ],
      ],
    };
    const anchor = diagramAnchor(square);
    assert.ok(anchor);
    assert.ok(Math.abs(anchor[0] - 2) < 1e-9);
    assert.ok(Math.abs(anchor[1] - 2) < 1e-9);
  });

  it("anchors a multi-polygon on its largest part", () => {
    const anchor = diagramAnchor({
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [100, 100],
            [101, 100],
            [101, 101],
            [100, 101],
            [100, 100],
          ],
        ],
        [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
        ],
      ],
    });
    assert.ok(anchor);
    assert.ok(Math.abs(anchor[0] - 5) < 1e-9);
    assert.ok(Math.abs(anchor[1] - 5) < 1e-9);
  });

  it("anchors a line at its middle vertex", () => {
    assert.deepEqual(
      diagramAnchor({
        type: "LineString",
        coordinates: [
          [0, 0],
          [5, 5],
          [10, 0],
        ],
      }),
      [5, 5],
    );
  });

  it("returns null for missing or non-finite geometry", () => {
    assert.equal(diagramAnchor(null), null);
    assert.equal(
      diagramAnchor({ type: "Point", coordinates: [Number.NaN, 0] }),
      null,
    );
  });
});

describe("collectDiagramData", () => {
  it("reads one value per field and computes totals and maxima", () => {
    const data = collectDiagramData(
      collection([
        pointFeature({ a: 3, b: 1 }),
        pointFeature({ a: 1, b: 5 }),
      ]),
      style({ diagramSizeMode: "sum" }),
    );
    assert.equal(data.data.length, 2);
    assert.deepEqual(data.data[0].values, [3, 1]);
    assert.equal(data.data[0].total, 4);
    assert.equal(data.maxTotal, 6);
    assert.equal(data.maxFieldValue, 5);
    assert.equal(data.maxSizeValue, 6);
    assert.equal(data.truncated, false);
  });

  it("clamps negative and non-numeric values to zero", () => {
    const data = collectDiagramData(
      collection([pointFeature({ a: -5, b: "7" })]),
      style(),
    );
    assert.deepEqual(data.data[0].values, [0, 7]);
  });

  it("skips features with no positive value or no anchor", () => {
    const data = collectDiagramData(
      collection([
        pointFeature({ a: 0, b: 0 }),
        { type: "Feature", geometry: null, properties: { a: 1, b: 1 } },
        pointFeature({ a: 2, b: 2 }),
      ]),
      style(),
    );
    assert.equal(data.data.length, 1);
    assert.deepEqual(data.data[0].values, [2, 2]);
  });

  it("sizes by the configured attribute in attribute mode", () => {
    const data = collectDiagramData(
      collection([pointFeature({ a: 1, b: 1, pop: 250 })]),
      style({ diagramSizeMode: "attribute", diagramSizeProperty: "pop" }),
    );
    assert.equal(data.data[0].sizeValue, 250);
    assert.equal(data.maxSizeValue, 250);
  });

  it("caps the dataset and reports truncation", () => {
    const many = Array.from({ length: MAX_DIAGRAM_FEATURES + 5 }, () =>
      pointFeature({ a: 1, b: 1 }),
    );
    const data = collectDiagramData(collection(many), style());
    assert.equal(data.data.length, MAX_DIAGRAM_FEATURES);
    assert.equal(data.truncated, true);
  });
});

describe("diagramPixelSize", () => {
  const datum = {
    position: [0, 0] as [number, number],
    values: [1],
    total: 1,
    sizeValue: 25,
  };

  it("returns the configured size for fixed sizing", () => {
    assert.equal(
      diagramPixelSize(datum, style({ diagramSize: 42 }), 100),
      42,
    );
  });

  it("scales by square root so area tracks the value", () => {
    const scaled = diagramPixelSize(
      datum,
      style({ diagramSizeMode: "sum", diagramSize: 40 }),
      100,
    );
    assert.equal(scaled, 40 * Math.sqrt(25 / 100));
  });

  it("never shrinks below the legibility floor", () => {
    const tiny = diagramPixelSize(
      { ...datum, sizeValue: 0.0001 },
      style({ diagramSizeMode: "sum", diagramSize: 40 }),
      1_000_000,
    );
    assert.equal(tiny, MIN_DIAGRAM_SIZE);
  });
});
