// The edge layer of the Model Builder canvas.

import type { ProcessingModelGraph } from "@geolibre/core";
import type { ModelToolDescriptor } from "@geolibre/processing";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { cardLayout, portPosition, portsOf } from "./model-builder-layout";

/** SVG layer drawing every connection, plus the in-progress link. */
export function GraphEdges({
  graph,
  resolveDescriptor,
  linking,
  onRemoveEdge,
}: {
  graph: ProcessingModelGraph;
  resolveDescriptor: (provider?: string, toolId?: string) => ModelToolDescriptor | undefined;
  linking: { nodeId: string; portId: string; x: number; y: number } | null;
  onRemoveEdge: (edgeId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  const anchor = (nodeId: string, portId: string, side: "in" | "out") => {
    const node = byId.get(nodeId);
    if (!node) return null;
    const ports = portsOf(node, resolveDescriptor(node.provider, node.toolId));
    const list = side === "in" ? ports.inputs : ports.outputs;
    const index = list.findIndex((port) => port.id === portId);
    if (index < 0) return null;
    // Same geometry the card uses, or a labelled multi-port node would draw its
    // curves to where the dots used to be.
    const layout = cardLayout(ports, node.kind);
    return portPosition(
      node,
      index,
      list.length,
      side,
      layout.band,
      side === "in" ? layout.labelIn : layout.labelOut,
    );
  };

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
      {graph.edges.map((edge) => {
        const from = anchor(edge.from, edge.fromPort, "out");
        const to = anchor(edge.to, edge.toPort, "in");
        if (!from || !to) return null;
        const midX = (from.x + to.x) / 2;
        return (
          <g key={edge.id} className="pointer-events-auto">
            <path
              d={`M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`}
              className="fill-none stroke-primary/70"
              strokeWidth={2}
            />
            {/* Fat invisible hit area so the thin curve is clickable. */}
            <path
              d={`M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`}
              className="cursor-pointer fill-none stroke-transparent"
              strokeWidth={12}
              onClick={() => onRemoveEdge(edge.id)}
            >
              <title>{t("processing.modelBuilder.removeConnection")}</title>
            </path>
          </g>
        );
      })}
      {linking &&
        (() => {
          const from = anchor(linking.nodeId, linking.portId, "out");
          if (!from) return null;
          return (
            <path
              d={`M ${from.x} ${from.y} L ${linking.x} ${linking.y}`}
              className="fill-none stroke-primary"
              strokeDasharray="4 3"
              strokeWidth={2}
            />
          );
        })()}
    </svg>
  );
}
