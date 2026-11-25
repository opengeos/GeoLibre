// The vector tools that run on the Turf tool worker, by id. Both sides read
// this: vector-tool-runner.ts to decide what to post, and the worker session
// (vector-tool-protocol.ts) to resolve the posted id. It imports the tools from
// vector-tools.ts directly rather than through the registry, so the worker
// bundle carries the supported Turf, spatial-statistics and local network
// tools, excluding the DGGS and topology modules from the full registry.
import type { ProcessingAlgorithm } from "./types";
import {
  olsRegressionTool,
  gwrTool,
  dbscanTool,
  hdbscanTool,
  krigingDiagnosticsTool,
} from "./statistics-tools";
import {
  localClosestFacilityTool,
  localServiceAreaTool,
  localShortestPathTool,
} from "./local-network-tools";
import {
  aggregateTool,
  attributeJoinTool,
  boundingBoxTool,
  bufferTool,
  cellSectorsTool,
  centroidsTool,
  clipTool,
  convexHullTool,
  decodePolylineTool,
  detectStopsTool,
  differenceTool,
  dissolveTool,
  encodePolylineTool,
  explodeTool,
  extractVerticesTool,
  gridTool,
  intersectionTool,
  mergeLayersTool,
  pointsAlongGeometryTool,
  randomExtractTool,
  selectByLocationTool,
  selectByValueTool,
  simplifyTool,
  smoothTool,
  spaceTimeProximityTool,
  spatialJoinTool,
  summarizeWithinTool,
  trajectorySpeedTool,
  unionTool,
  voronoiTool,
} from "./vector-tools";

/**
 * The pure FeatureCollection-in/out Turf tools, whose only reach outside their
 * parameters is the layers they read and the viewport (snapshotted into the
 * request). The local network tools qualify too: graph construction, point
 * placement and the searches are plain computation over the input layers, so
 * the whole run, not only its searches, leaves the interface thread. The
 * Valhalla network tools stay on the main thread: they wait on the network,
 * not the CPU, and their consent check is a main-thread concern.
 *
 * Kept as an explicit list so a new tool runs on the main thread until someone
 * checks it is worker-safe. Left out on purpose: the DGGS and topology tools,
 * which query the host's DuckDB capability (a main-thread object), and
 * `reproject`, whose client `run` only logs a pointer to the Python engines.
 */
export const WORKER_VECTOR_TOOLS: ReadonlyMap<string, ProcessingAlgorithm> = new Map(
  [
    olsRegressionTool,
    gwrTool,
    dbscanTool,
    hdbscanTool,
    krigingDiagnosticsTool,
    localShortestPathTool,
    localClosestFacilityTool,
    localServiceAreaTool,
    bufferTool,
    centroidsTool,
    convexHullTool,
    dissolveTool,
    boundingBoxTool,
    simplifyTool,
    clipTool,
    intersectionTool,
    differenceTool,
    unionTool,
    spatialJoinTool,
    summarizeWithinTool,
    attributeJoinTool,
    selectByValueTool,
    selectByLocationTool,
    randomExtractTool,
    explodeTool,
    aggregateTool,
    smoothTool,
    extractVerticesTool,
    pointsAlongGeometryTool,
    gridTool,
    voronoiTool,
    cellSectorsTool,
    trajectorySpeedTool,
    detectStopsTool,
    spaceTimeProximityTool,
    mergeLayersTool,
    decodePolylineTool,
    encodePolylineTool,
  ].map((tool) => [tool.id, tool]),
);

/** The ids of {@link WORKER_VECTOR_TOOLS}. */
export const WORKER_VECTOR_TOOL_IDS: ReadonlySet<string> = new Set(WORKER_VECTOR_TOOLS.keys());
