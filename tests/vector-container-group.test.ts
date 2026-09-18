import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { VectorControl, VectorLayerInfo } from "maplibre-gl-vector";
import {
  DEFAULT_LAYER_STYLE,
  LAYER_PALETTE,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  applyVectorContainerColors,
  groupVectorContainerImports,
} from "../packages/plugins/src/plugins/vector-container-group";

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

  it("preserves an explicit display name including dots", async () => {
    const { control, groups } = setup();
    await control.addData(new File([], "buildings.gpkg"), {
      id: "load",
      name: "Comparison v1.2",
      sourceLayers: ["original", "reference"],
    });
    assert.equal(groups[0].name, "Comparison v1.2");
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

describe("container default colors", () => {
  afterEach(() => useAppStore.setState({ layers: [] }));
  function layers(): GeoLibreLayer[] {
    return ["original", "circle", "detail"].map((id) => ({
      id,
      name: id,
      type: "vector-tiles",
      source: { type: "vector" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE, fillColor: "#3388ff", strokeColor: "#3388ff" },
      metadata: {},
    }));
  }
  it("assigns distinct palette colors to the store so the map and swatches agree", () => {
    useAppStore.setState({ layers: layers() });
    applyVectorContainerColors(["original", "circle", "detail"]);
    assert.deepEqual(
      useAppStore.getState().layers.map((l) => l.style.fillColor),
      LAYER_PALETTE.slice(0, 3),
    );
    assert.equal(new Set(useAppStore.getState().layers.map((l) => l.style.strokeColor)).size, 3);
  });
  it("preserves explicitly supplied colors and color expressions", () => {
    for (const style of [{ fillColor: "#ffffff" }, { fillColorExpression: ["get", "color"] }]) {
      const original = layers();
      useAppStore.setState({ layers: original });
      applyVectorContainerColors(
        original.map((l) => l.id),
        style,
      );
      assert.deepEqual(useAppStore.getState().layers, original);
    }
  });
});
