/**
 * Host side of the QGIS importer's remote vector layers: reads a downloaded
 * file that is not GeoJSON (a GeoParquet, GeoPackage, FlatGeobuf, KML, ...)
 * with the same readers a dropped file goes through. Kept apart from
 * `qgis-project-import.ts` so the parser stays free of DuckDB and runs under
 * `node --test`.
 */
import type { FeatureCollection } from "geojson";
import { isLoadedVectorLayer } from "./file-io/loaded-layer";
import { loadDuckDbVector, mergeFeatureCollections } from "./file-io/vector-shared";
import type { QgisRemoteVectorReader } from "./qgis-project-import";

/**
 * Read one remote QGIS layer's file into features.
 *
 * A layer that names its table (`layername=` in QGIS) reads that table
 * through DuckDB; any other file goes through the dropped-file loader, which
 * also knows the formats DuckDB does not read directly (KMZ, zipped
 * Shapefiles).
 *
 * @param file - The downloaded file and the table it should read.
 * @returns Every feature of the layer, in WGS84.
 * @throws When the file holds no readable vector data.
 */
export const readQgisRemoteVector: QgisRemoteVectorReader = async ({
  name,
  extension,
  data,
  sourceLayer,
}) => {
  if (sourceLayer) {
    return loadDuckDbVector({ name, extension, data }, { layer: sourceLayer });
  }
  const { loadDroppedVectorFiles } = await import("./file-io/vector-loader");
  const vectors = (await loadDroppedVectorFiles([new File([data], name)])).filter(
    isLoadedVectorLayer,
  );
  if (vectors.length === 0) throw new Error(`${name} holds no vector features.`);
  const collections: FeatureCollection[] = vectors.map((layer) => layer.data);
  return collections.length === 1 ? collections[0] : mergeFeatureCollections(collections);
};
