import type { MapController } from "@geolibre/map";
import { useEffect, useRef, useState } from "react";
import { MIN_REGION_SIZE, type RecordRegion } from "../../lib/map-recorder";

interface RegionSelectOverlayProps {
  mapControllerRef: React.RefObject<MapController | null>;
  /**
   * - `select`: drag a new rectangle (crosshair, captures pointer events).
   * - `frame`: show the chosen rectangle as a fixed frame; pointer events pass
   *   through so the map underneath stays interactive (used before and during
   *   recording).
   * - `hidden`: render nothing.
   */
  mode: "select" | "frame" | "hidden";
  /** The chosen rectangle in CSS pixels relative to the map canvas top-left. */
  region: RecordRegion | null;
  /** Fired when a drag completes: the rectangle, or null for a too-small drag. */
  onSelect: (region: RecordRegion | null) => void;
  /** Fired when the user presses Escape during selection. */
  onCancel: () => void;
}

/** A rectangle in CSS pixels, relative to the map canvas's top-left corner. */
interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): CanvasRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/**
 * Full-canvas overlay for choosing and displaying the "selected area" a
 * recording captures. In `select` mode the user drags a rubber-band rectangle;
 * in `frame` mode the chosen rectangle is shown as a fixed, non-interactive
 * frame so the map keeps panning and zooming under it while recording.
 *
 * The overlay is a `position: fixed` box pinned to the map canvas's viewport
 * rectangle. Because the recording region is screen-fixed (not geographic), the
 * frame does not move when the map pans — only a window/layout resize shifts it,
 * which a ResizeObserver + window listeners track.
 */
export function RegionSelectOverlay({
  mapControllerRef,
  mode,
  region,
  onSelect,
  onCancel,
}: RegionSelectOverlayProps) {
  // The canvas's position/size in viewport coordinates, so the fixed overlay can
  // be pinned over it and drag points can be made canvas-relative.
  const [canvasBox, setCanvasBox] = useState<DOMRect | null>(null);
  const [dragRect, setDragRect] = useState<CanvasRect | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // Track the canvas rectangle while the overlay is visible so the frame stays
  // aligned across window/layout resizes. Re-read on the map's own resize event
  // too (the container can change without a window resize, e.g. a side panel).
  useEffect(() => {
    if (mode === "hidden") {
      setCanvasBox(null);
      return;
    }
    const map = mapControllerRef.current?.getMap();
    const canvas = map?.getCanvas();
    if (!canvas || !map) return;
    const update = () => setCanvasBox(canvas.getBoundingClientRect());
    update();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(canvas);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    map.on("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      map.off("resize", update);
    };
  }, [mode, mapControllerRef]);

  // Escape cancels an in-progress selection.
  useEffect(() => {
    if (mode !== "select") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        startRef.current = null;
        setDragRect(null);
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, onCancel]);

  if (mode === "hidden" || !canvasBox) return null;

  const pointFromEvent = (event: React.PointerEvent) => ({
    x: event.clientX - canvasBox.left,
    y: event.clientY - canvasBox.top,
  });

  const onPointerDown = (event: React.PointerEvent) => {
    if (mode !== "select" || event.button !== 0) return;
    const start = pointFromEvent(event);
    startRef.current = start;
    setDragRect({ x: start.x, y: start.y, width: 0, height: 0 });
    overlayRef.current?.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!startRef.current) return;
    setDragRect(rectFromPoints(startRef.current, pointFromEvent(event)));
  };

  const onPointerUp = (event: React.PointerEvent) => {
    if (!startRef.current) return;
    const rect = rectFromPoints(startRef.current, pointFromEvent(event));
    startRef.current = null;
    setDragRect(null);
    overlayRef.current?.releasePointerCapture?.(event.pointerId);
    // Reject a click or a sliver: too small to record anything useful. Let the
    // caller decide what to do (it keeps select mode active to retry).
    if (rect.width < MIN_REGION_SIZE || rect.height < MIN_REGION_SIZE) {
      onSelect(null);
      return;
    }
    onSelect(rect);
  };

  // A cancelled gesture (touch/pen interruption, OS gesture) is not a completed
  // drag, so drop the in-progress rectangle without committing a crop. Release
  // the capture only if it is still held.
  const onPointerCancel = (event: React.PointerEvent) => {
    if (!startRef.current) return;
    startRef.current = null;
    setDragRect(null);
    overlayRef.current?.releasePointerCapture?.(event.pointerId);
  };

  // In select mode the live rubber band takes over; otherwise show the committed
  // region as a fixed frame.
  const shown: CanvasRect | null = mode === "select" ? dragRect : region;

  const overlayStyle: React.CSSProperties = {
    position: "fixed",
    left: canvasBox.left,
    top: canvasBox.top,
    width: canvasBox.width,
    height: canvasBox.height,
    // In frame mode the map must stay interactive, so events pass through; in
    // select mode the overlay captures the drag.
    pointerEvents: mode === "select" ? "auto" : "none",
    cursor: mode === "select" ? "crosshair" : "default",
    zIndex: 30,
  };

  return (
    <div
      ref={overlayRef}
      style={overlayStyle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {shown && (
        <div
          style={{
            position: "absolute",
            left: shown.x,
            top: shown.y,
            width: shown.width,
            height: shown.height,
            // A translucent frame with a full-viewport shadow to dim outside the
            // capture area, so the recorded region reads clearly. The 2px dashed
            // border marks the exact crop edge.
            border: "2px dashed rgba(255,255,255,0.9)",
            outline: "1px solid rgba(0,0,0,0.5)",
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.28)",
            boxSizing: "border-box",
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}
