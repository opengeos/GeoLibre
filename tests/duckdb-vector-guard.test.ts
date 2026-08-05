import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  confirmLargeDataset,
  DUCKDB_VECTOR_FEATURE_WARN_COUNT,
  DUCKDB_VECTOR_ROUTE_BYTES,
  shouldRouteToDuckDb,
  VectorLoadCancelledError,
} from "../apps/geolibre-desktop/src/lib/duckdb-vector-guard";

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
