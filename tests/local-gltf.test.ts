import assert from "node:assert/strict";
import { createEmptyProject, parseProject, serializeProject } from "../packages/core/src/project";
import { createDeckVizStoreLayer, readDeckVizConfig } from "../packages/plugins/src/plugins/deckgl-viz/store-layer";
import { DEFAULT_DECK_VIZ_STYLE } from "../packages/plugins/src/plugins/deckgl-viz/registry";
import { test } from "node:test";
import { localGltfMime } from "../apps/geolibre-desktop/src/lib/local-gltf";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;
const glb = (value: unknown) => {
  const json = new TextEncoder().encode(JSON.stringify(value));
  const length = Math.ceil(json.length / 4) * 4;
  const data = new ArrayBuffer(20 + length);
  const view = new DataView(data);
  [0x46546c67, 2, data.byteLength, length, 0x4e4f534a].forEach((n, i) => view.setUint32(i * 4, n, true));
  new Uint8Array(data, 20).fill(32);
  new Uint8Array(data, 20).set(json);
  return data;
};

test("accepts embedded JSON glTF and binary GLB", () => {
  const model = { asset: { version: "2.0" }, buffers: [{ uri: "data:application/octet-stream;base64,AAAA" }] };
  assert.equal(localGltfMime(encode(model)), "model/gltf+json");
  assert.equal(localGltfMime(glb(model)), "model/gltf-binary");
});
test("rejects sidecar resources in both glTF and GLB", () => {
  for (const uri of ["texture.png", "../mesh.bin", "https://example.com/a.png"]) {
    for (const field of ["buffers", "images"]) {
      const model = { asset: { version: "2.0" }, [field]: [{ uri }] };
      for (const data of [encode(model), glb(model)]) {
        assert.throws(() => localGltfMime(data), /externalResources/);
      }
    }
  }
});
test("rejects wrong formats, versions and truncated containers", () => {
  for (const data of [new ArrayBuffer(0), encode(null), encode({}), encode({ asset: { version: "1.0" } }), glb({ asset: { version: "2.0" } }).slice(0, -1)]) {
    assert.throws(() => localGltfMime(data));
  }
});
test("embedded model bytes survive a project save and reopen", () => {
  const bytes = glb({ asset: { version: "2.0" }, scenes: [{ nodes: [] }] });
  const modelUrl = `data:${localGltfMime(bytes)};base64,${Buffer.from(bytes).toString("base64")}`;
  const project = createEmptyProject("Local model");
  project.layers.push(createDeckVizStoreLayer({
    name: "local.glb", sourcePath: "local.glb", rows: [{ lng: 121.495, lat: 31.235 }],
    config: { layerKind: "scenegraph", format: "json-array", fieldMapping: { lng: "lng", lat: "lat" },
      style: { ...DEFAULT_DECK_VIZ_STYLE }, scenegraph: { modelUrl, sizeScale: 1, bearing: 0, altitude: 0 } },
  }));
  const restored = parseProject(serializeProject(project));
  assert.equal(readDeckVizConfig(restored.layers[0])?.scenegraph?.modelUrl, modelUrl);
});
