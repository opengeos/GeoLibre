import type maplibregl from "maplibre-gl";
import type { LngLat } from "./types";

export interface PickMapLibrePointOptions {
  readonly signal?: AbortSignal;
}

/** Pick one geographic point while owning cursor and cancellation cleanup. */
export function pickMapLibrePoint(
  map: maplibregl.Map,
  options: PickMapLibrePointOptions = {},
): Promise<LngLat | null> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve(null);
      return;
    }

    const canvas = map.getCanvas();
    const previousCursor = canvas.style.cursor;
    canvas.style.cursor = "crosshair";
    let settled = false;

    const finish = (point: LngLat | null): void => {
      if (settled) return;
      settled = true;
      map.off("click", onClick);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onCancel);
      options.signal?.removeEventListener("abort", onCancel);
      canvas.style.cursor = previousCursor;
      resolve(point);
    };
    const onCancel = (): void => finish(null);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") finish(null);
    };
    const onClick = (event: maplibregl.MapMouseEvent): void => {
      const button = event.originalEvent?.button;
      if (button !== undefined && button !== 0) return;
      finish([event.lngLat.lng, event.lngLat.lat]);
    };

    map.on("click", onClick);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onCancel);
    options.signal?.addEventListener("abort", onCancel, { once: true });
  });
}
