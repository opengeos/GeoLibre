import type { PointerElevationResolver } from "@geolibre/core";

/** Resample a stationary pointer after Mapbox installs a newly loaded style. */
export function refreshMapboxPointerElevationAfterStyleLoad(
  resolver: PointerElevationResolver | undefined,
  point: [number, number] | null,
): void {
  if (point) resolver?.update(point);
}
