import type { FeatureCollection } from "geojson";

export type BinaryVectorExportFormat = "geoparquet" | "geopackage" | "shapefile";

export interface BinaryVectorExportResult {
  data: Uint8Array;
  extension: string;
  mimeType: string;
}

async function exportGeoParquet(geojson: FeatureCollection): Promise<Uint8Array> {
  const { exportDuckDbGeoParquet } = await import("./duckdb-vector-loader");
  return exportDuckDbGeoParquet(geojson);
}

// GeoPackage and Shapefile are assembled by pure-JS writers. Neither in-browser
// engine can write these GDAL formats: DuckDB-WASM's virtual filesystem lacks
// the random-access seek/write the SQLite-based GeoPackage driver and the
// Shapefile writer need, and Pyodide's bundled GDAL has no working write driver
// (it fatally crashes). The writers produce WGS84 output compatible with
// QGIS/ArcGIS.
async function exportGeoPackage(
  geojson: FeatureCollection,
  layerName: string,
): Promise<Uint8Array> {
  const { writeGeoPackage } = await import("./geopackage-writer");
  return writeGeoPackage(geojson, layerName);
}

/**
 * Export a Shapefile and bundle its component files (`.shp`/`.shx`/`.dbf`/
 * `.prj`/`.cpg`) into a single zip archive, since a Shapefile is inherently a
 * multi-file dataset.
 */
async function exportShapefileZip(
  geojson: FeatureCollection,
  baseName: string,
): Promise<Uint8Array> {
  const [{ writeShapefile }, { zipSync }] = await Promise.all([
    import("./shapefile-writer"),
    import("fflate"),
  ]);
  const parts = writeShapefile(geojson);
  return zipSync({
    [`${baseName}.shp`]: parts.shp,
    [`${baseName}.shx`]: parts.shx,
    [`${baseName}.dbf`]: parts.dbf,
    [`${baseName}.prj`]: parts.prj,
    [`${baseName}.cpg`]: parts.cpg,
  });
}

export async function exportBinaryVectorLayer(
  geojson: FeatureCollection,
  format: BinaryVectorExportFormat,
  layerName: string,
): Promise<BinaryVectorExportResult> {
  switch (format) {
    case "geoparquet":
      return {
        data: await exportGeoParquet(geojson),
        extension: "parquet",
        mimeType: "application/vnd.apache.parquet",
      };
    case "geopackage":
      return {
        data: await exportGeoPackage(geojson, layerName),
        extension: "gpkg",
        mimeType: "application/geopackage+sqlite3",
      };
    case "shapefile":
      return {
        data: await exportShapefileZip(geojson, layerName),
        extension: "zip",
        mimeType: "application/zip",
      };
  }
}
