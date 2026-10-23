import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExpression, featureFilter } from "@maplibre/maplibre-gl-style-spec";
import type { Polygon } from "geojson";
import type { FileMetaData } from "hyparquet";
import {
  FTW_YEARS,
  coverageColorExpression,
  ftwArchiveUrl,
  ftwCellsLayer,
  ftwFieldsLayer,
  ftwRowsToFeatures,
  ftwZoneParquetUrl,
  geometryBbox,
  parseFtwZoneIndex,
  planFtwRead,
  scoreColorExpression,
  scoreFilterExpression,
  searchFtwZones,
  splitAntimeridian,
  thresholdFromFilter,
} from "../packages/plugins/src/plugins/fields-of-the-world-data";

/** Runs a filter through MapLibre's own compiler, as the renderer would. */
function kept(filter: unknown[] | undefined, scores: unknown[]): unknown[] {
  if (!filter) return scores;
  const compiled = featureFilter(filter as never, "layers[0].filter");
  return scores.filter((score) =>
    compiled.filter({ zoom: 12 }, { type: 3, properties: { score } } as never, undefined as never),
  );
}

function colorOf(expression: unknown[], properties: Record<string, unknown>): string {
  const compiled = createExpression(expression as never, { type: "color" } as never);
  assert.equal(compiled.result, "success");
  if (compiled.result !== "success") throw new Error("unreachable");
  const color = compiled.value.evaluate({ zoom: 12 } as never, { properties } as never) as {
    r: number;
    g: number;
    b: number;
  };
  const hex = (value: number): string =>
    Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
}

describe("fields of the world archives", () => {
  it("covers the nine 2nd Edition years", () => {
    assert.deepEqual(FTW_YEARS, [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]);
  });

  it("reads fields and cells from one archive per year", () => {
    const url = "https://data.source.coop/ftw/global-data-2e/vector/2019/fields-2019.pmtiles";
    assert.equal(ftwArchiveUrl(2019), url);
    assert.deepEqual(ftwFieldsLayer(2019), {
      url,
      sourceLayer: "fields",
      minZoom: 9,
      maxZoom: 13,
    });
    assert.deepEqual(ftwCellsLayer(2019), { url, sourceLayer: "cells", minZoom: 0, maxZoom: 8 });
  });

  it("builds zone GeoParquet URLs with a two-digit zone", () => {
    assert.equal(
      ftwZoneParquetUrl(2025, 1),
      "https://data.source.coop/ftw/global-data-2e/vector/2025/zone=01/utm01.parquet",
    );
    assert.equal(
      ftwZoneParquetUrl(2017, 31),
      "https://data.source.coop/ftw/global-data-2e/vector/2017/zone=31/utm31.parquet",
    );
  });
});

describe("fields of the world score", () => {
  it("filters fields below the threshold, coercing non-numbers", () => {
    const values = [44, 45, "60", null, undefined, 100];
    assert.deepEqual(kept(scoreFilterExpression(45), values), [45, "60", 100]);
    assert.equal(scoreFilterExpression(0), undefined);
    assert.deepEqual(kept(scoreFilterExpression(0), values), values);
    // Out-of-range and fractional thresholds are clamped and rounded.
    assert.deepEqual(scoreFilterExpression(150)?.[2], 100);
    assert.deepEqual(scoreFilterExpression(44.6)?.[2], 45);
  });

  it("round-trips a threshold through the filter it wrote", () => {
    for (const threshold of [1, 35, 70, 99, 100]) {
      assert.equal(thresholdFromFilter(scoreFilterExpression(threshold)), threshold);
    }
    assert.equal(thresholdFromFilter(undefined), 0);
    // A hand-edited filter, or a 1st Edition confidence filter, is left alone.
    assert.equal(thresholdFromFilter([">=", ["get", "score"], 30]), null);
    assert.equal(
      thresholdFromFilter([">=", ["to-number", ["get", "confidence_mean"], 0], 0.4]),
      null,
    );
  });

  it("colors fields with the dataset's score bins", () => {
    const color = (score: unknown): string => colorOf(scoreColorExpression(), { score });
    assert.equal(color(0), "#d73027");
    assert.equal(color(44), "#d73027");
    assert.equal(color(45), "#fdae61");
    assert.equal(color("60"), "#ffffbf");
    assert.equal(color(79), "#a6d96a");
    assert.equal(color(80), "#1a9850");
    assert.equal(color(null), "#d73027");
  });

  it("colors cells by the share of their area in fields", () => {
    const color = (pct_covered: unknown): string =>
      colorOf(coverageColorExpression(), { pct_covered });
    assert.equal(color(0), "#ffffd9");
    assert.equal(color(9.9), "#edf8b1");
    assert.equal(color(50), "#225ea8");
    assert.equal(color(100), "#081d58");
  });
});

describe("fields of the world zone index", () => {
  // The shape hyparquet returns for index/vector.parquet (ints as bigint).
  const zones = parseFtwZoneIndex([
    {
      year: 2025n,
      zone: 1n,
      size_bytes: 3798181n,
      n_parcels: 6733n,
      xmin: -175.35,
      ymin: -21.27,
      xmax: -175.07,
      ymax: -21.09,
    },
    {
      year: 2025,
      zone: 31,
      size_bytes: 4693301951,
      n_parcels: 5566113,
      xmin: -0.06,
      ymin: 5.42,
      xmax: 6.73,
      ymax: 53.76,
    },
    {
      year: 2025,
      zone: 32,
      size_bytes: 4863484649,
      n_parcels: 1,
      xmin: 5.9,
      ymin: 0,
      xmax: 12.1,
      ymax: 55,
    },
    { year: 2024, zone: 31, xmin: -0.06, ymin: 5.42, xmax: 6.73, ymax: 53.76 },
    { year: 2025, zone: 60, xmin: 174, ymin: -46, xmax: 179.8, ymax: -35 },
    // Malformed: no extent, skipped.
    { year: 2025, zone: 33 },
  ]);

  it("parses rows and rebuilds each file's URL", () => {
    assert.equal(zones.length, 5);
    assert.deepEqual(zones[0], {
      year: 2025,
      zone: 1,
      url: "https://data.source.coop/ftw/global-data-2e/vector/2025/zone=01/utm01.parquet",
      sizeBytes: 3798181,
      parcels: 6733,
      bbox: [-175.35, -21.27, -175.07, -21.09],
    });
    assert.equal(zones[3].sizeBytes, 0);
  });

  it("finds the year's zones overlapping a box, west to east", () => {
    assert.deepEqual(
      searchFtwZones(zones, [6, 45, 7, 46], 2025).map((zone) => zone.zone),
      [31, 32],
    );
    assert.deepEqual(
      searchFtwZones(zones, [1.5, 48.2, 1.6, 48.3], 2024).map((zone) => zone.zone),
      [31],
    );
    assert.deepEqual(searchFtwZones(zones, [100, 0, 101, 1], 2025), []);
  });

  it("searches a view that crosses the antimeridian", () => {
    assert.deepEqual(splitAntimeridian([170, -50, -170, 0]), [
      [170, -50, 180, 0],
      [-180, -50, -170, 0],
    ]);
    assert.deepEqual(
      searchFtwZones(zones, [170, -50, -170, 0], 2025).map((zone) => zone.zone),
      [1, 60],
    );
  });
});

describe("fields of the world row-group planning", () => {
  /** A row group whose bbox.* statistics span a box, as hyparquet decodes them. */
  const group = (rows: number, box: [number, number, number, number] | null, bytes = 100) => ({
    num_rows: BigInt(rows),
    columns: [
      ...(box
        ? (["xmin", "ymin", "xmax", "ymax"] as const).map((name, index) => ({
            meta_data: {
              path_in_schema: ["bbox", name],
              total_compressed_size: BigInt(bytes),
              // A field's xmin ranges from the group's west to east, and so on.
              statistics: {
                min_value: index < 2 ? box[index] : box[index - 2],
                max_value: index < 2 ? box[index + 2] : box[index],
              },
            },
          }))
        : []),
      {
        meta_data: {
          path_in_schema: ["geometry"],
          total_compressed_size: BigInt(bytes * 10),
        },
      },
      // Not a read column, so not counted.
      { meta_data: { path_in_schema: ["collection"], total_compressed_size: 99999n } },
    ],
  });
  const metadata = {
    row_groups: [
      group(8192, [0, 0, 1, 1]),
      group(8192, [1, 0, 2, 1]),
      group(100, [5, 5, 6, 6]),
      group(50, null),
    ],
  } as unknown as FileMetaData;

  it("keeps only the groups overlapping the area", () => {
    const plan = planFtwRead(metadata, [0.5, 0.5, 0.9, 0.9]);
    // The first group, and the one without statistics (it may overlap).
    assert.deepEqual(
      plan.groups.map((g) => [g.rowStart, g.rowEnd]),
      [
        [0, 8192],
        [16484, 16534],
      ],
    );
    assert.equal(plan.rows, 8242);
    // bbox ×4 + geometry, then the stats-less group's geometry; `collection`
    // is never read.
    assert.equal(plan.bytes, 4 * 100 + 1000 + 1000);
    assert.deepEqual(plan.extent, [0.5, 0.5, 0.9, 0.9]);
  });

  it("clips the extent to the groups' union inside the area", () => {
    const only = { row_groups: metadata.row_groups.slice(0, 3) } as unknown as FileMetaData;
    const plan = planFtwRead(only, [0.5, -1, 1.5, 0.5]);
    assert.equal(plan.groups.length, 2);
    assert.deepEqual(plan.extent, [0.5, 0, 1.5, 0.5]);
    assert.equal(planFtwRead(only, [10, 10, 11, 11]).extent, null);
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
      id: "31UCP_0_0-48077",
      score: 87,
      "metrics:area": 162378.125,
      "metrics:perimeter": 1924.27,
      bbox: { xmin: 6.5, ymin: 0.1, xmax: 6.51, ymax: 0.11 },
      geometry: square(6.5, 0.1, 0.01),
    },
    {
      id: "31UCP_0_0-2",
      score: Number.NaN,
      geometry: square(6.9, 0.9, 0.01),
    },
    { id: "no-geometry", geometry: null },
  ];

  it("turns rows into features and drops rows without geometry", () => {
    const features = ftwRowsToFeatures(rows);
    assert.equal(features.length, 2);
    assert.deepEqual(features[0].properties, {
      id: "31UCP_0_0-48077",
      score: 87,
      "metrics:area": 162378.125,
      "metrics:perimeter": 1924.27,
    });
    assert.equal(features[1].properties.score, null);
  });

  it("keeps only fields overlapping a clip box, whole", () => {
    const features = ftwRowsToFeatures(rows, [6.505, 0.105, 6.6, 0.2]);
    assert.equal(features.length, 1);
    assert.deepEqual(features[0].geometry, square(6.5, 0.1, 0.01));
    // A row without a bbox struct falls back to the geometry's own bounds.
    assert.equal(ftwRowsToFeatures(rows, [6.905, 0.905, 7, 1]).length, 1);
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
