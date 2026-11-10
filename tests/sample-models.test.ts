import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer, ProcessingModelGraph } from "../packages/core/src";
import {
  MODEL_SCHEMA,
  parseModelFile,
  readTextCapped,
  serializeModelFile,
} from "../apps/geolibre-desktop/src/lib/model-file";
import {
  SAMPLE_MODELS,
  bindSampleModelInputs,
  findSampleDataLayer,
  validateSampleModelManifest,
} from "../apps/geolibre-desktop/src/lib/sample-models";
import manifest from "../apps/geolibre-desktop/src/lib/sample-models.json";

const graph: ProcessingModelGraph = {
  nodes: [
    { id: "in", kind: "input", layerId: "sample-dem", x: 0, y: 0 },
    {
      id: "tool",
      kind: "tool",
      provider: "whitebox",
      toolId: "slope",
      parameters: { units: "degrees", input: "sample-other" },
      x: 0,
      y: 0,
    },
    { id: "out", kind: "output", name: "Slope", x: 0, y: 0 },
  ],
  edges: [
    { id: "e1", from: "in", fromPort: "out", to: "tool", toPort: "input" },
    { id: "e2", from: "tool", fromPort: "output", to: "out", toPort: "in" },
  ],
};

describe("model file", () => {
  it("round-trips through serialize and parse", () => {
    const parsed = parseModelFile(serializeModelFile("Terrain", graph));
    assert.ok(parsed.ok);
    assert.equal(parsed.name, "Terrain");
    assert.equal(parsed.graph.nodes.length, 3);
    assert.equal(parsed.graph.edges.length, 2);
  });

  it("rejects malformed JSON, a foreign schema and a graph-less file", () => {
    assert.deepEqual(parseModelFile("{not json"), { ok: false, error: "invalid" });
    assert.deepEqual(parseModelFile(JSON.stringify({ $schema: "https://example.com/x", graph })), {
      ok: false,
      error: "unsupported",
    });
    assert.deepEqual(parseModelFile(JSON.stringify({ $schema: MODEL_SCHEMA, name: "x" })), {
      ok: false,
      error: "invalid",
    });
    assert.deepEqual(parseModelFile("null"), { ok: false, error: "invalid" });
  });

  it("falls back to an empty name when the file has none", () => {
    const parsed = parseModelFile(JSON.stringify({ graph }));
    assert.ok(parsed.ok);
    assert.equal(parsed.name, "");
  });

  it("rejects a graph over the node cap", () => {
    const nodes = Array.from({ length: 2001 }, (_, i) => ({
      id: `n${i}`,
      kind: "output",
      x: 0,
      y: 0,
    }));
    assert.deepEqual(parseModelFile(JSON.stringify({ graph: { nodes, edges: [] } })), {
      ok: false,
      error: "tooLarge",
    });
  });
});

describe("readTextCapped", () => {
  /** A response streamed in chunks, with no Content-Length header. */
  const chunked = (parts: string[]) => {
    const encoder = new TextEncoder();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled < parts.length) controller.enqueue(encoder.encode(parts[pulled++]));
        else controller.close();
      },
    });
    return { response: new Response(stream), pulled: () => pulled };
  };

  it("returns the body when it fits", async () => {
    assert.equal(await readTextCapped(chunked(["héllo ", "wörld"]).response, 100), "héllo wörld");
  });

  it("counts UTF-8 bytes, not characters", async () => {
    // Five characters, ten bytes.
    assert.equal(await readTextCapped(chunked(["ééééé"]).response, 9), null);
    assert.equal(await readTextCapped(chunked(["ééééé"]).response, 10), "ééééé");
  });

  it("stops reading a chunked body once it passes the cap", async () => {
    const body = chunked(["12345", "67890", "abcde", "fghij"]);
    assert.equal(await readTextCapped(body.response, 8), null);
    assert.ok(body.pulled() < 4, `read ${body.pulled()} of 4 chunks`);
  });

  it("rejects on a declared Content-Length without reading", async () => {
    const response = new Response("tiny", { headers: { "content-length": "999" } });
    assert.equal(await readTextCapped(response, 10), null);
  });
});

describe("sample model manifest", () => {
  it("is valid and non-empty", () => {
    assert.deepEqual(validateSampleModelManifest(manifest), []);
    assert.ok(SAMPLE_MODELS.length > 0);
  });

  it("points every model at assets.geolibre.app/models", () => {
    for (const sample of SAMPLE_MODELS) {
      assert.match(sample.modelUrl, /^https:\/\/assets\.geolibre\.app\/models\/.+\.model\.json$/);
      assert.ok(sample.modelUrl.endsWith(`/${sample.id}.model.json`), sample.id);
    }
  });

  it("reports missing fields, bad URLs, bad kinds and duplicate ids", () => {
    const problems = validateSampleModelManifest({
      samples: [
        { id: "a", title: "A", description: "d", modelUrl: "http://x/a.json", data: [] },
        {
          id: "a",
          title: "",
          description: "d",
          modelUrl: "https://x/a.json",
          data: [{ layerId: "p", name: "n", url: "https://x/d.tif", kind: "tile" }],
        },
        { id: "c", title: "C", description: "d", modelUrl: "https://x/c.json" },
      ],
    });
    assert.deepEqual(problems, [
      "samples[0].modelUrl is not an https URL",
      "samples[1].title is missing or empty",
      'samples[1].id "a" is duplicated',
      'samples[1].data[0].kind must be "raster" or "vector"',
      "samples[2].data is not an array",
    ]);
    assert.deepEqual(validateSampleModelManifest({}), ["manifest has no `samples` array"]);
  });
});

describe("binding sample inputs", () => {
  it("rewrites placeholders on input nodes and parameters", () => {
    const bound = bindSampleModelInputs(
      graph,
      new Map([
        ["sample-dem", "layer-1"],
        ["sample-other", "layer-2"],
      ]),
    );
    assert.equal(bound.nodes[0].layerId, "layer-1");
    assert.deepEqual(bound.nodes[1].parameters, { units: "degrees", input: "layer-2" });
    // The source graph is untouched.
    assert.equal(graph.nodes[0].layerId, "sample-dem");
  });

  it("clears a placeholder that has no binding", () => {
    const bound = bindSampleModelInputs(graph, new Map(), new Set(["sample-dem", "sample-other"]));
    assert.equal("layerId" in bound.nodes[0], false);
    assert.equal(bound.nodes[1].parameters?.input, "");
    assert.equal(bound.nodes[1].parameters?.units, "degrees");
  });

  it("leaves non-placeholder layer ids alone", () => {
    const own: ProcessingModelGraph = {
      nodes: [{ id: "in", kind: "input", layerId: "real-layer", x: 0, y: 0 }],
      edges: [],
    };
    assert.equal(
      bindSampleModelInputs(own, new Map(), new Set(["sample-dem"])).nodes[0].layerId,
      "real-layer",
    );
  });
});

describe("finding sample data layers", () => {
  const layers = [
    { id: "a", sourcePath: "https://x/places.geojson", source: { type: "geojson" } },
    { id: "b", source: { type: "cog", url: "https://x/dem.tif" } },
  ] as unknown as GeoLibreLayer[];

  it("matches a GeoJSON layer by source path and a COG by source URL", () => {
    assert.equal(findSampleDataLayer(layers, "https://x/places.geojson"), "a");
    assert.equal(findSampleDataLayer(layers, "https://x/dem.tif"), "b");
    assert.equal(findSampleDataLayer(layers, "https://x/other.tif"), undefined);
  });
});
