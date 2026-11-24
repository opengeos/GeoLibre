import type { GeoJSON } from "geojson";

/** A source that accepts GeoJSON, including adapters with synchronous setters. */
interface GeoJsonDataSource {
  setData(data: GeoJSON): unknown;
}

/** Update an existing source and report asynchronous rendering failures. */
export function updateGeoJsonSourceData(
  source: GeoJsonDataSource | null | undefined,
  data: GeoJSON,
): void {
  if (!source) return;
  void Promise.resolve(source.setData(data)).catch((error: unknown) => {
    console.warn("Failed to update map source", error);
  });
}
