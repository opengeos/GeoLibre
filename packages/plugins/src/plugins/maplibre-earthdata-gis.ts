/**
 * Earthdata GIS browser (Plugins > Web Services).
 *
 * Searches NASA's Earthdata GIS portal (https://gis.earthdata.nasa.gov) and
 * adds its ArcGIS services straight to the map: ImageServer and MapServer items
 * as raster tile layers rendered through their export endpoints, FeatureServer
 * items as GeoJSON vector layers (via the host's ArcGIS feature-layer path, so
 * they arrive with attributes, styling, and export intact).
 *
 * This is a distinct catalog from the NASA Earthdata (GIBS) plugin: GIBS serves
 * pre-rendered global imagery tiles, while Earthdata GIS serves the analysis-
 * ready ArcGIS services EOSDIS publishes for its DAACs and disaster responses.
 */

import { useAppStore } from "@geolibre/core";
import { addArcGISLayer } from "./arcgis-layer";
import {
  buildExportTileUrl,
  EARTHDATA_GIS_ATTRIBUTION,
  EARTHDATA_GIS_PAGE_SIZE,
  EARTHDATA_GIS_TILE_SIZE,
  EARTHDATA_SERVICE_KINDS,
  type EarthdataGisItem,
  type EarthdataGisSearchResult,
  type EarthdataServiceKind,
  bboxToMercator,
  buildExportDownloadUrl,
  type ExportLimits,
  exportFileName,
  exportImageSize,
  fetchExportLimits,
  fetchMinVisibleZoom,
  fetchWebMapLayers,
  HTTP_URL_RE,
  nextExportSize,
  searchEarthdataGis,
  type WebMapLayer,
  webMapLayerAsItem,
} from "./earthdata-gis-api";
import { layerTypeForTiles } from "./web-service-sync";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

export const EARTHDATA_GIS_PLUGIN_ID = "maplibre-gl-earthdata-gis";
const PANEL_ID = EARTHDATA_GIS_PLUGIN_ID;

/**
 * How long a FeatureServer load may run before the card stops reporting
 * progress.
 *
 * Adding a feature service downloads its features as GeoJSON up front, and the
 * portal lists services whose query endpoint never answers at all (the NSIDC
 * ATL08 prototype returns nothing even for `returnCountOnly`). Without a bound
 * those cards sit on "Adding…" forever. A healthy service of this size answers
 * in single-digit seconds, so a minute is generous; the request is not
 * cancellable, so if it does land late the store subscription still flips the
 * card to "Remove".
 */
const FEATURE_ADD_TIMEOUT_MS = 60_000;

/**
 * How long the pre-add visibility lookup may take before the layer is added
 * without a minimum-zoom constraint. Two small metadata requests; capping them
 * keeps a slow or dead service from delaying the add noticeably.
 */
const VISIBILITY_LOOKUP_TIMEOUT_MS = 6_000;

/**
 * Ceiling on a COG export's pixel dimensions, independent of what the service
 * advertises.
 *
 * `maxImageWidth`/`maxImageHeight` describe the largest size ArcGIS will accept
 * as a parameter, not the largest it can actually render. The Planet disaster
 * imagery advertises 15000x4100 yet times out at 4096px and answers 503 at
 * 4977px, while GSSICB (5000x5000) serves 4977px in about a second. Both
 * return a 2048px export promptly, so that is the default ask; the retry ladder
 * in {@link downloadCog} covers services that cannot manage even that.
 */
const EXPORT_MAX_PIXELS = 2048;

/** Smallest export worth falling back to before giving up. */
const EXPORT_MIN_PIXELS = 512;

/** How many progressively smaller sizes to try before reporting failure. */
const EXPORT_ATTEMPTS = 3;

/** Per-attempt export timeout; an oversized request can otherwise hang for minutes. */
const EXPORT_ATTEMPT_TIMEOUT_MS = 45_000;

/** Which service kinds the type filter is showing. "all" means no restriction. */
type KindFilter = "all" | EarthdataServiceKind;

/**
 * User-facing strings for the panel. This package is framework-agnostic and
 * cannot call `t()`, so the host (`TopToolbar`) pushes localized copies via
 * {@link setEarthdataGisLabels} on activation and every language change — the
 * same pattern the OpenAerialMap / Source Cooperative panels use.
 */
export interface EarthdataGisLabels {
  hint: string;
  searchPlaceholder: string;
  search: string;
  searching: string;
  loadingMore: string;
  loadMore: string;
  noResults: string;
  showing: (shown: number, total: number) => string;
  searchError: (message: string) => string;
  limitToView: string;
  limitToViewTitle: string;
  filterAll: string;
  filterImage: string;
  filterMap: string;
  filterFeature: string;
  kindImage: string;
  kindMap: string;
  kindFeature: string;
  kindWebMap: string;
  filterWebMap: string;
  webMapAdded: (added: number, total: number) => string;
  webMapEmpty: string;
  add: string;
  adding: string;
  remove: string;
  zoom: string;
  details: string;
  portal: string;
  portalTitle: string;
  cog: string;
  cogTitle: string;
  cogHeading: string;
  cogAreaView: string;
  cogAreaExtent: string;
  cogSize: (width: number, height: number) => string;
  cogResolution: (metres: string) => string;
  cogNote: string;
  cogDownload: string;
  cogDownloading: string;
  cogRetrying: (width: number, height: number) => string;
  cogConverting: string;
  cogDone: (width: number, height: number) => string;
  cogFailed: (message: string) => string;
  cogUnavailable: string;
  cancel: string;
  addTitle: string;
  removeTitle: string;
  zoomTitle: string;
  zoomUnavailableTitle: string;
  detailsTitle: string;
  addError: (message: string) => string;
  addTimeout: string;
  zoomedToData: string;
  // Details dialog.
  detailsHeading: string;
  close: string;
  metaTitle: string;
  metaType: string;
  metaSummary: string;
  metaDescription: string;
  metaOwner: string;
  metaModified: string;
  metaTags: string;
  metaExtent: string;
  metaCredits: string;
  metaLicense: string;
  metaService: string;
  metaPortalItem: string;
  metaRaw: string;
}

/** English defaults, used until the host injects translations. */
export const DEFAULT_EARTHDATA_GIS_LABELS: EarthdataGisLabels = {
  hint: "Search NASA Earthdata GIS for imagery, map, and feature services.",
  searchPlaceholder: "Search Earthdata GIS…",
  search: "Search",
  searching: "Searching…",
  loadingMore: "Loading more…",
  loadMore: "Load more",
  noResults: "No services matched this search.",
  showing: (shown, total) => `Showing ${shown} of ${total} services.`,
  searchError: (message) => `Could not reach Earthdata GIS: ${message}. Please try again.`,
  limitToView: "Limit to map view",
  limitToViewTitle: "Only return services that intersect the current map view",
  filterAll: "All",
  filterImage: "Imagery",
  filterMap: "Maps",
  filterFeature: "Features",
  kindImage: "Image service",
  kindMap: "Map service",
  kindFeature: "Feature service",
  kindWebMap: "Web map",
  filterWebMap: "Web maps",
  webMapAdded: (added, total) =>
    added === total
      ? `Added ${added} layer${added === 1 ? "" : "s"} from this web map.`
      : `Added ${added} of ${total} layers from this web map; the rest could not be reached.`,
  webMapEmpty: "this web map has no layers GeoLibre can render.",
  add: "Add",
  adding: "Adding…",
  remove: "Remove",
  zoom: "Zoom",
  details: "Details",
  portal: "Portal",
  portalTitle: "Open this item on the Earthdata GIS portal",
  cog: "COG",
  cogTitle: "Download this service as a Cloud Optimized GeoTIFF",
  cogHeading: "Download as COG",
  cogAreaView: "Current view",
  cogAreaExtent: "Full extent",
  cogSize: (width, height) => `Export size: ${width} x ${height} px`,
  cogResolution: (metres) => `Ground resolution: ${metres} m/px`,
  cogNote:
    "The service is re-exported at this size and re-encoded as a COG, so this is a resampled view of the area, not the source raster at native resolution.",
  cogDownload: "Download",
  cogDownloading: "Exporting and converting…",
  cogRetrying: (width, height) =>
    `The service refused that size; retrying at ${width} x ${height} px…`,
  cogConverting: "Converting to a COG…",
  cogDone: (width, height) => `Saved the COG at ${width} x ${height} px.`,
  cogFailed: (message) => `Could not download the COG: ${message}`,
  cogUnavailable: "Downloading requires the desktop app or a browser save dialog.",
  cancel: "Cancel",
  addTitle: "Add this service to the map",
  removeTitle: "Remove this service from the map",
  zoomTitle: "Zoom to this service",
  zoomUnavailableTitle: "This service does not publish an extent",
  detailsTitle: "View this service's metadata",
  addError: (message) => `Could not add the service: ${message}`,
  addTimeout: "it did not respond within a minute. The layer will still appear if it finishes.",
  zoomedToData:
    "Zoomed in past this layer's full extent: the service only renders at higher zoom levels.",
  detailsHeading: "Service details",
  close: "Close",
  metaTitle: "Title",
  metaType: "Type",
  metaSummary: "Summary",
  metaDescription: "Description",
  metaOwner: "Published by",
  metaModified: "Last modified",
  metaTags: "Tags",
  metaExtent: "Extent (W, S, E, N)",
  metaCredits: "Credits",
  metaLicense: "Use constraints",
  metaService: "Service URL",
  metaPortalItem: "Portal item",
  metaRaw: "Raw metadata",
};

let labels: EarthdataGisLabels = { ...DEFAULT_EARTHDATA_GIS_LABELS };

// The theme tokens are HSL channel triplets (shadcn convention), so they must be
// wrapped in hsl(); using them bare yields an invalid value that drops the rule.
const CSS = {
  panel:
    "display:flex;flex-direction:column;gap:8px;padding:8px;font-size:12px;" +
    "height:100%;box-sizing:border-box;color:hsl(var(--foreground));",
  searchRow: "display:flex;gap:6px;",
  searchInput:
    "flex:1 1 auto;min-width:0;box-sizing:border-box;padding:5px 8px;font-size:12px;" +
    "border-radius:6px;border:1px solid hsl(var(--border));" +
    "background:hsl(var(--background));color:hsl(var(--foreground));",
  primaryButton:
    "padding:5px 12px;border-radius:6px;border:1px solid hsl(var(--primary));" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));" +
    "font-size:12px;cursor:pointer;white-space:nowrap;",
  wideButton:
    "width:100%;padding:6px 10px;border-radius:6px;border:1px solid hsl(var(--primary));" +
    "background:hsl(var(--primary));color:hsl(var(--primary-foreground));" +
    "font-size:12px;cursor:pointer;",
  filterBar:
    "display:flex;gap:2px;padding:2px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));",
  filterButton:
    "flex:1 1 0;padding:4px 6px;font-size:11px;border-radius:4px;border:none;" +
    "background:transparent;color:hsl(var(--muted-foreground));cursor:pointer;",
  filterButtonActive:
    "flex:1 1 0;padding:4px 6px;font-size:11px;border-radius:4px;border:none;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));" +
    "cursor:pointer;font-weight:600;",
  checkboxRow:
    "display:flex;align-items:center;gap:6px;font-size:11px;" +
    "color:hsl(var(--muted-foreground));cursor:pointer;",
  status: "font-size:11px;color:hsl(var(--muted-foreground));line-height:1.4;",
  results: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-height:0;overflow-y:auto;",
  card:
    "display:flex;gap:8px;padding:6px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));",
  thumb:
    "flex:0 0 auto;width:56px;height:56px;border-radius:4px;overflow:hidden;" +
    "background:hsl(var(--accent));",
  body: "flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:6px;",
  title: "font-size:12px;font-weight:600;line-height:1.3;overflow-wrap:anywhere;",
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
// rebuild the panel in place (see setEarthdataGisLabels).
let panelContainer: HTMLElement | null = null;
let disposePanel: (() => void) | null = null;
// Teardown for an open details dialog, so the panel/plugin can close it.
let closeDetailsDialog: (() => void) | null = null;
// Item ids whose (async) FeatureServer load is still running, so the card can
// show progress and a double click cannot start a second load.
const pendingAdds = new Set<string>();

/** Human-readable name for a service kind. */
function kindLabel(kind: EarthdataServiceKind): string {
  if (kind === "image") return labels.kindImage;
  if (kind === "map") return labels.kindMap;
  if (kind === "webmap") return labels.kindWebMap;
  return labels.kindFeature;
}

/**
 * Finds the store layer this item was added as.
 *
 * The store (not an in-memory map) is the source of truth so the Add/Remove
 * state stays correct across a project reload and across layers the user
 * deletes from the Layers panel. A raster item is matched by its deterministic
 * export tile template; a feature item by the service URL its GeoJSON refresh
 * endpoint was built from.
 */
function findAddedLayerId(item: EarthdataGisItem): string | undefined {
  const layers = useAppStore.getState().layers;
  if (item.kind === "webmap") {
    // A web map owns no layer of its own; its children are stamped with its id
    // on add, so the presence of any one of them means the web map is on.
    return layers.find((candidate) => candidate.metadata.earthdataWebMapId === item.id)?.id;
  }
  if (item.kind === "feature") {
    const servicePrefix = item.url.replace(/\/+$/, "");
    return layers.find((candidate) => candidate.sourcePath?.startsWith(servicePrefix))?.id;
  }
  const tileUrl = buildExportTileUrl(item);
  if (!tileUrl) return undefined;
  return layers.find((candidate) => {
    const tiles = (candidate.source as { tiles?: unknown }).tiles;
    return Array.isArray(tiles) && tiles.includes(tileUrl);
  })?.id;
}

/** Whether an item is currently on the map. */
function isAdded(item: EarthdataGisItem): boolean {
  return findAddedLayerId(item) !== undefined;
}

/**
 * Rejects with {@link EarthdataGisLabels.addTimeout} if `work` has not settled
 * within {@link FEATURE_ADD_TIMEOUT_MS}. The underlying request keeps running —
 * `addArcGISLayer` takes no abort signal — so a late success still lands its
 * layer in the store.
 *
 * @param work - The in-flight feature-layer load
 * @returns A promise that settles with `work`, or rejects on the deadline
 */
function withFeatureTimeout(work: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(labels.addTimeout)), FEATURE_ADD_TIMEOUT_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Moves the view to a newly added raster layer.
 *
 * Fits the layer's extent, except when the service only draws below a coarser
 * pixel size than that view would use — then it centers on the extent at the
 * shallowest zoom that actually renders, because fitting the extent would
 * otherwise land the user on a deliberately blank map.
 *
 * @param bbox - The layer's WGS84 bounds
 * @param minVisibleZoom - Zoom below which the service renders nothing, if known
 * @returns True when the view was zoomed past the fitted extent to reach data
 */
function revealRasterLayer(
  bbox: [number, number, number, number],
  minVisibleZoom: number | null,
): boolean {
  const map = appRef?.getMap?.();
  if (!map || minVisibleZoom === null) {
    appRef?.fitBounds?.(bbox);
    return false;
  }
  const [west, south, east, north] = bbox;
  // cameraForBounds reports the camera fitBounds would settle on without
  // moving the map, so the two views can be compared before either is applied.
  const fitted = map.cameraForBounds([
    [west, south],
    [east, north],
  ]);
  if (!fitted || (fitted.zoom ?? 0) >= minVisibleZoom) {
    appRef?.fitBounds?.(bbox);
    return false;
  }
  map.easeTo({
    center: fitted.center ?? [(west + east) / 2, (south + north) / 2],
    zoom: minVisibleZoom,
  });
  return true;
}

/**
 * Adds an item to the map.
 *
 * Raster services become a tile layer built from their export endpoint;
 * feature services are handed to the host's ArcGIS path, which fetches them as
 * GeoJSON (and therefore resolves asynchronously and can reject).
 *
 * The layer is typed `wms` rather than `xyz` because an ArcGIS export template
 * carries a `{bbox-epsg-3857}` placeholder instead of `{z}/{x}/{y}`. That is
 * what {@link layerTypeForTiles} classifies it as, matching every other web
 * service plugin, and it keeps tools that consume a tile template (Raster
 * Subset) from handing the unsubstituted placeholder to an XYZ fetcher.
 *
 * @param item - The catalog item to add
 * @param onHint - Called with a status note when the view had to zoom past the
 *   layer's extent to reach data
 * @returns A promise that settles once the layer is in the store
 */
async function addToMap(item: EarthdataGisItem, onHint?: (hint: string) => void): Promise<void> {
  if (isAdded(item)) return;
  if (item.kind === "webmap") {
    await addWebMapToMap(item, onHint);
    return;
  }
  await addServiceToMap(item, { onHint });
}

/** Options for {@link addServiceToMap}. */
interface AddServiceOptions {
  /** Called when the view had to zoom past the extent to show data. */
  onHint?: (hint: string) => void;
  /**
   * Set when the layer comes from a web map, so it can be tracked and removed
   * together with its siblings.
   */
  webMapId?: string;
  /** Whether to move the view to the new layer. @default true */
  fit?: boolean;
  /**
   * An already-resolved minimum visible zoom, letting a caller that adds many
   * layers run the lookups concurrently. Omit to look it up here; `null` means
   * the lookup ran and found no constraint.
   */
  minVisibleZoom?: number | null;
}

/**
 * Adds one ArcGIS service as a layer and returns its store id.
 *
 * @param item - A service item (never a web map)
 * @param options - Hint sink, web map ownership, view and zoom-lookup control
 * @returns The new layer's store id, or null when the item yields no layer
 */
async function addServiceToMap(
  item: EarthdataGisItem,
  options: AddServiceOptions = {},
): Promise<string | null> {
  const { onHint, webMapId, fit = true, minVisibleZoom: presetMinVisibleZoom } = options;
  const ownerMetadata = webMapId ? { earthdataWebMapId: webMapId } : undefined;

  if (item.kind === "feature") {
    if (!appRef) throw new Error("The map is not ready.");
    const layerId = (await withFeatureTimeout(
      addArcGISLayer(appRef, {
        layerType: "feature",
        sourceType: "url",
        url: item.url,
        name: item.title,
      }),
    )) as string | undefined;
    if (typeof layerId !== "string") return null;
    if (ownerMetadata) stampLayerMetadata(layerId, ownerMetadata);
    return layerId;
  }

  const tileUrl = buildExportTileUrl(item);
  if (!tileUrl) return null;

  // Best-effort: a service that never answers must not block the add, so the
  // lookup is bounded and any failure simply leaves the layer unconstrained.
  // `undefined` means "not looked up yet"; `null` is a completed lookup that
  // found no constraint, so only the former triggers a fetch here.
  const minVisibleZoom =
    presetMinVisibleZoom !== undefined
      ? presetMinVisibleZoom
      : await withVisibilityTimeout(fetchMinVisibleZoom(item));

  const layerId = useAppStore.getState().addTileLayer(item.title, {
    type: layerTypeForTiles([tileUrl]),
    tiles: [tileUrl],
    url: item.url,
    tileSize: EARTHDATA_GIS_TILE_SIZE,
    attribution: EARTHDATA_GIS_ATTRIBUTION,
    ...(minVisibleZoom !== null ? { minzoom: minVisibleZoom } : {}),
    ...(item.bbox ? { bounds: item.bbox } : {}),
    ...(ownerMetadata ? { metadata: ownerMetadata } : {}),
  });

  if (fit && item.bbox && revealRasterLayer(item.bbox, minVisibleZoom)) {
    onHint?.(labels.zoomedToData);
  }
  return layerId;
}

/**
 * Adds every renderable layer of a Web Map and collects them into one group.
 *
 * A web map is a composition, not a service, so "adding" it means adding its
 * `operationalLayers`. They are added sequentially (rather than concurrently)
 * so the resulting layer order matches the web map's own, and the view is moved
 * once at the end rather than once per layer.
 *
 * @param item - The web map item
 * @param onHint - Called when the view had to zoom past the extent to show data
 * @throws When the web map contains no layer this plugin can render
 */
async function addWebMapToMap(
  item: EarthdataGisItem,
  onHint?: (hint: string) => void,
): Promise<void> {
  const layers = await withFeatureTimeout(fetchWebMapLayers(item));
  const renderable = Array.isArray(layers) ? (layers as WebMapLayer[]) : [];
  if (renderable.length === 0) throw new Error(labels.webMapEmpty);

  const children = renderable.map((layer, index) => webMapLayerAsItem(item, layer, index));
  // Each raster child's visibility lookup is a bounded pair of requests, so
  // running them together keeps a web map of N unresponsive image layers from
  // costing N x VISIBILITY_LOOKUP_TIMEOUT_MS. Only the store writes below need
  // to stay ordered.
  const minVisibleZooms = await Promise.all(
    children.map((child) =>
      child.kind === "image" ? withVisibilityTimeout(fetchMinVisibleZoom(child)) : null,
    ),
  );

  const addedIds: string[] = [];
  for (const [index, child] of children.entries()) {
    try {
      const id = await addServiceToMap(child, {
        webMapId: item.id,
        fit: false,
        minVisibleZoom: minVisibleZooms[index],
      });
      if (id) addedIds.push(id);
    } catch {
      // One unreachable layer must not abandon the rest of the web map; the
      // shortfall is reported through the count below.
    }
  }
  if (addedIds.length === 0) throw new Error(labels.webMapEmpty);

  appRef?.addLayerGroup?.(item.title, addedIds);
  // A web map is a curated composition, so its own extent is the right view;
  // the per-layer zoom-to-data rule would over-zoom for its other layers.
  if (item.bbox) appRef?.fitBounds?.(item.bbox);
  onHint?.(labels.webMapAdded(addedIds.length, renderable.length));
}

// ---------------------------------------------------------------------------
// COG download
// ---------------------------------------------------------------------------

/**
 * Converts an ArcGIS GeoTIFF export into a Cloud Optimized GeoTIFF and saves it.
 *
 * ArcGIS has no COG output of its own — `format=cog` is not a recognized value
 * and silently falls back to PNG, while `format=tiff` returns a tiled GeoTIFF
 * with no overviews, which is not a valid COG. The re-encode and the file
 * dialog both live in the host, so this plugin (which is framework- and
 * I/O-free) receives them through {@link setEarthdataCogSaver}, the same
 * injection the Timelapse plugin uses for its video save.
 */
export type EarthdataCogSaver = (geoTiffBytes: Uint8Array, defaultName: string) => Promise<boolean>;

let cogSaver: EarthdataCogSaver | null = null;

/**
 * Installs the host's GeoTIFF-to-COG converter and file saver. Called once at
 * startup; without it the panel's COG button reports that downloading is
 * unavailable rather than failing mid-download.
 *
 * @param saver - Converts the bytes and saves them, resolving false if the user
 *   cancelled the save dialog
 */
export function setEarthdataCogSaver(saver: EarthdataCogSaver | null): void {
  cogSaver = saver;
}

/** The area a COG download covers. */
type CogArea = "view" | "extent";

/**
 * Resolves the web-mercator box a COG download should cover.
 *
 * @param item - The service item being downloaded
 * @param area - Whether to use the map view or the layer's full extent
 * @returns The box in web-mercator metres, or null when it cannot be determined
 */
function cogBounds(
  item: EarthdataGisItem,
  area: CogArea,
  serviceExtent3857: [number, number, number, number] | null,
): [number, number, number, number] | null {
  if (area === "extent") {
    // Prefer the service's own extent: a portal item can ship an empty
    // `extent: []` even when the service publishes a real one.
    return serviceExtent3857 ?? (item.bbox ? bboxToMercator(item.bbox) : null);
  }
  const view = currentBbox();
  if (!view) return null;
  return bboxToMercator(view);
}

/** Formats a ground resolution for the download dialog. */
function formatResolution(bbox3857: [number, number, number, number], width: number): string {
  const metresPerPixel = Math.abs(bbox3857[2] - bbox3857[0]) / Math.max(1, width);
  return metresPerPixel >= 10 ? metresPerPixel.toFixed(0) : metresPerPixel.toFixed(2);
}

/**
 * Opens the COG download dialog for an image or map service.
 *
 * The export size is recomputed whenever the area changes, so the size and
 * resolution shown are exactly what the request will ask ArcGIS for.
 */
function openCogModal(item: EarthdataGisItem): void {
  closeDetailsDialog?.();

  const overlay = document.createElement("div");
  const previouslyFocused = document.activeElement as HTMLElement | null;
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:2147483000;display:flex;" +
    "align-items:center;justify-content:center;padding:16px;" +
    "background:rgba(0,0,0,0.5);";

  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", labels.cogHeading);
  dialog.tabIndex = -1;
  dialog.style.cssText =
    "display:flex;flex-direction:column;gap:10px;width:100%;max-width:420px;" +
    "padding:12px;border-radius:8px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));" +
    "color:hsl(var(--foreground));box-shadow:0 10px 40px rgba(0,0,0,0.4);";

  const heading = document.createElement("div");
  heading.style.cssText = "font-size:13px;font-weight:600;";
  heading.textContent = labels.cogHeading;

  const areaBar = document.createElement("div");
  areaBar.style.cssText = CSS.filterBar;
  const areaButtons: Record<CogArea, HTMLButtonElement> = {
    view: makeFilterButton(labels.cogAreaView),
    extent: makeFilterButton(labels.cogAreaExtent),
  };
  areaBar.append(areaButtons.view, areaButtons.extent);

  const sizeLine = document.createElement("div");
  sizeLine.style.cssText = CSS.status;
  const resolutionLine = document.createElement("div");
  resolutionLine.style.cssText = CSS.status;
  const note = document.createElement("div");
  note.style.cssText = CSS.status;
  note.textContent = labels.cogNote;
  const status = document.createElement("div");
  status.style.cssText = CSS.status;

  const buttonRow = document.createElement("div");
  buttonRow.style.cssText = "display:flex;gap:6px;justify-content:flex-end;";
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = labels.cancel;
  cancelButton.style.cssText = CSS.action;
  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.textContent = labels.cogDownload;
  downloadButton.style.cssText = CSS.primaryButton;
  buttonRow.append(cancelButton, downloadButton);

  dialog.append(heading, areaBar, sizeLine, resolutionLine, note, status, buttonRow);
  overlay.appendChild(dialog);

  let area: CogArea = "view";
  let limits: ExportLimits = { maxWidth: 4096, maxHeight: 4096 };
  let serviceExtent3857: [number, number, number, number] | null = null;
  let running = false;
  // Set while an export is in flight so Cancel / Escape / the backdrop can stop
  // it: the retry ladder can otherwise hold the dialog for the better part of
  // two minutes with no way out.
  let inflight: AbortController | null = null;

  const refresh = (): void => {
    // A service with no published extent can only be exported over the map view.
    areaButtons.extent.disabled = !cogBounds(item, "extent", serviceExtent3857);
    for (const key of ["view", "extent"] as CogArea[]) {
      areaButtons[key].style.cssText = key === area ? CSS.filterButtonActive : CSS.filterButton;
      areaButtons[key].setAttribute("aria-pressed", String(key === area));
    }
    if (areaButtons.extent.disabled) areaButtons.extent.style.opacity = "0.5";
    const bounds = cogBounds(item, area, serviceExtent3857);
    if (!bounds) {
      sizeLine.textContent = "";
      resolutionLine.textContent = "";
      downloadButton.disabled = true;
      return;
    }
    const size = exportImageSize(bounds, cappedLimits(limits));
    sizeLine.textContent = labels.cogSize(size.width, size.height);
    resolutionLine.textContent = labels.cogResolution(formatResolution(bounds, size.width));
    downloadButton.disabled = running;
  };

  for (const key of ["view", "extent"] as CogArea[]) {
    areaButtons[key].addEventListener("click", () => {
      if (area === key || areaButtons[key].disabled) return;
      area = key;
      refresh();
    });
  }

  const close = (): void => {
    inflight?.abort();
    inflight = null;
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    previouslyFocused?.focus?.();
    if (closeDetailsDialog === close) closeDetailsDialog = null;
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  cancelButton.addEventListener("click", close);

  downloadButton.addEventListener("click", () => {
    if (running) return;
    const bounds = cogBounds(item, area, serviceExtent3857);
    if (!bounds) return;
    if (!cogSaver) {
      status.textContent = labels.cogUnavailable;
      status.style.color = "hsl(var(--destructive))";
      return;
    }
    running = true;
    downloadButton.disabled = true;
    status.style.color = "hsl(var(--muted-foreground))";
    status.textContent = labels.cogDownloading;
    const controller = new AbortController();
    inflight = controller;
    void downloadCog(
      item,
      bounds,
      limits,
      (message) => {
        status.textContent = message;
      },
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.saved && result.size) {
          // Report the size actually delivered: the retry ladder may have
          // stepped it below what the dialog previewed.
          status.textContent = labels.cogDone(result.size.width, result.size.height);
          close();
        } else {
          // The user dismissed the save dialog; leave the modal open so the
          // download can be retried without re-opening it.
          status.textContent = "";
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        status.style.color = "hsl(var(--destructive))";
        status.textContent = labels.cogFailed(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        running = false;
        if (inflight === controller) inflight = null;
        if (overlay.isConnected) refresh();
      });
  });

  document.body.appendChild(overlay);
  downloadButton.focus();
  closeDetailsDialog = close;
  refresh();

  // The caps come from the service, so the first render uses the conservative
  // default and the sizes are corrected once the metadata lands.
  void fetchExportLimits(item).then((resolved) => {
    limits = resolved.limits;
    serviceExtent3857 = resolved.extent3857;
    if (overlay.isConnected) refresh();
  });
}

/** What a COG download produced: whether a file was written, and at what size. */
interface CogDownloadResult {
  saved: boolean;
  /** The size actually exported, which the retry ladder may have reduced. */
  size: { width: number; height: number } | null;
}

/**
 * Exports the area as a GeoTIFF and hands it to the host to be re-encoded as a
 * COG and saved.
 *
 * @returns Whether a file was written, and the size it was exported at
 * @throws When the export request fails or returns something other than a TIFF
 */
async function downloadCog(
  item: EarthdataGisItem,
  bbox3857: [number, number, number, number],
  limits: ExportLimits,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<CogDownloadResult> {
  if (!cogSaver) return { saved: false, size: null };
  let size = exportImageSize(bbox3857, cappedLimits(limits));
  let lastError: Error | null = null;

  // A service's declared caps are what it accepts as a parameter, not what it
  // can render: the Planet disaster imagery advertises 15000x4100 but times out
  // at 4096px and answers 503 at 4977px. Step the request down on failure so a
  // service that cannot manage the first size still yields a file.
  for (let attempt = 0; attempt < EXPORT_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) return { saved: false, size: null };
    const url = buildExportDownloadUrl(item, bbox3857, size, "tiff");
    if (!url) return { saved: false, size: null };
    if (attempt > 0) onProgress?.(labels.cogRetrying(size.width, size.height));
    try {
      const bytes = await fetchExport(url, signal);
      onProgress?.(labels.cogConverting);
      const saved = await cogSaver(bytes, exportFileName(item.title, "tif"));
      return { saved, size };
    } catch (error) {
      // A cancel is the user's decision, not a failure to retry or report.
      if (signal?.aborted) return { saved: false, size: null };
      lastError = error instanceof Error ? error : new Error(String(error));
      const next = nextExportSize(size, EXPORT_MIN_PIXELS);
      if (!next) break;
      size = next;
    }
  }
  throw lastError ?? new Error("the export could not be completed");
}

/**
 * Requests one export and returns its bytes, bounded by a timeout.
 *
 * @param url - The export request URL
 * @returns The GeoTIFF bytes
 * @throws With the service's own message when it reports an error, or a
 *   timeout/status message otherwise
 */
async function fetchExport(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  // One controller fed by both the per-attempt deadline and the caller's cancel,
  // so either can stop the request. (AbortSignal.any would do this, but it is
  // newer than the browsers this app still targets.)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPORT_ATTEMPT_TIMEOUT_MS);
  const onCancel = (): void => controller.abort();
  signal?.addEventListener("abort", onCancel);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (signal?.aborted) throw error;
      throw new Error("the service did not respond in time at this size");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCancel);
  }
  if (!response.ok) throw new Error(`the service returned ${response.status} at this size`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  // ArcGIS answers an invalid export with a JSON error envelope at HTTP 200, so
  // the TIFF byte-order marker is what actually confirms a raster came back.
  if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)) {
    return bytes;
  }
  throw new Error(
    arcgisErrorMessage(bytes) ?? "the service did not return a GeoTIFF for this area",
  );
}

/** Reads the message out of an ArcGIS JSON error body, when that is what came back. */
function arcgisErrorMessage(bytes: Uint8Array): string | null {
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes.slice(0, 4096))) as {
      error?: { message?: string };
    };
    return body.error?.message ?? null;
  } catch {
    return null;
  }
}

/** Clamps a service's declared caps to a size services actually render. */
function cappedLimits(limits: ExportLimits): ExportLimits {
  return {
    maxWidth: Math.min(limits.maxWidth, EXPORT_MAX_PIXELS),
    maxHeight: Math.min(limits.maxHeight, EXPORT_MAX_PIXELS),
  };
}

/** Merges extra metadata onto a store layer that was created elsewhere. */
function stampLayerMetadata(layerId: string, metadata: Record<string, unknown>): void {
  const store = useAppStore.getState();
  const layer = store.layers.find((candidate) => candidate.id === layerId);
  if (!layer) return;
  store.updateLayer(layerId, { metadata: { ...layer.metadata, ...metadata } });
}

/**
 * Resolves {@link fetchMinVisibleZoom} or gives up after
 * {@link VISIBILITY_LOOKUP_TIMEOUT_MS}, so a slow catalog query delays the add
 * by at most that long instead of stalling it.
 *
 * @param work - The in-flight visibility lookup
 * @returns The minimum visible zoom, or null on timeout or failure
 */
function withVisibilityTimeout(work: Promise<number | null>): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), VISIBILITY_LOOKUP_TIMEOUT_MS);
  });
  return Promise.race([work, deadline])
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

/**
 * Removes an item's layer from the store, if present. Removing a web map drops
 * every layer it contributed plus the group they were collected into, so the
 * Layers panel is left exactly as it was before the add.
 */
function removeFromMap(item: EarthdataGisItem): void {
  const store = useAppStore.getState();
  if (item.kind === "webmap") {
    const children = store.layers.filter(
      (candidate) => candidate.metadata.earthdataWebMapId === item.id,
    );
    const groupIds = new Set(
      children.map((child) => child.groupId).filter((id): id is string => Boolean(id)),
    );
    for (const child of children) store.removeLayer(child.id);
    for (const groupId of groupIds) store.removeLayerGroup(groupId);
    return;
  }
  const layerId = findAddedLayerId(item);
  if (layerId) store.removeLayer(layerId);
}

/** Composes the "kind · publisher · modified" subtitle line. */
function subtitle(item: EarthdataGisItem): string {
  return [kindLabel(item.kind), item.owner, item.modified].filter(Boolean).join(" · ");
}

/** Formats a bbox as a short, human-readable "W, S, E, N" string. */
function formatBbox(bbox: [number, number, number, number]): string {
  return bbox.map((n) => n.toFixed(3)).join(", ");
}

/** Reads the current map view as a valid [w, s, e, n] bbox. */
function currentBbox(): [number, number, number, number] | null {
  const map = appRef?.getMap?.();
  if (!map) return null;
  const bounds = map.getBounds();
  const clampLat = (n: number): number => Math.max(-90, Math.min(90, n));
  const normalizeLon = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180;
  const rawWest = bounds.getWest();
  const rawEast = bounds.getEast();
  let west = normalizeLon(rawWest);
  let east = normalizeLon(rawEast);
  // A view that wraps the globe or crosses the antimeridian cannot be expressed
  // as one non-inverted [-180, 180] box, so search the full longitude range
  // rather than sending the portal an inverted box that matches nothing.
  if (rawEast - rawWest >= 360 || west > east) {
    west = -180;
    east = 180;
  }
  return [west, clampLat(bounds.getSouth()), east, clampLat(bounds.getNorth())];
}

// ---------------------------------------------------------------------------
// Details dialog
// ---------------------------------------------------------------------------

/** Appends a labelled row to a metadata definition list. */
function addMetaRow(list: HTMLElement, label: string, value: string | HTMLElement | null): void {
  if (value == null || value === "") return;
  const row = document.createElement("div");
  row.style.cssText = "display:flex;flex-direction:column;gap:2px;";
  const term = document.createElement("div");
  term.style.cssText =
    "font-size:10px;text-transform:uppercase;letter-spacing:0.04em;" +
    "color:hsl(var(--muted-foreground));";
  term.textContent = label;
  const definition = document.createElement("div");
  definition.style.cssText = "font-size:12px;overflow-wrap:anywhere;white-space:pre-wrap;";
  if (typeof value === "string") definition.textContent = value;
  else definition.appendChild(value);
  row.append(term, definition);
  list.appendChild(row);
}

/** Builds an external link element, or null when the URL is not http(s). */
function externalLink(url: string, text: string): HTMLAnchorElement | null {
  if (!HTTP_URL_RE.test(url)) return null;
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = text;
  link.style.cssText = "color:hsl(var(--primary));text-decoration:underline;";
  return link;
}

/**
 * Opens a modal listing an item's metadata (curated fields plus the raw portal
 * record). Rendered into `document.body` so it overlays the whole app; closes on
 * the backdrop, the close button, or Escape. Only one is open at a time.
 */
function openDetailsModal(item: EarthdataGisItem): void {
  closeDetailsDialog?.();

  const overlay = document.createElement("div");
  // Captured before the dialog steals focus so closing can hand it back to the
  // card button that opened it, instead of dumping the user at the page top.
  const previouslyFocused = document.activeElement as HTMLElement | null;
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:2147483000;display:flex;" +
    "align-items:center;justify-content:center;padding:16px;" +
    "background:rgba(0,0,0,0.5);";

  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", labels.detailsHeading);
  dialog.tabIndex = -1;
  dialog.style.cssText =
    "display:flex;flex-direction:column;width:100%;max-width:560px;" +
    "max-height:80vh;border-radius:8px;overflow:hidden;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--background));" +
    "color:hsl(var(--foreground));box-shadow:0 10px 40px rgba(0,0,0,0.4);";

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;gap:8px;" +
    "padding:10px 12px;border-bottom:1px solid hsl(var(--border));";
  const heading = document.createElement("div");
  heading.style.cssText = "font-size:13px;font-weight:600;";
  heading.textContent = labels.detailsHeading;
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
  body.style.cssText = "display:flex;flex-direction:column;gap:10px;padding:12px;overflow-y:auto;";

  if (item.thumbnailUrl) {
    const image = document.createElement("img");
    image.src = item.thumbnailUrl;
    image.alt = item.title;
    image.loading = "lazy";
    image.style.cssText = "width:100%;max-height:180px;object-fit:cover;border-radius:6px;";
    image.addEventListener("error", () => image.remove());
    body.appendChild(image);
  }

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:8px;";
  addMetaRow(list, labels.metaTitle, item.title);
  addMetaRow(list, labels.metaType, kindLabel(item.kind));
  addMetaRow(list, labels.metaSummary, item.snippet);
  addMetaRow(list, labels.metaDescription, item.description);
  addMetaRow(list, labels.metaOwner, item.owner);
  addMetaRow(list, labels.metaModified, item.modified);
  addMetaRow(list, labels.metaTags, item.tags.join(", "));
  addMetaRow(list, labels.metaExtent, item.bbox ? formatBbox(item.bbox) : null);
  addMetaRow(list, labels.metaCredits, item.accessInformation);
  addMetaRow(list, labels.metaLicense, item.licenseInfo);
  addMetaRow(list, labels.metaService, externalLink(item.url, item.url));
  addMetaRow(list, labels.metaPortalItem, externalLink(item.itemPageUrl, item.itemPageUrl));
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
    pre.textContent = JSON.stringify(item.raw, null, 2);
  } catch {
    pre.textContent = String(item.raw);
  }
  details.append(summary, pre);
  body.appendChild(details);

  dialog.append(header, body);
  overlay.appendChild(dialog);

  const close = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    previouslyFocused?.focus?.();
    if (closeDetailsDialog === close) closeDetailsDialog = null;
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
  // Move focus inside so the dialog is reachable by keyboard and announced;
  // without this, Tab keeps walking the panel behind the overlay.
  closeButton.focus();
  closeDetailsDialog = close;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * Builds the search panel DOM. Returns a teardown that invalidates in-flight
 * searches, drops the store subscription, and closes any open dialog.
 */
function buildPanel(container: HTMLElement): () => void {
  container.innerHTML = "";
  container.style.cssText = CSS.panel;

  const searchRow = document.createElement("div");
  searchRow.style.cssText = CSS.searchRow;
  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = labels.searchPlaceholder;
  searchInput.setAttribute("aria-label", labels.searchPlaceholder);
  searchInput.style.cssText = CSS.searchInput;
  const searchButton = document.createElement("button");
  searchButton.type = "button";
  searchButton.textContent = labels.search;
  searchButton.style.cssText = CSS.primaryButton;
  searchRow.append(searchInput, searchButton);

  const filterBar = document.createElement("div");
  filterBar.style.cssText = CSS.filterBar;
  const filterButtons: Record<KindFilter, HTMLButtonElement> = {
    all: makeFilterButton(labels.filterAll),
    image: makeFilterButton(labels.filterImage),
    map: makeFilterButton(labels.filterMap),
    feature: makeFilterButton(labels.filterFeature),
    webmap: makeFilterButton(labels.filterWebMap),
  };
  filterBar.append(
    filterButtons.all,
    filterButtons.image,
    filterButtons.map,
    filterButtons.feature,
    filterButtons.webmap,
  );

  const viewRow = document.createElement("label");
  viewRow.style.cssText = CSS.checkboxRow;
  viewRow.title = labels.limitToViewTitle;
  const viewCheckbox = document.createElement("input");
  viewCheckbox.type = "checkbox";
  const viewCaption = document.createElement("span");
  viewCaption.textContent = labels.limitToView;
  viewRow.append(viewCheckbox, viewCaption);

  const status = document.createElement("div");
  status.style.cssText = CSS.status;
  status.textContent = labels.hint;

  const results = document.createElement("div");
  results.style.cssText = CSS.results;

  const moreButton = document.createElement("button");
  moreButton.type = "button";
  moreButton.textContent = labels.loadMore;
  moreButton.style.cssText = CSS.wideButton;
  moreButton.hidden = true;

  container.append(searchRow, filterBar, viewRow, status, results, moreButton);

  // Panel-local search state.
  let items: EarthdataGisItem[] = [];
  let total = 0;
  let nextStart: number | null = null;
  let filter: KindFilter = "all";
  // Generation counter to ignore results from a superseded search.
  let generation = 0;
  // Aborts the in-flight request when a newer search supersedes it.
  let inflight: AbortController | null = null;
  // Signature of which listed items are on the map, so the store subscription
  // can skip re-rendering when an unrelated part of the store changes.
  let addedSignature = "";

  const setStatus = (text: string, isError = false): void => {
    status.textContent = text;
    status.style.color = isError ? "hsl(var(--destructive))" : "hsl(var(--muted-foreground))";
  };

  const computeAddedSignature = (): string =>
    items
      .map((item) => `${item.id}:${isAdded(item) ? 1 : 0}:${pendingAdds.has(item.id) ? 1 : 0}`)
      .join(",");

  const clearResults = (): void => {
    results.innerHTML = "";
    moreButton.hidden = true;
  };

  const renderResults = (): void => {
    results.innerHTML = "";
    for (const item of items) {
      results.appendChild(
        buildCard(item, {
          openDetails: () => openDetailsModal(item),
          onAddError: (message) => setStatus(labels.addError(message), true),
          onHint: (hint) => setStatus(hint),
          onChanged: () => renderResults(),
        }),
      );
    }
    moreButton.hidden = nextStart === null;
    addedSignature = computeAddedSignature();
  };

  // Keep Add/Remove in sync when layers change elsewhere (e.g. the user deletes
  // an Earthdata GIS layer from the Layers panel).
  const unsubscribe = useAppStore.subscribe(() => {
    if (items.length === 0) return;
    if (computeAddedSignature() !== addedSignature) renderResults();
  });

  const kindsForFilter = (): readonly EarthdataServiceKind[] =>
    filter === "all" ? EARTHDATA_SERVICE_KINDS : [filter];

  const runSearch = async (reset: boolean): Promise<void> => {
    if (reset) {
      items = [];
      total = 0;
      nextStart = 1;
    }
    const start = nextStart;
    if (start === null) return;

    // Cancel any earlier request still in flight so it does not run to
    // completion against the portal.
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;

    const current = ++generation;
    setControlsDisabled(true);
    setStatus(reset ? labels.searching : labels.loadingMore);

    try {
      const result: EarthdataGisSearchResult = await searchEarthdataGis({
        terms: searchInput.value,
        kinds: kindsForFilter(),
        bbox: viewCheckbox.checked ? currentBbox() : null,
        num: EARTHDATA_GIS_PAGE_SIZE,
        start,
        signal: controller.signal,
      });
      if (current !== generation) return; // superseded
      items = [...items, ...result.items];
      total = result.total;
      nextStart = result.nextStart;
      if (items.length === 0) {
        setStatus(labels.noResults);
        clearResults();
      } else {
        setStatus(labels.showing(items.length, total));
        renderResults();
      }
    } catch (error) {
      if (current !== generation) return;
      // An aborted request is a superseded search, not a failure to report.
      if (error instanceof DOMException && error.name === "AbortError") return;
      const message = error instanceof Error ? error.message : "Search failed";
      setStatus(labels.searchError(message), true);
      // Keep already-loaded results on screen: a failed "Load more" should not
      // wipe a successful initial search or hide the retry button.
      if (items.length === 0) clearResults();
    } finally {
      if (current === generation) {
        setControlsDisabled(false);
        inflight = null;
      }
    }
  };

  function setControlsDisabled(disabled: boolean): void {
    searchButton.disabled = disabled;
    moreButton.disabled = disabled;
  }

  const showFilter = (next: KindFilter): void => {
    filter = next;
    for (const key of ["all", "image", "map", "feature", "webmap"] as KindFilter[]) {
      filterButtons[key].style.cssText = key === next ? CSS.filterButtonActive : CSS.filterButton;
      filterButtons[key].setAttribute("aria-pressed", String(key === next));
    }
  };

  for (const key of ["all", "image", "map", "feature", "webmap"] as KindFilter[]) {
    filterButtons[key].addEventListener("click", () => {
      if (filter === key) return;
      showFilter(key);
      void runSearch(true);
    });
  }

  searchButton.addEventListener("click", () => void runSearch(true));
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void runSearch(true);
    }
  });
  viewCheckbox.addEventListener("change", () => void runSearch(true));
  moreButton.addEventListener("click", () => void runSearch(false));

  showFilter("all");
  // Open on a populated catalog rather than an empty panel: the unfiltered
  // browse is newest-first, which is what a user landing here wants to see.
  void runSearch(true);

  return () => {
    // Invalidate any in-flight search so a late result cannot touch detached DOM.
    generation += 1;
    inflight?.abort();
    inflight = null;
    closeDetailsDialog?.();
    unsubscribe();
  };
}

/** Creates a segmented-control button for the type filter. */
function makeFilterButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.style.cssText = CSS.filterButton;
  return button;
}

/**
 * Builds one result card.
 *
 * A raster add/remove is synchronous, so the store subscription in
 * {@link buildPanel} rebuilds the list. A feature add is a network round-trip,
 * so the card drives its own progress state through `onChanged` and only
 * reports failures the store never sees.
 */
function buildCard(
  item: EarthdataGisItem,
  handlers: {
    openDetails: () => void;
    onAddError: (message: string) => void;
    onHint: (hint: string) => void;
    onChanged: () => void;
  },
): HTMLElement {
  const card = document.createElement("div");
  card.style.cssText = CSS.card;

  const thumb = document.createElement("div");
  thumb.style.cssText = CSS.thumb;
  if (item.thumbnailUrl) {
    const image = document.createElement("img");
    image.src = item.thumbnailUrl;
    image.alt = item.title;
    image.loading = "lazy";
    image.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
    image.addEventListener("error", () => {
      thumb.style.display = "none";
    });
    thumb.appendChild(image);
  } else {
    thumb.style.display = "none";
  }

  const title = document.createElement("div");
  title.style.cssText = CSS.title;
  title.textContent = item.title;
  title.title = item.snippet || item.title;

  const sub = document.createElement("div");
  sub.style.cssText = CSS.sub;
  sub.textContent = subtitle(item);
  sub.title = sub.textContent;

  const actions = document.createElement("div");
  actions.style.cssText = CSS.actions;

  const detailsButton = document.createElement("button");
  detailsButton.type = "button";
  detailsButton.textContent = labels.details;
  detailsButton.style.cssText = CSS.action;
  detailsButton.title = labels.detailsTitle;
  detailsButton.addEventListener("click", handlers.openDetails);

  // Opens through the host so the desktop build hands the URL to the system
  // browser instead of navigating the app's own webview away.
  const portalButton = document.createElement("button");
  portalButton.type = "button";
  portalButton.textContent = labels.portal;
  portalButton.style.cssText = CSS.action;
  portalButton.title = labels.portalTitle;
  portalButton.addEventListener("click", () => appRef?.openExternalUrl?.(item.itemPageUrl));

  // Only raster services have an export endpoint to re-encode; feature services
  // and web maps carry no pixels of their own.
  const cogButton =
    item.kind === "image" || item.kind === "map" ? document.createElement("button") : null;
  if (cogButton) {
    cogButton.type = "button";
    cogButton.textContent = labels.cog;
    cogButton.style.cssText = CSS.action;
    cogButton.title = labels.cogTitle;
    cogButton.addEventListener("click", () => openCogModal(item));
  }

  const added = isAdded(item);
  const pending = pendingAdds.has(item.id);
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.textContent = pending ? labels.adding : added ? labels.remove : labels.add;
  addButton.style.cssText = added ? CSS.actionActive : CSS.action;
  addButton.disabled = pending;
  addButton.title = added ? labels.removeTitle : labels.addTitle;
  addButton.addEventListener("click", () => {
    if (pendingAdds.has(item.id)) return;
    if (isAdded(item)) {
      removeFromMap(item);
      return;
    }
    pendingAdds.add(item.id);
    handlers.onChanged();
    addToMap(item, handlers.onHint)
      .catch((error: unknown) => {
        handlers.onAddError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        pendingAdds.delete(item.id);
        handlers.onChanged();
      });
  });

  const zoomButton = document.createElement("button");
  zoomButton.type = "button";
  zoomButton.textContent = labels.zoom;
  zoomButton.style.cssText = CSS.action;
  zoomButton.disabled = !item.bbox;
  zoomButton.title = item.bbox ? labels.zoomTitle : labels.zoomUnavailableTitle;
  zoomButton.addEventListener("click", () => {
    if (item.bbox) appRef?.fitBounds?.(item.bbox);
  });

  actions.append(detailsButton, portalButton, zoomButton, addButton);
  if (cogButton) actions.appendChild(cogButton);

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
export function setEarthdataGisLabels(next: Partial<EarthdataGisLabels>): void {
  labels = { ...labels, ...next };
  if (panelContainer) mountPanel(panelContainer);
}

/**
 * Earthdata GIS plugin: searches NASA's Earthdata GIS portal and adds its
 * ArcGIS imagery, map, and feature services to the map.
 */
export const maplibreEarthdataGisPlugin: GeoLibrePlugin = {
  id: EARTHDATA_GIS_PLUGIN_ID,
  name: "Earthdata GIS",
  version: "0.1.0",
  activate: (app: GeoLibreAppAPI) => {
    appRef = app;
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: "Earthdata GIS",
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
    // Both panel APIs above are optional-chained, so the host may never invoke
    // the render cleanup. Tear the panel down here too, or its store
    // subscription outlives deactivation and a later setEarthdataGisLabels
    // remounts into a detached container. Already-run cleanup leaves
    // disposePanel null, so this is a no-op in the normal case.
    disposePanel?.();
    disposePanel = null;
    panelContainer = null;
    closeDetailsDialog?.();
    pendingAdds.clear();
    appRef = null;
  },
};

export default maplibreEarthdataGisPlugin;
