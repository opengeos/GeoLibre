import { captureLocator } from "./print-capture-grid";
import { mapImagePlacement, resolvePageSize, type LayoutOptions } from "./print-layout";
import type { CapturedMap } from "./print-layout-export";

/**
 * The longitude/latitude extent of a georeferenced capture, sampled along
 * its visible boundary, as `[west, south, east, north]` (east may exceed 180 across the
 * antimeridian). Read through the affine georeference, or the sampled
 * longitude/latitude grid of a globe or pitched view; null when it has neither.
 *
 * @param captured - The main map capture.
 * @param options - Page geometry, when the map capture is cropped.
 * @returns The extent, or null.
 */
export function capturedBounds(
  captured: CapturedMap | null,
  options?: LayoutOptions,
): [number, number, number, number] | null {
  if (!captured) return null;
  const { width, height, georef, lngLatGrid } = captured;
  const locate = captureLocator(georef, lngLatGrid);
  if (!locate) return null;
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
      let [lng, lat] = locate(
        a[0] + ((b[0] - a[0]) * step) / 128,
        a[1] + ((b[1] - a[1]) * step) / 128,
      );
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
      if (lngs.length) lng += 360 * Math.round((lngs[lngs.length - 1] - lng) / 360);
      lngs.push(lng);
      lats.push(lat);
    }
  }
  // The walk ends where it began, so whole turns mean it circles a pole: a
  // globe seen from above it (GH #3551). The pole is then inside the frame.
  const turns = Math.round((lngs[lngs.length - 1] - lngs[0]) / 360);
  // The enclosed pole is the one in the frame centre's hemisphere: a view
  // centred north of the equator cannot circle the south pole.
  if (turns !== 0) lats.push(locate((x0 + x1) / 2, (y0 + y1) / 2)[1] >= 0 ? 90 : -90);
  // A grid's interior can reach further north or south than its frame edge.
  if (!georef && lngLatGrid) {
    const { cols, rows } = lngLatGrid;
    for (let row = 0; row <= rows; row++) {
      const py = (height * row) / rows;
      if (py < y0 || py > y1) continue;
      for (let col = 0; col <= cols; col++) {
        const px = (width * col) / cols;
        if (px >= x0 && px <= x1) lats.push(lngLatGrid.lats[row * (cols + 1) + col]);
      }
    }
  }
  const west = Math.min(...lngs),
    east = Math.max(...lngs);
  if (turns !== 0 || east - west >= 360 - 1e-7)
    return [-180, Math.min(...lats), 180, Math.max(...lats)];
  return [west, Math.min(...lats), east, Math.max(...lats)];
}
