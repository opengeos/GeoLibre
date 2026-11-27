/**
 * Shared state between the GeoLens plugin and the host's offline edit outbox
 * (#3530). DOM-free and MapLibre-free, so the host can import it without
 * loading the plugin.
 *
 * - The plugin records the connection it is signed in with (`setActiveGeoLensClient`),
 *   so a queued change set can sync with that API key without the key ever
 *   being written to the outbox.
 * - Per-layer edit baselines live here, so the outbox can diff a layer and
 *   re-base it after a sync.
 * - The host installs a save handler; when present, the plugin's Save button
 *   queues through the outbox instead of writing directly.
 */

import type { GeoLensClientOptions, GeoLensFeatureBaseline, GeoLensFetch } from "./geolens-api";

/** What the plugin knows about one editable layer at save time. */
export interface GeoLensSaveRequest {
  layerId: string;
  layerName: string;
  datasetId: string;
  client: GeoLensClientOptions;
  baseline: GeoLensFeatureBaseline;
  featureLimit?: number;
}

/** What a save handler reports back to the panel. */
export interface GeoLensSaveHandlerResult {
  /** Features written to the server now. */
  written: number;
  /** Per-feature or whole-save errors. */
  errors: string[];
  /** A one-line status for the panel (queued, conflicts to review, ...). */
  message?: string;
}

/** A host hook that takes over the plugin's Save button. */
export type GeoLensSaveHandler = (request: GeoLensSaveRequest) => Promise<GeoLensSaveHandlerResult>;

/** Per-layer baselines of the GeoLens datasets loaded this session. */
export const geoLensEditSessions = new Map<string, { baseline: GeoLensFeatureBaseline }>();

const activeClients = new Map<string, { client: GeoLensClientOptions; fetchImpl: GeoLensFetch }>();
let saveHandler: GeoLensSaveHandler | null = null;

/** Record (or with null, forget) the connection the panel is signed in with. */
export function setActiveGeoLensClient(
  baseUrl: string,
  connection: { client: GeoLensClientOptions; fetchImpl: GeoLensFetch } | null,
): void {
  if (connection) activeClients.set(baseUrl, connection);
  else activeClients.delete(baseUrl);
}

/** Forget every signed-in connection (the plugin was turned off). */
export function clearActiveGeoLensClients(): void {
  activeClients.clear();
}

/** The connection the panel is signed in with for a server, if any. */
export function getActiveGeoLensClient(
  baseUrl: string,
): { client: GeoLensClientOptions; fetchImpl: GeoLensFetch } | undefined {
  return activeClients.get(baseUrl);
}

/** A layer's baseline, if one was captured this session. */
export function getGeoLensBaseline(layerId: string): GeoLensFeatureBaseline | undefined {
  return geoLensEditSessions.get(layerId)?.baseline;
}

/** Replace a layer's baseline (after the outbox synced some of its features). */
export function setGeoLensBaseline(layerId: string, baseline: GeoLensFeatureBaseline): void {
  geoLensEditSessions.set(layerId, { baseline });
}

/** Install (or with null, remove) the host's save handler. */
export function setGeoLensSaveHandler(handler: GeoLensSaveHandler | null): void {
  saveHandler = handler;
}

/** The host's save handler, if installed. */
export function getGeoLensSaveHandler(): GeoLensSaveHandler | null {
  return saveHandler;
}
