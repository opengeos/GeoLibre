import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  geojsonHasZCoordinates,
  transformGeojsonElevation,
} from "../packages/core/src/index";
import { syncLayer } from "../packages/map/src/layer-sync";
import {
  buildElevation3dLayers,
  isElevation3dLayer,
} from "../packages/plugins/src/plugins/deckgl-viz/elevation";
import type { GeoLibreDeckGL } from "../packages/plugins/src/types";

function track(coordinates: number[][]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates },
      },
    ],
  };
}

function geojsonLayer(overrides: Partial<GeoLibreLayer>): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Track",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: track([
      [6.86, 45.83, 1035],
      [6.87, 45.84, 1420],
    ]),
    ...overrides,
  } as GeoLibreLayer;
}

// Stateful fake MapLibre map (mirrors point-renderer-sync.test.ts): tracks
// sources and layers across sync passes so the tests can assert what the
// elevation3d branch removes and what a toggle back to 2D re-adds.
function makeMap() {
  const sources = new Map<string, Record<string, unknown>>();
  const layers = new Map<string, Record<string, unknown>>();
  const map = {
    getSource: (id: string) =>
      sources.has(id) ? { type: "geojson", setData: () => {} } : undefined,
    addSource: (id: string, spec: Record<string, unknown>) => {
      sources.set(id, spec);
    },
    removeSource: (id: string) => {
      sources.delete(id);
    },
    getLayer: (id: string) => (layers.has(id) ? { id, ...layers.get(id) } : undefined),
    addLayer: (spec: Record<string, unknown>) => {
      layers.set(spec.id as string, spec);
    },
    removeLayer: (id: string) => {
      layers.delete(id);
    },
    getFilter: (id: string) => layers.get(id)?.filter,
    setFilter: () => {},
    setPaintProperty: () => {},
    setLayoutProperty: () => {},
    setLayerZoomRange: () => {},
    moveLayer: () => {},
    getStyle: () => ({
      layers: [...layers.values()],
      sources: Object.fromEntries(sources),
    }),
    once: () => {},
  };
  return { map, sources, layers };
}

describe("syncLayer with elevation3dEnabled", () => {
  it("drops the MapLibre rendering for Z-bearing data and restores it when toggled off", () => {
    const { map, sources, layers } = makeMap();
    const layer = geojsonLayer({});

    // Baseline 2D render creates a source and at least one style layer.
    syncLayer(map as never, layer);
    assert.equal(sources.size, 1);
    assert.ok(layers.size > 0);

    // Enabling the 3D Z-value mode hands the layer to the deck.gl overlay,
    // so every MapLibre source/layer for it must be removed.
    syncLayer(
      map as never,
      geojsonLayer({
        style: { ...DEFAULT_LAYER_STYLE, elevation3dEnabled: true },
      }),
    );
    assert.equal(sources.size, 0);
    assert.equal(layers.size, 0);

    // Toggling back to 2D re-adds the MapLibre rendering.
    syncLayer(map as never, layer);
    assert.equal(sources.size, 1);
    assert.ok(layers.size > 0);
  });

  it("keeps the 2D render when the flag is set but the data has no Z values", () => {
    const { map, sources, layers } = makeMap();
    syncLayer(
      map as never,
      geojsonLayer({
        style: { ...DEFAULT_LAYER_STYLE, elevation3dEnabled: true },
        geojson: track([
          [6.86, 45.83],
          [6.87, 45.84],
        ]),
      }),
    );
    assert.equal(sources.size, 1);
    assert.ok(layers.size > 0);
  });
});

describe("geojsonHasZCoordinates", () => {
  it("detects Z on LineString coordinates", () => {
    assert.equal(
      geojsonHasZCoordinates(
        track([
          [6.86, 45.83, 1035],
          [6.87, 45.84, 1420],
        ]),
      ),
      true,
    );
  });

  it("detects Z on a bare Point geometry and inside GeometryCollections", () => {
    assert.equal(geojsonHasZCoordinates({ type: "Point", coordinates: [1, 2, 3] }), true);
    assert.equal(
      geojsonHasZCoordinates({
        type: "GeometryCollection",
        geometries: [
          { type: "Point", coordinates: [1, 2] },
          {
            type: "MultiPolygon",
            coordinates: [
              [
                [
                  [0, 0, 5],
                  [1, 0, 5],
                  [1, 1, 5],
                  [0, 0, 5],
                ],
              ],
            ],
          },
        ],
      }),
      true,
    );
  });

  it("returns false for 2D data, all-zero Z, non-finite Z, and empty input", () => {
    assert.equal(
      geojsonHasZCoordinates(
        track([
          [6.86, 45.83],
          [6.87, 45.84],
        ]),
      ),
      false,
    );
    assert.equal(
      geojsonHasZCoordinates(
        track([
          [6.86, 45.83, 0],
          [6.87, 45.84, 0],
        ]),
      ),
      false,
    );
    assert.equal(geojsonHasZCoordinates(track([[6.86, 45.83, Number.NaN]])), false);
    assert.equal(geojsonHasZCoordinates(null), false);
    assert.equal(geojsonHasZCoordinates({ type: "FeatureCollection", features: [] }), false);
  });
});

describe("transformGeojsonElevation", () => {
  it("sanitizes non-finite Z even for the identity transform", () => {
    const data = track([
      [6.86, 45.83, 1000],
      [6.87, 45.84, Number.NaN],
    ]);
    const result = transformGeojsonElevation(data, 1, 0);
    const coordinates = (result.features[0].geometry as { coordinates: number[][] }).coordinates;
    assert.deepEqual(coordinates[0], [6.86, 45.83, 1000]);
    assert.deepEqual(coordinates[1], [6.87, 45.84, 0]);
  });

  it("applies vertical scale and offset without mutating the input", () => {
    const data = track([
      [6.86, 45.83, 1000],
      [6.87, 45.84],
    ]);
    const result = transformGeojsonElevation(data, 2, 50);
    const coordinates = (result.features[0].geometry as { coordinates: number[][] }).coordinates;
    assert.deepEqual(coordinates[0], [6.86, 45.83, 2050]);
    // A missing Z is treated as 0 so the offset still lifts the vertex.
    assert.deepEqual(coordinates[1], [6.87, 45.84, 50]);
    const original = (data.features[0].geometry as { coordinates: number[][] }).coordinates;
    assert.deepEqual(original[0], [6.86, 45.83, 1000]);
  });
});

describe("isElevation3dLayer", () => {
  it("matches geojson layers with the style flag enabled", () => {
    const layer = geojsonLayer({
      style: { ...DEFAULT_LAYER_STYLE, elevation3dEnabled: true },
    });
    assert.equal(isElevation3dLayer(layer), true);
  });

  it("rejects layers without the flag, without data, or of other types", () => {
    assert.equal(isElevation3dLayer(geojsonLayer({})), false);
    assert.equal(
      isElevation3dLayer(
        geojsonLayer({
          style: { ...DEFAULT_LAYER_STYLE, elevation3dEnabled: true },
          geojson: undefined,
        }),
      ),
      false,
    );
    assert.equal(
      isElevation3dLayer(
        geojsonLayer({
          type: "raster",
          style: { ...DEFAULT_LAYER_STYLE, elevation3dEnabled: true },
        }),
      ),
      false,
    );
  });

  it("treats the flag as inert when the data carries no Z values", () => {
    assert.equal(
      isElevation3dLayer(
        geojsonLayer({
          style: { ...DEFAULT_LAYER_STYLE, elevation3dEnabled: true },
          geojson: track([
            [6.86, 45.83],
            [6.87, 45.84],
          ]),
        }),
      ),
      false,
    );
  });
});

describe("buildElevation3dLayers", () => {
  class FakeGeoJsonLayer {
    props: Record<string, unknown>;

    constructor(props: Record<string, unknown>) {
      this.props = props;
    }
  }
  class FakeIconLayer {
    props: Record<string, unknown>;

    constructor(props: Record<string, unknown>) {
      this.props = props;
    }
  }

  const fakeDeckGL = {
    layers: { GeoJsonLayer: FakeGeoJsonLayer, IconLayer: FakeIconLayer },
  } as unknown as GeoLibreDeckGL;

  it("maps the layer style onto billboarded deck.gl props", () => {
    const layer = geojsonLayer({
      opacity: 0.5,
      style: {
        ...DEFAULT_LAYER_STYLE,
        elevation3dEnabled: true,
        fillColor: "#ff0000",
        strokeColor: "#00ff00",
        strokeWidth: 4,
        circleRadius: 9,
        fillOpacity: 0.5,
      },
    });
    const [built] = buildElevation3dLayers(fakeDeckGL, layer) as unknown as FakeGeoJsonLayer[];
    assert.equal(built.props.id, "layer-1");
    assert.equal(built.props.opacity, 0.5);
    assert.equal(built.props.lineBillboard, true);
    assert.equal(built.props.extruded, false);
    assert.deepEqual(built.props.getLineColor, [0, 255, 0, 255]);
    assert.deepEqual(built.props.getFillColor, [255, 0, 0, 128]);
    assert.equal(built.props.getLineWidth, 4);
    // The identity transform still sanitizes into a copy; the copy is cached
    // so subsequent rebuilds reuse it.
    const coordinates = (
      (built.props.data as FeatureCollection).features[0].geometry as {
        coordinates: number[][];
      }
    ).coordinates;
    assert.deepEqual(coordinates[0], [6.86, 45.83, 1035]);
    const [rebuilt] = buildElevation3dLayers(fakeDeckGL, layer) as unknown as FakeGeoJsonLayer[];
    assert.equal(rebuilt.props.data, built.props.data);
  });

  it("renders the transparent color sentinel invisible", () => {
    const layer = geojsonLayer({
      style: {
        ...DEFAULT_LAYER_STYLE,
        elevation3dEnabled: true,
        fillColor: "transparent",
        strokeColor: "transparent",
      },
    });
    const [built] = buildElevation3dLayers(fakeDeckGL, layer) as unknown as FakeGeoJsonLayer[];
    assert.deepEqual(built.props.getFillColor, [0, 0, 0, 0]);
    assert.deepEqual(built.props.getLineColor, [0, 0, 0, 0]);
  });

  it("honors a meter-based stroke width unit", () => {
    const layer = geojsonLayer({
      style: {
        ...DEFAULT_LAYER_STYLE,
        elevation3dEnabled: true,
        strokeWidthUnit: "meters",
      },
    });
    const [built] = buildElevation3dLayers(fakeDeckGL, layer) as unknown as FakeGeoJsonLayer[];
    assert.equal(built.props.lineWidthUnits, "meters");
  });

  it("skips GeoJsonLayer entirely for point-only data", () => {
    const layer = geojsonLayer({
      style: {
        ...DEFAULT_LAYER_STYLE,
        elevation3dEnabled: true,
        strokeWidthUnit: "meters",
      },
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "Point", coordinates: [6.86, 45.83, 1035] },
          },
        ],
      },
    });
    const [built] = buildElevation3dLayers(fakeDeckGL, layer) as unknown as FakeIconLayer[];
    assert.equal(built.props.id, "layer-1-points");
    assert.equal(built.props.sizeUnits, "pixels");
    assert.equal(built.props.billboard, true);
  });

  it("renders high-altitude points with a solid IconLayer dot instead of GeoJsonLayer points", () => {
    const layer = geojsonLayer({
      opacity: 0.75,
      style: {
        ...DEFAULT_LAYER_STYLE,
        elevation3dEnabled: true,
        fillColor: "#336699",
        fillOpacity: 0.5,
        circleRadius: 8,
      },
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "MultiPoint",
              coordinates: [
                [6.86, 45.83, 3150],
                [6.87, 45.84, 3627],
              ],
            },
          },
        ],
      },
    });

    const built = buildElevation3dLayers(fakeDeckGL, layer) as unknown as [FakeIconLayer];
    assert.equal(built.length, 1);
    assert.equal(built[0].props.id, "layer-1-points");
    assert.equal(built[0].props.getSize, 16);
    assert.deepEqual(built[0].props.getColor, [51, 102, 153, 128]);
    assert.equal(built[0].props.opacity, 0.75);
    const data = built[0].props.data as Array<{ position: number[] }>;
    assert.deepEqual(
      data.map((datum) => datum.position),
      [
        [6.86, 45.83, 3150],
        [6.87, 45.84, 3627],
      ],
    );
  });

  it("splits mixed geometry so GeoJsonLayer never owns the point sublayer", () => {
    const layer = geojsonLayer({
      style: { ...DEFAULT_LAYER_STYLE, elevation3dEnabled: true },
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: { type: "Point", coordinates: [6.86, 45.83, 3150] },
          },
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: [
                [6.86, 45.83, 3150],
                [6.87, 45.84, 3627],
              ],
            },
          },
        ],
      },
    });

    const built = buildElevation3dLayers(fakeDeckGL, layer) as unknown as [
      FakeGeoJsonLayer,
      FakeIconLayer,
    ];
    assert.equal(built.length, 2);
    assert.equal(built[0].props.id, "layer-1");
    assert.equal(
      (
        (built[0].props.data as FeatureCollection).features[0].geometry as {
          type: string;
        }
      ).type,
      "LineString",
    );
    assert.equal(built[1].props.id, "layer-1-points");
  });

  it("rescales Z values when exaggeration or offset are set", () => {
    const layer = geojsonLayer({
      style: {
        ...DEFAULT_LAYER_STYLE,
        elevation3dEnabled: true,
        elevation3dVerticalScale: 3,
        elevation3dOffset: 100,
      },
    });
    const [built] = buildElevation3dLayers(fakeDeckGL, layer) as unknown as FakeGeoJsonLayer[];
    const data = built.props.data as FeatureCollection;
    const coordinates = (data.features[0].geometry as { coordinates: number[][] }).coordinates;
    assert.deepEqual(coordinates[0], [6.86, 45.83, 3205]);
    assert.deepEqual(coordinates[1], [6.87, 45.84, 4360]);

    // The rescan is cached per source collection and transform.
    const [rebuilt] = buildElevation3dLayers(fakeDeckGL, layer) as unknown as FakeGeoJsonLayer[];
    assert.equal(rebuilt.props.data, data);
  });
});
