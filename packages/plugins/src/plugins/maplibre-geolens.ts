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
import type { FeatureCollection } from "geojson";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  authHeaders,
  defaultGeoLensFetch,
  itemsUrl,
  mintTileToken,
  normalizeBaseUrl,
  resolveRasterTiles,
  searchDatasets,
  vectorTileTemplate,
  type GeoLensClientOptions,
  type GeoLensDataset,
  type GeoLensFetch,
} from "./geolens-api";

export const GEOLENS_PLUGIN_ID = "maplibre-gl-geolens";

/** Number of datasets requested per catalog search. */
const SEARCH_LIMIT = 50;
/** OGC Features page size (GeoLens caps `limit`, so this reads one page). */
const FEATURES_LIMIT = 100;
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
  baseUrlPlaceholder: string;
  apiKeyPlaceholder: string;
  connect: string;
  connecting: string;
  searchPlaceholder: string;
  search: string;
  searching: string;
  noResults: string;
  loadError: (message: string) => string;
  showing: (count: number) => string;
  vectorBadge: string;
  rasterBadge: string;
  add: string;
  adding: string;
  added: string;
  addFeatures: string;
  addError: (message: string) => string;
  features: (count: number) => string;
}

export const DEFAULT_GEOLENS_LABELS: GeoLensLabels = {
  hint: "Connect to a GeoLens server to browse and add its catalog datasets.",
  baseUrlPlaceholder: "GeoLens URL, e.g. https://demo.getgeolens.com",
  apiKeyPlaceholder: "API key (optional, for private data)",
  connect: "Connect",
  connecting: "Connecting…",
  searchPlaceholder: "Search the catalog",
  search: "Search",
  searching: "Searching…",
  noResults: "No matching datasets.",
  loadError: (message) => `Could not reach GeoLens: ${message}`,
  showing: (count) => `${count} dataset${count === 1 ? "" : "s"}.`,
  vectorBadge: "vector",
  rasterBadge: "raster",
  add: "Add",
  adding: "Adding…",
  added: "Added",
  addFeatures: "Features",
  addError: (message) => `Could not add layer: ${message}`,
  features: (count) => `${count.toLocaleString()} features`,
};

let labels: GeoLensLabels = { ...DEFAULT_GEOLENS_LABELS };

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

function findAddedLayerId(
  client: GeoLensClientOptions,
  dataset: GeoLensDataset,
): string | undefined {
  const path = sourcePathFor(client, dataset);
  return useAppStore.getState().layers.find((layer) => layer.sourcePath === path)?.id;
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
  const token = await mintTileToken(client, dataset.id, fetchImpl);
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
 * Add a vector dataset as GeoJSON via OGC API Features. Reads one page (GeoLens
 * caps `limit`); the vector-tile path is preferred for large datasets. Uses the
 * host GeoJSON layer so styling/attribute-table/export all apply.
 */
async function addFeaturesLayer(
  app: GeoLibreAppAPI,
  client: GeoLensClientOptions,
  dataset: GeoLensDataset,
  fetchImpl: GeoLensFetch,
): Promise<void> {
  const url = itemsUrl(client, dataset.id, FEATURES_LIMIT);
  const res = await fetchImpl(url, { headers: authHeaders(client) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as FeatureCollection;
  app.addGeoJsonLayer(dataset.title, data, `${sourcePathFor(client, dataset)}#items`);
  if (dataset.bbox) app.fitBounds?.(dataset.bbox);
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
  };

  const panel = el("div", CSS.panel);
  const hint = el("div", CSS.hint, labels.hint);

  const baseUrlInput = el("input", CSS.input) as HTMLInputElement;
  baseUrlInput.placeholder = labels.baseUrlPlaceholder;
  baseUrlInput.autocomplete = "off";

  const apiKeyInput = el("input", CSS.input) as HTMLInputElement;
  apiKeyInput.placeholder = labels.apiKeyPlaceholder;
  apiKeyInput.autocomplete = "off";

  const connectRow = el("div", CSS.row);
  const connectButton = button(labels.connect, CSS.primaryButton);
  connectRow.append(connectButton);

  const searchRow = el("div", CSS.row);
  const searchInput = el("input", CSS.searchInput) as HTMLInputElement;
  searchInput.placeholder = labels.searchPlaceholder;
  const searchButton = button(labels.search, CSS.primaryButton);
  searchRow.append(searchInput, searchButton);
  searchRow.style.display = "none";

  const status = el("div", CSS.status, "");
  const errorLine = el("div", CSS.error, "");
  errorLine.style.display = "none";
  const list = el("div", CSS.list);

  panel.append(hint, baseUrlInput, apiKeyInput, connectRow, searchRow, status, errorLine, list);
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
      status.textContent = "";
      showError(labels.loadError(messageOf(error)));
      return false;
    }
  };

  const renderList = (): void => {
    list.replaceChildren();
    for (const dataset of state.datasets) {
      list.append(renderCard(dataset));
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
    const addedId = findAddedLayerId(state.client!, dataset);
    const addButton = button(addedId ? labels.added : labels.add, CSS.action, dataset.title);
    if (addedId) addButton.disabled = true;
    // Raster datasets render as server-side Titiler PNG tiles; vector datasets
    // as signed MVT vector tiles.
    const addPrimary = dataset.isRaster
      ? () => addRasterTilesLayer(app!, state.client!, dataset, fetchImpl)
      : () => addVectorTilesLayer(app!, state.client!, dataset, fetchImpl);
    addButton.addEventListener("click", () => {
      void handleAdd(dataset, addButton, addPrimary);
    });
    actions.append(addButton);

    // Full-feature GeoJSON is only meaningful for vector datasets.
    if (dataset.isVector) {
      const featuresButton = button(labels.addFeatures, CSS.action, labels.addFeatures);
      featuresButton.addEventListener("click", () => {
        void handleAdd(dataset, featuresButton, () =>
          addFeaturesLayer(app!, state.client!, dataset, fetchImpl),
        );
      });
      actions.append(featuresButton);
    }

    card.append(actions);
    return card;
  };

  const handleAdd = async (
    dataset: GeoLensDataset,
    trigger: HTMLButtonElement,
    add: () => Promise<void>,
  ): Promise<void> => {
    if (!app || !state.client) return;
    const original = trigger.textContent;
    trigger.disabled = true;
    trigger.textContent = labels.adding;
    clearError();
    try {
      await add();
      trigger.textContent = labels.added;
    } catch (error) {
      trigger.disabled = false;
      trigger.textContent = original;
      showError(labels.addError(messageOf(error)));
    }
  };

  const connect = async (): Promise<void> => {
    const baseUrl = normalizeBaseUrl(baseUrlInput.value);
    if (!baseUrl) return;
    state.client = { baseUrl, apiKey: apiKeyInput.value.trim() || undefined };
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
  };

  connectButton.addEventListener("click", () => void connect());
  baseUrlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void connect();
  });
  searchButton.addEventListener("click", () => void runSearch(searchInput.value));
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void runSearch(searchInput.value);
  });

  return () => {
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
      // but the token-refresh timers we own must not outlive the plugin.
      clearAllRefreshTimers();
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
