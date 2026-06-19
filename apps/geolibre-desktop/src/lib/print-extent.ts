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
    x: start.x + Math.sign(dx || 1) * w,
    y: start.y + Math.sign(dy || 1) * h,
  };
}

export interface DrawPrintExtentOptions {
  /** Paper aspect ratio (width / height) used for Shift-to-snap. */
  aspect?: number;
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
    const canvas = map.getCanvas();
    const prevCursor = canvas.style.cursor;
    canvas.style.cursor = "crosshair";
    const panWasEnabled = map.dragPan.isEnabled();
    map.dragPan.disable();

    let start: { x: number; y: number } | null = null;
    let settled = false;

    const finish = (result: PrintExtent | null) => {
      if (settled) return;
      settled = true;
      map.off("mousedown", onDown);
      map.off("mousemove", onMove);
      map.off("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
      canvas.style.cursor = prevCursor;
      if (panWasEnabled) map.dragPan.enable();
      resolve(result);
    };

    const extentFromPixels = (
      a: { x: number; y: number },
      b: { x: number; y: number },
    ): PrintExtent => {
      const p1 = map.unproject([a.x, a.y]);
      const p2 = map.unproject([b.x, b.y]);
      return [
        Math.min(p1.lng, p2.lng),
        Math.min(p1.lat, p2.lat),
        Math.max(p1.lng, p2.lng),
        Math.max(p1.lat, p2.lat),
      ];
    };

    const endPoint = (e: MapMouseEvent): { x: number; y: number } => {
      const raw = { x: e.point.x, y: e.point.y };
      return start && e.originalEvent.shiftKey && options.aspect
        ? snapToAspect(start, raw, options.aspect)
        : raw;
    };

    const onDown = (e: MapMouseEvent) => {
      start = { x: e.point.x, y: e.point.y };
    };
    const onMove = (e: MapMouseEvent) => {
      if (!start) return;
      showPrintExtent(map, extentFromPixels(start, endPoint(e)));
    };
    const onUp = (e: MapMouseEvent) => {
      if (!start) return finish(null);
      const end = endPoint(e);
      // Treat a near-zero drag as a cancelled click rather than a sliver box.
      if (Math.abs(end.x - start.x) < 4 || Math.abs(end.y - start.y) < 4) {
        return finish(null);
      }
      const extent = extentFromPixels(start, end);
      showPrintExtent(map, extent);
      finish(extent);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(null);
    };

    map.on("mousedown", onDown);
    map.on("mousemove", onMove);
    map.on("mouseup", onUp);
    window.addEventListener("keydown", onKey);
  });
}
