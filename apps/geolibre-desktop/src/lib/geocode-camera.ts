import type { GeocodeMatch } from "@geolibre/core";

/**
 * Zoom a place without an extent is shown at (or the current zoom, when the
 * map is already closer). Only the fallback: a match that carries a bounding
 * box is framed by its box instead.
 */
export const POINT_RESULT_ZOOM = 12;

/**
 * Smallest north-south span, in degrees (about 550 m), a result's box is
 * framed at. A street address or a building comes back with a box a few tens
 * of meters wide, and fitting that exactly would dive to the map's maximum
 * zoom; padding it to this span keeps such results at street level (about zoom
 * 16) on every engine, none of which takes a max zoom for a fit.
 */
export const MIN_RESULT_SPAN_DEG = 0.005;

/** Web Mercator's latitude limit; a box reaching a pole is clipped to it. */
const MAX_MERCATOR_LAT = 85.051129;

/** Where the camera goes for a picked search result. */
export type GeocodeCamera =
  | {
      /** Frame `[west, south, east, north]` with the engine's standard padding. */
      kind: "bounds";
      bounds: [number, number, number, number];
    }
  | {
      /** Fly to a point at a fixed zoom: the result reported no usable extent. */
      kind: "center";
      center: [number, number];
      zoom: number;
    };

/**
 * Decide how to frame a picked geocoder result. A result with a bounding box
 * (a country, a state, a lake) is fit to that box so the whole place is in
 * view; a tiny box (an address) is first widened to {@link MIN_RESULT_SPAN_DEG}
 * so the fit stops at street level. A result without a box, or with one that
 * crosses the antimeridian (which the 2D engines cannot fit as given), flies to
 * its point at {@link POINT_RESULT_ZOOM}, never zooming the map out.
 *
 * @param match - The picked geocoder match.
 * @param currentZoom - The map's current zoom, for the point fallback.
 * @returns The camera move to make.
 */
export function geocodeResultCamera(match: GeocodeMatch, currentZoom: number): GeocodeCamera {
  const bbox = match.bbox;
  if (!bbox || bbox[0] > bbox[2]) {
    return {
      kind: "center",
      center: [match.lon, match.lat],
      zoom: Math.max(Number.isFinite(currentZoom) ? currentZoom : 0, POINT_RESULT_ZOOM),
    };
  }
  let [west, south, east, north] = bbox;
  south = Math.max(south, -MAX_MERCATOR_LAT);
  north = Math.min(north, MAX_MERCATOR_LAT);
  if (south > north) {
    // The whole box sat beyond the Mercator limit; keep a sliver at the edge.
    const edge = Math.sign(bbox[1]) * MAX_MERCATOR_LAT;
    south = edge;
    north = edge;
  }
  if (north - south < MIN_RESULT_SPAN_DEG) {
    const mid = (south + north) / 2;
    south = Math.max(mid - MIN_RESULT_SPAN_DEG / 2, -MAX_MERCATOR_LAT);
    north = Math.min(mid + MIN_RESULT_SPAN_DEG / 2, MAX_MERCATOR_LAT);
  }
  // A degree of longitude shrinks toward the poles, so widen by the same
  // ground distance rather than the same number of degrees.
  const midLat = ((south + north) / 2) * (Math.PI / 180);
  const minLonSpan = Math.min(MIN_RESULT_SPAN_DEG / Math.max(Math.cos(midLat), 0.01), 360);
  if (east - west < minLonSpan) {
    const mid = (west + east) / 2;
    west = Math.max(mid - minLonSpan / 2, -180);
    east = Math.min(mid + minLonSpan / 2, 180);
  }
  return { kind: "bounds", bounds: [west, south, east, north] };
}
