// WebAssembly search engine for the local network tools (#3530). The graph is
// built, snapped and split in local-network.ts; this module copies it into the
// `RoutingGraph` class of the main geolibre-wasm module (the same wasm-bindgen
// binary the COG converter loads, not the WASI tool runner) and runs the
// Dijkstra / A* / directed-edge searches there. The Rust search mirrors the JS
// one step for step, so results are identical and the JS search stays the
// fallback whenever the module is unavailable (an older geolibre-wasm without
// `RoutingGraph`, or a failed download).
import { getActiveMeanRadiusMeters } from "@geolibre/core/worker-safe";
import {
  getNetworkSearchEngine,
  setNetworkSearchEngine,
  type LocalNetwork,
  type NetworkSearchBudget,
  type NetworkSearchEngine,
  type NetworkSearchOptions,
  type NetworkSearchRun,
  type SearchResult,
  type UTurnPolicy,
} from "./local-network";

/** The slice of the geolibre-wasm `RoutingSearch` class this engine uses. */
interface WasmRoutingSearch {
  run(maxVisits: number): boolean;
  readonly remaining_budget: number;
  readonly has_turns: boolean;
  dist(): Float64Array;
  prev_edge(): Int32Array;
  prev_node(): Int32Array;
  entry(): Float64Array;
  prev_state(): Int32Array;
  best_state(): Int32Array;
  settled_targets(): Uint32Array;
  free(): void;
}

/** The slice of the geolibre-wasm `RoutingGraph` class this engine uses. */
interface WasmRoutingGraph {
  set_turn_rules(
    leftCost: number,
    rightCost: number,
    uturnCost: number,
    uturnPolicy: number,
    straightAngle: number,
    tableFrom: Uint32Array,
    tableTo: Uint32Array,
    tableCost: Float64Array,
  ): void;
  clear_turn_rules(): void;
  start_search(
    sources: Uint32Array,
    target: number,
    astar: boolean,
    maxCost: number,
    reverse: boolean,
    radiusM: number,
    minCostPerMeter: number,
    stopWeights: Uint32Array | undefined,
    stopCount: number,
    budget: number,
  ): WasmRoutingSearch;
  free(): void;
}

/** The geolibre-wasm exports this engine needs. */
export interface RoutingWasmModule {
  RoutingGraph: new (
    lon: Float64Array,
    lat: Float64Array,
    edgeA: Uint32Array,
    edgeB: Uint32Array,
    costAB: Float64Array,
    costBA: Float64Array,
    edgeFeature: Uint32Array,
    adjOffsets: Uint32Array,
    adjEdges: Uint32Array,
  ) => WasmRoutingGraph;
}

const UTURN_CODES: Record<UTurnPolicy, number> = {
  allow: 0,
  junctions: 1,
  "dead-ends": 2,
  never: 3,
};

/** Copies a network into flat typed arrays, adjacency in CSR form. */
function graphArrays(net: LocalNetwork) {
  const n = net.nodeCount;
  const m = net.edges.length;
  const edgeA = new Uint32Array(m);
  const edgeB = new Uint32Array(m);
  const costAB = new Float64Array(m);
  const costBA = new Float64Array(m);
  const feature = new Uint32Array(m);
  net.edges.forEach((edge, i) => {
    edgeA[i] = edge.a;
    edgeB[i] = edge.b;
    costAB[i] = edge.costAB;
    costBA[i] = edge.costBA;
    feature[i] = edge.feature;
  });
  const adjOffsets = new Uint32Array(n + 1);
  let total = 0;
  for (let node = 0; node < n; node++) {
    adjOffsets[node] = total;
    total += net.adj[node].length;
  }
  adjOffsets[n] = total;
  const adjEdges = new Uint32Array(total);
  for (let node = 0; node < n; node++) adjEdges.set(net.adj[node], adjOffsets[node]);
  return {
    lon: Float64Array.from(net.lon),
    lat: Float64Array.from(net.lat),
    edgeA,
    edgeB,
    costAB,
    costBA,
    feature,
    adjOffsets,
    adjEdges,
  };
}

/** Copies the network's compiled turn rules into the WASM graph. */
function applyTurnRules(graph: WasmRoutingGraph, net: LocalNetwork): void {
  const rules = net.compiledTurnRules;
  if (!rules) {
    graph.clear_turn_rules();
    return;
  }
  const from: number[] = [];
  const to: number[] = [];
  const cost: number[] = [];
  for (const [a, row] of rules.table) {
    for (const [b, value] of row) {
      from.push(a);
      to.push(b);
      cost.push(value);
    }
  }
  graph.set_turn_rules(
    rules.leftCost,
    rules.rightCost,
    rules.uturnCost,
    UTURN_CODES[rules.uturns],
    rules.straightAngle,
    Uint32Array.from(from),
    Uint32Array.from(to),
    Float64Array.from(cost),
  );
}

/** Rethrows a WASM error (a string) as the RangeError the JS search throws. */
function rethrow(error: unknown): never {
  if (error instanceof Error) throw error;
  throw new RangeError(String(error));
}

/**
 * Creates a search engine over a loaded geolibre-wasm module.
 *
 * @param wasm - The initialized module exports.
 * @returns An engine for {@link setNetworkSearchEngine}.
 */
export function createWasmNetworkEngine(wasm: RoutingWasmModule): NetworkSearchEngine {
  // One WASM graph at a time: a tool run searches one network, so the copy
  // of the previous network (or of an older revision) is freed as soon as
  // another is needed rather than left to the garbage collector. A graph the
  // WASM side rejects is remembered as null for that revision, so its
  // searches go straight to JS instead of copying it in again.
  let cached: { net: LocalNetwork; revision: number; graph: WasmRoutingGraph | null } | null = null;
  const graphFor = (net: LocalNetwork): WasmRoutingGraph | null => {
    if (cached && cached.net === net && cached.revision === net.revision) return cached.graph;
    cached?.graph?.free();
    cached = null;
    let graph: WasmRoutingGraph | null = null;
    try {
      const a = graphArrays(net);
      graph = new wasm.RoutingGraph(
        a.lon,
        a.lat,
        a.edgeA,
        a.edgeB,
        a.costAB,
        a.costBA,
        a.feature,
        a.adjOffsets,
        a.adjEdges,
      );
      applyTurnRules(graph, net);
    } catch {
      // The WASM side validates every index and cost; a graph it rejects
      // still has a JS search.
      graph?.free();
      graph = null;
    }
    cached = { net, revision: net.revision, graph };
    return graph;
  };

  return {
    name: "WebAssembly",
    prepare(net: LocalNetwork): boolean {
      return graphFor(net) !== null;
    },
    start(
      net: LocalNetwork,
      sources: number[],
      options: NetworkSearchOptions,
      budget: NetworkSearchBudget,
    ): NetworkSearchRun | null {
      // A per-node JS callback cannot run inside WASM.
      if (options.onSettle) return null;
      const graph = graphFor(net);
      if (!graph) return null;
      let search: WasmRoutingSearch | null;
      try {
        search = graph.start_search(
          Uint32Array.from(sources),
          options.target ?? -1,
          options.astar === true,
          options.maxCost ?? Infinity,
          options.reverse === true,
          getActiveMeanRadiusMeters(),
          net.minCostPerMeter,
          options.stopAt?.weights,
          options.stopAt?.count ?? 0,
          budget.remainingAdjacencyVisits,
        );
      } catch {
        // Only out-of-range sources or targets are rejected here, which the
        // JS search handles the same way it always has.
        return null;
      }
      const reverse = options.reverse === true;
      const stopAt = options.stopAt !== undefined;
      const live = (): WasmRoutingSearch => {
        if (!search) throw new Error("The network search was disposed");
        return search;
      };
      return {
        step(maxVisits: number): boolean {
          const s = live();
          try {
            return s.run(maxVisits);
          } catch (error) {
            return rethrow(error);
          } finally {
            budget.remainingAdjacencyVisits = s.remaining_budget;
          }
        },
        result(): SearchResult {
          const s = live();
          const result: SearchResult = {
            dist: s.dist(),
            prevEdge: s.prev_edge(),
            prevNode: s.prev_node(),
          };
          if (s.has_turns) {
            result.turns = {
              entry: s.entry(),
              prevState: s.prev_state(),
              bestState: s.best_state(),
              reverse,
            };
          }
          if (stopAt) result.settledTargets = Array.from(s.settled_targets());
          return result;
        },
        dispose(): void {
          search?.free();
          search = null;
        },
      };
    },
  };
}

let enginePromise: Promise<NetworkSearchEngine | null> | null = null;

/**
 * Loads geolibre-wasm and returns its network engine, or null when the module
 * cannot be loaded or predates `RoutingGraph`. The outcome is remembered for
 * the thread's lifetime: the JS search is a complete fallback, so a failed
 * load is not retried on every run.
 *
 * @param moduleOrPath - Wasm bytes or URL for hosts where the default fetch
 *   does not work (Node tests); omitted in the browser.
 * @returns The engine, or null.
 */
export function loadWasmNetworkEngine(
  moduleOrPath?: ArrayBuffer | Uint8Array | URL | string,
): Promise<NetworkSearchEngine | null> {
  enginePromise ??= (async () => {
    try {
      const mod = await import("geolibre-wasm");
      const exports = mod as unknown as Partial<RoutingWasmModule>;
      if (typeof exports.RoutingGraph !== "function") return null;
      await mod.default(moduleOrPath === undefined ? undefined : { module_or_path: moduleOrPath });
      return createWasmNetworkEngine(exports as RoutingWasmModule);
    } catch {
      return null;
    }
  })();
  return enginePromise;
}

/**
 * Installs the WebAssembly engine for this thread's network searches unless an
 * engine is already set.
 *
 * @returns The engine searches will use, or null for the JS search.
 */
export async function installWasmNetworkEngine(): Promise<NetworkSearchEngine | null> {
  const current = getNetworkSearchEngine();
  if (current) return current;
  const engine = await loadWasmNetworkEngine();
  if (engine && !getNetworkSearchEngine()) setNetworkSearchEngine(engine);
  return getNetworkSearchEngine();
}
