import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
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

// Layers can disappear through many paths that never touch the LayerPanel
// remove flow (scripting API, assistant tools, plugin teardown, New Project
// resetting `layers` wholesale). A store subscription prunes entries whose
// layer is gone so a credential never outlives its layer, whichever path
// removed it. Installed lazily on first registration.
let pruneSubscriptionInstalled = false;

function ensurePruneSubscription(): void {
  if (pruneSubscriptionInstalled) return;
  pruneSubscriptionInstalled = true;
  useAppStore.subscribe((state) => {
    if (connectionsByLayerId.size === 0) return;
    prunePostgisConnections(state.layers.map((layer) => layer.id));
  });
}

/** Drop registry entries whose layer id is not in the live set. */
export function prunePostgisConnections(liveLayerIds: Iterable<string>): void {
  const liveIds = new Set(liveLayerIds);
  for (const layerId of connectionsByLayerId.keys()) {
    if (!liveIds.has(layerId)) connectionsByLayerId.delete(layerId);
  }
}

/** Remember the connection string an editable PostGIS layer was loaded with. */
export function registerPostgisConnection(layerId: string, connection: string): void {
  ensurePruneSubscription();
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
export function postgisBaselineKeys(layer: GeoLibreLayer): Array<string | number> | undefined {
  const keys = layer.metadata.postgisBaselineKeys;
  if (!Array.isArray(keys)) return undefined;
  return keys.filter(
    (key): key is string | number => typeof key === "string" || typeof key === "number",
  );
}

/**
 * The primary-key values carried by a freshly read PostGIS FeatureCollection
 * (the /postgis/read endpoint sets each row's key as `feature.id`).
 */
export function postgisFeatureKeys(geojson: FeatureCollection): Array<string | number> {
  return geojson.features
    .map((feature) => feature.id)
    .filter((id): id is string | number => typeof id === "string" || typeof id === "number");
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
  // The label masks only the password, so two saved connections differing
  // just by password (e.g. before/after a rotation) share a label. Resolve
  // only an unambiguous match: guessing between candidate credentials would
  // read as an unexplained auth failure (or hit the wrong environment), while
  // returning null surfaces the explicit "reconnect" message.
  const matches = readSavedPostgresConnections().filter(
    (connection) => savedPostgresConnectionLabel(connection) === label,
  );
  return matches.length === 1 ? matches[0] : null;
}
