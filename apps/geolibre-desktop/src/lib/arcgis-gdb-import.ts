import type { VectorDatasetLayer } from "@geolibre/processing";
import type { FeatureCollection } from "geojson";
import {
  dropArcgisImportLayers,
  type ArcgisFileGeodatabaseImport,
  type ArcgisProjectImportResult,
  type ArcgisProjectImportWarning,
} from "./arcgis-project-import";

export interface FileGeodatabaseReader {
  /** Start the sidecar; a throw reports every layer as unreadable. */
  start: () => Promise<unknown>;
  /** `signal` stops the wait when the import is abandoned. */
  listLayers: (gdbPath: string, signal?: AbortSignal) => Promise<VectorDatasetLayer[]>;
  readLayer: (
    gdbPath: string,
    featureClass: string,
    signal?: AbortSignal,
  ) => Promise<FeatureCollection>;
}

/**
 * Fill the File Geodatabase layers of an ArcGIS Pro import with their
 * features, before the project is loaded. Each geodatabase is listed once; a
 * layer whose feature class is gone, whose coordinate system is unknown, or
 * whose geodatabase cannot be listed or read is removed with a warning, and
 * any group it leaves empty is pruned. Layers are read one at a time because
 * the sidecar caps the jobs it runs at once.
 *
 * @param imported - The import result, changed in place.
 * @param reader - The sidecar reads; injected so tests can stub them.
 * @param signal - Aborted when another project replaces the one importing;
 *   no further layer is listed or read, and the call rejects.
 */
export async function loadArcgisFileGeodatabaseLayers(
  imported: ArcgisProjectImportResult,
  reader: FileGeodatabaseReader,
  signal?: AbortSignal,
): Promise<void> {
  const pending = imported.fileGeodatabaseLayers;
  if (pending.length === 0) return;

  signal?.throwIfAborted();
  const outcomes = new Map<string, ReadOutcome>();
  let started = true;
  try {
    await reader.start();
  } catch (error) {
    console.error("[GeoLibre] Could not start the sidecar to read File Geodatabase layers", error);
    started = false;
  }

  const listings = new Map<string, Promise<VectorDatasetLayer[] | null>>();
  const listLayers = (gdbPath: string) => {
    let listing = listings.get(gdbPath);
    if (!listing) {
      listing = reader.listLayers(gdbPath, signal).catch((error: unknown) => {
        console.warn(`[GeoLibre] Could not read File Geodatabase "${gdbPath}"`, error);
        return null;
      });
      listings.set(gdbPath, listing);
    }
    return listing;
  };

  for (const entry of pending) {
    // Each read can take seconds; once the import is abandoned, the rest are
    // not worth the sidecar's time.
    signal?.throwIfAborted();
    outcomes.set(
      entry.id,
      started
        ? await readEntry(entry, listLayers, reader, signal)
        : { reason: "file-geodatabase-read" },
    );
    // Also after the last read: an abandoned import never gets its layers,
    // even when the read itself finished (or failed) after the abort.
    signal?.throwIfAborted();
  }

  const failed = new Set<string>();
  const failures: ArcgisProjectImportWarning[] = [];
  for (const entry of pending) {
    const outcome = outcomes.get(entry.id);
    if (outcome && "reason" in outcome) {
      failed.add(entry.id);
      failures.push({ layerName: entry.name, reason: outcome.reason });
    }
  }
  imported.project.layers = imported.project.layers.map((layer) => {
    const outcome = outcomes.get(layer.id);
    if (!outcome || "reason" in outcome) return layer;
    return {
      ...layer,
      geojson: outcome.geojson,
      metadata: {
        ...layer.metadata,
        // The listing's spelling, which is what was read.
        gdbLayer: outcome.featureClass,
        sourceCrs: outcome.crs,
        featureCount: outcome.geojson.features.length,
      },
    };
  });
  // Removes each unreadable layer, its place in the order and any group it
  // leaves empty; the warnings say why, and are untagged so they stay.
  dropArcgisImportLayers(imported, failed);
  imported.warnings.push(...failures);
  imported.fileGeodatabaseLayers = [];
}

type ReadOutcome =
  | { geojson: FeatureCollection; featureClass: string; crs: string }
  | { reason: ArcgisProjectImportWarning["reason"] };

async function readEntry(
  entry: ArcgisFileGeodatabaseImport,
  listLayers: (gdbPath: string) => Promise<VectorDatasetLayer[] | null>,
  reader: FileGeodatabaseReader,
  signal: AbortSignal | undefined,
): Promise<ReadOutcome> {
  const layers = await listLayers(entry.gdbPath);
  signal?.throwIfAborted();
  // A failed listing does not say why: the geodatabase may have moved, but
  // the sidecar may also be busy (HTTP 429), have timed out, or have failed
  // to open it, so it is reported as unreadable rather than as missing.
  if (!layers) return { reason: "file-geodatabase-read" };
  // GDAL's OpenFileGDB driver keeps the feature class's case, but ArcGIS
  // stores the dataset name as typed in the connection, so match either way.
  const info =
    layers.find((layer) => layer.name === entry.featureClass) ??
    layers.find((layer) => layer.name.toLowerCase() === entry.featureClass.toLowerCase());
  // The geodatabase opened but no longer holds this feature class.
  if (!info) return { reason: "missing-source" };
  // Without a declared CRS the coordinates would render wherever their raw
  // values land, so the layer is refused, as Add data → File geodatabase does.
  if (!info.crs) return { reason: "file-geodatabase-crs" };
  try {
    return {
      geojson: await reader.readLayer(entry.gdbPath, info.name, signal),
      featureClass: info.name,
      crs: info.crs,
    };
  } catch (error) {
    console.warn(
      `[GeoLibre] Could not read "${info.name}" from File Geodatabase "${entry.gdbPath}"`,
      error,
    );
    return { reason: "file-geodatabase-read" };
  }
}
