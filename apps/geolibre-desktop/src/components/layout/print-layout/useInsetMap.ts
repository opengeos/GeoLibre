import { useCallback, useEffect, useMemo, useState } from "react";
import type { PrintLayoutConfig } from "@geolibre/core";
import { capturedBounds } from "../../../lib/print-capture-bounds";
import {
  insetRectFor,
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
) {
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
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setFailedKey(null);
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!open || !showInset || !requestKey || rendered?.key === requestKey) return;
    // Snapshot the serialized camera: unrelated editor changes may recreate
    // view objects but must not abort an identical request already in flight.
    const [basemap, camera] = JSON.parse(requestKey) as [
      PrintLayoutConfig["insetBasemap"],
      MercatorView,
    ];
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setFailedKey(null);
      renderInsetMap(basemap, camera, controller.signal)
        .then((image) => {
          if (!controller.signal.aborted)
            setRendered({ image, view: camera, basemap, key: requestKey });
        })
        .catch(() => {
          // A failed replacement keeps its placeholder; a cached image is
          // reusable only for the same basemap, camera, and render dimensions.
          if (!controller.signal.aborted) setFailedKey(requestKey);
        });
    }, RENDER_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, showInset, requestKey, rendered?.key, attempt]);

  const inset = useMemo<InsetMapOptions | null>(() => {
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
  return {
    inset,
    ready: !showInset || Boolean(inset?.image),
    unavailable: showInset && !requestKey,
    loading: showInset && Boolean(view) && !inset?.image && failedKey !== requestKey,
    failed: showInset && Boolean(requestKey) && failedKey === requestKey,
    retry,
  };
}
