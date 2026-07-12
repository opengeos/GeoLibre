import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  buildSearchUrl,
  HTTP_URL_RE,
  type OamImage,
  type OamSearchResult,
  parseSearchResponse,
  searchOpenAerialMap,
} from "./openaerialmap-api";

export const OPENAERIALMAP_PLUGIN_ID = "maplibre-gl-openaerialmap";
const PANEL_ID = OPENAERIALMAP_PLUGIN_ID;
const PAGE_SIZE = 20;
// The OpenAerialMap metadata API is CORS-locked to the OAM web app origin, so a
// browser fetch from GeoLibre is blocked. GeoLibre's tiles Worker
// (workers/tiles, tiles.geolibre.app) re-emits it server-side with CORS, which
// is the one endpoint that works uniformly across the web, dev, and Jupyter
// embed builds (leafmap.oam_search avoids this entirely by calling the API
// server-side in Python). The desktop app fetches the API directly through its
// native (CORS-bypassing) HTTP, so its search bbox never leaves for the Worker.
const OAM_SEARCH_PROXY_ENDPOINT = "https://tiles.geolibre.app/oam";
const ATTRIBUTION =
  '<a href="https://openaerialmap.org/" target="_blank" rel="noopener">OpenAerialMap</a>';

/**
 * User-facing strings for the panel. This package is framework-agnostic and
 * cannot call `t()`, so the host (`TopToolbar`) pushes localized copies via
 * {@link setOpenAerialMapLabels} on activation and every language change, the
 * same pattern the graticule / mapillary plugins use.
 */
export interface OpenAerialMapLabels {
  hint: string;
  search: string;
  loadMore: string;
  searching: string;
  loadingMore: string;
  noResults: string;
  showing: (shown: number, total: number) => string;
  searchError: (message: string) => string;
  add: string;
  remove: string;
  zoom: string;
  download: string;
  addTitle: string;
  removeTitle: string;
  addUnavailableTitle: string;
  zoomTitle: string;
  downloadTitle: string;
}

/** English defaults, used until the host injects translations. */
export const DEFAULT_OPENAERIALMAP_LABELS: OpenAerialMapLabels = {
  hint: "Search the current map view for OpenAerialMap imagery.",
  search: "Search this view",
  loadMore: "Load more",
  searching: "Searching…",
  loadingMore: "Loading more…",
  noResults: "No imagery found in this view.",
  showing: (shown, total) => `Showing ${shown} of ${total} images.`,
  searchError: (message) =>
    `Could not reach OpenAerialMap: ${message}. Please try again.`,
  add: "Add",
  remove: "Remove",
  zoom: "Zoom",
  download: "Download",
  addTitle: "Add this image to the map",
  removeTitle: "Remove this image from the map",
  addUnavailableTitle: "No tile service available for this image",
  zoomTitle: "Zoom to this image",
  downloadTitle: "Download the source GeoTIFF",
};

let labels: OpenAerialMapLabels = { ...DEFAULT_OPENAERIALMAP_LABELS };

// The theme tokens are HSL channel triplets (shadcn convention), so they must be
// wrapped in hsl(); using them bare yields an invalid value that drops the rule.
const CSS = {
  panel:
    "display:flex;flex-direction:column;gap:8px;padding:8px;font-size:12px;" +
    "height:100%;box-sizing:border-box;color:hsl(var(--foreground));",
  primaryButton:
    "width:100%;padding:6px 10px;border-radius:6px;border:1px solid hsl(var(--primary));" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));" +
    "font-size:12px;cursor:pointer;",
  status: "font-size:11px;color:hsl(var(--muted-foreground));line-height:1.4;",
  results:
    "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-height:0;" +
    "overflow-y:auto;",
  card:
    "display:flex;gap:8px;padding:6px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));",
  thumb:
    "flex:0 0 auto;width:56px;height:56px;border-radius:4px;overflow:hidden;" +
    "background:hsl(var(--accent));",
  body: "flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:6px;",
  title:
    "font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;" +
    "text-overflow:ellipsis;",
  sub:
    "font-size:10px;color:hsl(var(--muted-foreground));white-space:nowrap;" +
    "overflow:hidden;text-overflow:ellipsis;",
  actions: "display:flex;gap:4px;flex-wrap:wrap;",
  action:
    "padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));" +
    "color:hsl(var(--foreground));",
  actionActive:
    "padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;" +
    "border:1px solid hsl(var(--primary));background:hsl(var(--primary));" +
    "color:hsl(var(--primary-foreground));",
} as const;

let appRef: GeoLibreAppAPI | null = null;
let unregisterPanel: (() => void) | null = null;
// The mounted panel container and its teardown, tracked so a language change can
// rebuild the panel in place (see setOpenAerialMapLabels).
let panelContainer: HTMLElement | null = null;
let disposePanel: (() => void) | null = null;

/**
 * Finds the store layer visualizing an image, matched by its tile-template URL.
 * The store (not an in-memory map) is the source of truth, so this stays correct
 * across a project reload, a fresh session, and layers removed from the Layers
 * panel — the tile URL is deterministic from the image's COG and persists on the
 * layer's source.
 */
function findAddedLayerId(image: OamImage): string | undefined {
  if (!image.tileUrl) return undefined;
  const layer = useAppStore.getState().layers.find((candidate) => {
    const tiles = (candidate.source as { tiles?: unknown }).tiles;
    return Array.isArray(tiles) && tiles.includes(image.tileUrl);
  });
  return layer?.id;
}

/** Whether an image is currently visualized on the map. */
function isAdded(image: OamImage): boolean {
  return findAddedLayerId(image) !== undefined;
}

/** Normalizes a longitude into [-180, 180]. */
function normalizeLon(lon: number): number {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return wrapped;
}

/** Reads the current map view as a valid [w, s, e, n] bbox. */
function currentBbox(): [number, number, number, number] | null {
  const map = appRef?.getMap?.();
  if (!map) return null;
  const bounds = map.getBounds();
  const clampLat = (n: number): number => Math.max(-90, Math.min(90, n));
  const rawWest = bounds.getWest();
  const rawEast = bounds.getEast();
  let west = normalizeLon(rawWest);
  let east = normalizeLon(rawEast);
  // A view that wraps the globe or crosses the antimeridian cannot be expressed
  // as a single non-inverted [-180, 180] bbox (MapLibre reports east < west, or
  // a >=360 span). Search the full longitude range instead of sending the OAM
  // API an inverted/invalid box that would silently return nothing.
  if (rawEast - rawWest >= 360 || west > east) {
    west = -180;
    east = 180;
  }
  return [west, clampLat(bounds.getSouth()), east, clampLat(bounds.getNorth())];
}

/**
 * Fetches a page of results. On desktop this routes through the host's native
 * (CORS-bypassing) fetch; otherwise it routes through the tiles Worker, which
 * re-emits the CORS-locked OAM metadata API with CORS.
 */
async function fetchPage(
  bbox: [number, number, number, number],
  page: number,
  signal?: AbortSignal,
): Promise<OamSearchResult> {
  // Desktop (Tauri): fetch the OAM API directly through the host's native
  // HTTP, which bypasses browser CORS and keeps the query on-device. (The
  // native fetch has no abort hook; a superseded result is ignored by the
  // caller's generation guard.)
  const isTauri =
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (isTauri && appRef?.fetchArrayBuffer) {
    const url = buildSearchUrl({ bbox, page, limit: PAGE_SIZE });
    const buffer = await appRef.fetchArrayBuffer(url);
    const body = JSON.parse(new TextDecoder().decode(buffer));
    return parseSearchResponse(body, page, PAGE_SIZE);
  }
  // Web / dev / embed: route through the tiles Worker, which adds CORS.
  return searchOpenAerialMap({
    bbox,
    page,
    limit: PAGE_SIZE,
    endpoint: OAM_SEARCH_PROXY_ENDPOINT,
    signal,
  });
}

/** Adds an image to the map as a native raster tile layer and zooms to it. */
function addToMap(image: OamImage): void {
  if (!image.tileUrl || !appRef?.addTileLayer || isAdded(image)) return;
  appRef.addTileLayer(image.title || "OpenAerialMap image", image.tileUrl, {
    attribution: ATTRIBUTION,
    ...(image.bbox ? { bounds: image.bbox } : {}),
  });
  if (image.bbox) appRef.fitBounds?.(image.bbox);
}

/** Removes an image's layer from the store, if present. */
function removeFromMap(image: OamImage): void {
  const layerId = findAddedLayerId(image);
  if (layerId) useAppStore.getState().removeLayer(layerId);
}

/** Triggers a browser download of the source GeoTIFF. */
function downloadCog(image: OamImage): void {
  // cogUrl is already http(s)-guarded at normalization; re-check at the point it
  // becomes a clicked href so this security-sensitive line is self-contained.
  if (!image.cogUrl || !HTTP_URL_RE.test(image.cogUrl)) return;
  const link = document.createElement("a");
  link.href = image.cogUrl;
  // Drop any query string (e.g. on a signed S3 URL) from the suggested filename.
  const fileName = image.cogUrl.split("/").pop()?.split("?")[0];
  link.download = fileName || "openaerialmap.tif";
  // A cross-origin `download` hint may be ignored (Content-Disposition wins), so
  // target=_blank keeps a fallback navigation in a new tab rather than replacing
  // the app; the browser downloads the .tif since it cannot render it.
  link.target = "_blank";
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Composes the "provider · date · resolution" subtitle line. */
function subtitle(image: OamImage): string {
  const parts: string[] = [];
  if (image.provider) parts.push(image.provider);
  const date = (image.acquisitionEnd ?? image.acquisitionStart)?.slice(0, 10);
  if (date) parts.push(date);
  if (image.gsd != null) {
    parts.push(
      image.gsd < 1
        ? `${(image.gsd * 100).toFixed(1)} cm/px`
        : `${image.gsd.toFixed(2)} m/px`,
    );
  }
  return parts.join(" · ");
}

/**
 * Builds the search panel DOM. Returns a teardown that invalidates in-flight
 * searches and drops the store subscription.
 */
function buildPanel(container: HTMLElement): () => void {
  container.innerHTML = "";
  container.style.cssText = CSS.panel;

  const searchButton = document.createElement("button");
  searchButton.type = "button";
  searchButton.textContent = labels.search;
  searchButton.style.cssText = CSS.primaryButton;

  const status = document.createElement("div");
  status.style.cssText = CSS.status;
  status.textContent = labels.hint;

  const results = document.createElement("div");
  results.style.cssText = CSS.results;

  const moreButton = document.createElement("button");
  moreButton.type = "button";
  moreButton.textContent = labels.loadMore;
  moreButton.style.cssText = CSS.primaryButton;
  moreButton.hidden = true;

  container.append(searchButton, status, results, moreButton);

  // Panel-local search state.
  let images: OamImage[] = [];
  let found = 0;
  let page = 1;
  let bbox: [number, number, number, number] | null = null;
  // Generation counter to ignore results from a superseded search.
  let generation = 0;
  // Aborts the in-flight request when a newer search supersedes it.
  let inflight: AbortController | null = null;
  // Signature of which listed images are currently on the map; lets the store
  // subscription skip re-rendering when an unrelated part of the store changes.
  let addedSignature = "";

  const setStatus = (text: string, isError = false): void => {
    status.textContent = text;
    status.style.color = isError
      ? "hsl(var(--destructive))"
      : "hsl(var(--muted-foreground))";
  };

  const computeAddedSignature = (): string =>
    images
      .filter((image) => isAdded(image))
      .map((image) => image.id)
      .join(",");

  const renderResults = (): void => {
    results.innerHTML = "";
    for (const image of images) {
      results.appendChild(buildCard(image));
    }
    moreButton.hidden = images.length >= found;
    addedSignature = computeAddedSignature();
  };

  // Keep the Add/Remove state in sync when layers change elsewhere (e.g. the
  // user deletes an OAM layer from the Layers panel).
  const unsubscribe = useAppStore.subscribe(() => {
    if (images.length === 0) return;
    if (computeAddedSignature() !== addedSignature) renderResults();
  });

  const runSearch = async (reset: boolean): Promise<void> => {
    if (reset) {
      bbox = currentBbox();
      page = 1;
      images = [];
      found = 0;
    }
    if (!bbox) {
      // The map isn't ready (e.g. the panel opened before the map mounted), so
      // there's nothing to search. Reflect the now-empty state in the DOM rather
      // than leaving the previous search's cards and Load-more button behind.
      if (reset) {
        results.innerHTML = "";
        moreButton.hidden = true;
        setStatus(labels.hint);
      }
      return;
    }

    // Cancel any earlier request still in flight so it doesn't run to completion
    // against the OAM API / Worker.
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;

    const current = ++generation;
    searchButton.disabled = true;
    moreButton.disabled = true;
    setStatus(reset ? labels.searching : labels.loadingMore);

    try {
      const result = await fetchPage(bbox, page, controller.signal);
      if (current !== generation) return; // superseded
      images = [...images, ...result.images];
      found = result.found;
      page += 1;
      if (images.length === 0) {
        setStatus(labels.noResults);
        results.innerHTML = "";
        moreButton.hidden = true;
      } else {
        setStatus(labels.showing(images.length, found));
        renderResults();
      }
    } catch (error) {
      if (current !== generation) return;
      const message = error instanceof Error ? error.message : "Search failed";
      setStatus(labels.searchError(message), true);
      // Keep any already-loaded results on screen: a failed "Load more" should
      // not wipe a successful initial search or hide the retry button.
      if (images.length === 0) {
        results.innerHTML = "";
        moreButton.hidden = true;
      }
    } finally {
      if (current === generation) {
        searchButton.disabled = false;
        moreButton.disabled = false;
        inflight = null;
      }
    }
  };

  searchButton.addEventListener("click", () => void runSearch(true));
  moreButton.addEventListener("click", () => void runSearch(false));

  return () => {
    // Invalidate any in-flight search so a late result cannot touch detached DOM.
    generation += 1;
    inflight?.abort();
    inflight = null;
    unsubscribe();
  };
}

/**
 * Builds one result card. After an add/remove the list is rebuilt by the store
 * subscription in {@link buildPanel} (zustand notifies listeners synchronously
 * on the `set()` inside add/removeToMap), so the click handler doesn't re-render.
 */
function buildCard(image: OamImage): HTMLElement {
  const card = document.createElement("div");
  card.style.cssText = CSS.card;

  const thumb = document.createElement("div");
  thumb.style.cssText = CSS.thumb;
  if (image.thumbnailUrl) {
    const img = document.createElement("img");
    img.src = image.thumbnailUrl;
    img.alt = image.title;
    img.loading = "lazy";
    img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
    img.addEventListener("error", () => {
      thumb.style.display = "none";
    });
    thumb.appendChild(img);
  } else {
    thumb.style.display = "none";
  }

  const title = document.createElement("div");
  title.style.cssText = CSS.title;
  title.textContent = image.title;
  title.title = image.title;

  const sub = document.createElement("div");
  sub.style.cssText = CSS.sub;
  sub.textContent = subtitle(image);

  const actions = document.createElement("div");
  actions.style.cssText = CSS.actions;

  const added = isAdded(image);
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.textContent = added ? labels.remove : labels.add;
  addButton.style.cssText = added ? CSS.actionActive : CSS.action;
  addButton.disabled = !image.tileUrl;
  addButton.title = !image.tileUrl
    ? labels.addUnavailableTitle
    : added
      ? labels.removeTitle
      : labels.addTitle;
  addButton.addEventListener("click", () => {
    if (isAdded(image)) removeFromMap(image);
    else addToMap(image);
  });

  const zoomButton = document.createElement("button");
  zoomButton.type = "button";
  zoomButton.textContent = labels.zoom;
  zoomButton.style.cssText = CSS.action;
  zoomButton.disabled = !image.bbox;
  zoomButton.title = labels.zoomTitle;
  zoomButton.addEventListener("click", () => {
    if (image.bbox) appRef?.fitBounds?.(image.bbox);
  });

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.textContent = labels.download;
  downloadButton.style.cssText = CSS.action;
  downloadButton.disabled = !image.cogUrl;
  downloadButton.title = labels.downloadTitle;
  downloadButton.addEventListener("click", () => downloadCog(image));

  actions.append(addButton, zoomButton, downloadButton);

  const body = document.createElement("div");
  body.style.cssText = CSS.body;
  body.append(title, sub, actions);

  card.append(thumb, body);
  return card;
}

/** Mounts (or remounts) the panel into a container, replacing any prior build. */
function mountPanel(container: HTMLElement): void {
  disposePanel?.();
  panelContainer = container;
  disposePanel = buildPanel(container);
}

/**
 * Replaces the panel's user-facing strings. The host calls this with
 * translations on activation and every language change; if the panel is open it
 * is rebuilt so the new strings take effect immediately.
 */
export function setOpenAerialMapLabels(next: Partial<OpenAerialMapLabels>): void {
  labels = { ...labels, ...next };
  if (panelContainer) mountPanel(panelContainer);
}

/**
 * OpenAerialMap plugin: searches the OpenAerialMap catalog for openly-licensed
 * imagery over the current map view, then visualizes a result as a raster tile
 * layer, zooms to its footprint, or downloads the source GeoTIFF.
 */
export const maplibreOpenAerialMapPlugin: GeoLibrePlugin = {
  id: OPENAERIALMAP_PLUGIN_ID,
  name: "OpenAerialMap",
  version: "0.1.0",
  activate: (app: GeoLibreAppAPI) => {
    appRef = app;
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: "OpenAerialMap",
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
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    app.closeRightPanel?.(PANEL_ID);
    unregisterPanel?.();
    unregisterPanel = null;
    appRef = null;
  },
};

export default maplibreOpenAerialMapPlugin;
