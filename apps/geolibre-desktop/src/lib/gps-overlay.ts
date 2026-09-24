import type { MapEngine } from "@geolibre/map";
import type { Position } from "geojson";

const SVG_NS = "http://www.w3.org/2000/svg";

/** The GPS accuracy circle and recorded track, drawn over any renderer. */
export interface GpsOverlay {
  /** The accuracy circle's ring, or null to hide it. */
  setAccuracy(ring: Position[] | null): void;
  /** The recorded track's line segments. */
  setTrack(lines: Position[][]): void;
  remove(): void;
}

/**
 * Draw the GPS accuracy circle and track as SVG over the engine's render
 * surface, reprojected as the camera moves. The MapLibre map draws them as
 * style layers; this serves every renderer without one (ArcGIS, #2477).
 *
 * @param engine - The live map engine.
 * @param colors - The accuracy circle's and the track's colours.
 * @returns The overlay, or null when the engine has no render surface.
 */
export function createGpsOverlay(
  engine: MapEngine,
  colors: { accuracy: string; track: string },
): GpsOverlay | null {
  const surface = engine.getRenderSurface();
  if (!surface) return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.dataset.gpsOverlay = "true";
  Object.assign(svg.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    zIndex: "4",
  });
  surface.getContainer().appendChild(svg);
  let accuracy: Position[] | null = null;
  let track: Position[][] = [];
  let removed = false;

  /**
   * Screen points for a ring or line, as runs of consecutive vertices that
   * project: a vertex a globe cannot project (its far side) breaks the line
   * there rather than dropping all of it.
   */
  const projectRuns = (coordinates: Position[]) => {
    const runs: string[][] = [[]];
    for (const [lng, lat] of coordinates) {
      try {
        const point = surface.project([lng, lat]);
        runs[runs.length - 1].push(`${point.x},${point.y}`);
      } catch {
        if (runs[runs.length - 1].length) runs.push([]);
      }
    }
    return runs.filter((run) => run.length);
  };
  let frame: number | null = null;
  // Camera moves fire every animation frame; redraw at most once per frame.
  const update = () => {
    if (removed || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      draw();
    });
  };
  const draw = () => {
    if (removed) return;
    svg.replaceChildren();
    // A ring is drawn only whole: a partial circle would read as a wedge.
    const ringRuns = accuracy ? projectRuns(accuracy) : [];
    const ring =
      accuracy && ringRuns.length === 1 && ringRuns[0].length === accuracy.length
        ? ringRuns[0].join(" ")
        : null;
    if (ring) {
      const polygon = document.createElementNS(SVG_NS, "polygon");
      polygon.setAttribute("points", ring);
      polygon.setAttribute("fill", colors.accuracy);
      polygon.setAttribute("fill-opacity", "0.15");
      polygon.setAttribute("stroke", colors.accuracy);
      polygon.setAttribute("stroke-opacity", "0.6");
      svg.appendChild(polygon);
    }
    for (const run of track.flatMap(projectRuns)) {
      if (run.length < 2) continue;
      const polyline = document.createElementNS(SVG_NS, "polyline");
      polyline.setAttribute("points", run.join(" "));
      polyline.setAttribute("fill", "none");
      polyline.setAttribute("stroke", colors.track);
      polyline.setAttribute("stroke-width", "3");
      polyline.setAttribute("stroke-linejoin", "round");
      polyline.setAttribute("stroke-linecap", "round");
      svg.appendChild(polyline);
    }
  };
  const stopMoving = engine.onCameraMove(update);
  const resize = new ResizeObserver(update);
  resize.observe(surface.getContainer());
  return {
    setAccuracy(ring) {
      accuracy = ring;
      update();
    },
    setTrack(lines) {
      track = lines;
      update();
    },
    remove() {
      if (removed) return;
      removed = true;
      stopMoving();
      resize.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      svg.remove();
    },
  };
}
