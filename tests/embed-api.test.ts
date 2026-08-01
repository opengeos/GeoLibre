import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";
import type { AddLayerSpec } from "@geolibre/embed";
import {
  EMBED_API_SOURCE,
  EMBED_API_VERSION,
  EMBED_ORIGINS_ENV,
  buildEmbedEvent,
  buildEmbedLayer,
  embedLayerSummaries,
  isEmbedOriginAllowed,
  parseEmbedOrigins,
  parseEmbedRequest,
  readEmbedOrigins,
  requireEmbedLayer,
  resolveHighlightIds,
  type EmbedHighlightTarget,
} from "../apps/geolibre-desktop/src/lib/embed-api";

/** A tile template that satisfies the addLayer renderable-source check. */
const XYZ_TILE_URL = "https://tiles.example.com/{z}/{x}/{y}.png";

/** Build an inbound host message with the right envelope by default. */
function message(type: string, payload?: unknown, extra: Record<string, unknown> = {}) {
  return { v: EMBED_API_VERSION, type, payload, ...extra };
}

/** A minimal store layer, enough for the layer-facing command helpers. */
function layer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "roads",
    name: "Roads",
    type: "xyz",
    source: { tiles: [XYZ_TILE_URL] },
    visible: true,
    opacity: 1,
    style: {} as GeoLibreLayer["style"],
    metadata: {},
    ...patch,
  } as GeoLibreLayer;
}

/** A valid `addLayer` spec, as `parseEmbedRequest` would have accepted it. */
function addLayerSpec(patch: Partial<AddLayerSpec> = {}): AddLayerSpec {
  return {
    id: "runtime",
    name: "Runtime",
    type: "xyz",
    source: { tiles: [XYZ_TILE_URL] },
    ...patch,
  };
}

function highlightTarget(patch: Partial<EmbedHighlightTarget> = {}): EmbedHighlightTarget {
  return { layerId: "layer-1", featureIds: [], filter: null, fit: false, ...patch };
}

describe("parseEmbedOrigins", () => {
  it("accepts a comma-separated list and normalizes each entry to an origin", () => {
    assert.deepEqual(
      parseEmbedOrigins("https://erp.example.com, https://portal.example.com/app/"),
      ["https://erp.example.com", "https://portal.example.com"],
    );
  });

  it("keeps an explicit port and deduplicates", () => {
    assert.deepEqual(parseEmbedOrigins("http://localhost:3000 http://localhost:3000/x"), [
      "http://localhost:3000",
    ]);
  });

  it("drops entries that are not parseable origins", () => {
    assert.deepEqual(parseEmbedOrigins("not-a-url, https://ok.example.com, mailto:a@b.com"), [
      "https://ok.example.com",
    ]);
  });

  it("preserves the any-origin wildcard", () => {
    assert.deepEqual(parseEmbedOrigins("*"), ["*"]);
  });

  it("returns an empty list for an unset value", () => {
    assert.deepEqual(parseEmbedOrigins(undefined), []);
    assert.deepEqual(parseEmbedOrigins(""), []);
  });
});

describe("readEmbedOrigins", () => {
  it("prefers the Docker runtime config over the build-time env", () => {
    const origins = readEmbedOrigins(
      { [EMBED_ORIGINS_ENV]: "https://built.example.com" },
      { [EMBED_ORIGINS_ENV]: "https://runtime.example.com" },
    );
    assert.deepEqual(origins, ["https://runtime.example.com"]);
  });

  it("falls back to the build-time env when the runtime config is empty", () => {
    const origins = readEmbedOrigins({ [EMBED_ORIGINS_ENV]: "https://built.example.com" }, {});
    assert.deepEqual(origins, ["https://built.example.com"]);
  });

  it("is empty when neither is configured, which keeps the API off", () => {
    assert.deepEqual(readEmbedOrigins({}, {}), []);
  });
});

describe("isEmbedOriginAllowed", () => {
  const allowed = ["https://erp.example.com"];

  it("allows a listed origin", () => {
    assert.equal(isEmbedOriginAllowed("https://erp.example.com", allowed), true);
  });

  it("rejects any other origin, including a subdomain of a listed one", () => {
    assert.equal(isEmbedOriginAllowed("https://evil.example.com", allowed), false);
    assert.equal(isEmbedOriginAllowed("https://sub.erp.example.com", allowed), false);
    assert.equal(isEmbedOriginAllowed("http://erp.example.com", allowed), false);
  });

  it("rejects everything when nothing is configured", () => {
    assert.equal(isEmbedOriginAllowed("https://erp.example.com", []), false);
  });

  it("allows any origin under the wildcard", () => {
    assert.equal(isEmbedOriginAllowed("https://anything.example.com", ["*"]), true);
    assert.equal(isEmbedOriginAllowed("null", ["*"]), true);
  });

  it("rejects a missing origin unless the wildcard is configured", () => {
    assert.equal(isEmbedOriginAllowed(null, allowed), false);
    assert.equal(isEmbedOriginAllowed(undefined, allowed), false);
  });
});

describe("parseEmbedRequest envelope", () => {
  it("ignores a message without the protocol version", () => {
    assert.equal(parseEmbedRequest({ type: "setView", payload: { zoom: 4 } }), null);
    assert.equal(parseEmbedRequest({ v: 3, type: "setView", payload: { zoom: 4 } }), null);
  });

  it("ignores unrelated postMessage traffic sharing the window", () => {
    assert.equal(parseEmbedRequest(null), null);
    assert.equal(parseEmbedRequest("webpack-hmr"), null);
    assert.equal(parseEmbedRequest(message("somethingElse")), null);
  });

  it("never treats one of our own events as a command", () => {
    const echoed = { ...buildEmbedEvent("ready", {}), type: "setView", payload: { zoom: 4 } };
    assert.equal(parseEmbedRequest(echoed), null);
  });

  it("echoes a host-supplied requestId", () => {
    const parsed = parseEmbedRequest(message("setView", { zoom: 4 }, { requestId: "abc" }));
    assert.deepEqual(parsed, {
      command: { type: "setView", target: { kind: "camera", zoom: 4 } },
      requestId: "abc",
    });
  });
});

describe("parseEmbedRequest: v2 commands", () => {
  it("keeps accepting a v1 request after the protocol bump", () => {
    assert.deepEqual(parseEmbedRequest({ v: 1, type: "getViewport", requestId: "legacy" }), {
      command: { type: "getViewport" },
      requestId: "legacy",
    });
  });

  it("validates visibility, filter, query, add, and export commands", () => {
    assert.deepEqual(
      parseEmbedRequest(message("setLayerVisibility", { layerId: "roads", visible: false })),
      {
        command: { type: "setLayerVisibility", layerId: "roads", visible: false },
        requestId: null,
      },
    );
    assert.deepEqual(parseEmbedRequest(message("listLayers")), {
      command: { type: "listLayers" },
      requestId: null,
    });
    assert.deepEqual(
      parseEmbedRequest(
        message("setFilter", { layerId: "roads", expression: ["==", ["get", "x"], 1] }),
      ),
      {
        command: {
          type: "setFilter",
          layerId: "roads",
          expression: ["==", ["get", "x"], 1],
        },
        requestId: null,
      },
    );
    assert.deepEqual(parseEmbedRequest(message("getViewport")), {
      command: { type: "getViewport" },
      requestId: null,
    });
    assert.deepEqual(
      parseEmbedRequest(
        message("addLayer", {
          spec: { id: "runtime", name: "Runtime", type: "xyz", source: { tiles: [XYZ_TILE_URL] } },
        }),
      ),
      {
        command: {
          type: "addLayer",
          spec: { id: "runtime", name: "Runtime", type: "xyz", source: { tiles: [XYZ_TILE_URL] } },
        },
        requestId: null,
      },
    );
    assert.deepEqual(parseEmbedRequest(message("exportImage")), {
      command: { type: "exportImage" },
      requestId: null,
    });
  });
});

describe("parseEmbedRequest: setFilter", () => {
  it("accepts a compiling filter expression and a null clear", () => {
    for (const expression of [
      ["==", ["get", "kind"], "road"],
      ["all", [">", ["get", "pop"], 1000], ["!", ["has", "hidden"]]],
      null,
    ]) {
      const parsed = parseEmbedRequest(message("setFilter", { layerId: "roads", expression }));
      assert.deepEqual(parsed, {
        command: { type: "setFilter", layerId: "roads", expression },
        requestId: null,
      });
    }
  });

  it("rejects an expression the style spec cannot compile", () => {
    // Acked `ok` before: the store write always succeeds, and the failure only
    // showed up later inside layer-sync, where the host could never see it.
    const unknownOperator = parseEmbedRequest(
      message("setFilter", { layerId: "roads", expression: ["nonsense", 1] }),
    );
    assert.ok(unknownOperator && "error" in unknownOperator);
    assert.match(unknownOperator.error, /^setFilter: .*Unknown expression "nonsense"/);

    const mistyped = parseEmbedRequest(
      message("setFilter", { layerId: "roads", expression: ["==", "x", 1] }),
    );
    assert.ok(mistyped && "error" in mistyped);
    assert.match(mistyped.error, /Cannot compare types/);
  });

  it("rejects an empty expression rather than storing a filter that does nothing", () => {
    const parsed = parseEmbedRequest(message("setFilter", { layerId: "roads", expression: [] }));
    assert.ok(parsed && "error" in parsed);
    assert.equal(parsed.error, "setFilter: not a MapLibre filter expression");
  });

  it("still requires a layerId and an array or null", () => {
    for (const payload of [
      { layerId: "", expression: null },
      { layerId: "roads", expression: "kind = road" },
    ]) {
      assert.deepEqual(parseEmbedRequest(message("setFilter", payload)), {
        error: "setFilter: expected layerId and a MapLibre expression array or null",
        requestId: null,
      });
    }
  });
});

describe("parseEmbedRequest: addLayer", () => {
  it("rejects a spec whose source carries nothing renderable", () => {
    // An `xyz` layer whose source has no usable tile template would be acked as
    // a success and then render nothing, so it is refused up front instead.
    for (const source of [{ tiles: [] }, { minzoom: 0 }]) {
      assert.deepEqual(parseEmbedRequest(message("addLayer", { spec: addLayerSpec({ source }) })), {
        error: 'addLayer: a "xyz" layer needs a source with a url or tiles',
        requestId: null,
      });
    }
  });

  it("does not let inline features stand in for a URL- or tile-backed source", () => {
    // Only `geojson` and `deckgl-viz` render from inline features; every other
    // renderer reads a URL or tiles and ignores the blob, so accepting these
    // would be the same silent no-op in a different shape.
    const empty = { type: "FeatureCollection", features: [] };
    for (const spec of [
      addLayerSpec({ geojson: empty, source: {} }),
      addLayerSpec({ source: { data: empty } }),
      addLayerSpec({ type: "vector-tiles", source: { data: empty } }),
      addLayerSpec({ type: "pmtiles", geojson: empty, source: {} }),
      addLayerSpec({ type: "image", geojson: empty, source: { coordinates: [] } }),
      addLayerSpec({ type: "video", geojson: empty, source: {} }),
      addLayerSpec({ type: "cog", source: { data: empty } }),
    ]) {
      const parsed = parseEmbedRequest(message("addLayer", { spec }));
      assert.ok(parsed && "error" in parsed, `expected ${spec.type} to be rejected`);
      assert.match(parsed.error, /needs a source with a url or tiles$/);
    }
  });

  it("accepts inline features on the spec or on the source for a data-backed type", () => {
    const empty = { type: "FeatureCollection", features: [] };
    for (const spec of [
      addLayerSpec({ type: "geojson", source: {}, geojson: empty }),
      addLayerSpec({ type: "geojson", source: { type: "geojson", data: empty } }),
      addLayerSpec({ type: "deckgl-viz", source: {}, geojson: empty }),
      addLayerSpec({ type: "cog", source: { url: "https://x/y.tif" } }),
      // A string `data` is a URL, which counts for a tile-backed type too.
      addLayerSpec({ source: { data: "https://x/features.json" } }),
      // A custom map protocol is a legitimate layer source, unlike loadProject.
      addLayerSpec({ type: "pmtiles", source: { url: "pmtiles://https://x/y.pmtiles" } }),
    ]) {
      const parsed = parseEmbedRequest(message("addLayer", { spec }));
      assert.ok(parsed && !("error" in parsed), `expected ${spec.type} to parse`);
    }
  });

  it("refuses a script-capable or local URL scheme on any source field", () => {
    for (const [field, spec] of [
      ["source.url", addLayerSpec({ source: { url: "javascript:alert(1)" } })],
      ["source.tiles", addLayerSpec({ source: { tiles: [" JavaScript:alert(1)"] } })],
      ["source.data", addLayerSpec({ type: "geojson", source: { data: "data:text/html,x" } })],
      ["metadata.originalUrl", addLayerSpec({ metadata: { originalUrl: "file:///etc/passwd" } })],
      ["blob", addLayerSpec({ source: { url: "blob:https://host/abc" } })],
      // A browser strips tab/newline/carriage return from anywhere in a URL,
      // so these name the blocked schemes too.
      ["split scheme", addLayerSpec({ source: { url: "java\tscript:alert(1)" } })],
      ["newline in scheme", addLayerSpec({ type: "geojson", source: { data: "da\nta:x" } })],
      ["carriage return", addLayerSpec({ source: { tiles: ["file\r:///etc/passwd"] } })],
    ] as const) {
      const parsed = parseEmbedRequest(message("addLayer", { spec }));
      assert.ok(parsed && "error" in parsed, `expected ${field} to be rejected`);
      assert.match(parsed.error, /^addLayer: unsupported URL scheme/);
    }
  });

  it("names the normalized scheme in the error, not the split-up raw one", () => {
    const parsed = parseEmbedRequest(
      message("addLayer", { spec: addLayerSpec({ source: { url: "java\tscript:alert(1)" } }) }),
    );
    assert.ok(parsed && "error" in parsed);
    assert.equal(parsed.error, 'addLayer: unsupported URL scheme in "javascript:"');
  });
});

describe("requireEmbedLayer", () => {
  it("returns the named layer", () => {
    const roads = layer();
    assert.equal(requireEmbedLayer([layer({ id: "parcels" }), roads], "roads"), roads);
  });

  it("throws the ack message a host sees for an unknown layer", () => {
    // The failure `setLayerVisibility`, `setFilter`, and `highlightFeature` all
    // report when the host names a layer the project no longer has.
    assert.throws(() => requireEmbedLayer([layer()], "missing"), /No layer with id "missing"/);
    assert.throws(() => requireEmbedLayer([], "roads"), /No layer with id "roads"/);
  });
});

describe("embedLayerSummaries", () => {
  it("projects only the fields listLayers publishes", () => {
    assert.deepEqual(
      embedLayerSummaries([
        layer({ opacity: 0.5, geojson: { type: "FeatureCollection", features: [] } }),
        layer({ id: "parcels", name: "Parcels", type: "geojson", visible: false }),
      ]),
      [
        { id: "roads", name: "Roads", type: "xyz", visible: true, opacity: 0.5 },
        { id: "parcels", name: "Parcels", type: "geojson", visible: false, opacity: 1 },
      ],
    );
  });
});

describe("buildEmbedLayer", () => {
  it("fills the store defaults a spec left out", () => {
    assert.deepEqual(buildEmbedLayer(addLayerSpec(), []), {
      id: "runtime",
      name: "Runtime",
      type: "xyz",
      source: { tiles: [XYZ_TILE_URL] },
      visible: true,
      opacity: 1,
      style: {},
      metadata: {},
    });
  });

  it("keeps the optional blocks a spec did supply", () => {
    const geojson = { type: "FeatureCollection", features: [] };
    assert.deepEqual(
      buildEmbedLayer(
        addLayerSpec({
          visible: false,
          opacity: 0.25,
          style: { color: "#ff0000" },
          metadata: { note: "from the host" },
          geojson,
          beforeId: "basemap",
        }),
        [],
      ),
      {
        id: "runtime",
        name: "Runtime",
        type: "xyz",
        source: { tiles: [XYZ_TILE_URL] },
        visible: false,
        opacity: 0.25,
        style: { color: "#ff0000" },
        metadata: { note: "from the host" },
        geojson,
        beforeId: "basemap",
      },
    );
  });

  it("refuses an id already in the project", () => {
    assert.throws(
      () => buildEmbedLayer(addLayerSpec({ id: "roads" }), [layer()]),
      /A layer with id "roads" already exists/,
    );
  });

  it("refuses a type no renderer knows", () => {
    // A made-up type would be added to the store and listed by `listLayers`,
    // but `layer-sync` has no branch for it, so nothing would ever draw.
    assert.throws(
      () => buildEmbedLayer(addLayerSpec({ type: "wobble" }), []),
      /Unsupported layer type "wobble"/,
    );
  });
});

describe("parseEmbedRequest: loadProject", () => {
  it("accepts an http(s) project URL", () => {
    assert.deepEqual(
      parseEmbedRequest(message("loadProject", { url: "https://x/p.geolibre.json" })),
      {
        command: { type: "loadProject", url: "https://x/p.geolibre.json" },
        requestId: null,
      },
    );
  });

  it("accepts a same-origin absolute path", () => {
    const parsed = parseEmbedRequest(message("loadProject", { url: "/projects/p.geolibre.json" }));
    assert.deepEqual(parsed, {
      command: { type: "loadProject", url: "/projects/p.geolibre.json" },
      requestId: null,
    });
  });

  it("reports an error for a non-fetchable scheme instead of loading it", () => {
    const parsed = parseEmbedRequest(message("loadProject", { url: "javascript:alert(1)" }));
    assert.ok(parsed && "error" in parsed);
  });

  it("reports an error when the url is missing", () => {
    const parsed = parseEmbedRequest(message("loadProject", {}));
    assert.ok(parsed && "error" in parsed);
  });
});

describe("parseEmbedRequest: setView", () => {
  it("parses a bbox", () => {
    const parsed = parseEmbedRequest(message("setView", { bbox: [-1, -2, 3, 4] }));
    assert.deepEqual(parsed, {
      command: { type: "setView", target: { kind: "bbox", bbox: [-1, -2, 3, 4] } },
      requestId: null,
    });
  });

  it("parses a center/zoom camera and keeps only the fields sent", () => {
    const parsed = parseEmbedRequest(message("setView", { center: [10, 20], zoom: 12, pitch: 45 }));
    assert.deepEqual(parsed, {
      command: {
        type: "setView",
        target: { kind: "camera", center: [10, 20], zoom: 12, pitch: 45 },
      },
      requestId: null,
    });
  });

  it("rejects a bbox with a non-finite value rather than flying to NaN", () => {
    const parsed = parseEmbedRequest(message("setView", { bbox: [-1, -2, 3, Number.NaN] }));
    assert.ok(parsed && "error" in parsed);
  });

  it("rejects an empty payload", () => {
    const parsed = parseEmbedRequest(message("setView", {}));
    assert.ok(parsed && "error" in parsed);
  });
});

describe("parseEmbedRequest: highlightFeature", () => {
  it("accepts a single feature id, as a string or a number", () => {
    for (const featureId of ["7", 7]) {
      const parsed = parseEmbedRequest(message("highlightFeature", { layerId: "l", featureId }));
      assert.deepEqual(parsed, {
        command: {
          type: "highlightFeature",
          target: { layerId: "l", featureIds: ["7"], filter: null, fit: false },
        },
        requestId: null,
      });
    }
  });

  it("merges featureId with featureIds without duplicating", () => {
    const parsed = parseEmbedRequest(
      message("highlightFeature", {
        layerId: "l",
        featureId: "a",
        featureIds: ["a", "b"],
        fit: true,
      }),
    );
    assert.deepEqual(parsed, {
      command: {
        type: "highlightFeature",
        target: { layerId: "l", featureIds: ["a", "b"], filter: null, fit: true },
      },
      requestId: null,
    });
  });

  it("accepts a property filter and treats an empty target as a clear", () => {
    const filtered = parseEmbedRequest(
      message("highlightFeature", { layerId: "l", filter: { parcel: "A-1" } }),
    );
    assert.deepEqual(filtered, {
      command: {
        type: "highlightFeature",
        target: { layerId: "l", featureIds: [], filter: { parcel: "A-1" }, fit: false },
      },
      requestId: null,
    });
    const cleared = parseEmbedRequest(message("highlightFeature", { layerId: "l" }));
    assert.ok(cleared && "command" in cleared);
  });

  it("requires a layerId", () => {
    const parsed = parseEmbedRequest(message("highlightFeature", { featureId: "a" }));
    assert.ok(parsed && "error" in parsed);
  });
});

describe("parseEmbedRequest: openTool", () => {
  it("passes the tool id through and stringifies scalar params", () => {
    const parsed = parseEmbedRequest(
      message("openTool", {
        id: "buffer",
        params: { distance: 100, dissolve: true, name: "x", bad: { nested: 1 } },
      }),
    );
    assert.deepEqual(parsed, {
      command: {
        type: "openTool",
        id: "buffer",
        params: { distance: "100", dissolve: "true", name: "x" },
      },
      requestId: null,
    });
  });

  it("defaults to no params", () => {
    const parsed = parseEmbedRequest(message("openTool", { id: "slope" }));
    assert.deepEqual(parsed, {
      command: { type: "openTool", id: "slope", params: {} },
      requestId: null,
    });
  });

  it("requires an id", () => {
    const parsed = parseEmbedRequest(message("openTool", {}));
    assert.ok(parsed && "error" in parsed);
  });
});

describe("resolveHighlightIds", () => {
  // Geometry is irrelevant here (only ids and properties are read), so these
  // fixtures declare it as null and type accordingly.
  const features: Feature<null>[] = [
    { type: "Feature", id: "f1", properties: { parcel: "A-1", area: 12 }, geometry: null },
    { type: "Feature", properties: { parcel: "A-2", area: 34 }, geometry: null },
    { type: "Feature", id: "f3", properties: { parcel: "A-1", area: 56 }, geometry: null },
  ];

  it("keeps an explicit id that the layer actually carries", () => {
    assert.deepEqual(resolveHighlightIds(features, highlightTarget({ featureIds: ["f3"] })), [
      "f3",
    ]);
  });

  it("resolves an explicit id against the index convention for an id-less feature", () => {
    assert.deepEqual(resolveHighlightIds(features, highlightTarget({ featureIds: ["1"] })), ["1"]);
  });

  it("drops an explicit id no feature carries, rather than selecting a phantom", () => {
    assert.deepEqual(resolveHighlightIds(features, highlightTarget({ featureIds: ["NOPE"] })), []);
    assert.deepEqual(
      resolveHighlightIds(features, highlightTarget({ featureIds: ["f1", "NOPE"] })),
      ["f1"],
    );
  });

  it("resolves nothing when the layer has no readable features", () => {
    assert.deepEqual(resolveHighlightIds([], highlightTarget({ featureIds: ["f1"] })), []);
  });

  it("matches every feature satisfying the filter, in feature order", () => {
    const ids = resolveHighlightIds(features, highlightTarget({ filter: { parcel: "A-1" } }));
    assert.deepEqual(ids, ["f1", "f3"]);
  });

  it("falls back to the feature index for a feature without an id", () => {
    const ids = resolveHighlightIds(features, highlightTarget({ filter: { parcel: "A-2" } }));
    assert.deepEqual(ids, ["1"]);
  });

  it("matches a numeric property sent as a string by the host", () => {
    const ids = resolveHighlightIds(features, highlightTarget({ filter: { area: "34" } }));
    assert.deepEqual(ids, ["1"]);
  });

  it("requires every filter pair to match", () => {
    const ids = resolveHighlightIds(
      features,
      highlightTarget({ filter: { parcel: "A-1", area: 56 } }),
    );
    assert.deepEqual(ids, ["f3"]);
  });

  it("does not duplicate a feature already named explicitly", () => {
    const ids = resolveHighlightIds(
      features,
      highlightTarget({ featureIds: ["f1"], filter: { parcel: "A-1" } }),
    );
    assert.deepEqual(ids, ["f1", "f3"]);
  });
});

describe("buildEmbedEvent", () => {
  it("stamps the version and source so a host can filter its own traffic", () => {
    assert.deepEqual(buildEmbedEvent("ready", { version: "2.2.0" }), {
      v: EMBED_API_VERSION,
      source: EMBED_API_SOURCE,
      type: "ready",
      payload: { version: "2.2.0" },
    });
  });
});
