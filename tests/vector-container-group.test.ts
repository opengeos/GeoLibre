import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { VectorControl, VectorLayerInfo, VectorLayerStyle } from "maplibre-gl-vector";
import type { FeatureCollection } from "geojson";
import {
  DEFAULT_LAYER_STYLE,
  LAYER_PALETTE,
  isInitialLayerStyle,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  applyInitialVectorStyles,
  groupVectorContainerImports,
} from "../packages/plugins/src/plugins/vector-container-group";

function setup() {
  const layers: VectorLayerInfo[] = [];
  const groups: { name: string; ids: string[] }[] = [];
  const imported: string[][] = [];
  const control: Pick<VectorControl, "addData" | "getLayers"> = {
    getLayers: () => layers,
    addData: async (_source, options = {}) => {
      if (options.sourceLayers?.length === 0) throw new Error("cancelled");
      await new Promise((resolve) => setTimeout(resolve, options.name === "slow" ? 10 : 0));
      if (options.sourceLayers === undefined) {
        // A plain single-layer file keeps the id it was added under.
        layers.push({ id: options.id, name: "single" } as VectorLayerInfo);
      }
      for (const name of options.sourceLayers ?? []) {
        // Only identity is needed by the grouping adapter.
        layers.push({ id: `${options.id}-${name}`, name } as VectorLayerInfo);
      }
      return layers[layers.length - 1];
    },
  };
  groupVectorContainerImports(
    control,
    (name, ids) => groups.push({ name, ids }),
    (ids) => imported.push(ids),
  );
  return { control, groups, imported };
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

  it("reports every new layer, single files included, but not replayed ones", async () => {
    const { control, imported } = setup();
    await control.addData(new File([], "counties.geojson"), { id: "single" });
    await control.addData(new File([], "buildings.gpkg"), {
      id: "load",
      sourceLayers: ["original", "reference"],
    });
    // A restore replays a layer the store already holds.
    useAppStore.setState({ layers: [{ id: "restored" } as GeoLibreLayer] });
    try {
      await control.addData(new File([], "saved.geojson"), { id: "restored" });
    } finally {
      useAppStore.setState({ layers: [] });
    }
    assert.deepEqual(imported, [["single"], ["load-original", "load-reference"], []]);
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

describe("initial styles for vector control layers", () => {
  afterEach(() => useAppStore.setState({ layers: [] }));
  // What createVectorStoreLayer seeds from the control's own default style.
  const CONTROL_SEED = {
    ...DEFAULT_LAYER_STYLE,
    fillColor: "#3388ff",
    strokeColor: "#3388ff",
    fillOpacity: 0.4,
    strokeWidth: 2,
    circleRadius: 5,
  };
  function layers(geometryType?: string): GeoLibreLayer[] {
    return ["original", "circle", "detail"].map((id) => ({
      id,
      name: id,
      type: "vector-tiles",
      source: { type: "vector" },
      visible: true,
      opacity: 1,
      style: { ...CONTROL_SEED },
      metadata: geometryType ? { geometryType } : {},
    }));
  }
  function points(count: number): FeatureCollection {
    return {
      type: "FeatureCollection",
      features: Array.from({ length: count }, (_, index) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [index, index] },
        properties: { magType: index % 2 ? "ml" : "md", depth: index },
      })),
    };
  }
  it("assigns distinct palette colors to the store so the map and swatches agree", () => {
    useAppStore.setState({ layers: layers() });
    applyInitialVectorStyles(["original", "circle", "detail"]);
    assert.deepEqual(
      useAppStore.getState().layers.map((l) => l.style.fillColor),
      LAYER_PALETTE.slice(0, 3),
    );
    assert.equal(new Set(useAppStore.getState().layers.map((l) => l.style.strokeColor)).size, 3);
  });
  it("gives a single added layer the as-added style that unlocks style suggestions", () => {
    // Regression: an Add Vector Layer layer kept the control's #3388ff, which is
    // not a palette color, so isInitialLayerStyle failed and the Style panel
    // never showed its suggestions strip, even after the layer was adopted.
    const [layer] = layers("point");
    useAppStore.setState({ layers: [layer] });
    applyInitialVectorStyles([layer.id]);
    const styled = useAppStore.getState().layers[0];
    assert.equal(styled.style.fillColor, LAYER_PALETTE[0]);
    assert.equal(styled.style.fillOpacity, 0.9, "point sizing, not the control's 0.4");
    // As adopted: the features arrive in geojson and the style must still read
    // as untouched.
    assert.equal(isInitialLayerStyle(styled.style, points(20)), true);
    assert.equal(isInitialLayerStyle(layer.style, points(20)), false);
  });
  it("sizes polygon and unknown-geometry layers for their family", () => {
    const [polygon] = layers("polygon");
    const [unknown] = layers("unknown").map((l) => ({ ...l, id: "unknown" }));
    useAppStore.setState({ layers: [polygon, unknown] });
    applyInitialVectorStyles([polygon.id, unknown.id]);
    const [styledPolygon, styledUnknown] = useAppStore.getState().layers;
    assert.equal(styledPolygon.style.fillOpacity, 0.45);
    assert.equal(styledPolygon.style.strokeWidth, 1.5);
    assert.equal(styledUnknown.style.fillOpacity, DEFAULT_LAYER_STYLE.fillOpacity);
    assert.equal(styledUnknown.style.fillColor, LAYER_PALETTE[1]);
  });
  it("keeps the restyle out of the undo history", () => {
    useAppStore.setState({ layers: layers() });
    useAppStore.temporal.getState().clear();
    applyInitialVectorStyles(["original"]);
    assert.equal(useAppStore.temporal.getState().pastStates.length, 0);
  });
  it("preserves explicitly supplied colors and color expressions", () => {
    const styles: Partial<VectorLayerStyle>[] = [
      { fillColor: "#ffffff" },
      { fillColorExpression: ["get", "color"] },
    ];
    for (const style of styles) {
      const original = layers();
      useAppStore.setState({ layers: original });
      applyInitialVectorStyles(
        original.map((l) => l.id),
        style,
      );
      assert.deepEqual(useAppStore.getState().layers, original);
    }
  });
});
