import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_ROUTING_ENDPOINT,
  buildIsochroneRequest,
  buildMatrixRequest,
  buildRouteRequest,
  compareSequenceValues,
  decodePolyline,
  getRoutingConfig,
  isochroneResponseToFeatures,
  matrixResponseToFeatures,
  parseContours,
  routeResponseToFeatures,
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
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
      },
      {
        type: "Feature",
        properties: { contour: 10 },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 1],
          ],
        },
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
    assert.deepEqual(
      isochroneResponseToFeatures(null, {
        sourceId: 0,
        mode: "auto",
        metric: "time",
      }),
      [],
    );
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
    assert.deepEqual(feature.geometry.coordinates, [
      [0, 0],
      [1, 1],
    ]);
    assert.deepEqual(feature.properties, {
      origin_id: "o1",
      dest_id: "t1",
      time_s: 600,
      distance_km: 6.5,
      mode: "auto",
    });
  });

  it("returns an empty array for a malformed response", () => {
    assert.deepEqual(matrixResponseToFeatures({}, origins, targets, { mode: "auto" }), []);
  });
});

describe("buildRouteRequest", () => {
  it("maps ordered points to Valhalla locations with km units", () => {
    const points: RoutingPoint[] = [
      { id: "a", lon: -83, lat: 40 },
      { id: "b", lon: -82, lat: 41 },
    ];
    assert.deepEqual(buildRouteRequest(points, "pedestrian"), {
      locations: [
        { lon: -83, lat: 40 },
        { lon: -82, lat: 41 },
      ],
      costing: "pedestrian",
      directions_options: { units: "kilometers" },
    });
  });
});

describe("decodePolyline", () => {
  it("decodes the canonical Google precision-5 example to [lon, lat] pairs", () => {
    // Canonical example from Google's encoded-polyline algorithm docs:
    // (38.5, -120.2), (40.7, -120.95), (43.252, -126.453).
    const coords = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5);
    assert.deepEqual(coords, [
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });

  it("decodes a Valhalla precision-6 polyline at the default precision", () => {
    // Encodes [[-77.05, 38.88], [-77.04, 38.89], [-77.02, 38.9]] at precision 6.
    assert.deepEqual(decodePolyline("_o`diA~gw}qC_pR_pR_pR_af@"), [
      [-77.05, 38.88],
      [-77.04, 38.89],
      [-77.02, 38.9],
    ]);
  });

  it("returns an empty array for an empty string", () => {
    assert.deepEqual(decodePolyline(""), []);
  });

  it("drops a truncated trailing chunk instead of emitting a garbage coord", () => {
    // The full string above with its last coordinate cut off mid-chunk.
    assert.deepEqual(decodePolyline("_o`diA~gw}qC_pR_pR_p"), [
      [-77.05, 38.88],
      [-77.04, 38.89],
    ]);
  });
});

describe("routeResponseToFeatures", () => {
  const points: RoutingPoint[] = [
    { id: "p0", lon: 0, lat: 0 },
    { id: "p1", lon: 1, lat: 1 },
  ];
  // A real Valhalla precision-6 polyline encoding the three [lon, lat] points
  // [[-77.05, 38.88], [-77.04, 38.89], [-77.02, 38.9]], so the test asserts the
  // decode runs at precision 6 (not Google's 5) and yields the right values.
  const response = {
    trip: {
      legs: [
        {
          shape: "_o`diA~gw}qC_pR_pR_pR_af@",
          summary: { time: 540, length: 8.2 },
        },
      ],
    },
  };

  it("emits one LineString per leg with from/to ids and cost", () => {
    const features = routeResponseToFeatures(response, points, { mode: "auto" });
    assert.equal(features.length, 1);
    const [feature] = features;
    assert.equal(feature.geometry.type, "LineString");
    assert.deepEqual(feature.geometry.coordinates, [
      [-77.05, 38.88],
      [-77.04, 38.89],
      [-77.02, 38.9],
    ]);
    assert.deepEqual(feature.properties, {
      leg_index: 0,
      from_id: "p0",
      to_id: "p1",
      time_s: 540,
      distance_km: 8.2,
      mode: "auto",
    });
  });

  it("returns an empty array for a malformed response", () => {
    assert.deepEqual(routeResponseToFeatures({}, points, { mode: "auto" }), []);
  });
});

describe("compareSequenceValues", () => {
  it("orders numeric and numeric-string values ascending", () => {
    assert.ok(compareSequenceValues(1, 2) < 0);
    assert.ok(compareSequenceValues("10", "2") > 0);
  });

  it("orders ISO timestamps chronologically", () => {
    assert.ok(compareSequenceValues("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z") > 0);
  });

  it("sorts parseable values before free-form text and empties last", () => {
    const values = ["zeta", "", "2", "10"];
    const sorted = [...values].sort(compareSequenceValues);
    assert.deepEqual(sorted, ["2", "10", "zeta", ""]);
  });

  it("treats hex strings as text, not their Number() value", () => {
    // "0x1A" must not sort as 26; it is text, so it trails the numeric 5.
    assert.ok(compareSequenceValues("0x1A", 5) > 0);
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
