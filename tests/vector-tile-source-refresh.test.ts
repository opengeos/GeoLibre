import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import { syncLayer } from "../packages/map/src/layer-sync";

/**
 * A vector-tile source must follow its layer's tile template. MapLibre creates a
 * source once and then serves what it has cached, so a store update alone never
 * reaches the map: a re-signed GeoLens tile URL would keep 404ing after its
 * token expired, and edits saved back to a dataset would only appear at zoom
 * levels the user had not visited yet.
 */

interface FakeSource {
  tiles: string[];
  setTilesCalls: string[][];
  setTiles(tiles: string[]): void;
}

function makeMapStub(source: FakeSource | undefined) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const map = {
    getStyle: () => ({ layers: [] }),
    getLayer: () => undefined,
    getSource: () => source,
    setLayoutProperty: record("setLayoutProperty"),
    setPaintProperty: record("setPaintProperty"),
    setLayerZoomRange: record("setLayerZoomRange"),
    moveLayer: record("moveLayer"),
    removeLayer: record("removeLayer"),
    removeSource: record("removeSource"),
    addLayer: record("addLayer"),
    addSource: record("addSource"),
  };
  return { map, calls };
}

function makeSource(tiles: string[]): FakeSource {
  return {
    tiles,
    setTilesCalls: [],
    setTiles(next: string[]) {
      this.setTilesCalls.push(next);
      this.tiles = next;
    },
  };
}

function vectorTileLayer(tiles: string[]): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "GeoLens dataset",
    type: "vector-tiles",
    source: {
      type: "vector",
      tiles,
      sourceLayer: "data.buildings",
      sourceLayers: ["data.buildings"],
      minzoom: 0,
      maxzoom: 22,
    },
    visible: true,
    opacity: 1,
    style: {},
    metadata: { sourceLayers: ["data.buildings"] },
  } as unknown as GeoLibreLayer;
}

const SIGNED_A = "https://geolens.example/api/tiles/data.b/{z}/{x}/{y}.pbf?sig=aaa&exp=1";
const SIGNED_B = "https://geolens.example/api/tiles/data.b/{z}/{x}/{y}.pbf?sig=bbb&exp=2";

describe("syncVectorTileLayer — endpoint changes", () => {
  it("pushes a new tile template into the existing source", () => {
    const source = makeSource([SIGNED_A]);
    const { map, calls } = makeMapStub(source);
    syncLayer(map as never, vectorTileLayer([SIGNED_B]));
    assert.deepEqual(source.setTilesCalls, [[SIGNED_B]]);
    // The source is updated in place, not torn down and rebuilt.
    assert.equal(
      calls.some((c) => c.method === "addSource" || c.method === "removeSource"),
      false,
    );
  });

  it("does not reload the source when the template is unchanged", () => {
    const source = makeSource([SIGNED_A]);
    const { map } = makeMapStub(source);
    syncLayer(map as never, vectorTileLayer([SIGNED_A]));
    assert.deepEqual(source.setTilesCalls, []);
  });

  it("still creates the source the first time", () => {
    const { map, calls } = makeMapStub(undefined);
    syncLayer(map as never, vectorTileLayer([SIGNED_A]));
    const added = calls.find((c) => c.method === "addSource");
    assert.ok(added);
    assert.deepEqual((added.args[1] as { tiles: string[] }).tiles, [SIGNED_A]);
  });
});
