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
  finalizeState() {}
}

class FakeModel {
  shaderProps: Record<string, unknown>[] = [];
  shaderInputs = { setProps: (props: Record<string, unknown>) => this.shaderProps.push(props) };
  constructor(
    public device: unknown,
    public props: Record<string, unknown>,
  ) {}
}

/** A parsed material whose generated textures record being destroyed. */
function parsedMaterial(sampler: unknown) {
  const texture = { destroyed: false, destroy: () => (texture.destroyed = true) };
  return {
    bindings: sampler ? { pbr_baseColorSampler: sampler } : {},
    generatedTextures: [texture],
  };
}

describe("I3S mesh layer", () => {
  const materials: ReturnType<typeof parsedMaterial>[] = [];
  const Layer = createI3sMeshLayerClass(FakeSimpleMeshLayer, {
    Model: FakeModel,
    parsePBRMaterial: (_device: unknown, material: unknown) => {
      const parsed = parsedMaterial((material as { sampler?: unknown }).sampler);
      materials.push(parsed);
      return parsed;
    },
  }) as new (props: Record<string, unknown>) => FakeSimpleMeshLayer & {
    getModel(mesh: unknown): FakeModel;
    updateTexture(material: unknown): void;
    finalizeState(context: unknown): void;
  };

  // The base class here is a stand-in, so this checks what the subclass adds;
  // that the real scene draws again is checked in the browser (see the PR).
  it("replaces the base shaders and adds no PBR module of its own", () => {
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
    // Absent, not 0: luma.gl defines a 0, and `#ifdef` would take it.
    assert.ok(!("HAS_UV_REGIONS" in (without.props.defines as Record<string, number>)));
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

  it("binds the base-colour texture and frees the textures it replaces", () => {
    const layer = new Layer({ id: "m", mesh: { attributes: {} } });
    const model = new FakeModel("device", {});
    layer.state.model = model;
    layer.updateTexture({ sampler: "texture-a" });
    assert.deepEqual(model.shaderProps.at(-1), {
      simpleMesh: { sampler: "texture-a", hasTexture: true },
    });
    const first = materials.at(-1)!;
    layer.updateTexture({});
    assert.equal(first.generatedTextures[0].destroyed, true);
    assert.equal(
      (model.shaderProps.at(-1)!.simpleMesh as { hasTexture: boolean }).hasTexture,
      false,
    );
    const second = materials.at(-1)!;
    layer.finalizeState({});
    assert.equal(second.generatedTextures[0].destroyed, true);
  });
});
