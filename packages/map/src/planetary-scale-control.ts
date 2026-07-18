import {
  formatRoundNum,
  getActiveMeanRadiusMeters,
  getRoundNum,
  scaleSpan,
  type MapScaleUnit,
} from "@geolibre/core";
import maplibregl from "maplibre-gl";

// Re-exported so the nice-number rounding and unit conversion — now shared with
// the Print Layout scale bar in `@geolibre/core` — can still be imported from
// this module (and covered by planetary-scale-control.test.ts).
export { getRoundNum, scaleSpan } from "@geolibre/core";

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
 * without waiting for the next pan. The unit system (metric / imperial /
 * nautical) is set with {@link setUnit} and follows the project's map
 * preferences.
 */
export class PlanetaryScaleControl implements maplibregl.IControl {
  private map: maplibregl.Map | null = null;
  private container: HTMLElement | null = null;
  private readonly maxWidth: number;
  private unit: MapScaleUnit;
  private readonly onMove = () => this.update();

  constructor(options: { maxWidth?: number; unit?: MapScaleUnit } = {}) {
    this.maxWidth = options.maxWidth ?? 100;
    this.unit = options.unit ?? "metric";
  }

  /**
   * Set the unit system. This only stores the unit; the bar is redrawn on the
   * next {@link refresh} (or map move), so callers that change the unit outside
   * a move should follow with `refresh()`. Keeping it a pure setter lets the map
   * controller change the unit and the radius and then redraw exactly once.
   */
  setUnit(unit: MapScaleUnit): void {
    this.unit = unit;
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
    setScale(container, this.maxWidth, maxMeters, this.unit);
  }
}

/** A longitude/latitude pair in degrees (structurally a MapLibre `LngLat`). */
export interface LngLatLike {
  lng: number;
  lat: number;
}

/** Great-circle (haversine) distance in metres for a sphere of `radiusMeters`. */
export function greatCircleMeters(a: LngLatLike, b: LngLatLike, radiusMeters: number): number {
  const rad = Math.PI / 180;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const dLat = lat2 - lat1;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radiusMeters * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Size the bar and label to a round distance in the requested unit system. */
function setScale(el: HTMLElement, maxWidth: number, maxMeters: number, unit: MapScaleUnit): void {
  const { span, label } = scaleSpan(maxMeters, unit);
  const rounded = getRoundNum(span);
  // rounded ≤ span, so the bar is never wider than maxWidth; clamp anyway as a
  // hard guard against any pathological span slipping through.
  const width = Math.min(maxWidth, maxWidth * (rounded / span));
  el.style.width = `${width}px`;
  el.textContent = `${formatRoundNum(rounded)} ${label}`;
}
