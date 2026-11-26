import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { getActiveMeanRadiusMeters } from "@geolibre/core";
import {
  buildLocalNetwork,
  createNetworkSearchBudget,
  createWasmNetworkEngine,
  LocalNetwork,
  type RoutingWasmModule,
  getNetworkSearchEngine,
  loadWasmNetworkEngine,
  setNetworkSearchEngine,
  installWasmNetworkEngine,
  type NetworkSearchBudget,
  type NetworkSearchEngine,
  type NetworkSearchOptions,
  type SearchResult,
  type TurnRules,
} from "@geolibre/processing";
import type { Feature } from "geojson";

// The WebAssembly network engine (geolibre-wasm's RoutingGraph) must return
// exactly what the JS search returns: same costs, same predecessor links (so
// the same paths), same settled facilities and the same budget use. This file
// checks that three ways: randomized networks searched by both engines, the
// chunked runner, and every routing test in local-network.test.ts and
// local-network-turns.test.ts re-run with an engine that runs each search in
// both engines and compares them.

// In the browser wasm-bindgen fetches the bundled asset; under node:test it
// gets the wasm bytes directly.
const wasmPath = fileURLToPath(
  new URL("../node_modules/geolibre-wasm/geolibre_wasm_bg.wasm", import.meta.url),
);
// A package without this file cannot have RoutingGraph either; skip, not fail.
const wasm = existsSync(wasmPath)
  ? await loadWasmNetworkEngine(new Uint8Array(readFileSync(wasmPath)))
  : null;
const skip = wasm ? false : "the installed geolibre-wasm has no RoutingGraph";

/** Asserts two typed arrays hold the same values (NaN-free, Infinity-aware). */
function sameArray(actual: ArrayLike<number>, expected: ArrayLike<number>, what: string): void {
  assert.equal(actual.length, expected.length, `${what} length`);
  for (let i = 0; i < expected.length; i++) {
    if (!Object.is(actual[i], expected[i])) {
      assert.fail(`${what}[${i}]: WASM ${actual[i]}, JS ${expected[i]}`);
    }
  }
}

/** Asserts a WASM search result equals the JS one. */
function sameResult(actual: SearchResult, expected: SearchResult): void {
  sameArray(actual.dist, expected.dist, "dist");
  sameArray(actual.prevEdge, expected.prevEdge, "prevEdge");
  sameArray(actual.prevNode, expected.prevNode, "prevNode");
  assert.equal(!!actual.turns, !!expected.turns, "turn state presence");
  if (actual.turns && expected.turns) {
    sameArray(actual.turns.entry, expected.turns.entry, "entry");
    sameArray(actual.turns.prevState, expected.turns.prevState, "prevState");
    sameArray(actual.turns.bestState, expected.turns.bestState, "bestState");
    assert.equal(actual.turns.reverse, expected.turns.reverse);
  }
  assert.deepEqual(actual.settledTargets, expected.settledTargets, "settledTargets");
}

/**
 * Wraps the WASM engine so every search also runs in JS and the two must
 * agree, including on budget use and on a budget overrun.
 */
function verifyingEngine(inner: NetworkSearchEngine) {
  const stats = { compared: 0, turnSearches: 0, overruns: 0 };
  const engine: NetworkSearchEngine = {
    name: inner.name,
    start(net, sources, options, budget) {
      // A JS callback runs only in JS; don't run it twice.
      if (options.onSettle) return null;
      const jsBudget: NetworkSearchBudget = { ...budget };
      let expected: SearchResult | undefined;
      let jsError: unknown;
      try {
        expected = net.searchJs(sources, { ...options, budget: jsBudget });
      } catch (error) {
        jsError = error;
      }
      const run = inner.start(net, sources, options, budget);
      assert.ok(run, "the WASM engine should take every search without a callback");
      return {
        step(maxVisits) {
          try {
            return run.step(maxVisits);
          } catch (error) {
            assert.ok(jsError instanceof RangeError, `WASM threw but JS did not: ${error}`);
            assert.ok(error instanceof RangeError);
            assert.equal(error.message, jsError.message);
            assert.equal(budget.remainingAdjacencyVisits, jsBudget.remainingAdjacencyVisits);
            stats.overruns++;
            throw error;
          }
        },
        result() {
          assert.equal(jsError, undefined, `JS threw but WASM did not: ${jsError}`);
          const result = run.result();
          sameResult(result, expected!);
          assert.equal(budget.remainingAdjacencyVisits, jsBudget.remainingAdjacencyVisits);
          stats.compared++;
          if (result.turns) stats.turnSearches++;
          return result;
        },
        dispose: () => run.dispose(),
      };
    },
  };
  return { engine, stats };
}

/** Deterministic PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Degrees spanning `m` metres at the equator. */
function deg(m: number): number {
  return m / ((getActiveMeanRadiusMeters() * Math.PI) / 180);
}

/**
 * A jittered street grid of `size` x `size` intersections, one feature per
 * block edge, with random speeds, some one-way and closed streets, and a few
 * diagonals, so searches see ties, dead ends and unreachable nodes.
 */
function randomStreets(seed: number, size: number): { features: Feature[]; random: () => number } {
  const random = prng(seed);
  const at = (x: number, y: number): [number, number] => [
    deg(x * 100 + (random() - 0.5) * 30),
    deg(y * 100 + (random() - 0.5) * 30),
  ];
  const points: [number, number][][] = [];
  for (let y = 0; y < size; y++) {
    points.push([]);
    for (let x = 0; x < size; x++) points[y].push(at(x, y));
  }
  const features: Feature[] = [];
  const street = (a: [number, number], b: [number, number]) => {
    const roll = random();
    features.push({
      type: "Feature",
      properties: {
        id: `s${features.length}`,
        speed: [30, 50, 50, 80][Math.floor(random() * 4)],
        oneway: roll < 0.15 ? "yes" : roll < 0.25 ? "-1" : roll < 0.28 ? "closed" : "no",
      },
      geometry: { type: "LineString", coordinates: [a, b] },
    });
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x + 1 < size) street(points[y][x], points[y][x + 1]);
      if (y + 1 < size) street(points[y][x], points[y + 1][x]);
      if (x + 1 < size && y + 1 < size && random() < 0.1)
        street(points[y][x], points[y + 1][x + 1]);
    }
  }
  return { features, random };
}

/** Random turn rules over `features`: a turn table plus turn costs. */
function randomTurnRules(random: () => number, features: number): TurnRules {
  const table: TurnRules["table"] = [];
  for (let i = 0; i < features; i++) {
    if (random() < 0.3) {
      const to = Math.floor(random() * features);
      table.push({ from: i, to, cost: random() < 0.5 ? Infinity : random() * 0.5 });
    }
  }
  const policies = ["allow", "junctions", "dead-ends", "never"] as const;
  return {
    table,
    leftCost: random() < 0.7 ? random() * 0.3 : 0,
    rightCost: random() < 0.7 ? random() * 0.2 : 0,
    uturnCost: random() * 0.5,
    uturns: policies[Math.floor(random() * policies.length)],
    straightAngle: random() < 0.5 ? 30 : random() * 60,
  };
}

/** Runs one search in both engines and asserts they agree. */
function compare(
  net: LocalNetwork,
  sources: number[],
  options: NetworkSearchOptions,
): SearchResult {
  const jsBudget = createNetworkSearchBudget();
  const wasmBudget = createNetworkSearchBudget();
  const expected = net.searchJs(sources, { ...options, budget: jsBudget });
  const run = wasm!.start(net, sources, options, wasmBudget);
  assert.ok(run);
  try {
    assert.equal(run.step(Infinity), true);
    const actual = run.result();
    sameResult(actual, expected);
    assert.equal(wasmBudget.remainingAdjacencyVisits, jsBudget.remainingAdjacencyVisits);
    return actual;
  } finally {
    run.dispose();
  }
}

describe("WASM network engine", { skip }, () => {
  it("matches the JS search on random networks, with and without turn rules", () => {
    let reached = 0;
    let turnSearches = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const { features, random } = randomStreets(seed, 6 + (seed % 5));
      const net = buildLocalNetwork(features, {
        costMode: seed % 3 === 0 ? "length" : "speed",
        costField: "speed",
        directionField: "oneway",
        snapToleranceM: seed % 2 ? 5 : 0,
      });
      // Split a few edges with inserted points, as the tools do.
      for (let i = 0; i < 4; i++) net.insertPoint(deg(random() * 500), deg(random() * 500));
      if (seed % 2 === 0) {
        net.setTurnRules(randomTurnRules(random, features.length));
        assert.ok(net.hasTurnRules);
      }
      const n = net.nodeCount;
      const pick = () => Math.floor(random() * n);
      for (let k = 0; k < 6; k++) {
        const source = pick();
        const target = pick();
        const reverse = random() < 0.4;
        // Dijkstra, A* to a target, a capped search, and a multi-source one.
        const full = compare(net, [source], { reverse });
        reached += full.dist.filter(Number.isFinite).length;
        compare(net, [source], { target, astar: true, reverse });
        compare(net, [source], { target, astar: false, reverse });
        compare(net, [source], { maxCost: random() * 2, reverse });
        compare(net, [source, pick(), source], { maxCost: random() * 3 });
        // Closest-facility style stop on weighted nodes.
        const weights = new Uint32Array(n);
        for (let f = 0; f < 5; f++) weights[pick()] += 1 + Math.floor(random() * 2);
        const stopped = compare(net, [source], {
          stopAt: { weights, count: 1 + Math.floor(random() * 4) },
          reverse,
        });
        assert.ok(stopped.settledTargets);
        if (full.turns) turnSearches++;
      }
    }
    assert.ok(reached > 1000, `searches reached only ${reached} nodes`);
    assert.ok(turnSearches > 30);
  });

  it("A* returns the Dijkstra optimum", () => {
    const { features, random } = randomStreets(99, 12);
    const net = buildLocalNetwork(features, { costMode: "speed", costField: "speed" });
    for (let k = 0; k < 20; k++) {
      const s = Math.floor(random() * net.nodeCount);
      const t = Math.floor(random() * net.nodeCount);
      const a = compare(net, [s], { target: t, astar: true });
      const d = compare(net, [s], { target: t });
      assert.equal(a.dist[t], d.dist[t]);
    }
  });

  it("runs in chunks to the same result and charges the shared budget", async () => {
    const { features } = randomStreets(7, 10);
    const net = buildLocalNetwork(features, { costMode: "speed", costField: "speed" });
    const previous = getNetworkSearchEngine();
    setNetworkSearchEngine(wasm);
    try {
      const whole = net.searchJs([0]);
      let yields = 0;
      const budget = createNetworkSearchBudget();
      const chunked = await net.searchChunked(
        [0],
        { budget },
        { yieldToHost: async () => void yields++, aborted: () => false, chunk: 5 },
      );
      assert.ok(chunked);
      sameResult(chunked, whole);
      assert.ok(yields > 10, `only ${yields} yields`);
      const jsBudget = createNetworkSearchBudget();
      net.searchJs([0], { budget: jsBudget });
      assert.equal(budget.remainingAdjacencyVisits, jsBudget.remainingAdjacencyVisits);

      // Cancelling between chunks abandons the search.
      let calls = 0;
      const aborted = await net.searchChunked(
        [0],
        {},
        { yieldToHost: async () => void calls++, aborted: () => calls >= 2, chunk: 5 },
      );
      assert.equal(aborted, null);
      assert.equal(calls, 2);
    } finally {
      setNetworkSearchEngine(previous);
    }
  });

  it("throws the JS budget error and leaves the budget at zero", () => {
    const { features } = randomStreets(3, 8);
    const net = buildLocalNetwork(features, {});
    const budget = createNetworkSearchBudget(25);
    const run = wasm!.start(net, [0], {}, budget);
    assert.ok(run);
    try {
      assert.throws(
        () => run.step(Infinity),
        (error: unknown) =>
          error instanceof RangeError && /adjacency work budget exceeded/.test(error.message),
      );
      assert.equal(budget.remainingAdjacencyVisits, 0);
    } finally {
      run.dispose();
    }
  });

  it("rebuilds its graph copy when the network changes", () => {
    const { features } = randomStreets(5, 6);
    const net = buildLocalNetwork(features, { costMode: "length" });
    compare(net, [0], {});
    // Point placement splits an edge; edge cost edits are announced by touch().
    net.insertPoint(deg(250), deg(250));
    compare(net, [0], {});
    net.edges[0].costAB = 1e6;
    net.touch();
    compare(net, [0], {});
    net.setTurnRules({ uturns: "never", leftCost: 5 });
    compare(net, [0], { reverse: true });
    net.setTurnRules(null);
    compare(net, [0], {});
  });

  it("remembers a graph it rejects instead of copying it in again", async () => {
    const mod = (await import("geolibre-wasm")) as unknown as RoutingWasmModule;
    let builds = 0;
    const counted: RoutingWasmModule = {
      RoutingGraph: class extends mod.RoutingGraph {
        constructor(...args: ConstructorParameters<RoutingWasmModule["RoutingGraph"]>) {
          builds++;
          super(...args);
        }
      },
    };
    const engine = createWasmNetworkEngine(counted);
    // A NaN cost is rejected by the WASM graph validation.
    const net = new LocalNetwork();
    const a = net.addNode(0, 0);
    const b = net.addNode(0.001, 0);
    net.addEdge({ a, b, costAB: Number.NaN, costBA: 1, length: 111, feature: 0 });
    assert.equal(engine.prepare?.(net), false);
    for (let i = 0; i < 3; i++) {
      assert.equal(engine.start(net, [a], {}, createNetworkSearchBudget()), null);
    }
    assert.equal(builds, 1);
    // A change gives the next search a fresh attempt.
    net.edges[0].costAB = 1;
    net.touch();
    assert.equal(engine.prepare?.(net), true);
    assert.equal(builds, 2);
  });

  it("leaves callback searches to the JS engine", () => {
    const { features } = randomStreets(5, 6);
    const net = buildLocalNetwork(features, {});
    assert.equal(
      wasm!.start(net, [0], { onSettle: () => false }, createNetworkSearchBudget()),
      null,
    );
  });

  it("is the engine the tools install", async () => {
    const previous = getNetworkSearchEngine();
    setNetworkSearchEngine(null);
    try {
      assert.equal(await installWasmNetworkEngine(), wasm);
      assert.equal(getNetworkSearchEngine(), wasm);
    } finally {
      setNetworkSearchEngine(previous);
    }
  });
});

// Re-run the routing suites with every search checked in both engines.
if (wasm) {
  const { engine, stats } = verifyingEngine(wasm);
  setNetworkSearchEngine(engine);
  await import("./local-network.test.ts");
  await import("./local-network-turns.test.ts");
  describe("WASM engine cross-check over the routing suites", () => {
    it("compared the searches of both suites", () => {
      assert.ok(stats.compared > 40, `only ${stats.compared} searches compared`);
      assert.ok(stats.turnSearches > 10, `only ${stats.turnSearches} turn searches compared`);
    });
  });
}
