import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from "react";
import { clamp } from "../lib/clamp";

/** A panel's top-start corner, relative to its positioned parent (px). */
export interface PanelPos {
  x: number;
  y: number;
}

/** An explicit panel size (px). */
export interface PanelSize {
  w: number;
  h: number;
}

/** Fixed geometry limits for a floating panel. */
export interface FloatingPanelLimits {
  /** Width assumed for drag clamping before the panel has been measured. */
  defaultWidth: number;
  /** Gap kept between the panel and its parent's far edges. */
  margin: number;
  /** Smallest width a resize may reach while there is room for it. */
  minWidth: number;
  /** Smallest height a resize may reach while there is room for it. */
  minHeight: number;
}

/** Where a resize started, in the parent-relative coordinates drags use. */
export interface ResizeStart {
  x: number;
  y: number;
  w: number;
  h: number;
  left: number;
  top: number;
  parentW: number;
  parentH: number;
}

/**
 * The panel position for a drag, clamped inside the parent.
 *
 * Args:
 *   start: The panel position when the drag began.
 *   delta: How far the pointer has moved since then.
 *   panel: The panel's size.
 *   parent: The parent's size, or null when unknown (no clamp at the far edges).
 *   margin: Gap to keep from the parent's far edges.
 *
 * Returns:
 *   The new position, never past the parent's start edges.
 */
export function draggedPanelPosition(
  start: PanelPos,
  delta: { x: number; y: number },
  panel: { width: number; height: number },
  parent: { width: number; height: number } | null,
  margin: number,
): PanelPos {
  const maxX = parent ? parent.width - panel.width - margin : Number.POSITIVE_INFINITY;
  const maxY = parent ? parent.height - panel.height - margin : Number.POSITIVE_INFINITY;
  return {
    x: clamp(start.x + delta.x, 0, Math.max(0, maxX)),
    y: clamp(start.y + delta.y, 0, Math.max(0, maxY)),
  };
}

/**
 * The panel geometry for a resize from the bottom-end grip.
 *
 * The top-start corner stays pinned so the panel grows toward the grip,
 * clamped to a usable minimum and the room left to the parent's edge. In a
 * right-to-left layout the grip is on the physical left, so the horizontal
 * delta is inverted, the room is measured to the left, and the position
 * shifts so the physical right edge stays put.
 *
 * Args:
 *   start: The geometry when the resize began.
 *   pointer: The pointer's current client position.
 *   isRtl: Whether the document is laid out right to left.
 *   limits: The panel's minimum size and edge margin.
 *
 * Returns:
 *   The new size, and the new position when it moves (RTL only).
 */
export function resizedPanelGeometry(
  start: ResizeStart,
  pointer: { x: number; y: number },
  isRtl: boolean,
  limits: Pick<FloatingPanelLimits, "margin" | "minWidth" | "minHeight">,
): { size: PanelSize; pos: PanelPos | null } {
  const availW = isRtl
    ? start.left + start.w - limits.margin
    : start.parentW - start.left - limits.margin;
  const availH = start.parentH - start.top - limits.margin;
  const deltaX = pointer.x - start.x;
  const newW = clamp(
    start.w + (isRtl ? -deltaX : deltaX),
    Math.min(limits.minWidth, availW),
    Math.max(limits.minWidth, availW),
  );
  return {
    pos: isRtl ? { x: start.left + start.w - newW, y: start.top } : null,
    size: {
      w: newW,
      h: clamp(
        start.h + (pointer.y - start.y),
        Math.min(limits.minHeight, availH),
        Math.max(limits.minHeight, availH),
      ),
    },
  };
}

/**
 * Drag-to-move and grip-resize state for a floating panel positioned inside
 * the map area. Both stay null until the user first moves or resizes the
 * panel, so its responsive default placement and size apply until then.
 *
 * Args:
 *   panelRef: The panel element.
 *   limits: The panel's default width, edge margin and minimum size.
 *
 * Returns:
 *   The position and size (null until changed), their setters for resetting,
 *   and the pointer handlers for the drag handle and the resize grip.
 */
export function useFloatingPanelGeometry(
  panelRef: RefObject<HTMLDivElement | null>,
  limits: FloatingPanelLimits,
) {
  const [pos, setPos] = useState<PanelPos | null>(null);
  const [size, setSize] = useState<PanelSize | null>(null);
  const resizeStart = useRef<ResizeStart | null>(null);
  const { defaultWidth, margin, minWidth, minHeight } = limits;

  // Dragging the panel by its header; a press on a header button is not a drag.
  const handleDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      const el = panelRef.current;
      const parent = (el?.offsetParent as HTMLElement | null) ?? el?.parentElement ?? null;
      const pb = parent?.getBoundingClientRect();
      const eb = el?.getBoundingClientRect();
      const start: PanelPos = pos ?? {
        x: (eb?.left ?? 0) - (pb?.left ?? 0),
        y: (eb?.top ?? 0) - (pb?.top ?? 0),
      };
      if (!pos) setPos(start);
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const panel = { width: eb?.width ?? defaultWidth, height: eb?.height ?? 0 };
      const move = (m: PointerEvent) => {
        if (!panelRef.current) return;
        const bounds = parent?.getBoundingClientRect() ?? null;
        setPos(
          draggedPanelPosition(
            start,
            { x: m.clientX - startX, y: m.clientY - startY },
            panel,
            bounds,
            margin,
          ),
        );
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
    [pos, panelRef, defaultWidth, margin],
  );

  const handleResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      const el = panelRef.current;
      if (!el) return;
      const parent = (el.offsetParent as HTMLElement | null) ?? el.parentElement ?? null;
      const pb = parent?.getBoundingClientRect();
      const eb = el.getBoundingClientRect();
      const left = eb.left - (pb?.left ?? 0);
      const top = eb.top - (pb?.top ?? 0);
      // Pin the top-start corner (parent-relative) so the panel grows toward
      // the grip without jumping.
      setPos({ x: left, y: top });
      resizeStart.current = {
        x: event.clientX,
        y: event.clientY,
        w: eb.width,
        h: eb.height,
        left,
        top,
        parentW: pb?.width ?? window.innerWidth,
        parentH: pb?.height ?? window.innerHeight,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [panelRef],
  );

  const handleResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = resizeStart.current;
      if (!start) return;
      const next = resizedPanelGeometry(
        start,
        { x: event.clientX, y: event.clientY },
        document.documentElement.dir === "rtl",
        { margin, minWidth, minHeight },
      );
      if (next.pos) setPos(next.pos);
      setSize(next.size);
    },
    [margin, minWidth, minHeight],
  );

  const handleResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    resizeStart.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  return {
    pos,
    setPos,
    size,
    setSize,
    handleDragStart,
    handleResizeStart,
    handleResizeMove,
    handleResizeEnd,
  };
}
