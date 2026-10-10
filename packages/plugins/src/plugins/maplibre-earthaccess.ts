import { useAppStore } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent } from "maplibre-gl";
import { createPluginTranslator, pluginDisplayTitle } from "../plugin-i18n";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  type Bbox,
  EARTHDATA_PRESETS,
  EARTHDATA_TOKEN_PAGE_URL,
  earthdataProxyUrl,
  isEarthdataDataUrl,
  isEarthdataProxyUrl,
  type EarthdataCollection,
  type EarthdataGranule,
  earthdataTokenExpiry,
  fileNameFromUrl,
  formatSizeMb,
  granuleDetailsUrl,
  granuleFootprints,
  isSpaceborneLidarGranule,
  newestCollection,
  primaryDataLink,
  requestEarthdataToken,
  searchEarthdataCollections,
  searchEarthdataGranules,
} from "./earthaccess-api";
import { getControlMap } from "./style-map";

export const EARTHACCESS_PLUGIN_ID = "geolibre-earthaccess";
const PLUGIN_NAME = "NASA Earthaccess";
const PANEL_ID = EARTHACCESS_PLUGIN_ID;
/** `app.credentials` name of the Earthdata Login bearer token. */
const TOKEN_CREDENTIAL = "earthdataToken";
const GRANULE_PAGE_SIZE = 25;
const COLLECTION_PAGE_SIZE = 20;

// Plugin-owned overlays. The footprints are surfaced in the Layers panel as one
// entry; the selection outline stays private to the plugin.
const FOOTPRINT_SOURCE_ID = "geolibre-earthaccess-footprints";
const FOOTPRINT_FILL_LAYER_ID = "geolibre-earthaccess-footprints-fill";
const FOOTPRINT_LINE_LAYER_ID = "geolibre-earthaccess-footprints-line";
const FOOTPRINT_STORE_LAYER_ID = "geolibre-earthaccess-footprints-layer";
const FOOTPRINT_SOURCE_KIND = "earthaccess-footprints";
const SELECT_SOURCE_ID = "geolibre-earthaccess-selected";
const SELECT_LINE_LAYER_ID = "geolibre-earthaccess-selected-line";
const FOOTPRINT_COLOR = "#0b7285";
const HIGHLIGHT_COLOR = "#f5a623";

const CSS = {
  panel:
    "display:flex;flex-direction:column;gap:8px;padding:8px;font-size:12px;" +
    "height:100%;box-sizing:border-box;color:hsl(var(--foreground));overflow-y:auto;",
  section:
    "display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));",
  heading: "font-size:12px;font-weight:600;margin:0;",
  summary: "font-size:12px;font-weight:600;cursor:pointer;",
  row: "display:flex;gap:6px;align-items:center;",
  grid: "display:grid;grid-template-columns:1fr 1fr;gap:6px;",
  label:
    "display:flex;flex-direction:column;gap:2px;font-size:10px;color:hsl(var(--muted-foreground));",
  input:
    "width:100%;box-sizing:border-box;padding:4px 6px;font-size:12px;" +
    "border-radius:4px;border:1px solid hsl(var(--border));" +
    "background:hsl(var(--background));color:hsl(var(--foreground));",
  primaryButton:
    "padding:5px 10px;border-radius:6px;border:1px solid hsl(var(--primary));" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));" +
    "font-size:12px;cursor:pointer;white-space:nowrap;",
  secondaryButton:
    "padding:5px 10px;border-radius:6px;border:1px solid hsl(var(--border));" +
    "background:hsl(var(--background));color:hsl(var(--foreground));" +
    "font-size:12px;cursor:pointer;white-space:nowrap;",
  hint: "font-size:11px;color:hsl(var(--muted-foreground));line-height:1.4;margin:0;",
  error: "font-size:11px;color:hsl(var(--destructive));line-height:1.4;margin:0;",
  link: "color:hsl(var(--primary));text-decoration:underline;cursor:pointer;",
  list: "display:flex;flex-direction:column;gap:4px;max-height:220px;overflow-y:auto;",
  option:
    "display:flex;flex-direction:column;gap:2px;padding:6px;border-radius:4px;text-align:start;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));" +
    "color:hsl(var(--foreground));cursor:pointer;font-size:11px;",
  chip:
    "display:flex;flex-direction:column;gap:2px;padding:6px;border-radius:4px;" +
    "background:hsl(var(--muted));font-size:11px;",
  results: "display:flex;flex-direction:column;gap:6px;",
  card:
    "display:flex;flex-direction:column;gap:4px;padding:6px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));",
  cardSelected:
    "display:flex;flex-direction:column;gap:4px;padding:6px;border-radius:6px;" +
    `border:1px solid ${HIGHLIGHT_COLOR};background:hsl(var(--muted));`,
  title:
    "font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
  sub: "font-size:10px;color:hsl(var(--muted-foreground));",
  actions: "display:flex;gap:4px;flex-wrap:wrap;",
  action:
    "padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));" +
    "color:hsl(var(--foreground));",
  files: "display:flex;flex-direction:column;gap:2px;font-size:11px;",
  filesSummary: "cursor:pointer;font-size:11px;color:hsl(var(--muted-foreground));",
  fileRow: "display:flex;gap:4px;align-items:center;",
  fileName:
    "flex:1 1 auto;min-width:0;font-size:11px;white-space:nowrap;overflow:hidden;" +
    "text-overflow:ellipsis;",
  actionPrimary:
    "padding:2px 8px;font-size:11px;border-radius:4px;cursor:pointer;" +
    "border:1px solid hsl(var(--primary));background:hsl(var(--primary));" +
    "color:hsl(var(--primary-foreground));",
} as const;

/** A download in flight or finished for one granule. */
interface TransferState {
  kind: "open" | "save" | "all";
  /** 0-100, or null while the size is unknown. */
  percent: number | null;
  received: number;
  /** Which file of a multi-file download is in flight (0-based). */
  fileIndex: number;
  fileCount: number;
  error: string | null;
  done: string | null;
  controller: AbortController | null;
}

/** Panel state, at module scope so a rebuild (a language change) keeps it. */
interface PanelState {
  keyword: string;
  collections: EarthdataCollection[] | null;
  collectionHits: number;
  collectionError: string | null;
  collection: EarthdataCollection | null;
  start: string;
  end: string;
  granules: EarthdataGranule[];
  granuleHits: number;
  granulePage: number;
  searched: boolean;
  searching: boolean;
  granuleError: string | null;
  bbox: Bbox | null;
  /** The date range of the current search, frozen for its later pages. */
  temporal: [string, string] | null;
  selectedId: string | null;
  transfers: Map<string, TransferState>;
  authOpen: boolean;
  authError: string | null;
  /** Granules whose file list is expanded, kept across re-renders. */
  openFileLists: Set<string>;
  /** COG URLs being added to the map. */
  addingCog: Set<string>;
  /** Errors from adding a COG, shown under the dataset. */
  cogError: string | null;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function initialState(): PanelState {
  const end = new Date();
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  return {
    keyword: "",
    collections: null,
    collectionHits: 0,
    collectionError: null,
    collection: null,
    start: isoDate(start),
    end: isoDate(end),
    granules: [],
    granuleHits: 0,
    granulePage: 1,
    searched: false,
    searching: false,
    granuleError: null,
    bbox: null,
    temporal: null,
    selectedId: null,
    transfers: new Map(),
    authOpen: false,
    authError: null,
    openFileLists: new Set(),
    addingCog: new Set(),
    cogError: null,
  };
}

let state: PanelState = initialState();
let appRef: GeoLibreAppAPI | null = null;
let unregisterPanel: (() => void) | null = null;
let unsubscribeLocale: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;
let disposePanel: (() => void) | null = null;
/** Re-renders the mounted panel, if any. */
let renderPanel: (() => void) | null = null;
let footprintsRegistered = false;
let footprintHandlersBound = false;
/** Bumped by every granule search so a superseded response is dropped. */
let searchGeneration = 0;

const tr = createPluginTranslator(() => appRef, EARTHACCESS_PLUGIN_ID);

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style?: string,
  content?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (content !== undefined) node.textContent = content;
  return node;
}

function button(
  label: string,
  style: string,
  onClick: () => void,
  title?: string,
): HTMLButtonElement {
  const node = element("button", style, label);
  node.type = "button";
  if (title) node.title = title;
  node.addEventListener("click", onClick);
  return node;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function token(): string {
  return appRef?.credentials?.get(TOKEN_CREDENTIAL) ?? "";
}

/**
 * The Authorization header for a file URL: only NASA Earthdata hosts get the
 * token, since CMR data links are chosen by each provider.
 */
function authHeaders(url: string): Record<string, string> {
  const value = token();
  return value && isEarthdataDataUrl(url) ? { Authorization: `Bearer ${value}` } : {};
}

function openExternal(url: string): void {
  if (appRef?.openExternalUrl) appRef.openExternalUrl(url);
  else window.open(url, "_blank", "noopener");
}

/** The current view as a CMR bbox; the whole world when it wraps the antimeridian. */
function viewBbox(): Bbox | null {
  const bounds = appRef?.getViewBounds?.();
  if (!bounds) return null;
  const [west, south, east, north] = bounds;
  if (east - west >= 360 || west < -180 || east > 180 || west > east) {
    return [-180, Math.max(-90, south), 180, Math.min(90, north)];
  }
  return [west, Math.max(-90, south), east, Math.min(90, north)];
}

// ---------------------------------------------------------------------------
// Footprints
// ---------------------------------------------------------------------------

function emptyCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function onFootprintClick(event: MapLayerMouseEvent): void {
  const id = event.features?.[0]?.properties?.id;
  if (typeof id !== "string") return;
  selectGranule(id, false);
}

function onFootprintEnter(event: MapLayerMouseEvent): void {
  event.target.getCanvas().style.cursor = "pointer";
}

function onFootprintLeave(event: MapLayerMouseEvent): void {
  event.target.getCanvas().style.cursor = "";
}

function ensureFootprintLayers(map: MapLibreMap): void {
  if (map.isStyleLoaded() !== true) return;
  if (!map.getSource(FOOTPRINT_SOURCE_ID)) {
    map.addSource(FOOTPRINT_SOURCE_ID, { type: "geojson", data: emptyCollection() });
  }
  if (!map.getLayer(FOOTPRINT_FILL_LAYER_ID)) {
    map.addLayer({
      id: FOOTPRINT_FILL_LAYER_ID,
      type: "fill",
      source: FOOTPRINT_SOURCE_ID,
      filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
      paint: { "fill-color": FOOTPRINT_COLOR, "fill-opacity": 0.12 },
    });
  }
  if (!map.getLayer(FOOTPRINT_LINE_LAYER_ID)) {
    map.addLayer({
      id: FOOTPRINT_LINE_LAYER_ID,
      type: "line",
      source: FOOTPRINT_SOURCE_ID,
      paint: { "line-color": FOOTPRINT_COLOR, "line-width": 1.5, "line-opacity": 0.9 },
    });
  }
  if (!map.getSource(SELECT_SOURCE_ID)) {
    map.addSource(SELECT_SOURCE_ID, { type: "geojson", data: emptyCollection() });
  }
  if (!map.getLayer(SELECT_LINE_LAYER_ID)) {
    map.addLayer({
      id: SELECT_LINE_LAYER_ID,
      type: "line",
      source: SELECT_SOURCE_ID,
      paint: { "line-color": HIGHLIGHT_COLOR, "line-width": 3 },
    });
  }
  if (!footprintHandlersBound) {
    footprintHandlersBound = true;
    for (const layerId of [FOOTPRINT_FILL_LAYER_ID, FOOTPRINT_LINE_LAYER_ID]) {
      map.on("click", layerId, onFootprintClick);
      map.on("mouseenter", layerId, onFootprintEnter);
      map.on("mouseleave", layerId, onFootprintLeave);
    }
  }
}

function setFootprints(): void {
  const map = getControlMap(appRef);
  if (!map) return;
  ensureFootprintLayers(map);
  const source = map.getSource(FOOTPRINT_SOURCE_ID) as GeoJSONSource | undefined;
  if (!source) return;
  const collection = granuleFootprints(state.granules);
  void source.setData(collection);
  if (collection.features.length === 0) {
    unregisterFootprintLayer();
    return;
  }
  appRef?.registerExternalNativeLayer?.({
    id: FOOTPRINT_STORE_LAYER_ID,
    name: tr("footprintsLayer", "Earthdata granule footprints"),
    type: "geojson",
    nativeLayerIds: [FOOTPRINT_FILL_LAYER_ID, FOOTPRINT_LINE_LAYER_ID],
    sourceIds: [FOOTPRINT_SOURCE_ID],
    geojson: collection as FeatureCollection,
    metadata: { sourceKind: FOOTPRINT_SOURCE_KIND },
    ...(footprintsRegistered
      ? {}
      : {
          opacity: 1,
          style: {
            fillColor: FOOTPRINT_COLOR,
            fillOpacity: 0.12,
            strokeColor: FOOTPRINT_COLOR,
            strokeWidth: 1.5,
          },
        }),
  });
  footprintsRegistered = true;
  setSelectedFootprint();
}

function setSelectedFootprint(): void {
  const map = getControlMap(appRef);
  const source = map?.getSource(SELECT_SOURCE_ID) as GeoJSONSource | undefined;
  if (!source) return;
  const granule = state.granules.find((g) => g.conceptId === state.selectedId);
  void source.setData(
    granule ? granuleFootprints([granule]) : (emptyCollection() as FeatureCollection),
  );
}

function unregisterFootprintLayer(): void {
  if (!footprintsRegistered) return;
  footprintsRegistered = false;
  appRef?.unregisterExternalNativeLayer?.(FOOTPRINT_STORE_LAYER_ID);
}

function removeFootprintLayers(map: MapLibreMap | null): void {
  unregisterFootprintLayer();
  if (!map) return;
  if (footprintHandlersBound) {
    footprintHandlersBound = false;
    for (const layerId of [FOOTPRINT_FILL_LAYER_ID, FOOTPRINT_LINE_LAYER_ID]) {
      map.off("click", layerId, onFootprintClick);
      map.off("mouseenter", layerId, onFootprintEnter);
      map.off("mouseleave", layerId, onFootprintLeave);
    }
  }
  for (const layerId of [SELECT_LINE_LAYER_ID, FOOTPRINT_LINE_LAYER_ID, FOOTPRINT_FILL_LAYER_ID]) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  for (const sourceId of [SELECT_SOURCE_ID, FOOTPRINT_SOURCE_ID]) {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  }
}

/** Bounding box of a granule footprint, for Zoom. */
function granuleBounds(granule: EarthdataGranule): Bbox | null {
  const geometry = granule.geometry;
  if (!geometry || geometry.type === "GeometryCollection") return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      west = Math.min(west, value[0]);
      east = Math.max(east, value[0]);
      south = Math.min(south, value[1]);
      north = Math.max(north, value[1]);
      return;
    }
    for (const item of value) visit(item);
  };
  visit(geometry.coordinates);
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

function selectGranule(id: string, zoom: boolean): void {
  state.selectedId = id;
  setSelectedFootprint();
  const granule = state.granules.find((g) => g.conceptId === id);
  if (zoom && granule) {
    const bounds = granuleBounds(granule);
    if (bounds) appRef?.fitBounds?.(bounds);
  }
  renderPanel?.();
  panelContainer
    ?.querySelector(`[data-granule-id="${CSS_ESCAPE(id)}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

/** `CSS.escape` where available (not in every test DOM). */
function CSS_ESCAPE(value: string): string {
  return typeof globalThis.CSS?.escape === "function"
    ? globalThis.CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function searchCollections(): Promise<void> {
  state.collectionError = null;
  const keyword = state.keyword.trim();
  if (!keyword) return;
  try {
    const page = await searchEarthdataCollections({
      keyword,
      pageSize: COLLECTION_PAGE_SIZE,
    });
    state.collections = page.items;
    state.collectionHits = page.hits;
  } catch (error) {
    state.collections = null;
    state.collectionError = tr("collectionSearchFailed", "Dataset search failed: {{message}}", {
      message: errorMessage(error),
    });
  }
  renderPanel?.();
}

async function choosePreset(shortName: string): Promise<void> {
  state.collectionError = null;
  try {
    const page = await searchEarthdataCollections({ shortName, pageSize: COLLECTION_PAGE_SIZE });
    const collection = newestCollection(page.items);
    if (!collection)
      throw new Error(tr("presetMissing", "CMR has no dataset {{name}}.", { name: shortName }));
    chooseCollection(collection);
  } catch (error) {
    state.collectionError = tr("collectionSearchFailed", "Dataset search failed: {{message}}", {
      message: errorMessage(error),
    });
    renderPanel?.();
  }
}

function chooseCollection(collection: EarthdataCollection): void {
  state.collection = collection;
  state.collections = null;
  clearGranules();
  renderPanel?.();
}

function clearGranules(): void {
  searchGeneration += 1;
  for (const transfer of state.transfers.values()) transfer.controller?.abort();
  state.transfers.clear();
  state.granules = [];
  state.granuleHits = 0;
  state.granulePage = 1;
  state.searched = false;
  state.searching = false;
  state.granuleError = null;
  state.selectedId = null;
  setFootprints();
}

async function searchGranules(more: boolean): Promise<void> {
  const collection = state.collection;
  if (!collection) return;
  if (!more) {
    clearGranules();
    state.bbox = viewBbox();
    // "Load more" pages the same query, even if the dates were edited since.
    state.temporal = [state.start, state.end];
  }
  const generation = ++searchGeneration;
  state.searching = true;
  state.granuleError = null;
  renderPanel?.();
  const pageNum = more ? state.granulePage + 1 : 1;
  try {
    const page = await searchEarthdataGranules({
      collectionConceptId: collection.conceptId,
      bbox: state.bbox,
      temporal: state.temporal,
      pageSize: GRANULE_PAGE_SIZE,
      pageNum,
    });
    if (generation !== searchGeneration) return;
    state.granules = more ? [...state.granules, ...page.items] : page.items;
    state.granuleHits = page.hits;
    state.granulePage = pageNum;
    state.searched = true;
    setFootprints();
  } catch (error) {
    if (generation !== searchGeneration) return;
    state.granuleError = tr("granuleSearchFailed", "Granule search failed: {{message}}", {
      message: errorMessage(error),
    });
  } finally {
    if (generation === searchGeneration) {
      state.searching = false;
      renderPanel?.();
    }
  }
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

/** Fetch through the tiles Worker (browser builds), with progress. */
async function proxyDownload(
  url: string,
  signal: AbortSignal,
  onProgress: (received: number, total: number | null) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(earthdataProxyUrl(url), {
    headers: authHeaders(url),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim();
    throw new Error(detail || `${response.status} ${response.statusText}`.trim());
  }
  const total = Number(response.headers.get("content-length")) || null;
  if (!response.body) return response.arrayBuffer();
  const reader = response.body.getReader();
  // Preallocate when the size is known, so a large granule is not held twice.
  const bytes = total ? new Uint8Array(total) : null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes && received + value.length <= bytes.length) bytes.set(value, received);
    else chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  if (bytes && chunks.length === 0) {
    return received === bytes.length ? bytes.buffer : bytes.slice(0, received).buffer;
  }
  const out = new Uint8Array(received);
  let offset = 0;
  if (bytes) {
    out.set(bytes.subarray(0, Math.min(bytes.length, received)), 0);
    offset = Math.min(bytes.length, received);
  }
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

/** Save bytes the browser already holds as a file download. */
function saveBlob(data: ArrayBuffer, fileName: string): void {
  const url = URL.createObjectURL(new Blob([data]));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Download one or more of a granule's files.
 *
 * - `open`: the primary file, into memory, handed to the ICESat-2 / GEDI dialog.
 * - `save`: one file (`fileUrl`, else the primary one), saved where the user picks.
 * - `all`: every data file; the desktop asks for a folder once, the browser
 *   saves them one after another.
 */
async function transferGranule(
  granule: EarthdataGranule,
  kind: "open" | "save" | "all",
  fileUrl?: string,
): Promise<void> {
  const files =
    kind === "all" ? granule.dataLinks : [fileUrl ?? primaryDataLink(granule)].filter(Boolean);
  if (files.length === 0 || state.transfers.get(granule.conceptId)?.controller) return;
  const controller = new AbortController();
  const transfer: TransferState = {
    kind,
    percent: null,
    received: 0,
    fileIndex: 0,
    fileCount: files.length,
    error: null,
    done: null,
    controller,
  };
  state.transfers.set(granule.conceptId, transfer);
  renderPanel?.();
  let lastPaint = 0;
  const onProgress = (received: number, total: number | null) => {
    transfer.received = received;
    transfer.percent = total ? Math.min(100, Math.floor((received / total) * 100)) : null;
    const now = Date.now();
    if (now - lastPaint > 200) {
      lastPaint = now;
      renderPanel?.();
    }
  };
  const native = appRef?.downloadRemoteFile;
  try {
    let folder: { id: string; path: string } | null = null;
    if (kind === "all" && native) {
      folder = (await appRef?.pickDownloadFolder?.()) ?? null;
      if (!folder) {
        state.transfers.delete(granule.conceptId);
        return;
      }
    }
    for (let index = 0; index < files.length; index += 1) {
      const url = files[index] as string;
      const fileName = fileNameFromUrl(url);
      transfer.fileIndex = index;
      transfer.received = 0;
      transfer.percent = null;
      renderPanel?.();
      if (native) {
        const common = {
          headers: authHeaders(url),
          fileName,
          signal: controller.signal,
          onProgress,
        };
        const result = await native(
          url,
          folder
            ? { ...common, target: "folder", folderId: folder.id }
            : { ...common, target: kind === "open" ? "memory" : "save" },
        );
        if (!result) {
          state.transfers.delete(granule.conceptId);
          return;
        }
        if (kind === "open" && result.data) {
          appRef?.openSpaceborneLidarGranule?.(result.data, fileName);
          transfer.done = tr("opened", "Opened in Add Data → ICESat-2 / GEDI.");
        } else if (!folder) {
          transfer.done = tr("saved", "Saved to {{path}}", { path: result.path ?? fileName });
        }
      } else {
        if (!isEarthdataDataUrl(url)) {
          // The relay serves NASA Earthdata hosts only; let the browser fetch
          // any other host itself (it signs in there if it needs to).
          openExternal(url);
          transfer.done = tr("openedInTab", "Opened {{name}} in a new tab.", { name: fileName });
          continue;
        }
        const data = await proxyDownload(url, controller.signal, onProgress);
        if (kind === "open") {
          appRef?.openSpaceborneLidarGranule?.(data, fileName);
          transfer.done = tr("opened", "Opened in Add Data → ICESat-2 / GEDI.");
        } else {
          saveBlob(data, fileName);
          transfer.done = tr("downloaded", "Downloaded {{name}}", { name: fileName });
        }
      }
    }
    if (kind === "all") {
      transfer.done = folder
        ? tr("savedAll", "Saved {{count}} files to {{path}}", {
            count: files.length,
            path: folder.path,
          })
        : // Browsers may ask before saving several files, and drop them if
          // declined, so this cannot claim they were all saved.
          tr(
            "startedAll",
            "Started {{count}} downloads. If your browser asks to allow multiple downloads, allow it.",
            { count: files.length },
          );
    }
  } catch (error) {
    if (controller.signal.aborted) {
      state.transfers.delete(granule.conceptId);
    } else {
      transfer.error =
        files.length > 1
          ? tr("fileFailed", "{{name}}: {{message}}", {
              name: fileNameFromUrl(files[transfer.fileIndex] as string),
              message: errorMessage(error),
            })
          : errorMessage(error);
    }
  } finally {
    transfer.controller = null;
    transfer.percent = null;
    renderPanel?.();
  }
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0);
}

function buildAuthSection(): HTMLElement {
  const details = element("details", CSS.section);
  details.open = state.authOpen;
  details.addEventListener("toggle", () => {
    state.authOpen = details.open;
  });
  const current = token();
  const expiry = current ? earthdataTokenExpiry(current) : null;
  const expired = expiry !== null && expiry.getTime() < Date.now();
  const summary = element(
    "summary",
    CSS.summary,
    current
      ? expired
        ? tr("authExpired", "Earthdata Login: token expired")
        : tr("authSignedIn", "Earthdata Login: token saved")
      : tr("authSignedOut", "Earthdata Login: not signed in"),
  );
  details.append(summary);

  if (current) {
    const status = element(
      "p",
      expired ? CSS.error : CSS.hint,
      expiry
        ? tr("tokenExpiry", "The token expires on {{date}}.", { date: isoDate(expiry) })
        : tr("tokenSaved", "A token is saved."),
    );
    const clear = button(tr("signOut", "Remove token"), CSS.secondaryButton, () => {
      appRef?.credentials?.set(TOKEN_CREDENTIAL, "");
      renderPanel?.();
    });
    details.append(status, clear);
  }

  details.append(
    element(
      "p",
      CSS.hint,
      tr(
        "authHint",
        "Searching needs no account. Downloading a granule needs an Earthdata Login token, which works for every NASA DAAC.",
      ),
    ),
  );
  const tokenInput = element("input", CSS.input);
  tokenInput.type = "password";
  tokenInput.autocomplete = "off";
  tokenInput.placeholder = tr("tokenPlaceholder", "Paste a token");
  tokenInput.setAttribute("aria-label", tr("tokenLabel", "Earthdata Login token"));
  const saveToken = button(tr("saveToken", "Save"), CSS.primaryButton, () => {
    const value = tokenInput.value.trim();
    if (!value) return;
    state.authError = null;
    appRef?.credentials?.set(TOKEN_CREDENTIAL, value);
    renderPanel?.();
  });
  const tokenRow = element("div", CSS.row);
  tokenRow.append(tokenInput, saveToken);
  const tokenLink = element("a", CSS.link, tr("generateToken", "Generate a token"));
  // An href keeps the link in the tab order; the click handler routes it.
  tokenLink.href = EARTHDATA_TOKEN_PAGE_URL;
  tokenLink.addEventListener("click", (event) => {
    event.preventDefault();
    openExternal(EARTHDATA_TOKEN_PAGE_URL);
  });
  details.append(tokenRow, tokenLink);

  // The token endpoint sends no CORS headers, so signing in with a password
  // needs the desktop app's native fetch.
  const nativeFetch = appRef?.nativeFetch;
  if (nativeFetch) {
    const user = element("input", CSS.input);
    user.autocomplete = "username";
    user.placeholder = tr("username", "User name");
    user.setAttribute("aria-label", tr("username", "User name"));
    const password = element("input", CSS.input);
    password.type = "password";
    password.autocomplete = "current-password";
    password.placeholder = tr("password", "Password");
    password.setAttribute("aria-label", tr("password", "Password"));
    const signIn = button(tr("signIn", "Sign in"), CSS.secondaryButton, async () => {
      if (!user.value.trim() || !password.value) return;
      signIn.disabled = true;
      state.authError = null;
      try {
        const value = await requestEarthdataToken(user.value.trim(), password.value, nativeFetch);
        appRef?.credentials?.set(TOKEN_CREDENTIAL, value);
      } catch (error) {
        state.authError = errorMessage(error);
      }
      renderPanel?.();
    });
    const grid = element("div", CSS.grid);
    grid.append(user, password);
    details.append(
      element("p", CSS.hint, tr("signInHint", "Or sign in; only the token it returns is kept.")),
      grid,
      signIn,
    );
  }
  if (state.authError) details.append(element("p", CSS.error, state.authError));
  if (appRef?.credentials) {
    details.append(
      element(
        "p",
        CSS.hint,
        appRef.credentials.location() === "keychain"
          ? tr("storedKeychain", "The token is kept in the system keychain.")
          : tr("storedBrowser", "The token is kept in this browser's storage."),
      ),
    );
  }
  return details;
}

function buildDatasetSection(): HTMLElement {
  const section = element("div", CSS.section);
  section.append(element("p", CSS.heading, tr("dataset", "Dataset")));

  if (state.collection) {
    const chip = element("div", CSS.chip);
    const c = state.collection;
    chip.append(
      element("strong", undefined, `${c.shortName} v${c.version}`),
      element("span", undefined, c.title),
      element(
        "span",
        CSS.sub,
        [c.dataCenter, c.cloudHosted ? tr("cloud", "Earthdata Cloud") : ""]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    const change = button(tr("changeDataset", "Change dataset"), CSS.secondaryButton, () => {
      state.collection = null;
      clearGranules();
      renderPanel?.();
    });
    section.append(chip, change);
    return section;
  }

  const presets = element("select", CSS.input);
  presets.setAttribute("aria-label", tr("popular", "Popular datasets"));
  presets.append(new Option(tr("popularPlaceholder", "Popular datasets…"), ""));
  for (const preset of EARTHDATA_PRESETS)
    presets.append(new Option(preset.label, preset.shortName));
  presets.addEventListener("change", () => {
    if (presets.value) void choosePreset(presets.value);
  });

  const keyword = element("input", CSS.input);
  keyword.type = "search";
  keyword.value = state.keyword;
  keyword.placeholder = tr("keywordPlaceholder", "Search datasets, e.g. GEDI biomass");
  keyword.setAttribute("aria-label", tr("keywordLabel", "Dataset keyword"));
  keyword.addEventListener("input", () => {
    state.keyword = keyword.value;
  });
  keyword.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void searchCollections();
  });
  const go = button(
    tr("searchDatasets", "Search"),
    CSS.primaryButton,
    () => void searchCollections(),
  );
  const row = element("div", CSS.row);
  row.append(keyword, go);
  section.append(presets, row);

  if (state.collectionError) section.append(element("p", CSS.error, state.collectionError));
  if (state.collections) {
    if (state.collections.length === 0) {
      section.append(element("p", CSS.hint, tr("noDatasets", "No datasets match.")));
    } else {
      section.append(
        element(
          "p",
          CSS.hint,
          tr("datasetHits", "Showing {{shown}} of {{total}} datasets.", {
            shown: state.collections.length,
            total: state.collectionHits,
          }),
        ),
      );
      const list = element("div", CSS.list);
      for (const collection of state.collections) {
        const option = element("button", CSS.option);
        option.type = "button";
        option.append(
          element(
            "strong",
            undefined,
            `${collection.shortName} v${collection.version} · ${collection.dataCenter}`,
          ),
          element("span", undefined, collection.title),
        );
        option.addEventListener("click", () => chooseCollection(collection));
        list.append(option);
      }
      section.append(list);
    }
  }
  return section;
}

function buildGranuleSection(): HTMLElement | null {
  if (!state.collection) return null;
  const section = element("div", CSS.section);
  section.append(element("p", CSS.heading, tr("granules", "Granules")));
  const grid = element("div", CSS.grid);
  const dateInput = (label: string, value: string, set: (v: string) => void) => {
    const wrap = element("label", CSS.label, label);
    const input = element("input", CSS.input);
    input.type = "date";
    input.value = value;
    input.addEventListener("change", () => set(input.value));
    wrap.append(input);
    return wrap;
  };
  grid.append(
    dateInput(tr("startDate", "Start date"), state.start, (v) => (state.start = v)),
    dateInput(tr("endDate", "End date"), state.end, (v) => (state.end = v)),
  );
  const search = button(
    state.searching && state.granules.length === 0
      ? tr("searching", "Searching…")
      : tr("searchView", "Search this view"),
    CSS.primaryButton,
    () => void searchGranules(false),
  );
  search.disabled = state.searching;
  section.append(grid, search);

  if (state.granuleError) section.append(element("p", CSS.error, state.granuleError));
  if (state.cogError) section.append(element("p", CSS.error, state.cogError));
  if (state.searched) {
    section.append(
      element(
        "p",
        CSS.hint,
        state.granules.length === 0
          ? tr("noGranules", "No granules in this view and date range.")
          : tr("granuleHits", "Showing {{shown}} of {{total}} granules, newest first.", {
              shown: state.granules.length,
              total: state.granuleHits,
            }),
      ),
    );
  }
  const results = element("div", CSS.results);
  for (const granule of state.granules) results.append(buildCard(granule));
  section.append(results);
  if (state.granules.length > 0 && state.granules.length < state.granuleHits) {
    const more = button(
      state.searching ? tr("loadingMore", "Loading more…") : tr("loadMore", "Load more"),
      CSS.secondaryButton,
      () => void searchGranules(true),
    );
    more.disabled = state.searching;
    section.append(more);
  }
  return section;
}

/** Whether the host can add COG layers. */
function canAddCog(): boolean {
  return typeof appRef?.addCogLayer === "function";
}

/** The relay URLs of the Earthdata COG layers on the map, as one comparable string. */
function addedCogSignature(layers: readonly { source: unknown }[]): string {
  const urls: string[] = [];
  for (const layer of layers) {
    const url = (layer.source as { url?: unknown } | undefined)?.url;
    if (typeof url === "string" && isEarthdataProxyUrl(url)) urls.push(url);
  }
  return urls.sort().join("\n");
}

/** Whether a COG is already on the map, found by its relay URL in the store. */
function isCogAdded(url: string): boolean {
  const relay = earthdataProxyUrl(url);
  return useAppStore
    .getState()
    .layers.some((layer) => (layer.source as { url?: unknown }).url === relay);
}

/**
 * Add one of a granule's GeoTIFFs as a COG layer. The layer reads through the
 * tiles Worker relay, since the DAACs send no CORS headers, and its saved URL
 * carries no token: the host adds the Earthdata Login token to relay requests.
 */
async function addCog(url: string): Promise<void> {
  if (!appRef?.addCogLayer || state.addingCog.has(url)) return;
  state.cogError = null;
  if (!token()) {
    state.authOpen = true;
    state.cogError = tr(
      "cogNeedsToken",
      "Add an Earthdata Login token to put NASA GeoTIFFs on the map.",
    );
    renderPanel?.();
    return;
  }
  state.addingCog.add(url);
  renderPanel?.();
  try {
    await appRef.addCogLayer(fileNameFromUrl(url).replace(/\.tiff?$/i, ""), earthdataProxyUrl(url));
  } catch (error) {
    state.cogError = tr("cogFailed", "Could not add {{name}}: {{message}}", {
      name: fileNameFromUrl(url),
      message: errorMessage(error),
    });
  } finally {
    state.addingCog.delete(url);
    renderPanel?.();
  }
}

/** Whether a data link is a (Cloud-Optimized) GeoTIFF the map can add. */
function isCogUrl(url: string): boolean {
  return /\.tiff?$/i.test(url.split(/[?#]/)[0]);
}

/** The collapsible per-file list of a granule: download one file, or add a COG. */
function buildFileList(granule: EarthdataGranule, busy: boolean): HTMLElement {
  const details = element("details", CSS.files);
  details.open = state.openFileLists.has(granule.conceptId);
  details.addEventListener("toggle", () => {
    if (details.open) state.openFileLists.add(granule.conceptId);
    else state.openFileLists.delete(granule.conceptId);
  });
  details.append(
    element(
      "summary",
      CSS.filesSummary,
      tr("files", "Files ({{count}})", { count: granule.dataLinks.length }),
    ),
  );
  for (const url of granule.dataLinks) {
    const row = element("div", CSS.fileRow);
    const fullName = fileNameFromUrl(url);
    // HLS-style files all start with the granule name; show what tells them apart.
    const shortName = fullName.startsWith(`${granule.name}.`)
      ? fullName.slice(granule.name.length + 1)
      : fullName;
    const name = element("span", CSS.fileName, shortName);
    name.title = fullName;
    row.append(name);
    if (isCogUrl(url) && isEarthdataDataUrl(url) && canAddCog()) {
      const added = isCogAdded(url);
      const add = button(
        added ? tr("addedCog", "Added") : tr("addCog", "Add"),
        CSS.action,
        () => void addCog(url),
        tr("addCogTitle", "Add this GeoTIFF to the map"),
      );
      add.disabled = added || state.addingCog.has(url);
      row.append(add);
    }
    const download = button(
      tr("download", "Download"),
      CSS.action,
      () => void transferGranule(granule, "save", url),
      tr("downloadFileTitle", "Download this file"),
    );
    download.disabled = busy;
    row.append(download);
    details.append(row);
  }
  return details;
}

function buildCard(granule: EarthdataGranule): HTMLElement {
  const collection = state.collection;
  const selected = state.selectedId === granule.conceptId;
  const card = element("div", selected ? CSS.cardSelected : CSS.card);
  card.dataset.granuleId = granule.conceptId;
  const title = element("div", CSS.title, granule.name);
  title.title = granule.name;
  const parts = [
    granule.timeStart?.replace("T", " ").slice(0, 16),
    formatSizeMb(granule.sizeMb),
    granule.cloudCover !== null
      ? tr("cloudCover", "{{value}}% cloud", { value: Math.round(granule.cloudCover) })
      : null,
    granule.dataLinks.length > 1
      ? tr("fileCount", "{{count}} files", { count: granule.dataLinks.length })
      : null,
  ].filter(Boolean);
  card.append(title, element("div", CSS.sub, parts.join(" · ")));

  const actions = element("div", CSS.actions);
  const transfer = state.transfers.get(granule.conceptId);
  const busy = Boolean(transfer?.controller);
  const link = primaryDataLink(granule);
  if (
    collection &&
    isSpaceborneLidarGranule(collection, granule) &&
    appRef?.openSpaceborneLidarGranule
  ) {
    const open = button(
      tr("open", "Open"),
      CSS.actionPrimary,
      () => void transferGranule(granule, "open"),
      tr("openTitle", "Download this granule and add its footprints to the map"),
    );
    open.disabled = busy;
    actions.append(open);
  }
  const multiFile = granule.dataLinks.length > 1;
  if (link) {
    const download = multiFile
      ? button(
          tr("downloadAll", "Download all"),
          CSS.action,
          () => void transferGranule(granule, "all"),
          appRef?.downloadRemoteFile
            ? tr("downloadAllTitle", "Download all {{count}} files into a folder", {
                count: granule.dataLinks.length,
              })
            : tr("downloadAllBrowserTitle", "Download all {{count}} files", {
                count: granule.dataLinks.length,
              }),
        )
      : button(
          tr("download", "Download"),
          CSS.action,
          () => void transferGranule(granule, "save"),
          tr("downloadTitle", "Download this granule"),
        );
    download.disabled = busy;
    actions.append(download);
  }
  actions.append(
    button(tr("zoom", "Zoom"), CSS.action, () => selectGranule(granule.conceptId, true)),
    button(
      tr("details", "Details"),
      CSS.action,
      () => openExternal(granuleDetailsUrl(granule)),
      tr("detailsTitle", "Open this granule in Earthdata Search"),
    ),
  );
  card.append(actions);
  if (multiFile || granule.dataLinks.some(isCogUrl)) card.append(buildFileList(granule, busy));

  if (transfer) {
    if (transfer.controller) {
      const row = element("div", CSS.row);
      const progress = element(
        "span",
        CSS.sub,
        (transfer.fileCount > 1
          ? tr("fileOf", "File {{index}} of {{count}}: ", {
              index: transfer.fileIndex + 1,
              count: transfer.fileCount,
            })
          : "") +
          (transfer.received === 0
            ? tr("starting", "Starting download…")
            : transfer.percent !== null
              ? tr("progress", "Downloading… {{percent}}% ({{mb}} MB)", {
                  percent: transfer.percent,
                  mb: megabytes(transfer.received),
                })
              : tr("progressUnknown", "Downloading… {{mb}} MB", {
                  mb: megabytes(transfer.received),
                })),
      );
      row.append(
        progress,
        button(tr("cancel", "Cancel"), CSS.action, () => transfer.controller?.abort()),
      );
      card.append(row);
    } else if (transfer.error) {
      card.append(element("p", CSS.error, transfer.error));
    } else if (transfer.done) {
      card.append(element("p", CSS.hint, transfer.done));
    }
  }
  card.addEventListener("click", (event) => {
    // The file list toggles itself; selecting re-renders and would close it.
    if ((event.target as HTMLElement).closest("button, details")) return;
    selectGranule(granule.conceptId, false);
  });
  return card;
}

function buildPanel(container: HTMLElement): () => void {
  const root = element("div", CSS.panel);
  container.replaceChildren(root);
  const render = () => {
    const scroll = root.scrollTop;
    root.replaceChildren(
      element(
        "p",
        CSS.hint,
        tr(
          "hint",
          "Search NASA's Earthdata catalog (CMR) for datasets and granules over the map view, then download them or open ICESat-2 and GEDI granules on the map.",
        ),
      ),
      buildAuthSection(),
      buildDatasetSection(),
      ...[buildGranuleSection()].filter((node): node is HTMLElement => node !== null),
    );
    root.scrollTop = scroll;
  };
  renderPanel = render;
  // Keep the file lists' Add / Added state in step with the map: re-render when
  // an Earthdata COG layer is added or removed anywhere (the Layers panel, undo,
  // a project load), but not for unrelated layer edits.
  let addedCogs = addedCogSignature(useAppStore.getState().layers);
  const unsubscribeLayers = useAppStore.subscribe((next, previous) => {
    if (next.layers === previous.layers) return;
    const signature = addedCogSignature(next.layers);
    if (signature === addedCogs) return;
    addedCogs = signature;
    render();
  });
  render();
  if (state.granules.length > 0) setFootprints();
  return () => {
    unsubscribeLayers();
    if (renderPanel === render) renderPanel = null;
    container.replaceChildren();
  };
}

function mountPanel(container: HTMLElement): void {
  disposePanel?.();
  panelContainer = container;
  disposePanel = buildPanel(container);
}

/**
 * NASA Earthaccess plugin: the GeoLibre counterpart of the Python
 * `earthaccess` library. Searches NASA's Common Metadata Repository for
 * datasets and for granules over the map view and a date range, draws their
 * footprints, and downloads granules with an Earthdata Login token: natively on
 * the desktop, through GeoLibre's tiles Worker in the browser. ICESat-2 and GEDI
 * granules open straight into the Add Data → ICESat-2 / GEDI reader.
 */
export const maplibreEarthaccessPlugin: GeoLibrePlugin = {
  id: EARTHACCESS_PLUGIN_ID,
  name: PLUGIN_NAME,
  version: "0.1.0",
  engines: ["maplibre", "mapbox"],
  activate: (app) => {
    appRef = app;
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: pluginDisplayTitle(app, EARTHACCESS_PLUGIN_ID, PLUGIN_NAME),
        dock: "replace-style",
        defaultWidth: 360,
        render: (container) => {
          mountPanel(container);
          return () => {
            disposePanel?.();
            disposePanel = null;
            if (panelContainer === container) panelContainer = null;
          };
        },
      }) ?? null;
    unsubscribeLocale =
      app.onLocaleChange?.(() => {
        if (panelContainer) mountPanel(panelContainer);
      }) ?? null;
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate: (app) => {
    app.closeRightPanel?.(PANEL_ID);
    unsubscribeLocale?.();
    unsubscribeLocale = null;
    unregisterPanel?.();
    unregisterPanel = null;
    disposePanel?.();
    disposePanel = null;
    panelContainer = null;
    for (const transfer of state.transfers.values()) transfer.controller?.abort();
    removeFootprintLayers(getControlMap(app));
    searchGeneration += 1;
    state = initialState();
    appRef = null;
  },
};

export default maplibreEarthaccessPlugin;
