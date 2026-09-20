import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useAppStore, DEFAULT_LAYER_STYLE } from "@geolibre/core";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import {
  googleMapsApiKeyHeaderValue,
  isGooglePhotorealisticTilesetUrl,
  nonEmptyRecord,
  persistedThreeDTilesRequestHeaders,
  resolveThreeDTilesRequestHeaders,
  stripGoogleMapsApiKeyHeader,
} from "../packages/core/src/three-d-tiles";
import {
  createThreeDTilesGlobeStoreLayer,
  deferThreeDTilesRestoreUntilMapIdle,
  restoreThreeDTilesLayers,
} from "../packages/plugins/src/plugins/maplibre-3d-tiles";

// Shared 3D-Tiles header resolution: Google Photorealistic tiles keep their
// X-GOOG-API-KEY out of the store and have it re-injected at render time. Both
// the MapLibre and Cesium render paths must resolve it the same way.

const GOOGLE = "https://tile.googleapis.com/v1/3dtiles/root.json";

describe("deferThreeDTilesRestoreUntilMapIdle", () => {
  it("continues immediately when the style is ready", () => {
    const map = {
      isStyleLoaded: () => true,
      once: () => {
        throw new Error("style listener should not be registered");
      },
    } as unknown as Parameters<typeof deferThreeDTilesRestoreUntilMapIdle>[0];

    assert.equal(
      deferThreeDTilesRestoreUntilMapIdle(map, () => {}),
      false,
    );
  });

  it("queues one restore until an in-progress style load finishes", () => {
    const listeners: Array<() => void> = [];
    const map = {
      isStyleLoaded: () => false,
      once: (event: string, listener: () => void) => {
        assert.equal(event, "idle");
        listeners.push(listener);
      },
    } as unknown as Parameters<typeof deferThreeDTilesRestoreUntilMapIdle>[0];
    let firstRestoreCount = 0;
    let duplicateRestoreCount = 0;

    assert.equal(
      deferThreeDTilesRestoreUntilMapIdle(map, () => {
        firstRestoreCount += 1;
      }),
      true,
    );
    assert.equal(
      deferThreeDTilesRestoreUntilMapIdle(map, () => {
        duplicateRestoreCount += 1;
      }),
      true,
    );
    assert.equal(listeners.length, 1);

    listeners[0]();

    assert.equal(firstRestoreCount, 1);
    assert.equal(duplicateRestoreCount, 0);
  });
});

describe("resolveThreeDTilesRequestHeaders", () => {
  it("passes non-Google tileset headers through unchanged", () => {
    const headers = { Authorization: "Bearer x" };
    assert.equal(
      resolveThreeDTilesRequestHeaders("https://example.com/tileset.json", headers),
      headers,
    );
  });

  it("re-injects the Google key from the fallback when the store stripped it", () => {
    // The store record carries no key (stripped for sharing); the resolver
    // rebuilds the header from the runtime-env fallback.
    assert.deepEqual(resolveThreeDTilesRequestHeaders(GOOGLE, undefined, "env-key"), {
      "X-GOOG-API-KEY": "env-key",
    });
  });

  it("prefers an explicit key already present in the headers", () => {
    assert.deepEqual(
      resolveThreeDTilesRequestHeaders(GOOGLE, { "X-GOOG-API-KEY": "header-key" }, "env-key"),
      { "X-GOOG-API-KEY": "header-key" },
    );
  });

  it("ignores a masked placeholder key and falls back", () => {
    assert.deepEqual(
      resolveThreeDTilesRequestHeaders(GOOGLE, { "X-GOOG-API-KEY": "********" }, "env-key"),
      { "X-GOOG-API-KEY": "env-key" },
    );
  });

  it("detects the Google Photorealistic tileset url", () => {
    assert.equal(isGooglePhotorealisticTilesetUrl(GOOGLE), true);
    assert.equal(isGooglePhotorealisticTilesetUrl("https://tile.googleapis.com/other"), false);
    assert.equal(isGooglePhotorealisticTilesetUrl("not a url"), false);
  });
});

// The persistence + header helpers were duplicated in the MapLibre plugin until
// they were centralized here (issue #1142). The plugin now imports them, so the
// tests live with the shared implementation both render paths depend on.

describe("persistedThreeDTilesRequestHeaders", () => {
  it("passes non-Google tileset headers through unchanged", () => {
    const headers = { Authorization: "Bearer x" };
    assert.equal(
      persistedThreeDTilesRequestHeaders("https://example.com/tileset.json", headers),
      headers,
    );
  });

  it("strips the Google key so it never persists in a shared project", () => {
    assert.deepEqual(
      persistedThreeDTilesRequestHeaders(GOOGLE, {
        "X-GOOG-API-KEY": "secret",
        Authorization: "Bearer x",
      }),
      { Authorization: "Bearer x" },
    );
  });

  it("collapses to undefined when only the key header was present", () => {
    assert.equal(
      persistedThreeDTilesRequestHeaders(GOOGLE, { "X-GOOG-API-KEY": "secret" }),
      undefined,
    );
  });
});

describe("stripGoogleMapsApiKeyHeader", () => {
  it("removes the key header case-insensitively and keeps the rest", () => {
    assert.deepEqual(stripGoogleMapsApiKeyHeader({ "x-goog-api-key": "secret", Accept: "json" }), {
      Accept: "json",
    });
  });

  it("returns undefined for empty or missing input", () => {
    assert.equal(stripGoogleMapsApiKeyHeader(undefined), undefined);
    assert.equal(stripGoogleMapsApiKeyHeader({ "X-GOOG-API-KEY": "secret" }), undefined);
  });
});

describe("googleMapsApiKeyHeaderValue", () => {
  it("returns the real key value, case-insensitively", () => {
    assert.equal(googleMapsApiKeyHeaderValue({ "x-goog-api-key": " key " }), "key");
  });

  it("ignores a masked placeholder and missing values", () => {
    assert.equal(googleMapsApiKeyHeaderValue({ "X-GOOG-API-KEY": "****" }), undefined);
    assert.equal(googleMapsApiKeyHeaderValue({ Accept: "json" }), undefined);
    assert.equal(googleMapsApiKeyHeaderValue(undefined), undefined);
  });
});

describe("nonEmptyRecord", () => {
  it("passes a non-empty record through and collapses an empty one", () => {
    const record = { a: "1" };
    assert.equal(nonEmptyRecord(record), record);
    assert.equal(nonEmptyRecord({}), undefined);
    assert.equal(nonEmptyRecord(undefined), undefined);
  });
});

describe("restoreThreeDTilesLayers on the globe", () => {
  it("leaves the 3D Tiles control alone when Cesium is the renderer (issue #2505)", () => {
    // Cesium draws a 3D Tiles record itself, and the map the control would be
    // mounted on there is a facade with no style layers: reaching the MapLibre
    // restore path is what threw `getLayer is not a function`.
    useAppStore.getState().newProject();
    useAppStore.getState().addLayer({
      id: "globe-tiles",
      name: "Tiles",
      type: "3d-tiles",
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      source: { url: "https://example.com/tileset.json" },
      metadata: { sourceKind: "3d-tiles-url", externalNativeLayer: true },
    });

    const app = {
      getMapRenderer: () => "cesium" as const,
      getMap: () => {
        throw new Error("the globe has no MapLibre map to restore into");
      },
      addMapControl: () => {
        throw new Error("the 3D Tiles control must not be mounted on the globe");
      },
    } as unknown as GeoLibreAppAPI;

    restoreThreeDTilesLayers(app);

    // The record stays put for the globe's own layer sync to draw.
    assert.equal(useAppStore.getState().layers.length, 1);
  });
});

describe("createThreeDTilesGlobeStoreLayer", () => {
  // Every flavour the panel accepts renders on the globe, but only if its own
  // sourceKind survives: cesium-layer-sync routes a scene service to
  // I3SDataProvider on "arcgis-i3s" alone, and the 2D restore paths find a
  // Google tileset by its Google kind (issue #2505).
  const panelFields = (url: string) => ({
    id: "tiles-1",
    layerId: "tiles-1-tiles",
    layerName: "Scene",
    tilesetUrl: url,
    altitudeOffset: -300,
    opacity: 0.5,
    visible: true,
    status: "loaded" as const,
  });

  it("files a scene service under the I3S kind so the globe uses I3SDataProvider", () => {
    const layer = createThreeDTilesGlobeStoreLayer(
      panelFields(
        "https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/SanFrancisco_Bldgs/SceneServer/layers/0",
      ),
    );
    assert.equal(layer.type, "3d-tiles");
    assert.equal(layer.metadata.sourceKind, "arcgis-i3s");
    assert.equal(layer.opacity, 0.5);
    assert.equal(layer.name, "Scene");
  });

  it("files Google Photorealistic tiles under the Google kind", () => {
    const layer = createThreeDTilesGlobeStoreLayer(panelFields(GOOGLE));
    assert.equal(layer.metadata.sourceKind, "google-photorealistic-3d-tiles");
    // The API key header is never persisted on the record, on any renderer.
    assert.equal(layer.source.requestHeaders, undefined);
  });

  it("keeps a plain tileset.json on the generic 3D Tiles kind", () => {
    const layer = createThreeDTilesGlobeStoreLayer(
      panelFields("https://example.com/3dtiles/tileset.json"),
    );
    assert.equal(layer.metadata.sourceKind, "3d-tiles-url");
    assert.equal(layer.source.url, "https://example.com/3dtiles/tileset.json");
    assert.equal(layer.source.altitudeOffset, -300);
  });
});
