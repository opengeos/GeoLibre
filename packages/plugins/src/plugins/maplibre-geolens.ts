/**
 * GeoLens catalog browser plugin.
 *
 * Connects to a self-hosted GeoLens server (base URL + optional API key),
 * searches its catalog, and adds datasets to the map over the standards GeoLens
 * already serves — signed vector tiles (the primary, scalable path), OGC API
 * Features GeoJSON (a full-feature fallback), and STAC (raster/COG). All the
 * network/parse/URL logic lives in the DOM-free `./geolens-api` so it is unit
 * testable; this file owns the panel DOM and the map wiring.
 *
 * GeoLens vector-tile tokens are short-lived (seconds to minutes), so a pasted
 * URL would stop loading tiles once the token lapses. The plugin owns that
 * lifecycle: on add it mints a token and schedules a re-mint shortly before
 * expiry, patching the layer's `tiles` in place via the store. This is why the
 * integration is a plugin and not a hand-entered Add Data URL.
 *
 * Panel DOM is built by hand (like `maplibre-source-coop.ts`): the plugin
 * `render(container)` contract hands over a bare element and external plugins
 * cannot share the host's React, so `@geolibre/ui` primitives are unavailable
 * here and inputs are plain elements styled with the shadcn HSL theme tokens.
 */

import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { Map as MapLibreMap, RequestParameters, ResourceType } from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  applyFeatureEdits,
  captureFeatureBaseline,
  datasetPageUrl,
  defaultGeoLensFetch,
  diffFeatures,
  fetchCapabilities,
  fetchDatasetFeatures,
  fetchDatasetFields,
  geometryKind,
  isEditPlanEmpty,
  mintTileToken,
  normalizeBaseUrl,
  rasterTemplatesForServer,
  rasterTileAuthHeaders,
  resolveRasterTiles,
  searchDatasets,
  tileUrlPrefix,
  vectorTileTemplate,
  type GeoLensClientOptions,
  type GeoLensDataset,
  type GeoLensEditPlan,
  type GeoLensFeatureBaseline,
  type GeoLensFetch,
} from "./geolens-api";

export const GEOLENS_PLUGIN_ID = "maplibre-gl-geolens";

/**
 * Metadata `sourceKind` of a layer loaded from GeoLens as editable GeoJSON —
 * distinct from `geolens-vector-tiles`, which cannot be edited in place. It,
 * together with `geolensBaseUrl`/`geolensDatasetId`, is what lets the panel
 * find a layer's origin again after a project reload.
 */
export const GEOLENS_FEATURES_SOURCE_KIND = "geolens-features";

/** One entry in the sample-server dropdown. */
export interface GeoLensSampleServer {
  /** Shown in the dropdown; the URL is the title text. */
  label: string;
  baseUrl: string;
}

/**
 * Public GeoLens deployments offered in the panel, so the plugin can be tried
 * without hunting for a server URL. Both are open catalogs that need no key.
 *
 * The labels are the deployments' own names rather than translatable strings:
 * they identify a specific server, the way a bookmark does.
 */
export const GEOLENS_SAMPLE_SERVERS: readonly GeoLensSampleServer[] = [
  { label: "GeoLibre datasets", baseUrl: "https://datasets.geolibre.app" },
  { label: "GeoLens demo", baseUrl: "https://demo.getgeolens.com" },
];

/** Number of datasets requested per catalog search. */
const SEARCH_LIMIT = 50;
/** Default maximum number of editable GeoJSON features loaded per dataset. */
export const DEFAULT_GEOLENS_FEATURE_LIMIT = 10_000;
const MAX_GEOLENS_FEATURE_LIMIT = 1_000_000;
const FEATURE_LIMIT_STORAGE_KEY = "geolibre.geolens.featureLimit";
/** Re-mint the tile token this many seconds before it expires. */
const TOKEN_REFRESH_LEAD_SECONDS = 30;
/** Floor on the refresh delay, so a tiny/expired TTL cannot busy-loop. */
const TOKEN_REFRESH_MIN_SECONDS = 10;
/** Cap on the backoff delay after repeated mint failures. */
const TOKEN_REFRESH_MAX_RETRY_SECONDS = 300;

// ---------------------------------------------------------------------------
// i18n. Plugins cannot read the host's locale JSON, so — like source-coop —
// English defaults are baked in and the host may override them via
// setGeoLensLabels(t(...)) on activation and every language change.
// ---------------------------------------------------------------------------

export interface GeoLensLabels {
  hint: string;
  sampleServer: string;
  sampleServerTitle: string;
  baseUrlPlaceholder: string;
  apiKeyPlaceholder: string;
  connect: string;
  connecting: string;
  searchPlaceholder: string;
  search: string;
  searching: string;
  noResults: string;
  loadError: (message: string) => string;
  blockedError: (host: string) => string;
  showing: (count: number) => string;
  vectorBadge: string;
  rasterBadge: string;
  addVectorTiles: string;
  addVectorTilesTitle: string;
  addRasterTiles: string;
  addRasterTilesTitle: string;
  adding: string;
  added: string;
  addGeoJson: string;
  addGeoJsonTitle: string;
  metadata: string;
  metadataTitle: string;
  settings: string;
  featureLimit: string;
  featureLimitHelp: string;
  addError: (message: string) => string;
  features: (count: number) => string;
  editsHeading: string;
  editsPending: (added: number, changed: number, deleted: number) => string;
  editsNone: string;
  saveEdits: string;
  saveEditsTitle: string;
  savingEdits: (done: number, total: number) => string;
  savedEdits: (written: number) => string;
  saveDisabledByServer: string;
  saveNeedsKey: string;
  saveError: (message: string) => string;
  savePartial: (failed: number, message: string) => string;
  revertEdits: string;
  revertEditsTitle: string;
  revertingEdits: string;
  revertConfirm: (added: number, changed: number, deleted: number) => string;
}

export const DEFAULT_GEOLENS_LABELS: GeoLensLabels = {
  hint: "Connect to a GeoLens server to browse and add its catalog datasets.",
  sampleServer: "Sample server…",
  sampleServerTitle: "Connect to a public GeoLens deployment",
  baseUrlPlaceholder: "GeoLens URL, e.g. https://datasets.geolibre.app",
  apiKeyPlaceholder: "API key (optional, for private data)",
  connect: "Connect",
  connecting: "Connecting…",
  searchPlaceholder: "Search the catalog",
  search: "Search",
  searching: "Searching…",
  noResults: "No matching datasets.",
  loadError: (message) => `Could not reach GeoLens: ${message}`,
  blockedError: (host) =>
    `Could not reach ${host}. The request never completed — the host may be ` +
    `unreachable or offline, or, if it is reachable, it may not allow ` +
    `cross-origin requests from GeoLibre (CORS).`,
  showing: (count) => `${count} dataset${count === 1 ? "" : "s"}.`,
  vectorBadge: "vector",
  rasterBadge: "raster",
  addVectorTiles: "Add vector tiles",
  addVectorTilesTitle: "Add as vector tiles — the whole dataset, best for viewing and styling",
  addRasterTiles: "Add raster tiles",
  addRasterTilesTitle: "Add as server-rendered raster tiles",
  adding: "Adding…",
  added: "Added",
  addGeoJson: "Add GeoJSON",
  addGeoJsonTitle: "Load features as editable GeoJSON for the attribute table and export",
  metadata: "Metadata",
  metadataTitle: "Open this dataset's page on the GeoLens server in a new tab",
  settings: "Settings",
  featureLimit: "Default GeoJSON feature limit",
  featureLimitHelp: "The loader follows paginated responses until this many features are loaded.",
  addError: (message) => `Could not add layer: ${message}`,
  features: (count) => `${count.toLocaleString()} features`,
  editsHeading: "Edits",
  editsPending: (added, changed, deleted) =>
    [
      added ? `${added} added` : "",
      changed ? `${changed} changed` : "",
      deleted ? `${deleted} deleted` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  editsNone: "No local changes.",
  saveEdits: "Save to GeoLens",
  saveEditsTitle: "Write the added, changed, and deleted features back to the GeoLens dataset",
  savingEdits: (done, total) => `Saving ${done}/${total}…`,
  savedEdits: (written) => `Saved ${written} change${written === 1 ? "" : "s"} to GeoLens.`,
  saveDisabledByServer: "This GeoLens server has dataset editing turned off.",
  saveNeedsKey: "Connect with an API key that can write to this dataset.",
  saveError: (message) => `Could not save: ${message}`,
  savePartial: (failed, message) =>
    `${failed} change${failed === 1 ? "" : "s"} failed — ${message}`,
  revertEdits: "Reload",
  revertEditsTitle: "Discard local changes and reload this dataset's features from GeoLens",
  revertingEdits: "Reloading…",
  revertConfirm: (added, changed, deleted) =>
    `Discard unsaved changes to this layer (${[
      added ? `${added} added` : "",
      changed ? `${changed} changed` : "",
      deleted ? `${deleted} deleted` : "",
    ]
      .filter(Boolean)
      .join(", ")}) and reload it from GeoLens?`,
};

let labels: GeoLensLabels = { ...DEFAULT_GEOLENS_LABELS };

export function normalizeGeoLensFeatureLimit(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_GEOLENS_FEATURE_LIMIT;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_GEOLENS_FEATURE_LIMIT;
  return Math.min(MAX_GEOLENS_FEATURE_LIMIT, Math.max(1, Math.floor(parsed)));
}

function readFeatureLimit(): number {
  if (typeof localStorage === "undefined") return DEFAULT_GEOLENS_FEATURE_LIMIT;
  try {
    return normalizeGeoLensFeatureLimit(localStorage.getItem(FEATURE_LIMIT_STORAGE_KEY));
  } catch {
    return DEFAULT_GEOLENS_FEATURE_LIMIT;
  }
}

function writeFeatureLimit(value: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(FEATURE_LIMIT_STORAGE_KEY, String(value));
  } catch {
    // Storage can be unavailable in privacy-restricted webviews.
  }
}

/** Panels currently mounted, so a language change can repaint them in place. */
const mountedPanels = new Set<() => void>();

/** Override the plugin's UI strings (host pushes `t()` values); repaints panels. */
export function setGeoLensLabels(next: Partial<GeoLensLabels>): void {
  labels = { ...labels, ...next };
  for (const remount of mountedPanels) remount();
}

// ---------------------------------------------------------------------------
// DOM helpers + styling (shadcn HSL theme tokens), mirroring source-coop.
// ---------------------------------------------------------------------------

const CSS = {
  panel:
    "display:flex;flex-direction:column;gap:8px;padding:8px;font-size:12px;" +
    "height:100%;box-sizing:border-box;color:hsl(var(--foreground));",
  hint: "font-size:11px;color:hsl(var(--muted-foreground));line-height:1.4;",
  input:
    "box-sizing:border-box;width:100%;padding:5px 8px;font-size:12px;" +
    "border-radius:6px;border:1px solid hsl(var(--border));" +
    "background:hsl(var(--background));color:hsl(var(--foreground));",
  // Like `input`, but flexes to share a row with the Search button instead of
  // claiming the full width (which would push the button onto its own line).
  searchInput:
    "flex:1 1 auto;min-width:0;box-sizing:border-box;padding:5px 8px;font-size:12px;" +
    "border-radius:6px;border:1px solid hsl(var(--border));" +
    "background:hsl(var(--background));color:hsl(var(--foreground));",
  row: "display:flex;gap:4px;",
  primaryButton:
    "padding:5px 10px;border-radius:6px;border:1px solid hsl(var(--primary));" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));" +
    "font-size:12px;cursor:pointer;white-space:nowrap;",
  status: "font-size:11px;color:hsl(var(--muted-foreground));line-height:1.4;",
  error: "font-size:11px;color:hsl(var(--destructive));line-height:1.4;word-break:break-word;",
  list: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-height:0;overflow-y:auto;",
  card:
    "display:flex;flex-direction:column;gap:4px;padding:6px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));",
  titleRow: "display:flex;align-items:baseline;gap:6px;",
  title: "font-size:12px;font-weight:600;line-height:1.3;flex:1 1 auto;",
  sub:
    "font-size:10px;color:hsl(var(--muted-foreground));white-space:nowrap;" +
    "overflow:hidden;text-overflow:ellipsis;",
  desc:
    "font-size:11px;color:hsl(var(--muted-foreground));line-height:1.4;" +
    "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;",
  badge:
    "font-size:9px;padding:1px 5px;border-radius:999px;flex:0 0 auto;" +
    "background:hsl(var(--accent));color:hsl(var(--accent-foreground));" +
    "text-transform:uppercase;letter-spacing:0.03em;",
  actions: "display:flex;gap:4px;flex-wrap:wrap;",
  action:
    "padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));" +
    "color:hsl(var(--foreground));",
  settings:
    "display:none;flex-direction:column;gap:5px;padding:7px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));",
  edits:
    "display:none;flex-direction:column;gap:6px;padding:7px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));",
  editsHeading: "font-size:11px;font-weight:600;",
  editRow: "display:flex;flex-direction:column;gap:3px;",
  editName:
    "font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
} as const;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, style: string, title?: string): HTMLButtonElement {
  const node = el("button", style, text);
  node.type = "button";
  if (title) node.title = title;
  return node;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a failure was the request never reaching the server at all.
 *
 * `fetch` rejects with a bare `TypeError` ("Failed to fetch") when the browser
 * blocks the request — a CORS policy, a DNS failure, being offline — and gives
 * the page no detail beyond that, by design. Every failure this module raises
 * itself is a plain `Error`, so the constructor is a reliable discriminator.
 *
 * It matters because CORS is the likeliest cause and the least guessable: a
 * GeoLens deployment that serves its catalog happily to `curl` is unreachable
 * from a browser unless it sends `Access-Control-Allow-Origin` for the app's
 * origin, and `demo.getgeolens.com` currently sends none at all.
 */
function isTransportFailure(error: unknown): boolean {
  return error instanceof TypeError;
}

/** The host of a base URL, for an error message; falls back to the whole URL. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Scheme + host + port of a base URL, or null when it is not a usable URL. */
function originOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Layer creation + tile-token lifecycle.
// ---------------------------------------------------------------------------

function createLayerId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** A stable identity for "this dataset from this server", for add/remove state. */
function sourcePathFor(client: GeoLensClientOptions, dataset: GeoLensDataset): string {
  return `geolens:${client.baseUrl}/${dataset.id}`;
}

/** Pending token-refresh timers, keyed by store layer id, so they can be cleared. */
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearRefreshTimer(layerId: string): void {
  const timer = refreshTimers.get(layerId);
  if (timer !== undefined) {
    clearTimeout(timer);
    refreshTimers.delete(layerId);
  }
}

/** Clear every pending refresh (plugin deactivation). */
function clearAllRefreshTimers(): void {
  for (const timer of refreshTimers.values()) clearTimeout(timer);
  refreshTimers.clear();
}

/**
 * Raster tile URL prefixes that need an `X-Api-Key` header, mapped to the key.
 *
 * MapLibre issues raster tile requests itself, so an API-key-only private raster
 * cannot carry the key the way the fetch calls in `./geolens-api` do.
 * `transformRequest` is the supported hook: `RasterTileSource` routes every tile
 * URL through it, and supplying any header other than `accept` moves the request
 * off `HTMLImageElement` onto fetch, which sends headers. (Verified against
 * maplibre-gl 5.24: `ImageRequest.doImageRequest` only takes the
 * `HTMLImageElement` path when `requestParameters.headers` is empty or
 * `accept`-only.)
 *
 * Keyed by tile-URL prefix (everything before the `{z}` placeholder) rather than
 * by origin, so a key is only ever attached to the exact GeoLens raster endpoint
 * that issued it. A basemap, another plugin's tiles, or a second GeoLens server
 * reachable on the same origin never sees it.
 */
const rasterApiKeys = new Map<string, string>();

let installedOnMap: MapLibreMap | null = null;

function geolensTransformRequest(
  url: string,
  resourceType?: ResourceType,
): RequestParameters | undefined {
  if (resourceType !== "Tile" || rasterApiKeys.size === 0) return undefined;
  const headers = rasterTileAuthHeaders(url, rasterApiKeys);
  return headers ? { url, headers } : undefined;
}

/**
 * Register a private raster's tile URL so its requests carry the API key.
 *
 * Installs the transform on first use only. GeoLibre sets no `transformRequest`
 * of its own, and `Map` exposes no getter for an existing one, so this
 * deliberately does not try to chain: it returns `undefined` for anything it
 * does not recognize, which is the documented "leave this request alone" answer
 * and keeps the hook cheap to hand over if the host ever wants to own it.
 */
function registerRasterApiKey(app: GeoLibreAppAPI, tiles: string, apiKey: string): void {
  rasterApiKeys.set(tileUrlPrefix(tiles), apiKey);
  const map = app.getMap?.();
  if (!map || installedOnMap === map) return;
  map.setTransformRequest(geolensTransformRequest);
  installedOnMap = map;
}

/**
 * Drop every registered key and uninstall the hook (plugin deactivation).
 *
 * Raster layers the user added stay on the map, but a private one stops
 * rendering once its key is gone. That is deliberate: the credential was
 * entered into the plugin panel, so it should not outlive the plugin. The way
 * back is the connect handler, which re-registers templates for restored
 * layers when the user reconnects with a key.
 */
function clearRasterApiKeys(): void {
  rasterApiKeys.clear();
  installedOnMap?.setTransformRequest(null);
  installedOnMap = null;
}

/** True when the layer's signed tile URL carries an expired (or near-expiry) token. */
function tileTokenExpired(layer: GeoLibreLayer): boolean {
  const tiles = layer.source.tiles;
  const url = Array.isArray(tiles) && typeof tiles[0] === "string" ? tiles[0] : "";
  const match = url.match(/[?&]exp=(\d+)/);
  if (!match) return false; // no signed expiry — leave it alone
  return Number(match[1]) <= Math.floor(Date.now() / 1000) + 5;
}

/** GeoLens layers currently being re-minted, to avoid overlapping restores. */
const restoringLayerIds = new Set<string>();

/**
 * Re-mint tile tokens for GeoLens vector-tile layers restored from a saved
 * project. Such a layer arrives with a dead token (tokens live seconds to
 * minutes) and no refresh timer — so its tiles 404 forever. For any GeoLens
 * layer whose token has expired and that isn't already managed, this mints a
 * fresh token, patches the layer's `tiles`, and starts the refresh loop.
 *
 * Only public datasets restore automatically: the API key is never persisted,
 * so a private layer stays blank until re-added through the panel.
 */
function healRestoredGeoLensLayers(): void {
  for (const layer of useAppStore.getState().layers) {
    if (layer.metadata.sourceKind !== "geolens-vector-tiles") continue;
    if (refreshTimers.has(layer.id) || restoringLayerIds.has(layer.id)) continue;
    if (!tileTokenExpired(layer)) continue; // a fresh add already has a live token
    const baseUrl = layer.metadata.geolensBaseUrl;
    const datasetId = layer.metadata.geolensDatasetId;
    if (typeof baseUrl !== "string" || typeof datasetId !== "string") continue;
    const client: GeoLensClientOptions = { baseUrl };
    restoringLayerIds.add(layer.id);
    void mintTileToken(client, datasetId, defaultGeoLensFetch)
      .then((token) => {
        const current = useAppStore.getState().layers.find((l) => l.id === layer.id);
        if (!current) return;
        const { tiles } = vectorTileTemplate(client, token);
        useAppStore
          .getState()
          .updateLayer(layer.id, { source: { ...current.source, tiles: [tiles] } });
        scheduleTokenRefresh(client, layer.id, datasetId, token.expiresIn, defaultGeoLensFetch);
      })
      .catch(() => {}) // a transient failure is retried on the next store change
      .finally(() => restoringLayerIds.delete(layer.id));
  }
}

// Heal when the layer set changes (covers project load and late additions),
// plus once now for layers already present when this module loads. Guarded on
// the `layers` reference so unrelated store churn (pointer, selection, map view)
// doesn't re-run the scan — useAppStore has no selector-subscribe middleware.
let lastLayersRef: readonly GeoLibreLayer[] | null = null;
useAppStore.subscribe((state) => {
  if (state.layers === lastLayersRef) return;
  lastLayersRef = state.layers;
  healRestoredGeoLensLayers();
});
healRestoredGeoLensLayers();

/**
 * Schedule a re-mint of the signed tile token shortly before it expires and
 * patch the layer's `tiles` in place, so MVT keeps loading past the TTL. Stops
 * on its own once the layer leaves the store (user removed it); on a transient
 * mint failure it retries soon rather than giving up.
 */
function scheduleTokenRefresh(
  client: GeoLensClientOptions,
  layerId: string,
  datasetId: string,
  expiresIn: number,
  fetchImpl: GeoLensFetch,
  // When set (retry path), wait exactly this long instead of refreshing ahead
  // of expiry — it carries the capped exponential backoff between failures.
  retryBackoffSeconds?: number,
): void {
  clearRefreshTimer(layerId);
  const delaySeconds =
    retryBackoffSeconds ??
    Math.max(TOKEN_REFRESH_MIN_SECONDS, expiresIn - TOKEN_REFRESH_LEAD_SECONDS);
  const timer = setTimeout(() => {
    refreshTimers.delete(layerId);
    const store = useAppStore.getState();
    const layer = store.layers.find((l) => l.id === layerId);
    if (!layer) return; // removed from the Layers panel — nothing to refresh.
    void mintTileToken(client, datasetId, fetchImpl)
      .then((token) => {
        const { tiles } = vectorTileTemplate(client, token);
        // Re-read: the layer may have been removed while the mint was in flight.
        const current = useAppStore.getState().layers.find((l) => l.id === layerId);
        if (!current) return;
        useAppStore
          .getState()
          .updateLayer(layerId, { source: { ...current.source, tiles: [tiles] } });
        // Success resets the backoff (no retry argument).
        scheduleTokenRefresh(client, layerId, datasetId, token.expiresIn, fetchImpl);
      })
      .catch(() => {
        if (useAppStore.getState().layers.some((l) => l.id === layerId)) {
          // Capped exponential backoff so a persistently failing token endpoint
          // is not hammered every TOKEN_REFRESH_MIN_SECONDS forever.
          const nextBackoff =
            retryBackoffSeconds === undefined
              ? TOKEN_REFRESH_MIN_SECONDS
              : Math.min(retryBackoffSeconds * 2, TOKEN_REFRESH_MAX_RETRY_SECONDS);
          scheduleTokenRefresh(client, layerId, datasetId, 0, fetchImpl, nextBackoff);
        }
      });
  }, delaySeconds * 1000);
  refreshTimers.set(layerId, timer);
}

/**
 * Add a vector dataset as a signed MVT layer. `addTileLayer` is raster-only in
 * the host, so a `"vector-tiles"` layer is built directly and pushed to the
 * store (the same shape the OGC Vector Tiles Add Data source produces).
 */
async function addVectorTilesLayer(
  app: GeoLibreAppAPI,
  client: GeoLensClientOptions,
  dataset: GeoLensDataset,
  fetchImpl: GeoLensFetch,
): Promise<void> {
  // Mint the tile token and read the dataset's field names together. A vector-
  // tile layer carries no `geojson` features, so the field list (from one OGC
  // items feature) is what lets the Style panel populate its attribute
  // dropdowns (3D extrusion height, graduated/categorical color). Best-effort:
  // if the items read fails the layer still renders, just without field hints.
  const [token, fields] = await Promise.all([
    mintTileToken(client, dataset.id, fetchImpl),
    fetchDatasetFields(client, dataset.id, fetchImpl).catch(() => [] as string[]),
  ]);
  const { tiles, sourceLayer } = vectorTileTemplate(client, token);
  const layer: GeoLibreLayer = {
    id: createLayerId(),
    name: dataset.title,
    type: "vector-tiles",
    source: {
      type: "vector",
      tiles: [tiles],
      sourceLayer,
      sourceLayers: [sourceLayer],
      minzoom: 0,
      maxzoom: 22,
      ...(dataset.bbox ? { bounds: dataset.bbox } : {}),
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      sourceKind: "geolens-vector-tiles",
      geolensBaseUrl: client.baseUrl,
      geolensDatasetId: dataset.id,
      sourceLayers: [sourceLayer],
      fields,
      // The host's canonical geometry signal — drives the Layers-panel symbol
      // and default styling when there are no local features to inspect.
      ...(geometryKind(dataset.geometryType)
        ? { geometryType: geometryKind(dataset.geometryType) }
        : {}),
    },
    sourcePath: sourcePathFor(client, dataset),
  };
  useAppStore.getState().addLayer(layer);
  if (dataset.bbox) app.fitBounds?.(dataset.bbox);
  scheduleTokenRefresh(client, layer.id, dataset.id, token.expiresIn, fetchImpl);
}

/**
 * Add a raster dataset as server-rendered Titiler PNG tiles. The raster token
 * carries no signature/expiry, so no refresh is scheduled; access is authorized
 * per tile request (a public dataset renders anonymously). Built as an `"xyz"`
 * raster layer directly (rather than `app.addTileLayer`) so it carries the same
 * `sourcePath` the vector path uses for add/remove state.
 */
async function addRasterTilesLayer(
  app: GeoLibreAppAPI,
  client: GeoLensClientOptions,
  dataset: GeoLensDataset,
  fetchImpl: GeoLensFetch,
): Promise<void> {
  const raster = await resolveRasterTiles(client, dataset.id, fetchImpl);
  // A public raster renders anonymously; only a keyed client needs the header.
  if (client.apiKey) registerRasterApiKey(app, raster.tiles, client.apiKey);
  const layer: GeoLibreLayer = {
    id: createLayerId(),
    name: dataset.title,
    type: "xyz",
    source: {
      type: "raster",
      tiles: [raster.tiles],
      tileSize: raster.tileSize,
      minzoom: raster.minzoom,
      maxzoom: raster.maxzoom,
      ...(raster.bounds ? { bounds: raster.bounds } : {}),
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      sourceKind: "geolens-raster-tiles",
      geolensBaseUrl: client.baseUrl,
      geolensDatasetId: dataset.id,
    },
    sourcePath: sourcePathFor(client, dataset),
  };
  useAppStore.getState().addLayer(layer);
  const bounds = raster.bounds ?? dataset.bbox;
  if (bounds) app.fitBounds?.(bounds);
}

/**
 * Add a vector dataset as GeoJSON via OGC API Features. Follows `rel=next`
 * pages until `featureLimit` features are loaded; the vector-tile path is
 * preferred for large datasets. Uses the host GeoJSON layer so
 * styling/attribute-table/export all apply.
 */
async function addFeaturesLayer(
  app: GeoLibreAppAPI,
  client: GeoLensClientOptions,
  dataset: GeoLensDataset,
  featureLimit: number,
  fetchImpl: GeoLensFetch,
): Promise<void> {
  const data = await fetchDatasetFeatures(client, dataset.id, featureLimit, fetchImpl);
  const layerId = app.addGeoJsonLayer(
    dataset.title,
    data,
    `${sourcePathFor(client, dataset)}#items`,
  );
  // Register the baseline before the metadata write below: that write is the
  // store change that makes the panel notice the layer, and it must already be
  // able to report "no local changes" rather than an unknown state.
  editSessions.set(layerId, { baseline: captureFeatureBaseline(data) });
  // Tag the layer with where it came from, so the panel can offer to write
  // edits back — including after a project reload, when the in-memory baseline
  // is gone but the metadata was persisted with the project.
  const store = useAppStore.getState();
  const layer = store.layers.find((l) => l.id === layerId);
  if (layer) {
    store.updateLayer(layerId, {
      metadata: {
        ...layer.metadata,
        sourceKind: GEOLENS_FEATURES_SOURCE_KIND,
        geolensBaseUrl: client.baseUrl,
        geolensDatasetId: dataset.id,
      },
    });
  }
  if (dataset.bbox) app.fitBounds?.(dataset.bbox);
}

// ---------------------------------------------------------------------------
// Feature editing: change tracking and write-back.
// ---------------------------------------------------------------------------

/** What a layer's features looked like on the server, per store layer id. */
interface GeoLensEditSession {
  baseline: GeoLensFeatureBaseline;
}

/**
 * Per-layer baselines for the GeoLens datasets loaded this session.
 *
 * Deliberately in memory only — a baseline is a copy of the whole dataset, and
 * persisting it would bloat every saved project. A restored project therefore
 * has none, and {@link ensureBaseline} rebuilds it from the server, which also
 * means the diff is against what the dataset holds *now* rather than what it
 * held whenever the project was last saved.
 */
const editSessions = new Map<string, GeoLensEditSession>();

/** A GeoLens GeoJSON layer in the store that can be written back. */
interface GeoLensEditableLayer {
  id: string;
  name: string;
  datasetId: string;
  baseUrl: string;
  geojson: import("geojson").FeatureCollection;
}

/** The editable GeoLens feature layers currently in the store for one server. */
export function editableLayersForServer(baseUrl: string): GeoLensEditableLayer[] {
  const out: GeoLensEditableLayer[] = [];
  for (const layer of useAppStore.getState().layers) {
    if (layer.metadata.sourceKind !== GEOLENS_FEATURES_SOURCE_KIND) continue;
    if (layer.metadata.geolensBaseUrl !== baseUrl) continue;
    const datasetId = layer.metadata.geolensDatasetId;
    if (typeof datasetId !== "string" || !layer.geojson) continue;
    out.push({ id: layer.id, name: layer.name, datasetId, baseUrl, geojson: layer.geojson });
  }
  return out;
}

/**
 * The baseline for a layer: the one captured when it was loaded, or — after a
 * project reload or a plugin reactivation — a fresh read of the dataset from
 * the server. Reading it back is what makes "Save" work at all on a restored
 * project, and it is why a save then only writes what genuinely differs from
 * the server rather than re-writing every feature.
 */
async function ensureBaseline(
  client: GeoLensClientOptions,
  layer: GeoLensEditableLayer,
  featureLimit: number,
  fetchImpl: GeoLensFetch,
  signal?: AbortSignal,
): Promise<GeoLensFeatureBaseline> {
  const existing = editSessions.get(layer.id);
  if (existing) return existing.baseline;
  const data = await fetchDatasetFeatures(client, layer.datasetId, featureLimit, fetchImpl, signal);
  const baseline = captureFeatureBaseline(data);
  editSessions.set(layer.id, { baseline });
  return baseline;
}

/** Counts shown next to a layer in the Edits section. */
interface GeoLensPendingCounts {
  added: number;
  changed: number;
  deleted: number;
}

function planCounts(plan: GeoLensEditPlan): GeoLensPendingCounts {
  return {
    added: plan.creates.length,
    changed: plan.updates.length,
    deleted: plan.deletes.length,
  };
}

/**
 * Last computed counts per layer, keyed on the exact collection and baseline
 * they were derived from. Diffing walks every feature, and the panel repaints
 * whenever *any* layer changes, so without this an edit to one layer would
 * re-diff every other tracked dataset as well.
 */
const pendingCountsCache = new Map<
  string,
  {
    collection: import("geojson").FeatureCollection;
    baseline: GeoLensFeatureBaseline;
    counts: GeoLensPendingCounts;
  }
>();

/**
 * The pending changes for a layer whose baseline is already known, or null when
 * it is not (a restored project, before a save reads the dataset back). The
 * panel uses this for its at-a-glance counts, which is why it never triggers a
 * network read of its own.
 */
function pendingCountsFor(layer: GeoLensEditableLayer): GeoLensPendingCounts | null {
  const session = editSessions.get(layer.id);
  if (!session) return null;
  const cached = pendingCountsCache.get(layer.id);
  if (cached && cached.collection === layer.geojson && cached.baseline === session.baseline) {
    return cached.counts;
  }
  const counts = planCounts(diffFeatures(layer.geojson, session.baseline));
  pendingCountsCache.set(layer.id, {
    collection: layer.geojson,
    baseline: session.baseline,
    counts,
  });
  return counts;
}

/** The outcome of one layer's save, as the panel reports it. */
interface GeoLensSaveOutcome {
  written: number;
  errors: string[];
}

/**
 * Diff a layer against its baseline and write the differences to GeoLens.
 *
 * After the writes, the ids GeoLens assigned to newly inserted features are
 * stamped back onto the store layer, and the baseline is advanced to match —
 * but only for the writes that actually succeeded, so a partially applied save
 * leaves exactly the failed changes still pending instead of silently dropping
 * them.
 */
async function saveLayerEdits(
  client: GeoLensClientOptions,
  layer: GeoLensEditableLayer,
  featureLimit: number,
  fetchImpl: GeoLensFetch,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<GeoLensSaveOutcome> {
  const baseline = await ensureBaseline(client, layer, featureLimit, fetchImpl, signal);
  const plan = diffFeatures(layer.geojson, baseline);
  if (isEditPlanEmpty(plan)) return { written: 0, errors: [] };

  const result = await applyFeatureEdits(
    client,
    layer.datasetId,
    plan,
    fetchImpl,
    onProgress,
    signal,
  );

  // Stamp the new gids onto the features that were just inserted, so a second
  // save updates those rows instead of inserting duplicates.
  const newGidByIndex = new Map<number, number>();
  for (const created of result.created) {
    if (created.gid !== null) newGidByIndex.set(created.index, created.gid);
  }
  // What the server now holds: the collection that was actually diffed and
  // written, with the assigned row ids stamped on. Deliberately NOT re-read
  // from the store — an edit made while the save was in flight is not on the
  // server, and baselining it would mark it as already saved, so it could never
  // be written and would be lost.
  const saved: import("geojson").FeatureCollection =
    newGidByIndex.size === 0
      ? layer.geojson
      : {
          ...layer.geojson,
          features: layer.geojson.features.map((feature, index) => {
            const gid = newGidByIndex.get(index);
            return gid === undefined ? feature : { ...feature, id: gid };
          }),
        };

  const current = useAppStore.getState().layers.find((l) => l.id === layer.id);
  if (newGidByIndex.size > 0 && current?.geojson === layer.geojson) {
    // Only write the stamped ids back when the layer has not been edited again
    // while the save was in flight; otherwise the indices no longer refer to the
    // same features and stamping them would attach a row id to the wrong one.
    useAppStore.getState().updateLayer(layer.id, { geojson: saved });
  }

  // Advance the baseline to the saved state, then put back the entries whose
  // write failed so they stay pending.
  const next = captureFeatureBaseline(saved);
  const updatedOk = new Set(result.updated.map(String));
  for (const update of plan.updates) {
    if (updatedOk.has(String(update.gid))) continue;
    const original = baseline.get(String(update.gid));
    if (original) next.set(String(update.gid), original);
  }
  const deletedOk = new Set(result.deleted.map(String));
  for (const gid of plan.deletes) {
    if (deletedOk.has(String(gid))) continue;
    const original = baseline.get(String(gid));
    if (original) next.set(String(gid), original);
  }
  editSessions.set(layer.id, { baseline: next });

  const written = result.updated.length + result.created.length + result.deleted.length;
  return { written, errors: result.errors };
}

/**
 * Discard a layer's local changes by reloading the dataset from GeoLens. Also
 * re-captures the baseline, so the layer starts clean rather than immediately
 * looking edited again.
 */
async function reloadLayerFeatures(
  client: GeoLensClientOptions,
  layer: GeoLensEditableLayer,
  featureLimit: number,
  fetchImpl: GeoLensFetch,
  signal?: AbortSignal,
): Promise<void> {
  const data = await fetchDatasetFeatures(client, layer.datasetId, featureLimit, fetchImpl, signal);
  useAppStore.getState().updateLayer(layer.id, { geojson: data });
  editSessions.set(layer.id, { baseline: captureFeatureBaseline(data) });
}

/**
 * Drop bookkeeping for layers that have left the store.
 *
 * A baseline is a full copy of its dataset, so without this a session of adding
 * and removing GeoLens layers retains one dataset per layer the user has since
 * discarded. Called from the panel's store subscription, which already runs on
 * every `layers` change.
 */
function pruneEditSessions(): void {
  const live = new Set(useAppStore.getState().layers.map((l) => l.id));
  for (const id of editSessions.keys()) {
    if (!live.has(id)) editSessions.delete(id);
  }
  for (const id of pendingCountsCache.keys()) {
    if (!live.has(id)) pendingCountsCache.delete(id);
  }
}

/** Forget every tracked baseline (plugin deactivation). */
function clearEditSessions(): void {
  editSessions.clear();
  pendingCountsCache.clear();
}

// ---------------------------------------------------------------------------
// Panel.
// ---------------------------------------------------------------------------

interface PanelState {
  client: GeoLensClientOptions | null;
  datasets: GeoLensDataset[];
  /** Monotonic token to ignore superseded in-flight requests. */
  generation: number;
  controller: AbortController | null;
  featureLimit: number;
  /** Whether the connected server has dataset editing enabled. */
  editingEnabled: boolean;
  /** Layer ids with a save/reload in flight, so the row can't be re-triggered. */
  busyLayerIds: Set<string>;
}

/**
 * Build the panel DOM and return a teardown. `fetchImpl` is injectable for the
 * same reason the API module's is — the panel logic can be exercised without a
 * live server.
 */
function buildPanel(
  container: HTMLElement,
  app: GeoLibreAppAPI | null,
  fetchImpl: GeoLensFetch,
): () => void {
  const state: PanelState = {
    client: null,
    datasets: [],
    generation: 0,
    controller: null,
    featureLimit: readFeatureLimit(),
    editingEnabled: false,
    busyLayerIds: new Set(),
  };

  const panel = el("div", CSS.panel);
  const hintRow = el("div", "display:flex;align-items:flex-start;gap:8px;");
  const hint = el("div", `${CSS.hint}flex:1 1 auto;`, labels.hint);
  const settingsButton = button("⚙", CSS.action, labels.settings);
  settingsButton.setAttribute("aria-label", labels.settings);
  hintRow.append(hint, settingsButton);

  const settingsPanel = el("div", CSS.settings);
  const featureLimitLabel = el("label", "font-size:11px;font-weight:600;", labels.featureLimit);
  const featureLimitInput = el("input", CSS.input) as HTMLInputElement;
  featureLimitInput.type = "number";
  featureLimitInput.min = "1";
  featureLimitInput.max = String(MAX_GEOLENS_FEATURE_LIMIT);
  featureLimitInput.step = "1";
  featureLimitInput.value = String(state.featureLimit);
  featureLimitInput.style.display = "block";
  featureLimitInput.style.marginTop = "4px";
  featureLimitLabel.append(featureLimitInput);
  settingsPanel.append(featureLimitLabel, el("div", CSS.hint, labels.featureLimitHelp));

  // A shortcut to the public deployments. It fills the URL field and connects,
  // rather than only filling it: picking a sample server is the whole intent, so
  // leaving the user to press Connect afterwards would just be a second click.
  const sampleSelect = el("select", CSS.input) as HTMLSelectElement;
  sampleSelect.title = labels.sampleServerTitle;
  sampleSelect.setAttribute("aria-label", labels.sampleServerTitle);
  const samplePlaceholder = el("option", "", labels.sampleServer);
  samplePlaceholder.value = "";
  sampleSelect.append(samplePlaceholder);
  for (const server of GEOLENS_SAMPLE_SERVERS) {
    const option = el("option", "", server.label);
    option.value = server.baseUrl;
    option.title = server.baseUrl;
    sampleSelect.append(option);
  }

  const baseUrlInput = el("input", CSS.input) as HTMLInputElement;
  baseUrlInput.placeholder = labels.baseUrlPlaceholder;
  baseUrlInput.autocomplete = "off";

  const apiKeyInput = el("input", CSS.input) as HTMLInputElement;
  apiKeyInput.placeholder = labels.apiKeyPlaceholder;
  apiKeyInput.autocomplete = "off";
  // Mask the key like a password so it isn't shown in the clear when pasted.
  apiKeyInput.type = "password";

  const connectRow = el("div", CSS.row);
  const connectButton = button(labels.connect, CSS.primaryButton);
  connectRow.append(connectButton);

  // Wider gap than CSS.row: the input's focus ring renders a few px outside its
  // border box, and a 4px gap lets that ring touch the Search button on focus.
  const searchRow = el("div", "display:flex;gap:8px;");
  const searchInput = el("input", CSS.searchInput) as HTMLInputElement;
  searchInput.placeholder = labels.searchPlaceholder;
  const searchButton = button(labels.search, CSS.primaryButton);
  searchRow.append(searchInput, searchButton);
  searchRow.style.display = "none";

  const status = el("div", CSS.status, "");
  const errorLine = el("div", CSS.error, "");
  errorLine.style.display = "none";
  const edits = el("div", CSS.edits);
  edits.style.display = "none";
  const list = el("div", CSS.list);

  panel.append(
    hintRow,
    settingsPanel,
    sampleSelect,
    baseUrlInput,
    apiKeyInput,
    connectRow,
    searchRow,
    status,
    errorLine,
    edits,
    list,
  );
  container.replaceChildren(panel);

  const showError = (message: string): void => {
    errorLine.textContent = message;
    errorLine.style.display = "";
  };
  const clearError = (): void => {
    errorLine.textContent = "";
    errorLine.style.display = "none";
  };

  // Resolves true when the search completed and populated the catalog, false
  // on error or when superseded — so the caller can gate UI on a real result.
  const runSearch = async (query: string): Promise<boolean> => {
    if (!state.client) return false;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const generation = ++state.generation;
    clearError();
    status.textContent = labels.searching;
    try {
      const datasets = await searchDatasets(
        state.client,
        query,
        SEARCH_LIMIT,
        fetchImpl,
        controller.signal,
      );
      if (generation !== state.generation) return false; // superseded
      state.datasets = datasets;
      renderList();
      status.textContent = datasets.length ? labels.showing(datasets.length) : labels.noResults;
      return true;
    } catch (error) {
      if (isAbort(error) || generation !== state.generation) return false;
      // Show no catalog rather than a stale one: after a failed request the
      // panel does not know what this server holds, and leaving the previous
      // results up presents them as the answer to a query that never ran.
      state.datasets = [];
      renderList();
      status.textContent = "";
      showError(
        isTransportFailure(error)
          ? labels.blockedError(hostOf(state.client?.baseUrl ?? ""))
          : labels.loadError(messageOf(error)),
      );
      return false;
    }
  };

  // Buttons currently mid-add (skip store-driven resync so it doesn't clobber
  // the transient "Adding…" state) and the per-button resync callbacks that
  // re-derive add/added state from the store (rebuilt on each renderList).
  const addingButtons = new Set<HTMLButtonElement>();
  const resyncers: Array<() => void> = [];

  // Reconcile one add-style button with the store: if a layer with `sourcePath`
  // is present it reads "Added" and is disabled; otherwise it offers `addLabel`
  // and is enabled. Derived from the store (not remembered) so the button stays
  // correct after the user removes the layer from the Layers panel.
  const syncButtonState = (btn: HTMLButtonElement, sourcePath: string, addLabel: string): void => {
    if (addingButtons.has(btn)) return;
    const present = useAppStore.getState().layers.some((l) => l.sourcePath === sourcePath);
    btn.disabled = present;
    btn.textContent = present ? labels.added : addLabel;
  };

  const renderList = (): void => {
    resyncers.length = 0;
    list.replaceChildren();
    for (const dataset of state.datasets) {
      list.append(renderCard(dataset));
    }
  };

  // Per-layer status lines in the Edits section, so a save in progress can
  // report "Saving 12/48…" into its own row without repainting the section.
  const rowStatusNodes = new Map<string, HTMLElement>();

  /**
   * Repaint the Edits section: one row per GeoLens GeoJSON layer on the map that
   * came from the connected server. Hidden entirely when there are none, so the
   * panel looks exactly as it did before for read-only use.
   */
  const renderEdits = (): void => {
    rowStatusNodes.clear();
    const client = state.client;
    const layers = client ? editableLayersForServer(client.baseUrl) : [];
    if (!client || layers.length === 0) {
      edits.replaceChildren();
      edits.style.display = "none";
      return;
    }
    const children: HTMLElement[] = [el("div", CSS.editsHeading, labels.editsHeading)];
    // Say *why* saving is unavailable rather than showing a dead button: the
    // server's editing flag is off, or the connection carries no API key (the
    // write endpoints reject anonymous requests).
    if (!state.editingEnabled) {
      children.push(el("div", CSS.hint, labels.saveDisabledByServer));
    } else if (!client.apiKey) {
      children.push(el("div", CSS.hint, labels.saveNeedsKey));
    }
    for (const layer of layers) children.push(renderEditRow(layer));
    edits.replaceChildren(...children);
    edits.style.display = "flex";
  };

  const renderEditRow = (layer: GeoLensEditableLayer): HTMLElement => {
    const row = el("div", CSS.editRow);
    row.append(el("div", CSS.editName, layer.name));

    const counts = pendingCountsFor(layer);
    const pending = counts ? counts.added + counts.changed + counts.deleted : null;
    const rowStatus = el(
      "div",
      CSS.hint,
      // A restored project has no baseline yet, so the counts are unknown until
      // a save reads the dataset back — leave the line blank rather than claim
      // there is nothing to save.
      counts === null
        ? ""
        : pending === 0
          ? labels.editsNone
          : labels.editsPending(counts.added, counts.changed, counts.deleted),
    );
    rowStatusNodes.set(layer.id, rowStatus);
    row.append(rowStatus);

    const busy = state.busyLayerIds.has(layer.id);
    const canWrite = state.editingEnabled && !!state.client?.apiKey;
    const actions = el("div", CSS.actions);

    const saveButton = button(labels.saveEdits, CSS.action, labels.saveEditsTitle);
    saveButton.disabled = busy || !canWrite || pending === 0;
    saveButton.addEventListener("click", () => void handleSave(layer));

    const reloadButton = button(labels.revertEdits, CSS.action, labels.revertEditsTitle);
    reloadButton.disabled = busy;
    reloadButton.addEventListener("click", () => void handleReload(layer));

    actions.append(saveButton, reloadButton);
    row.append(actions);
    return row;
  };

  /** The layer's current store state, or null when it has since been removed. */
  const currentEditableLayer = (layerId: string): GeoLensEditableLayer | null => {
    if (!state.client) return null;
    return editableLayersForServer(state.client.baseUrl).find((l) => l.id === layerId) ?? null;
  };

  const handleSave = async (layer: GeoLensEditableLayer): Promise<void> => {
    const client = state.client;
    if (!client || state.busyLayerIds.has(layer.id)) return;
    state.busyLayerIds.add(layer.id);
    clearError();
    renderEdits();
    try {
      // Re-read from the store: the row was built from a snapshot that may be a
      // few edits old by the time the button is pressed.
      const fresh = currentEditableLayer(layer.id) ?? layer;
      const outcome = await saveLayerEdits(
        client,
        fresh,
        state.featureLimit,
        fetchImpl,
        (done, total) => {
          const node = rowStatusNodes.get(layer.id);
          if (node) node.textContent = labels.savingEdits(done, total);
        },
      );
      if (outcome.errors.length > 0) {
        showError(labels.savePartial(outcome.errors.length, outcome.errors[0]));
      }
      status.textContent = labels.savedEdits(outcome.written);
    } catch (error) {
      showError(labels.saveError(messageOf(error)));
    } finally {
      state.busyLayerIds.delete(layer.id);
      renderEdits();
    }
  };

  const handleReload = async (layer: GeoLensEditableLayer): Promise<void> => {
    const client = state.client;
    if (!client || state.busyLayerIds.has(layer.id)) return;
    // Reloading throws away unsaved work, and there is no undo, so confirm when
    // there is something to lose. A clean layer still reloads on one click.
    const pending = pendingCountsFor(layer);
    if (pending && pending.added + pending.changed + pending.deleted > 0) {
      const proceed = window.confirm(
        labels.revertConfirm(pending.added, pending.changed, pending.deleted),
      );
      if (!proceed) return;
    }
    state.busyLayerIds.add(layer.id);
    clearError();
    renderEdits();
    const rowStatus = rowStatusNodes.get(layer.id);
    if (rowStatus) rowStatus.textContent = labels.revertingEdits;
    try {
      await reloadLayerFeatures(client, layer, state.featureLimit, fetchImpl);
    } catch (error) {
      showError(labels.loadError(messageOf(error)));
    } finally {
      state.busyLayerIds.delete(layer.id);
      renderEdits();
    }
  };

  const renderCard = (dataset: GeoLensDataset): HTMLElement => {
    const card = el("div", CSS.card);

    const titleRow = el("div", CSS.titleRow);
    const title = el("div", CSS.title, dataset.title);
    const badge = el("span", CSS.badge, dataset.isRaster ? labels.rasterBadge : labels.vectorBadge);
    titleRow.append(title, badge);

    const facts: string[] = [];
    if (dataset.geometryType) facts.push(dataset.geometryType.toLowerCase());
    if (dataset.featureCount !== null) facts.push(labels.features(dataset.featureCount));
    if (dataset.license) facts.push(dataset.license);
    const sub = el("div", CSS.sub, facts.join(" · "));

    card.append(titleRow, sub);
    if (dataset.description) card.append(el("div", CSS.desc, dataset.description));

    const actions = el("div", CSS.actions);
    const tilesSourcePath = sourcePathFor(state.client!, dataset);
    // Raster datasets render as server-side Titiler PNG tiles; vector datasets
    // as signed MVT vector tiles. The button says which.
    const addLabel = dataset.isRaster ? labels.addRasterTiles : labels.addVectorTiles;
    const addTitle = dataset.isRaster ? labels.addRasterTilesTitle : labels.addVectorTilesTitle;
    const addButton = button(addLabel, CSS.action, addTitle);
    const syncAdd = () => syncButtonState(addButton, tilesSourcePath, addLabel);
    resyncers.push(syncAdd);
    syncAdd();
    const addPrimary = dataset.isRaster
      ? () => addRasterTilesLayer(app!, state.client!, dataset, fetchImpl)
      : () => addVectorTilesLayer(app!, state.client!, dataset, fetchImpl);
    addButton.addEventListener("click", () => {
      void handleAdd(addButton, syncAdd, addPrimary);
    });
    actions.append(addButton);

    // Full-feature GeoJSON is only meaningful for vector datasets.
    if (dataset.isVector) {
      const geoJsonSourcePath = `${tilesSourcePath}#items`;
      const geoJsonButton = button(labels.addGeoJson, CSS.action, labels.addGeoJsonTitle);
      const syncGeoJson = () =>
        syncButtonState(geoJsonButton, geoJsonSourcePath, labels.addGeoJson);
      resyncers.push(syncGeoJson);
      syncGeoJson();
      geoJsonButton.addEventListener("click", () => {
        void handleAdd(geoJsonButton, syncGeoJson, () =>
          addFeaturesLayer(app!, state.client!, dataset, state.featureLimit, fetchImpl),
        );
      });
      actions.append(geoJsonButton);
    }

    // Opens the dataset's page on the GeoLens server for the full record. Route
    // through the host's opener (the Tauri webview ignores window.open and would
    // open the link inside the app); fall back to window.open on older hosts.
    const metadataButton = button(labels.metadata, CSS.action, labels.metadataTitle);
    metadataButton.addEventListener("click", () => {
      if (!state.client) return;
      const url = datasetPageUrl(state.client, dataset.id);
      if (app?.openExternalUrl) app.openExternalUrl(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    });
    actions.append(metadataButton);

    card.append(actions);
    return card;
  };

  const handleAdd = async (
    trigger: HTMLButtonElement,
    settle: () => void,
    add: () => Promise<void>,
  ): Promise<void> => {
    if (!app || !state.client) return;
    addingButtons.add(trigger);
    trigger.disabled = true;
    trigger.textContent = labels.adding;
    clearError();
    try {
      await add();
    } catch (error) {
      showError(labels.addError(messageOf(error)));
    } finally {
      // Settle from store truth: "Added"+disabled on success, back to the add
      // label+enabled on failure (the layer never entered the store).
      addingButtons.delete(trigger);
      settle();
      // A GeoJSON add introduces a layer the Edits section tracks, and it
      // finishes after the store change that would otherwise have repainted it.
      renderEdits();
    }
  };

  /**
   * Forget the API key when the server being pointed at changes origin.
   *
   * A key is issued by one deployment. Carrying it across — which is what
   * picking a sample server or retyping the host would otherwise do — would send
   * a private host's credential to a different, possibly public one.
   */
  const dropKeyOnOriginChange = (nextBaseUrl: string): void => {
    const next = originOf(normalizeBaseUrl(nextBaseUrl));
    const current = originOf(normalizeBaseUrl(baseUrlInput.value));
    if (!next || !current || next === current) return;
    apiKeyInput.value = "";
  };

  const capabilitiesFor = async (client: GeoLensClientOptions): Promise<boolean> => {
    const { datasetEditing } = await fetchCapabilities(client, fetchImpl);
    return datasetEditing;
  };

  const connect = async (): Promise<void> => {
    const baseUrl = normalizeBaseUrl(baseUrlInput.value);
    if (!baseUrl) return;
    state.client = { baseUrl, apiKey: apiKeyInput.value.trim() || undefined };
    // Drop the outgoing server's catalog before the new one is queried. Those
    // cards belong to a server this panel is no longer pointed at: their Add
    // buttons would build source paths for the old base URL, and if the new
    // connection fails they would sit there looking like its catalog.
    state.datasets = [];
    renderList();
    connectButton.disabled = true;
    connectButton.textContent = labels.connecting;
    const connected = await runSearch("");
    connectButton.disabled = false;
    connectButton.textContent = labels.connect;
    // Reveal search only once a connection produced a catalog. On failure, drop
    // the client so a later attempt starts clean and the search row stays hidden.
    // Restore "flex" (not "") so the row keeps its flex layout and gap — setting
    // display to "" would wipe the inline `display:flex` and collapse to block.
    if (!connected) state.client = null;
    searchRow.style.display = connected ? "flex" : "none";
    // Ask the server whether it allows dataset editing at all. Public endpoint,
    // and a failure resolves to "no editing", so this never blocks connecting.
    state.editingEnabled = connected && state.client ? await capabilitiesFor(state.client) : false;
    renderEdits();
    // Restored private rasters (project reopen, plugin reactivation) are in the
    // store but hold no registered key — and their Add button is disabled, so
    // re-adding is not a path back. The key entered here is the one credential
    // they can get; register their templates so their tiles authenticate again.
    if (connected && app && state.client?.apiKey) {
      const layers = useAppStore.getState().layers;
      for (const template of rasterTemplatesForServer(layers, state.client.baseUrl)) {
        registerRasterApiKey(app, template, state.client.apiKey);
      }
    }
  };

  connectButton.addEventListener("click", () => void connect());
  sampleSelect.addEventListener("change", () => {
    const baseUrl = sampleSelect.value;
    // Reset to the placeholder: the URL field is the source of truth (the user
    // can edit it afterwards), so a stuck selection would soon be a lie.
    sampleSelect.value = "";
    if (!baseUrl) return;
    dropKeyOnOriginChange(baseUrl);
    baseUrlInput.value = baseUrl;
    void connect();
  });
  // Typing a different host clears the key for the same reason as above; the
  // check runs on `change` (commit), not on every keystroke, so editing a path
  // or fixing a typo within one host leaves the key alone.
  baseUrlInput.addEventListener("change", () => dropKeyOnOriginChange(baseUrlInput.value));
  settingsButton.addEventListener("click", () => {
    const open = settingsPanel.style.display !== "flex";
    settingsPanel.style.display = open ? "flex" : "none";
    settingsButton.setAttribute("aria-expanded", String(open));
  });
  settingsButton.setAttribute("aria-expanded", "false");
  featureLimitInput.addEventListener("change", () => {
    state.featureLimit = normalizeGeoLensFeatureLimit(featureLimitInput.value);
    featureLimitInput.value = String(state.featureLimit);
    writeFeatureLimit(state.featureLimit);
  });
  baseUrlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void connect();
  });
  searchButton.addEventListener("click", () => void runSearch(searchInput.value));
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void runSearch(searchInput.value);
  });

  // Re-derive every card's add/added button whenever the layer set changes, so
  // removing a layer from the Layers panel re-enables its "Add" button.
  //
  // The Edits section repaints with it — that is what makes the pending counts
  // follow along as the user edits geometry or attributes elsewhere in the app —
  // but only when the `layers` array itself changed. Repainting diffs every
  // tracked collection against its baseline, and this subscription fires on all
  // store churn (pointer moves, map view), which would run that diff continuously.
  let lastLayersRef: readonly GeoLibreLayer[] | null = null;
  const unsubscribe = useAppStore.subscribe((store) => {
    for (const resync of resyncers) resync();
    if (store.layers === lastLayersRef) return;
    lastLayersRef = store.layers;
    pruneEditSessions();
    if (state.busyLayerIds.size === 0) renderEdits();
  });

  return () => {
    unsubscribe();
    state.controller?.abort();
  };
}

// ---------------------------------------------------------------------------
// Plugin.
// ---------------------------------------------------------------------------

interface GeoLensPluginConfig {
  id: string;
  name: string;
  /** Injectable transport, so the plugin can be driven in tests. */
  fetchImpl?: GeoLensFetch;
}

function createGeoLensPlugin(config: GeoLensPluginConfig): GeoLibrePlugin {
  const fetchImpl = config.fetchImpl ?? defaultGeoLensFetch;
  let appRef: GeoLibreAppAPI | null = null;
  let unregisterPanel: (() => void) | null = null;
  let panelContainer: HTMLElement | null = null;
  let disposePanel: (() => void) | null = null;

  const mountPanel = (container: HTMLElement): void => {
    disposePanel?.();
    container.replaceChildren();
    panelContainer = container;
    disposePanel = buildPanel(container, appRef, fetchImpl);
  };

  const remount = (): void => {
    if (panelContainer) mountPanel(panelContainer);
  };

  return {
    id: config.id,
    name: config.name,
    version: "0.1.0",
    activate: (app: GeoLibreAppAPI) => {
      appRef = app;
      mountedPanels.add(remount);
      unregisterPanel =
        app.registerRightPanel?.({
          id: config.id,
          title: config.name,
          dock: "right-of-style",
          defaultWidth: 340,
          render: (container) => {
            mountPanel(container);
            return () => {
              disposePanel?.();
              disposePanel = null;
              if (panelContainer === container) panelContainer = null;
            };
          },
        }) ?? null;
      app.openRightPanel?.(config.id);
    },
    deactivate: (app: GeoLibreAppAPI) => {
      app.closeRightPanel?.(config.id);
      unregisterPanel?.();
      unregisterPanel = null;
      mountedPanels.delete(remount);
      // Layers the user added stay on the map (ordinary GeoLibre layers now),
      // but the token-refresh timers and the raster API keys we own must not
      // outlive the plugin.
      clearAllRefreshTimers();
      clearRasterApiKeys();
      // Baselines are the plugin's own bookkeeping and hold a full copy of each
      // loaded dataset; on reactivation they are read back from the server.
      clearEditSessions();
      appRef = null;
    },
  };
}

export const maplibreGeoLensPlugin: GeoLibrePlugin = createGeoLensPlugin({
  id: GEOLENS_PLUGIN_ID,
  name: "GeoLens",
});

/** Exposed for unit tests: build a plugin over an injected transport. */
export { createGeoLensPlugin };

/** Exposed for unit tests: the save path and the pending-change readout. */
export { clearEditSessions, pendingCountsFor, saveLayerEdits, type GeoLensEditableLayer };
