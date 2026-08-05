import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  confirmLargeDataset,
  confirmLargeVectorFile,
  DUCKDB_VECTOR_FEATURE_WARN_COUNT,
  exceedsTextVectorLimit,
  LARGE_VECTOR_SIZE_WARN_BYTES,
  MAX_SHPJS_SHP_BYTES,
  MAX_TEXT_VECTOR_BYTES,
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

describe("confirmLargeVectorFile", () => {
  const HUGE = { name: "counties.geojson", sizeBytes: 539 * 1024 * 1024 };

  it("does nothing when no callback is supplied", async () => {
    await assert.doesNotReject(confirmLargeVectorFile(HUGE, undefined));
  });

  it("does nothing when the size is unknown", async () => {
    // A failed `stat` must not block the load, and must not invent a size.
    let called = false;
    await confirmLargeVectorFile(undefined, () => {
      called = true;
      return false;
    });
    assert.equal(called, false);
  });

  it("skips the callback below the warn threshold", async () => {
    let called = false;
    await confirmLargeVectorFile(
      { name: "small.geojson", sizeBytes: LARGE_VECTOR_SIZE_WARN_BYTES - 1 },
      () => {
        called = true;
        return false;
      },
    );
    assert.equal(called, false);
  });

  it("invokes the callback at the threshold with the file details", async () => {
    const seen: unknown[] = [];
    await confirmLargeVectorFile(
      { name: "edge.geojson", sizeBytes: LARGE_VECTOR_SIZE_WARN_BYTES },
      (file) => {
        seen.push(file);
        return true;
      },
    );
    assert.deepEqual(seen, [{ name: "edge.geojson", sizeBytes: LARGE_VECTOR_SIZE_WARN_BYTES }]);
  });

  it("throws VectorLoadCancelledError when the user declines", async () => {
    await assert.rejects(
      confirmLargeVectorFile(HUGE, () => false),
      VectorLoadCancelledError,
    );
  });

  it("awaits an async callback decision", async () => {
    await assert.rejects(
      confirmLargeVectorFile(HUGE, () => Promise.resolve(false)),
      VectorLoadCancelledError,
    );
  });
});

describe("exceedsTextVectorLimit", () => {
  it("matches V8's maximum string length", () => {
    // The loaders' whole reason for checking is that `readTextFile` /
    // `File.text()` throw RangeError at this exact size, so the mirror must not
    // drift from `require("buffer").constants.MAX_STRING_LENGTH` (2**29 - 24).
    assert.equal(MAX_TEXT_VECTOR_BYTES, 2 ** 29 - 24);
  });

  it("treats an unknown size as within the limit", () => {
    assert.equal(exceedsTextVectorLimit(undefined), false);
  });

  it("rejects the limit itself and accepts one byte under it", () => {
    assert.equal(exceedsTextVectorLimit(MAX_TEXT_VECTOR_BYTES), true);
    assert.equal(exceedsTextVectorLimit(MAX_TEXT_VECTOR_BYTES - 1), false);
  });

  it("diverts the reported 539 MB GeoJSON off the text path", () => {
    // The reported 539 MB case: just over the ceiling, so the text parse
    // could never have succeeded.
    assert.equal(exceedsTextVectorLimit(539 * 1000 * 1000), true);
  });
});

describe("shapefile thresholds", () => {
  it("sends a large .shp to DuckDB well before the string limit applies", () => {
    // The shapefile guard is about shpjs's synchronous per-coordinate proj4
    // walk, not about string length, so it must trip far earlier.
    assert.ok(MAX_SHPJS_SHP_BYTES < MAX_TEXT_VECTOR_BYTES);
    assert.ok(MAX_SHPJS_SHP_BYTES < LARGE_VECTOR_SIZE_WARN_BYTES);
  });
});
