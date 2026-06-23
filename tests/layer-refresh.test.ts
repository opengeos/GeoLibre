import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  isRefreshableLayer,
  isVectorControlRefreshLayer,
} from "../apps/geolibre-desktop/src/lib/layer-refresh";

function makeLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Test Layer",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: DEFAULT_LAYER_STYLE,
    metadata: {},
    ...patch,
  };
}

describe("isVectorControlRefreshLayer / isRefreshableLayer", () => {
  it("treats a vector-control URL layer as refreshable", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson", url: "https://x.com/a.geojson" },
      metadata: {
        sourceKind: "maplibre-gl-vector",
        externalNativeLayer: true,
      },
    });

    assert.equal(isVectorControlRefreshLayer(layer), true);
    assert.equal(isRefreshableLayer(layer), true);
  });

  it("does not treat a file-backed vector-control layer (no url) as a vector-control refresh layer", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson" },
      metadata: {
        sourceKind: "maplibre-gl-vector",
        externalNativeLayer: true,
      },
    });

    assert.equal(isVectorControlRefreshLayer(layer), false);
    assert.equal(isRefreshableLayer(layer), false);
  });

  it("does not treat a vector-control layer without the externalNativeLayer flag as refreshable", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson", url: "https://x.com/a.geojson" },
      metadata: {
        sourceKind: "maplibre-gl-vector",
        // externalNativeLayer intentionally absent — exercises the three-way AND
      },
    });

    assert.equal(isVectorControlRefreshLayer(layer), false);
    assert.equal(isRefreshableLayer(layer), false);
  });

  it("treats a vector-control layer whose URL comes from sourcePath as refreshable", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson" },
      sourcePath: "https://x.com/a.geojson",
      metadata: {
        sourceKind: "maplibre-gl-vector",
        externalNativeLayer: true,
      },
    });

    assert.equal(isVectorControlRefreshLayer(layer), true);
    assert.equal(isRefreshableLayer(layer), true);
  });

  it("treats a tiles-mode (vector-tiles) vector-control layer as refreshable", () => {
    const layer = makeLayer({
      type: "vector-tiles",
      source: { type: "vector", url: "https://x.com/a.pmtiles" },
      metadata: {
        sourceKind: "maplibre-gl-vector",
        externalNativeLayer: true,
      },
    });

    assert.equal(isVectorControlRefreshLayer(layer), true);
    assert.equal(isRefreshableLayer(layer), true);
  });

  it("does not treat a plain store layer as a vector-control refresh layer", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson", url: "https://x.com/a.geojson" },
      metadata: { sourceKind: "geojson-url" },
    });

    assert.equal(isVectorControlRefreshLayer(layer), false);
  });

  it("still treats a WFS layer as refreshable (refactor regression guard)", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson", url: "https://x.com/wfs?service=WFS" },
      metadata: { sourceKind: "wfs-getfeature" },
    });

    assert.equal(isRefreshableLayer(layer), true);
  });

  it("legacy untagged geojson-url layer is refreshable via the store path", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson", url: "https://example.com/data.geojson" },
      metadata: {},
    });

    assert.equal(isRefreshableLayer(layer), true);
    assert.equal(isVectorControlRefreshLayer(layer), false);
  });

  it("treats a URL-backed GeoRSS layer as refreshable", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson", url: "https://example.com/feed.atom" },
      sourcePath: "https://example.com/feed.atom",
      metadata: { sourceKind: "georss" },
    });

    assert.equal(isRefreshableLayer(layer), true);
  });

  it("does not refresh a GeoRSS layer loaded from a local file", () => {
    const layer = makeLayer({
      type: "geojson",
      source: { type: "geojson", url: "/home/user/feed.xml" },
      sourcePath: "/home/user/feed.xml",
      metadata: { sourceKind: "georss" },
    });

    assert.equal(isRefreshableLayer(layer), false);
  });
});
