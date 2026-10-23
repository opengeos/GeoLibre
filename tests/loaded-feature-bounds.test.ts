import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import type { Feature } from "geojson";
import {
  layerSourceLayerNames,
  loadedVectorTileFeatureBounds,
} from "../packages/map/src/loaded-feature-bounds";
import { summarizeDiagnosticTile } from "../packages/map/src/map-diagnostic";

function vectorTileLayer(overrides: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "vt",
    name: "Buildings",
    type: "vector-tiles",
    visible: true,
    opacity: 1,
    source: {
      type: "vector",
      tiles: ["https://example.com/tiles/{z}/{x}/{y}.pbf"],
      sourceLayer: "data.buildings",
      sourceLayers: ["data.buildings"],
    },
    metadata: { sourceKind: "ogc-vector-tiles" },
    ...overrides,
  } as GeoLibreLayer;
}

function polygon(west: number, south: number, east: number, north: number): Feature {
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ],
    },
  };
}

describe("layerSourceLayerNames", () => {
  it("merges source and metadata source layers without duplicates", () => {
    const layer = vectorTileLayer({
      metadata: { sourceLayers: ["data.buildings", "data.roads", ""] },
    });
    assert.deepEqual(layerSourceLayerNames(layer), ["data.buildings", "data.roads"]);
  });
});

describe("loadedVectorTileFeatureBounds", () => {
  it("returns the extent of the features loaded in every source layer", () => {
    const queried: Array<[string, string | undefined]> = [];
    const map = {
      getSource: (id: string) => (id === "source-vt" ? {} : undefined),
      querySourceFeatures: (id: string, params?: { sourceLayer?: string }) => {
        queried.push([id, params?.sourceLayer]);
        return [polygon(-74.02, 40.7, -74.0, 40.72), polygon(-73.99, 40.75, -73.96, 40.77)];
      },
    };
    const bounds = loadedVectorTileFeatureBounds(map, vectorTileLayer(), ["source-vt", "missing"]);
    assert.deepEqual(bounds, [-74.02, 40.7, -73.96, 40.77]);
    // A source id the map does not hold is skipped, not queried.
    assert.deepEqual(queried, [["source-vt", "data.buildings"]]);
  });

  it("returns null when nothing is loaded or the layer is not a vector tile layer", () => {
    const empty = { getSource: () => ({}), querySourceFeatures: () => [] };
    assert.equal(loadedVectorTileFeatureBounds(empty, vectorTileLayer(), ["s"]), null);
    const loaded = {
      getSource: () => ({}),
      querySourceFeatures: () => [polygon(0, 0, 1, 1)],
    };
    const raster = vectorTileLayer({ type: "raster", source: { type: "raster" } });
    assert.equal(loadedVectorTileFeatureBounds(loaded, raster, ["s"]), null);
    assert.equal(
      loadedVectorTileFeatureBounds({ getSource: () => ({}) }, vectorTileLayer(), ["s"]),
      null,
    );
    assert.equal(loadedVectorTileFeatureBounds(null, vectorTileLayer(), ["s"]), null);
  });

  it("treats a throwing query as nothing loaded", () => {
    const map = {
      getSource: () => ({}),
      querySourceFeatures: () => {
        throw new Error("source removed");
      },
    };
    assert.equal(loadedVectorTileFeatureBounds(map, vectorTileLayer(), ["s"]), null);
  });
});

describe("summarizeDiagnosticTile", () => {
  it("keeps only the tile coordinates and state, not its worker actor", () => {
    const window = { location: { href: "https://web.geolibre.app/" } } as Record<string, unknown>;
    window.self = window;
    const tile = {
      uid: 226,
      state: "errored",
      tileID: { overscaledZ: 4, wrap: 0, canonical: { z: 4, x: 6, y: 5, key: "k" }, key: "k" },
      actor: { target: {}, globalScope: window },
      buckets: {},
    };
    const summary = summarizeDiagnosticTile(tile);
    assert.deepEqual(summary, { z: 4, x: 6, y: 5, overscaledZ: 4, wrap: 0, state: "errored" });
    assert.ok(!JSON.stringify(summary).includes("geolibre.app"));
  });

  it("returns undefined for an event without a tile", () => {
    assert.equal(summarizeDiagnosticTile(undefined), undefined);
    assert.equal(summarizeDiagnosticTile("tile"), undefined);
  });
});
