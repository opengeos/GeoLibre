import { useEffect, useMemo, useState } from "react";
import type { PrintLayoutConfig } from "@geolibre/core";
import { georefLngLat } from "../../../lib/geopdf";
import {
  insetRectFor,
  resolvePageSize,
  type InsetMapOptions,
  type LayoutOptions,
} from "../../../lib/print-layout";
import { insetViewForBounds, type MercatorView } from "../../../lib/print-layout-cartography";
import { INSET_RENDER_WIDTH, renderInsetMap } from "../../../lib/print-inset-map";
import type { CapturedMap } from "../../../lib/print-layout-export";

/** Wait this long after the last change before re-rendering the inset. */
const RENDER_DEBOUNCE_MS = 300;

/**
 * The longitude/latitude extent of a georeferenced capture, from its four
 * corners, as `[west, south, east, north]` (east may exceed 180 across the
 * antimeridian). Null when the capture has no georeference.
 *
 * @param captured - The main map capture.
 * @returns The extent, or null.
 */
export function capturedBounds(
  captured: CapturedMap | null,
): [number, number, number, number] | null {
  if (!captured?.georef) return null;
  const { width, height, georef } = captured;
  const corners = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ].map(([x, y]) => georefLngLat(georef, x, y));
  if (corners.some(([lng, lat]) => !Number.isFinite(lng) || !Number.isFinite(lat))) return null;
  const lngs = corners.map(([lng]) => lng);
  const lats = corners.map(([, lat]) => lat);
  let west = Math.min(...lngs);
  let east = Math.max(...lngs);
  // A span past 180 degrees is a frame across the antimeridian, not most of
  // the world: unwrap the western corners.
  if (east - west > 180) {
    const shifted = lngs.map((lng) => (lng < 0 ? lng + 360 : lng));
    west = Math.min(...shifted);
    east = Math.max(...shifted);
  }
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
  const bounds = useMemo(() => capturedBounds(captured), [captured]);
  // The inset frame's aspect, rounded so a drag does not re-render per pixel.
  const aspect = useMemo(() => {
    const page = resolvePageSize(options);
    const rect = insetRectFor(options, insetBox, page.width, page.height);
    const value = rect.h > 0 ? rect.w / rect.h : 4 / 3;
    return Math.round(value * 20) / 20;
  }, [options, insetBox]);
  const view = useMemo<MercatorView | null>(() => {
    if (!bounds || !(aspect > 0)) return null;
    const width = INSET_RENDER_WIDTH;
    const height = Math.max(40, Math.round(width / aspect));
    return insetViewForBounds(bounds, width, height, insetZoomOffset);
  }, [bounds, aspect, insetZoomOffset]);
  const [rendered, setRendered] = useState<{
    image: HTMLCanvasElement;
    view: MercatorView;
  } | null>(null);

  useEffect(() => {
    if (!open || !showInset || !view) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      renderInsetMap(insetBasemap, view, controller.signal)
        .then((image) => {
          if (!controller.signal.aborted) setRendered({ image, view });
        })
        .catch(() => {
          // Aborted or no WebGL to spare: the inset keeps its placeholder.
        });
    }, RENDER_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, showInset, view, insetBasemap]);

  return useMemo(() => {
    if (!showInset) return null;
    // Until the new render lands, keep showing the previous one with its own
    // view, so the footprint stays registered to the image underneath it.
    return {
      box: insetBox,
      image: rendered?.image ?? null,
      view: rendered?.view ?? view,
      extentColor: insetExtentColor,
    };
  }, [showInset, insetBox, rendered, view, insetExtentColor]);
}
