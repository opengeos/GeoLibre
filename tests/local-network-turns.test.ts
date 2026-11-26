import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { DEFAULT_LAYER_STYLE, getActiveMeanRadiusMeters, type GeoLibreLayer } from "@geolibre/core";
import {
  buildLocalNetwork,
  LocalNetwork,
  localClosestFacilityTool,
  localServiceAreaTool,
  localShortestPathTool,
  turnRulesActive,
  type ProcessingAlgorithm,
  type NetworkSearchBudget,
} from "@geolibre/processing";
import type { Feature, FeatureCollection, LineString, Position } from "geojson";

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

/** A turn table row: no geometry, just the from and to line ids. */
function turn(from: string, to: string, extra: Record<string, unknown> = {}): Feature {
  return { type: "Feature", properties: { from, to, ...extra }, geometry: null as never };
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

/** Metre offsets of a result line's vertices, rounded to the centimetre. */
function metres(coords: Position[]): [number, number][] {
  return coords.map(([x, y]) => [Math.round(x / deg(0.01)) / 100, Math.round(y / deg(0.01)) / 100]);
}

/**
 * S --a-- J --c-- E
 *         |       |d
 *         b       K
 *         |     /e
 *         N ----
 *
 * S (0,0), J (100,0), E (200,0), K (200,50), N (100,100). S to N is 200 m by
 * a then b (a left turn at J). The detour a, c, d, e is about 361.8 m, and a
 * U-turn at E back along c and up b would be 400 m.
 */
const STREETS = layer("streets", [
  line(
    [
      [0, 0],
      [100, 0],
    ],
    { id: "a" },
  ),
  line(
    [
      [100, 0],
      [100, 100],
    ],
    { id: "b" },
  ),
  line(
    [
      [100, 0],
      [200, 0],
    ],
    { id: "c" },
  ),
  line(
    [
      [200, 0],
      [200, 50],
    ],
    { id: "d" },
  ),
  line(
    [
      [200, 50],
      [100, 100],
    ],
    { id: "e" },
  ),
]);
const DETOUR = 250 + Math.hypot(100, 50);
const S_TO_N = layer("stops", [point(0, 0, { name: "S" }), point(100, 100, { name: "N" })]);
const NO_LEFT = layer("turns", [turn("a", "b")]);
const TURN_TABLE = {
  turns: "rules",
  turnTable: "turns",
  networkIdField: "id",
  turnFromField: "from",
  turnToField: "to",
};

describe("turn restrictions", () => {
  it("routes straight through with no turn rules", async () => {
    const { results } = await run(localShortestPathTool, [STREETS, S_TO_N], {
      network: "streets",
      stops: "stops",
    });
    const leg = results[0].geojson.features[0];
    assert.ok(Math.abs((leg.properties?.cost as number) - 200) < 0.01);
  });

  it("takes the detour around a prohibited turn", async () => {
    for (const algorithm of ["astar", "dijkstra"]) {
      const { results, messages } = await run(localShortestPathTool, [STREETS, S_TO_N, NO_LEFT], {
        network: "streets",
        stops: "stops",
        algorithm,
        ...TURN_TABLE,
      });
      assert.equal(results.length, 1, messages.join("\n"));
      const leg = results[0].geojson.features[0];
      assert.ok(Math.abs((leg.properties?.cost as number) - DETOUR) < 0.01, algorithm);
      assert.ok(Math.abs((leg.properties?.length_m as number) - DETOUR) < 0.01);
      assert.deepEqual(metres((leg.geometry as LineString).coordinates), [
        [0, 0],
        [100, 0],
        [200, 0],
        [200, 50],
        [100, 100],
      ]);
      assert.ok(messages.some((m) => m.includes("1 row(s) matched (1 prohibited")));
    }
  });

  it("uses a U-turn to get around a prohibited turn only where U-turns are allowed", async () => {
    // Without d and e the only way from a onto b is past J and back.
    const spur = layer("streets", STREETS.geojson!.features.slice(0, 3));
    const params = { network: "streets", stops: "stops", ...TURN_TABLE };
    const allowed = await run(localShortestPathTool, [spur, S_TO_N, NO_LEFT], params);
    const leg = allowed.results[0].geojson.features[0];
    assert.ok(Math.abs((leg.properties?.cost as number) - 400) < 0.01);
    assert.deepEqual(metres((leg.geometry as LineString).coordinates), [
      [0, 0],
      [100, 0],
      [200, 0],
      [100, 0],
      [100, 100],
    ]);
    // E is a dead end, so "dead ends only" still allows it, with its cost.
    const deadEnd = await run(localShortestPathTool, [spur, S_TO_N, NO_LEFT], {
      ...params,
      uturns: "dead-ends",
      uturnCost: 25,
    });
    const costed = deadEnd.results[0].geojson.features[0];
    assert.ok(Math.abs((costed.properties?.cost as number) - 425) < 0.01);
    const never = await run(localShortestPathTool, [spur, S_TO_N, NO_LEFT], {
      ...params,
      uturns: "never",
    });
    assert.equal(never.results.length, 0);
    assert.ok(never.messages.some((m) => m.startsWith("Error: none of the stops")));
  });

  it("restricts only the named direction of a turn", async () => {
    // b onto a (N toward S) is still allowed.
    const reversed = layer("stops", [point(100, 100), point(0, 0)]);
    const { results } = await run(localShortestPathTool, [STREETS, reversed, NO_LEFT], {
      network: "streets",
      stops: "stops",
      ...TURN_TABLE,
    });
    assert.ok(Math.abs((results[0].geojson.features[0].properties?.cost as number) - 200) < 0.01);
  });

  it("applies the restriction in closest facility for both travel directions", async () => {
    const incident = layer("incidents", [point(100, 100, { name: "N" })]);
    const facility = layer("facilities", [point(0, 0, { name: "S" })]);
    const base = {
      network: "streets",
      incidents: "incidents",
      facilities: "facilities",
      ...TURN_TABLE,
    };
    const layers = [STREETS, incident, facility, NO_LEFT];
    // Facility to incident turns from a onto b: the prohibited turn.
    const from = await run(localClosestFacilityTool, layers, { ...base, travelDirection: "from" });
    const outbound = from.results[0].geojson.features[0];
    assert.ok(Math.abs((outbound.properties?.cost as number) - DETOUR) < 0.01);
    const coords = metres((outbound.geometry as LineString).coordinates);
    assert.deepEqual(coords[0], [0, 0], "starts at the facility");
    assert.deepEqual(coords[coords.length - 1], [100, 100], "ends at the incident");
    // Incident to facility turns from b onto a, which is allowed.
    const to = await run(localClosestFacilityTool, layers, { ...base, travelDirection: "to" });
    assert.ok(
      Math.abs((to.results[0].geojson.features[0].properties?.cost as number) - 200) < 0.01,
    );
  });

  it("keeps a service area from crossing a prohibited turn", async () => {
    const facility = layer("facilities", [point(0, 0)]);
    const params = {
      network: "streets",
      facilities: "facilities",
      breaks: "250",
      polygonWidth: 0,
    };
    const reachedB = (fc: FeatureCollection) =>
      (fc.features[0].geometry as { coordinates: Position[][] }).coordinates
        .map(metres)
        .filter((piece) => piece.every(([x]) => x === 100) && piece.some(([, y]) => y > 0));
    const free = await run(localServiceAreaTool, [STREETS, facility], params);
    assert.equal(reachedB(free.results[0].geojson).length, 1);
    const ruled = await run(localServiceAreaTool, [STREETS, facility, NO_LEFT], {
      ...params,
      ...TURN_TABLE,
      uturns: "never",
    });
    assert.deepEqual(reachedB(ruled.results[0].geojson), []);
    // Toward the facility, b onto a is allowed, so b is in the area.
    const toward = await run(localServiceAreaTool, [STREETS, facility, NO_LEFT], {
      ...params,
      ...TURN_TABLE,
      uturns: "never",
      travelDirection: "to",
    });
    assert.equal(reachedB(toward.results[0].geojson).length, 1);
  });
});

describe("turn costs", () => {
  /**
   * S --a-- J --c-- K
   *         |      /
   *         b    d
   *         |  /
   *         T
   *
   * S (0,0), J (100,0), K (200,0), T (100,100). Via b is 200 m with a left
   * turn at J; via c and d is about 334.5 m and goes straight through J (the
   * sharp bend at K is not a junction, so it is free).
   */
  const roads = layer("roads", [
    line(
      [
        [0, 0],
        [100, 0],
      ],
      { id: "a" },
    ),
    line(
      [
        [100, 0],
        [100, 100],
      ],
      { id: "b" },
    ),
    line(
      [
        [100, 0],
        [200, 0],
      ],
      { id: "c" },
    ),
    line(
      [
        [200, 0],
        [100, 100],
      ],
      { id: "d" },
    ),
  ]);
  const stops = layer("stops", [point(0, 0), point(100, 100)]);
  const around = 200 + Math.hypot(100, 100);
  const route = async (parameters: Record<string, unknown>, extra: GeoLibreLayer[] = []) => {
    const { results, messages } = await run(localShortestPathTool, [roads, stops, ...extra], {
      network: "roads",
      stops: "stops",
      ...parameters,
    });
    assert.equal(results.length, 1, messages.join("\n"));
    return results[0].geojson.features[0];
  };

  it("avoids a left turn that costs more than the detour", async () => {
    const leg = await route({ turns: "rules", leftTurnCost: 150 });
    assert.ok(Math.abs((leg.properties?.cost as number) - around) < 0.01);
    assert.ok(Math.abs((leg.properties?.length_m as number) - around) < 0.01);
    assert.deepEqual(metres((leg.geometry as LineString).coordinates)[2], [200, 0]);
  });

  it("keeps the left turn when it costs less than the detour, and counts it", async () => {
    const leg = await route({ turns: "rules", leftTurnCost: 100 });
    assert.ok(Math.abs((leg.properties?.cost as number) - 300) < 0.01);
    assert.ok(Math.abs((leg.properties?.length_m as number) - 200) < 0.01);
  });

  it("charges a right turn cost only on right turns", async () => {
    const leg = await route({ turns: "rules", rightTurnCost: 500 });
    assert.ok(Math.abs((leg.properties?.cost as number) - 200) < 0.01);
    const reversed = {
      ...stops,
      geojson: { ...stops.geojson!, features: [...stops.geojson!.features].reverse() },
    };
    const { results } = await run(localShortestPathTool, [roads, reversed], {
      network: "roads",
      stops: "stops",
      turns: "rules",
      rightTurnCost: 100,
    });
    assert.ok(Math.abs((results[0].geojson.features[0].properties?.cost as number) - 300) < 0.01);
    assert.ok(
      Math.abs((results[0].geojson.features[0].properties?.length_m as number) - 200) < 0.01,
    );
  });

  it("adds a turn table cost and lets it change the route", async () => {
    const table = layer("turns", [turn("a", "b", { penalty: 180 }), turn("x", "y")]);
    const { results, messages } = await run(localShortestPathTool, [roads, stops, table], {
      network: "roads",
      stops: "stops",
      ...TURN_TABLE,
      turnCostField: "penalty",
    });
    const leg = results[0].geojson.features[0];
    assert.ok(Math.abs((leg.properties?.cost as number) - around) < 0.01);
    assert.ok(
      messages.some((m) =>
        m.includes("1 row(s) matched (0 prohibited, 1 with a cost), 1 row(s) name no network line"),
      ),
      messages.join("\n"),
    );
  });

  it("treats a blank cost in the cost field as a prohibition", async () => {
    const table = layer("turns", [turn("a", "b", { penalty: "" })]);
    const leg = await route({ ...TURN_TABLE, turnCostField: "penalty" }, [table]);
    assert.ok(Math.abs((leg.properties?.cost as number) - around) < 0.01);
  });
});

describe("turn cost edge cases", () => {
  it("uses one adjacency budget for every search in each local tool run", async () => {
    // The tools search through searchChunked, which yields between chunks.
    const original = LocalNetwork.prototype.searchChunked;
    const budgets: (NetworkSearchBudget | undefined)[] = [];
    const search = mock.method(
      LocalNetwork.prototype,
      "searchChunked",
      function (this: LocalNetwork, ...args: Parameters<typeof original>) {
        budgets.push(args[1]?.budget);
        return original.apply(this, args);
      },
    );
    try {
      const stops = layer("stops", [point(0, 0), point(100, 100), point(200, 0)]);
      const incidents = layer("incidents", [point(0, 0), point(100, 100)]);
      const facilities = layer("facilities", [point(200, 0), point(100, 100)]);
      let previous: NetworkSearchBudget | undefined;
      for (const tool of [localShortestPathTool, localClosestFacilityTool, localServiceAreaTool]) {
        budgets.length = 0;
        const { results, messages } = await run(tool, [STREETS, stops, incidents, facilities], {
          network: "streets",
          stops: "stops",
          incidents: "incidents",
          facilities: "facilities",
          breaks: "100",
          overlap: "separate",
          polygonWidth: 0,
          turns: "rules",
          uturnCost: 1,
        });
        assert.ok(results.length > 0, messages.join("\n"));
        assert.ok(budgets.length >= 2, tool.id);
        assert.ok(budgets[0]);
        assert.ok(
          budgets.every((budget) => budget === budgets[0]),
          tool.id,
        );
        assert.notEqual(budgets[0], previous);
        previous = budgets[0];
      }
    } finally {
      search.mock.restore();
    }
  });

  it("refuses a configured turn table that has been deleted", async () => {
    const { results, messages } = await run(localShortestPathTool, [STREETS, S_TO_N], {
      network: "streets",
      stops: "stops",
      ...TURN_TABLE,
    });
    assert.equal(results.length, 0);
    assert.ok(
      messages.some((message) => message.includes("turn table layer is no longer available")),
    );
  });

  it("charges settled adjacency entries in forward and reverse turn searches", () => {
    const net = buildLocalNetwork([
      line([
        [0, 0],
        [100, 0],
      ]),
    ]);
    net.setTurnRules({ uturnCost: 1 });
    for (const reverse of [false, true]) {
      assert.throws(
        () => net.search([0], { reverse, budget: { remainingAdjacencyVisits: 2 } }),
        /adjacency.*budget/,
      );
      const budget = { remainingAdjacencyVisits: 3 };
      assert.ok(Number.isFinite(net.search([0], { reverse, budget }).dist[1]));
      assert.equal(budget.remainingAdjacencyVisits, 0);
    }
  });

  it("shares adjacency work across repeated searches and shortest-path legs", () => {
    const net = buildLocalNetwork([
      line([
        [0, 0],
        [100, 0],
      ]),
    ]);
    const budget = { remainingAdjacencyVisits: 3 };
    net.search([0], { budget });
    assert.equal(budget.remainingAdjacencyVisits, 1);
    assert.throws(() => net.search([0], { budget }), /adjacency.*budget/);
    assert.throws(
      () => net.shortestPath(0, 1, true, { remainingAdjacencyVisits: 0 }),
      /adjacency.*budget/,
    );
    assert.ok(net.shortestPath(0, 1));
    assert.ok(net.shortestPath(0, 1));
  });

  it("does not charge a bend in one line where a side line joins", async () => {
    // One line bends left 90 degrees at (100, 0), where a spur also starts.
    const bend = layer("roads", [
      line(
        [
          [0, 0],
          [100, 0],
          [100, 100],
        ],
        { id: "main" },
      ),
      line(
        [
          [100, 0],
          [200, 0],
        ],
        { id: "spur" },
      ),
    ]);
    const stops = layer("stops", [point(0, 0), point(100, 100)]);
    const { results } = await run(localShortestPathTool, [bend, stops], {
      network: "roads",
      stops: "stops",
      turns: "rules",
      leftTurnCost: 500,
      rightTurnCost: 500,
    });
    assert.ok(Math.abs((results[0].geojson.features[0].properties?.cost as number) - 200) < 0.01);
  });

  it("accepts decimal text costs with leading or trailing decimal points", async () => {
    for (const [text, penalty] of [
      [".5", 0.5],
      ["1.", 1],
      [".5e2", 50],
      [" +.5 ", 0.5],
    ] as const) {
      const table = layer("turns", [turn("a", "b", { penalty: text })]);
      const { results } = await run(localShortestPathTool, [STREETS, S_TO_N, table], {
        network: "streets",
        stops: "stops",
        ...TURN_TABLE,
        turnCostField: "penalty",
      });
      const leg = results[0].geojson.features[0];
      assert.ok(Math.abs((leg.properties?.cost as number) - (200 + penalty)) < 0.01, text);
    }
  });

  it("prohibits a turn whose cost cell is hexadecimal text", async () => {
    const table = layer("turns", [turn("a", "b", { penalty: "0x1A" })]);
    const { results } = await run(localShortestPathTool, [STREETS, S_TO_N, table], {
      network: "streets",
      stops: "stops",
      ...TURN_TABLE,
      turnCostField: "penalty",
    });
    const cost = results[0].geojson.features[0].properties?.cost as number;
    assert.ok(Math.abs(cost - DETOUR) < 0.01);
  });

  it("treats a negative or NaN table cost passed to setTurnRules as a prohibition", () => {
    for (const bad of [-1, Number.NaN]) {
      const net = buildLocalNetwork(STREETS.geojson!.features);
      const s = net.insertPoint(0, 0)!.node;
      const n = net.insertPoint(deg(100), deg(100))!.node;
      net.setTurnRules({ table: [{ from: 0, to: 1, cost: bad }] });
      const path = net.shortestPath(s, n);
      assert.ok(path && Math.abs(path.cost - DETOUR) < 0.01, String(bad));
    }
  });
});

describe("turn rule parameters", () => {
  it("leaves results unchanged when turn rules are off or set nothing", async () => {
    const params = { network: "streets", stops: "stops" };
    const base = await run(localShortestPathTool, [STREETS, S_TO_N], params);
    const off = await run(localShortestPathTool, [STREETS, S_TO_N, NO_LEFT], {
      ...params,
      ...TURN_TABLE,
      turns: "none",
    });
    assert.deepEqual(off.results, base.results);
    const empty = await run(localShortestPathTool, [STREETS, S_TO_N], {
      ...params,
      turns: "rules",
      leftTurnCost: 0,
      rightTurnCost: 0,
      uturns: "allow",
    });
    assert.deepEqual(empty.results, base.results);
    assert.ok(empty.messages.includes("Turn rules are on but set no restriction or cost."));
  });

  it("asks for the id and from/to fields when a turn table is chosen", async () => {
    const { results, messages } = await run(localShortestPathTool, [STREETS, S_TO_N, NO_LEFT], {
      network: "streets",
      stops: "stops",
      turns: "rules",
      turnTable: "turns",
    });
    assert.equal(results.length, 0);
    assert.ok(messages.some((m) => m.startsWith("Error: a turn table needs")));
  });

  it("rejects negative turn costs", async () => {
    const { messages } = await run(localShortestPathTool, [STREETS, S_TO_N], {
      network: "streets",
      stops: "stops",
      turns: "rules",
      leftTurnCost: -5,
    });
    assert.ok(messages.includes("Error: turn costs must be zero or a positive number"));
  });

  it("knows which rules change routing", () => {
    assert.equal(turnRulesActive(null), false);
    assert.equal(turnRulesActive({ leftCost: 0, uturns: "allow", table: [] }), false);
    assert.equal(turnRulesActive({ uturns: "junctions" }), true);
    assert.equal(turnRulesActive({ rightCost: 1 }), true);
    assert.equal(turnRulesActive({ table: [{ from: 0, to: 1, cost: 0 }] }), true);
  });
});

/** Square grid of `n` x `n` nodes `spacing` metres apart, one feature per segment. */
function grid(n: number, spacing: number, cost: (i: number) => number): Feature[] {
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
            { cost: cost(k++) },
          ),
        );
      if (j + 1 < n)
        features.push(
          line(
            [
              [x, y],
              [x, y + spacing],
            ],
            { cost: cost(k++) },
          ),
        );
    }
  }
  return features;
}

describe("directed-edge search", () => {
  it("matches the node search when the turn rules cost nothing", () => {
    // A zero-cost table entry activates the directed-edge search without
    // changing any cost, so every pair must match the node search exactly.
    const features = grid(6, 100, (i) => 100 + ((i * 7919) % 97) * 3);
    const plain = buildLocalNetwork(features, { costMode: "field", costField: "cost" });
    const turned = buildLocalNetwork(features, { costMode: "field", costField: "cost" });
    turned.setTurnRules({ table: [{ from: 0, to: 1, cost: 0 }] });
    assert.equal(turned.hasTurnRules, true);
    assert.equal(turned.searchStateCount, 2 * turned.edges.length);
    for (let s = 0; s < plain.nodeCount; s += 5) {
      for (const astar of [true, false]) {
        for (let t = 0; t < plain.nodeCount; t += 3) {
          const a = plain.shortestPath(s, t, astar);
          const b = turned.shortestPath(s, t, astar);
          assert.ok(a && b);
          assert.ok(Math.abs(a.cost - b.cost) < 1e-6, `${s}->${t}: ${a.cost} vs ${b.cost}`);
          assert.ok(Math.abs(a.length - b.length) < 1e-6);
          assert.equal(b.nodes[0], s);
          assert.equal(b.nodes[b.nodes.length - 1], t);
        }
      }
      for (const reverse of [false, true]) {
        const a = plain.search([s], { reverse, maxCost: 600 });
        const b = turned.search([s], { reverse, maxCost: 600 });
        assert.deepEqual(
          Array.from(b.dist, (d) => (Number.isFinite(d) ? Math.round(d * 1e6) : -1)),
          Array.from(a.dist, (d) => (Number.isFinite(d) ? Math.round(d * 1e6) : -1)),
        );
        const round = (pieces: Position[][]) =>
          pieces.map((piece) => piece.map(([x, y]) => [x.toFixed(12), y.toFixed(12)]).join());
        assert.deepEqual(
          round(turned.reachableSegments(b, 450, reverse)).sort(),
          round(plain.reachableSegments(a, 450, reverse)).sort(),
        );
      }
    }
  });

  it("returns a one-node path from a node to itself", () => {
    const net = buildLocalNetwork(STREETS.geojson!.features);
    net.setTurnRules({ uturns: "never" });
    const path = net.shortestPath(0, 0);
    assert.ok(path);
    assert.deepEqual(path.nodes, [0]);
    assert.equal(path.cost, 0);
  });
});
