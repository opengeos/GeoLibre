import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  arcgisI3sSceneLayerName,
  buildArcgisI3sTilesDeckLayer,
  i3sTilesetLngLat,
  isArcgisI3sSceneLayerUrl,
  isArcgisI3sTilesLayer,
  persistI3sTilesetCenter,
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

  function build() {
    const props: Record<string, unknown>[] = [];
    class FakeTile3DLayer {
      constructor(p: Record<string, unknown>) {
        props.push(p);
      }
    }
    const deckGL = {
      geoLayers: { Tile3DLayer: FakeTile3DLayer },
    } as unknown as GeoLibreDeckGL;
    buildArcgisI3sTilesDeckLayer(layer, { deckGL, loader: {} });
    return props[0];
  }

  it("passes the shared main-thread load options to the Tile3DLayer", () => {
    // The whole point of the CSP fix: the constructed layer must carry
    // core.worker === false so parsing never falls back to a CDN worker. The
    // call site spreads the shared constant into a fresh object, so compare by
    // value rather than reference.
    const props = build();
    assert.deepEqual(props?.loadOptions, THREE_D_TILES_DECK_LOAD_OPTIONS);
    assert.equal((props?.loadOptions as typeof THREE_D_TILES_DECK_LOAD_OPTIONS).core.worker, false);
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
