import type { GeoLibreLayer } from "@geolibre/core";
import {
  readSavedPostgresConnections,
  savedPostgresConnectionLabel,
} from "../components/layout/add-data/helpers";

/**
 * In-memory registry mapping an editable PostGIS layer to the connection
 * string it was loaded with.
 *
 * Connection strings carry credentials, so they are deliberately kept out of
 * the layer metadata (which is serialized into `.geolibre.json` projects).
 * The layer instead persists only a password-masked label
 * (`postgisConnectionLabel`); after a project reload the connection is
 * recovered by matching that label against the saved connections in
 * localStorage (the same list the Add Data dialog offers).
 */
const connectionsByLayerId = new Map<string, string>();

/** Remember the connection string an editable PostGIS layer was loaded with. */
export function registerPostgisConnection(
  layerId: string,
  connection: string,
): void {
  connectionsByLayerId.set(layerId, connection);
}

export function unregisterPostgisConnection(layerId: string): void {
  connectionsByLayerId.delete(layerId);
}

/**
 * Resolve the connection string for an editable PostGIS layer.
 *
 * Prefers the in-session registry; falls back to the saved connection whose
 * masked label matches the layer's `postgisConnectionLabel` metadata (so
 * write-back keeps working after a project reload without persisting
 * credentials in the project file).
 */
export function resolvePostgisConnection(layer: GeoLibreLayer): string | null {
  const registered = connectionsByLayerId.get(layer.id);
  if (registered) return registered;
  const label =
    typeof layer.metadata.postgisConnectionLabel === "string"
      ? layer.metadata.postgisConnectionLabel
      : "";
  if (!label) return null;
  const saved = readSavedPostgresConnections().find(
    (connection) => savedPostgresConnectionLabel(connection) === label,
  );
  return saved ?? null;
}
