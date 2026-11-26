import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { clamp } from "../../../lib/clamp";
import {
  MIN_SIDE_WIDTH,
  MAX_SIDE_WIDTH,
  DEFAULT_PALETTE_WIDTH,
  DEFAULT_INSPECTOR_WIDTH,
  MIN_LOG_HEIGHT,
  MAX_LOG_HEIGHT,
  DEFAULT_LOG_HEIGHT,
  MAX_LOG_FRACTION,
  MAX_SIDE_FRACTION,
  MIN_WIDTH,
  MIN_HEIGHT,
  FLOOR_WIDTH,
  FLOOR_HEIGHT,
  COMPACT_WIDTH,
  EDGE_MARGIN,
} from "./model-builder-constants";

/**
 * The Model Builder window's geometry: position, size, maximize/minimize, the resizable palette, inspector and log panes, and fitting the window to its host.
 */
export function useModelBuilderWindow({ open }: { open: boolean }) {
  const [position, setPosition] = useState({ x: 48, y: 48 });
  const [size, setSize] = useState({ width: 980, height: 560 });
  const [maximized, setMaximized] = useState(false);
  const [paletteWidth, setPaletteWidth] = useState(DEFAULT_PALETTE_WIDTH);
  const [inspectorWidth, setInspectorWidth] = useState(DEFAULT_INSPECTOR_WIDTH);
  const [logHeight, setLogHeight] = useState(DEFAULT_LOG_HEIGHT);
  /**
   * Collapsed to just the title bar, so the map underneath can be read without
   * closing the panel and losing the model on the canvas. A run keeps going
   * while collapsed — the point is to watch its results land.
   */
  const [minimized, setMinimized] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  const restoredGeometryRef = useRef<{
    position: { x: number; y: number };
    size: { width: number; height: number };
  } | null>(null);
  /**
   * Keep the panel inside the map area.
   *
   * The default size assumes a full-width map; open side panels, a small
   * window or a phone leave much less. The floors here are the *smaller* of
   * the preferred minimum and what the container actually offers, so the panel
   * shrinks to fit instead of hanging off the edge with its buttons out of
   * reach.
   */
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const fitToContainer = useCallback(() => {
    const bounds = sectionRef.current?.parentElement?.getBoundingClientRect();
    if (!bounds) return;
    if (maximized) {
      setPosition({ x: 0, y: 0 });
      setSize({ width: bounds.width, height: bounds.height });
      return;
    }
    const currentSize = sizeRef.current;
    const maxWidth = Math.max(FLOOR_WIDTH, bounds.width - EDGE_MARGIN * 2);
    const maxHeight = Math.max(FLOOR_HEIGHT, bounds.height - EDGE_MARGIN * 2);
    const width = clamp(currentSize.width, Math.min(MIN_WIDTH, maxWidth), maxWidth);
    const height = clamp(currentSize.height, Math.min(MIN_HEIGHT, maxHeight), maxHeight);
    if (width !== currentSize.width || height !== currentSize.height) setSize({ width, height });
    setPosition((current) => ({
      x: clamp(current.x, 0, Math.max(0, bounds.width - width - EDGE_MARGIN)),
      y: clamp(current.y, 0, Math.max(0, bounds.height - height - EDGE_MARGIN)),
    }));
  }, [maximized]);
  // Re-fit whenever the map area changes, not just when the panel opens: a
  // resized window or a side panel opening would otherwise leave the panel
  // sized for a viewport that is gone. The observed element is the map area,
  // which the panel does not affect, so this cannot feed back on itself.
  useLayoutEffect(() => {
    if (!open) return;
    fitToContainer();
    const host = sectionRef.current?.parentElement;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fitToContainer());
    observer.observe(host);
    return () => observer.disconnect();
  }, [open, fitToContainer]);
  // --- Panel chrome -------------------------------------------------------

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (maximized) return;
    if ((event.target as HTMLElement).closest("button, input")) return;
    const handle = event.currentTarget;
    // React bubbles events from portaled content (the Samples menu) through
    // the component tree, so a click on a menu item reaches this handler
    // although the item is not inside the title bar. Capturing the pointer
    // here would steal the item's click.
    if (!handle.contains(event.target as Node)) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const card = handle.closest("section") as HTMLElement;
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = position;
    const handleMove = (move: PointerEvent) => {
      const bounds = card.parentElement?.getBoundingClientRect();
      const maxX = bounds ? bounds.width - card.offsetWidth - EDGE_MARGIN : Infinity;
      const maxY = bounds ? bounds.height - card.offsetHeight - EDGE_MARGIN : Infinity;
      setPosition({
        x: clamp(origin.x + (move.clientX - startX), 0, Math.max(0, maxX)),
        y: clamp(origin.y + (move.clientY - startY), 0, Math.max(0, maxY)),
      });
    };
    const handleEnd = () => {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", handleMove);
      handle.removeEventListener("pointerup", handleEnd);
      handle.removeEventListener("pointercancel", handleEnd);
    };
    handle.addEventListener("pointermove", handleMove);
    handle.addEventListener("pointerup", handleEnd);
    handle.addEventListener("pointercancel", handleEnd);
  };
  /**
   * Drag one of the two column splitters.
   *
   * The palette grows as the pointer moves towards the canvas and the
   * inspector grows as it moves away from it, which in a mirrored (RTL) layout
   * is the opposite screen direction — hence the sign taken from the element's
   * computed `direction` rather than assuming left-to-right.
   */
  /**
   * Too narrow for three columns. The side panes overlay the canvas instead of
   * splitting the row with it, and the toolbar drops its button labels.
   */
  const compact = size.width < COMPACT_WIDTH;
  /** Resize floors, matching what {@link fitToContainer} allows. */
  const hostBounds = sectionRef.current?.parentElement?.getBoundingClientRect();
  const minWidth = Math.min(
    MIN_WIDTH,
    Math.max(FLOOR_WIDTH, (hostBounds?.width ?? MIN_WIDTH) - EDGE_MARGIN * 2),
  );
  const minHeight = Math.min(
    MIN_HEIGHT,
    Math.max(FLOOR_HEIGHT, (hostBounds?.height ?? MIN_HEIGHT) - EDGE_MARGIN * 2),
  );
  /** Upper bound for one side column at the panel's current width. */
  const maxSideWidth = Math.max(
    MIN_SIDE_WIDTH,
    Math.min(MAX_SIDE_WIDTH, size.width * MAX_SIDE_FRACTION),
  );
  const handleSideResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, side: "palette" | "inspector") => {
      event.preventDefault();
      event.stopPropagation();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const dirSign = getComputedStyle(handle).direction === "rtl" ? -1 : 1;
      const sideSign = side === "palette" ? 1 : -1;
      const startX = event.clientX;
      const start = side === "palette" ? paletteWidth : inspectorWidth;
      const setWidth = side === "palette" ? setPaletteWidth : setInspectorWidth;
      const handleMove = (move: PointerEvent) => {
        setWidth(
          clamp(start + (move.clientX - startX) * dirSign * sideSign, MIN_SIDE_WIDTH, maxSideWidth),
        );
      };
      const handleEnd = () => {
        if (handle.hasPointerCapture(event.pointerId))
          handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener("pointermove", handleMove);
        handle.removeEventListener("pointerup", handleEnd);
        handle.removeEventListener("pointercancel", handleEnd);
      };
      handle.addEventListener("pointermove", handleMove);
      handle.addEventListener("pointerup", handleEnd);
      handle.addEventListener("pointercancel", handleEnd);
    },
    [paletteWidth, inspectorWidth, maxSideWidth],
  );
  /** Upper bound for the log pane at the panel's current height. */
  const maxLogHeight = Math.max(
    MIN_LOG_HEIGHT,
    Math.min(MAX_LOG_HEIGHT, size.height * MAX_LOG_FRACTION),
  );
  /**
   * Drag the splitter above the log pane. Dragging up grows it, which is the
   * direction that reveals more of the run output. Vertical, so unlike the
   * column splitters this needs no writing-direction handling.
   */
  const handleLogResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startY = event.clientY;
      const start = logHeight;
      const handleMove = (move: PointerEvent) => {
        setLogHeight(clamp(start - (move.clientY - startY), MIN_LOG_HEIGHT, maxLogHeight));
      };
      const handleEnd = () => {
        if (handle.hasPointerCapture(event.pointerId))
          handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener("pointermove", handleMove);
        handle.removeEventListener("pointerup", handleEnd);
        handle.removeEventListener("pointercancel", handleEnd);
      };
      handle.addEventListener("pointermove", handleMove);
      handle.addEventListener("pointerup", handleEnd);
      handle.addEventListener("pointercancel", handleEnd);
    },
    [logHeight, maxLogHeight],
  );
  /** Keyboard path for the log splitter. */
  const handleLogResizeKey = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.key === "ArrowUp" ? 16 : event.key === "ArrowDown" ? -16 : 0;
      if (!step) return;
      event.preventDefault();
      setLogHeight((current) => clamp(current + step, MIN_LOG_HEIGHT, maxLogHeight));
    },
    [maxLogHeight],
  );
  /** Keyboard path for the splitters, so a column is resizable without a mouse. */
  const handleSideResizeKey = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, side: "palette" | "inspector") => {
      const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
      if (!step) return;
      event.preventDefault();
      const dirSign = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
      const sideSign = side === "palette" ? 1 : -1;
      const setWidth = side === "palette" ? setPaletteWidth : setInspectorWidth;
      setWidth((current) =>
        clamp(current + step * dirSign * sideSign, MIN_SIDE_WIDTH, maxSideWidth),
      );
    },
    [maxSideWidth],
  );
  /**
   * Keyboard path for the panel's own resize grip, matching the column
   * splitters: arrows grow or shrink the panel a step at a time. The panel is
   * clamped to its container the same way the pointer drag is.
   */
  const handleResizeKey = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const dx = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
      const dy = event.key === "ArrowUp" ? -16 : event.key === "ArrowDown" ? 16 : 0;
      if (!dx && !dy) return;
      event.preventDefault();
      const dirSign = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
      const bounds = (
        event.currentTarget.closest("section") as HTMLElement | null
      )?.parentElement?.getBoundingClientRect();
      const maxWidth = bounds ? bounds.width - position.x - EDGE_MARGIN : Infinity;
      const maxHeight = bounds ? bounds.height - position.y - EDGE_MARGIN : Infinity;
      setSize((current) => ({
        width: clamp(current.width + dx * dirSign, minWidth, Math.max(minWidth, maxWidth)),
        height: clamp(current.height + dy, minHeight, Math.max(minHeight, maxHeight)),
      }));
    },
    [position.x, position.y, minWidth, minHeight],
  );
  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const isRtl = getComputedStyle(handle).direction === "rtl";
    const startX = event.clientX;
    const startY = event.clientY;
    const start = size;
    const startLeft = position.x;
    const startRight = startLeft + start.width;
    const handleMove = (move: PointerEvent) => {
      const bounds = (
        handle.closest("section") as HTMLElement
      )?.parentElement?.getBoundingClientRect();
      const maxHeight = bounds ? bounds.height - position.y - EDGE_MARGIN : Infinity;
      const nextHeight = clamp(
        start.height + (move.clientY - startY),
        minHeight,
        Math.max(minHeight, maxHeight),
      );
      if (isRtl) {
        // In RTL the `end-0` grip sits on the left edge while the panel is
        // positioned with `left: position.x`: keep the right edge anchored and
        // shift `position.x` as the clamped width changes.
        const maxWidth = bounds ? startRight - EDGE_MARGIN : Infinity;
        const nextWidth = clamp(
          start.width - (move.clientX - startX),
          minWidth,
          Math.max(minWidth, maxWidth),
        );
        setSize({ width: nextWidth, height: nextHeight });
        setPosition((current) => ({ ...current, x: startRight - nextWidth }));
        return;
      }
      const maxWidth = bounds ? bounds.width - startLeft - EDGE_MARGIN : Infinity;
      setSize({
        width: clamp(start.width + (move.clientX - startX), minWidth, Math.max(minWidth, maxWidth)),
        height: nextHeight,
      });
    };
    const handleEnd = () => {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", handleMove);
      handle.removeEventListener("pointerup", handleEnd);
      handle.removeEventListener("pointercancel", handleEnd);
    };
    handle.addEventListener("pointermove", handleMove);
    handle.addEventListener("pointerup", handleEnd);
    handle.addEventListener("pointercancel", handleEnd);
  };
  const toggleMaximized = useCallback(() => {
    if (maximized) {
      const restored = restoredGeometryRef.current;
      if (restored) {
        setPosition(restored.position);
        setSize(restored.size);
      }
      restoredGeometryRef.current = null;
      setMaximized(false);
      return;
    }

    const bounds = sectionRef.current?.parentElement?.getBoundingClientRect();
    if (!bounds) return;
    restoredGeometryRef.current = { position, size };
    setMinimized(false);
    setPosition({ x: 0, y: 0 });
    setSize({ width: bounds.width, height: bounds.height });
    setMaximized(true);
  }, [maximized, position, size]);
  return {
    position,
    size,
    maximized,
    paletteWidth,
    inspectorWidth,
    logHeight,
    minimized,
    setMinimized,
    sectionRef,
    handleDragStart,
    compact,
    maxSideWidth,
    handleSideResizeStart,
    maxLogHeight,
    handleLogResizeStart,
    handleLogResizeKey,
    handleSideResizeKey,
    handleResizeKey,
    handleResizeStart,
    toggleMaximized,
  };
}
