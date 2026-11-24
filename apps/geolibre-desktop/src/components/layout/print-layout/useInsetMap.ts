import { useEffect, useMemo, useState } from "react";
import type { PrintLayoutConfig } from "@geolibre/core";
import { georefLngLat } from "../../../lib/geopdf";
import {
  insetRectFor,
  mapImagePlacement,
  resolvePageSize,
  type InsetMapOptions,
  type LayoutOptions,
} from "../../../lib/print-layout";
import {
  insetViewForBounds,
  insetRenderSize,
  type MercatorView,
} from "../../../lib/print-layout-cartography";
import { INSET_RENDER_MAX_DIMENSION, renderInsetMap } from "../../../lib/print-inset-map";
import type { CapturedMap } from "../../../lib/print-layout-export";

/** Wait this long after the last change before re-rendering the inset. */
const RENDER_DEBOUNCE_MS = 300;

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

/**
 * Render the overview / inset map for the composer (GH #3530): a hidden map
 * with the chosen basemap, centred on the main capture and zoomed out by the
 * layout's zoom offset. Re-renders (debounced) when the capture, the inset's
 * aspect, the basemap or the zoom offset change.
 *
 * @param open - Whether the dialog is open.
 * @param layout - The persisted layout.
 * @param options - The page options (for the inset frame's aspect).
 * @param captured - The main capture the inset locates.
 * @returns The inset to compose, or null when the inset is off.
 */
export function useInsetMap(
  open: boolean,
  layout: PrintLayoutConfig,
  options: LayoutOptions,
  captured: CapturedMap | null,
): InsetMapOptions | null {
  const { showInset, insetBasemap, insetZoomOffset, insetExtentColor, insetBox } = layout;
  const bounds = useMemo(() => capturedBounds(captured, options), [captured, options]);
  // The inset frame's aspect, rounded so a drag does not re-render per pixel.
  const aspect = useMemo(() => {
    const page = resolvePageSize(options);
    const rect = insetRectFor(options, insetBox, page.width, page.height);
    const value = rect.h > 0 ? rect.w / rect.h : 4 / 3;
    return value < 0.05 ? value : Math.round(value * 20) / 20;
  }, [options, insetBox]);
  const view = useMemo<MercatorView | null>(() => {
    if (!bounds || !(aspect > 0)) return null;
    const size = insetRenderSize(aspect, INSET_RENDER_MAX_DIMENSION);
    return insetViewForBounds(bounds, size.width, size.height, insetZoomOffset);
  }, [bounds, aspect, insetZoomOffset]);
  const [rendered, setRendered] = useState<{
    image: HTMLCanvasElement;
    view: MercatorView;
    basemap: PrintLayoutConfig["insetBasemap"];
    key: string;
  } | null>(null);
  const requestKey = view ? JSON.stringify([insetBasemap, view]) : null;

  useEffect(() => {
    if (!open || !showInset || !view || !requestKey || rendered?.key === requestKey) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      renderInsetMap(insetBasemap, view, controller.signal)
        .then((image) => {
          if (!controller.signal.aborted)
            setRendered({ image, view, basemap: insetBasemap, key: requestKey });
        })
        .catch(() => {
          // A failed replacement keeps its placeholder; a cached image is
          // reusable only for the same basemap, camera, and render dimensions.
        });
    }, RENDER_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, showInset, view, insetBasemap, requestKey, rendered?.key]);

  return useMemo(() => {
    if (!showInset) return null;
    const current = rendered?.key === requestKey ? rendered : null;
    return {
      box: insetBox,
      image: current?.image ?? null,
      view: current?.view ?? view,
      extentColor: insetExtentColor,
      attribution:
        (current?.basemap ?? insetBasemap) === "osm"
          ? "© OpenStreetMap contributors"
          : "OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors",
    };
  }, [showInset, insetBox, rendered, view, insetExtentColor, insetBasemap, requestKey]);
}
