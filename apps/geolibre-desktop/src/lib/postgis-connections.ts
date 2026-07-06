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

// Primary-key values the layer's edit session started from (set at load and
// refreshed after each save). Sent with a save so the sidecar scopes deletions
// to rows this session actually read, leaving concurrently inserted rows
// alone. Session-only, like the connection itself.
const baselineKeysByLayerId = new Map<string, Array<string | number>>();

/** Remember the connection string an editable PostGIS layer was loaded with. */
export function registerPostgisConnection(
  layerId: string,
  connection: string,
): void {
  connectionsByLayerId.set(layerId, connection);
}

/** Remember the primary-key values the layer's edit session started from. */
export function setPostgisBaselineKeys(
  layerId: string,
  keys: Array<string | number>,
): void {
  baselineKeysByLayerId.set(layerId, keys);
}

/** The session's baseline primary-key values for the layer, if known. */
export function getPostgisBaselineKeys(
  layerId: string,
): Array<string | number> | null {
  return baselineKeysByLayerId.get(layerId) ?? null;
}

/**
 * Drop the layer's session state (connection string and baseline keys), e.g.
 * when the layer is removed, so credentials do not outlive the layer.
 */
export function unregisterPostgisConnection(layerId: string): void {
  connectionsByLayerId.delete(layerId);
  baselineKeysByLayerId.delete(layerId);
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
