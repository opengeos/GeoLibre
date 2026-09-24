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

  /** Screen points for a ring or line, or null when any vertex cannot project. */
  const project = (coordinates: Position[]) => {
    const points: string[] = [];
    for (const [lng, lat] of coordinates) {
      try {
        const point = surface.project([lng, lat]);
        points.push(`${point.x},${point.y}`);
      } catch {
        return null;
      }
    }
    return points.join(" ");
  };
  const update = () => {
    if (removed) return;
    svg.replaceChildren();
    const ring = accuracy && project(accuracy);
    if (ring) {
      const polygon = document.createElementNS(SVG_NS, "polygon");
      polygon.setAttribute("points", ring);
      polygon.setAttribute("fill", colors.accuracy);
      polygon.setAttribute("fill-opacity", "0.15");
      polygon.setAttribute("stroke", colors.accuracy);
      polygon.setAttribute("stroke-opacity", "0.6");
      svg.appendChild(polygon);
    }
    for (const line of track) {
      const points = line.length >= 2 ? project(line) : null;
      if (!points) continue;
      const polyline = document.createElementNS(SVG_NS, "polyline");
      polyline.setAttribute("points", points);
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
      svg.remove();
    },
  };
}
