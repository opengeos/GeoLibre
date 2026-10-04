import { normalizeLayerDescriptiveMetadata, type GeoLibreLayer } from "@geolibre/core";
import { quoteSqlString } from "./duckdb-geometry";

/**
 * Parquet key-value metadata key under which a GeoParquet export carries the
 * layer's descriptive metadata (title, abstract, keywords, license, …) as JSON,
 * next to the `geo` key the GeoParquet writer adds.
 */
export const GEOLIBRE_PARQUET_METADATA_KEY = "geolibre:metadata";

/**
 * The Parquet key-value metadata a layer's GeoParquet export should carry.
 *
 * @param layer - The exported layer.
 * @returns The entries to write, or `undefined` when the layer has no
 *   descriptive metadata.
 */
export function layerParquetKeyValueMetadata(
  layer: Pick<GeoLibreLayer, "descriptiveMetadata">,
): Record<string, string> | undefined {
  const metadata = normalizeLayerDescriptiveMetadata(layer.descriptiveMetadata);
  return metadata ? { [GEOLIBRE_PARQUET_METADATA_KEY]: JSON.stringify(metadata) } : undefined;
}

/**
 * The DuckDB `COPY … (FORMAT PARQUET …)` option writing key-value metadata
 * into the file footer, with keys and values quoted as SQL string literals.
 *
 * @param entries - Key-value pairs to write.
 * @returns `, KV_METADATA {…}` to append to the option list, or `""` when
 *   there is nothing to write.
 */
export function parquetKeyValueMetadataOption(entries: Record<string, string> | undefined): string {
  const pairs = Object.entries(entries ?? {});
  if (pairs.length === 0) return "";
  const body = pairs
    .map(([key, value]) => `${quoteSqlString(key)}: ${quoteSqlString(value)}`)
    .join(", ");
  return `, KV_METADATA {${body}}`;
}
