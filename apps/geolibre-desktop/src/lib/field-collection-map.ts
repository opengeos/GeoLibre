import type { MapEngine, MapRenderSurface } from "@geolibre/map";
import { createStoryMapMarker } from "../components/storymap/storymap-engine";
import type { GeometryType, Vertex } from "./field-collection";

const SVG_NS = "http://www.w3.org/2000/svg";
const DRAG_THRESHOLD_PX = 5;

export interface FieldCollectionMarker {
  setLngLat(lngLat: Vertex): void;
  remove(): void;
}

export interface FieldCollectionPreview {
  setGeometry(geometry: GeometryType, vertices: Vertex[]): void;
  remove(): void;
}

function followCamera(engine: MapEngine, update: () => void): () => void {
  const surface = engine.getRenderSurface();
  if (!surface) return () => {};
  const stopMoving = engine.onCameraMove(update);
  const resize = new ResizeObserver(update);
  resize.observe(surface.getContainer());
  return () => {
    stopMoving();
    resize.disconnect();
  };
}

/** Pin the Field Collection capture marker to any renderer-neutral surface. */
export function createFieldCollectionMarker(
  engine: MapEngine,
  color: string,
): FieldCollectionMarker | null {
  // Share the story-map pin so its hand-mirrored MapLibre offset lives in one place.
  return createStoryMapMarker(engine, color);
}

/** Draw an in-progress line or polygon above any renderer's canvas. */
export function createFieldCollectionPreview(
  engine: MapEngine,
  color: string,
): FieldCollectionPreview | null {
  const surface = engine.getRenderSurface();
  if (!surface) return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.dataset.fieldCollectionPreview = "true";
  svg.style.position = "absolute";
  svg.style.inset = "0";
  svg.style.width = "100%";
  svg.style.height = "100%";
  svg.style.pointerEvents = "none";
  svg.style.zIndex = "35";
  surface.getContainer().appendChild(svg);
  let geometry: GeometryType = "line";
  let vertices: Vertex[] = [];
  let removed = false;

  const update = () => {
    if (removed) return;
    svg.replaceChildren();
    const points: Array<{ x: number; y: number }> = [];
    for (const vertex of vertices) {
      try {
        points.push(surface.project(vertex));
      } catch {
        return;
      }
    }
    if (points.length === 0) return;
    const serialized = points.map((point) => `${point.x},${point.y}`).join(" ");
    if (geometry === "polygon" && points.length >= 3) {
      const polygon = document.createElementNS(SVG_NS, "polygon");
      polygon.setAttribute("points", serialized);
      polygon.setAttribute("fill", color);
      polygon.setAttribute("fill-opacity", "0.2");
      svg.appendChild(polygon);
    }
    if (points.length >= 2) {
      const line = document.createElementNS(SVG_NS, "polyline");
      const first = points[0];
      const outline =
        geometry === "polygon" && points.length >= 3
          ? `${serialized} ${first.x},${first.y}`
          : serialized;
      line.setAttribute("points", outline);
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", color);
      line.setAttribute("stroke-width", "2");
      line.setAttribute("stroke-dasharray", "4 2");
      svg.appendChild(line);
    }
    for (const point of points) {
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(point.x));
      circle.setAttribute("cy", String(point.y));
      circle.setAttribute("r", "4");
      circle.setAttribute("fill", color);
      circle.setAttribute("stroke", "#ffffff");
      circle.setAttribute("stroke-width", "1");
      svg.appendChild(circle);
    }
  };
  const stopFollowing = followCamera(engine, update);
  return {
    setGeometry(nextGeometry, nextVertices) {
      geometry = nextGeometry;
      vertices = nextVertices;
      update();
    },
    remove() {
      if (removed) return;
      removed = true;
      stopFollowing();
      svg.remove();
    },
  };
}

export function fieldCollectionEventLngLat(
  surface: MapRenderSurface,
  event: Pick<MouseEvent, "clientX" | "clientY">,
): Vertex {
  const rect = surface.getCanvas().getBoundingClientRect();
  const coordinate = surface.unproject([event.clientX - rect.left, event.clientY - rect.top]);
  return [coordinate.lng, coordinate.lat];
}

/** Listen for map clicks without requiring an engine-specific map instance. */
export function listenForFieldCollectionClicks(
  engine: MapEngine,
  handlers: {
    onClick: (lngLat: Vertex) => void;
    onDoubleClick?: (lngLat: Vertex) => void;
  },
): () => void {
  const surface = engine.getRenderSurface();
  if (!surface) return () => {};
  const canvas = surface.getCanvas();
  const previousCursor = canvas.style.cursor;
  canvas.style.cursor = "crosshair";
  let pointerStart: { x: number; y: number } | null = null;
  let activePointerId: number | null = null;
  const pointersDown = new Set<number>();
  let dragged = false;
  const onPointerDown = (event: PointerEvent) => {
    pointersDown.add(event.pointerId);
    if (pointersDown.size > 1) {
      // A second finger means a pinch/rotate gesture, never a capture tap.
      dragged = true;
      return;
    }
    activePointerId = event.pointerId;
    pointerStart = { x: event.clientX, y: event.clientY };
    dragged = false;
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!pointerStart || event.pointerId !== activePointerId) return;
    const dx = event.clientX - pointerStart.x;
    const dy = event.clientY - pointerStart.y;
    if (dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) dragged = true;
  };
  const onPointerUp = (event: PointerEvent) => {
    pointersDown.delete(event.pointerId);
    if (event.pointerId !== activePointerId) return;
    pointerStart = null;
    activePointerId = null;
  };
  const onClick = (event: MouseEvent) => {
    if (dragged) {
      dragged = false;
      return;
    }
    handlers.onClick(fieldCollectionEventLngLat(surface, event));
  };
  const onDoubleClick = (event: MouseEvent) => {
    if (!handlers.onDoubleClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    handlers.onDoubleClick(fieldCollectionEventLngLat(surface, event));
  };
  canvas.addEventListener("pointerdown", onPointerDown, true);
  canvas.addEventListener("pointermove", onPointerMove, true);
  // A pointer can be released off the canvas; listen document-wide so it never
  // lingers in pointersDown and turns the next tap into a "multi-touch" drag.
  const doc = canvas.ownerDocument;
  doc.addEventListener("pointerup", onPointerUp, true);
  doc.addEventListener("pointercancel", onPointerUp, true);
  canvas.addEventListener("click", onClick, true);
  canvas.addEventListener("dblclick", onDoubleClick, true);
  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown, true);
    canvas.removeEventListener("pointermove", onPointerMove, true);
    doc.removeEventListener("pointerup", onPointerUp, true);
    doc.removeEventListener("pointercancel", onPointerUp, true);
    canvas.removeEventListener("click", onClick, true);
    canvas.removeEventListener("dblclick", onDoubleClick, true);
    canvas.style.cursor = previousCursor;
  };
}
