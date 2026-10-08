import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { clamp } from "../lib/clamp";

const PANEL_MARGIN = 12;

/** Top-left offset of a dragged panel within its positioned parent. */
export interface FloatingPanelPos {
  x: number;
  y: number;
}

/**
 * Drag a floating panel by its header, clamped to its positioned parent (the
 * map area). Same behavior as the Segment Everything and Object Detection
 * panels: the panel sits at its CSS-anchored spot until first dragged, then
 * follows the pointer with explicit `left`/`top`.
 *
 * @returns The panel ref, the dragged position (null until the first drag), and
 *   the header's pointer-down handler.
 */
export function useFloatingPanelDrag() {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<FloatingPanelPos | null>(null);

  const onDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      const el = panelRef.current;
      const parent = (el?.offsetParent as HTMLElement | null) ?? el?.parentElement ?? null;
      const pb = parent?.getBoundingClientRect();
      const eb = el?.getBoundingClientRect();
      const start: FloatingPanelPos = pos ?? {
        x: (eb?.left ?? 0) - (pb?.left ?? 0),
        y: (eb?.top ?? 0) - (pb?.top ?? 0),
      };
      if (!pos) setPos(start);
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const w = eb?.width ?? 0;
      const h = eb?.height ?? 0;
      const move = (m: PointerEvent) => {
        if (!panelRef.current) return;
        const bounds = parent?.getBoundingClientRect();
        const maxX = bounds ? bounds.width - w - PANEL_MARGIN : Number.POSITIVE_INFINITY;
        const maxY = bounds ? bounds.height - h - PANEL_MARGIN : Number.POSITIVE_INFINITY;
        setPos({
          x: clamp(start.x + (m.clientX - startX), 0, Math.max(0, maxX)),
          y: clamp(start.y + (m.clientY - startY), 0, Math.max(0, maxY)),
        });
      };
      const end = () => {
        if (handle.hasPointerCapture(event.pointerId))
          handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    },
    [pos],
  );

  return { panelRef, pos, onDragStart };
}
