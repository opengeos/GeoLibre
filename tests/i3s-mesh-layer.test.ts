import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createI3sMeshLayerClass } from "../packages/plugins/src/plugins/i3s-mesh-layer";

/** A stand-in for SimpleMeshLayer with just what the subclass calls. */
class FakeSimpleMeshLayer {
  props: Record<string, unknown>;
  state: Record<string, unknown> = {};
  context = { device: "device", viewport: { cameraPosition: [0, 0, 0] } };
  constructor(props: Record<string, unknown>) {
    this.props = props;
  }
  getShaders() {
    return { vs: "base-vs", fs: "base-fs", modules: [{ name: "project32" }], defines: { A: 1 } };
  }
  getAttributeManager() {
    return { getBufferLayouts: () => ["layout"], add: () => {} };
  }
  setState(patch: Record<string, unknown>) {
    Object.assign(this.state, patch);
  }
}

class FakeModel {
  constructor(
    public device: unknown,
    public props: Record<string, unknown>,
  ) {}
}

describe("I3S mesh layer", () => {
  const Layer = createI3sMeshLayerClass(FakeSimpleMeshLayer, {
    Model: FakeModel,
    parsePBRMaterial: () => ({ bindings: {}, generatedTextures: [] }),
  }) as new (props: Record<string, unknown>) => FakeSimpleMeshLayer & {
    getModel(mesh: unknown): FakeModel;
  };

  it("shades without luma.gl's PBR module, which draws nothing on deck.gl 9.4", () => {
    const shaders = new Layer({ id: "m" }).getShaders() as {
      modules: { name: string }[];
      vs: string;
    };
    const names = shaders.modules.map((module) => module.name);
    assert.ok(!names.includes("pbrMaterial"));
    assert.ok(names.includes("mesh"));
    assert.match(shaders.vs, /applyUVRegion/);
  });

  it("turns on I3S UV regions only for meshes that have them", () => {
    const layer = new Layer({ id: "m" });
    const mesh = (uvRegions?: unknown) => ({
      attributes: {
        positions: { value: new Float32Array(9), size: 3 },
        ...(uvRegions ? { uvRegions } : {}),
      },
    });
    const withRegions = layer.getModel(mesh({ value: new Uint16Array(12), size: 4 }));
    const without = layer.getModel(mesh());
    assert.equal((withRegions.props.defines as Record<string, number>).HAS_UV_REGIONS, 1);
    assert.equal((without.props.defines as Record<string, number>).HAS_UV_REGIONS, 0);
    assert.equal(withRegions.props.isInstanced, true);
  });

  it("gives a mesh without vertex colours white ones", () => {
    const layer = new Layer({ id: "m" });
    const attributes: Record<string, unknown> = {
      positions: { value: new Float32Array(6), size: 3 },
    };
    layer.getModel({ attributes });
    const colors = attributes.colors as { value: Uint8Array; size: number };
    assert.equal(colors.size, 4);
    assert.deepEqual([...colors.value], [255, 255, 255, 255, 255, 255, 255, 255]);
  });
});
