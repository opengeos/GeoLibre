import { useAppStore } from "@geolibre/core";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import type {
  GeoJSONSource,
  LngLat,
  Map as MapLibreMap,
  MapLayerMouseEvent,
  MapMouseEvent,
} from "maplibre-gl";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  buildSearchUrl,
  footprintFeature,
  HTTP_URL_RE,
  type OamFootprintProps,
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

/** How a search bbox is chosen: the current view, a drawn box, or typed bounds. */
type SearchMode = "view" | "draw" | "bbox";

// Plugin-owned map overlay ids. The footprint fill/line are surfaced in the
// Layers panel as one entry via registerExternalNativeLayer (so the user can
// hide/reorder/restyle/remove them), while the selection outline and the drawn
// search box stay plugin-private overlays that never enter the store.
const FOOTPRINT_SOURCE_ID = "geolibre-oam-footprints";
const FOOTPRINT_FILL_LAYER_ID = "geolibre-oam-footprints-fill";
const FOOTPRINT_LINE_LAYER_ID = "geolibre-oam-footprints-line";
// The Layers-panel entry id (distinct from the map source/layer ids above).
const FOOTPRINT_STORE_LAYER_ID = "geolibre-oam-footprints-layer";
// The selection outline lives in its own source so removing the footprints
// store layer (which drops FOOTPRINT_SOURCE_ID) never leaves a layer pointing at
// a deleted source — MapLibre throws on that.
const SELECT_SOURCE_ID = "geolibre-oam-selected";
const SELECT_LINE_LAYER_ID = "geolibre-oam-selected-line";
const DRAW_SOURCE_ID = "geolibre-oam-draw";
const DRAW_FILL_LAYER_ID = "geolibre-oam-draw-fill";
const DRAW_LINE_LAYER_ID = "geolibre-oam-draw-line";
const FOOTPRINT_COLOR = "#2f6feb";
const HIGHLIGHT_COLOR = "#f5a623";

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
  metadata: string;
  addTitle: string;
  removeTitle: string;
  addUnavailableTitle: string;
  zoomTitle: string;
  downloadTitle: string;
  metadataTitle: string;
  // Search-area modes.
  modeView: string;
  modeDraw: string;
  modeBbox: string;
  drawHint: string;
  drawStart: string;
  drawCancel: string;
  drawnBox: (box: string) => string;
  coordWest: string;
  coordSouth: string;
  coordEast: string;
  coordNorth: string;
  coordSearch: string;
  bboxInvalid: string;
  // Footprint interaction + metadata dialog.
  footprintsLayer: string;
  footprintUnavailable: string;
  metadataHeading: string;
  close: string;
  metaTitle: string;
  metaProvider: string;
  metaPlatform: string;
  metaResolution: string;
  metaAcquired: string;
  metaBounds: string;
  metaSource: string;
  metaRaw: string;
}

/** English defaults, used until the host injects translations. */
export const DEFAULT_OPENAERIALMAP_LABELS: OpenAerialMapLabels = {
  hint: "Search OpenAerialMap imagery by map view, a drawn box, or coordinates.",
  search: "Search this view",
  loadMore: "Load more",
  searching: "Searching…",
  loadingMore: "Loading more…",
  noResults: "No imagery found in this area.",
  showing: (shown, total) => `Showing ${shown} of ${total} images.`,
  searchError: (message) => `Could not reach OpenAerialMap: ${message}. Please try again.`,
  add: "Add",
  remove: "Remove",
  zoom: "Zoom",
  download: "Download",
  metadata: "Metadata",
  addTitle: "Add this image to the map",
  removeTitle: "Remove this image from the map",
  addUnavailableTitle: "No tile service available for this image",
  zoomTitle: "Zoom to this image",
  downloadTitle: "Download the source GeoTIFF",
  metadataTitle: "View this image's metadata",
  modeView: "Map view",
  modeDraw: "Draw box",
  modeBbox: "Coordinates",
  drawHint: "Click and drag on the map to draw a search box.",
  drawStart: "Draw box on map",
  drawCancel: "Cancel drawing",
  drawnBox: (box) => `Search box: ${box}`,
  coordWest: "West",
  coordSouth: "South",
  coordEast: "East",
  coordNorth: "North",
  coordSearch: "Search this box",
  bboxInvalid: "Enter four valid coordinates with west < east and south < north.",
  footprintsLayer: "OpenAerialMap footprints",
  footprintUnavailable: "No tile service available for this image.",
  metadataHeading: "Image metadata",
  close: "Close",
  metaTitle: "Title",
  metaProvider: "Provider",
  metaPlatform: "Platform",
  metaResolution: "Resolution",
  metaAcquired: "Acquired",
  metaBounds: "Bounds (W, S, E, N)",
  metaSource: "Source GeoTIFF",
  metaRaw: "Raw metadata",
};

let labels: OpenAerialMapLabels = { ...DEFAULT_OPENAERIALMAP_LABELS };

// The theme tokens are HSL channel triplets (shadcn convention), so they must be
// wrapped in hsl(); using them bare yields an invalid value that drops the rule.
const CSS = {
  panel:
    "display:flex;flex-direction:column;gap:8px;padding:8px;font-size:12px;" +
    "height:100%;box-sizing:border-box;color:hsl(var(--foreground));",
  modeBar:
    "display:flex;gap:2px;padding:2px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));",
  modeButton:
    "flex:1 1 0;padding:4px 6px;font-size:11px;border-radius:4px;border:none;" +
    "background:transparent;color:hsl(var(--muted-foreground));cursor:pointer;",
  modeButtonActive:
    "flex:1 1 0;padding:4px 6px;font-size:11px;border-radius:4px;border:none;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));" +
    "cursor:pointer;font-weight:600;",
  primaryButton:
    "width:100%;padding:6px 10px;border-radius:6px;border:1px solid hsl(var(--primary));" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));" +
    "font-size:12px;cursor:pointer;",
  secondaryButton:
    "width:100%;padding:6px 10px;border-radius:6px;border:1px solid hsl(var(--border));" +
    "background:hsl(var(--background));color:hsl(var(--foreground));" +
    "font-size:12px;cursor:pointer;",
  coordGrid: "display:grid;grid-template-columns:1fr 1fr;gap:6px;",
  coordField: "display:flex;flex-direction:column;gap:2px;",
  coordLabel: "font-size:10px;color:hsl(var(--muted-foreground));",
  coordInput:
    "width:100%;box-sizing:border-box;padding:4px 6px;font-size:11px;" +
    "border-radius:4px;border:1px solid hsl(var(--border));" +
    "background:hsl(var(--background));color:hsl(var(--foreground));",
  readout: "font-size:10px;color:hsl(var(--muted-foreground));word-break:break-all;",
  status: "font-size:11px;color:hsl(var(--muted-foreground));line-height:1.4;",
  results:
    "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-height:0;" + "overflow-y:auto;",
  card:
    "display:flex;gap:8px;padding:6px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));" +
    "transition:box-shadow 0.15s;",
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
// The panel's handler for a footprint click on the map, set while a panel is
// mounted so the once-bound map listeners can reach the current search state.
let onFootprintSelect: ((id: string) => void) | null = null;
// Whether the footprints Layers-panel entry is currently registered in the
// store. Registration happens once per result set (re-registering would reset
// the user's opacity/colour edits, since a registration owns the keys it sends).
let footprintsRegistered = false;
// Footprint feature per image id, so the selection outline can be redrawn from
// an id without re-querying the results.
const footprintById = new Map<string, Feature<Polygon | MultiPolygon, OamFootprintProps>>();
// Teardown for an open metadata dialog, so the panel/plugin can close it.
let closeMetadataDialog: (() => void) | null = null;

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

/** Formats a bbox as a short, human-readable "W, S, E, N" string. */
function formatBbox(bbox: [number, number, number, number]): string {
  return bbox.map((n) => n.toFixed(3)).join(", ");
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
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
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

/**
 * Adds an image to the map as a native raster tile layer. Fits to its footprint
 * only when `fit` is true — a footprint click on the map should reveal imagery
 * without yanking the view the user is already looking at.
 */
function addToMap(image: OamImage, fit = true): void {
  if (!image.tileUrl || !appRef?.addTileLayer || isAdded(image)) return;
  appRef.addTileLayer(image.title || "OpenAerialMap image", image.tileUrl, {
    attribution: ATTRIBUTION,
    ...(image.bbox ? { bounds: image.bbox } : {}),
  });
  if (fit && image.bbox) appRef.fitBounds?.(image.bbox);
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

/** Formats an image's ground sample distance, e.g. "30.0 cm/px". */
function resolutionText(image: OamImage): string | null {
  if (image.gsd == null) return null;
  return image.gsd < 1 ? `${(image.gsd * 100).toFixed(1)} cm/px` : `${image.gsd.toFixed(2)} m/px`;
}

/** Composes the "provider · date · resolution" subtitle line. */
function subtitle(image: OamImage): string {
  const parts: string[] = [];
  if (image.provider) parts.push(image.provider);
  const date = (image.acquisitionEnd ?? image.acquisitionStart)?.slice(0, 10);
  if (date) parts.push(date);
  const resolution = resolutionText(image);
  if (resolution) parts.push(resolution);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Map overlays: result footprints + the drawn search box
// ---------------------------------------------------------------------------

function emptyCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

/** Whether the style is ready for addSource/addLayer (they throw before that). */
function styleReady(map: MapLibreMap): boolean {
  return map.isStyleLoaded() === true;
}

let footprintHandlersBound = false;

function onFootprintClick(event: MapLayerMouseEvent): void {
  const id = event.features?.[0]?.properties?.id;
  if (typeof id === "string") onFootprintSelect?.(id);
}

function onFootprintEnter(event: MapLayerMouseEvent): void {
  event.target.getCanvas().style.cursor = "pointer";
}

function onFootprintLeave(event: MapLayerMouseEvent): void {
  event.target.getCanvas().style.cursor = "";
}

/** Adds the footprint fill/outline layers + the selection outline once. */
function ensureFootprintLayers(map: MapLibreMap): void {
  if (!styleReady(map)) return;
  if (!map.getSource(FOOTPRINT_SOURCE_ID)) {
    map.addSource(FOOTPRINT_SOURCE_ID, {
      type: "geojson",
      data: emptyCollection(),
    });
  }
  if (!map.getLayer(FOOTPRINT_FILL_LAYER_ID)) {
    map.addLayer({
      id: FOOTPRINT_FILL_LAYER_ID,
      type: "fill",
      source: FOOTPRINT_SOURCE_ID,
      // Very faint so the fill is clickable without hiding the imagery beneath.
      // The store (via the Layers-panel entry) owns the paint after this, so the
      // user's opacity/colour edits take over — these are just the initial look.
      paint: { "fill-color": FOOTPRINT_COLOR, "fill-opacity": 0.08 },
    });
  }
  if (!map.getLayer(FOOTPRINT_LINE_LAYER_ID)) {
    map.addLayer({
      id: FOOTPRINT_LINE_LAYER_ID,
      type: "line",
      source: FOOTPRINT_SOURCE_ID,
      paint: {
        "line-color": FOOTPRINT_COLOR,
        "line-width": 1.5,
        "line-opacity": 0.9,
      },
    });
  }
  // Selection outline: its own source so it survives the footprints store layer
  // being removed (which drops FOOTPRINT_SOURCE_ID). Plugin-private, never in the
  // store, so the store's paint sync never touches it.
  if (!map.getSource(SELECT_SOURCE_ID)) {
    map.addSource(SELECT_SOURCE_ID, { type: "geojson", data: emptyCollection() });
  }
  if (!map.getLayer(SELECT_LINE_LAYER_ID)) {
    map.addLayer({
      id: SELECT_LINE_LAYER_ID,
      type: "line",
      source: SELECT_SOURCE_ID,
      paint: {
        "line-color": HIGHLIGHT_COLOR,
        "line-width": 3,
        "line-opacity": 1,
      },
    });
  }
  if (!footprintHandlersBound) {
    footprintHandlersBound = true;
    map.on("click", FOOTPRINT_FILL_LAYER_ID, onFootprintClick);
    map.on("mouseenter", FOOTPRINT_FILL_LAYER_ID, onFootprintEnter);
    map.on("mouseleave", FOOTPRINT_FILL_LAYER_ID, onFootprintLeave);
  }
}

/**
 * Registers (or updates) the footprints as a first-class Layers-panel entry.
 * The `geojson` is passed every call so the store layer carries the feature
 * data — that is what the attribute table (and export) read. Paint/opacity are
 * seeded only on the first registration so a "Load more" (or any later data
 * refresh) does not clobber the user's opacity/colour edits.
 */
function syncFootprintStoreLayer(
  features: Feature<Polygon | MultiPolygon, OamFootprintProps>[],
): void {
  appRef?.registerExternalNativeLayer?.({
    id: FOOTPRINT_STORE_LAYER_ID,
    name: labels.footprintsLayer,
    type: "geojson",
    nativeLayerIds: [FOOTPRINT_FILL_LAYER_ID, FOOTPRINT_LINE_LAYER_ID],
    sourceIds: [FOOTPRINT_SOURCE_ID],
    geojson: { type: "FeatureCollection", features } as FeatureCollection,
    ...(footprintsRegistered
      ? {}
      : {
          opacity: 1,
          // Seed the faint fill + hairline outline; the Layers/Style panel drives
          // it from here on (opacity slider, colour pickers all apply).
          style: {
            fillColor: FOOTPRINT_COLOR,
            fillOpacity: 0.08,
            strokeColor: FOOTPRINT_COLOR,
            strokeWidth: 1.5,
          },
        }),
  });
  footprintsRegistered = true;
}

/** Removes the footprints Layers-panel entry (dropping its fill/line + source). */
function unregisterFootprintLayer(): void {
  if (!footprintsRegistered) return;
  footprintsRegistered = false;
  appRef?.unregisterExternalNativeLayer?.(FOOTPRINT_STORE_LAYER_ID);
}

/** Renders the footprints for the current result set. */
function setFootprints(map: MapLibreMap, images: OamImage[]): void {
  ensureFootprintLayers(map);
  const source = map.getSource(FOOTPRINT_SOURCE_ID) as GeoJSONSource | undefined;
  if (!source) return;
  footprintById.clear();
  const features: Feature<Polygon | MultiPolygon, OamFootprintProps>[] = [];
  for (const image of images) {
    const feature = footprintFeature(image);
    if (feature) {
      features.push(feature);
      footprintById.set(image.id, feature);
    }
  }
  source.setData({ type: "FeatureCollection", features });
  if (features.length > 0) syncFootprintStoreLayer(features);
  else unregisterFootprintLayer();
}

/** Draws the selection outline around one footprint (or clears it when null). */
function setSelectedFootprint(map: MapLibreMap, id: string | null): void {
  const source = map.getSource(SELECT_SOURCE_ID) as GeoJSONSource | undefined;
  if (!source) return;
  const feature = id ? footprintById.get(id) : undefined;
  source.setData(feature ? { type: "FeatureCollection", features: [feature] } : emptyCollection());
}

/**
 * Removes the footprint overlay: the Layers-panel entry (and its fill/line +
 * source), the selection outline, and the interaction handlers.
 */
function removeFootprintLayers(map: MapLibreMap): void {
  if (footprintHandlersBound) {
    footprintHandlersBound = false;
    map.off("click", FOOTPRINT_FILL_LAYER_ID, onFootprintClick);
    map.off("mouseenter", FOOTPRINT_FILL_LAYER_ID, onFootprintEnter);
    map.off("mouseleave", FOOTPRINT_FILL_LAYER_ID, onFootprintLeave);
  }
  // Drop the Layers-panel entry; the host removes fill/line + FOOTPRINT_SOURCE_ID
  // on the next sync. Also remove them directly so teardown is immediate and safe
  // even if that sync has not run yet (guarded by getLayer/getSource).
  unregisterFootprintLayer();
  for (const layerId of [SELECT_LINE_LAYER_ID, FOOTPRINT_LINE_LAYER_ID, FOOTPRINT_FILL_LAYER_ID]) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  for (const sourceId of [SELECT_SOURCE_ID, FOOTPRINT_SOURCE_ID]) {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  }
  footprintById.clear();
}

/** Builds a rectangle FeatureCollection from a bbox, or empty when null. */
function boxCollection(bbox: [number, number, number, number] | null): FeatureCollection {
  if (!bbox) return emptyCollection();
  const [w, s, e, n] = bbox;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [w, s],
              [e, s],
              [e, n],
              [w, n],
              [w, s],
            ],
          ],
        },
      },
    ],
  };
}

/** Adds the (dashed) drawn-box source + layers once. */
function ensureDrawLayers(map: MapLibreMap): void {
  if (!styleReady(map)) return;
  if (!map.getSource(DRAW_SOURCE_ID)) {
    map.addSource(DRAW_SOURCE_ID, { type: "geojson", data: emptyCollection() });
  }
  if (!map.getLayer(DRAW_FILL_LAYER_ID)) {
    map.addLayer({
      id: DRAW_FILL_LAYER_ID,
      type: "fill",
      source: DRAW_SOURCE_ID,
      paint: { "fill-color": HIGHLIGHT_COLOR, "fill-opacity": 0.1 },
    });
  }
  if (!map.getLayer(DRAW_LINE_LAYER_ID)) {
    map.addLayer({
      id: DRAW_LINE_LAYER_ID,
      type: "line",
      source: DRAW_SOURCE_ID,
      paint: {
        "line-color": HIGHLIGHT_COLOR,
        "line-width": 2,
        "line-dasharray": [2, 1],
      },
    });
  }
}

/** Updates the drawn-box preview (or clears it when bbox is null). */
function setDrawBox(map: MapLibreMap, bbox: [number, number, number, number] | null): void {
  ensureDrawLayers(map);
  const source = map.getSource(DRAW_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData(boxCollection(bbox));
}

/** Removes the drawn-box overlay. */
function removeDrawLayers(map: MapLibreMap): void {
  for (const layerId of [DRAW_LINE_LAYER_ID, DRAW_FILL_LAYER_ID]) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  if (map.getSource(DRAW_SOURCE_ID)) map.removeSource(DRAW_SOURCE_ID);
}

/** Normalizes two drag corners into a [w, s, e, n] bbox. */
function boxFromCorners(a: LngLat, b: LngLat): [number, number, number, number] {
  return [
    Math.min(a.lng, b.lng),
    Math.min(a.lat, b.lat),
    Math.max(a.lng, b.lng),
    Math.max(a.lat, b.lat),
  ];
}

/**
 * Starts a click-and-drag rectangle draw on the map. Pan/box-zoom are disabled
 * for the duration so the drag traces a box instead of moving the map. Returns a
 * cancel function that restores the map interactions and detaches the listeners;
 * it is also called internally once a box is completed.
 */
function startDraw(
  map: MapLibreMap,
  onComplete: (bbox: [number, number, number, number]) => void,
): () => void {
  ensureDrawLayers(map);
  setDrawBox(map, null);
  const canvas = map.getCanvas();
  canvas.style.cursor = "crosshair";
  map.dragPan.disable();
  map.boxZoom.disable();

  let start: LngLat | null = null;
  let done = false;

  const cleanup = (): void => {
    map.off("mousedown", onDown);
    map.off("mousemove", onMove);
    map.off("mouseup", onUp);
    canvas.style.cursor = "";
    map.dragPan.enable();
    map.boxZoom.enable();
  };

  function onDown(event: MapMouseEvent): void {
    start = event.lngLat;
  }
  function onMove(event: MapMouseEvent): void {
    if (start) setDrawBox(map, boxFromCorners(start, event.lngLat));
  }
  function onUp(event: MapMouseEvent): void {
    if (!start || done) return;
    const bbox = boxFromCorners(start, event.lngLat);
    start = null;
    // Ignore a plain click (no drag): a zero-width/height box is not a search
    // area and would otherwise fire an empty search.
    if (bbox[0] === bbox[2] || bbox[1] === bbox[3]) return;
    done = true;
    cleanup();
    setDrawBox(map, bbox);
    onComplete(bbox);
  }

  map.on("mousedown", onDown);
  map.on("mousemove", onMove);
  map.on("mouseup", onUp);
  return cleanup;
}

// ---------------------------------------------------------------------------
// Metadata dialog
// ---------------------------------------------------------------------------

/** Appends a labelled row to a metadata definition list. */
function addMetaRow(list: HTMLElement, label: string, value: string | HTMLElement | null): void {
  if (value == null || value === "") return;
  const row = document.createElement("div");
  row.style.cssText = "display:flex;flex-direction:column;gap:2px;";
  const dt = document.createElement("div");
  dt.style.cssText =
    "font-size:10px;text-transform:uppercase;letter-spacing:0.04em;" +
    "color:hsl(var(--muted-foreground));";
  dt.textContent = label;
  const dd = document.createElement("div");
  dd.style.cssText = "font-size:12px;word-break:break-word;";
  if (typeof value === "string") dd.textContent = value;
  else dd.appendChild(value);
  row.append(dt, dd);
  list.appendChild(row);
}

/**
 * Opens a modal dialog listing an image's metadata (curated fields plus the raw
 * `/meta` record). Rendered into `document.body` so it overlays the whole app;
 * closes on the backdrop, the close button, or Escape. Only one is open at a
 * time — opening another (or closing the panel) dismisses the previous.
 */
function openMetadataModal(image: OamImage): void {
  closeMetadataDialog?.();

  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:2147483000;display:flex;" +
    "align-items:center;justify-content:center;padding:16px;" +
    "background:rgba(0,0,0,0.5);";

  const dialog = document.createElement("div");
  dialog.style.cssText =
    "display:flex;flex-direction:column;width:100%;max-width:520px;" +
    "max-height:80vh;border-radius:8px;overflow:hidden;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));" +
    "color:hsl(var(--foreground));box-shadow:0 10px 40px rgba(0,0,0,0.4);";

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:8px;" +
    "padding:10px 12px;border-bottom:1px solid hsl(var(--border));";
  const heading = document.createElement("div");
  heading.style.cssText = "font-size:13px;font-weight:600;";
  heading.textContent = labels.metadataHeading;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "✕";
  closeButton.title = labels.close;
  closeButton.setAttribute("aria-label", labels.close);
  closeButton.style.cssText =
    "border:none;background:transparent;color:hsl(var(--foreground));" +
    "font-size:14px;cursor:pointer;line-height:1;padding:2px 6px;";
  header.append(heading, closeButton);

  const body = document.createElement("div");
  body.style.cssText =
    "display:flex;flex-direction:column;gap:10px;padding:12px;" + "overflow-y:auto;";

  if (image.thumbnailUrl) {
    const img = document.createElement("img");
    img.src = image.thumbnailUrl;
    img.alt = image.title;
    img.loading = "lazy";
    img.style.cssText = "width:100%;max-height:180px;object-fit:cover;border-radius:6px;";
    img.addEventListener("error", () => img.remove());
    body.appendChild(img);
  }

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:8px;";
  addMetaRow(list, labels.metaTitle, image.title);
  addMetaRow(list, labels.metaProvider, image.provider);
  addMetaRow(list, labels.metaPlatform, image.platform);
  addMetaRow(list, labels.metaResolution, resolutionText(image));
  const acquired = [image.acquisitionStart, image.acquisitionEnd]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.slice(0, 10));
  addMetaRow(
    list,
    labels.metaAcquired,
    acquired.length ? [...new Set(acquired)].join(" – ") : null,
  );
  addMetaRow(list, labels.metaBounds, image.bbox ? formatBbox(image.bbox) : null);
  if (image.cogUrl) {
    const link = document.createElement("a");
    link.href = image.cogUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = image.cogUrl;
    link.style.cssText = "color:hsl(var(--primary));text-decoration:underline;";
    addMetaRow(list, labels.metaSource, link);
  }
  body.appendChild(list);

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = labels.metaRaw;
  summary.style.cssText = "cursor:pointer;font-size:11px;";
  const pre = document.createElement("pre");
  pre.style.cssText =
    "margin:6px 0 0;padding:8px;font-size:10px;line-height:1.4;" +
    "border-radius:6px;overflow:auto;max-height:220px;" +
    "background:hsl(var(--muted));color:hsl(var(--foreground));" +
    "white-space:pre-wrap;word-break:break-word;";
  try {
    pre.textContent = JSON.stringify(image.raw, null, 2);
  } catch {
    pre.textContent = String(image.raw);
  }
  details.append(summary, pre);
  body.appendChild(details);

  dialog.append(header, body);
  overlay.appendChild(dialog);

  const close = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    if (closeMetadataDialog === close) closeMetadataDialog = null;
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  closeButton.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  closeMetadataDialog = close;
}

/**
 * Builds the search panel DOM. Returns a teardown that invalidates in-flight
 * searches, drops the store subscription, and clears the map overlays.
 */
function buildPanel(container: HTMLElement): () => void {
  container.innerHTML = "";
  container.style.cssText = CSS.panel;

  // --- Search-area mode selector --------------------------------------------
  const modeBar = document.createElement("div");
  modeBar.style.cssText = CSS.modeBar;
  const modeButtons: Record<SearchMode, HTMLButtonElement> = {
    view: makeModeButton(labels.modeView),
    draw: makeModeButton(labels.modeDraw),
    bbox: makeModeButton(labels.modeBbox),
  };
  modeBar.append(modeButtons.view, modeButtons.draw, modeButtons.bbox);

  // --- Mode-specific controls -----------------------------------------------
  // View: a single "search this view" button.
  const viewControls = document.createElement("div");
  const searchButton = document.createElement("button");
  searchButton.type = "button";
  searchButton.textContent = labels.search;
  searchButton.style.cssText = CSS.primaryButton;
  viewControls.appendChild(searchButton);

  // Draw: a toggle to start/cancel drawing, plus a readout of the drawn box.
  const drawControls = document.createElement("div");
  drawControls.style.cssText = "display:flex;flex-direction:column;gap:6px;";
  const drawButton = document.createElement("button");
  drawButton.type = "button";
  drawButton.textContent = labels.drawStart;
  drawButton.style.cssText = CSS.secondaryButton;
  const drawReadout = document.createElement("div");
  drawReadout.style.cssText = CSS.readout;
  drawReadout.hidden = true;
  drawControls.append(drawButton, drawReadout);

  // Bbox: four coordinate inputs and a search button.
  const bboxControls = document.createElement("div");
  bboxControls.style.cssText = "display:flex;flex-direction:column;gap:6px;";
  const coordGrid = document.createElement("div");
  coordGrid.style.cssText = CSS.coordGrid;
  const westInput = makeCoordInput(labels.coordWest, coordGrid);
  const southInput = makeCoordInput(labels.coordSouth, coordGrid);
  const eastInput = makeCoordInput(labels.coordEast, coordGrid);
  const northInput = makeCoordInput(labels.coordNorth, coordGrid);
  const bboxSearchButton = document.createElement("button");
  bboxSearchButton.type = "button";
  bboxSearchButton.textContent = labels.coordSearch;
  bboxSearchButton.style.cssText = CSS.primaryButton;
  bboxControls.append(coordGrid, bboxSearchButton);

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

  container.append(modeBar, viewControls, drawControls, bboxControls, status, results, moreButton);

  // Panel-local search state.
  let images: OamImage[] = [];
  let found = 0;
  let page = 1;
  let bbox: [number, number, number, number] | null = null;
  let mode: SearchMode = "view";
  let drawnBbox: [number, number, number, number] | null = null;
  let cancelDraw: (() => void) | null = null;
  let selectedId: string | null = null;
  // Generation counter to ignore results from a superseded search.
  let generation = 0;
  // Aborts the in-flight request when a newer search supersedes it.
  let inflight: AbortController | null = null;
  // Signature of which listed images are currently on the map; lets the store
  // subscription skip re-rendering when an unrelated part of the store changes.
  let addedSignature = "";
  // Card elements by image id, so a footprint click can highlight its card.
  const cardEls = new Map<string, HTMLElement>();

  const setStatus = (text: string, isError = false): void => {
    status.textContent = text;
    status.style.color = isError ? "hsl(var(--destructive))" : "hsl(var(--muted-foreground))";
  };

  const computeAddedSignature = (): string =>
    images
      .filter((image) => isAdded(image))
      .map((image) => image.id)
      .join(",");

  const renderResults = (): void => {
    results.innerHTML = "";
    cardEls.clear();
    for (const image of images) {
      const card = buildCard(image, {
        openMetadata: () => openMetadataModal(image),
        onHover: (hovered) => {
          const map = appRef?.getMap?.();
          if (map) setSelectedFootprint(map, hovered ? image.id : selectedId);
        },
      });
      cardEls.set(image.id, card);
      results.appendChild(card);
    }
    moreButton.hidden = images.length >= found;
    addedSignature = computeAddedSignature();
  };

  const renderFootprints = (): void => {
    const map = appRef?.getMap?.();
    if (map) setFootprints(map, images);
  };

  // Keep the Add/Remove state in sync when layers change elsewhere (e.g. the
  // user deletes an OAM layer from the Layers panel), and tear down our private
  // overlays if the user deletes the footprints layer from the Layers panel.
  const unsubscribe = useAppStore.subscribe(() => {
    if (
      footprintsRegistered &&
      !useAppStore.getState().layers.some((layer) => layer.id === FOOTPRINT_STORE_LAYER_ID)
    ) {
      // The host already dropped the footprint fill/line + source; clear the
      // selection outline we own and reset selection so a later search re-adds a
      // clean layer.
      footprintsRegistered = false;
      footprintById.clear();
      selectedId = null;
      const map = appRef?.getMap?.();
      if (map) {
        if (map.getLayer(SELECT_LINE_LAYER_ID)) map.removeLayer(SELECT_LINE_LAYER_ID);
        if (map.getSource(SELECT_SOURCE_ID)) map.removeSource(SELECT_SOURCE_ID);
      }
    }
    if (images.length === 0) return;
    if (computeAddedSignature() !== addedSignature) renderResults();
  });

  // A footprint click on the map: visualize the image (without moving the view)
  // and highlight both its outline and its card in the list.
  onFootprintSelect = (id: string): void => {
    const image = images.find((candidate) => candidate.id === id);
    if (!image) return;
    selectedId = id;
    const map = appRef?.getMap?.();
    if (map) setSelectedFootprint(map, id);
    const card = cardEls.get(id);
    if (card) {
      card.scrollIntoView({ block: "nearest" });
      card.style.boxShadow = `0 0 0 2px ${HIGHLIGHT_COLOR}`;
      window.setTimeout(() => {
        card.style.boxShadow = "";
      }, 1200);
    }
    if (!image.tileUrl) {
      setStatus(labels.footprintUnavailable, true);
      return;
    }
    if (!isAdded(image)) addToMap(image, false);
  };

  const runSearch = async (
    reset: boolean,
    nextBbox?: [number, number, number, number] | null,
  ): Promise<void> => {
    if (reset) {
      bbox = nextBbox !== undefined ? nextBbox : currentBbox();
      page = 1;
      images = [];
      found = 0;
      selectedId = null;
    }
    if (!bbox) {
      // No searchable area (the map isn't ready, or the typed bounds were
      // invalid). Reflect the now-empty state rather than leaving stale cards.
      if (reset) {
        results.innerHTML = "";
        cardEls.clear();
        moreButton.hidden = true;
        const map = appRef?.getMap?.();
        if (map) setFootprints(map, []);
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
    setControlsDisabled(true);
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
        cardEls.clear();
        moreButton.hidden = true;
      } else {
        setStatus(labels.showing(images.length, found));
        renderResults();
      }
      renderFootprints();
    } catch (error) {
      if (current !== generation) return;
      const message = error instanceof Error ? error.message : "Search failed";
      setStatus(labels.searchError(message), true);
      // Keep any already-loaded results on screen: a failed "Load more" should
      // not wipe a successful initial search or hide the retry button.
      if (images.length === 0) {
        results.innerHTML = "";
        cardEls.clear();
        moreButton.hidden = true;
      }
    } finally {
      if (current === generation) {
        setControlsDisabled(false);
        inflight = null;
      }
    }
  };

  function setControlsDisabled(disabled: boolean): void {
    searchButton.disabled = disabled;
    bboxSearchButton.disabled = disabled;
    moreButton.disabled = disabled;
  }

  // Reads the four inputs into a valid bbox, or null when malformed / inverted.
  const readCoordBbox = (): [number, number, number, number] | null => {
    const west = Number(westInput.value);
    const south = Number(southInput.value);
    const east = Number(eastInput.value);
    const north = Number(northInput.value);
    if (![west, south, east, north].every(Number.isFinite)) return null;
    if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
      return null;
    }
    return [west, south, east, north];
  };

  const stopDrawing = (): void => {
    cancelDraw?.();
    cancelDraw = null;
    drawButton.textContent = labels.drawStart;
  };

  const showMode = (next: SearchMode): void => {
    if (next !== "draw") stopDrawing();
    mode = next;
    for (const key of ["view", "draw", "bbox"] as SearchMode[]) {
      modeButtons[key].style.cssText = key === next ? CSS.modeButtonActive : CSS.modeButton;
    }
    viewControls.hidden = next !== "view";
    drawControls.hidden = next !== "draw";
    bboxControls.hidden = next !== "bbox";
    if (next === "draw") {
      setStatus(labels.drawHint);
      // Prefill the coordinate inputs / readout from any prior drawn box.
      if (drawnBbox) drawReadout.textContent = labels.drawnBox(formatBbox(drawnBbox));
    } else if (next === "bbox") {
      setStatus(labels.hint);
    } else {
      setStatus(images.length ? labels.showing(images.length, found) : labels.hint);
    }
  };

  modeButtons.view.addEventListener("click", () => showMode("view"));
  modeButtons.draw.addEventListener("click", () => showMode("draw"));
  modeButtons.bbox.addEventListener("click", () => showMode("bbox"));

  searchButton.addEventListener("click", () => void runSearch(true));
  moreButton.addEventListener("click", () => void runSearch(false));

  bboxSearchButton.addEventListener("click", () => {
    const parsed = readCoordBbox();
    if (!parsed) {
      setStatus(labels.bboxInvalid, true);
      return;
    }
    const map = appRef?.getMap?.();
    if (map) setDrawBox(map, parsed); // reuse the box preview for typed bounds
    void runSearch(true, parsed);
  });

  drawButton.addEventListener("click", () => {
    const map = appRef?.getMap?.();
    if (!map) return;
    if (cancelDraw) {
      stopDrawing();
      setStatus(labels.hint);
      return;
    }
    setStatus(labels.drawHint);
    drawButton.textContent = labels.drawCancel;
    cancelDraw = startDraw(map, (drawn) => {
      cancelDraw = null;
      drawButton.textContent = labels.drawStart;
      drawnBbox = drawn;
      drawReadout.hidden = false;
      drawReadout.textContent = labels.drawnBox(formatBbox(drawn));
      // Mirror the drawn bounds into the coordinate inputs so the user can nudge
      // them and re-search from the Coordinates tab.
      [westInput.value, southInput.value, eastInput.value, northInput.value] = drawn.map((n) =>
        n.toFixed(5),
      );
      void runSearch(true, drawn);
    });
  });

  showMode("view");

  return () => {
    // Invalidate any in-flight search so a late result cannot touch detached DOM.
    generation += 1;
    inflight?.abort();
    inflight = null;
    stopDrawing();
    closeMetadataDialog?.();
    if (onFootprintSelect) onFootprintSelect = null;
    const map = appRef?.getMap?.();
    if (map) {
      removeFootprintLayers(map);
      removeDrawLayers(map);
    }
    unsubscribe();
  };
}

/** Creates a segmented-control button for the mode selector. */
function makeModeButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.style.cssText = CSS.modeButton;
  return button;
}

/** Creates a labelled numeric coordinate input, appended to `grid`. */
function makeCoordInput(label: string, grid: HTMLElement): HTMLInputElement {
  const field = document.createElement("label");
  field.style.cssText = CSS.coordField;
  const caption = document.createElement("span");
  caption.style.cssText = CSS.coordLabel;
  caption.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.style.cssText = CSS.coordInput;
  field.append(caption, input);
  grid.appendChild(field);
  return input;
}

/**
 * Builds one result card. After an add/remove the list is rebuilt by the store
 * subscription in {@link buildPanel} (zustand notifies listeners synchronously
 * on the `set()` inside add/removeToMap), so the click handler doesn't re-render.
 */
function buildCard(
  image: OamImage,
  handlers: { openMetadata: () => void; onHover: (hovered: boolean) => void },
): HTMLElement {
  const card = document.createElement("div");
  card.style.cssText = CSS.card;
  card.addEventListener("mouseenter", () => handlers.onHover(true));
  card.addEventListener("mouseleave", () => handlers.onHover(false));

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

  const metadataButton = document.createElement("button");
  metadataButton.type = "button";
  metadataButton.textContent = labels.metadata;
  metadataButton.style.cssText = CSS.action;
  metadataButton.title = labels.metadataTitle;
  metadataButton.addEventListener("click", handlers.openMetadata);

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

  // Metadata sits before Add, as requested, so details are one click from view.
  actions.append(metadataButton, addButton, zoomButton, downloadButton);

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
 * imagery over the map view, a drawn box, or typed coordinates; previews the
 * result footprints on the map; and visualizes a result as a raster tile layer,
 * zooms to its footprint, inspects its metadata, or downloads the source
 * GeoTIFF.
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
    // Safety net: drop the footprints Layers-panel entry and map overlays even
    // if the panel's own cleanup did not run (or ran after appRef was cleared).
    const map = app.getMap?.();
    if (map) {
      removeFootprintLayers(map);
      removeDrawLayers(map);
    }
    appRef = null;
  },
};

export default maplibreOpenAerialMapPlugin;
