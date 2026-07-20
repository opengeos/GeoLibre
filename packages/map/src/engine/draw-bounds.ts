import type maplibregl from "maplibre-gl";
import type { BBox, ScreenPoint } from "./types";

export interface DrawMapLibreBoundsOptions {
  readonly aspectRatio?: number;
  readonly signal?: AbortSignal;
  readonly onPreview?: (bounds: BBox | null) => void;
}

/** Wrap longitude to (-180, 180], keeping the antimeridian at +180. */
export function normalizeDrawLongitude(longitude: number): number {
  const wrapped = (((longitude % 360) + 540) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/** Constrain a screen-space drag to an aspect ratio while preserving direction. */
export function snapBoundsPointToAspect(
  start: ScreenPoint,
  end: ScreenPoint,
  aspectRatio: number,
): ScreenPoint {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return end;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const width = Math.max(Math.abs(dx), Math.abs(dy) * aspectRatio);
  const height = width / aspectRatio;
  return {
    x: start.x + (Math.sign(dx) || 1) * width,
    y: start.y + (Math.sign(dy) || 1) * height,
  };
}

/**
 * Pick a geographic bounding box with a click-and-drag gesture. Map navigation
 * is suspended for the gesture and restored on commit, Escape, blur, or abort.
 */
export function drawMapLibreBounds(
  map: maplibregl.Map,
  options: DrawMapLibreBoundsOptions = {},
): Promise<BBox | null> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve(null);
      return;
    }

    const canvas = map.getCanvas();
    const previousCursor = canvas.style.cursor;
    canvas.style.cursor = "crosshair";
    const panWasEnabled = map.dragPan.isEnabled();
    const boxZoomWasEnabled = map.boxZoom.isEnabled();
    const scrollWasEnabled = map.scrollZoom.isEnabled();
    const doubleClickWasEnabled = map.doubleClickZoom.isEnabled();
    map.dragPan.disable();
    map.boxZoom.disable();
    map.scrollZoom.disable();
    map.doubleClickZoom.disable();

    let start: ScreenPoint | null = null;
    let settled = false;
    let moveFrame = 0;
    let pendingMove: { x: number; y: number; shiftKey: boolean } | null = null;

    const finish = (result: BBox | null): void => {
      if (settled) return;
      settled = true;
      if (moveFrame) cancelAnimationFrame(moveFrame);
      map.off("mousedown", onMapDown);
      map.off("mousemove", onMapMove);
      map.off("mouseup", onMapUp);
      window.removeEventListener("mousemove", onWindowMove);
      window.removeEventListener("mouseup", onWindowUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onCancel);
      options.signal?.removeEventListener("abort", onCancel);
      canvas.style.cursor = previousCursor;
      if (panWasEnabled) map.dragPan.enable();
      if (boxZoomWasEnabled) map.boxZoom.enable();
      if (scrollWasEnabled) map.scrollZoom.enable();
      if (doubleClickWasEnabled) map.doubleClickZoom.enable();
      options.onPreview?.(null);
      resolve(result);
    };
    const onCancel = (): void => finish(null);

    const pointFromClient = (clientX: number, clientY: number): ScreenPoint => {
      const rect = canvas.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };
    const boundsFromPoints = (first: ScreenPoint, second: ScreenPoint): BBox => {
      const a = map.unproject([first.x, first.y]);
      const b = map.unproject([second.x, second.y]);
      const firstLongitude = normalizeDrawLongitude(a.lng);
      const secondLongitude = normalizeDrawLongitude(b.lng);
      return [
        Math.min(firstLongitude, secondLongitude),
        Math.min(a.lat, b.lat),
        Math.max(firstLongitude, secondLongitude),
        Math.max(a.lat, b.lat),
      ];
    };
    const settledPoint = (point: ScreenPoint, shiftKey: boolean): ScreenPoint =>
      start && shiftKey && options.aspectRatio
        ? snapBoundsPointToAspect(start, point, options.aspectRatio)
        : point;
    const preview = (point: ScreenPoint, shiftKey: boolean): void => {
      if (!start) return;
      options.onPreview?.(boundsFromPoints(start, settledPoint(point, shiftKey)));
    };
    const commit = (point: ScreenPoint, shiftKey: boolean): void => {
      if (!start || settled) return;
      const end = settledPoint(point, shiftKey);
      if (Math.abs(end.x - start.x) < 4 || Math.abs(end.y - start.y) < 4) {
        finish(null);
        return;
      }
      finish(boundsFromPoints(start, end));
    };
    const queueMove = (clientX: number, clientY: number, shiftKey: boolean): void => {
      if (!start) return;
      pendingMove = { x: clientX, y: clientY, shiftKey };
      if (moveFrame) return;
      moveFrame = requestAnimationFrame(() => {
        moveFrame = 0;
        const move = pendingMove;
        pendingMove = null;
        if (move) preview(pointFromClient(move.x, move.y), move.shiftKey);
      });
    };

    const onMapDown = (event: maplibregl.MapMouseEvent): void => {
      if (event.originalEvent.button !== 0) return;
      start = pointFromClient(event.originalEvent.clientX, event.originalEvent.clientY);
    };
    const onMapMove = (event: maplibregl.MapMouseEvent): void => {
      queueMove(
        event.originalEvent.clientX,
        event.originalEvent.clientY,
        event.originalEvent.shiftKey,
      );
    };
    const onWindowMove = (event: MouseEvent): void => {
      queueMove(event.clientX, event.clientY, event.shiftKey);
    };
    const onMapUp = (event: maplibregl.MapMouseEvent): void => {
      if (event.originalEvent.button !== 0) return;
      commit(
        pointFromClient(event.originalEvent.clientX, event.originalEvent.clientY),
        event.originalEvent.shiftKey,
      );
    };
    const onWindowUp = (event: MouseEvent): void => {
      if (event.button !== 0) return;
      commit(pointFromClient(event.clientX, event.clientY), event.shiftKey);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") finish(null);
    };

    map.on("mousedown", onMapDown);
    map.on("mousemove", onMapMove);
    map.on("mouseup", onMapUp);
    window.addEventListener("mousemove", onWindowMove);
    window.addEventListener("mouseup", onWindowUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onCancel);
    options.signal?.addEventListener("abort", onCancel, { once: true });
  });
}
