import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Tileset3D } from "@loaders.gl/tiles";
import {
  applyThreeDTilesTilesetMemoryLimit,
  arcgisI3sSceneLayerName,
  buildArcgisI3sTilesDeckLayer,
  buildArcgisI3sTilesDeckLayers,
  i3sDocumentRequestUrl,
  i3sTilesetLngLat,
  isArcgisI3sSceneLayerUrl,
  isArcgisI3sTilesLayer,
  persistI3sTilesetCenter,
  probeI3sLayerKind,
  ARCGIS_I3S_SOURCE_KIND,
  THREE_D_TILES_DECK_LOAD_OPTIONS,
} from "../packages/plugins/src/plugins/arcgis-i3s-tiles";
import type { GeoLibreDeckGL } from "../packages/plugins/src/types";
import { useAppStore } from "../packages/core/src/store";
import type { GeoLibreLayer } from "../packages/core/src/types";

describe("isArcgisI3sSceneLayerUrl", () => {
  it("matches SceneServer endpoints", () => {
    for (const url of [
      "https://tiles.arcgis.com/tiles/ab/arcgis/rest/services/SF_Bldgs/SceneServer/layers/0",
      "https://services.arcgis.com/ab/arcgis/rest/services/Trees/SceneServer",
      "https://example.com/server/rest/services/City/SceneServer?token=xyz",
      "https://host/SceneServer/",
    ]) {
      assert.equal(isArcgisI3sSceneLayerUrl(url), true, url);
    }
  });

  it("does not match non-I3S URLs", () => {
    for (const url of [
      "https://example.com/tileset.json",
      "https://tile.googleapis.com/v1/3dtiles/root.json",
      "https://services.arcgis.com/ab/arcgis/rest/services/Roads/FeatureServer/0",
      "https://example.com/scenes/my-scene.json",
    ]) {
      assert.equal(isArcgisI3sSceneLayerUrl(url), false, url);
    }
  });

  it("ignores surrounding whitespace", () => {
    assert.equal(isArcgisI3sSceneLayerUrl("  https://host/City/SceneServer  "), true);
  });
});

describe("isArcgisI3sTilesLayer", () => {
  const base: GeoLibreLayer = {
    id: "x",
    name: "x",
    type: "3d-tiles",
    source: { sourceId: "x", type: ARCGIS_I3S_SOURCE_KIND, url: "u" },
    visible: true,
    opacity: 1,
    style: {},
    metadata: { sourceKind: ARCGIS_I3S_SOURCE_KIND },
  } as unknown as GeoLibreLayer;

  it("matches a 3d-tiles layer with the arcgis-i3s source kind", () => {
    assert.equal(isArcgisI3sTilesLayer(base), true);
  });

  it("rejects other 3d-tiles layers and other types", () => {
    assert.equal(
      isArcgisI3sTilesLayer({
        ...base,
        metadata: { sourceKind: "google-photorealistic-3d-tiles" },
      } as unknown as GeoLibreLayer),
      false,
    );
    assert.equal(
      isArcgisI3sTilesLayer({
        ...base,
        type: "raster",
      } as unknown as GeoLibreLayer),
      false,
    );
  });
});

describe("arcgisI3sSceneLayerName", () => {
  it("derives the service name from the SceneServer path", () => {
    assert.equal(
      arcgisI3sSceneLayerName(
        "https://tiles.arcgis.com/tiles/ab/arcgis/rest/services/SF_Bldgs/SceneServer/layers/0",
      ),
      "SF_Bldgs",
    );
    assert.equal(
      arcgisI3sSceneLayerName(
        "https://services.arcgis.com/ab/arcgis/rest/services/Trees/SceneServer",
      ),
      "Trees",
    );
    assert.equal(
      arcgisI3sSceneLayerName(
        "https://example.com/server/rest/services/City/SceneServer?token=xyz",
      ),
      "City",
    );
  });

  it("decodes percent-encoded service names", () => {
    assert.equal(
      arcgisI3sSceneLayerName("https://host/rest/services/My%20City/SceneServer"),
      "My City",
    );
  });

  it("returns null when there is no SceneServer service segment", () => {
    assert.equal(arcgisI3sSceneLayerName("https://example.com/tileset.json"), null);
  });

  it("falls back to the raw segment on a malformed percent-escape", () => {
    assert.equal(
      arcgisI3sSceneLayerName("https://host/rest/services/Bad%ZZName/SceneServer"),
      "Bad%ZZName",
    );
  });
});

describe("THREE_D_TILES_DECK_LOAD_OPTIONS", () => {
  // Regression guard: @loaders.gl otherwise fetches its parsing workers from the
  // unpkg CDN at runtime, which the Tauri desktop CSP blocks. Workers must stay
  // disabled, and `worker` must be nested under `core` (the documented shape; a
  // top-level `worker` only works via a deprecated backwards-compat alias).
  it("disables loaders.gl workers via core.worker", () => {
    assert.equal(THREE_D_TILES_DECK_LOAD_OPTIONS.core.worker, false);
  });

  // Issue #2560: loaders.gl ratchets the error target up on every tile load
  // over the memory cap, so zooming in could drop to a coarser level of detail.
  it("keeps the screen-space error fixed rather than memory-adjusted", () => {
    assert.equal(THREE_D_TILES_DECK_LOAD_OPTIONS.tileset.memoryAdjustedScreenSpaceError, false);
  });
});

describe("applyThreeDTilesTilesetMemoryLimit", () => {
  // Issue #2560: Tileset3D's cache trims against a field that stays at 32 MB
  // whatever maximumMemoryUsage the load options pass.
  it("syncs the tileset cache cap with the configured memory limit", () => {
    const tileset = { maximumMemoryUsage: 32 };
    applyThreeDTilesTilesetMemoryLimit(tileset);
    assert.equal(
      tileset.maximumMemoryUsage,
      THREE_D_TILES_DECK_LOAD_OPTIONS.tileset.maximumMemoryUsage,
    );
  });

  // Drift guard for a @loaders.gl bump: run the helper on a real Tileset3D, so
  // a renamed or lazily initialised cache field fails here instead of the fix
  // silently turning into a no-op.
  it("raises a real loaders.gl Tileset3D cache cap from its 32 MB default", () => {
    const tileset = new Tileset3D(
      {
        asset: { version: "1.0" },
        root: { boundingVolume: { sphere: [0, 0, 0, 1] }, geometricError: 1, refine: "REPLACE" },
        url: "https://example.com/tileset.json",
        basePath: "https://example.com",
        type: "TILES3D",
        lodMetricType: "geometricError",
        lodMetricValue: 1,
      } as never,
      { ...THREE_D_TILES_DECK_LOAD_OPTIONS.tileset },
    );
    assert.equal(tileset.maximumMemoryUsage, 32);
    applyThreeDTilesTilesetMemoryLimit(tileset);
    assert.equal(
      tileset.maximumMemoryUsage,
      THREE_D_TILES_DECK_LOAD_OPTIONS.tileset.maximumMemoryUsage,
    );
  });

  it("ignores values that are not a tileset", () => {
    const other = { name: "not a tileset" };
    applyThreeDTilesTilesetMemoryLimit(other);
    assert.deepEqual(other, { name: "not a tileset" });
    assert.doesNotThrow(() => applyThreeDTilesTilesetMemoryLimit(null));
  });
});

describe("buildArcgisI3sTilesDeckLayer", () => {
  const layer = {
    id: "i3s-1",
    name: "Scene",
    type: "3d-tiles",
    source: {
      sourceId: "i3s-1",
      type: ARCGIS_I3S_SOURCE_KIND,
      url: "https://host/City/SceneServer",
    },
    visible: true,
    opacity: 0.5,
    style: {},
    metadata: { sourceKind: ARCGIS_I3S_SOURCE_KIND },
  } as unknown as GeoLibreLayer;

  function build(meshLayer?: unknown) {
    const props: Record<string, unknown>[] = [];
    class FakeTile3DLayer {
      constructor(p: Record<string, unknown>) {
        props.push(p);
      }
    }
    const deckGL = {
      geoLayers: { Tile3DLayer: FakeTile3DLayer },
    } as unknown as GeoLibreDeckGL;
    buildArcgisI3sTilesDeckLayer(layer, { deckGL, loader: {}, meshLayer });
    return props[0];
  }

  it("passes the shared main-thread load options to the Tile3DLayer", () => {
    // The whole point of the CSP fix: the constructed layer must carry
    // core.worker === false so parsing never falls back to a CDN worker. The
    // call site spreads the shared constant into a fresh object, so compare by
    // value rather than reference.
    const props = build();
    const options = props?.loadOptions as {
      tileset: unknown;
      core: { worker: boolean; fetch?: unknown };
    };
    assert.deepEqual(options.tileset, THREE_D_TILES_DECK_LOAD_OPTIONS.tileset);
    assert.equal(options.core.worker, false);
  });

  it("fetches layer documents as JSON and leaves other requests alone", async () => {
    const fetchImpl = (build()?.loadOptions as { core: { fetch: typeof fetch } }).core.fetch;
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response("{}");
    }) as typeof fetch;
    try {
      const base = "https://example.com/arcgis/rest/services/B/SceneServer/layers/0";
      await fetchImpl(base);
      await fetchImpl(new Request(`${base}/nodepages/0`));
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(seen, [
      "https://example.com/arcgis/rest/services/B/SceneServer/layers/0?f=json",
      "https://example.com/arcgis/rest/services/B/SceneServer/layers/0/nodepages/0",
    ]);
  });

  it("keeps a Request's method, headers and body, and lets init override them", async () => {
    const fetchImpl = (build()?.loadOptions as { core: { fetch: typeof fetch } }).core.fetch;
    const seen: {
      url: string;
      method: string;
      header: string | null;
      body: string;
      init?: RequestInit;
    }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input as Request;
      seen.push({
        url: request.url,
        method: request.method,
        header: request.headers.get("x-test"),
        body: await request.text(),
        init,
      });
      return new Response("{}");
    }) as typeof fetch;
    try {
      const base = "https://example.com/arcgis/rest/services/B/SceneServer/layers/0";
      await fetchImpl(
        new Request(base, { method: "POST", headers: { "x-test": "1" }, body: "payload" }),
        { headers: { "x-test": "2" } },
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(
      seen[0].url,
      "https://example.com/arcgis/rest/services/B/SceneServer/layers/0?f=json",
    );
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].header, "1");
    assert.equal(seen[0].body, "payload");
    // init is passed on as given, so fetch applies it over the Request.
    assert.deepEqual(seen[0].init, { headers: { "x-test": "2" } });
  });

  it("draws I3S meshes with GeoLibre's mesh layer when it is loaded", () => {
    class MeshLayer {}
    assert.deepEqual(build(MeshLayer)?._subLayerProps, { mesh: { type: MeshLayer } });
    assert.equal(build()?._subLayerProps, undefined);
  });

  it("returns null when the deck.gl class or loader is missing", () => {
    assert.equal(buildArcgisI3sTilesDeckLayer(layer, { deckGL: null, loader: {} }), null);
    assert.equal(
      buildArcgisI3sTilesDeckLayer(layer, {
        deckGL: { geoLayers: { Tile3DLayer: class {} } } as unknown as GeoLibreDeckGL,
        loader: null,
      }),
      null,
    );
  });
});

describe("i3sTilesetLngLat", () => {
  it("returns the [lng, lat] pair from a cartographic center", () => {
    assert.deepEqual(i3sTilesetLngLat({ cartographicCenter: [10, 20, 30] }), [10, 20]);
  });

  it("returns null for missing, malformed, or non-finite centers", () => {
    assert.equal(i3sTilesetLngLat(null), null);
    assert.equal(i3sTilesetLngLat({}), null);
    assert.equal(i3sTilesetLngLat({ cartographicCenter: [Number.NaN, 20] }), null);
    assert.equal(i3sTilesetLngLat({ cartographicCenter: ["a", "b"] as unknown as number[] }), null);
  });

  it("rejects centers outside the valid lng/lat range", () => {
    assert.equal(i3sTilesetLngLat({ cartographicCenter: [200, 20] }), null);
    assert.equal(i3sTilesetLngLat({ cartographicCenter: [10, 95] }), null);
  });
});

describe("persistI3sTilesetCenter", () => {
  function seedI3sLayer(): GeoLibreLayer {
    const layer = {
      id: "i3s-1",
      name: "Scene",
      type: "3d-tiles",
      source: { sourceId: "i3s-1", type: ARCGIS_I3S_SOURCE_KIND, url: "u" },
      visible: true,
      opacity: 1,
      style: {},
      metadata: { sourceKind: ARCGIS_I3S_SOURCE_KIND },
    } as unknown as GeoLibreLayer;
    useAppStore.setState({ layers: [layer] });
    return layer;
  }

  it("writes the tileset center into layer.metadata.center", () => {
    seedI3sLayer();
    persistI3sTilesetCenter("i3s-1", { cartographicCenter: [-122.4, 37.8, 0] });
    assert.deepEqual(useAppStore.getState().layers[0].metadata.center, [-122.4, 37.8]);
  });

  it("skips a redundant store write when the center is unchanged", () => {
    seedI3sLayer();
    persistI3sTilesetCenter("i3s-1", { cartographicCenter: [-122.4, 37.8, 0] });
    const afterFirst = useAppStore.getState().layers[0];
    persistI3sTilesetCenter("i3s-1", { cartographicCenter: [-122.4, 37.8, 0] });
    // No write means the layer object reference is untouched.
    assert.equal(useAppStore.getState().layers[0], afterFirst);
  });

  it("ignores invalid centers and unknown / non-I3S layers", () => {
    seedI3sLayer();
    persistI3sTilesetCenter("i3s-1", { cartographicCenter: [Number.NaN, 1] });
    assert.equal(useAppStore.getState().layers[0].metadata.center, undefined);
    assert.doesNotThrow(() =>
      persistI3sTilesetCenter("missing", { cartographicCenter: [1, 2, 3] }),
    );
  });
});

describe("i3sDocumentRequestUrl", () => {
  const base = "https://services5.arcgis.com/x/ArcGIS/rest/services/Library/SceneServer";

  it("asks an ArcGIS Server for a layer document as JSON", () => {
    assert.equal(i3sDocumentRequestUrl(`${base}/layers/0`), `${base}/layers/0?f=json`);
    assert.equal(
      i3sDocumentRequestUrl(`${base}/layers/0/sublayers/23`),
      `${base}/layers/0/sublayers/23?f=json`,
    );
    assert.equal(
      i3sDocumentRequestUrl(`${base}/layers/0?token=t`),
      `${base}/layers/0?token=t&f=json`,
    );
  });

  it("leaves node pages, resources and an explicit format alone", () => {
    for (const url of [
      `${base}/layers/0/nodepages/3`,
      `${base}/layers/0/nodes/1/geometries/0`,
      `${base}/layers/0?f=pjson`,
      "not a url",
    ]) {
      assert.equal(i3sDocumentRequestUrl(url), url);
    }
  });
});

describe("probeI3sLayerKind", () => {
  const base = "https://services5.arcgis.com/x/ArcGIS/rest/services/Library/SceneServer";

  it("keys failed probes by URL so updating a layer's URL probes the new endpoint", async () => {
    const badLayer = {
      id: "i3s-probe-1",
      name: "Scene",
      type: "3d-tiles",
      source: { sourceId: "i3s-probe-1", type: ARCGIS_I3S_SOURCE_KIND, url: `${base}/layers/99` },
      visible: true,
      opacity: 1,
      style: {},
      metadata: { sourceKind: ARCGIS_I3S_SOURCE_KIND },
    } as unknown as GeoLibreLayer;
    useAppStore.setState({ layers: [badLayer] });

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/layers/99")) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          layerType: "Building",
          sublayers: [
            {
              id: 0,
              name: "Overview",
              layerType: "3DObject",
              visibility: true,
            },
          ],
        }),
      );
    }) as typeof fetch;
    try {
      await probeI3sLayerKind(badLayer);
      // Failed probe does not write to metadata, and updated URL starts unprobed again.
      assert.equal(useAppStore.getState().layers[0].metadata.i3sKind, undefined);
      const updatedLayer = {
        ...badLayer,
        source: { ...badLayer.source, url: `${base}/layers/0` },
      } as unknown as GeoLibreLayer;
      useAppStore.setState({ layers: [updatedLayer] });
      assert.deepEqual(buildArcgisI3sTilesDeckLayers(updatedLayer), []);

      await probeI3sLayerKind(updatedLayer);
      assert.equal(useAppStore.getState().layers[0].metadata.i3sKind, "building");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
