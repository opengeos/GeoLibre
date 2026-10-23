import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  buildGeoLibreQueryStyle,
  geoLibreStyleSourceName,
} from "../packages/map/src/query-param-style";
import { applyMapboxStyleImport, parseMapboxStyle } from "../packages/map/src/mapbox-style-import";

const data = {
  type: "FeatureCollection" as const,
  features: [
    {
      type: "Feature" as const,
      properties: {},
      geometry: { type: "Point" as const, coordinates: [0, 0] },
    },
  ],
};

function layer(sourcePath?: string): GeoLibreLayer {
  return {
    id: "places-id",
    name: "Places display name",
    type: "geojson",
    source: { type: "geojson" },
    sourcePath,
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE, fillColor: "#123456" },
    metadata: {},
    geojson: data,
  };
}

describe("GeoLibre URL style export", () => {
  it("derives the source from a ZIP member filename", () => {
    assert.equal(
      geoLibreStyleSourceName(layer("https://example.com/export.zip#folder/parks.geojson")),
      "parks",
    );
  });

  it("decodes a percent-encoded ZIP member path before taking the stem", () => {
    assert.equal(
      geoLibreStyleSourceName(layer("https://example.com/export.zip#folder%2Fparks.geojson")),
      "parks",
    );
  });

  it("ignores an ordinary URL hash rather than reading it as the filename", () => {
    assert.equal(geoLibreStyleSourceName(layer("https://example.com/data.geojson#view")), "data");
  });

  it("falls back to the layer name for an in-memory layer", () => {
    assert.equal(geoLibreStyleSourceName(layer()), "Places display name");
  });

  it("emits source-matched render layers without embedding feature data", () => {
    const result = buildGeoLibreQueryStyle(layer("https://example.com/data/places.geojson"), data);
    assert.deepEqual(Object.keys(result.style.sources), ["places"]);
    assert.deepEqual((result.style.sources.places as { data: unknown }).data, {
      type: "FeatureCollection",
      features: [],
    });
    assert.ok(result.style.layers.length > 0);
    assert.ok(
      result.style.layers.every(
        (styleLayer) => !("source" in styleLayer) || styleLayer.source === "places",
      ),
    );
  });

  it("round-trips through the existing style importer", () => {
    const exported = buildGeoLibreQueryStyle(
      layer("https://example.com/data/places.geojson"),
      data,
    );
    const parsed = parseMapboxStyle(exported.style);
    assert.ok(parsed.matchedLayerCount > 0);
    const imported = applyMapboxStyleImport(DEFAULT_LAYER_STYLE, parsed);
    assert.equal(imported.fillColor, "#123456");
  });
});
