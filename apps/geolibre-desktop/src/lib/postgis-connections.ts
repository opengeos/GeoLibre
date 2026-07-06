import type { GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  readSavedPostgresConnections,
  savedPostgresConnectionLabel,
} from "./saved-postgres-connections";

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

/**
 * Drop the layer's session state (its connection string), e.g. when the layer
 * is removed, so credentials do not outlive the layer.
 */
export function unregisterPostgisConnection(layerId: string): void {
  connectionsByLayerId.delete(layerId);
}

/**
 * The primary-key values the layer's edit session started from, persisted on
 * the layer metadata (`postgisBaselineKeys`) so the protection survives a
 * project reload — unlike the connection string, keys are not credentials.
 * Sent with a save so the sidecar scopes deletions to rows this session
 * actually read, leaving concurrently inserted rows alone.
 */
export function postgisBaselineKeys(
  layer: GeoLibreLayer,
): Array<string | number> | undefined {
  const keys = layer.metadata.postgisBaselineKeys;
  if (!Array.isArray(keys)) return undefined;
  return keys.filter(
    (key): key is string | number =>
      typeof key === "string" || typeof key === "number",
  );
}

/**
 * The primary-key values carried by a freshly read PostGIS FeatureCollection
 * (the /postgis/read endpoint sets each row's key as `feature.id`).
 */
export function postgisFeatureKeys(
  geojson: FeatureCollection,
): Array<string | number> {
  return geojson.features
    .map((feature) => feature.id)
    .filter(
      (id): id is string | number =>
        typeof id === "string" || typeof id === "number",
    );
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
