import type { FeatureCollection } from "geojson";

export type BinaryVectorExportFormat = "geoparquet";

export interface BinaryVectorExportResult {
  data: Uint8Array;
  extension: string;
  mimeType: string;
}

async function exportGeoParquet(
  geojson: FeatureCollection,
): Promise<Uint8Array> {
  const { exportDuckDbGeoParquet } = await import("./duckdb-vector-loader");
  return exportDuckDbGeoParquet(geojson);
}

export async function exportBinaryVectorLayer(
  geojson: FeatureCollection,
  _format: BinaryVectorExportFormat,
  _layerName: string,
): Promise<BinaryVectorExportResult> {
  return {
    data: await exportGeoParquet(geojson),
    extension: "parquet",
    mimeType: "application/vnd.apache.parquet",
  };
}
