import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, getActiveMeanRadiusMeters, type GeoLibreLayer } from "@geolibre/core";
import {
  type ProcessingAlgorithm,
  buildLocalNetwork,
  localClosestFacilityTool,
  localServiceAreaTool,
  localShortestPathTool,
  parseCostBreaks,
  parseDirection,
} from "@geolibre/processing";
import type { Feature, FeatureCollection, LineString, MultiLineString, Position } from "geojson";

/** Degrees of latitude (or longitude at the equator) spanning `m` metres. */
function deg(m: number): number {
  return m / ((getActiveMeanRadiusMeters() * Math.PI) / 180);
}

/** A line from metre offsets near (0, 0), where 1 m east = 1 m north. */
function line(points: [number, number][], properties: Record<string, unknown> = {}): Feature {
  return {
    type: "Feature",
    properties,
    geometry: { type: "LineString", coordinates: points.map(([x, y]) => [deg(x), deg(y)]) },
  };
}

function point(x: number, y: number, properties: Record<string, unknown> = {}): Feature {
  return {
    type: "Feature",
    properties,
    geometry: { type: "Point", coordinates: [deg(x), deg(y)] },
  };
}

function layer(id: string, features: Feature[]): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: { type: "FeatureCollection", features } as FeatureCollection,
  };
}

async function run(
  tool: ProcessingAlgorithm,
  layers: GeoLibreLayer[],
  parameters: Record<string, unknown>,
): Promise<{ messages: string[]; results: { name: string; geojson: FeatureCollection }[] }> {
  const messages: string[] = [];
  const results: { name: string; geojson: FeatureCollection }[] = [];
  await tool.run({
    layers,
    parameters,
    log: (message) => messages.push(message),
    addResultLayer: (name, geojson) => results.push({ name, geojson }),
  });
  return { messages, results };
}

/** Square grid of `n` x `n` nodes `spacing` metres apart, one feature per segment. */
function grid(n: number, spacing: number, cost?: (i: number) => number): Feature[] {
  const features: Feature[] = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = i * spacing;
      const y = j * spacing;
      if (i + 1 < n)
        features.push(
          line(
            [
              [x, y],
              [x + spacing, y],
            ],
            { cost: cost?.(k++) },
          ),
        );
      if (j + 1 < n)
        features.push(
          line(
            [
              [x, y],
              [x, y + spacing],
            ],
            { cost: cost?.(k++) },
          ),
        );
    }
  }
  return features;
}

/** Brute-force all-pairs shortest costs (Floyd-Warshall) for cross-checking. */
function floydWarshall(net: ReturnType<typeof buildLocalNetwork>): number[][] {
  const n = net.nodeCount;
  const d = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)),
  );
  for (const e of net.edges) {
    d[e.a][e.b] = Math.min(d[e.a][e.b], e.costAB);
    d[e.b][e.a] = Math.min(d[e.b][e.a], e.costBA);
  }
  for (let k = 0; k < n; k++)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j];
  return d;
}

function lineLength(coords: Position[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
  }
  return total / deg(1);
}

describe("parseDirection", () => {
  it("reads OSM and Esri one-way conventions", () => {
    assert.equal(parseDirection("yes"), "forward");
    assert.equal(parseDirection(1), "forward");
    assert.equal(parseDirection(true), "forward");
    assert.equal(parseDirection("FT"), "forward");
    assert.equal(parseDirection("-1"), "backward");
    assert.equal(parseDirection("TF"), "backward");
    assert.equal(parseDirection("N"), "closed");
    assert.equal(parseDirection("no"), "both");
    assert.equal(parseDirection("B"), "both");
    assert.equal(parseDirection(null), "both");
    assert.equal(parseDirection(""), "both");
  });
});

describe("parseCostBreaks", () => {
  it("sorts, de-duplicates and drops invalid values", () => {
    assert.deepEqual(parseCostBreaks("10, 5;5 x -1 20"), [5, 10, 20]);
  });
});

describe("buildLocalNetwork", () => {
  it("joins lines at shared vertices and measures length in metres", () => {
    const net = buildLocalNetwork([
      line([
        [0, 0],
        [100, 0],
      ]),
      line([
        [100, 0],
        [100, 50],
      ]),
    ]);
    assert.equal(net.nodeCount, 3);
    assert.equal(net.edges.length, 2);
    const path = net.shortestPath(0, 2);
    assert.ok(path);
    assert.ok(Math.abs(path.cost - 150) < 1e-6, `cost ${path.cost}`);
    assert.ok(Math.abs(path.length - 150) < 1e-6);
  });

  it("does not connect lines that cross without a shared vertex", () => {
    const net = buildLocalNetwork([
      line([
        [-50, 0],
        [50, 0],
      ]),
      line([
        [0, -50],
        [0, 50],
      ]),
    ]);
    const a = net.insertPoint(deg(-50), 0);
    const b = net.insertPoint(0, deg(50));
    assert.ok(a && b);
    assert.equal(net.shortestPath(a.node, b.node), null);
  });

  it("snaps endpoints within the tolerance and not beyond it", () => {
    const features = [
      line([
        [0, 0],
        [100, 0],
      ]),
      line([
        [100.5, 0],
        [200, 0],
      ]),
    ];
    const loose = buildLocalNetwork(features, { snapToleranceM: 1 });
    assert.equal(loose.stats.snappedEndpoints, 1);
    assert.equal(loose.nodeCount, 3);
    const tight = buildLocalNetwork(features, { snapToleranceM: 0.2 });
    assert.equal(tight.nodeCount, 4);
    const s = tight.insertPoint(0, 0);
    const t = tight.insertPoint(deg(200), 0);
    assert.ok(s && t);
    assert.equal(tight.shortestPath(s.node, t.node), null);
  });

  it("splits a segment where a dangling endpoint stops just short of it", () => {
    // A T-junction digitized 0.4 m short of the through road.
    const net = buildLocalNetwork(
      [
        line([
          [0, 0],
          [200, 0],
        ]),
        line([
          [100, 50],
          [100, 0.4],
        ]),
      ],
      {
        snapToleranceM: 1,
      },
    );
    assert.equal(net.stats.splitSegments, 1);
    const s = net.insertPoint(0, 0);
    const t = net.insertPoint(deg(100), deg(50));
    assert.ok(s && t);
    const path = net.shortestPath(s.node, t.node);
    assert.ok(path);
    assert.ok(Math.abs(path.cost - 149.6) < 0.01, `cost ${path.cost}`);
  });

  it("respects one-way direction fields", () => {
    // A square: the direct east edge is one-way west, so east-bound traffic
    // has to go around the other three sides.
    const net = buildLocalNetwork(
      [
        line(
          [
            [0, 0],
            [100, 0],
          ],
          { oneway: "-1" },
        ),
        line([
          [0, 0],
          [0, 100],
        ]),
        line([
          [0, 100],
          [100, 100],
        ]),
        line([
          [100, 100],
          [100, 0],
        ]),
      ],
      { directionField: "oneway" },
    );
    const a = net.insertPoint(0, 0);
    const b = net.insertPoint(deg(100), 0);
    assert.ok(a && b);
    assert.ok(Math.abs((net.shortestPath(a.node, b.node)?.cost ?? 0) - 300) < 1e-6);
    assert.ok(Math.abs((net.shortestPath(b.node, a.node)?.cost ?? 0) - 100) < 1e-6);
  });

  it("derives minutes from a speed field", () => {
    const net = buildLocalNetwork(
      [
        line(
          [
            [0, 0],
            [1000, 0],
          ],
          { kmh: 60 },
        ),
      ],
      {
        costMode: "speed",
        costField: "kmh",
      },
    );
    const path = net.shortestPath(0, 1);
    assert.ok(path && Math.abs(path.cost - 1) < 1e-9);
  });

  it("spreads a feature's total cost field over its parts by length", () => {
    const net = buildLocalNetwork(
      [
        line(
          [
            [0, 0],
            [30, 0],
            [100, 0],
          ],
          { cost: 10 },
        ),
      ],
      {
        costMode: "field",
        costField: "cost",
      },
    );
    assert.ok(Math.abs(net.edges[0].costAB - 3) < 1e-9);
    assert.ok(Math.abs(net.edges[1].costAB - 7) < 1e-9);
  });

  it("A* and Dijkstra both match Floyd-Warshall on a weighted grid", () => {
    // Deterministic pseudo-random costs, never below the length-based floor.
    const net = buildLocalNetwork(
      grid(6, 100, (i) => 100 + ((i * 7919) % 97) * 3),
      { costMode: "field", costField: "cost" },
    );
    const all = floydWarshall(net);
    for (const [s, t] of [
      [0, 35],
      [5, 30],
      [12, 23],
      [35, 0],
    ]) {
      const astar = net.shortestPath(s, t, true);
      const dijkstra = net.shortestPath(s, t, false);
      assert.ok(astar && dijkstra);
      assert.ok(Math.abs(astar.cost - all[s][t]) < 1e-6, `A* ${astar.cost} vs ${all[s][t]}`);
      assert.ok(Math.abs(dijkstra.cost - all[s][t]) < 1e-6);
    }
  });
});

describe("local network tools", () => {
  const roads = layer("roads", grid(5, 100));

  it("routes through stops in order", async () => {
    const stops = layer("stops", [
      point(0, 0, { name: "A" }),
      point(400, 0, { name: "B" }),
      point(400, 400, { name: "C" }),
    ]);
    const { results, messages } = await run(localShortestPathTool, [roads, stops], {
      network: "roads",
      stops: "stops",
      costMode: "length",
      snapTolerance: 1,
      algorithm: "astar",
    });
    assert.equal(results.length, 1, messages.join("\n"));
    const legs = results[0].geojson.features;
    assert.equal(legs.length, 2);
    assert.deepEqual(
      legs.map((f) => [f.properties?.from, f.properties?.to]),
      [
        ["A", "B"],
        ["B", "C"],
      ],
    );
    for (const leg of legs) {
      assert.ok(Math.abs((leg.properties?.cost as number) - 400) < 0.01);
      assert.ok(Math.abs(lineLength((leg.geometry as LineString).coordinates) - 400) < 0.01);
    }
  });

  it("starts and ends routes at points projected onto edges", async () => {
    // Stops 30 m and 70 m along the bottom edge, 5 m off the road.
    const stops = layer("stops", [point(130, 5), point(270, -5)]);
    const { results } = await run(localShortestPathTool, [roads, stops], {
      network: "roads",
      stops: "stops",
    });
    const leg = results[0].geojson.features[0];
    assert.ok(Math.abs((leg.properties?.cost as number) - 140) < 0.01);
    assert.ok(Math.abs((leg.properties?.from_snap_m as number) - 5) < 0.01);
  });

  it("finds the k closest facilities by network cost, nearest first", async () => {
    // Facility F1 is closer as the crow flies but far by network: the edge
    // between (0,100) and (0,0) is missing, so it is a detour.
    const net = layer("net", [
      line([
        [0, 0],
        [300, 0],
      ]),
      line([
        [300, 0],
        [300, 100],
      ]),
      line([
        [300, 100],
        [0, 100],
      ]),
      line([
        [0, 0],
        [-200, 0],
      ]),
    ]);
    const incidents = layer("inc", [point(0, 0, { id: "I" })]);
    const facilities = layer("fac", [point(0, 100, { id: "F1" }), point(-200, 0, { id: "F2" })]);
    const { results } = await run(localClosestFacilityTool, [net, incidents, facilities], {
      network: "net",
      incidents: "inc",
      facilities: "fac",
      count: 2,
    });
    const routes = results[0].geojson.features;
    assert.deepEqual(
      routes.map((f) => [f.properties?.facility, f.properties?.rank]),
      [
        ["F2", 1],
        ["F1", 2],
      ],
    );
    assert.ok(Math.abs((routes[0].properties?.cost as number) - 200) < 0.01);
    assert.ok(Math.abs((routes[1].properties?.cost as number) - 700) < 0.01);
  });

  it("honours the maximum cost for closest facility", async () => {
    const incidents = layer("inc", [point(0, 0)]);
    const facilities = layer("fac", [point(400, 400)]);
    const { results, messages } = await run(
      localClosestFacilityTool,
      [roads, incidents, facilities],
      { network: "roads", incidents: "inc", facilities: "fac", count: 1, maxCost: 500 },
    );
    assert.equal(results.length, 0);
    assert.ok(messages.some((m) => m.startsWith("Error:")));
  });

  it("clips service-area lines at the break, including partial edges", async () => {
    const net = layer("net", [
      line([
        [0, 0],
        [1000, 0],
      ]),
    ]);
    const facilities = layer("fac", [point(500, 0)]);
    const { results } = await run(localServiceAreaTool, [net, facilities], {
      network: "net",
      facilities: "fac",
      breaks: "200, 1000",
      polygonWidth: 10,
    });
    const lines = results.find((r) => r.name === "Service area lines");
    const polygons = results.find((r) => r.name === "Service area polygons");
    assert.ok(lines && polygons);
    const byBreak = new Map(
      lines.geojson.features.map((f) => [
        f.properties?.break as number,
        (f.geometry as MultiLineString).coordinates.reduce((s, piece) => s + lineLength(piece), 0),
      ]),
    );
    assert.ok(Math.abs((byBreak.get(200) ?? 0) - 400) < 0.01, `200: ${byBreak.get(200)}`);
    assert.ok(Math.abs((byBreak.get(1000) ?? 0) - 1000) < 0.01);
    assert.equal(polygons.geojson.features.length, 2);
    // Largest break first so the smaller area draws on top.
    assert.equal(lines.geojson.features[0].properties?.break, 1000);
  });

  it("service area follows one-way edges away from the facility", async () => {
    const net = layer("net", [
      line(
        [
          [0, 0],
          [1000, 0],
        ],
        { ow: "yes" },
      ),
    ]);
    const facilities = layer("fac", [point(500, 0)]);
    const { results } = await run(localServiceAreaTool, [net, facilities], {
      network: "net",
      facilities: "fac",
      directionField: "ow",
      breaks: "200",
      polygonWidth: 0,
    });
    const coords = (results[0].geojson.features[0].geometry as MultiLineString).coordinates;
    assert.equal(coords.length, 1);
    assert.ok(Math.abs(lineLength(coords[0]) - 200) < 0.01);
    assert.ok(coords[0][0][0] >= deg(500) - 1e-12, "reachable only eastward");
  });
});
