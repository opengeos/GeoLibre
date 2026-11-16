import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import {
  antimeridianAwareBbox,
  shortestLongitudeExtent,
  toRfc7946Bbox,
  unionLonLatExtents,
  type GeoLibreLayer,
} from "@geolibre/core";
import { getLayerBounds } from "../packages/map/src/geojson-loader";

// GeoLibre#3469: zoom to layer on a layer with parts on both sides of the
// antimeridian framed the whole globe, because the extent was a plain min/max.

/** A small square polygon ring west-south corner at `[lon, lat]`. */
function square(lon: number, lat: number, size = 1): number[][][] {
  return [
    [
      [lon, lat],
      [lon + size, lat],
      [lon + size, lat + size],
      [lon, lat + size],
      [lon, lat],
    ],
  ];
}

/** A US-states-like layer: the contiguous US plus Alaska split at 180. */
const US_LIKE: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Maine" },
      geometry: { type: "Polygon", coordinates: square(-70, 44) },
    },
    {
      type: "Feature",
      properties: { name: "Alaska" },
      geometry: {
        type: "MultiPolygon",
        coordinates: [square(-150, 60, 10), square(172, 52, 7.999), square(-180, 51, 1)],
      },
    },
  ],
};

function layerWith(geojson: FeatureCollection): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Test",
    type: "geojson",
    visible: true,
    opacity: 1,
    source: { type: "geojson" },
    metadata: {},
    geojson,
  } as unknown as GeoLibreLayer;
}

describe("shortestLongitudeExtent", () => {
  it("keeps the plain extent when it is already the shortest", () => {
    assert.deepEqual(
      shortestLongitudeExtent([
        [-10, 5],
        [20, 30],
      ]),
      [-10, 30],
    );
    // Wider than a hemisphere but with its widest gap across the antimeridian.
    assert.deepEqual(
      shortestLongitudeExtent([
        [-120, -100],
        [40, 60],
      ]),
      [-120, 60],
    );
  });

  it("takes the short way across the antimeridian", () => {
    assert.deepEqual(
      shortestLongitudeExtent([
        [179, 179],
        [-179, -179],
      ]),
      [179, 181],
    );
    assert.deepEqual(
      shortestLongitudeExtent([
        [170, 180],
        [-180, -160],
        [-100, -90],
      ]),
      [170, 270],
    );
  });

  it("reads unwrapped and RFC 7946 crossing intervals", () => {
    assert.deepEqual(shortestLongitudeExtent([[170, 200]]), [170, 200]);
    assert.deepEqual(shortestLongitudeExtent([[170, -160]]), [170, 200]);
  });

  it("covers the whole circle when nothing is left out", () => {
    assert.deepEqual(shortestLongitudeExtent([[-180, 180]]), [-180, 180]);
    assert.deepEqual(shortestLongitudeExtent([[0, 400]]), [-180, 180]);
  });

  it("returns null without a finite interval", () => {
    assert.equal(shortestLongitudeExtent([]), null);
    assert.equal(shortestLongitudeExtent([[Number.NaN, 1]]), null);
  });
});

describe("antimeridianAwareBbox", () => {
  it("frames a US-like layer across the antimeridian instead of the globe", () => {
    assert.deepEqual(antimeridianAwareBbox(US_LIKE), [172, 44, 291, 70]);
  });

  it("matches the plain bbox for data away from the antimeridian", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [-78, 35] } },
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [2, 48],
              [13, 52],
            ],
          },
        },
      ],
    };
    assert.deepEqual(antimeridianAwareBbox(fc), [-78, 35, 13, 52]);
  });

  it("unwraps a collection's own RFC 7946 bbox member", () => {
    const fc = { ...US_LIKE, bbox: [172, 44, -69, 70] } as FeatureCollection;
    assert.deepEqual(antimeridianAwareBbox(fc), [172, 44, 291, 70]);
  });

  it("re-measures a conventional bbox member wider than a hemisphere", () => {
    const fc = { ...US_LIKE, bbox: [-180, 44, 179.999, 70] } as FeatureCollection;
    assert.deepEqual(antimeridianAwareBbox(fc), [172, 44, 291, 70]);
    // A narrow one is trusted as is.
    const narrow = { ...US_LIKE, bbox: [-75, 40, -65, 50] } as FeatureCollection;
    assert.deepEqual(antimeridianAwareBbox(narrow), [-75, 40, -65, 50]);
  });

  it("returns null when no feature has coordinates", () => {
    assert.equal(
      antimeridianAwareBbox({
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: null as never }],
      }),
      null,
    );
  });
});

describe("unionLonLatExtents", () => {
  it("combines extents the short way round", () => {
    assert.deepEqual(
      unionLonLatExtents([
        [172, 44, 291, 70],
        [-160, 18, -154, 23],
      ]),
      [172, 18, 291, 70],
    );
  });

  it("matches a plain min/max away from the antimeridian", () => {
    assert.deepEqual(
      unionLonLatExtents([
        [-10, 0, 5, 10],
        [20, -5, 30, 2],
      ]),
      [-10, -5, 30, 10],
    );
  });
});

describe("toRfc7946Bbox", () => {
  it("writes an unwrapped crossing extent with west > east", () => {
    assert.deepEqual(toRfc7946Bbox([172, 44, 291, 70]), [172, 44, -69, 70]);
    assert.deepEqual(toRfc7946Bbox([-10, 0, 10, 5]), [-10, 0, 10, 5]);
    assert.deepEqual(toRfc7946Bbox([-180, -90, 180, 90]), [-180, -90, 180, 90]);
  });
});

describe("getLayerBounds across the antimeridian (#3469)", () => {
  it("frames the layer rather than the whole globe", () => {
    assert.deepEqual(getLayerBounds(layerWith(US_LIKE)), [172, 44, 291, 70]);
  });
});
