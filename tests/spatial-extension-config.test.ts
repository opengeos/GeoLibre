import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSpatialExtensionPath } from "../apps/geolibre-desktop/src/lib/spatial-extension-config";

describe("getSpatialExtensionPath", () => {
  it("returns undefined when env is missing or empty", () => {
    assert.equal(getSpatialExtensionPath(undefined), undefined);
    assert.equal(getSpatialExtensionPath({}), undefined);
    assert.equal(getSpatialExtensionPath({ VITE_DUCKDB_SPATIAL_EXTENSION_PATH: "" }), undefined);
    assert.equal(getSpatialExtensionPath({ VITE_DUCKDB_SPATIAL_EXTENSION_PATH: "   " }), undefined);
  });

  it("returns the path when env is set", () => {
    assert.equal(
      getSpatialExtensionPath({
        VITE_DUCKDB_SPATIAL_EXTENSION_PATH: "C:/test.duckdb_extension",
      }),
      "C:/test.duckdb_extension",
    );
  });

  it("trims whitespace from the env value", () => {
    assert.equal(
      getSpatialExtensionPath({
        VITE_DUCKDB_SPATIAL_EXTENSION_PATH: "  C:/test.duckdb_extension  ",
      }),
      "C:/test.duckdb_extension",
    );
  });
});
