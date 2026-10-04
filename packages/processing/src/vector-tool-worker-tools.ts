// The vector tools that run on the Turf tool worker, by id. Both sides read
// this: vector-tool-runner.ts to decide what to post, and the worker session
// (vector-tool-protocol.ts) to resolve the posted id. It imports the tools from
// vector-tools.ts directly rather than through the registry, so the worker
// bundle carries only the Turf tools, not the DGGS and topology modules the
// full registry lists.
import type { ProcessingAlgorithm } from "./types";
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
  trajectorySpeedTool,
  unionTool,
  voronoiTool,
} from "./vector-tools";

/**
 * The pure FeatureCollection-in/out Turf tools, whose only reach outside their
 * parameters is the layers they read and the viewport (snapshotted into the
 * request).
 *
 * Kept as an explicit list so a new tool runs on the main thread until someone
 * checks it is worker-safe. Left out on purpose: the DGGS and topology tools,
 * which query the host's DuckDB capability (a main-thread object), and
 * `reproject`, whose client `run` only logs a pointer to the Python engines.
 */
export const WORKER_VECTOR_TOOLS: ReadonlyMap<string, ProcessingAlgorithm> = new Map(
  [
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
