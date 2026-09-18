import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VectorControl, VectorLayerInfo } from "maplibre-gl-vector";
import { groupVectorContainerImports } from "../packages/plugins/src/plugins/vector-container-group";

function setup() {
  const layers: VectorLayerInfo[] = [];
  const groups: { name: string; ids: string[] }[] = [];
  const control: Pick<VectorControl, "addData" | "getLayers"> = {
    getLayers: () => layers,
    addData: async (_source, options = {}) => {
      if (options.sourceLayers?.length === 0) throw new Error("cancelled");
      await new Promise((resolve) => setTimeout(resolve, options.name === "slow" ? 10 : 0));
      for (const name of options.sourceLayers ?? ["only"]) {
        // Only identity is needed by the grouping adapter.
        layers.push({ id: `${options.id}-${name}`, name } as VectorLayerInfo);
      }
      return layers[layers.length - 1];
    },
  };
  groupVectorContainerImports(control, (name, ids) => groups.push({ name, ids }));
  return { control, groups };
}

describe("vector container groups", () => {
  it("groups only the selected tables under the file's name", async () => {
    const { control, groups } = setup();
    await control.addData(new File([], "buildings.gpkg"), {
      id: "load",
      sourceLayers: ["original", "reference"],
    });
    assert.deepEqual(groups, [{ name: "buildings", ids: ["load-original", "load-reference"] }]);
  });

  it("does not create a group for a single selected table or a cancelled import", async () => {
    const { control, groups } = setup();
    await control.addData(new File([], "buildings.gpkg"), { sourceLayers: ["reference"] });
    await assert.rejects(
      control.addData(new File([], "buildings.gpkg"), { sourceLayers: [] }),
      /cancelled/,
    );
    assert.deepEqual(groups, []);
  });

  it("keeps concurrent imports in separate groups", async () => {
    const { control, groups } = setup();
    await Promise.all([
      control.addData(new File([], "same.gpkg"), {
        id: "a",
        name: "slow",
        sourceLayers: ["one", "two"],
      }),
      control.addData(new File([], "same.gpkg"), {
        id: "b",
        name: "fast",
        sourceLayers: ["one", "two"],
      }),
    ]);
    assert.deepEqual(groups, [
      { name: "fast", ids: ["b-one", "b-two"] },
      { name: "slow", ids: ["a-one", "a-two"] },
    ]);
  });
});
