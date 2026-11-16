import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import { dataUrlFitBounds } from "../apps/geolibre-desktop/src/lib/data-url";
import { getLayerBounds } from "../packages/map/src/geojson-loader";

/** A COG-like layer whose extent is stored once its header has been read. */
function raster(id: string, bounds?: [number, number, number, number]): GeoLibreLayer {
  return {
    id,
    type: "cog",
    source: {},
    metadata: bounds ? { bounds } : {},
  } as unknown as GeoLibreLayer;
}

describe("dataUrlFitBounds", () => {
  it("waits while a raster has not reported its extent yet", () => {
    const layers = [raster("west", [-84, 35.9, -83.93, 35.95]), raster("east")];
    assert.equal(dataUrlFitBounds(layers, ["west", "east"], true, getLayerBounds), "pending");
  });

  it("frames the union of every raster once all extents are known", () => {
    const layers = [
      raster("west", [-84, 35.9, -83.93, 35.95]),
      raster("east", [-83.93, 35.91, -83.9, 35.96]),
    ];
    assert.deepEqual(
      dataUrlFitBounds(layers, ["west", "east"], true, getLayerBounds),
      [-84, 35.9, -83.9, 35.96],
    );
  });

  it("frames what is known when told not to wait, and ignores unlisted layers", () => {
    const layers = [
      raster("west", [-84, 35.9, -83.93, 35.95]),
      raster("east"),
      raster("other", [0, 0, 1, 1]),
    ];
    assert.deepEqual(
      dataUrlFitBounds(layers, ["west", "east"], false, getLayerBounds),
      [-84, 35.9, -83.93, 35.95],
    );
    assert.equal(dataUrlFitBounds(layers, ["east"], false, getLayerBounds), null);
  });

  it("does not wait on a layer that never reports an extent", () => {
    const vector = {
      id: "v",
      type: "pmtiles",
      source: {},
      metadata: {},
    } as unknown as GeoLibreLayer;
    const layers = [raster("west", [-84, 35.9, -83.93, 35.95]), vector];
    assert.deepEqual(
      dataUrlFitBounds(layers, ["west", "v"], true, getLayerBounds),
      [-84, 35.9, -83.93, 35.95],
    );
  });

  it("does not wait on a COG that failed to load", () => {
    const failed = {
      id: "f",
      type: "cog",
      source: {},
      metadata: { error: "HTTP 404" },
    } as unknown as GeoLibreLayer;
    const layers = [raster("west", [-84, 35.9, -83.93, 35.95]), failed];
    assert.deepEqual(
      dataUrlFitBounds(layers, ["west", "f"], true, getLayerBounds),
      [-84, 35.9, -83.93, 35.95],
    );
  });
});
