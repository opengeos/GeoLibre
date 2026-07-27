import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  readZarrStoreMetadata,
  variablesFromConsolidatedV2,
  variablesFromConsolidatedV3,
  type ZarrDirectoryLister,
  type ZarrMetadataReader,
} from "../packages/plugins/src/plugins/zarr-store-metadata";

/** A reader over a fixed key -> document map, like a store's metadata. */
function readerFor(documents: Record<string, unknown>): ZarrMetadataReader {
  return async (key: string) => documents[key];
}

/** A lister over a fixed directory -> entry-names map. */
function listerFor(tree: Record<string, string[]>): ZarrDirectoryLister {
  return async (path: string) => (tree[path] ?? []).map((name) => ({ name, isDirectory: true }));
}

/** The shape of a real multiscale pyramid's `.zmetadata` (CarbonPlan's demo). */
const PYRAMID_CONSOLIDATED = {
  metadata: {
    ".zgroup": { zarr_format: 2 },
    "0/climate/.zarray": { shape: [2, 12, 128, 128] },
    "0/climate/.zattrs": { _ARRAY_DIMENSIONS: ["band", "month", "y", "x"] },
    "0/band/.zarray": { shape: [2] },
    "0/band/.zattrs": { _ARRAY_DIMENSIONS: ["band"] },
    "0/month/.zarray": { shape: [12] },
    "0/spatial_ref/.zarray": { shape: [] },
    "1/climate/.zarray": { shape: [2, 12, 256, 256] },
    "1/climate/.zattrs": { _ARRAY_DIMENSIONS: ["band", "month", "y", "x"] },
  },
};

describe("variablesFromConsolidatedV2", () => {
  it("lists a pyramid's data variable once, with its dimensions", () => {
    const variables = variablesFromConsolidatedV2(PYRAMID_CONSOLIDATED);
    assert.deepEqual(variables, [
      {
        name: "climate",
        path: "0/climate",
        dims: ["band", "month", "y", "x"],
        shape: [2, 12, 128, 128],
      },
    ]);
  });

  it("keeps the path of the level the shape came from", () => {
    // The coordinate arrays are siblings of that path, so it has to be the
    // group the array really lives in, not the bare variable name.
    const [variable] = variablesFromConsolidatedV2(PYRAMID_CONSOLIDATED);
    assert.equal(variable.path, "0/climate");
    assert.notEqual(variable.path, variable.name);
  });

  it("drops coordinate arrays, which are 1-D or scalar", () => {
    const names = variablesFromConsolidatedV2(PYRAMID_CONSOLIDATED).map((v) => v.name);
    assert.deepEqual(names, ["climate"]);
  });

  it("reads a flat store with no pyramid", () => {
    const variables = variablesFromConsolidatedV2({
      metadata: {
        "sst/.zarray": { shape: [504, 180, 360] },
        "sst/.zattrs": { _ARRAY_DIMENSIONS: ["time", "lat", "lon"] },
        "time/.zarray": { shape: [504] },
      },
    });
    assert.deepEqual(variables, [
      { name: "sst", path: "sst", dims: ["time", "lat", "lon"], shape: [504, 180, 360] },
    ]);
  });

  it("returns nothing for a document with no metadata block", () => {
    assert.deepEqual(variablesFromConsolidatedV2({}), []);
    assert.deepEqual(variablesFromConsolidatedV2(null), []);
  });
});

describe("variablesFromConsolidatedV3", () => {
  it("reads dimension_names from a v3 consolidated root", () => {
    const variables = variablesFromConsolidatedV3({
      consolidated_metadata: {
        metadata: {
          temperature: {
            node_type: "array",
            shape: [10, 20, 30],
            dimension_names: ["time", "lat", "lon"],
          },
          time: { node_type: "array", shape: [10], dimension_names: ["time"] },
          nested: { node_type: "group" },
        },
      },
    });
    assert.deepEqual(variables, [
      {
        name: "temperature",
        path: "temperature",
        dims: ["time", "lat", "lon"],
        shape: [10, 20, 30],
      },
    ]);
  });

  it("falls back to _ARRAY_DIMENSIONS for a writer that came from v2", () => {
    const [variable] = variablesFromConsolidatedV3({
      consolidated_metadata: {
        metadata: {
          "0/precip": {
            node_type: "array",
            shape: [4, 8, 8],
            attributes: { _ARRAY_DIMENSIONS: ["time", "y", "x"] },
          },
        },
      },
    });
    assert.deepEqual(variable.dims, ["time", "y", "x"]);
  });
});

describe("readZarrStoreMetadata", () => {
  it("prefers v2 consolidated metadata", async () => {
    const metadata = await readZarrStoreMetadata(readerFor({ ".zmetadata": PYRAMID_CONSOLIDATED }));
    assert.equal(metadata.version, 2);
    assert.deepEqual(
      metadata.variables.map((v) => v.name),
      ["climate"],
    );
  });

  it("falls back to a v3 consolidated root", async () => {
    const metadata = await readZarrStoreMetadata(
      readerFor({
        "zarr.json": {
          consolidated_metadata: {
            metadata: {
              sst: { node_type: "array", shape: [3, 4, 5], dimension_names: ["time", "y", "x"] },
            },
          },
        },
      }),
    );
    assert.equal(metadata.version, 3);
    assert.deepEqual(
      metadata.variables.map((v) => v.name),
      ["sst"],
    );
  });

  it("walks the nodes of a store with no consolidated metadata", async () => {
    const metadata = await readZarrStoreMetadata(
      readerFor({
        ".zgroup": { zarr_format: 2 },
        "0/climate/.zarray": { shape: [2, 12, 64, 64] },
        "0/climate/.zattrs": { _ARRAY_DIMENSIONS: ["band", "month", "y", "x"] },
        "0/month/.zarray": { shape: [12] },
      }),
      { listEntries: listerFor({ "": ["0"], "0": ["climate", "month"] }) },
    );
    assert.equal(metadata.version, 2);
    assert.deepEqual(metadata.variables, [
      {
        name: "climate",
        path: "0/climate",
        dims: ["band", "month", "y", "x"],
        shape: [2, 12, 64, 64],
      },
    ]);
  });

  it("says the store is not consolidated when it cannot be listed", async () => {
    await assert.rejects(
      readZarrStoreMetadata(readerFor({ ".zgroup": { zarr_format: 2 } })),
      /consolidated metadata/,
    );
  });

  it("rejects a location that is not a Zarr store", async () => {
    await assert.rejects(
      readZarrStoreMetadata(readerFor({}), { listEntries: listerFor({ "": ["photos"] }) }),
      /Not a Zarr store/,
    );
  });

  it("does not blame consolidation when a consolidated store has nothing to draw", async () => {
    // The store *is* consolidated; telling the user to consolidate it would
    // send them after a document that is already there.
    await assert.rejects(
      readZarrStoreMetadata(
        readerFor({ ".zmetadata": { metadata: { "time/.zarray": { shape: [12] } } } }),
      ),
      /No renderable/,
    );
  });

  it("reports a store whose only arrays are coordinates", async () => {
    await assert.rejects(
      readZarrStoreMetadata(
        readerFor({ ".zgroup": { zarr_format: 2 }, "time/.zarray": { shape: [12] } }),
        { listEntries: listerFor({ "": ["time"] }) },
      ),
      /No renderable/,
    );
  });

  it("walks a store whose consolidated listing holds no renderable array", async () => {
    // A `.zmetadata` that only describes coordinates is not a reason to give up
    // when the nodes can still be walked.
    const metadata = await readZarrStoreMetadata(
      readerFor({
        ".zmetadata": { metadata: { "time/.zarray": { shape: [12] } } },
        "air/.zarray": { shape: [12, 5, 5] },
        "air/.zattrs": { _ARRAY_DIMENSIONS: ["time", "lat", "lon"] },
      }),
      { listEntries: listerFor({ "": ["air", "time"] }) },
    );
    assert.deepEqual(
      metadata.variables.map((v) => v.name),
      ["air"],
    );
  });
});
