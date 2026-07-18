import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import {
  DEFAULT_LAYER_STYLE,
  MAX_DIAGRAM_FEATURES,
  MAX_DIAGRAM_SCAN_FEATURES,
  MIN_DIAGRAM_SIZE,
  collectDiagramData,
  diagramAnchor,
  diagramPixelSize,
  diagramsSuppressedByPointRenderer,
  isDiagramStyleEnabled,
  type LayerStyle,
} from "../packages/core/src/index";
import {
  MAX_ATLAS_HEIGHT,
  declutterEntries,
  packDiagramCells,
} from "../packages/plugins/src/plugins/deckgl-viz/diagrams";

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
      isDiagramStyleEnabled(style({ diagramFields: [{ property: "", color: "#fff" }] })),
      false,
    );
  });
});

describe("diagramsSuppressedByPointRenderer", () => {
  const lineFeature: Feature = {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    },
    properties: {},
  };

  it("suppresses only point-only layers with a non-single renderer", () => {
    const points = collection([pointFeature({ a: 1 })]);
    assert.equal(
      diagramsSuppressedByPointRenderer(points, style({ pointRenderer: "cluster" })),
      true,
    );
    assert.equal(
      diagramsSuppressedByPointRenderer(points, style({ pointRenderer: "single" })),
      false,
    );
  });

  it("ignores a stale renderer once the layer has non-point geometry", () => {
    const mixed = collection([pointFeature({ a: 1 }), lineFeature]);
    assert.equal(
      diagramsSuppressedByPointRenderer(mixed, style({ pointRenderer: "heatmap" })),
      false,
    );
    assert.equal(
      diagramsSuppressedByPointRenderer(undefined, style({ pointRenderer: "cluster" })),
      false,
    );
  });
});

describe("diagramAnchor", () => {
  it("anchors points at their own coordinates", () => {
    assert.deepEqual(diagramAnchor({ type: "Point", coordinates: [1, 2] }), [1, 2]);
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
    assert.equal(diagramAnchor({ type: "Point", coordinates: [Number.NaN, 0] }), null);
  });
});

describe("collectDiagramData", () => {
  it("reads one value per field and computes totals and maxima", () => {
    const data = collectDiagramData(
      collection([pointFeature({ a: 3, b: 1 }), pointFeature({ a: 1, b: 5 })]),
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
    const data = collectDiagramData(collection([pointFeature({ a: -5, b: "7" })]), style());
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

  it("falls back to constant sizing when attribute mode has no field yet", () => {
    const data = collectDiagramData(
      collection([pointFeature({ a: 1, b: 1 }), pointFeature({ a: 5, b: 5 })]),
      style({ diagramSizeMode: "attribute", diagramSizeProperty: "" }),
    );
    assert.ok(data.data.every((datum) => datum.sizeValue === 1));
    assert.equal(data.maxSizeValue, 1);
    // Full-size diagrams, not the legibility floor.
    assert.equal(
      diagramPixelSize(
        data.data[0],
        style({ diagramSizeMode: "attribute", diagramSize: 40 }),
        data.maxSizeValue,
      ),
      40,
    );
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

  it("bounds the raw scan on sparse layers and reports it as truncation", () => {
    // Only a handful of the features are drawable, so the drawn count stays
    // far below the draw cap — the raw-scan cap must still stop the loop.
    const sparse = Array.from({ length: MAX_DIAGRAM_SCAN_FEATURES + 10 }, (_, i) =>
      pointFeature(i < 3 ? { a: 1, b: 1 } : { a: 0, b: 0 }),
    );
    const data = collectDiagramData(collection(sparse), style());
    assert.equal(data.data.length, 3);
    assert.equal(data.truncated, true);
  });
});

describe("packDiagramCells", () => {
  it("packs cells into rows without overlap and wraps at the atlas width", () => {
    const sizes = Array.from({ length: 40 }, () => ({
      width: 200,
      height: 200,
    }));
    const { cells, atlasHeight, dropped } = packDiagramCells(sizes);
    assert.equal(cells.length, 40);
    assert.equal(dropped, 0);
    assert.ok(atlasHeight <= MAX_ATLAS_HEIGHT);
    for (const cell of cells) {
      assert.ok(cell.x + cell.width <= 2048);
    }
    // No two cells overlap.
    for (let i = 0; i < cells.length; i += 1) {
      for (let j = i + 1; j < cells.length; j += 1) {
        const a = cells[i];
        const b = cells[j];
        const overlaps =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        assert.equal(overlaps, false);
      }
    }
  });

  it("honors a lower height bound (device texture limit)", () => {
    const sizes = Array.from({ length: 100 }, () => ({
      width: 240,
      height: 240,
    }));
    const { cells, atlasHeight, dropped } = packDiagramCells(sizes, 1024);
    assert.ok(atlasHeight <= 1024);
    assert.ok(dropped > 0);
    assert.equal(cells.length + dropped, 100);
  });

  it("drops cells past the atlas height cap instead of growing unbounded", () => {
    // 248px cells, 8 per 2048px row: 2000 diagrams would need ~62,000px of
    // height, far past the cap.
    const sizes = Array.from({ length: 2000 }, () => ({
      width: 240,
      height: 240,
    }));
    const { cells, atlasHeight, dropped } = packDiagramCells(sizes);
    assert.ok(atlasHeight <= MAX_ATLAS_HEIGHT);
    assert.ok(dropped > 0);
    assert.equal(cells.length + dropped, 2000);
  });
});

describe("declutterEntries", () => {
  const project = (position: [number, number]) => ({
    x: position[0],
    y: position[1],
  });

  it("keeps non-overlapping entries and drops overlapped smaller ones", () => {
    const big = { width: 40, height: 40, position: [0, 0] as [number, number] };
    const overlapped = {
      width: 20,
      height: 20,
      position: [10, 10] as [number, number],
    };
    const far = {
      width: 20,
      height: 20,
      position: [500, 500] as [number, number],
    };
    const kept = declutterEntries([overlapped, big, far], project);
    assert.ok(kept.includes(big));
    assert.ok(kept.includes(far));
    assert.equal(kept.includes(overlapped), false);
  });

  it("keeps everything when nothing overlaps", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      width: 10,
      height: 10,
      position: [i * 100, 0] as [number, number],
    }));
    assert.equal(declutterEntries(entries, project).length, 5);
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
    assert.equal(diagramPixelSize(datum, style({ diagramSize: 42 }), 100), 42);
  });

  it("scales by square root so area tracks the value", () => {
    const scaled = diagramPixelSize(datum, style({ diagramSizeMode: "sum", diagramSize: 40 }), 100);
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
