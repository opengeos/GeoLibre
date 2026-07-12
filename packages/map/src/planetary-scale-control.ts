import { getActiveMeanRadiusMeters } from "@geolibre/core";
import maplibregl from "maplibre-gl";

/**
 * A metric scale bar that respects the active celestial body's radius.
 *
 * MapLibre's built-in `ScaleControl` derives ground distance from the Web-
 * Mercator meters-per-pixel using Earth's radius, so on a Moon / Mars / Mercury
 * basemap it is wrong by the ratio of that body's circumference to Earth's
 * (e.g. the Moon reads ~3.7× too far). This drop-in replacement does the same
 * nice-number rounding and reuses MapLibre's `.maplibregl-ctrl-scale` styling,
 * but measures distance with the active body's mean radius — the same radius the
 * measurement tools use (see `getActiveMeanRadiusMeters`) — so the bar is correct
 * on every body.
 *
 * The radius is read lazily on each update, and {@link refresh} lets the map
 * controller redraw the bar the instant the basemap (and thus the body) changes,
 * without waiting for the next pan.
 */
export class PlanetaryScaleControl implements maplibregl.IControl {
  private map: maplibregl.Map | null = null;
  private container: HTMLElement | null = null;
  private readonly maxWidth: number;
  private readonly onMove = () => this.update();

  constructor(options: { maxWidth?: number } = {}) {
    this.maxWidth = options.maxWidth ?? 100;
  }

  onAdd(map: maplibregl.Map): HTMLElement {
    this.map = map;
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-scale";
    this.container = container;
    map.on("move", this.onMove);
    this.update();
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
    this.map?.off("move", this.onMove);
    this.map = null;
  }

  /** Recompute the bar now — e.g. after the active celestial body changed. */
  refresh(): void {
    this.update();
  }

  private update(): void {
    const map = this.map;
    const container = this.container;
    if (!map || !container) return;
    // Distance spanned by `maxWidth` pixels, sampled around the map *centre*.
    // Sampling the canvas edge (as MapLibre's built-in does) breaks on the globe
    // projection: when the globe doesn't fill the canvas, an edge point lands in
    // space and unprojects to garbage, blowing the bar up to the full width. The
    // centre is always on the surface.
    const rect = map.getContainer();
    const cx = rect.clientWidth / 2;
    const cy = rect.clientHeight / 2;
    const half = this.maxWidth / 2;
    const left = map.unproject([cx - half, cy]);
    const right = map.unproject([cx + half, cy]);
    const maxMeters = greatCircleMeters(left, right, getActiveMeanRadiusMeters());
    if (!Number.isFinite(maxMeters) || maxMeters <= 0) {
      // Degenerate span (e.g. an unsized map) — hide rather than stretch.
      container.style.display = "none";
      return;
    }
    container.style.display = "";
    setMetricScale(container, this.maxWidth, maxMeters);
  }
}

/** A longitude/latitude pair in degrees (structurally a MapLibre `LngLat`). */
export interface LngLatLike {
  lng: number;
  lat: number;
}

/** Great-circle (haversine) distance in metres for a sphere of `radiusMeters`. */
export function greatCircleMeters(
  a: LngLatLike,
  b: LngLatLike,
  radiusMeters: number,
): number {
  const rad = Math.PI / 180;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const dLat = lat2 - lat1;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radiusMeters * Math.asin(Math.min(1, Math.sqrt(h)));
}

// The largest "1 / 2 / 3 / 5 / 10 × 10ⁿ" number that does not exceed `num`, so
// the bar lands on a readable round value. Uses log10 for the magnitude (unlike
// MapLibre's digit-count trick, which returns 1 for any 0 < num < 1 and so
// rounds *up* — producing a bar wider than maxWidth for sub-unit spans).
export function getRoundNum(num: number): number {
  if (!(num > 0)) return 0;
  const pow10 = Math.pow(10, Math.floor(Math.log10(num)));
  const d = num / pow10;
  const nice = d >= 10 ? 10 : d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1;
  return pow10 * nice;
}

/** Trim trailing-zero noise from a rounded value (e.g. 0.5, 2, 300). */
function formatNum(value: number): string {
  return Number.parseFloat(value.toPrecision(12)).toString();
}

/** Size the bar and label to a round metric distance (km above 1 km, else m). */
function setMetricScale(
  el: HTMLElement,
  maxWidth: number,
  maxMeters: number,
): void {
  const inKm = maxMeters >= 1000;
  const span = inKm ? maxMeters / 1000 : maxMeters;
  const rounded = getRoundNum(span);
  // rounded ≤ span, so the bar is never wider than maxWidth; clamp anyway as a
  // hard guard against any pathological span slipping through.
  const width = Math.min(maxWidth, maxWidth * (rounded / span));
  el.style.width = `${width}px`;
  el.textContent = `${formatNum(rounded)} ${inKm ? "km" : "m"}`;
}
