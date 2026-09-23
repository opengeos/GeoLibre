import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExpression, featureFilter } from "@maplibre/maplibre-gl-style-spec";
import type { Polygon } from "geojson";
import {
  FTW_MAX_CONFIDENCE,
  FTW_YEARS,
  clipCoversTile,
  confidenceColorExpression,
  confidenceFilterExpression,
  ftwArchive,
  ftwRowsToFeatures,
  ftwTileParquetUrl,
  geometryBbox,
  parseFtwDownloadGrid,
  searchFtwGrid,
  splitAntimeridian,
  thresholdFromFilter,
  thresholdToConfidence,
} from "../packages/plugins/src/plugins/fields-of-the-world-data";

/** Runs a filter through MapLibre's own compiler, as the renderer would. */
function kept(filter: unknown[] | undefined, confidences: unknown[]): unknown[] {
  if (!filter) return confidences;
  const compiled = featureFilter(filter as never, "layers[0].filter");
  return confidences.filter((confidence_mean) =>
    compiled.filter(
      { zoom: 12 },
      { type: 3, properties: { confidence_mean } } as never,
      undefined as never,
    ),
  );
}

function colorOf(confidence: unknown): string {
  const compiled = createExpression(
    confidenceColorExpression() as never,
    {
      type: "color",
    } as never,
  );
  assert.equal(compiled.result, "success");
  if (compiled.result !== "success") throw new Error("unreachable");
  const color = compiled.value.evaluate(
    { zoom: 12 } as never,
    {
      properties: { confidence_mean: confidence },
    } as never,
  ) as { r: number; g: number; b: number };
  const hex = (value: number): string =>
    Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
}

// A trimmed copy of three real cells of ftw-download-grid-v2.geojson.
const GRID = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "N00E005",
      geometry: { type: "Polygon", coordinates: [] },
      properties: {
        tile_id: "N00E005",
        lat_min: 0,
        lon_min: 5,
        years: [2024, 2025],
        feature_counts: { "2024": 3, "2025": 1 },
        size_bytes: { "2024": 2667, "2025": 2706 },
      },
    },
    {
      type: "Feature",
      id: "N00E006",
      geometry: { type: "Polygon", coordinates: [] },
      properties: {
        tile_id: "N00E006",
        lat_min: 0,
        lon_min: 6,
        years: [2024, 2025],
        feature_counts: { "2024": 77, "2025": 267 },
        size_bytes: { "2024": 12969, "2025": 40541 },
      },
    },
    {
      type: "Feature",
      id: "N00E007",
      geometry: { type: "Polygon", coordinates: [] },
      properties: {
        tile_id: "N00E007",
        lat_min: 0,
        lon_min: 7,
        years: [2025],
        feature_counts: { "2025": 3 },
        size_bytes: { "2025": 2653 },
      },
    },
    // Malformed: no corner, skipped.
    { type: "Feature", properties: { tile_id: "BROKEN" } },
  ],
};

describe("fields of the world archives", () => {
  it("points each year at its archive and source layer", () => {
    assert.deepEqual(FTW_YEARS, [2024, 2025]);
    const released = ftwArchive(2025);
    assert.equal(
      released.url,
      "https://data.source.coop/ftw/global-field-boundaries/pmtiles/ftw-global-fields-2025.pmtiles",
    );
    assert.equal(released.sourceLayer, "fields");
    assert.equal(released.minZoom, 0);
    const alpha = ftwArchive(2024);
    assert.match(alpha.url, /\/alpha\/2024_with_confidence\.pmtiles$/);
    // The alpha archive names its layer after the year and starts at zoom 10.
    assert.equal(alpha.sourceLayer, "2024");
    assert.equal(alpha.minZoom, 10);
  });

  it("builds tile GeoParquet URLs the way the FTW app does", () => {
    assert.equal(
      ftwTileParquetUrl(2025, "N00E006"),
      "https://data.source.coop/ftw/global-field-boundaries/download-tiles/geoparquet/2025/2025_N00E006.parquet",
    );
  });
});

describe("fields of the world confidence", () => {
  it("maps the 0–100% threshold onto the model's confidence range", () => {
    assert.equal(thresholdToConfidence(0), 0);
    assert.equal(thresholdToConfidence(100), FTW_MAX_CONFIDENCE);
    assert.equal(thresholdToConfidence(150), FTW_MAX_CONFIDENCE);
    assert.equal(thresholdToConfidence(-5), 0);
    assert.ok(Math.abs(thresholdToConfidence(70) - 0.4047246) < 1e-6);
  });

  it("filters fields below the threshold, coercing string confidences", () => {
    const cutoff = thresholdToConfidence(70);
    // The 2025 archive stores confidence as strings; tiles loaded from
    // GeoParquet carry numbers; a missing value counts as 0.
    const values = [String(cutoff - 0.01), String(cutoff + 0.01), cutoff + 0.02, null, undefined];
    assert.deepEqual(kept(confidenceFilterExpression(70), values), [
      String(cutoff + 0.01),
      cutoff + 0.02,
    ]);
    assert.equal(confidenceFilterExpression(0), undefined);
    assert.deepEqual(kept(confidenceFilterExpression(0), values), values);
  });

  it("round-trips a threshold through the filter it wrote", () => {
    for (const percent of [1, 35, 70, 99, 100]) {
      assert.equal(thresholdFromFilter(confidenceFilterExpression(percent)), percent);
    }
    assert.equal(thresholdFromFilter(undefined), 0);
    // A hand-edited filter is left alone rather than misread.
    assert.equal(thresholdFromFilter([">=", ["get", "confidence_mean"], 0.3]), null);
    assert.equal(thresholdFromFilter(["==", ["get", "label"], "field"]), null);
  });

  it("colors fields from red (low) to green (high)", () => {
    assert.equal(colorOf("0"), "#d7191c");
    assert.equal(colorOf(thresholdToConfidence(70)), "#fec379");
    assert.equal(colorOf(FTW_MAX_CONFIDENCE), "#33a02c");
    assert.equal(colorOf(0.9), "#33a02c");
    assert.equal(colorOf(null), "#d7191c");
  });
});

describe("fields of the world download grid", () => {
  const tiles = parseFtwDownloadGrid(GRID);

  it("parses cells into 1° boxes with per-year counts", () => {
    assert.equal(tiles.length, 3);
    assert.deepEqual(tiles[1], {
      id: "N00E006",
      bbox: [6, 0, 7, 1],
      years: [2024, 2025],
      featureCounts: { "2024": 77, "2025": 267 },
      sizeBytes: { "2024": 12969, "2025": 40541 },
    });
    assert.throws(() => parseFtwDownloadGrid({}));
  });

  it("finds cells for a year in a box, most fields first", () => {
    const all = searchFtwGrid(tiles, [4.5, -0.5, 7.5, 0.5], 2025);
    assert.deepEqual(
      all.tiles.map((tile) => tile.id),
      ["N00E006", "N00E007", "N00E005"],
    );
    assert.equal(all.total, 3);
    // N00E007 has no 2024 file.
    assert.deepEqual(
      searchFtwGrid(tiles, [4.5, -0.5, 7.5, 0.5], 2024).tiles.map((tile) => tile.id),
      ["N00E006", "N00E005"],
    );
    // A box touching a cell only along its edge does not select it.
    assert.deepEqual(
      searchFtwGrid(tiles, [7, 0.2, 7.5, 0.4], 2025).tiles.map((tile) => tile.id),
      ["N00E007"],
    );
    const capped = searchFtwGrid(tiles, [-180, -90, 180, 90], 2025, 1);
    assert.equal(capped.tiles.length, 1);
    assert.equal(capped.total, 3);
  });

  it("searches a view that crosses the antimeridian", () => {
    const dateline = parseFtwDownloadGrid({
      features: [
        { properties: { tile_id: "S17E179", lat_min: -17, lon_min: 179, years: [2025] } },
        { properties: { tile_id: "S17W180", lat_min: -17, lon_min: -180, years: [2025] } },
        { properties: { tile_id: "S17E000", lat_min: -17, lon_min: 0, years: [2025] } },
      ],
    });
    assert.deepEqual(splitAntimeridian([170, -20, -170, -10]), [
      [170, -20, 180, -10],
      [-180, -20, -170, -10],
    ]);
    assert.deepEqual(
      searchFtwGrid(dateline, [170, -20, -170, -10], 2025)
        .tiles.map((tile) => tile.id)
        .sort(),
      ["S17E179", "S17W180"],
    );
    assert.equal(clipCoversTile([170, -20, -170, -10], dateline[0]), true);
    assert.equal(clipCoversTile([170, -20, -170, -10], dateline[2]), false);
  });

  it("knows when a clip box keeps a whole tile", () => {
    const tile = tiles[1]; // [6, 0, 7, 1]
    assert.equal(clipCoversTile([-180, -90, 180, 90], tile), true);
    assert.equal(clipCoversTile([6, 0, 7, 1], tile), true);
    assert.equal(clipCoversTile([6.5, 0, 7, 1], tile), false);
  });
});

describe("fields of the world GeoParquet rows", () => {
  const square = (west: number, south: number, size: number): Polygon => ({
    type: "Polygon",
    coordinates: [
      [
        [west, south],
        [west + size, south],
        [west + size, south + size],
        [west, south + size],
        [west, south],
      ],
    ],
  });
  // The shape hyparquet returns: WKB already decoded to GeoJSON geometry.
  const rows = [
    {
      time: new Date("2025-01-01T00:00:00Z"),
      label: "field",
      confidence_mean: 0.14,
      confidence_median: 0.13,
      confidence_min: 0.1,
      geometry: square(6.5, 0.1, 0.01),
      chunk_id: "N00E006",
    },
    {
      time: new Date("2025-01-01T00:00:00Z"),
      label: "field",
      confidence_mean: 0.5,
      confidence_median: Number.NaN,
      confidence_min: 0.4,
      geometry: square(6.9, 0.9, 0.01),
      chunk_id: "N00E006",
    },
    { label: "field", geometry: null },
  ];

  it("turns rows into features and drops rows without geometry", () => {
    const features = ftwRowsToFeatures(rows);
    assert.equal(features.length, 2);
    assert.deepEqual(features[0].properties, {
      confidence_mean: 0.14,
      confidence_median: 0.13,
      confidence_min: 0.1,
      label: "field",
      time: "2025-01-01T00:00:00.000Z",
      tile_id: "N00E006",
    });
    assert.equal(features[1].properties.confidence_median, null);
  });

  it("keeps only fields overlapping a clip box, whole", () => {
    const features = ftwRowsToFeatures(rows, [6.505, 0.105, 6.6, 0.2]);
    assert.equal(features.length, 1);
    assert.deepEqual(features[0].geometry, square(6.5, 0.1, 0.01));
  });

  it("clips with a box crossing the antimeridian", () => {
    const dateline = [
      { geometry: square(179.5, -17, 0.1) },
      { geometry: square(-179.5, -17, 0.1) },
      { geometry: square(0, -17, 0.1) },
    ];
    assert.equal(ftwRowsToFeatures(dateline, [179, -18, -179, -16]).length, 2);
  });

  it("measures geometry bounds", () => {
    assert.deepEqual(geometryBbox(square(1, 2, 3)), [1, 2, 4, 5]);
    assert.deepEqual(
      geometryBbox({
        type: "GeometryCollection",
        geometries: [square(0, 0, 1), { type: "Point", coordinates: [5, -1] }],
      }),
      [0, -1, 5, 1],
    );
    assert.equal(geometryBbox(null), null);
  });
});
