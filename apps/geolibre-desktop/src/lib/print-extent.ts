/**
 * Interactive "Draw print extent" tool for the Print Layout dialog (GH #523).
 *
 * Lets the user drag a bounding box directly on the map to define the exact
 * geographic area to export, decoupling the layout from the live viewport. The
 * box is drawn as a translucent rectangle (a temporary GeoJSON source + fill /
 * line layers) that persists after the drag so the user can see and re-draw it.
 * {@link captureMapImage} later crops the snapshot to this extent.
 */
import type {
  GeoJSONSource,
  Map as MapLibreMap,
  MapMouseEvent,
} from "maplibre-gl";

/** A geographic bounding box as `[west, south, east, north]`. */
export type PrintExtent = [number, number, number, number];

const SOURCE_ID = "geolibre-print-extent";
const FILL_LAYER_ID = "geolibre-print-extent-fill";
const LINE_LAYER_ID = "geolibre-print-extent-line";

/** Wrap a longitude into the [-180, 180) range. */
function normalizeLng(lng: number): number {
  return (((lng % 360) + 540) % 360) - 180;
}

function extentToFeature(extent: PrintExtent): GeoJSON.Feature<GeoJSON.Polygon> {
  const [w, s, e, n] = extent;
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ],
      ],
    },
  };
}

/** Ensure the extent source + layers exist, then set them to show `extent`. */
export function showPrintExtent(map: MapLibreMap, extent: PrintExtent): void {
  const data = extentToFeature(extent);
  const existing = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
  if (existing) {
    existing.setData(data);
    // Keep the function idempotent w.r.t. visibility: the layers may have been
    // hidden by setPrintExtentVisible (e.g. during a capture), so re-showing
    // the extent must make them visible again rather than silently no-op.
    setPrintExtentVisible(map, true);
    return;
  }
  map.addSource(SOURCE_ID, { type: "geojson", data });
  map.addLayer({
    id: FILL_LAYER_ID,
    type: "fill",
    source: SOURCE_ID,
    paint: { "fill-color": "#2563eb", "fill-opacity": 0.12 },
  });
  map.addLayer({
    id: LINE_LAYER_ID,
    type: "line",
    source: SOURCE_ID,
    paint: {
      "line-color": "#2563eb",
      "line-width": 2,
      "line-dasharray": [3, 2],
    },
  });
}

/**
 * Toggle the extent box's visibility without removing it. Used to hide the box
 * while {@link captureMapImage} reads the drawing buffer, so the box outline is
 * never baked into the exported image.
 */
export function setPrintExtentVisible(
  map: MapLibreMap,
  visible: boolean,
): void {
  const value = visible ? "visible" : "none";
  for (const id of [FILL_LAYER_ID, LINE_LAYER_ID]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", value);
  }
}

/** Remove the extent box from the map (no-op if it was never drawn). */
export function clearPrintExtent(map: MapLibreMap): void {
  if (map.getLayer(LINE_LAYER_ID)) map.removeLayer(LINE_LAYER_ID);
  if (map.getLayer(FILL_LAYER_ID)) map.removeLayer(FILL_LAYER_ID);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
}

/**
 * Snap a drag end point to a target aspect ratio (width / height) in screen
 * space, preserving the drag direction. Used while Shift is held so the box
 * matches the chosen paper's proportions and nothing extra is cropped.
 */
function snapToAspect(
  start: { x: number; y: number },
  end: { x: number; y: number },
  aspect: number,
): { x: number; y: number } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (!Number.isFinite(aspect) || aspect <= 0) return end;
  // Grow to the larger of the two implied sizes so the box always covers the
  // pointer, then re-derive the constrained dimension from the aspect ratio.
  const w = Math.max(Math.abs(dx), Math.abs(dy) * aspect);
  const h = w / aspect;
  return {
    x: start.x + (Math.sign(dx) || 1) * w,
    y: start.y + (Math.sign(dy) || 1) * h,
  };
}

export interface DrawPrintExtentOptions {
  /** Paper aspect ratio (width / height) used for Shift-to-snap. */
  aspect?: number;
  /** Aborts the interaction (resolves with `null`) e.g. on dialog unmount. */
  signal?: AbortSignal;
}

/**
 * Enter interactive draw mode: the next click-and-drag on the map defines the
 * print extent. Resolves with the drawn extent, or `null` if the user cancels
 * (Escape) or the gesture is degenerate (a click with no drag).
 *
 * Map panning is suspended during the drag and restored afterwards; the drawn
 * box is left on the map so the caller can show it until it is cleared.
 */
export function drawPrintExtent(
  map: MapLibreMap,
  options: DrawPrintExtentOptions = {},
): Promise<PrintExtent | null> {
  return new Promise((resolve) => {
    // Already-aborted signal: resolve immediately without touching the map.
    if (options.signal?.aborted) return resolve(null);

    const canvas = map.getCanvas();
    const prevCursor = canvas.style.cursor;
    canvas.style.cursor = "crosshair";
    // Suspend the map gestures that would fight the draw: panning moves the map
    // under the box, and wheel / double-click zoom would change the projection
    // mid-draw so the previewed box no longer matches the captured extent.
    const panWasEnabled = map.dragPan.isEnabled();
    const scrollWasEnabled = map.scrollZoom.isEnabled();
    const dblClickWasEnabled = map.doubleClickZoom.isEnabled();
    map.dragPan.disable();
    map.scrollZoom.disable();
    map.doubleClickZoom.disable();

    let start: { x: number; y: number } | null = null;
    let settled = false;
    let moveRaf = 0;
    let pendingMove: { x: number; y: number; shiftKey: boolean } | null = null;

    const finish = (result: PrintExtent | null) => {
      if (settled) return;
      settled = true;
      if (moveRaf) cancelAnimationFrame(moveRaf);
      map.off("mousedown", onDown);
      window.removeEventListener("mousemove", onWindowMove);
      window.removeEventListener("mouseup", onWindowUp);
      window.removeEventListener("keydown", onKey);
      options.signal?.removeEventListener("abort", onAbort);
      canvas.style.cursor = prevCursor;
      if (panWasEnabled) map.dragPan.enable();
      if (scrollWasEnabled) map.scrollZoom.enable();
      if (dblClickWasEnabled) map.doubleClickZoom.enable();
      resolve(result);
    };
    const onAbort = () => finish(null);

    const extentFromPixels = (
      a: { x: number; y: number },
      b: { x: number; y: number },
    ): PrintExtent => {
      const p1 = map.unproject([a.x, a.y]);
      const p2 = map.unproject([b.x, b.y]);
      // Normalize to [-180, 180): map.unproject can return out-of-range
      // longitudes on world-copy maps (e.g. centred near the antimeridian),
      // which would otherwise make Math.min/max yield a near-world-wide bbox.
      const lng1 = normalizeLng(p1.lng);
      const lng2 = normalizeLng(p2.lng);
      return [
        Math.min(lng1, lng2),
        Math.min(p1.lat, p2.lat),
        Math.max(lng1, lng2),
        Math.max(p1.lat, p2.lat),
      ];
    };

    // Canvas-relative point from a native event, so releases/moves outside the
    // map container are still handled (window listeners below).
    const pointFromClient = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    };

    const settlePoint = (
      raw: { x: number; y: number },
      shiftKey: boolean,
    ): { x: number; y: number } =>
      start && shiftKey && options.aspect
        ? snapToAspect(start, raw, options.aspect)
        : raw;

    const preview = (raw: { x: number; y: number }, shiftKey: boolean) => {
      if (!start) return;
      showPrintExtent(map, extentFromPixels(start, settlePoint(raw, shiftKey)));
    };

    const commit = (raw: { x: number; y: number }, shiftKey: boolean) => {
      if (!start) return finish(null);
      const end = settlePoint(raw, shiftKey);
      // Treat a near-zero drag as a cancelled click rather than a sliver box.
      if (Math.abs(end.x - start.x) < 4 || Math.abs(end.y - start.y) < 4) {
        return finish(null);
      }
      const extent = extentFromPixels(start, end);
      showPrintExtent(map, extent);
      finish(extent);
    };

    // Only a mousedown that lands on the map canvas starts a draw; everything
    // after is tracked on the window so a drag/release outside the canvas still
    // works. All points are derived via pointFromClient so start and end share
    // the same (canvas-relative) coordinate space even if the canvas is inset
    // within its container.
    const onDown = (e: MapMouseEvent) => {
      // Primary button only: a right-click would open the context menu and
      // leave the drag half-started.
      if (e.originalEvent.button !== 0) return;
      start = pointFromClient(e.originalEvent.clientX, e.originalEvent.clientY);
    };
    const onWindowMove = (e: MouseEvent) => {
      // Coalesce to one redraw per frame: setData re-parses the GeoJSON and
      // schedules a repaint, which is wasteful on fast pointer motion.
      pendingMove = { x: e.clientX, y: e.clientY, shiftKey: e.shiftKey };
      if (!moveRaf) {
        moveRaf = requestAnimationFrame(() => {
          moveRaf = 0;
          if (pendingMove)
            preview(
              pointFromClient(pendingMove.x, pendingMove.y),
              pendingMove.shiftKey,
            );
        });
      }
    };
    const onWindowUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      commit(pointFromClient(e.clientX, e.clientY), e.shiftKey);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(null);
    };

    map.on("mousedown", onDown);
    window.addEventListener("mousemove", onWindowMove);
    window.addEventListener("mouseup", onWindowUp);
    window.addEventListener("keydown", onKey);
    options.signal?.addEventListener("abort", onAbort);
  });
}
