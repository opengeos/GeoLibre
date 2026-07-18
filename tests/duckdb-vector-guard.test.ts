import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  confirmLargeDataset,
  DUCKDB_VECTOR_FEATURE_WARN_COUNT,
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
