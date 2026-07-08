import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  geojsonHasZCoordinates,
  transformGeojsonElevation,
} from "../packages/core/src/index";
import {
  buildElevation3dLayer,
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
    assert.equal(
      geojsonHasZCoordinates({ type: "Point", coordinates: [1, 2, 3] }),
      true,
    );
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
    assert.equal(
      geojsonHasZCoordinates(track([[6.86, 45.83, Number.NaN]])),
      false,
    );
    assert.equal(geojsonHasZCoordinates(null), false);
    assert.equal(
      geojsonHasZCoordinates({ type: "FeatureCollection", features: [] }),
      false,
    );
  });
});

describe("transformGeojsonElevation", () => {
  it("returns the input unchanged for the identity transform", () => {
    const data = track([[6.86, 45.83, 1000]]);
    assert.equal(transformGeojsonElevation(data, 1, 0), data);
  });

  it("applies vertical scale and offset without mutating the input", () => {
    const data = track([
      [6.86, 45.83, 1000],
      [6.87, 45.84],
    ]);
    const result = transformGeojsonElevation(data, 2, 50);
    const coordinates = (
      result.features[0].geometry as { coordinates: number[][] }
    ).coordinates;
    assert.deepEqual(coordinates[0], [6.86, 45.83, 2050]);
    // A missing Z is treated as 0 so the offset still lifts the vertex.
    assert.deepEqual(coordinates[1], [6.87, 45.84, 50]);
    const original = (
      data.features[0].geometry as { coordinates: number[][] }
    ).coordinates;
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
});

describe("buildElevation3dLayer", () => {
  class FakeGeoJsonLayer {
    props: Record<string, unknown>;

    constructor(props: Record<string, unknown>) {
      this.props = props;
    }
  }

  const fakeDeckGL = {
    layers: { GeoJsonLayer: FakeGeoJsonLayer },
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
    const built = buildElevation3dLayer(
      fakeDeckGL,
      layer,
    ) as unknown as FakeGeoJsonLayer;
    assert.equal(built.props.id, "layer-1");
    assert.equal(built.props.opacity, 0.5);
    assert.equal(built.props.lineBillboard, true);
    assert.equal(built.props.pointBillboard, true);
    assert.equal(built.props.extruded, false);
    assert.deepEqual(built.props.getLineColor, [0, 255, 0, 255]);
    assert.deepEqual(built.props.getFillColor, [255, 0, 0, 128]);
    assert.equal(built.props.getLineWidth, 4);
    assert.equal(built.props.getPointRadius, 9);
    // Identity elevation transform passes the source data straight through.
    assert.equal(built.props.data, layer.geojson);
  });

  it("honors a meter-based stroke width unit", () => {
    const layer = geojsonLayer({
      style: {
        ...DEFAULT_LAYER_STYLE,
        elevation3dEnabled: true,
        strokeWidthUnit: "meters",
      },
    });
    const built = buildElevation3dLayer(
      fakeDeckGL,
      layer,
    ) as unknown as FakeGeoJsonLayer;
    assert.equal(built.props.lineWidthUnits, "meters");
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
    const built = buildElevation3dLayer(
      fakeDeckGL,
      layer,
    ) as unknown as FakeGeoJsonLayer;
    const data = built.props.data as FeatureCollection;
    const coordinates = (
      data.features[0].geometry as { coordinates: number[][] }
    ).coordinates;
    assert.deepEqual(coordinates[0], [6.86, 45.83, 3205]);
    assert.deepEqual(coordinates[1], [6.87, 45.84, 4360]);

    // The rescan is cached per source collection and transform.
    const rebuilt = buildElevation3dLayer(
      fakeDeckGL,
      layer,
    ) as unknown as FakeGeoJsonLayer;
    assert.equal(rebuilt.props.data, data);
  });
});
