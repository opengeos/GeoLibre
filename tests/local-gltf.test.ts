import assert from "node:assert/strict";
import { createEmptyProject, parseProject, serializeProject } from "../packages/core/src/project";
import {
  createDeckVizStoreLayer,
  readDeckVizConfig,
} from "../packages/plugins/src/plugins/deckgl-viz/store-layer";
import { DEFAULT_DECK_VIZ_STYLE } from "../packages/plugins/src/plugins/deckgl-viz/registry";
import { test } from "node:test";
import {
  MAX_LOCAL_GLTF_BYTES,
  embedLocalGltf,
  localGltfMime,
} from "../apps/geolibre-desktop/src/lib/local-gltf";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;
const encodeText = (json: string) => new TextEncoder().encode(json).buffer;
const glb = (value: unknown) => {
  const json = new TextEncoder().encode(JSON.stringify(value));
  const length = Math.ceil(json.length / 4) * 4;
  const data = new ArrayBuffer(20 + length);
  const view = new DataView(data);
  [0x46546c67, 2, data.byteLength, length, 0x4e4f534a].forEach((n, i) =>
    view.setUint32(i * 4, n, true),
  );
  new Uint8Array(data, 20).fill(32);
  new Uint8Array(data, 20).set(json);
  return data;
};

test("accepts embedded JSON glTF and binary GLB", () => {
  const model = {
    asset: { version: "2.0" },
    buffers: [{ uri: "data:application/octet-stream;base64,AAAA" }],
  };
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
test("rejects an external uri nested in a texture extension", () => {
  const model = {
    asset: { version: "2.0" },
    images: [
      { extensions: { KHR_texture_basisu: { uri: "https://example.com/city.ktx2" } } },
      // Free-form application data is not a resource reference.
      { extras: { uri: "C:/exports/original.png" }, uri: "data:image/png;base64,AAAA" },
    ],
  };
  assert.throws(() => localGltfMime(encode(model)), /externalResources/);
  assert.equal(
    localGltfMime(encode({ asset: { version: "2.0" }, images: [model.images[1]] })),
    "model/gltf+json",
  );
});
// Built as text rather than through JSON.stringify, which recurses and blows
// the stack on the deeper fixtures. Stack budgets differ by host, so the test
// picks the deepest asset this runtime can parse: the walk is what is under
// test, not the parser.
const deepAsset = (depth: number, innermost: string) =>
  `{"asset":{"version":"2.0"},"scenes":${"[".repeat(depth)}${innermost}${"]".repeat(depth)}}`;
const deepestParsable = [4000, 2000, 1000, 500].find((depth) => {
  try {
    JSON.parse(deepAsset(depth, ""));
    return true;
  } catch {
    return false;
  }
})!;
test("validates deeply nested assets without overflowing the stack", () => {
  const buried = deepAsset(deepestParsable, '{"uri":"https://example.com/buried.bin"}');
  assert.throws(() => localGltfMime(encodeText(buried)), /externalResources/);
  assert.equal(localGltfMime(encodeText(deepAsset(deepestParsable, ""))), "model/gltf+json");
});
test("rejects a model past the inline embedding cap", async () => {
  await assert.rejects(embedLocalGltf(new ArrayBuffer(MAX_LOCAL_GLTF_BYTES + 1)), /modelTooLarge/);
});
test("rejects wrong formats, versions and truncated containers", () => {
  for (const data of [
    new ArrayBuffer(0),
    encode(null),
    encode({}),
    encode({ asset: { version: "1.0" } }),
    glb({ asset: { version: "2.0" } }).slice(0, -1),
  ]) {
    assert.throws(() => localGltfMime(data));
  }
});
test("embedded model bytes survive a project save and reopen", () => {
  const bytes = glb({ asset: { version: "2.0" }, scenes: [{ nodes: [] }] });
  const modelUrl = `data:${localGltfMime(bytes)};base64,${Buffer.from(bytes).toString("base64")}`;
  const project = createEmptyProject("Local model");
  project.layers.push(
    createDeckVizStoreLayer({
      name: "local.glb",
      sourcePath: "local.glb",
      rows: [{ lng: 121.495, lat: 31.235 }],
      config: {
        layerKind: "scenegraph",
        format: "json-array",
        fieldMapping: { lng: "lng", lat: "lat" },
        style: { ...DEFAULT_DECK_VIZ_STYLE },
        scenegraph: { modelUrl, sizeScale: 1, bearing: 0, altitude: 0 },
      },
    }),
  );
  const restored = parseProject(serializeProject(project));
  assert.equal(readDeckVizConfig(restored.layers[0])?.scenegraph?.modelUrl, modelUrl);
});
