import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  isTileVectorLayer,
  resolveTileQueryTargets,
  sampleTileFeatureRecords,
  type TileSampleMap,
  type TileSampleStyle,
} from "../packages/plugins/src/plugins/time-slider-tile-sample";

function layer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "vt",
    name: "vt",
    type: "vector-tiles",
    source: { type: "vector", tiles: ["https://example.com/{z}/{x}/{y}.pbf"] },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...patch,
  };
}

/** A style with one vector source and one raster source. */
function style(layers: Record<string, unknown>[]): TileSampleStyle {
  return {
    sources: {
      "source-vt": { type: "vector" },
      "pm-source": { type: "vector" },
      "raster-source": { type: "raster" },
    },
    layers,
  };
}

function fakeMap(
  styleValue: TileSampleStyle | undefined,
  features: Record<string, Array<{ id?: unknown; properties?: Record<string, unknown> | null }>>,
): TileSampleMap {
  return {
    getStyle: () => styleValue,
    querySourceFeatures: (sourceId, parameters) =>
      features[`${sourceId} ${parameters?.sourceLayer ?? ""}`] ?? [],
  };
}

describe("isTileVectorLayer", () => {
  it("accepts the three tile-backed vector layer types", () => {
    assert.equal(isTileVectorLayer(layer({ type: "vector-tiles" })), true);
    assert.equal(isTileVectorLayer(layer({ type: "pmtiles" })), true);
    assert.equal(isTileVectorLayer(layer({ type: "mbtiles" })), true);
  });

  it("rejects layers that are not tile-backed vectors", () => {
    assert.equal(isTileVectorLayer(layer({ type: "geojson" })), false);
    assert.equal(isTileVectorLayer(layer({ type: "raster" })), false);
    assert.equal(isTileVectorLayer(undefined), false);
  });

  it("rejects a raster PMTiles archive, which carries no features", () => {
    assert.equal(
      isTileVectorLayer(layer({ type: "pmtiles", metadata: { tileType: "raster" } })),
      false,
    );
    assert.equal(isTileVectorLayer(layer({ type: "pmtiles", source: { type: "raster" } })), false);
  });
});

describe("resolveTileQueryTargets", () => {
  it("finds the source-layers of a core vector-tile layer by its source", () => {
    const targets = resolveTileQueryTargets(
      layer({ metadata: { sourceId: "source-vt" } }),
      style([
        {
          id: "layer-vt-vector",
          source: "source-vt",
          "source-layer": "buildings",
        },
        {
          id: "layer-vt-vector-line",
          source: "source-vt",
          "source-layer": "buildings",
        },
        {
          id: "layer-vt-vector-roads",
          source: "source-vt",
          "source-layer": "roads",
        },
        { id: "basemap", source: "other", "source-layer": "water" },
      ]),
    );

    // Distinct pairs only: three style layers over two source-layers.
    assert.deepEqual(targets, [
      { sourceId: "source-vt", sourceLayer: "buildings" },
      { sourceId: "source-vt", sourceLayer: "roads" },
    ]);
  });

  it("finds a saved GeoLens layer that records no source or native layer ids", () => {
    // The shape a vector-tiles layer restored from a .geolibre.json has: the
    // core sync path builds `source-<id>` and `layer-<id>-vector-*` itself, and
    // records neither back onto the layer. Matching on recorded sources alone
    // finds nothing here, so the layer-id prefix is what resolves it.
    const targets = resolveTileQueryTargets(
      layer({
        id: "ce178973",
        metadata: {
          sourceKind: "geolens-vector-tiles",
          geolensDatasetId: "4a0bd0db",
        },
      }),
      {
        sources: { "source-ce178973": { type: "vector" } },
        layers: [
          {
            id: "layer-ce178973-vector-extrusion",
            source: "source-ce178973",
            "source-layer": "data.manhattan_building_heights",
          },
        ],
      },
    );

    assert.deepEqual(targets, [
      {
        sourceId: "source-ce178973",
        sourceLayer: "data.manhattan_building_heights",
      },
    ]);
  });

  it("finds a control-owned PMTiles layer by its native layer ids", () => {
    const targets = resolveTileQueryTargets(
      layer({
        type: "pmtiles",
        metadata: { nativeLayerIds: ["pm-fill"], sourceId: "pm-source" },
      }),
      style([
        { id: "pm-fill", source: "pm-source", "source-layer": "places" },
        // Same source, different store layer — must not be picked up.
        { id: "other-fill", source: "pm-source", "source-layer": "roads" },
      ]),
    );

    assert.deepEqual(targets, [{ sourceId: "pm-source", sourceLayer: "places" }]);
  });

  it("ignores style layers drawn from a raster source", () => {
    const targets = resolveTileQueryTargets(
      layer({ metadata: { sourceId: "raster-source" } }),
      style([{ id: "layer-vt-raster", source: "raster-source" }]),
    );

    assert.deepEqual(targets, []);
  });

  it("returns nothing when the style has no layers yet", () => {
    assert.deepEqual(resolveTileQueryTargets(layer(), undefined), []);
    assert.deepEqual(resolveTileQueryTargets(layer(), { layers: undefined }), []);
  });
});

describe("sampleTileFeatureRecords", () => {
  const styleValue = style([
    { id: "layer-vt-vector", source: "source-vt", "source-layer": "buildings" },
  ]);
  const target = "source-vt buildings";

  it("reads the properties of the loaded tile features", () => {
    const map = fakeMap(styleValue, {
      [target]: [
        { id: 1, properties: { year: 1958 } },
        { id: 2, properties: { year: 1971 } },
      ],
    });

    assert.deepEqual(
      sampleTileFeatureRecords(map, layer({ metadata: { sourceId: "source-vt" } })),
      [{ year: 1958 }, { year: 1971 }],
    );
  });

  it("counts a feature spanning several tiles once", () => {
    // querySourceFeatures returns one clipped copy per tile a feature spans.
    // Counting each copy would bias detection toward the widest features.
    const map = fakeMap(styleValue, {
      [target]: [
        { id: 7, properties: { year: 1958 } },
        { id: 7, properties: { year: 1958 } },
        { id: 8, properties: { year: 1971 } },
      ],
    });

    assert.deepEqual(
      sampleTileFeatureRecords(map, layer({ metadata: { sourceId: "source-vt" } })),
      [{ year: 1958 }, { year: 1971 }],
    );
  });

  it("keeps every copy of a feature that has no id to dedupe on", () => {
    const map = fakeMap(styleValue, {
      [target]: [{ properties: { year: 1958 } }, { properties: { year: 1958 } }],
    });

    assert.equal(
      sampleTileFeatureRecords(map, layer({ metadata: { sourceId: "source-vt" } })).length,
      2,
    );
  });

  it("stops at the sample limit", () => {
    const many = Array.from({ length: 50 }, (_unused, index) => ({
      id: index,
      properties: { year: 1900 + index },
    }));
    const map = fakeMap(styleValue, { [target]: many });

    assert.equal(
      sampleTileFeatureRecords(map, layer({ metadata: { sourceId: "source-vt" } }), 10).length,
      10,
    );
  });

  it("returns nothing for a non-tile layer, a missing map, or an unready style", () => {
    const map = fakeMap(styleValue, {
      [target]: [{ id: 1, properties: { year: 1958 } }],
    });

    assert.deepEqual(sampleTileFeatureRecords(map, layer({ type: "geojson" })), []);
    assert.deepEqual(sampleTileFeatureRecords(undefined, layer()), []);
    assert.deepEqual(
      sampleTileFeatureRecords(
        {
          getStyle: () => {
            throw new Error("style not ready");
          },
          querySourceFeatures: () => [],
        },
        layer({ metadata: { sourceId: "source-vt" } }),
      ),
      [],
    );
  });

  it("survives a source that is not on the map yet", () => {
    const map: TileSampleMap = {
      getStyle: () => styleValue,
      querySourceFeatures: () => {
        throw new Error("source not added");
      },
    };

    assert.deepEqual(
      sampleTileFeatureRecords(map, layer({ metadata: { sourceId: "source-vt" } })),
      [],
    );
  });
});
