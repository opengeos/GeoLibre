import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection, LineString, MultiLineString, Position } from "geojson";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  createRoutesTool,
  dynamicSegmentationTool,
  getMeasure,
  haversineMeters,
  locateFeaturesAlongRoutesTool,
  locatePointOnRoute,
  measureLine,
  pointAtMeasure,
  sliceRouteByMeasure,
  withMeasure,
} from "../packages/processing/src/linear-referencing-tools";
import { getVectorTool } from "../packages/processing/src/vector-tool-registry";
import type { ProcessingContext } from "../packages/processing/src/types";

/** One degree of longitude along the equator, in metres (R = 6371008.8). */
const DEG_M = (6371008.8 * Math.PI) / 180;

function close(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected}`);
}

function closeAll(actual: number[], expected: number[], tolerance = 1e-9): void {
  assert.equal(actual.length, expected.length, `${actual} vs ${expected}`);
  actual.forEach((value, i) => close(value, expected[i], tolerance));
}

const EQUATOR_LINE: LineString = {
  type: "LineString",
  coordinates: [
    [0, 0],
    [1, 0],
    [3, 0],
  ],
};

function layerOf(id: string, features: Feature[]): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: { type: "FeatureCollection", features },
  };
}

function run(
  toolRun: (ctx: ProcessingContext) => unknown,
  layers: GeoLibreLayer[],
  parameters: Record<string, unknown>,
) {
  const logs: string[] = [];
  const results: FeatureCollection[] = [];
  return Promise.resolve(
    toolRun({
      layers,
      parameters,
      log: (m) => logs.push(m),
      addResultLayer: (_name, geojson) => results.push(geojson),
    }),
  ).then(() => ({ logs, results }));
}

describe("M values in GeoJSON", () => {
  it("stores M as the fourth ordinate with a Z placeholder", () => {
    assert.deepEqual(withMeasure([1, 2], 5), [1, 2, 0, 5]);
    assert.deepEqual(withMeasure([1, 2, 30], 5), [1, 2, 30, 5]);
    assert.equal(getMeasure([1, 2, 30, 5]), 5);
    assert.equal(getMeasure([1, 2, 30]), undefined);
  });

  it("survives a JSON round trip", () => {
    const measured = measureLine(EQUATOR_LINE)!;
    const copy = JSON.parse(JSON.stringify(measured)) as LineString;
    assert.deepEqual(copy.coordinates, measured.coordinates);
  });
});

describe("measureLine", () => {
  it("measures by cumulative geodesic length", () => {
    const line = measureLine(EQUATOR_LINE, { unit: "kilometers" }) as LineString;
    const ms = line.coordinates.map((p) => getMeasure(p)!);
    close(ms[0], 0);
    close(ms[1], DEG_M / 1000);
    close(ms[2], (3 * DEG_M) / 1000);
  });

  it("rescales to start and end measures", () => {
    const line = measureLine(EQUATOR_LINE, { fromMeasure: 100, toMeasure: 400 }) as LineString;
    assert.deepEqual(
      line.coordinates.map((p) => getMeasure(p)),
      [100, 200, 400],
    );
  });

  it("continues measures across MultiLineString parts and keeps Z", () => {
    const multi: MultiLineString = {
      type: "MultiLineString",
      coordinates: [
        [
          [0, 0, 5],
          [1, 0, 6],
        ],
        [
          [2, 0, 7],
          [3, 0, 8],
        ],
      ],
    };
    const measured = measureLine(multi, { fromMeasure: 0, toMeasure: 2 }) as MultiLineString;
    assert.deepEqual(measured.coordinates, [
      [
        [0, 0, 5, 0],
        [1, 0, 6, 1],
      ],
      [
        [2, 0, 7, 1],
        [3, 0, 8, 2],
      ],
    ]);
  });

  it("returns null for non-line geometry", () => {
    assert.equal(measureLine({ type: "Point", coordinates: [0, 0] }), null);
  });
});

describe("locatePointOnRoute", () => {
  const route = measureLine(EQUATOR_LINE, { fromMeasure: 0, toMeasure: 300 })!;

  it("interpolates the measure at the closest point", () => {
    const hit = locatePointOnRoute(route, [2, 0.001])!;
    close(hit.measure, 200);
    close(hit.point[0], 2);
    close(hit.point[1], 0);
    close(hit.distance, haversineMeters([2, 0.001], [2, 0]));
  });

  it("clamps to the route end", () => {
    const hit = locatePointOnRoute(route, [4, 0])!;
    close(hit.measure, 300);
    close(hit.distance, DEG_M, 1e-3);
  });

  it("measures an unmeasured line by length in metres", () => {
    const hit = locatePointOnRoute(EQUATOR_LINE, [0.5, 0])!;
    close(hit.measure, DEG_M / 2, 1e-6);
  });
});

describe("dynamic segmentation geometry", () => {
  const route = measureLine(EQUATOR_LINE, { fromMeasure: 0, toMeasure: 300 })!;

  it("slices between two measures with interpolated ends", () => {
    const slice = sliceRouteByMeasure(route, 50, 250) as LineString;
    assert.deepEqual(slice.type, "LineString");
    const coords = slice.coordinates as Position[];
    assert.equal(coords.length, 3);
    close(coords[0][0], 0.5);
    close(coords[1][0], 1);
    close(coords[2][0], 2.5);
    closeAll(
      coords.map((p) => getMeasure(p)!),
      [50, 100, 250],
    );
  });

  it("accepts reversed measures and clamps to the route range", () => {
    const slice = sliceRouteByMeasure(route, 500, 200) as LineString;
    assert.deepEqual(
      slice.coordinates.map((p) => getMeasure(p)),
      [200, 300],
    );
    assert.equal(sliceRouteByMeasure(route, 400, 500), null);
  });

  it("splits a slice across MultiLineString parts", () => {
    const multi = measureLine(
      {
        type: "MultiLineString",
        coordinates: [
          [
            [0, 0],
            [1, 0],
          ],
          [
            [2, 0],
            [3, 0],
          ],
        ],
      },
      { fromMeasure: 0, toMeasure: 20 },
    );
    const slice = sliceRouteByMeasure(multi, 5, 15) as MultiLineString;
    assert.equal(slice.type, "MultiLineString");
    assert.deepEqual(
      slice.coordinates.map((part) => part.map((p) => getMeasure(p))),
      [
        [5, 10],
        [10, 15],
      ],
    );
  });

  it("places a point event", () => {
    const point = pointAtMeasure(route, 150)!;
    close(point[0], 1.5);
    assert.equal(getMeasure(point), 150);
    assert.equal(pointAtMeasure(route, 301), null);
  });
});

describe("linear referencing tools", () => {
  const roads = layerOf("roads", [
    {
      type: "Feature",
      properties: { name: "A", start: 0, end: 300 },
      geometry: EQUATOR_LINE,
    },
    {
      type: "Feature",
      properties: { name: "B", start: 0, end: 10 },
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 1],
          [1, 1],
        ],
      },
    },
  ]);

  it("are registered as vector tools", () => {
    for (const id of ["create-routes", "locate-features-along-routes", "dynamic-segmentation"]) {
      assert.ok(getVectorTool(id), id);
    }
  });

  it("chain: create routes, locate points, then segment events", async () => {
    const created = await run(createRoutesTool.run, [roads], {
      layer: "roads",
      routeIdField: "name",
      measureSource: "fields",
      fromField: "start",
      toField: "end",
    });
    assert.equal(created.results.length, 1);
    const routes = created.results[0];
    assert.deepEqual(
      routes.features.map((f) => [
        f.properties?.route_id,
        f.properties?.m_from,
        f.properties?.m_to,
      ]),
      [
        ["A", 0, 300],
        ["B", 0, 10],
      ],
    );
    const routesLayer = layerOf("routes", routes.features);

    const points = layerOf("points", [
      { type: "Feature", properties: { id: 1 }, geometry: { type: "Point", coordinates: [2, 0] } },
      {
        type: "Feature",
        properties: { id: 2 },
        geometry: { type: "Point", coordinates: [0.5, 1] },
      },
      { type: "Feature", properties: { id: 3 }, geometry: { type: "Point", coordinates: [9, 9] } },
    ]);
    const located = await run(locateFeaturesAlongRoutesTool.run, [points, routesLayer], {
      layer: "points",
      routes: "routes",
      routeIdField: "route_id",
      radius: 10,
    });
    const rows = located.results[0].features.map((f) => f.properties!);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].route_id, "A");
    close(rows[0].measure as number, 200);
    assert.equal(rows[1].route_id, "B");
    close(rows[1].measure as number, 5);
    assert.match(located.logs.join("\n"), /1 feature\(s\) had no route/);

    const events = layerOf("events", [
      {
        type: "Feature",
        properties: { road: "A", from: 50, to: 150, kind: "paving" },
        geometry: null as never,
      },
      {
        type: "Feature",
        properties: { road: "B", from: 2, to: 8, kind: "lights" },
        geometry: null as never,
      },
      { type: "Feature", properties: { road: "Z", from: 1, to: 2 }, geometry: null as never },
    ]);
    const segmented = await run(dynamicSegmentationTool.run, [routesLayer, events], {
      routes: "routes",
      routeIdField: "route_id",
      layer: "events",
      eventRouteField: "road",
      fromField: "from",
      toField: "to",
    });
    const segments = segmented.results[0].features;
    assert.equal(segments.length, 2);
    assert.equal(segments[0].properties?.kind, "paving");
    closeAll(
      (segments[0].geometry as LineString).coordinates.map((p) => getMeasure(p)!),
      [50, 100, 150],
    );
    close((segments[1].geometry as LineString).coordinates[0][0], 0.2);
    assert.match(segmented.logs.join("\n"), /1 event\(s\) reference a route that does not exist/);

    const pointEvents = await run(dynamicSegmentationTool.run, [routesLayer, events], {
      routes: "routes",
      routeIdField: "route_id",
      layer: "events",
      eventRouteField: "road",
      fromField: "from",
    });
    const placed = pointEvents.results[0].features;
    assert.equal(placed[0].geometry.type, "Point");
    assert.equal(getMeasure((placed[0].geometry as { coordinates: Position }).coordinates), 50);
  });

  it("create-routes measures by length in the chosen unit", async () => {
    const { results } = await run(createRoutesTool.run, [roads], {
      layer: "roads",
      measureSource: "length",
      unit: "kilometers",
    });
    const first = results[0].features[0];
    close(first.properties?.m_to as number, (3 * DEG_M) / 1000);
    assert.equal(first.properties?.route_id, "0");
  });
});

it("locates each MultiPoint hit with its matching point geometry", async () => {
  const routes = layerOf("routes", [
    { type: "Feature", properties: { route_id: "A" }, geometry: EQUATOR_LINE },
  ]);
  const points = layerOf("points", [
    {
      type: "Feature",
      properties: {},
      geometry: {
        type: "MultiPoint",
        coordinates: [
          [0.5, 0],
          [2, 0],
        ],
      },
    },
  ]);
  for (const allRoutes of [false, true]) {
    const result = await run(locateFeaturesAlongRoutesTool.run, [routes, points], {
      layer: "points",
      routes: "routes",
      routeIdField: "route_id",
      allRoutes,
      radius: 1,
    });
    assert.equal(result.results[0].features.length, 2);
    assert.deepEqual(
      result.results[0].features.map((feature) => feature.geometry),
      [
        { type: "Point", coordinates: [0.5, 0] },
        { type: "Point", coordinates: [2, 0] },
      ],
    );
    assert.match(result.logs.join("\n"), /incomplete M values/);
  }
});

it("places zero-length line events as points and warns about repeated route IDs", async () => {
  const geometry = measureLine(EQUATOR_LINE)!;
  const routes = layerOf(
    "routes",
    [0, 1].map(() => ({ type: "Feature", properties: { route_id: "A" }, geometry })),
  );
  const events = layerOf("events", [
    {
      type: "Feature",
      properties: { road: "A", from: 100, to: 100 },
      geometry: { type: "Point", coordinates: [0, 0] },
    },
  ]);
  const result = await run(dynamicSegmentationTool.run, [routes, events], {
    layer: "events",
    routes: "routes",
    routeIdField: "route_id",
    eventRouteField: "road",
    fromField: "from",
    toField: "to",
  });
  assert.equal(result.results[0].features[0].geometry?.type, "Point");
  assert.match(result.logs.join("\n"), /multiple features/);
  assert.ok(!result.logs.some((message) => message.includes("outside their route")));
});

it("locates nearby routes across the antimeridian and reports missing IDs", async () => {
  const routes = layerOf("routes", [
    {
      type: "Feature",
      properties: { id: "A" },
      geometry: {
        type: "LineString",
        coordinates: [
          [-179.999, -0.01],
          [-179.999, 0.01],
        ],
      },
    },
    { type: "Feature", properties: {}, geometry: EQUATOR_LINE },
  ]);
  const points = layerOf("points", [
    { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [179.999, 0] } },
  ]);
  const result = await run(locateFeaturesAlongRoutesTool.run, [routes, points], {
    layer: "points",
    routes: "routes",
    routeIdField: "id",
    radius: 500,
  });
  assert.equal(result.results[0].features.length, 1);
  assert.ok(Number(result.results[0].features[0].properties?.distance_m) < 250);
  assert.match(result.logs.join("\n"), /empty route ID/);
});

it("places point events on a wrapped route at the antimeridian", async () => {
  const geometry: LineString = {
    type: "LineString",
    coordinates: [
      [179, 0, 0, 0],
      [-179, 0, 0, 100],
    ],
  };
  assert.deepEqual(pointAtMeasure(geometry, 50), [180, 0, 0, 50]);
  const routes = layerOf("routes", [{ type: "Feature", properties: { id: "A" }, geometry }]);
  const events = layerOf("events", [
    {
      type: "Feature",
      properties: { id: "A", m: 50 },
      geometry: { type: "Point", coordinates: [0, 0] },
    },
  ]);
  const result = await run(dynamicSegmentationTool.run, [routes, events], {
    layer: "events",
    routes: "routes",
    routeIdField: "id",
    eventRouteField: "id",
    fromField: "m",
  });
  assert.deepEqual(result.results[0].features[0].geometry, {
    type: "Point",
    coordinates: [180, 0, 0, 50],
  });
});
