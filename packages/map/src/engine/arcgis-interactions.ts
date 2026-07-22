import type { BBox, LngLat } from "./types";

interface ArcGISHandle {
  remove(): void;
}

export interface ArcGISInteractionEvent {
  readonly action?: "start" | "update" | "added" | "removed" | "end";
  readonly button?: number;
  readonly mapPoint?: { readonly longitude?: number; readonly latitude?: number; readonly x?: number; readonly y?: number } | null;
  stopPropagation?(): void;
}

export interface ArcGISInteractionView {
  on(event: "click" | "drag", handler: (event: ArcGISInteractionEvent) => void): ArcGISHandle;
}

function toLngLat(event: ArcGISInteractionEvent): LngLat | null {
  const longitude = event.mapPoint?.longitude ?? event.mapPoint?.x;
  const latitude = event.mapPoint?.latitude ?? event.mapPoint?.y;
  return typeof longitude === "number" && typeof latitude === "number" ? [longitude, latitude] : null;
}

function boundsFromPoints(first: LngLat, second: LngLat, aspectRatio?: number): BBox {
  let west = Math.min(first[0], second[0]);
  let east = Math.max(first[0], second[0]);
  let south = Math.min(first[1], second[1]);
  let north = Math.max(first[1], second[1]);
  if (aspectRatio && aspectRatio > 0) {
    const width = east - west;
    const height = north - south;
    if (width > 0 && height > 0) {
      const actual = width / height;
      if (actual > aspectRatio) north = south + width / aspectRatio;
      else east = west + height * aspectRatio;
    }
  }
  return [west, south, east, north];
}

/** Resolve the next public ArcGIS view click to a neutral longitude/latitude pair. */
export function pickArcGISPoint(
  view: ArcGISInteractionView,
  options?: { readonly signal?: AbortSignal },
): Promise<LngLat | null> {
  return new Promise((resolve) => {
    let settled = false;
    let handle: ArcGISHandle | null = null;
    const finish = (point: LngLat | null): void => {
      if (settled) return;
      settled = true;
      handle?.remove();
      options?.signal?.removeEventListener("abort", onAbort);
      resolve(point);
    };
    const onAbort = (): void => finish(null);
    if (options?.signal?.aborted) return finish(null);
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    handle = view.on("click", (event) => finish(toLngLat(event)));
  });
}

/** Draw a public ArcGIS drag extent without exposing SDK geometries through MapEngine. */
export function drawArcGISBounds(
  view: ArcGISInteractionView,
  options?: {
    readonly aspectRatio?: number;
    readonly signal?: AbortSignal;
    readonly onPreview?: (bounds: BBox | null) => void;
  },
): Promise<BBox | null> {
  return new Promise((resolve) => {
    let start: LngLat | null = null;
    let settled = false;
    let handle: ArcGISHandle | null = null;
    const finish = (bounds: BBox | null): void => {
      if (settled) return;
      settled = true;
      handle?.remove();
      options?.signal?.removeEventListener("abort", onAbort);
      options?.onPreview?.(null);
      resolve(bounds);
    };
    const onAbort = (): void => finish(null);
    if (options?.signal?.aborted) return finish(null);
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    handle = view.on("drag", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      const point = toLngLat(event);
      if (!point) return;
      if (event.action === "start") {
        start = point;
        event.stopPropagation?.();
        return;
      }
      if (!start || (event.action !== "update" && event.action !== "end")) return;
      event.stopPropagation?.();
      const bounds = boundsFromPoints(start, point, options?.aspectRatio);
      options?.onPreview?.(bounds);
      if (event.action === "end") finish(bounds);
    });
  });
}
