/** Check finite positions and GeoJSON nesting without imposing topology or CRS bounds. */
export function validOgcProcessGeoJson(value: unknown): boolean {
  const record = (input: unknown): input is Record<string, unknown> =>
    input !== null && typeof input === "object" && !Array.isArray(input);
  const position = (input: unknown): input is number[] =>
    Array.isArray(input) &&
    input.length >= 2 &&
    input.every((value) => typeof value === "number" && Number.isFinite(value));
  const line = (input: unknown, minimum: number): input is number[][] =>
    Array.isArray(input) && input.length >= minimum && input.every(position);
  const ring = (input: unknown): boolean => {
    if (!line(input, 4)) return false;
    const first = input[0],
      last = input[input.length - 1];
    return first.length === last.length && first.every((value, index) => value === last[index]);
  };
  const polygon = (input: unknown): boolean => Array.isArray(input) && input.every(ring);
  const geometry = (value: unknown): boolean => {
    const pending = [value];
    while (pending.length) {
      const input = pending.pop();
      if (!record(input)) return false;
      const coordinates = input.coordinates;
      let valid: boolean;
      switch (input.type) {
        case "Point":
          valid = position(coordinates);
          break;
        case "MultiPoint":
          valid = Array.isArray(coordinates) && coordinates.every(position);
          break;
        case "LineString":
          valid = Array.isArray(coordinates) && (!coordinates.length || line(coordinates, 2));
          break;
        case "MultiLineString":
          valid = Array.isArray(coordinates) && coordinates.every((value) => line(value, 2));
          break;
        case "Polygon":
          valid = polygon(coordinates);
          break;
        case "MultiPolygon":
          valid = Array.isArray(coordinates) && coordinates.every(polygon);
          break;
        case "GeometryCollection":
          if (!Array.isArray(input.geometries)) return false;
          for (const child of input.geometries) pending.push(child);
          continue;
        default:
          return false;
      }
      if (!valid) return false;
    }
    return true;
  };
  return (
    record(value) &&
    value.type === "FeatureCollection" &&
    Array.isArray(value.features) &&
    value.features.every(
      (feature) =>
        record(feature) &&
        feature.type === "Feature" &&
        (feature.geometry === null || geometry(feature.geometry)),
    )
  );
}
