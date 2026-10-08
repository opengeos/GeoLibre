import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addLayersToProject,
  createEmptyProject,
  DEFAULT_LAYER_STYLE,
  extractLayersFileContent,
  isReferencedLayer,
  LAYERS_FILE_TYPE,
  MAX_LAYERS_FILE_BYTES,
  normalizeLayersFileContent,
  parseLayersFile,
  serializeLayersFile,
  type GeoLibreLayer,
  type LayerGroup,
} from "@geolibre/core";

function layer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "xyz",
    name: "Imagery",
    type: "xyz",
    source: { type: "raster", tiles: ["https://tiles.example.com/{z}/{x}/{y}.png"] },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...patch,
  };
}

const inlineGeojson = layer({
  id: "drawn",
  name: "Sketch",
  type: "geojson",
  source: { type: "geojson" },
  geojson: { type: "FeatureCollection", features: [] },
});

const localFile = layer({
  id: "roads",
  name: "Roads",
  type: "geojson",
  source: { type: "geojson" },
  sourcePath: "/data/roads.geojson",
  metadata: { localFileReloadable: true },
});

function group(id: string, parentId?: string): LayerGroup {
  return { id, name: id, collapsed: false, visible: true, opacity: 1, parentId };
}

describe("isReferencedLayer", () => {
  it("accepts tile, URL and local-file references", () => {
    assert.equal(isReferencedLayer(layer()), true);
    assert.equal(isReferencedLayer(localFile), true);
    assert.equal(
      isReferencedLayer(
        layer({
          type: "geojson",
          source: { type: "geojson" },
          sourcePath: "https://example.com/a.geojson",
        }),
      ),
      true,
    );
  });

  it("rejects layers that carry their data", () => {
    assert.equal(isReferencedLayer(inlineGeojson), false);
    assert.equal(
      isReferencedLayer(
        layer({ source: { type: "geojson", data: { type: "FeatureCollection" } } }),
      ),
      false,
    );
    assert.equal(isReferencedLayer(layer({ metadata: { embeddedGeoJSON: {} } })), false);
    assert.equal(isReferencedLayer(layer({ source: { type: "image", url: "blob:abc" } })), false);
    assert.equal(isReferencedLayer(layer({ metadata: { sessionOnly: true } })), false);
  });

  it("rejects a local path the desktop app cannot re-read", () => {
    // A browser-picked file records only its bare name.
    assert.equal(isReferencedLayer({ ...localFile, sourcePath: "roads.geojson" }), false);
    assert.equal(isReferencedLayer({ ...localFile, sourcePath: "/data/../etc/x.geojson" }), false);
  });
});

describe("extractLayersFileContent", () => {
  it("keeps referenced layers, reports inline ones, and prunes folders", () => {
    const { content, skipped } = extractLayersFileContent({
      layers: [{ ...layer(), groupId: "child" }, inlineGeojson, localFile],
      layerGroups: [group("root"), group("child", "root"), group("unused")],
    });
    assert.deepEqual(
      content.layers.map((entry) => entry.id),
      ["xyz", "roads"],
    );
    assert.deepEqual(skipped, ["Sketch"]);
    assert.deepEqual(
      content.layerGroups.map((entry) => entry.id),
      ["root", "child"],
    );
  });
});

describe("parseLayersFile", () => {
  it("round-trips an exported file", () => {
    const json = serializeLayersFile({ layers: [layer(), localFile], layerGroups: [] });
    assert.equal(JSON.parse(json).type, LAYERS_FILE_TYPE);
    const parsed = parseLayersFile(json);
    assert.deepEqual(
      parsed.layers.map((entry) => entry.name),
      ["Imagery", "Roads"],
    );
    assert.equal(parsed.layers[1].sourcePath, "/data/roads.geojson");
  });

  it("drops malformed, duplicate and inline layers", () => {
    const parsed = normalizeLayersFileContent({
      layers: [
        layer(),
        layer(),
        { id: "x", name: "Bad", type: "nope", source: {} },
        inlineGeojson,
        7,
      ],
    });
    assert.deepEqual(
      parsed.layers.map((entry) => entry.id),
      ["xyz"],
    );
  });

  it("keeps nothing from a corrupt or oversized copy instead of throwing", () => {
    const huge = layer({ metadata: { blob: "x".repeat(MAX_LAYERS_FILE_BYTES) } });
    assert.deepEqual(normalizeLayersFileContent({ layers: [huge] }).layers, []);
    assert.deepEqual(
      normalizeLayersFileContent({ layers: [layer()], layerGroups: "bad" }).layers.length,
      1,
    );
  });

  it("refuses other files, newer versions, empty and oversized files", () => {
    assert.throws(() => parseLayersFile("{"), /invalid JSON/);
    assert.throws(() => parseLayersFile(JSON.stringify({ type: "x", version: 1 })), /Not a valid/);
    assert.throws(
      () => parseLayersFile(JSON.stringify({ type: LAYERS_FILE_TYPE, version: 2, layers: [] })),
      /Unsupported/,
    );
    assert.throws(
      () => parseLayersFile(serializeLayersFile({ layers: [inlineGeojson], layerGroups: [] })),
      /no usable layers/,
    );
    assert.throws(() => parseLayersFile(" ".repeat(MAX_LAYERS_FILE_BYTES + 1)), /too large/);
  });
});

describe("addLayersToProject", () => {
  it("adds the layers on top without replacing the project's own", () => {
    const project = { ...createEmptyProject(), layers: [layer({ name: "Own" })] };
    const result = addLayersToProject(project, {
      layers: [layer({ name: "Duplicate id" }), localFile],
      layerGroups: [group("g")],
    });
    assert.deepEqual(
      result.layers.map((entry) => entry.name),
      ["Own", "Roads"],
    );
    assert.deepEqual(
      result.layerGroups?.map((entry) => entry.id),
      ["g"],
    );
  });
});
