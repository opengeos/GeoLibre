/**
 * The `[west, south, east, north]` extent of point features, or null if empty.
 * A track crossing the antimeridian comes back unwrapped (east > 180), the
 * `MapExtent` convention, so the map frames the track rather than the world.
 */
export function pointBounds(
  features: Array<{ geometry: { coordinates: number[] } }>,
): [number, number, number, number] | null {
  if (features.length === 0) return null;
  let west = Infinity;
  let east = -Infinity;
  // The same extent with longitudes shifted into [0, 360).
  let west360 = Infinity;
  let east360 = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const { geometry } of features) {
    const [x, y] = geometry.coordinates;
    const x360 = x < 0 ? x + 360 : x;
    west = Math.min(west, x);
    east = Math.max(east, x);
    west360 = Math.min(west360, x360);
    east360 = Math.max(east360, x360);
    south = Math.min(south, y);
    north = Math.max(north, y);
  }
  if (east360 - west360 < east - west) {
    const shift = west360 > 180 ? -360 : 0;
    return [west360 + shift, south, east360 + shift, north];
  }
  return [west, south, east, north];
}
