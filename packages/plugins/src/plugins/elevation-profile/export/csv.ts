/**
 * Pure CSV serialization for an elevation profile, kept DOM-free so the output
 * can be asserted directly in unit tests. The control turns the returned string
 * into a downloadable Blob.
 */

import type { LngLat } from "../elevation/geometry";
import type { ProfilePoint } from "../chart/profileChart";

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * Serialize profile samples to CSV with a header row.
 *
 * Columns: `index, longitude, latitude, distance_m, elevation_m`. Distances and
 * elevations are emitted in meters (rounded to 2 decimals); coordinates use the
 * matching sampled `[lng, lat]` when available.
 *
 * @param points - Profile samples (distance + elevation) in along-line order
 * @param coords - Sampled coordinates matching `points` (may be shorter/empty)
 * @returns The CSV document as a single string
 */
export function profileToCsv(points: ProfilePoint[], coords: LngLat[]): string {
  const header = "index,longitude,latitude,distance_m,elevation_m";
  const rows = points.map((point, i) => {
    const coord = coords[i];
    const longitude = coord ? round(coord[0]) : "";
    const latitude = coord ? round(coord[1]) : "";
    return `${i},${longitude},${latitude},${round(point.distance)},${round(point.elevation)}`;
  });
  return [header, ...rows].join("\n");
}
