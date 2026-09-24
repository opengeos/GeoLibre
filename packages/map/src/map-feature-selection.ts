import {
  applyMatchedSelection,
  effectiveLayerRenderState,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { Polygon } from "geojson";
import {
  FEATURE_SELECTION_EVENT,
  featuresIntersectingPolygon,
  keepsFeatureSelectionActive,
  selectionModeFromModifiers,
  suspendedCameraHandlers,
  type CameraHandlerName,
  type FeatureSelectionRequest,
  type FeatureSelectionShape,
} from "./feature-selection";

/** Lets pointer overlays stand down immediately when a menu arms selection. */
export const FEATURE_SELECTION_BEGIN_EVENT = "geolibre:feature-selection-begin";

/** Minimum screen distance between freehand vertices, avoiding oversized rings. */
const FREEHAND_MIN_POINT_DISTANCE = 3;
/** Maximum screen distance between duplicate clicks generated before `dblclick`. */
const DOUBLE_CLICK_VERTEX_TOLERANCE = 2;
/** Main-thread scan cap; larger jobs belong in expression/location selection tools. */
const MAX_SELECTION_SCAN_FEATURES = 250_000;

interface PointLike {
  x: number;
  y: number;
}

interface SelectionMouseEvent {
  point: PointLike;
  originalEvent: MouseEvent;
  preventDefault(): void;
}

interface CameraHandler {
  isEnabled(): boolean;
  disable(): void;
  enable(): void;
}

export type FeatureSelectionMap = {
  getCanvas(): HTMLCanvasElement;
  getContainer(): HTMLElement;
  unproject(point: [number, number]): { lng: number; lat: number };
  on(type: string, listener: (event: SelectionMouseEvent) => void): unknown;
  off(type: string, listener: (event: SelectionMouseEvent) => void): unknown;
} & Record<CameraHandlerName, CameraHandler>;

export interface FeatureSelectionState {
  active: { current: boolean };
  cancel: { current: (() => void) | null };
}

interface SelectionDiagnostic {
  message: string;
  detail?: string;
  source?: string;
}

export interface AttachFeatureSelectionOptions {
  state: FeatureSelectionState;
  featureIdAtPoint: (layer: GeoLibreLayer, point: PointLike) => string | null;
  onDiagnostic?: (event: SelectionDiagnostic) => void;
  onEnd?: () => void;
}

const distance = (a: PointLike, b: PointLike) => Math.hypot(a.x - b.x, a.y - b.y);
const equalPoints = (a: PointLike, b: PointLike) => a.x === b.x && a.y === b.y;

/** Install GeoLibre's map-selection gestures on either native GL renderer. */
export function attachFeatureSelection(
  map: FeatureSelectionMap,
  { state, featureIdAtPoint, onDiagnostic, onEnd }: AttachFeatureSelectionOptions,
): () => void {
  const tooManyToScan = (candidate: GeoLibreLayer, shape: FeatureSelectionShape) => {
    const featureCount = candidate.geojson?.features?.length ?? 0;
    if (shape === "single" || featureCount <= MAX_SELECTION_SCAN_FEATURES) return false;
    onDiagnostic?.({
      message: `Selecting by shape would test ${featureCount} features (limit ${MAX_SELECTION_SCAN_FEATURES})`,
      detail:
        "Use Select by expression or Select by location on this layer instead — they run the same match without blocking the map.",
      source: candidate.name,
    });
    return true;
  };

  const begin = (request: FeatureSelectionRequest) => {
    state.cancel.current?.();
    const store = useAppStore.getState();
    const layer = store.layers.find((item) => item.id === request.layerId);
    if (!layer?.geojson?.features) return;
    if (!effectiveLayerRenderState(layer, store.layerGroups).visible) return;
    if (tooManyToScan(layer, request.shape)) return;

    const canvas = map.getCanvas();
    const container = map.getContainer();
    const cleanups: Array<() => void> = [];
    state.cancel.current = () => {
      cleanups.forEach((cleanup) => cleanup());
      state.active.current = false;
      state.cancel.current = null;
      onEnd?.();
    };

    const overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    overlay.setAttribute("aria-hidden", "true");
    Object.assign(overlay.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      zIndex: "5",
    });
    const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
    shape.setAttribute("fill", "rgba(37, 99, 235, 0.16)");
    shape.setAttribute("stroke", "#2563eb");
    shape.setAttribute("stroke-width", "2");
    shape.setAttribute("stroke-dasharray", "6 4");
    overlay.append(shape);
    container.append(overlay);
    cleanups.push(() => overlay.remove());

    for (const name of suspendedCameraHandlers(request.shape)) {
      const handler = map[name];
      if (!handler.isEnabled()) continue;
      handler.disable();
      cleanups.push(() => handler.enable());
    }
    canvas.style.cursor = "crosshair";
    cleanups.push(() => {
      canvas.style.cursor = "";
    });
    state.active.current = true;
    window.dispatchEvent(new Event(FEATURE_SELECTION_BEGIN_EVENT));

    let points: PointLike[] = [];
    let dragging = false;
    const render = () => {
      if (points.length === 0) return shape.setAttribute("d", "");
      if (request.shape === "rectangle" && points.length > 1) {
        const [a, b] = points;
        shape.setAttribute(
          "d",
          `M ${a.x} ${a.y} L ${b.x} ${a.y} L ${b.x} ${b.y} L ${a.x} ${b.y} Z`,
        );
        return;
      }
      if (request.shape === "radius" && points.length > 1) {
        const [center, edge] = points;
        const radius = distance(center, edge);
        shape.setAttribute(
          "d",
          `M ${center.x - radius} ${center.y} a ${radius} ${radius} 0 1 0 ${
            radius * 2
          } 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0`,
        );
        return;
      }
      const closed = request.shape !== "freehand" || !dragging;
      shape.setAttribute(
        "d",
        `${points
          .map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`)
          .join(" ")}${closed && points.length > 2 ? " Z" : ""}`,
      );
    };
    const polygonFromPoints = (): Polygon | null => {
      let ring = points;
      const twoPointShape = request.shape === "rectangle" || request.shape === "radius";
      if (twoPointShape && (points.length < 2 || equalPoints(points[0], points[1]))) return null;
      if (request.shape === "rectangle" && points.length >= 2) {
        const [a, b] = points;
        ring = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
      } else if (request.shape === "radius" && points.length >= 2) {
        const [center, edge] = points;
        const radius = distance(center, edge);
        ring = Array.from({ length: 64 }, (_, index) => {
          const angle = (index / 64) * Math.PI * 2;
          return {
            x: center.x + Math.cos(angle) * radius,
            y: center.y + Math.sin(angle) * radius,
          };
        });
      }
      if (ring.length < 3) return null;
      // A vertex off the globe (a 3D view's horizon) has no ground position;
      // it is left out rather than written into the ring as NaN.
      const coordinates = ring
        .map((point) => {
          const lngLat = map.unproject([point.x, point.y]);
          return [lngLat.lng, lngLat.lat] as [number, number];
        })
        .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
      if (coordinates.length < 3) return null;
      coordinates.push(coordinates[0]);
      return { type: "Polygon", coordinates: [coordinates] };
    };

    const finish = (event: { shiftKey?: boolean; altKey?: boolean }) => {
      const latest = useAppStore.getState();
      const live = latest.layers.find((item) => item.id === layer.id);
      if (
        !live?.geojson?.features ||
        !effectiveLayerRenderState(live, latest.layerGroups).visible ||
        tooManyToScan(live, request.shape)
      ) {
        state.cancel.current?.();
        return;
      }
      let matched: string[] = [];
      if (request.shape === "single" && points[0]) {
        const id = featureIdAtPoint(live, points[0]);
        if (id != null) matched = [id];
      } else {
        const polygon = polygonFromPoints();
        if (!polygon) {
          state.cancel.current?.();
          return;
        }
        matched = featuresIntersectingPolygon(live.geojson.features, polygon);
      }
      applyMatchedSelection(
        layer.id,
        matched,
        selectionModeFromModifiers(Boolean(event.shiftKey), Boolean(event.altKey), request.mode),
      );
      if (!keepsFeatureSelectionActive(request.shape)) state.cancel.current?.();
    };
    const onMouseDown = (event: SelectionMouseEvent) => {
      if (request.shape === "polygon" || request.shape === "single") return;
      dragging = true;
      points = [event.point];
      render();
    };
    const canvasPoint = (clientX: number, clientY: number): PointLike => {
      const rect = canvas.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };
    const moveTo = (point: PointLike) => {
      if (!dragging) return;
      if (request.shape === "freehand") {
        const last = points.at(-1);
        if (last && distance(last, point) < FREEHAND_MIN_POINT_DISTANCE) return;
        points.push(point);
      } else {
        if (points[1] && equalPoints(points[1], point)) return;
        points = [points[0], point];
      }
      render();
    };
    const endDrag = (point: PointLike, modifiers: MouseEvent) => {
      if (!dragging) return;
      dragging = false;
      const last = points.at(-1);
      if (request.shape === "freehand" && (!last || !equalPoints(last, point))) points.push(point);
      else if (request.shape !== "freehand") points = [points[0], point];
      finish(modifiers);
    };
    const onMouseMove = (event: SelectionMouseEvent) => moveTo(event.point);
    const onWindowMouseMove = (event: MouseEvent) =>
      moveTo(canvasPoint(event.clientX, event.clientY));
    const onMouseUp = (event: SelectionMouseEvent) => endDrag(event.point, event.originalEvent);
    const onWindowMouseUp = (event: MouseEvent) =>
      endDrag(canvasPoint(event.clientX, event.clientY), event);
    const onClick = (event: SelectionMouseEvent) => {
      if (request.shape === "single") {
        points = [event.point];
        finish(event.originalEvent);
      } else if (request.shape === "polygon") {
        points.push(event.point);
        render();
      }
    };
    const onDoubleClick = (event: SelectionMouseEvent) => {
      if (request.shape !== "polygon") return;
      event.preventDefault();
      const [last, previous] = [points.at(-1), points.at(-2)];
      if (last && previous && distance(last, previous) <= DOUBLE_CLICK_VERTEX_TOLERANCE)
        points.pop();
      if (points.length > 2) finish(event.originalEvent);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") state.cancel.current?.();
    };
    const onBlur = () => {
      if (dragging) state.cancel.current?.();
    };
    map.on("mousedown", onMouseDown);
    map.on("mousemove", onMouseMove);
    map.on("mouseup", onMouseUp);
    map.on("click", onClick);
    map.on("dblclick", onDoubleClick);
    window.addEventListener("mousemove", onWindowMouseMove);
    window.addEventListener("mouseup", onWindowMouseUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    cleanups.push(
      () => void map.off("mousedown", onMouseDown),
      () => void map.off("mousemove", onMouseMove),
      () => void map.off("mouseup", onMouseUp),
      () => void map.off("click", onClick),
      () => void map.off("dblclick", onDoubleClick),
      () => window.removeEventListener("mousemove", onWindowMouseMove),
      () => window.removeEventListener("mouseup", onWindowMouseUp),
      () => window.removeEventListener("keydown", onKeyDown),
      () => window.removeEventListener("blur", onBlur),
    );
  };
  const onRequest = (event: Event) => begin((event as CustomEvent<FeatureSelectionRequest>).detail);
  window.addEventListener(FEATURE_SELECTION_EVENT, onRequest);
  return () => {
    window.removeEventListener(FEATURE_SELECTION_EVENT, onRequest);
    state.cancel.current?.();
  };
}
