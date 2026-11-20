import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import type { AddLayerSpec } from "../packages/embed/src";
import {
  isFetchedGeoJson,
  projectFromStore,
  rememberFetchedGeoJson,
  remoteGeoJsonUrl,
  useAppStore,
  type GeoLibreLayer,
} from "../packages/core/src";
import {
  addEmbedLayer,
  restoreRemoteGeoJsonLayers,
  withFetchedRemoteGeoJson,
} from "../apps/geolibre-desktop/src/lib/restore-remote-geojson-layers";
import * as notifyModule from "../apps/geolibre-desktop/src/lib/notify";

// GeoLibre#3508: a plain `geojson` layer that points at its data with
// `source.data` / `source.url` (no inline `geojson`) was listed but never
// fetched or drawn, on project restore and through the embed `addLayer` verb.

const BASE = "https://app.example/geolibre/";

function collection(name: string): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name },
        geometry: { type: "Point", coordinates: [-93.4, 41.9] },
      },
    ],
  };
}

function layer(overrides: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "fields",
    name: "Fields",
    type: "geojson",
    source: { type: "geojson", data: "https://data.example/fields.geojson" },
    visible: true,
    opacity: 1,
    style: {} as GeoLibreLayer["style"],
    metadata: {},
    ...overrides,
  };
}

describe("remoteGeoJsonUrl", () => {
  it("reads source.data, then source.url", () => {
    assert.equal(remoteGeoJsonUrl(layer(), BASE), "https://data.example/fields.geojson");
    assert.equal(
      remoteGeoJsonUrl(
        layer({ source: { type: "geojson", url: "https://data.example/u.geojson" } }),
        BASE,
      ),
      "https://data.example/u.geojson",
    );
  });

  it("resolves a root-relative path against the page", () => {
    assert.equal(
      remoteGeoJsonUrl(layer({ source: { type: "geojson", data: "/files/f.geojson" } }), BASE),
      "https://app.example/files/f.geojson",
    );
  });

  it("accepts only absolute URLs when there is no page to resolve against", () => {
    assert.equal(
      remoteGeoJsonUrl(layer({ source: { type: "geojson", data: "/home/me/f.geojson" } }), null),
      null,
    );
    assert.equal(remoteGeoJsonUrl(layer(), null), "https://data.example/fields.geojson");
  });

  it("skips inline data, other layer types, owned layers, and non-http references", () => {
    assert.equal(remoteGeoJsonUrl(layer({ geojson: collection("a") }), BASE), null);
    assert.equal(remoteGeoJsonUrl(layer({ type: "xyz" }), BASE), null);
    assert.equal(
      remoteGeoJsonUrl(layer({ metadata: { sourceKind: "maplibre-gl-vector" } }), BASE),
      null,
    );
    assert.equal(remoteGeoJsonUrl(layer({ metadata: { externalNativeLayer: true } }), BASE), null);
    assert.equal(remoteGeoJsonUrl(layer({ metadata: { localFileReloadable: true } }), BASE), null);
    for (const data of [
      "fields.geojson",
      "//cdn.example/f.json",
      "/\\evil.example/f.json",
      "/\t/evil.example/f.json",
      "file:///f.json",
      "data:,{}",
    ]) {
      assert.equal(remoteGeoJsonUrl(layer({ source: { type: "geojson", data } }), BASE), null);
    }
  });
});

describe("saving a fetched GeoJSON layer", () => {
  beforeEach(() => useAppStore.getState().newProject());

  it("keeps the URL reference instead of embedding the download", () => {
    const fetched = rememberFetchedGeoJson(collection("fetched"));
    useAppStore.getState().addLayer(layer({ geojson: fetched }));
    const saved = projectFromStore(useAppStore.getState()).layers[0];
    assert.equal(saved.geojson, undefined);
    assert.equal(saved.source.data, "https://data.example/fields.geojson");
  });

  it("embeds the features once they are edited", () => {
    const fetched = rememberFetchedGeoJson(collection("fetched"));
    useAppStore.getState().addLayer(layer({ geojson: fetched }));
    const edited = collection("edited");
    useAppStore.getState().updateLayer("fields", { geojson: edited });
    assert.equal(isFetchedGeoJson(edited), false);
    assert.deepEqual(projectFromStore(useAppStore.getState()).layers[0].geojson, edited);
  });

  it("still embeds inline features that were never fetched", () => {
    const inline = collection("inline");
    useAppStore.getState().addLayer(layer({ geojson: inline }));
    assert.deepEqual(projectFromStore(useAppStore.getState()).layers[0].geojson, inline);
  });
});

describe("restoreRemoteGeoJsonLayers", () => {
  const realFetch = globalThis.fetch;
  let requests: string[];

  beforeEach(() => {
    useAppStore.getState().newProject();
    requests = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function serve(body: unknown, status = 200): void {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/geo+json" },
      });
    }) as typeof fetch;
  }

  it("fetches a URL-only layer's features into the store once", async () => {
    serve(collection("remote"));
    useAppStore.getState().addLayer(layer());
    await restoreRemoteGeoJsonLayers();
    const restored = useAppStore.getState().layers[0];
    assert.equal(restored.geojson?.features[0].properties?.name, "remote");
    assert.equal(isFetchedGeoJson(restored.geojson), true);
    assert.deepEqual(requests, ["https://data.example/fields.geojson"]);

    // A map re-init re-runs restore over the same records: no second request.
    await restoreRemoteGeoJsonLayers();
    assert.equal(requests.length, 1);
  });

  it("keeps a layer whose data cannot be fetched, and does not retry it", async () => {
    serve({ error: "gone" }, 404);
    useAppStore.getState().addLayer(layer());
    await restoreRemoteGeoJsonLayers();
    await restoreRemoteGeoJsonLayers();
    const kept = useAppStore.getState().layers;
    assert.equal(kept.length, 1);
    assert.equal(kept[0].geojson, undefined);
    assert.equal(requests.length, 1);
  });

  it("warns, without fetching, about a reference it cannot fetch", async () => {
    serve(collection("unused"));
    const warnings: unknown[] = [];
    const realWarn = notifyModule.notify.warning;
    notifyModule.notify.warning = ((message: string) => void warnings.push(message)) as never;
    try {
      useAppStore
        .getState()
        .addLayer(layer({ source: { type: "geojson", data: "fields.geojson" } }));
      await restoreRemoteGeoJsonLayers();
      await restoreRemoteGeoJsonLayers();
    } finally {
      notifyModule.notify.warning = realWarn;
    }
    assert.equal(requests.length, 0);
    assert.equal(warnings.length, 1);
  });

  it("does not overwrite a layer removed while the request was in flight", async () => {
    let release!: () => void;
    globalThis.fetch = (async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return new Response(JSON.stringify(collection("late")));
    }) as typeof fetch;
    useAppStore.getState().addLayer(layer());
    const pending = restoreRemoteGeoJsonLayers();
    useAppStore.getState().removeLayer("fields");
    release();
    await pending;
    assert.equal(useAppStore.getState().layers.length, 0);
  });

  it("does not warn about a failed request for a layer removed meanwhile", async () => {
    let release!: () => void;
    globalThis.fetch = (async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    const warnings: unknown[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      useAppStore.getState().addLayer(layer());
      const pending = restoreRemoteGeoJsonLayers();
      useAppStore.getState().removeLayer("fields");
      release();
      await pending;
    } finally {
      console.warn = realWarn;
    }
    assert.equal(warnings.length, 0);
  });
});

describe("withFetchedRemoteGeoJson (embed addLayer)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("fills a URL-only spec before it is added", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(collection("remote")))) as typeof fetch;
    const filled = await withFetchedRemoteGeoJson(layer());
    assert.equal(filled.geojson?.features.length, 1);
    assert.equal(isFetchedGeoJson(filled.geojson), true);
  });

  it("rejects when the referenced document is not GeoJSON", async () => {
    globalThis.fetch = (async () => new Response("<html></html>")) as typeof fetch;
    await assert.rejects(withFetchedRemoteGeoJson(layer()), /valid JSON/);
  });

  it("rejects a collection whose features are not Feature objects", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ type: "FeatureCollection", features: [null] }),
      )) as typeof fetch;
    await assert.rejects(withFetchedRemoteGeoJson(layer()), /not a GeoJSON FeatureCollection/);
  });

  it("stops at an aborted signal", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return new Response(JSON.stringify(collection("remote")));
    }) as typeof fetch;
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(withFetchedRemoteGeoJson(layer(), { signal: abort.signal }));
  });

  it("rejects a reference it cannot fetch instead of adding an empty layer", async () => {
    for (const data of ["fields.geojson", "//cdn.example/f.json"]) {
      await assert.rejects(
        withFetchedRemoteGeoJson(layer({ source: { type: "geojson", data } })),
        /not an http\(s\) URL/,
      );
    }
  });

  it("passes a layer with inline features through untouched", async () => {
    const inline = layer({ geojson: collection("inline") });
    assert.equal(await withFetchedRemoteGeoJson(inline), inline);
  });
});

describe("addEmbedLayer", () => {
  const realFetch = globalThis.fetch;
  const spec = {
    id: "fields",
    name: "Fields",
    type: "geojson",
    source: { type: "geojson", data: "https://data.example/fields.geojson" },
  } as AddLayerSpec;

  beforeEach(() => {
    useAppStore.getState().newProject();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("adds a URL-only geojson layer with its fetched features", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(collection("remote")))) as typeof fetch;
    assert.equal(await addEmbedLayer(spec), "fields");
    const added = useAppStore.getState().layers.find((entry) => entry.id === "fields");
    assert.equal(added?.geojson?.features.length, 1);
  });

  it("adds nothing when a project load lands during the fetch", async () => {
    let release!: () => void;
    globalThis.fetch = (async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return new Response(JSON.stringify(collection("late")));
    }) as typeof fetch;
    const pending = addEmbedLayer(spec);
    useAppStore.setState((state) => ({ projectGeneration: state.projectGeneration + 1 }));
    release();
    await assert.rejects(pending, /project changed/);
    assert.equal(
      useAppStore.getState().layers.some((entry) => entry.id === "fields"),
      false,
    );
  });

  it("adds nothing once the embed is torn down", async () => {
    let release!: () => void;
    globalThis.fetch = (async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return new Response(JSON.stringify(collection("late")));
    }) as typeof fetch;
    const abort = new AbortController();
    const pending = addEmbedLayer(spec, abort.signal);
    abort.abort();
    release();
    await assert.rejects(pending);
    assert.equal(
      useAppStore.getState().layers.some((entry) => entry.id === "fields"),
      false,
    );
  });
});
