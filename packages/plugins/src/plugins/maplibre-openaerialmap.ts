import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  buildSearchUrl,
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
// Visualized images: OAM image id -> store layer id. Persists across the panel
// being closed/reopened so the Add/Remove state survives.
const addedLayers = new Map<string, string>();

/** Whether an image's layer is currently present in the store. */
function isAdded(image: OamImage): boolean {
  const layerId = addedLayers.get(image.id);
  if (!layerId) return false;
  const exists = useAppStore
    .getState()
    .layers.some((layer) => layer.id === layerId);
  if (!exists) {
    addedLayers.delete(image.id);
    return false;
  }
  return true;
}

/** Reads the current map view as a clamped [w, s, e, n] bbox. */
function currentBbox(): [number, number, number, number] | null {
  const map = appRef?.getMap?.();
  if (!map) return null;
  const bounds = map.getBounds();
  const clampLon = (n: number): number => Math.max(-180, Math.min(180, n));
  const clampLat = (n: number): number => Math.max(-90, Math.min(90, n));
  return [
    clampLon(bounds.getWest()),
    clampLat(bounds.getSouth()),
    clampLon(bounds.getEast()),
    clampLat(bounds.getNorth()),
  ];
}

/**
 * Fetches a page of results. On desktop this routes through the host's native
 * (CORS-bypassing) fetch; otherwise it falls back to a direct request, which
 * the OAM metadata API's origin-locked CORS may block on the web build.
 */
async function fetchPage(
  bbox: [number, number, number, number],
  page: number,
): Promise<OamSearchResult> {
  // Desktop (Tauri): fetch the OAM API directly through the host's native
  // HTTP, which bypasses browser CORS and keeps the query on-device.
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
  });
}

/** Adds an image to the map as a native raster tile layer and zooms to it. */
function addToMap(image: OamImage): void {
  if (!image.tileUrl || !appRef?.addTileLayer) return;
  const layerId = appRef.addTileLayer(image.title || "OpenAerialMap image", image.tileUrl, {
    attribution: ATTRIBUTION,
    ...(image.bbox ? { bounds: image.bbox } : {}),
  });
  addedLayers.set(image.id, layerId);
  if (image.bbox) appRef.fitBounds?.(image.bbox);
}

/** Removes an image's layer from the store. */
function removeFromMap(image: OamImage): void {
  const layerId = addedLayers.get(image.id);
  if (!layerId) return;
  useAppStore.getState().removeLayer(layerId);
  addedLayers.delete(image.id);
}

/** Triggers a browser download of the source GeoTIFF. */
function downloadCog(image: OamImage): void {
  if (!image.cogUrl) return;
  const link = document.createElement("a");
  link.href = image.cogUrl;
  link.download = image.cogUrl.split("/").pop() ?? "openaerialmap.tif";
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
 * Builds the search panel DOM. Returns a cleanup function that the host calls
 * when the panel closes.
 */
function buildPanel(container: HTMLElement): () => void {
  container.innerHTML = "";
  container.style.cssText = CSS.panel;

  const searchButton = document.createElement("button");
  searchButton.type = "button";
  searchButton.textContent = "Search this view";
  searchButton.style.cssText = CSS.primaryButton;

  const status = document.createElement("div");
  status.style.cssText = CSS.status;
  status.textContent = "Search the current map view for OpenAerialMap imagery.";

  const results = document.createElement("div");
  results.style.cssText = CSS.results;

  const moreButton = document.createElement("button");
  moreButton.type = "button";
  moreButton.textContent = "Load more";
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

  const setStatus = (text: string, isError = false): void => {
    status.textContent = text;
    status.style.color = isError
      ? "hsl(var(--destructive))"
      : "hsl(var(--muted-foreground))";
  };

  const renderResults = (): void => {
    results.innerHTML = "";
    for (const image of images) results.appendChild(buildCard(image, renderResults));
    moreButton.hidden = images.length >= found;
  };

  const runSearch = async (reset: boolean): Promise<void> => {
    if (reset) {
      bbox = currentBbox();
      page = 1;
      images = [];
      found = 0;
    }
    if (!bbox) return;

    const current = ++generation;
    searchButton.disabled = true;
    moreButton.disabled = true;
    setStatus(reset ? "Searching…" : "Loading more…");

    try {
      const result = await fetchPage(bbox, page);
      if (current !== generation) return; // superseded
      images = images.concat(result.images);
      found = result.found;
      page += 1;
      if (images.length === 0) {
        setStatus("No imagery found in this view.");
        results.innerHTML = "";
        moreButton.hidden = true;
      } else {
        setStatus(`Showing ${images.length} of ${found} images.`);
        renderResults();
      }
    } catch (error) {
      if (current !== generation) return;
      const message = error instanceof Error ? error.message : "Search failed";
      setStatus(
        `Could not reach OpenAerialMap: ${message}. The catalog API may be blocked by CORS in this environment.`,
        true,
      );
      results.innerHTML = "";
      moreButton.hidden = true;
    } finally {
      if (current === generation) {
        searchButton.disabled = false;
        moreButton.disabled = false;
      }
    }
  };

  searchButton.addEventListener("click", () => void runSearch(true));
  moreButton.addEventListener("click", () => void runSearch(false));

  return () => {
    // Invalidate any in-flight search so a late result cannot touch detached DOM.
    generation += 1;
  };
}

/** Builds one result card. `rerender` refreshes the list after an add/remove. */
function buildCard(image: OamImage, rerender: () => void): HTMLElement {
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
  addButton.textContent = added ? "Remove" : "Add";
  addButton.style.cssText = added ? CSS.actionActive : CSS.action;
  addButton.disabled = !image.tileUrl;
  addButton.title = image.tileUrl
    ? "Add this image to the map"
    : "No tile service available for this image";
  addButton.addEventListener("click", () => {
    if (isAdded(image)) removeFromMap(image);
    else addToMap(image);
    rerender();
  });

  const zoomButton = document.createElement("button");
  zoomButton.type = "button";
  zoomButton.textContent = "Zoom";
  zoomButton.style.cssText = CSS.action;
  zoomButton.disabled = !image.bbox;
  zoomButton.title = "Zoom to this image";
  zoomButton.addEventListener("click", () => {
    if (image.bbox) appRef?.fitBounds?.(image.bbox);
  });

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.textContent = "Download";
  downloadButton.style.cssText = CSS.action;
  downloadButton.disabled = !image.cogUrl;
  downloadButton.title = "Download the source GeoTIFF";
  downloadButton.addEventListener("click", () => downloadCog(image));

  actions.append(addButton, zoomButton, downloadButton);

  const body = document.createElement("div");
  body.style.cssText = CSS.body;
  body.append(title, sub, actions);

  card.append(thumb, body);
  return card;
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
        render: (container) => buildPanel(container),
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
