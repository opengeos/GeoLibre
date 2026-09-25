/** Helpers shared by the vector readers (archives, DuckDB, collections). */

import { unzip } from "fflate";
import type { FeatureCollection } from "geojson";
import type { DuckDbVectorLoadOptions } from "../duckdb-vector-guard";
import type { DuckDbVectorFile } from "../duckdb-vector-loader";

export function assertFeatureCollection(value: unknown): FeatureCollection {
  if (
    value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "FeatureCollection" &&
    Array.isArray((value as { features?: unknown }).features)
  ) {
    return value as FeatureCollection;
  }
  throw new Error("The selected file did not produce a GeoJSON FeatureCollection.");
}

export function mergeFeatureCollections(collections: FeatureCollection[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: collections.flatMap((collection) => collection.features),
  };
}

export function unzipArchive(data: ArrayBuffer | Uint8Array): Promise<Record<string, Uint8Array>> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(bytes, (error, entries) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(entries);
    });
  });
}

export function toDuckDbVectorData(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data);
}

export async function loadDuckDbVector(file: DuckDbVectorFile, options?: DuckDbVectorLoadOptions) {
  const { loadDuckDbVectorFile } = await import("../duckdb-vector-loader");
  return loadDuckDbVectorFile(file, options);
}

/**
 * Whether an error is the {@link VectorLoadCancelledError} thrown when the user
 * declines a large-file load. Matched by `name` rather than `instanceof` so the
 * heavy `duckdb-vector-loader` module (and its DuckDB-WASM imports) stays a
 * lazy dynamic import instead of being pulled into this module's chunk.
 */
export function isVectorLoadCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "VectorLoadCancelledError";
}
