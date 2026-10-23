/**
 * PostGIS vector tiles rendered in-process by the Tauri backend
 * (`src-tauri/src/postgis_tiles.rs`, `ST_AsMVT`), for the Android/iOS apps
 * that cannot run the Martin tile server (GeoLibre#2091).
 *
 * MapLibre reaches the renderer through the `geolibre-pgtiles://` custom
 * protocol; nothing listens on a port. Tile URLs carry only a password-masked
 * connection label (see `postgis-tiles-url.ts`), resolved here to the real
 * connection string from this session's connects or the saved connections.
 */

import { useAppStore } from "@geolibre/core";
import { invoke } from "@tauri-apps/api/core";
import i18next from "i18next";
import { addProtocol } from "maplibre-gl";
import {
  MAX_TILES_IN_FLIGHT,
  POSTGIS_TILES_PROTOCOL,
  parsePostgisTileUrl,
  postgisTilesConnectionLabels,
  type PostgisTileSourceRef,
} from "./postgis-tiles-url";
import { createRequestLimiter, type RequestLimiter } from "./request-limiter";
import {
  savedPostgresConnectionLabel,
  savedPostgresConnectionsWithLabel,
} from "./saved-postgres-connections";

export interface PostgisTileSource {
  schema: string;
  table: string;
  geometryColumn: string;
  geometryType: string;
  srid: number;
}

export interface PostgisTileSourceInfo {
  /** Vector-tile layer name (the table name). */
  layer: string;
  /** West, south, east, north in WGS84; null for an empty table. */
  bounds: [number, number, number, number] | null;
  fields: Record<string, string>;
}

/**
 * Connection strings used this session, by masked label. Two strings that
 * differ only by password share a label; the later, which has just connected
 * successfully, replaces the stale one.
 */
const sessionConnections = new Map<string, string>();

const tileLimiters = new Map<string, RequestLimiter>();

let protocolRegistered = false;

/** Remember a connection so its tile URLs resolve without a saved entry. */
export function rememberPostgisTilesConnection(connection: string): string {
  const label = savedPostgresConnectionLabel(connection);
  const replaced = sessionConnections.get(label);
  sessionConnections.set(label, connection);
  // A replaced string (e.g. an old password) can no longer be resolved from
  // a tile URL, so its pool would only sit idle.
  if (replaced && replaced !== connection) void disconnectPostgisTiles(replaced).catch(() => {});
  return label;
}

/**
 * Resolve a masked label to a connection string: this session's connects
 * first, else an unambiguous saved connection (the same rule as editable
 * PostGIS layers, `resolvePostgisConnection`).
 */
export function resolvePostgisTilesConnection(label: string): string | null {
  const session = sessionConnections.get(label);
  if (session) return session;
  const matches = savedPostgresConnectionsWithLabel(label);
  return matches.length === 1 ? matches[0] : null;
}

/** The backend's `PostgisTileSourceRequest`. */
function sourceRequest(connection: string, source: Omit<PostgisTileSourceRef, "connectionLabel">) {
  return {
    connection,
    defaultSrid: source.defaultSrid?.trim() || null,
    schema: source.schema,
    table: source.table,
    geometryColumn: source.geometryColumn,
  };
}

export function listPostgisTileSources(
  connection: string,
  defaultSrid?: string,
): Promise<PostgisTileSource[]> {
  return invoke<PostgisTileSource[]>("postgis_tiles_list_sources", {
    connection,
    defaultSrid: defaultSrid?.trim() || null,
  });
}

export function readPostgisTileSourceInfo(
  connection: string,
  source: Omit<PostgisTileSourceRef, "connectionLabel">,
): Promise<PostgisTileSourceInfo> {
  return invoke<PostgisTileSourceInfo>("postgis_tiles_source_info", {
    source: sourceRequest(connection, source),
  });
}

/**
 * Release the backend's pool for a connection (or all pools). Tiles already
 * being rendered still finish.
 */
export function disconnectPostgisTiles(connection?: string): Promise<void> {
  return invoke("postgis_tiles_disconnect", { connection: connection ?? null });
}

/**
 * Release a connection's pool unless a layer on the map still uses it, e.g.
 * when the Add Data form moves to another database or closes without adding.
 */
export function releasePostgisTilesConnectionIfUnused(connection: string): void {
  const label = savedPostgresConnectionLabel(connection);
  if (postgisTilesConnectionLabels(useAppStore.getState().layers).has(label)) return;
  void disconnectPostgisTiles(connection).catch(() => {});
}

/**
 * Close the pools behind connection labels no layer uses any more (the last
 * layer of a database was removed, or the project was closed).
 */
export function releasePostgisTilesConnections(labels: Iterable<string>): void {
  for (const label of labels) {
    tileLimiters.delete(label);
    const candidates = new Set(savedPostgresConnectionsWithLabel(label));
    const session = sessionConnections.get(label);
    if (session) candidates.add(session);
    for (const connection of candidates) {
      void disconnectPostgisTiles(connection).catch(() => {});
    }
  }
}

function tileLimiter(label: string): RequestLimiter {
  let limiter = tileLimiters.get(label);
  if (!limiter) {
    limiter = createRequestLimiter(MAX_TILES_IN_FLIGHT);
    tileLimiters.set(label, limiter);
  }
  return limiter;
}

export function registerPostgisTilesProtocol(): void {
  if (protocolRegistered) return;
  addProtocol(POSTGIS_TILES_PROTOCOL, async (request, abortController) => {
    const tile = parsePostgisTileUrl(request.url);
    const connection = resolvePostgisTilesConnection(tile.connectionLabel);
    if (!connection) {
      throw new Error(
        i18next.t("addData.postgres.errorNoMatchingConnection", { label: tile.connectionLabel }),
      );
    }
    // The command returns a raw tauri::ipc::Response, which arrives as an
    // ArrayBuffer rather than a JSON number array.
    const data = await tileLimiter(tile.connectionLabel)(
      () =>
        invoke<ArrayBuffer>("postgis_tiles_tile", {
          source: sourceRequest(connection, tile),
          z: tile.z,
          x: tile.x,
          y: tile.y,
        }),
      abortController.signal,
    );
    return { data };
  });
  protocolRegistered = true;
}
