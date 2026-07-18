import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FeatureCollection } from "geojson";
import {
  boundsIntersect,
  buildChartBlock,
  buildTableBlock,
  DEFAULT_TABLE_ROWS,
  layerRows,
  MAX_TABLE_ROWS,
  rowsWithinBounds,
} from "../apps/geolibre-desktop/src/lib/print-data-blocks";
import { collectAtlasFeatures } from "../apps/geolibre-desktop/src/lib/print-atlas";
import type { ChartRow } from "../apps/geolibre-desktop/src/lib/attribute-charts";

function point(lng: number, lat: number, properties: Record<string, unknown>): GeoJSON.Feature {
  return {
    type: "Feature",
    properties,
    geometry: { type: "Point", coordinates: [lng, lat] },
  };
}

function rows(...props: Record<string, unknown>[]): ChartRow[] {
  return props.map((properties) => ({ properties }));
}

describe("boundsIntersect", () => {
  it("detects overlap, touching edges, and containment", () => {
    assert.equal(boundsIntersect([0, 0, 10, 10], [5, 5, 15, 15]), true);
    // Touching along an edge counts as intersecting.
    assert.equal(boundsIntersect([0, 0, 10, 10], [10, 0, 20, 10]), true);
    // One box fully inside the other.
    assert.equal(boundsIntersect([0, 0, 10, 10], [2, 2, 3, 3]), true);
  });

  it("rejects disjoint boxes on either axis", () => {
    assert.equal(boundsIntersect([0, 0, 10, 10], [11, 0, 20, 10]), false);
    assert.equal(boundsIntersect([0, 0, 10, 10], [0, 11, 10, 20]), false);
  });

  it("matches across the antimeridian's differing longitude conventions", () => {
    // An unwrapped dateline view (east > 180, à la map.getBounds()) against a
    // normalized feature box on the far side of the wrap.
    assert.equal(boundsIntersect([170, -10, 190, 10], [-178, -5, -176, 5]), true);
    // And the mirror case: a shifted feature box against a normalized view.
    assert.equal(boundsIntersect([-180, -10, -170, 10], [178, -5, 185, 5]), true);
    // Genuinely far apart boxes still do not match.
    assert.equal(boundsIntersect([170, -10, 190, 10], [-10, -5, 0, 5]), false);
  });
});

describe("rowsWithinBounds", () => {
  const collection: Pick<FeatureCollection, "features"> = {
    features: [
      point(1, 1, { name: "inside" }),
      point(50, 50, { name: "outside" }),
      // No geometry: nowhere on the page, so never included.
      {
        type: "Feature",
        properties: { name: "no-geometry" },
        geometry: null as unknown as GeoJSON.Geometry,
      },
    ],
  };

  // The dialog precomputes per-feature bounds once per layer (the atlas
  // pattern) and hands those to the filter.
  const infos = collectAtlasFeatures(collection);

  it("keeps only features whose bounds intersect the extent", () => {
    const result = rowsWithinBounds(infos, [0, 0, 10, 10]);
    assert.deepEqual(
      result.map((r) => r.properties.name),
      ["inside"],
    );
  });

  it("returns no rows for a fully disjoint extent", () => {
    assert.equal(rowsWithinBounds(infos, [-30, -30, -20, -20]).length, 0);
  });
});

describe("layerRows", () => {
  it("maps features to property bags, defaulting missing properties", () => {
    const result = layerRows({
      features: [
        point(0, 0, { a: 1 }),
        {
          type: "Feature",
          properties: null,
          geometry: { type: "Point", coordinates: [0, 0] },
        },
      ],
    });
    assert.deepEqual(result, [{ properties: { a: 1 } }, { properties: {} }]);
  });
});

describe("buildTableBlock", () => {
  const source = rows(
    { name: "b-town", pop: 200 },
    { name: "a-town", pop: 300 },
    { name: "c-town", pop: null },
  );

  it("returns null without rows or without columns", () => {
    assert.equal(buildTableBlock([], { columns: ["name"] }), null);
    assert.equal(buildTableBlock(source, { columns: [] }), null);
  });

  it("stringifies cells and blanks null/undefined values", () => {
    const table = buildTableBlock(source, { columns: ["name", "pop", "nope"] });
    assert.ok(table);
    assert.deepEqual(table.columns, ["name", "pop", "nope"]);
    assert.deepEqual(table.rows[0], ["b-town", "200", ""]);
    assert.deepEqual(table.rows[2], ["c-town", "", ""]);
    assert.equal(table.truncated, 0);
  });

  it("sorts numerically with missing values last, both directions", () => {
    const asc = buildTableBlock(source, {
      columns: ["name"],
      sortField: "pop",
    });
    assert.deepEqual(
      asc?.rows.map((r) => r[0]),
      ["b-town", "a-town", "c-town"],
    );
    const desc = buildTableBlock(source, {
      columns: ["name"],
      sortField: "pop",
      sortDescending: true,
    });
    assert.deepEqual(
      desc?.rows.map((r) => r[0]),
      ["a-town", "b-town", "c-town"],
    );
  });

  it("caps rows at the limit and reports the truncated count", () => {
    const many = rows(...Array.from({ length: 30 }, (_, i) => ({ id: i })));
    const table = buildTableBlock(many, { columns: ["id"], maxRows: 5 });
    assert.equal(table?.rows.length, 5);
    assert.equal(table?.truncated, 25);
    // Clamped into 1..MAX_TABLE_ROWS; non-finite falls back to the default.
    assert.equal(buildTableBlock(many, { columns: ["id"], maxRows: 0 })?.rows.length, 1);
    assert.equal(
      buildTableBlock(many, { columns: ["id"], maxRows: 999 })?.rows.length,
      Math.min(30, MAX_TABLE_ROWS),
    );
    assert.equal(
      buildTableBlock(many, { columns: ["id"], maxRows: Number.NaN })?.rows.length,
      DEFAULT_TABLE_ROWS,
    );
  });
});

describe("buildChartBlock", () => {
  const source = rows({ kind: "a", v: 10 }, { kind: "a", v: 30 }, { kind: "b", v: 5 });

  it("returns null for empty rows or incomplete configuration", () => {
    assert.equal(buildChartBlock([], { type: "bar", categoryField: "kind" }), null);
    assert.equal(buildChartBlock(source, { type: "bar" }), null);
    assert.equal(buildChartBlock(source, { type: "line" }), null);
    // sum/mean without a value field cannot aggregate.
    assert.equal(
      buildChartBlock(source, {
        type: "bar",
        categoryField: "kind",
        aggregation: "sum",
      }),
      null,
    );
  });

  it("builds a bar chart with counts, sorted descending, colored", () => {
    const chart = buildChartBlock(source, {
      type: "bar",
      categoryField: "kind",
      aggregation: "count",
    });
    assert.ok(chart && chart.kind === "bar");
    assert.deepEqual(
      chart.bars.map((b) => [b.label, b.value]),
      [
        ["a", 2],
        ["b", 1],
      ],
    );
    assert.equal(chart.maxValue, 2);
    assert.ok(chart.bars.every((b) => /^#/.test(b.color)));
  });

  it("reports bar categories dropped past the top-N cap", () => {
    const many = rows(...Array.from({ length: 25 }, (_, i) => ({ kind: `k${i}` })));
    const chart = buildChartBlock(many, {
      type: "bar",
      categoryField: "kind",
      aggregation: "count",
    });
    assert.ok(chart && chart.kind === "bar");
    assert.equal(chart.bars.length, 20);
    assert.equal(chart.truncated, 5);
  });

  it("builds a sum-aggregated pie whose slices carry the total", () => {
    const chart = buildChartBlock(source, {
      type: "pie",
      categoryField: "kind",
      aggregation: "sum",
      valueField: "v",
    });
    assert.ok(chart && chart.kind === "pie");
    assert.equal(chart.total, 45);
    assert.deepEqual(
      chart.slices.map((s) => [s.label, s.value]),
      [
        ["a", 40],
        ["b", 5],
      ],
    );
  });

  it("builds a line chart over row order, skipping non-numeric rows", () => {
    const chart = buildChartBlock(rows({ v: 1 }, { v: "x" }, { v: 3 }), {
      type: "line",
      valueField: "v",
    });
    assert.ok(chart && chart.kind === "line");
    assert.deepEqual(
      chart.points.map((p) => [p.index, p.value]),
      [
        [0, 1],
        [2, 3],
      ],
    );
    assert.equal(chart.min, 1);
    assert.equal(chart.max, 3);
    assert.equal(chart.length, 3);
  });
});
