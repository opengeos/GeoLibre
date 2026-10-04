import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import { clearDiagnostics } from "../apps/geolibre-desktop/src/lib/diagnostics";
import { createLayerFailureNotifier } from "../apps/geolibre-desktop/src/lib/layer-failure-notifier";
import {
  layerForTileUrl,
  mapErrorNotice,
  MISSING_TILES_THRESHOLD,
  tilesLookBroken,
} from "../apps/geolibre-desktop/src/lib/map-error-notification";
import { clearNotifications, useNotificationStore } from "../apps/geolibre-desktop/src/lib/notify";

const visible = () => useNotificationStore.getState().notifications;

const layers = [
  { id: "roads", name: "Roads", source: { type: "geojson" } },
  {
    id: "xyz",
    name: "Imagery",
    source: { tiles: ["https://tiles.example.com/v1/{z}/{x}/{y}.png?key=abc"] },
  },
] as unknown as GeoLibreLayer[];

// Echoes the key and its values, so assertions can read what was asked for.
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key} ${JSON.stringify(options)}` : key;

describe("mapErrorNotice", () => {
  it("resolves a Cesium/ArcGIS layer by its store id", () => {
    const notice = mapErrorNotice({ message: "x", source: "cesium", layerId: "roads" }, layers);
    assert.equal(notice?.layer.name, "Roads");
    assert.equal(notice?.kind, "failed");
  });

  it("reads 401/403 as access denied, tile or not", () => {
    for (const status of [401, 403]) {
      const notice = mapErrorNotice(
        { message: "x", layerId: "xyz", status, tiles: { loaded: 5, failed: 1 } },
        layers,
      );
      assert.equal(notice?.kind, "accessDenied");
      assert.equal(notice?.status, status);
    }
    assert.equal(
      mapErrorNotice({ message: "x", source: "source-roads", status: 403 }, layers)?.kind,
      "accessDenied",
    );
  });

  it("waits for a run of failures with no loaded tile before blaming a counted tile layer", () => {
    const event = (loaded: number, failed: number, status?: number) =>
      mapErrorNotice({ message: "x", layerId: "xyz", status, tiles: { loaded, failed } }, layers);
    assert.equal(event(0, MISSING_TILES_THRESHOLD - 1, 404), null);
    assert.equal(event(0, MISSING_TILES_THRESHOLD, 404)?.kind, "tilesMissing");
    // Status unseen (an <img> load): a broken layer, but not provably "missing".
    assert.equal(event(0, MISSING_TILES_THRESHOLD)?.kind, "failed");
    // One loaded tile makes it a sparse set.
    assert.equal(event(1, 30, 404), null);
    assert.equal(event(1, 30), null);
    // A server error is a failure at once.
    assert.equal(event(4, 1, 500)?.kind, "failed");
  });

  it("tilesLookBroken needs zero loads and the threshold", () => {
    assert.equal(tilesLookBroken({ loaded: 0, failed: MISSING_TILES_THRESHOLD }), true);
    assert.equal(tilesLookBroken({ loaded: 1, failed: 100 }), false);
    assert.equal(tilesLookBroken({ loaded: 0, failed: 1 }), false);
  });
});

describe("layerForTileUrl", () => {
  it("matches a requested tile to the template that produced it", () => {
    assert.equal(
      layerForTileUrl("https://tiles.example.com/v1/3/4/2.png?key=abc", layers)?.id,
      "xyz",
    );
    // An engine-appended query is still the same template.
    assert.equal(
      layerForTileUrl("https://tiles.example.com/v1/3/4/2.png?key=abc&v=2", layers)?.id,
      "xyz",
    );
  });

  it("ignores other hosts, other paths, and non-template layers", () => {
    assert.equal(layerForTileUrl("https://tiles.example.com/v2/3/4/2.png?key=abc", layers), null);
    assert.equal(layerForTileUrl("https://other.example.com/v1/3/4/2.png", layers), null);
    assert.equal(layerForTileUrl("https://tiles.example.com/v1/3/4/extra/2.png", layers), null);
  });

  it("does not treat regex characters in a template as patterns", () => {
    const dotted = [
      { id: "d", name: "D", source: { tiles: ["https://a.b/{z}/{x}/{y}.png"] } },
    ] as unknown as GeoLibreLayer[];
    assert.equal(layerForTileUrl("https://aXb/1/2/3.png", dotted), null);
    assert.equal(layerForTileUrl("https://a.b/1/2/3.png", dotted)?.id, "d");
  });
});

describe("createLayerFailureNotifier", () => {
  beforeEach(() => {
    clearNotifications();
    clearDiagnostics();
  });
  afterEach(() => clearNotifications());

  const notifier = () => createLayerFailureNotifier({ getLayers: () => layers, t });
  const tile = (status: number) => ({
    url: "https://tiles.example.com/v1/3/4/2.png?key=abc",
    method: "GET",
    status,
  });

  it("warns once when every tile of a layer is missing", () => {
    const n = notifier();
    for (let i = 0; i < MISSING_TILES_THRESHOLD - 1; i++) n.handleNetworkResponse(tile(404));
    assert.equal(visible().length, 0);
    n.handleNetworkResponse(tile(404));
    assert.equal(visible().length, 1);
    assert.equal(visible()[0].kind, "warning");
    assert.match(visible()[0].message, /notifications\.layerTilesMissing .*Imagery/);
    for (let i = 0; i < 20; i++) n.handleNetworkResponse(tile(404));
    assert.equal(visible().length, 1);
    assert.equal(visible()[0].count, 1);
  });

  it("never warns about a sparse layer that loaded a tile", () => {
    const n = notifier();
    n.handleNetworkResponse(tile(200));
    for (let i = 0; i < 50; i++) n.handleNetworkResponse(tile(404));
    assert.equal(visible().length, 0);
  });

  it("warns about a refused key on the first 401/403 tile", () => {
    const n = notifier();
    n.handleNetworkResponse(tile(403));
    assert.equal(visible().length, 1);
    assert.equal(visible()[0].kind, "warning");
    assert.match(visible()[0].description ?? "", /"status":403/);
  });

  it("ignores responses that belong to no layer", () => {
    const n = notifier();
    n.handleNetworkResponse({
      url: "https://elsewhere.example.com/a.json",
      method: "GET",
      status: 403,
    });
    assert.equal(visible().length, 0);
  });

  it("shows an engine failure as an error, once per layer across inputs", () => {
    const n = notifier();
    n.handleMapEvent({ message: "boom", source: "cesium", layerId: "xyz" });
    n.handleMapEvent({ message: "boom again", source: "cesium", layerId: "xyz" });
    n.handleNetworkResponse(tile(403));
    assert.equal(visible().length, 1);
    assert.equal(visible()[0].kind, "error");
    assert.match(visible()[0].message, /notifications\.layerLoadFailed .*Imagery/);
    // The error toast links a Diagnostics record for "Report issue".
    assert.ok(visible()[0].diagnostic);
  });

  it("stays quiet for basemap sources and empty tiles", () => {
    const n = notifier();
    n.handleMapEvent({ message: "x", source: "openmaptiles" });
    n.handleMapEvent({
      message: "Not Found",
      source: "source-xyz",
      status: 404,
      detail: JSON.stringify({ tile: { z: 1 } }),
    });
    assert.equal(visible().length, 0);
  });
});
