import { type PointerEvent as ReactPointerEvent, useCallback, useRef, useState } from "react";
import { clamp } from "../lib/clamp";

/** A movable/resizable panel rect, in px relative to its positioned ancestor. */
export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloatingPanelRectOptions {
  /** Smallest width the panel can be dragged down to. */
  minWidth: number;
  /** Smallest height the panel can be dragged down to. */
  minHeight: number;
  /** Inset kept between the panel and its container's far edges. */
  margin: number;
  /** Rect assumed when the panel has not been measured yet (no DOM node). */
  fallback: PanelRect;
}

export interface FloatingPanelRect {
  /** Attach to the panel element; the gestures measure and clamp against it. */
  panelRef: React.RefObject<HTMLDivElement | null>;
  /**
   * The panel's px geometry, or null while it still sits at its CSS default.
   * Apply as `style` only when non-null, so an untouched panel keeps whatever
   * responsive placement its classes describe.
   */
  rect: PanelRect | null;
  /** Attach to the panel's header to move it. */
  handleDragStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** Attach to the panel's corner grip to resize it. */
  handleResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** Drop back to the CSS default placement, for a full teardown of the panel. */
  resetRect: () => void;
}

/**
 * Pointer-driven move and resize for a panel floating over the map.
 *
 * The panel starts at its CSS placement (`rect` is null) and switches to
 * absolute px on the first gesture, measured from the DOM so it does not jump.
 * Both gestures clamp to the positioned ancestor, so a panel cannot be pushed
 * off the map area.
 *
 * Shared by the Time Slider's pixel chart and the NetCDF spectral profile, which
 * are the same kind of window over the same kind of container.
 *
 * @param options - Size floors, edge inset, and the pre-measurement fallback.
 * @returns The ref to attach, the current rect, and the two gesture handlers.
 */
export function useFloatingPanelRect({
  minWidth,
  minHeight,
  margin,
  fallback,
}: FloatingPanelRectOptions): FloatingPanelRect {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<PanelRect | null>(null);

  // The current panel rect relative to its positioned ancestor (the map area),
  // measured from the DOM so a drag/resize can begin from the CSS default.
  const measureRect = useCallback((): PanelRect => {
    const el = panelRef.current;
    if (!el) return fallback;
    const parent = (el.offsetParent as HTMLElement | null) ?? el.parentElement;
    const pb = parent?.getBoundingClientRect();
    const eb = el.getBoundingClientRect();
    return {
      x: eb.left - (pb?.left ?? 0),
      y: eb.top - (pb?.top ?? 0),
      w: eb.width,
      h: eb.height,
    };
  }, [fallback]);

  // Shared pointer-capture drag loop: `onMove` receives the px delta from the
  // gesture start and the rect captured when it began.
  const startPointerGesture = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      onMove: (dx: number, dy: number, start: PanelRect, bounds?: DOMRect) => void,
    ) => {
      event.preventDefault();
      const start = rect ?? measureRect();
      if (!rect) setRect(start);
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const parent =
        (panelRef.current?.offsetParent as HTMLElement | null) ??
        panelRef.current?.parentElement ??
        null;
      const move = (m: PointerEvent) => {
        // Bail if the panel unmounted mid-gesture so we don't setState for a
        // panel that is gone.
        if (!panelRef.current) return;
        onMove(m.clientX - startX, m.clientY - startY, start, parent?.getBoundingClientRect());
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
    [rect, measureRect],
  );

  const handleDragStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Let header buttons (close, pop-in) work without starting a drag.
      if ((event.target as HTMLElement).closest("button")) return;
      startPointerGesture(event, (dx, dy, start, b) => {
        const maxX = b ? b.width - start.w - margin : Number.POSITIVE_INFINITY;
        const maxY = b ? b.height - start.h - margin : Number.POSITIVE_INFINITY;
        setRect({
          ...start,
          x: clamp(start.x + dx, 0, Math.max(0, maxX)),
          y: clamp(start.y + dy, 0, Math.max(0, maxY)),
        });
      });
    },
    [startPointerGesture, margin],
  );

  const handleResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
      startPointerGesture(event, (dx, dy, start, b) => {
        const maxW = b ? b.width - start.x - margin : Number.POSITIVE_INFINITY;
        const maxH = b ? b.height - start.y - margin : Number.POSITIVE_INFINITY;
        setRect({
          ...start,
          w: clamp(start.w + dx, minWidth, Math.max(minWidth, maxW)),
          h: clamp(start.h + dy, minHeight, Math.max(minHeight, maxH)),
        });
      });
    },
    [startPointerGesture, margin, minWidth, minHeight],
  );

  const resetRect = useCallback(() => setRect(null), []);

  return { panelRef, rect, handleDragStart, handleResizeStart, resetRect };
}
