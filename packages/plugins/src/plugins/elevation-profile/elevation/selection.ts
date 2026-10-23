import type { Feature, Geometry, Position } from "geojson";

import type { LngLat } from "./geometry";

/** A selected line prepared for elevation profiling. */
export interface SelectedProfileLine {
  /** Two-dimensional vertices used for distance calculations and map rendering. */
  coords: LngLat[];
  /** Embedded Z values in meters, or null when any vertex has no usable Z value. */
  elevations: number[] | null;
}

/**
 * Find the first selected line feature and split its positions into XY and Z.
 *
 * LineString and MultiLineString geometries are supported. Multi-part lines are
 * concatenated in their source order, matching how GeoLibre's route tools treat
 * them. Embedded elevations are returned only when every retained vertex has a
 * finite Z value and at least one of them is non-zero. This lets GPX tracks use
 * their recorded `<ele>` values while ordinary two-dimensional lines fall back
 * to the elevation service.
 *
 * The all-zero exclusion matters because many GPX/GeoJSON producers write `0`
 * as a placeholder Z instead of omitting the third ordinate, so a genuinely 2D
 * line arrives as `[x, y, 0]` vertices. Charting those would draw a flat 0 m
 * profile instead of the real terrain. `geojsonHasZCoordinates` in
 * `@geolibre/core` rejects all-zero Z for the same reason.
 *
 * @param features - The features currently selected in GeoLibre.
 * @returns The first usable selected line, or null when none is selected.
 */
export function selectedProfileLine(
  features: Feature<Geometry | null>[] | null | undefined,
): SelectedProfileLine | null {
  if (!features) return null;
  for (const feature of features) {
    const positions = linePositions(feature.geometry);
    if (positions.length < 2) continue;

    const coords: LngLat[] = [];
    const elevations: number[] = [];
    let hasCompleteElevations = true;
    let hasNonZeroElevation = false;
    for (const position of positions) {
      const longitude = position[0];
      const latitude = position[1];
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
      coords.push([longitude, latitude]);
      const elevation = position[2];
      if (typeof elevation === "number" && Number.isFinite(elevation)) {
        elevations.push(elevation);
        if (elevation !== 0) hasNonZeroElevation = true;
      } else {
        hasCompleteElevations = false;
      }
    }

    if (coords.length >= 2) {
      return {
        coords,
        elevations:
          hasCompleteElevations && hasNonZeroElevation && elevations.length === coords.length
            ? elevations
            : null,
      };
    }
  }
  return null;
}

function linePositions(geometry: Geometry | null | undefined): Position[] {
  if (geometry?.type === "LineString") return geometry.coordinates;
  if (geometry?.type === "MultiLineString") return geometry.coordinates.flat();
  return [];
}
