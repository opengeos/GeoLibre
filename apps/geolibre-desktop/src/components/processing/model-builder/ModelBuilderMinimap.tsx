import type { ProcessingModelGraph } from "@geolibre/core";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  if (graph.nodes.length === 0) return null;
  const worldW = Math.max(extentWidth, 1);
  const worldH = Math.max(extentHeight, 1);
  const scale = Math.min(MINIMAP_WIDTH / worldW, MINIMAP_HEIGHT / worldH);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  const safeZoom = Math.max(zoom, 0.1);
  const viewX = (scrollLeft / safeZoom) * scale;
  const viewY = (scrollTop / safeZoom) * scale;
  const viewW = Math.min(MINIMAP_WIDTH, (viewportWidth / safeZoom) * scale);
  const viewH = Math.min(MINIMAP_HEIGHT, (viewportHeight / safeZoom) * scale);

  const handleClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const clickY = event.clientY - rect.top;
    onNavigate(clickX / scale, clickY / scale);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    const centerWorldX = (scrollLeft + viewportWidth / 2) / safeZoom;
    const centerWorldY = (scrollTop + viewportHeight / 2) / safeZoom;
    const stepX = Math.max(80, worldW * 0.1);
    const stepY = Math.max(60, worldH * 0.1);
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onNavigate(Math.max(0, centerWorldX - stepX), centerWorldY);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onNavigate(Math.min(worldW, centerWorldX + stepX), centerWorldY);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      onNavigate(centerWorldX, Math.max(0, centerWorldY - stepY));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onNavigate(centerWorldX, Math.min(worldH, centerWorldY + stepY));
    } else if (event.key === "Home") {
      event.preventDefault();
      onNavigate(0, 0);
    }
  };

  return (
    <div
      className="pointer-events-auto sticky bottom-2 ms-auto me-2 w-fit rounded-md border bg-card/90 p-1 shadow-md backdrop-blur-xs"
      data-testid="model-builder-minimap"
    >
      <svg
        width={MINIMAP_WIDTH}
        height={MINIMAP_HEIGHT}
        tabIndex={0}
        className="block cursor-pointer rounded-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        role="application"
        aria-label={t("processing.modelBuilder.minimapAriaLabel")}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
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
