import type { ProcessingModelGraph } from "@geolibre/core";
import type { MouseEvent as ReactMouseEvent } from "react";
import { NODE_HEIGHT, NODE_WIDTH } from "../../../lib/model-graph-edit";

interface ModelBuilderMinimapProps {
  graph: ProcessingModelGraph;
  selectedIds: ReadonlySet<string>;
  extentWidth: number;
  extentHeight: number;
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
  viewportWidth: number;
  viewportHeight: number;
  onNavigate: (worldX: number, worldY: number) => void;
}

const MINIMAP_WIDTH = 148;
const MINIMAP_HEIGHT = 96;

/**
 * Interactive SVG minimap for the Model Builder canvas. Displays scaled node
 * rectangles, connecting edges, and the current viewport frame; clicking moves
 * the canvas scroll position to that world coordinate.
 */
export function ModelBuilderMinimap({
  graph,
  selectedIds,
  extentWidth,
  extentHeight,
  zoom,
  scrollLeft,
  scrollTop,
  viewportWidth,
  viewportHeight,
  onNavigate,
}: ModelBuilderMinimapProps) {
  if (graph.nodes.length === 0) return null;
  const worldW = Math.max(extentWidth, 1);
  const worldH = Math.max(extentHeight, 1);
  const scale = Math.min(MINIMAP_WIDTH / worldW, MINIMAP_HEIGHT / worldH);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  const viewX = (scrollLeft / Math.max(zoom, 0.1)) * scale;
  const viewY = (scrollTop / Math.max(zoom, 0.1)) * scale;
  const viewW = Math.min(MINIMAP_WIDTH, (viewportWidth / Math.max(zoom, 0.1)) * scale);
  const viewH = Math.min(MINIMAP_HEIGHT, (viewportHeight / Math.max(zoom, 0.1)) * scale);

  const handleClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;
    onNavigate(clickX / scale, clickY / scale);
  };

  return (
    <div
      className="pointer-events-auto sticky bottom-2 ms-auto me-2 w-fit rounded-md border bg-card/90 p-1 shadow-md backdrop-blur-xs"
      data-testid="model-builder-minimap"
    >
      <svg
        width={MINIMAP_WIDTH}
        height={MINIMAP_HEIGHT}
        className="block cursor-pointer"
        role="img"
        aria-label="Model canvas minimap"
        onClick={handleClick}
      >
        {graph.edges.map((edge) => {
          const from = nodeById.get(edge.from);
          const to = nodeById.get(edge.to);
          if (!from || !to) return null;
          return (
            <line
              key={edge.id}
              x1={(from.x + NODE_WIDTH) * scale}
              y1={(from.y + NODE_HEIGHT / 2) * scale}
              x2={to.x * scale}
              y2={(to.y + NODE_HEIGHT / 2) * scale}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeWidth={1}
              className="text-muted-foreground"
            />
          );
        })}
        {graph.nodes.map((node) => {
          const isSelected = selectedIds.has(node.id);
          return (
            <rect
              key={node.id}
              x={node.x * scale}
              y={node.y * scale}
              width={Math.max(4, NODE_WIDTH * scale)}
              height={Math.max(3, NODE_HEIGHT * scale)}
              rx={1.5}
              className={isSelected ? "fill-primary" : "fill-muted-foreground/60"}
            />
          );
        })}
        {viewportWidth > 0 && viewportHeight > 0 && (
          <rect
            x={Math.max(0, Math.min(MINIMAP_WIDTH - viewW, viewX))}
            y={Math.max(0, Math.min(MINIMAP_HEIGHT - viewH, viewY))}
            width={Math.max(6, viewW)}
            height={Math.max(6, viewH)}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.25}
            className="text-primary"
          />
        )}
      </svg>
    </div>
  );
}
