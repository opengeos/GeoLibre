import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMultipleDatasetParameter } from "../apps/geolibre-desktop/src/lib/whitebox-param-kind";

describe("isMultipleDatasetParameter", () => {
  it("uses explicit multiple cardinality", () => {
    assert.equal(
      isMultipleDatasetParameter({
        name: "inputs",
        data_kind: "raster",
        io_role: "input",
        schema: { kind: "input", cardinality: "multiple" },
      }),
      true,
    );
  });

  it("repairs Merge Vectors' incorrect single cardinality from its description", () => {
    assert.equal(
      isMultipleDatasetParameter({
        name: "inputs",
        description: "Array of input vector paths (at least two required).",
        data_kind: "vector",
        io_role: "input",
        schema: { kind: "input", cardinality: "single" },
      }),
      true,
    );
  });

  it("recognizes descriptions with several dataset qualifiers", () => {
    assert.equal(
      isMultipleDatasetParameter({
        name: "tiles",
        description: "Array of LiDAR tile paths or a directory containing LAS/LAZ tiles.",
        data_kind: "lidar",
        io_role: "input",
      }),
      true,
    );
  });

  it("does not turn ordinary dataset inputs or scalar lists into dataset pickers", () => {
    assert.equal(isMultipleDatasetParameter({ name: "input", kind: "vector_in" }), false);
    assert.equal(
      isMultipleDatasetParameter({
        name: "fields",
        description: "List of field names.",
        kind: "string",
      }),
      false,
    );
  });
});
