import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  confirmLargeDataset,
  DUCKDB_VECTOR_FEATURE_WARN_COUNT,
  DUCKDB_VECTOR_ROUTE_BYTES,
  shouldRouteToDuckDb,
  VectorLoadCancelledError,
} from "../apps/geolibre-desktop/src/lib/duckdb-vector-guard";
import { detectNonGeographicCoordinates } from "../packages/core/src/types";

describe("confirmLargeDataset", () => {
  it("does nothing when no callback is supplied", async () => {
    await assert.doesNotReject(
      confirmLargeDataset({ name: "huge.parquet", featureCount: 10_000_000 }, undefined),
    );
  });

  it("skips the callback below the warn threshold", async () => {
    let called = false;
    await confirmLargeDataset(
      { name: "small.gpkg", featureCount: DUCKDB_VECTOR_FEATURE_WARN_COUNT - 1 },
      () => {
        called = true;
        return false;
      },
    );
    assert.equal(called, false);
  });

  it("invokes the callback at the threshold with the dataset details", async () => {
    const seen: unknown[] = [];
    await confirmLargeDataset(
      { name: "edge.fgb", featureCount: DUCKDB_VECTOR_FEATURE_WARN_COUNT },
      (dataset) => {
        seen.push(dataset);
        return true;
      },
    );
    assert.deepEqual(seen, [{ name: "edge.fgb", featureCount: DUCKDB_VECTOR_FEATURE_WARN_COUNT }]);
  });

  it("resolves when the user proceeds", async () => {
    await assert.doesNotReject(
      confirmLargeDataset({ name: "big.shp", featureCount: 2_000_000 }, () => true),
    );
  });

  it("throws VectorLoadCancelledError when the user declines", async () => {
    await assert.rejects(
      confirmLargeDataset({ name: "big.shp", featureCount: 2_000_000 }, () => false),
      VectorLoadCancelledError,
    );
  });

  it("awaits an async callback decision", async () => {
    await assert.rejects(
      confirmLargeDataset({ name: "big.shp", featureCount: 2_000_000 }, () =>
        Promise.resolve(false),
      ),
      VectorLoadCancelledError,
    );
  });
});

describe("shouldRouteToDuckDb", () => {
  it("treats an unknown size as small", () => {
    // A failed `stat` must not divert every file to DuckDB.
    assert.equal(shouldRouteToDuckDb(undefined), false);
  });

  it("routes at the threshold and keeps one byte under it in-memory", () => {
    assert.equal(shouldRouteToDuckDb(DUCKDB_VECTOR_ROUTE_BYTES), true);
    assert.equal(shouldRouteToDuckDb(DUCKDB_VECTOR_ROUTE_BYTES - 1), false);
  });

  it("routes the reported 148 MB shapefile and 539 MB GeoJSON", () => {
    assert.equal(shouldRouteToDuckDb(148 * 1024 * 1024), true);
    assert.equal(shouldRouteToDuckDb(539 * 1000 * 1000), true);
  });

  it("stays below V8's maximum string length", () => {
    // Text files at or above 2**29 - 24 bytes cannot be read into a string at
    // all; routing far below that is what makes the RangeError unreachable.
    assert.ok(DUCKDB_VECTOR_ROUTE_BYTES < 2 ** 29 - 24);
  });
});

describe("configured defaults", () => {
  it("routes at 100 MB and warns at 100k features", () => {
    assert.equal(DUCKDB_VECTOR_ROUTE_BYTES, 100 * 1024 * 1024);
    assert.equal(DUCKDB_VECTOR_FEATURE_WARN_COUNT, 100_000);
  });
});

describe("detectNonGeographicCoordinates", () => {
  const fc = (coordinates: unknown, type = "Point") => ({
    type: "FeatureCollection" as const,
    features: [{ type: "Feature" as const, properties: {}, geometry: { type, coordinates } }],
  });

  it("passes ordinary WGS84 coordinates", () => {
    assert.equal(detectNonGeographicCoordinates(fc([-72.6, 41.9]) as never), null);
  });

  it("accepts the exact WGS84 corners", () => {
    assert.equal(detectNonGeographicCoordinates(fc([180, 90]) as never), null);
    assert.equal(detectNonGeographicCoordinates(fc([-180, -90]) as never), null);
  });

  it("flags projected coordinates hiding behind a geographic CRS", () => {
    // The CT_Wetlands case: EPSG:5070 Albers metres declared as CRS84.
    const found = detectNonGeographicCoordinates(fc([1905935.66, 2337159.4]) as never);
    assert.ok(found);
    assert.equal(found.sampled, 1);
    assert.equal(Math.round(found.maxAbsX), 1905936);
  });

  it("walks nested MultiPolygon rings", () => {
    const nested = fc(
      [
        [
          [
            [1820601, 2201748],
            [1993899, 2377614],
          ],
        ],
      ],
      "MultiPolygon",
    );
    assert.ok(detectNonGeographicCoordinates(nested as never));
  });

  it("ignores a latitude just inside range but a longitude just outside", () => {
    assert.equal(detectNonGeographicCoordinates(fc([180.5, 12]) as never)?.sampled, 1);
    assert.equal(detectNonGeographicCoordinates(fc([12, 90.5]) as never)?.sampled, 1);
  });

  it("treats non-finite coordinates as a different defect, not a CRS mismatch", () => {
    assert.equal(detectNonGeographicCoordinates(fc([Number.NaN, Number.NaN]) as never), null);
  });

  it("returns null for an empty or missing collection", () => {
    assert.equal(detectNonGeographicCoordinates(undefined), null);
    assert.equal(detectNonGeographicCoordinates({ type: "FeatureCollection", features: [] }), null);
  });

  it("stops at the sample limit instead of walking the whole collection", () => {
    // The out-of-range feature sits past the limit, so a null result proves the
    // walk actually stopped — an all-valid collection would pass even if
    // `sampleLimit` were ignored entirely.
    const many = {
      type: "FeatureCollection" as const,
      features: Array.from({ length: 5000 }, (_unused, index) => ({
        type: "Feature" as const,
        properties: {},
        geometry: {
          type: "Point",
          coordinates: index === 40 ? [1905935.66, 2337159.4] : [-72, 41],
        },
      })),
    };
    assert.equal(detectNonGeographicCoordinates(many as never, 25), null);
    // ...and it is still found when the limit reaches it.
    assert.ok(detectNonGeographicCoordinates(many as never, 100));
  });
});

describe("detectNonGeographicCoordinates with GeometryCollection", () => {
  it("visits coordinates nested under geometries[]", () => {
    // A GeometryCollection has no `coordinates` of its own, so it was skipped
    // entirely before and a wholly-GeometryCollection file passed silently.
    const gc = {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          properties: {},
          geometry: {
            type: "GeometryCollection",
            geometries: [{ type: "Point", coordinates: [1905935.66, 2337159.4] }],
          },
        },
      ],
    };
    const found = detectNonGeographicCoordinates(gc as never);
    assert.ok(found);
    assert.equal(Math.round(found.maxAbsX), 1905936);
  });

  it("still passes a geographic GeometryCollection", () => {
    const gc = {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          properties: {},
          geometry: {
            type: "GeometryCollection",
            geometries: [{ type: "Point", coordinates: [-72.6, 41.9] }],
          },
        },
      ],
    };
    assert.equal(detectNonGeographicCoordinates(gc as never), null);
  });
});
