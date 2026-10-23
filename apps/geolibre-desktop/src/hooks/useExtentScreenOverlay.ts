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
 * Whether a panel should draw its own screen-space outline for this engine, or
 * leave the extent to {@link MapEngine.showExtent}.
 *
 * Every engine has a render surface, so the capability is what separates them:
 * on a globe engine `project` either throws for a corner it cannot clamp into
 * view (Cesium) or silently returns `{x: 0, y: 0}` (ArcGIS), and the engine
 * draws the extent natively anyway.
 *
 * @param engine - The live engine, or null before one is published.
 * @param active - False while the owning panel is closed.
 * @returns True when the SVG overlay is the right way to draw the box.
 */
export function usesScreenOverlay(engine: MapEngine | null | undefined, active: boolean): boolean {
  return Boolean(active && engine?.capabilities.screenOverlays && engine.getRenderSurface());
}

/** Whether `bbox` is inside the caller's span guard. One definition, so the
 * overlay and the caller's native fallback cannot disagree about a wide box. */
function withinSpan(bbox: MapExtent, maxSpanDeg: number | undefined): boolean {
  const [w, s, e, n] = bbox;
  return maxSpanDeg === undefined || (e - w <= maxSpanDeg && n - s <= maxSpanDeg);
}

/**
 * Whether {@link useExtentScreenOverlay} will actually outline `bbox`, so the
 * caller knows when to fall back to {@link MapEngine.showExtent}.
 *
 * Not the same question as {@link usesScreenOverlay}: an engine that takes the
 * overlay still opts out of a box wider than its span guard, and a wide box
 * with no outline at all is worse than the engine's own rectangle — which has
 * no span guard, because a native line does not degenerate.
 *
 * Deliberately derived from `bbox` rather than from the returned points, so a
 * caller can depend on it in an effect without re-running on every camera move.
 *
 * @param engine - The live engine, or null before one is published.
 * @param active - False while the owning panel is closed.
 * @param bbox - The box to outline, or `null` for none.
 * @param maxSpanDeg - The same guard passed to the hook, if any.
 * @returns True when the SVG overlay covers this box.
 */
export function screenOverlayCovers(
  engine: MapEngine | null | undefined,
  active: boolean,
  bbox: MapExtent | null,
  maxSpanDeg?: number,
): boolean {
  return Boolean(bbox && usesScreenOverlay(engine, active) && withinSpan(bbox, maxSpanDeg));
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
  if (!bbox || !withinSpan(bbox, maxSpanDeg)) return null;
  const [w, s, e, n] = bbox;
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
 * either 2D engine. It returns nothing on an engine without the
 * `screenOverlays` capability, which is where the caller falls back to
 * {@link MapEngine.showExtent} instead (#2475).
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
    // Checked here rather than left to each caller, so a panel cannot forget it
    // and end up with both this overlay and the engine's native one.
    if (!engine || !surface || !usesScreenOverlay(engine, active)) {
      // Drop the stale closure too, or a later `bbox` change would reproject
      // through the engine this effect just let go of.
      reprojectRef.current = () => {};
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
      reprojectRef.current = () => {};
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
