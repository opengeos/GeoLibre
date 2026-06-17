import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { vectorSpatialExtensionPath } from "../packages/plugins/src/plugins/maplibre-vector";

describe("vectorSpatialExtensionPath", () => {
  it("returns undefined when env is missing or empty", () => {
    assert.equal(vectorSpatialExtensionPath({}), undefined);
    assert.equal(
      vectorSpatialExtensionPath({ VITE_DUCKDB_SPATIAL_EXTENSION_PATH: "" }),
      undefined,
    );
    assert.equal(
      vectorSpatialExtensionPath({ VITE_DUCKDB_SPATIAL_EXTENSION_PATH: "   " }),
      undefined,
    );
  });

  it("returns the trimmed path when env is set", () => {
    assert.equal(
      vectorSpatialExtensionPath({
        VITE_DUCKDB_SPATIAL_EXTENSION_PATH: "  /vendor/spatial.duckdb_extension  ",
      }),
      "/vendor/spatial.duckdb_extension",
    );
  });
});
