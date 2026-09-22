import type { MapEngine, MapExtent, MapRenderSurface } from "@geolibre/map";
import { type RefObject, useEffect, useRef, useState } from "react";

/** A projected corner of the box, in CSS pixels relative to the map container. */
export interface ExtentScreenPoint {
  x: number;
  y: number;
}

interface Options {
  /**
   * Drop the overlay once the box spans more than this many degrees in either
   * direction. A near-global box has corners that project to the same pole or
   * wrap around, so the four-corner polygon degenerates into a stray diagonal.
   * Omit to keep every box.
   */
  maxSpanDeg?: number;
}

/**
 * The box's four corners in screen space, in `[NW, NE, SE, SW]` order so the
 * caller can join them straight into an SVG `<polygon points>`.
 *
 * All four are projected (not two), so the outline stays correct under rotation
 * and pitch.
 *
 * @param project - The engine's {@link MapRenderSurface.project}.
 * @param bbox - The box to outline, or `null` for none.
 * @param maxSpanDeg - See {@link Options.maxSpanDeg}.
 * @returns The corners, or `null` when there is nothing meaningful to draw.
 */
export function projectExtentCorners(
  project: MapRenderSurface["project"],
  bbox: MapExtent | null,
  maxSpanDeg?: number,
): ExtentScreenPoint[] | null {
  if (!bbox) return null;
  const [w, s, e, n] = bbox;
  if (maxSpanDeg !== undefined && (e - w > maxSpanDeg || n - s > maxSpanDeg)) return null;
  const corners: [number, number][] = [
    [w, n],
    [e, n],
    [e, s],
    [w, s],
  ];
  return corners.map((corner) => {
    const p = project(corner);
    return { x: p.x, y: p.y };
  });
}

/**
 * Project a geographic box's four corners to screen positions and keep them in
 * step with the camera, for a panel that draws its own SVG outline.
 *
 * The extract panels draw the box as an SVG rather than a style layer so it
 * stays visible above the interleaved deck.gl COG/raster overlay — which is
 * exactly the layer a raster subset is drawn over. That only needs
 * `MapRenderSurface.project`, which every engine has, so the overlay works on
 * either 2D engine; the caller gates it on the engine's `screenOverlays`
 * capability and falls back to {@link MapEngine.showExtent} for the globe
 * engines (#2475).
 *
 * @param mapControllerRef - Ref holding the live engine.
 * @param bbox - The box to outline, or `null` for none.
 * @param active - False while the owning panel is closed, which clears the
 *   overlay and drops the camera subscription.
 * @param mapReadyGeneration - Bumped whenever a map is (re)initialised, so the
 *   subscription re-attaches to the new engine.
 * @param options - Optional span guard, see {@link Options.maxSpanDeg}.
 * @returns The four corners as {@link projectExtentCorners} orders them, or
 *   `null` when there is nothing to draw.
 */
export function useExtentScreenOverlay(
  mapControllerRef: RefObject<MapEngine | null>,
  bbox: MapExtent | null,
  active: boolean,
  mapReadyGeneration: number,
  options: Options = {},
): ExtentScreenPoint[] | null {
  const [screenPoints, setScreenPoints] = useState<ExtentScreenPoint[] | null>(null);
  const { maxSpanDeg } = options;
  // Latest box, read inside the projection callback so the camera subscription
  // does not need `bbox` as a dependency (it changes on every drag mousemove).
  const bboxRef = useRef(bbox);
  bboxRef.current = bbox;
  // The current projection function, so the bbox-change effect below can
  // trigger a reproject without re-subscribing to the camera.
  const reprojectRef = useRef<() => void>(() => {});

  // Subscribed once per panel/map (not per box edit) to avoid tearing down and
  // re-attaching listeners on every drag tick.
  useEffect(() => {
    const engine = mapControllerRef.current;
    const surface = engine?.getRenderSurface();
    if (!engine || !surface || !active) {
      setScreenPoints(null);
      return;
    }
    // Called through the surface, not passed as a bare reference: MapLibre's
    // render surface *is* the map, so a detached `project` would lose its `this`.
    const reproject = () =>
      setScreenPoints(
        projectExtentCorners((point) => surface.project(point), bboxRef.current, maxSpanDeg),
      );
    reprojectRef.current = reproject;
    reproject();
    const unsubscribe = engine.onCameraMove(reproject);
    // A container resize moves the corners without a camera event of its own
    // (the engine re-centres on the same view), so watch the container too.
    // ResizeObserver is missing in jsdom-style test environments; the camera
    // subscription alone still keeps the overlay correct there.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => reproject());
    observer?.observe(surface.getContainer());
    return () => {
      unsubscribe();
      observer?.disconnect();
    };
  }, [active, mapControllerRef, mapReadyGeneration, maxSpanDeg]);

  // Reproject when the box itself changes, reusing the already-subscribed
  // projection function rather than re-attaching camera listeners.
  useEffect(() => {
    reprojectRef.current();
  }, [bbox]);

  return screenPoints;
}
