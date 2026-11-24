import { georefLngLat } from "./geopdf";
import { mapImagePlacement, resolvePageSize, type LayoutOptions } from "./print-layout";
import type { CapturedMap } from "./print-layout-export";

/**
 * The longitude/latitude extent of a georeferenced capture, sampled along
 * its visible boundary, as `[west, south, east, north]` (east may exceed 180 across the
 * antimeridian). Null when the capture has no georeference.
 *
 * @param captured - The main map capture.
 * @param options - Page geometry, when the map capture is cropped.
 * @returns The extent, or null.
 */
export function capturedBounds(
  captured: CapturedMap | null,
  options?: LayoutOptions,
): [number, number, number, number] | null {
  if (!captured?.georef) return null;
  const { width, height, georef } = captured;
  let x0 = 0,
    y0 = 0,
    x1 = width,
    y1 = height;
  if (options) {
    const page = resolvePageSize(options);
    const placement = mapImagePlacement(options, page.width, page.height);
    if (placement) {
      x0 = (placement.clip.x - placement.dx) / placement.scale;
      y0 = (placement.clip.y - placement.dy) / placement.scale;
      x1 = x0 + placement.clip.w / placement.scale;
      y1 = y0 + placement.clip.h / placement.scale;
    }
  }
  const corners = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const lngs: number[] = [],
    lats: number[] = [];
  for (let edge = 0; edge < 4; edge++) {
    const a = corners[edge],
      b = corners[(edge + 1) % 4];
    for (let step = 0; step <= 128; step++) {
      let [lng, lat] = georefLngLat(
        georef,
        a[0] + ((b[0] - a[0]) * step) / 128,
        a[1] + ((b[1] - a[1]) * step) / 128,
      );
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
      if (lngs.length) lng += 360 * Math.round((lngs[lngs.length - 1] - lng) / 360);
      lngs.push(lng);
      lats.push(lat);
    }
  }
  const west = Math.min(...lngs),
    east = Math.max(...lngs);
  if (east - west >= 360 - 1e-7) return [-180, Math.min(...lats), 180, Math.max(...lats)];
  return [west, Math.min(...lats), east, Math.max(...lats)];
}
