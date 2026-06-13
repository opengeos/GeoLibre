import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_ROUTING_ENDPOINT,
  buildIsochroneRequest,
  buildMatrixRequest,
  getRoutingConfig,
  isochroneResponseToFeatures,
  matrixResponseToFeatures,
  parseContours,
  type RoutingPoint,
} from "../packages/core/src/routing";

describe("parseContours", () => {
  it("parses, sorts, and de-duplicates positive values", () => {
    assert.deepEqual(parseContours("10, 5, 15"), [5, 10, 15]);
    assert.deepEqual(parseContours("5 10 5"), [5, 10]);
  });

  it("drops non-finite and non-positive tokens", () => {
    assert.deepEqual(parseContours("5, abc, -3, 0, 8"), [5, 8]);
    assert.deepEqual(parseContours(""), []);
  });
});

describe("buildIsochroneRequest", () => {
  it("builds a time request with one contour per value", () => {
    const body = buildIsochroneRequest([-83, 40], {
      mode: "auto",
      metric: "time",
      contours: [5, 10],
    });
    assert.deepEqual(body, {
      locations: [{ lon: -83, lat: 40 }],
      costing: "auto",
      contours: [{ time: 5 }, { time: 10 }],
      polygons: true,
    });
  });

  it("uses the distance key for the distance metric", () => {
    const body = buildIsochroneRequest([1, 2], {
      mode: "pedestrian",
      metric: "distance",
      contours: [1],
    });
    assert.deepEqual(body.contours, [{ distance: 1 }]);
    assert.equal(body.costing, "pedestrian");
  });
});

describe("isochroneResponseToFeatures", () => {
  const response = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { contour: 5, metric: "time" },
        geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      },
      {
        type: "Feature",
        properties: { contour: 10 },
        geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
      },
    ],
  };

  it("keeps polygons and tags them with origin/mode/metric/contour", () => {
    const features = isochroneResponseToFeatures(response, {
      sourceId: "hospital-1",
      mode: "auto",
      metric: "time",
    });
    assert.equal(features.length, 1);
    assert.deepEqual(features[0].properties, {
      source_id: "hospital-1",
      mode: "auto",
      metric: "time",
      contour: 5,
    });
    assert.equal(features[0].geometry.type, "Polygon");
  });

  it("returns an empty array for a malformed response", () => {
    assert.deepEqual(isochroneResponseToFeatures(null, {
      sourceId: 0,
      mode: "auto",
      metric: "time",
    }), []);
  });
});

describe("buildMatrixRequest", () => {
  it("maps points to Valhalla sources/targets", () => {
    const origins: RoutingPoint[] = [{ id: "a", lon: -83, lat: 40 }];
    const targets: RoutingPoint[] = [
      { id: "x", lon: -82, lat: 41 },
      { id: "y", lon: -84, lat: 39 },
    ];
    const body = buildMatrixRequest(origins, targets, "bicycle");
    assert.deepEqual(body, {
      sources: [{ lon: -83, lat: 40 }],
      targets: [
        { lon: -82, lat: 41 },
        { lon: -84, lat: 39 },
      ],
      costing: "bicycle",
    });
  });
});

describe("matrixResponseToFeatures", () => {
  const origins: RoutingPoint[] = [{ id: "o1", lon: 0, lat: 0 }];
  const targets: RoutingPoint[] = [
    { id: "t1", lon: 1, lat: 1 },
    { id: "t2", lon: 2, lat: 2 },
  ];
  const response = {
    sources_to_targets: [
      [
        { from_index: 0, to_index: 0, time: 600, distance: 6.5 },
        { from_index: 0, to_index: 1, time: null, distance: null },
      ],
    ],
  };

  it("emits one LineString per reachable pair with cost attributes", () => {
    const features = matrixResponseToFeatures(response, origins, targets, {
      mode: "auto",
    });
    assert.equal(features.length, 1);
    const [feature] = features;
    assert.equal(feature.geometry.type, "LineString");
    assert.deepEqual(feature.geometry.coordinates, [[0, 0], [1, 1]]);
    assert.deepEqual(feature.properties, {
      origin_id: "o1",
      dest_id: "t1",
      time_s: 600,
      distance_km: 6.5,
      mode: "auto",
    });
  });

  it("returns an empty array for a malformed response", () => {
    assert.deepEqual(
      matrixResponseToFeatures({}, origins, targets, { mode: "auto" }),
      [],
    );
  });
});

describe("getRoutingConfig", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("defaults to the public Valhalla endpoint", () => {
    assert.equal(getRoutingConfig().endpoint, DEFAULT_ROUTING_ENDPOINT);
  });

  it("honors VITE_ROUTING_ENDPOINT from runtime env and trims a trailing slash", () => {
    (globalThis as { window?: unknown }).window = {
      __GEOLIBRE_RUNTIME_ENV__: {
        VITE_ROUTING_ENDPOINT: "https://valhalla.example.com/",
      },
    };
    assert.equal(getRoutingConfig().endpoint, "https://valhalla.example.com");
  });
});
