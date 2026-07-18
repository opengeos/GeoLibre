/**
 * Interactive "Draw print extent" tool for the Print Layout dialog (GH #523).
 *
 * Lets the user drag a bounding box directly on the map to define the exact
 * geographic area to export, decoupling the layout from the live viewport. The
 * box is drawn as a translucent rectangle (a temporary GeoJSON source + fill /
 * line layers) that persists after the drag so the user can see and re-draw it.
 * {@link captureMapImage} later crops the snapshot to this extent.
 */
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";

/** A geographic bounding box as `[west, south, east, north]`. */
export type PrintExtent = [number, number, number, number];

const SOURCE_ID = "geolibre-print-extent";
const FILL_LAYER_ID = "geolibre-print-extent-fill";
const LINE_LAYER_ID = "geolibre-print-extent-line";

/** Wrap a longitude into the (-180, 180] range. Mapping the wrap point to +180
 * (not -180) avoids a near-world-wide bbox when a drag endpoint lands exactly on
 * the antimeridian alongside a positive longitude. */
function normalizeLng(lng: number): number {
  const wrapped = (((lng % 360) + 540) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
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

/** Add the fill/line layers for the extent source if they are not present. */
function ensurePrintExtentLayers(map: MapLibreMap): void {
  if (!map.getLayer(FILL_LAYER_ID)) {
    map.addLayer({
      id: FILL_LAYER_ID,
      type: "fill",
      source: SOURCE_ID,
      paint: { "fill-color": "#2563eb", "fill-opacity": 0.12 },
    });
  }
  if (!map.getLayer(LINE_LAYER_ID)) {
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
}

/** Ensure the extent source + layers exist, then set them to show `extent`. */
export function showPrintExtent(map: MapLibreMap, extent: PrintExtent): void {
  const data = extentToFeature(extent);
  const existing = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
  if (existing) {
    existing.setData(data);
    // Re-add the layers if they were removed externally (e.g. a style mutation)
    // while the source was left in place, and make them visible again -- they
    // may have been hidden by setPrintExtentVisible during a capture.
    ensurePrintExtentLayers(map);
    setPrintExtentVisible(map, true);
    return;
  }
  map.addSource(SOURCE_ID, { type: "geojson", data });
  ensurePrintExtentLayers(map);
}

/**
 * Toggle the extent box's visibility without removing it. Used to hide the box
 * while {@link captureMapImage} reads the drawing buffer, so the box outline is
 * never baked into the exported image.
 */
export function setPrintExtentVisible(map: MapLibreMap, visible: boolean): void {
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
  /** Draw the extent box on the map as a MapLibre fill/line source (default
   * true). Set false when the caller renders its own preview (e.g. a DOM/SVG
   * overlay that must sit above an interleaved deck.gl raster, which occludes
   * MapLibre layers). */
  drawBox?: boolean;
  /** Called with the current extent as the box is dragged (and `null` when the
   * draw ends or is cancelled), so a caller drawing its own preview can follow
   * the drag. */
  onPreview?: (extent: PrintExtent | null) => void;
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
      map.off("mousemove", onMapMove);
      map.off("mouseup", onMapUp);
      window.removeEventListener("mousemove", onWindowMove);
      window.removeEventListener("mouseup", onWindowUp);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
      options.signal?.removeEventListener("abort", onAbort);
      canvas.style.cursor = prevCursor;
      if (panWasEnabled) map.dragPan.enable();
      if (scrollWasEnabled) map.scrollZoom.enable();
      if (dblClickWasEnabled) map.doubleClickZoom.enable();
      // Clear any caller-drawn preview on every exit (commit, cancel, abort).
      options.onPreview?.(null);
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
      // Note: a box that itself *crosses* the antimeridian is not supported (an
      // axis-aligned [w,s,e,n] can't express the wrap); such a drag yields a
      // wide bbox. Acceptable for now given how niche printing across the date
      // line is.
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
      start && shiftKey && options.aspect ? snapToAspect(start, raw, options.aspect) : raw;

    const preview = (raw: { x: number; y: number }, shiftKey: boolean) => {
      if (!start) return;
      const extent = extentFromPixels(start, settlePoint(raw, shiftKey));
      if (options.drawBox !== false) showPrintExtent(map, extent);
      options.onPreview?.(extent);
    };

    const commit = (raw: { x: number; y: number }, shiftKey: boolean) => {
      // Ignore a stray mouseup before a press on the map (start still null):
      // it must not cancel the not-yet-started draw. A real click (start set,
      // no drag) still cancels via the near-zero check below.
      if (settled || !start) return;
      const end = settlePoint(raw, shiftKey);
      // Cancel a click-with-no-drag *or* a sliver thinner than 4px on either
      // axis: a near-degenerate extent crops to a useless strip once cover-
      // scaled onto the page, so reject it (OR, not AND) and let the user
      // redraw rather than export a distorted band.
      if (Math.abs(end.x - start.x) < 4 || Math.abs(end.y - start.y) < 4) {
        return finish(null);
      }
      const extent = extentFromPixels(start, end);
      if (options.drawBox !== false) showPrintExtent(map, extent);
      finish(extent);
    };

    // Schedule a single preview per animation frame from the latest pointer
    // position (both the map and window move handlers feed this, so over-canvas
    // motion that fires both is still drawn only once per frame).
    const queueMove = (clientX: number, clientY: number, shiftKey: boolean) => {
      if (!start) return;
      pendingMove = { x: clientX, y: clientY, shiftKey };
      if (!moveRaf) {
        moveRaf = requestAnimationFrame(() => {
          moveRaf = 0;
          const move = pendingMove;
          pendingMove = null;
          if (move) preview(pointFromClient(move.x, move.y), move.shiftKey);
        });
      }
    };

    // A mousedown on the map canvas starts the draw. The live rubber band is
    // driven by MapLibre's own mousemove (reliable across the desktop and
    // embedded webviews), while the window listeners extend tracking to a
    // drag/release that leaves the canvas. All points come from pointFromClient
    // so start and end share one canvas-relative coordinate space.
    const onDown = (e: MapMouseEvent) => {
      // Primary button only: a right-click would open the context menu and
      // leave the drag half-started.
      if (e.originalEvent.button !== 0) return;
      start = pointFromClient(e.originalEvent.clientX, e.originalEvent.clientY);
    };
    const onMapMove = (e: MapMouseEvent) =>
      queueMove(e.originalEvent.clientX, e.originalEvent.clientY, e.originalEvent.shiftKey);
    const onWindowMove = (e: MouseEvent) => queueMove(e.clientX, e.clientY, e.shiftKey);
    const onMapUp = (e: MapMouseEvent) => {
      if (e.originalEvent.button !== 0) return;
      commit(
        pointFromClient(e.originalEvent.clientX, e.originalEvent.clientY),
        e.originalEvent.shiftKey,
      );
    };
    const onWindowUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      commit(pointFromClient(e.clientX, e.clientY), e.shiftKey);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(null);
    };
    // Cancel if the window loses focus mid-drag (Alt+Tab, a system dialog): the
    // mouseup would never arrive, leaving the interaction armed so the next
    // unrelated click anywhere would commit a stray extent. Note: in an embedded
    // iframe this also fires when the parent frame is clicked; that's fine for
    // the desktop and top-level web builds, but revisit if the mouse-only path
    // below is ever extended to a Jupyter/embedded context.
    const onBlur = () => finish(null);

    // TODO: mouse-only for now (the print workflow is desktop-centric). Add a
    // touch / pointer-event path for tablets and touchscreens as a follow-up.
    map.on("mousedown", onDown);
    map.on("mousemove", onMapMove);
    map.on("mouseup", onMapUp);
    window.addEventListener("mousemove", onWindowMove);
    window.addEventListener("mouseup", onWindowUp);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    options.signal?.addEventListener("abort", onAbort);
  });
}
