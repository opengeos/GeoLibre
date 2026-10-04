// The vector tool registry: every tool the Vector Tools dialog lists, in menu
// order. Kept apart from vector-tools.ts, which defines the Turf tools, so the
// Turf tool worker (vector-tool.worker.ts) can import those tools without the
// DGGS and topology modules (and their wasm/S2/DGGAL dependencies) that this
// list pulls in.
import type { ProcessingAlgorithm } from "./types";
import { createDggsGridTool, dggsBinPointsTool, dggsCompactTool } from "./dggs-tools";
import { TOPOLOGY_TOOLS } from "./topology-tools";
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
  reprojectTool,
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

export const VECTOR_TOOLS: ProcessingAlgorithm[] = [
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
  reprojectTool,
  explodeTool,
  aggregateTool,
  smoothTool,
  extractVerticesTool,
  pointsAlongGeometryTool,
  gridTool,
  voronoiTool,
  cellSectorsTool,
  decodePolylineTool,
  encodePolylineTool,
  createDggsGridTool,
  dggsBinPointsTool,
  dggsCompactTool,
  // Movement & time tools come after DGGS so the dialog's group order (derived
  // from this array) matches the Processing → Vector menu order.
  trajectorySpeedTool,
  detectStopsTool,
  spaceTimeProximityTool,
  mergeLayersTool,
  // Data-quality tools (validity + topology rules) last, matching the menu.
  ...TOPOLOGY_TOOLS,
];

export function getVectorTool(id: string): ProcessingAlgorithm | undefined {
  return VECTOR_TOOLS.find((tool) => tool.id === id);
}

/**
 * Old H3 processing tool IDs from history entries written before the DGGS
 * rename. Map them onto the current tools and default `dggsType` to `"h3"`.
 */
const H3_VECTOR_TOOL_ALIASES: Readonly<Record<string, string>> = {
  "h3-grid": "dggs-grid",
  "h3-bin-points": "dggs-bin",
};

/**
 * Resolve a vector History re-run's tool id (and parameters) for today's
 * registry. Unknown ids pass through unchanged so the dialog can still report
 * "tool unavailable".
 */
export function resolveVectorRerun(
  toolId: string,
  parameters: Record<string, unknown> = {},
): { toolId: string; parameters: Record<string, unknown> } {
  const mapped = H3_VECTOR_TOOL_ALIASES[toolId];
  if (!mapped) return { toolId, parameters };
  return {
    toolId: mapped,
    parameters: {
      ...parameters,
      dggsType: parameters.dggsType ?? "h3",
    },
  };
}
