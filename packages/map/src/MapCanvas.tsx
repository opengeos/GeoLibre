import {
  applyGroupEffects,
  applyMatchedSelection,
  createPointerElevationResolver,
  effectiveLayerRenderState,
  formatPixelValue,
  getActiveEllipsoid,
  IDENTIFY_ALL_LAYERS_ID,
  isDuckDBQueryLayer,
  isInlineImageValue,
  isPopupClickEnabled,
  isPopupHoverEnabled,
  isSafePopupUrl,
  NETCDF_IMAGE_SOURCE_KIND,
  PHOTO_FULL_PROPERTY,
  PHOTO_PROPERTY,
  resolveConfiguredPopupTitle,
  resolveLayerCapabilities,
  resolvePopupBody,
  resolvePopupRows,
  resolvePopupTitle,
  stringifyPopupValue,
  useAppStore,
  type FieldVisibility,
  type GeoLibreLayer,
  type LayerPopupConfig,
  type PointerElevationResolver,
  type PopupRow,
} from "@geolibre/core";
import * as maplibregl from "maplibre-gl";
import type { Feature, Polygon } from "geojson";
import { memo, useEffect, useMemo, useRef } from "react";
import {
  circleLayerId,
  fillExtrusionLayerId,
  fillLayerId,
  lineLayerId,
  markerLayerId,
} from "./geojson-loader";
import {
  externalExtrusionLayerId,
  mbtilesStyleLayerIds,
  vectorTileStyleLayerIds,
} from "./layer-sync";
import {
  FEATURE_SELECTION_EVENT,
  featuresIntersectingPolygon,
  keepsFeatureSelectionActive,
  selectionModeFromModifiers,
  suspendedCameraHandlers,
  type FeatureSelectionRequest,
  type FeatureSelectionShape,
} from "./feature-selection";
import { isGlobeControlToggleClick } from "./globe-control-toggle";
import { createGlobalIdentifyHitDeduper } from "./identify-all";
import { createMapController, type MapController } from "./map-controller";
import { createMapResizeScheduler } from "./map-resize";
import "maplibre-gl/dist/maplibre-gl.css";
import "maplibre-gl-layer-control/style.css";
import "./layer-control-overrides.css";

/**
 * Dispatched when a feature-selection gesture arms. `featureSelectionActive` is
 * a ref rather than store state, so the map overlays that must stand down for a
 * gesture (the hover tooltip) have nothing to subscribe to — a gesture armed
 * from a menu produces no pointer event, and a tip already open under a
 * motionless cursor would sit there until the first drag.
 */
const FEATURE_SELECTION_BEGIN_EVENT = "geolibre:feature-selection-begin";
const WMS_PROXY_PATH = "/__geolibre_wms_proxy";
const WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066;
const WEB_MERCATOR_EARTH_RADIUS = 6378137;
const WEB_MERCATOR_WORLD_SIZE = 2 * Math.PI * WEB_MERCATOR_EARTH_RADIUS;
const MAPLIBRE_TILE_SIZE = 512;
const WMS_IDENTIFY_QUERY_SIZE = 101;
const WMS_IDENTIFY_QUERY_CENTER = Math.floor(WMS_IDENTIFY_QUERY_SIZE / 2);
const WMS_IDENTIFY_INFO_FORMATS = ["application/json", "text/html", "text/plain"];
/**
 * Minimum screen distance, in pixels, between two vertices of a freehand
 * selection ring. Small enough that the traced outline still reads as a smooth
 * curve, large enough that a slow drag cannot grow the ring without bound.
 */
const FREEHAND_MIN_POINT_DISTANCE = 3;
/**
 * How close, in screen pixels, the two clicks a browser fires before `dblclick`
 * have to land to count as the same vertex. Small: it only has to absorb the
 * hand tremor within one double-click, never two deliberate vertices.
 */
const DOUBLE_CLICK_VERTEX_TOLERANCE = 2;
/**
 * Upper bound on the features a drawn selection will test on the main thread.
 * Mirrors MAX_CLIENT_PAIRS in @geolibre/processing's vector tools, which caps
 * the same kind of pairwise Turf loop so a very large layer cannot freeze the
 * tab; Select by expression and Select by location handle the bigger jobs.
 */
const MAX_SELECTION_SCAN_FEATURES = 250_000;

export interface MapCanvasProps {
  controllerRef?: React.MutableRefObject<MapController | null>;
  onMapDiagnosticEvent?: (event: MapDiagnosticEvent) => void;
  onControllerReady?: () => void;
  /**
   * Whether the status bar's elevation readout may fall back to the public
   * Open-Meteo service. Supplied by the app, which owns the persisted consent
   * flag; `@geolibre/map` has no opinion about consent storage.
   *
   * **Omitting it denies the remote lookup.** A privacy gate that fails open
   * would send coordinates off-device for any embedder that simply did not know
   * to pass a predicate. The terrain path is unaffected either way, since it
   * sends nothing anywhere.
   */
  canUseRemoteElevation?: () => boolean;
  /** Localized labels for the grouped, all-layer Identify popup. */
  identifyAllLabels?: MapCanvasIdentifyAllLabels;
  /** Reads app-owned raster layers for the grouped, all-layer Identify popup. */
  identifyRasterLayerAt?: MapCanvasRasterIdentify;
}

/** Text formatters used by the grouped, all-layer Identify popup. */
export interface MapCanvasIdentifyAllLabels {
  title: (count: number) => string;
  resultCount: (count: number) => string;
  featureFallback: (index: number) => string;
  pixel: string;
  expandAll: string;
  collapseAll: string;
  loadingTitle: string;
  loading: string;
  errorLabel: string;
  error: string;
}

/** One raster result supplied by the application to all-layer Identify. */
export interface MapCanvasRasterIdentifyResult {
  properties: Record<string, unknown>;
  title?: string;
}

/** Application bridge for raster sources owned outside `@geolibre/map`. */
export type MapCanvasRasterIdentify = (
  layer: GeoLibreLayer,
  lngLat: [number, number],
  options: { signal: AbortSignal },
) => Promise<MapCanvasRasterIdentifyResult | null>;

const DEFAULT_IDENTIFY_ALL_LABELS: MapCanvasIdentifyAllLabels = {
  title: (count) => `Identified results (${count})`,
  resultCount: (count) => `${count} ${count === 1 ? "result" : "results"}`,
  featureFallback: (index) => `Feature ${index}`,
  pixel: "Pixel",
  expandAll: "Expand all",
  collapseAll: "Collapse all",
  loadingTitle: "Identify visible layers",
  loading: "Loading...",
  errorLabel: "Error",
  error: "Could not identify this layer.",
};

export interface MapDiagnosticEvent {
  message: string;
  detail?: string;
  source?: string;
  status?: number;
  url?: string;
}

interface DuckDBIdentifyBridgeResult {
  coordinate: [number, number] | null;
  featureId: string;
  properties: Record<string, unknown>;
}

interface GeoLibreDuckDBBridge {
  getFeatureBounds?: (
    layerId: string,
    featureId: string,
  ) => [number, number, number, number] | null;
  identifyLayerAtPoint?: (
    layerId: string,
    point: { x: number; y: number },
  ) => DuckDBIdentifyBridgeResult | null;
  setSelectedFeature?: (layerId: string, featureId: string | null) => void;
}

/** One band's value at an identified pixel, from the Time Slider bridge. */
interface TimeSliderBandReading {
  index: number;
  name: string | null;
  value: number;
  isNodata: boolean;
}

interface TimeSliderPixelIdentifyBridgeResult {
  sourceId: string;
  date: string;
  url: string;
  bands: TimeSliderBandReading[];
}

interface GeoLibreTimeSliderBridge {
  identifyPixelAt?: (
    sourceId: string,
    lngLat: [number, number],
    options?: { signal?: AbortSignal },
  ) => Promise<TimeSliderPixelIdentifyBridgeResult | null>;
}

/**
 * The author's popup design for a layer, plus what the renderer needs to apply
 * it. Every field is optional: the WMS, pixel and status popups pass none of
 * it and get exactly the rendering they always had.
 */
interface IdentifyPopupOptions {
  popup?: LayerPopupConfig;
  fieldVisibility?: Record<string, FieldVisibility>;
  /** The real feature, when the caller has one — feeds geometry-aware expressions. */
  feature?: Feature | null;
  /** Map zoom for `["zoom"]` in the title/body expressions. */
  zoom?: number;
}

/** The document language, so formatted numbers and dates follow the UI locale. */
function documentLocale(): string | undefined {
  const lang = typeof document !== "undefined" ? document.documentElement.lang.trim() : "";
  return lang || undefined;
}

/**
 * Draw one resolved value into its cell. `"auto"` keeps the historical
 * behavior (sanitized KML description markup, inline base64 images as
 * thumbnails, everything else as text); the explicit kinds render what the
 * author asked for, and fall back to text when the value cannot support it
 * (a `link` whose value is not an http(s) URL, an `image` that is not one).
 */
function renderPopupValue(cell: HTMLElement, row: PopupRow): void {
  if (row.kind === "image") {
    if (isSafePopupUrl(row.value, true)) {
      const image = document.createElement("img");
      // Trimmed, because that is the copy isSafePopupUrl actually validated —
      // as in the link branch below.
      image.src = row.value.trim();
      image.alt = row.label;
      image.loading = "lazy";
      image.className = "max-h-40 max-w-full rounded";
      cell.appendChild(image);
      return;
    }
    cell.textContent = row.text;
    return;
  }

  if (row.kind === "link") {
    if (isSafePopupUrl(row.value)) {
      const link = document.createElement("a");
      link.href = row.value.trim();
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "break-all underline";
      link.textContent = row.linkLabel ?? row.text;
      cell.appendChild(link);
      return;
    }
    cell.textContent = row.text;
    return;
  }

  if (row.kind === "auto") {
    // Render known KML description structures as sanitized markup. Requiring a
    // supported tag keeps ordinary text such as "Elevation <500m>" intact.
    if (
      row.field === "description" &&
      typeof row.value === "string" &&
      /<(?:a|b|br|div|em|i|p|span|strong|table|tbody|td|th|thead|tr)\b/i.test(row.value)
    ) {
      appendSanitizedKmlDescription(cell, row.value);
      return;
    }
    // Render inline image data URLs (e.g. a geotagged-photo or field-collection
    // thumbnail) as an actual thumbnail rather than a multi-kilobyte string.
    // Match base64 raster images only, excluding SVG (which can carry scripts)
    // so an untrusted GeoJSON value can't smuggle one in.
    if (isInlineImageValue(row.value)) {
      const image = document.createElement("img");
      image.src = row.value;
      image.alt = row.field;
      image.loading = "lazy";
      image.className = "max-h-40 max-w-full rounded";
      cell.appendChild(image);
      return;
    }
  }

  cell.textContent = row.text;
}

function createIdentifyPopupElement(
  layerName: string,
  properties: Record<string, unknown>,
  featureId?: string | number,
  options: IdentifyPopupOptions = {},
): HTMLElement {
  const { popup, fieldVisibility, feature, zoom } = options;

  const root = document.createElement("div");
  root.className =
    "geolibre-identify-popup-root flex min-w-[min(18rem,calc(100vw-48px))] max-w-[min(520px,calc(100vw-48px))] flex-col text-xs";

  const title = document.createElement("div");
  // Leave room for MapLibre's close button, which sits in the same corner the
  // heading would otherwise run into.
  title.className = "mb-2 pe-6 font-semibold text-foreground";
  title.textContent = resolvePopupTitle(layerName, properties, popup, {
    feature,
    zoom,
    fieldVisibility,
  });
  root.appendChild(title);

  root.appendChild(createIdentifyPopupRows(properties, featureId, options));

  return root;
}

/** Build the attribute rows shared by per-layer and all-layer Identify popups. */
function createIdentifyPopupRows(
  properties: Record<string, unknown>,
  featureId?: string | number,
  options: IdentifyPopupOptions = {},
  scrollable = true,
): HTMLElement {
  const { popup, fieldVisibility, feature, zoom } = options;
  const locale = documentLocale();

  const rows = document.createElement("div");
  rows.className = scrollable ? "geolibre-identify-popup-rows pe-2" : "pe-2";

  // An author-supplied body expression replaces the whole body outright — the
  // field table AND the synthetic id row. The point of it is a sentence
  // instead of rows, and a raw feature id dangling under that sentence would
  // undo it. The designer disables the "Show the feature id row" checkbox
  // while a body expression is set, so the UI does not offer a control that
  // cannot take effect.
  const body = resolvePopupBody(properties, popup, { feature, zoom, fieldVisibility });
  if (body !== null) {
    const paragraph = document.createElement("div");
    paragraph.className = "whitespace-pre-wrap break-words text-foreground";
    paragraph.textContent = body;
    rows.appendChild(paragraph);
    return rows;
  }

  const appendRow = (row: PopupRow) => {
    const rowElement = document.createElement("div");
    rowElement.className = "grid grid-cols-[minmax(5rem,0.45fr)_1fr] gap-2 border-t py-1";

    const keyCell = document.createElement("div");
    keyCell.className = "break-words font-medium text-muted-foreground";
    keyCell.textContent = row.label;

    const valueCell = document.createElement("div");
    valueCell.className = "break-words text-foreground";
    renderPopupValue(valueCell, row);

    rowElement.append(keyCell, valueCell);
    rows.appendChild(rowElement);
  };

  const showFeatureId = featureId != null && popup?.showFeatureId !== false;
  if (showFeatureId) {
    appendRow({
      field: "id",
      label: "id",
      value: featureId,
      text: stringifyPopupValue(featureId),
      kind: "auto",
    });
  }

  // resolvePopupRows drops GeoLibre's internal columns and the heavy
  // full-resolution photo twin, and applies the author's field list, order,
  // labels and formatting. Its result is empty for a feature with nothing to
  // show, which is what the "No attributes" state reports.
  const resolved = resolvePopupRows(properties, {
    popup,
    fieldVisibility,
    locale,
  });
  if (resolved.length === 0 && !showFeatureId) {
    const empty = document.createElement("div");
    empty.className = "text-muted-foreground";
    empty.textContent = "No attributes";
    rows.appendChild(empty);
  } else {
    for (const row of resolved) appendRow(row);
  }

  return rows;
}

interface GlobalIdentifyHit {
  layer: GeoLibreLayer;
  properties: Record<string, unknown>;
  feature?: maplibregl.MapGeoJSONFeature;
  featureId: string | null;
  title?: string;
}

/**
 * Build the all-layer Identify result, grouped by owning GeoLibre layer.
 *
 * @param hits Rendered feature hits in topmost-first map order.
 * @param zoom Current map zoom for expression-backed popup formatting.
 * @param onActivate Selects the owning layer and feature in the application.
 * @returns Popup DOM containing every grouped hit and its visible attributes.
 */
function createGlobalIdentifyPopupElement(
  hits: GlobalIdentifyHit[],
  zoom: number,
  onActivate: (hit: GlobalIdentifyHit) => void,
  labels: MapCanvasIdentifyAllLabels,
): HTMLElement {
  const root = document.createElement("div");
  root.className =
    "geolibre-identify-popup-root flex min-w-[min(18rem,calc(100vw-48px))] max-w-[min(520px,calc(100vw-48px))] flex-col text-xs";

  const title = document.createElement("div");
  title.className = "font-semibold text-foreground";
  title.textContent = labels.title(hits.length);
  const header = document.createElement("div");
  header.className = "mb-2 flex shrink-0 items-center justify-between gap-3 pe-10";
  const actions = document.createElement("div");
  actions.className = "flex shrink-0 items-center gap-1";
  const detailsElements: HTMLDetailsElement[] = [];
  const createToggleAllButton = (text: string, open: boolean) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "rounded border px-1.5 py-0.5 font-normal text-muted-foreground hover:bg-muted hover:text-foreground";
    button.textContent = text;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      for (const details of detailsElements) details.open = open;
    });
    return button;
  };
  actions.append(
    createToggleAllButton(labels.expandAll, true),
    createToggleAllButton(labels.collapseAll, false),
  );
  header.append(title, actions);
  root.appendChild(header);

  // Only the results scroll. Scrolling `root` instead would run the scrollbar
  // up the full popup height, and a sticky header painted over MapLibre's own
  // close button — which lives outside this element and takes no stacking
  // order from it.
  const body = document.createElement("div");
  body.className = "geolibre-identify-popup-groups";
  root.appendChild(body);

  const groups = new Map<string, GlobalIdentifyHit[]>();
  for (const hit of hits) {
    const group = groups.get(hit.layer.id);
    if (group) group.push(hit);
    else groups.set(hit.layer.id, [hit]);
  }

  for (const groupHits of groups.values()) {
    const { layer } = groupHits[0];
    const section = document.createElement("details");
    section.className = "group border-t py-2 first:border-t-0 first:pt-0";
    section.open = true;
    detailsElements.push(section);

    const layerButton = document.createElement("summary");
    layerButton.className =
      "mb-1 flex w-full cursor-pointer list-none items-center justify-between gap-3 rounded px-1 py-1 text-start font-semibold text-foreground hover:bg-muted [&::-webkit-details-marker]:hidden";
    const layerName = document.createElement("span");
    layerName.className = "min-w-0 break-words";
    layerName.textContent = layer.name;
    const count = document.createElement("span");
    count.className = "shrink-0 font-normal text-muted-foreground";
    count.textContent = labels.resultCount(groupHits.length);
    layerButton.append(layerName, count);
    layerButton.addEventListener("click", (event) => {
      event.stopPropagation();
      onActivate(groupHits[0]);
    });
    section.appendChild(layerButton);

    for (const [index, hit] of groupHits.entries()) {
      const featureContainer = document.createElement("div");
      featureContainer.className = "mb-2 rounded border bg-background/60 p-2 last:mb-0";
      const configuredTitle = hit.feature
        ? resolveConfiguredPopupTitle(hit.properties, layer.popup, {
            feature: hit.feature,
            zoom,
            fieldVisibility: layer.fieldVisibility,
          })
        : null;
      const featureButton = document.createElement("button");
      featureButton.type = "button";
      featureButton.className =
        "mb-1 w-full break-words text-start font-medium text-foreground hover:underline";
      featureButton.textContent = configuredTitle ?? hit.title ?? labels.featureFallback(index + 1);
      featureButton.addEventListener("click", (event) => {
        event.stopPropagation();
        onActivate(hit);
      });
      featureContainer.appendChild(featureButton);
      featureContainer.appendChild(
        createIdentifyPopupRows(
          hit.properties,
          hit.featureId ?? undefined,
          {
            popup: layer.popup,
            fieldVisibility: layer.fieldVisibility,
            feature: hit.feature,
            zoom,
          },
          false,
        ),
      );
      section.appendChild(featureContainer);
    }
    body.appendChild(section);
  }

  return root;
}

/**
 * The hover tooltip's content: the layer's popup title over the fields the
 * author flagged for hover. Kept deliberately small — this follows the pointer,
 * so it shows the one or two fields that name the feature, never the table.
 */
function createHoverTooltipElement(
  layerName: string,
  properties: Record<string, unknown>,
  options: IdentifyPopupOptions = {},
): HTMLElement | null {
  const { popup, fieldVisibility, feature, zoom } = options;
  const rows = resolvePopupRows(properties, {
    popup,
    fieldVisibility,
    hover: true,
    locale: documentLocale(),
  });
  const configuredTitle = resolveConfiguredPopupTitle(properties, popup, {
    feature,
    zoom,
    fieldVisibility,
  });
  // Nothing to say: no flagged field, and no title the author configured, so
  // the tip would be a box repeating the layer name the user can already read
  // in the Layers panel. Keyed on whether a title was configured rather than on
  // whether it happens to equal the layer name — a feature legitimately called
  // the same thing as its layer still deserves its tooltip.
  if (rows.length === 0 && configuredTitle === null) return null;
  const title = configuredTitle ?? layerName;

  const root = document.createElement("div");
  root.className = "geolibre-hover-tooltip-root flex max-w-[16rem] flex-col gap-0.5 text-xs";

  const heading = document.createElement("div");
  heading.className = "font-semibold text-foreground";
  heading.textContent = title;
  root.appendChild(heading);

  for (const row of rows) {
    const line = document.createElement("div");
    line.className = "flex gap-1.5 text-foreground";
    const label = document.createElement("span");
    label.className = "shrink-0 text-muted-foreground";
    label.textContent = row.label;
    const value = document.createElement("span");
    value.className = "min-w-0 break-words";
    // A tooltip is a one-line read, so a link shows as its text rather than as
    // a clickable anchor — the tip has `pointer-events: none` and could not be
    // clicked anyway. Image rows never reach here: resolvePopupRows drops them
    // from the hover subset rather than printing a data URL.
    value.textContent = row.text;
    line.append(label, value);
    root.appendChild(line);
  }

  return root;
}

const KML_DESCRIPTION_TAGS = new Set([
  "a",
  "b",
  "br",
  "div",
  "em",
  "i",
  "p",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
]);

/** Render useful KML description markup while dropping scripts and attributes. */
function appendSanitizedKmlDescription(target: HTMLElement, html: string): void {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const copy = (node: Node, parent: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendChild(document.createTextNode(node.textContent ?? ""));
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.localName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "head" || tag === "meta") return;
    if (!KML_DESCRIPTION_TAGS.has(tag)) {
      for (const child of node.childNodes) copy(child, parent);
      return;
    }
    const element = document.createElement(tag);
    if (tag === "a") {
      const href = node.getAttribute("href")?.trim();
      if (href && /^(https?:|mailto:)/i.test(href)) {
        element.setAttribute("href", href);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      }
    }
    for (const child of node.childNodes) copy(child, element);
    parent.appendChild(element);
  };
  const content = document.createElement("div");
  content.className = "geolibre-kml-description";
  for (const child of parsed.body.childNodes) copy(child, content);
  target.appendChild(content);
}

function createIdentifyMessagePopupElement(layerName: string, message: string): HTMLElement {
  return createIdentifyPopupElement(layerName, { status: message });
}

// Feature-property keys for geotagged/field-collection photos, from the shared
// @geolibre/core schema: the popup shows the light thumbnail while the fullscreen
// viewer and "Save image" use the embedded full-resolution image.
const PHOTO_THUMBNAIL_KEY = PHOTO_PROPERTY;
const PHOTO_FULL_KEY = PHOTO_FULL_PROPERTY;

/** Return the value at `key` when it is an inline raster image data URL. */
function imageDataUrlAt(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key];
  return isInlineImageValue(value) ? value : null;
}

/**
 * Find the first feature property holding an inline raster image (a geotagged
 * photo or field-collection thumbnail), returning its data URL or null. The
 * full-resolution key is skipped so this fallback never returns the heavy
 * original as if it were the light thumbnail (e.g. for a hand-edited feature
 * whose `photo` thumbnail is missing but `photo_full` is present).
 */
function findPhotoDataUrl(properties: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(properties)) {
    if (key !== PHOTO_FULL_KEY && isInlineImageValue(value)) {
      return value;
    }
  }
  return null;
}

/** How far past native resolution the fullscreen viewer can magnify (400%). */
const PHOTO_MAX_ZOOM_FRACTION = 4;
/** Per-wheel-notch zoom step. */
const PHOTO_ZOOM_STEP = 1.15;

/**
 * Open a photo in a fullscreen lightbox: a backdrop overlay with the image
 * centered and scaled to fit. The mouse wheel zooms in on the photo (up to 400%
 * of its native resolution) and, once zoomed past the fit, dragging pans it; a
 * badge reports the current zoom as a percentage of native resolution alongside
 * the source pixel dimensions. Uses the native Fullscreen API so it fills the
 * whole screen, falling back to a viewport-filling overlay where fullscreen is
 * denied. Closes on the × button, a backdrop click, or Escape (double-click
 * toggles zoom rather than closing), or when the user leaves native fullscreen.
 *
 * @param src - The image data URL or URL (native resolution where available).
 * @param alt - Accessible label for the image.
 */
function openPhotoFullscreen(src: string, alt: string): void {
  const overlay = document.createElement("div");
  overlay.className = "geolibre-photo-fullscreen";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", alt);

  const image = document.createElement("img");
  image.src = src;
  image.alt = alt;
  image.className = "geolibre-photo-fullscreen-img";
  overlay.appendChild(image);

  const badge = document.createElement("div");
  badge.className = "geolibre-photo-fullscreen-badge";
  badge.setAttribute("aria-hidden", "true");
  overlay.appendChild(badge);

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "geolibre-photo-fullscreen-close";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.textContent = "×";
  overlay.appendChild(closeButton);

  document.body.appendChild(overlay);
  // Move focus into the lightbox so keyboard and screen-reader users land on a
  // control inside it (and Escape/Enter act on the close button by default).
  closeButton.focus();

  // Zoom is a multiple of the fit-to-screen size (1 = fit). `tx`/`ty` translate
  // the image while panning a zoomed photo.
  let zoom = 1;
  let tx = 0;
  let ty = 0;
  // Set once the image loads: the fit-size-to-native ratio (so the badge can
  // report zoom as a fraction of native), and the fit and max zoom multiples.
  let fitToNative = 1;
  let maxZoom = PHOTO_MAX_ZOOM_FRACTION;

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

  const applyTransform = () => {
    // Bound the pan so the image can't be dragged fully off-screen: the image is
    // centered, so keeping |tx|/|ty| within half its scaled size guarantees the
    // viewport centre always sits on the photo (and its double-click-to-reset
    // target stays reachable). clientWidth/Height are the fit-rendered size.
    const maxTx = (image.clientWidth * zoom) / 2;
    const maxTy = (image.clientHeight * zoom) / 2;
    tx = clamp(tx, -maxTx, maxTx);
    ty = clamp(ty, -maxTy, maxTy);
    image.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
    image.classList.toggle("is-zoomed", zoom > 1.001);
    const nativePercent = Math.round(fitToNative * zoom * 100);
    badge.textContent =
      image.naturalWidth > 0
        ? `${nativePercent}% · ${image.naturalWidth} × ${image.naturalHeight}`
        : "";
  };

  const measure = () => {
    // clientWidth is the fit-rendered width (max-width/height:100%, aspect kept);
    // dividing by naturalWidth gives how much of native the fit view shows.
    fitToNative =
      image.naturalWidth > 0 && image.clientWidth > 0 ? image.clientWidth / image.naturalWidth : 1;
    // Cap magnification at PHOTO_MAX_ZOOM_FRACTION of native. The floor of 1
    // only guards the degenerate case where the image is somehow larger than the
    // fit (fitToNative > cap) so zoom never drops below the fit; in the normal
    // case (fitToNative <= 1, no upscaling) this is always the native-cap branch,
    // keeping the badge at exactly 400% of native at maximum zoom.
    maxZoom = Math.max(1, PHOTO_MAX_ZOOM_FRACTION / fitToNative);
    // A resize (or entering fullscreen) can grow the fit ratio and shrink
    // maxZoom below the current zoom; reclamp so the 400%-of-native cap holds
    // instead of rendering (and reporting) a now-out-of-range zoom.
    zoom = clamp(zoom, 1, maxZoom);
    if (zoom === 1) {
      tx = 0;
      ty = 0;
    }
    applyTransform();
  };
  if (image.complete && image.naturalWidth > 0) measure();
  else image.addEventListener("load", measure, { once: true });
  // The fit size (and thus the native-zoom ratio and 400% cap) depends on the
  // viewport, which changes when the browser window resizes or the viewer
  // enters/leaves native fullscreen, so remeasure on both.
  const onResize = () => measure();
  window.addEventListener("resize", onResize);

  const setZoom = (next: number) => {
    zoom = clamp(next, 1, maxZoom);
    if (zoom <= 1.001) {
      // Back at fit: recenter so a later zoom-in starts from the middle.
      zoom = 1;
      tx = 0;
      ty = 0;
    }
    applyTransform();
  };

  overlay.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      setZoom(zoom * (event.deltaY < 0 ? PHOTO_ZOOM_STEP : 1 / PHOTO_ZOOM_STEP));
    },
    { passive: false },
  );

  // Pan (one pointer) and pinch-zoom (two pointers). Touch devices have no
  // wheel, and `touch-action: none` disables native pinch, so drive the same
  // zoom/pan transform from raw pointer events here.
  const activePointers = new Map<number, { x: number; y: number }>();
  let lastX = 0;
  let lastY = 0;
  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  const pointerSpread = () => {
    const [a, b] = [...activePointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  image.addEventListener("pointerdown", (event) => {
    // Track at most two pointers; a third (e.g. an accidental palm touch) is
    // ignored so it can't perturb the pan anchor or the pinch spread.
    if (activePointers.size >= 2) return;
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    // Arm pan/pinch state before capturing the pointer: setPointerCapture can
    // throw for a non-active pointer, and that must not skip the setup below.
    if (activePointers.size === 2) {
      pinchStartDist = pointerSpread();
      pinchStartZoom = zoom;
    } else {
      lastX = event.clientX;
      lastY = event.clientY;
    }
    try {
      image.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is already gone; pan/pinch still work without capture.
    }
    // Only suppress the default for a mouse drag while zoomed, to stop the native
    // image ghost-drag during a pan. Touch gestures are already neutralized by
    // `touch-action: none` on the image, so we must NOT preventDefault there: on
    // pointerdown that would suppress the compatibility events a double-tap's
    // dblclick is synthesized from, breaking double-tap-to-zoom on touch. A plain
    // mouse click at fit is likewise left untouched so mouse double-click works.
    if (event.pointerType === "mouse" && zoom > 1) {
      event.preventDefault();
    }
  });
  image.addEventListener("pointermove", (event) => {
    if (!activePointers.has(event.pointerId)) return;
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.size >= 2) {
      const spread = pointerSpread();
      // Re-anchor if the initial spread was zero (both fingers landed on the
      // same spot), so pinch isn't stuck disabled for the rest of the gesture.
      if (pinchStartDist <= 0) {
        pinchStartDist = spread;
        pinchStartZoom = zoom;
      } else {
        setZoom((pinchStartZoom * spread) / pinchStartDist);
      }
      return;
    }
    // Single-pointer pan, only meaningful once zoomed past the fit.
    if (zoom <= 1) return;
    tx += event.clientX - lastX;
    ty += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    applyTransform();
  });
  const endPointer = (event: PointerEvent) => {
    if (!activePointers.delete(event.pointerId)) return;
    if (image.hasPointerCapture(event.pointerId)) {
      image.releasePointerCapture(event.pointerId);
    }
    // Dropping from a pinch back to one finger: resume panning from the survivor
    // so the image doesn't jump on the next move.
    const [survivor] = [...activePointers.values()];
    if (survivor) {
      lastX = survivor.x;
      lastY = survivor.y;
    }
  };
  image.addEventListener("pointerup", endPointer);
  image.addEventListener("pointercancel", endPointer);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener("resize", onResize);
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    if (document.fullscreenElement === overlay) {
      void document.exitFullscreen().catch(() => {});
    }
    overlay.remove();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  const onFullscreenChange = () => {
    if (document.fullscreenElement === overlay) {
      // Entering fullscreen changes the rendered fit size; remeasure so the
      // badge percentage and the 400%-of-native cap track the new layout.
      requestAnimationFrame(measure);
    } else {
      // Leaving native fullscreen (Esc / F11) should also dismiss the overlay.
      close();
    }
  };

  closeButton.addEventListener("click", close);
  // Click the backdrop (but not the image) to dismiss.
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  // Double-click toggles between fit and 100% of native (or max, if native is
  // beyond the cap), rather than closing, so the viewer stays a zoom surface.
  image.addEventListener("dblclick", (event) => {
    event.preventDefault();
    setZoom(zoom > 1.001 ? 1 : Math.min(1 / fitToNative, maxZoom));
  });
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("fullscreenchange", onFullscreenChange);

  // Best-effort true fullscreen; the overlay already fills the viewport if the
  // request is unsupported or denied (e.g. inside a sandboxed embed).
  void overlay.requestFullscreen?.().catch(() => {});
}

/**
 * Build the geotagged-photo popup: a resizable box showing the photo scaled to
 * fill it, captioned with the photo's name and timestamp. The box uses CSS
 * `resize` so the user can drag its corner to enlarge the photo, and
 * double-clicking the photo opens it fullscreen. Photos with no thumbnail (e.g.
 * HEIC) fall back to a "No preview available" note.
 *
 * @param properties - The clicked feature's properties.
 * @returns The popup's DOM content element.
 */
function createPhotoPopupElement(properties: Record<string, unknown>): HTMLElement {
  const root = document.createElement("div");
  root.className = "geolibre-photo-popup";

  // The popup shows the light thumbnail; the fullscreen viewer prefers the
  // embedded full-resolution image (falling back to the thumbnail when no
  // original was embedded, e.g. a format that can't be shown at full size).
  const thumbnail = imageDataUrlAt(properties, PHOTO_THUMBNAIL_KEY) ?? findPhotoDataUrl(properties);
  if (thumbnail) {
    // Prefer the embedded full-resolution image, falling back to the thumbnail
    // when no original was embedded (TIFF/HEIC, mislabeled bytes, or an original
    // over the size ceiling); `thumbnail` is non-null here, so this is a string.
    const fullImage = imageDataUrlAt(properties, PHOTO_FULL_KEY);
    const fullResolution = fullImage ?? thumbnail;
    const image = document.createElement("img");
    image.src = thumbnail;
    image.alt = typeof properties.name === "string" ? properties.name : "Photo";
    image.className = "geolibre-photo-popup-img";
    // Only promise "full resolution" when the native original is actually
    // embedded; otherwise the double-click just opens the thumbnail fullscreen.
    image.title = fullImage
      ? "Double-click to view at full resolution"
      : "Double-click to view fullscreen";
    // Double-click (not single, so it never fights the resize drag) opens the
    // photo fullscreen. The image is popup DOM, not the map canvas, so this does
    // not trigger MapLibre's double-click zoom.
    image.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      openPhotoFullscreen(fullResolution, image.alt);
    });
    root.appendChild(image);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "geolibre-photo-popup-placeholder";
    placeholder.textContent = "No preview available";
    root.appendChild(placeholder);
  }

  const caption = [properties.name, properties.timestamp]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" · ");
  if (caption) {
    const captionEl = document.createElement("div");
    captionEl.className = "geolibre-photo-popup-caption";
    captionEl.textContent = caption;
    captionEl.title = caption;
    root.appendChild(captionEl);
  }

  return root;
}

function nativeIdentifyLayerIds(layer: GeoLibreLayer): string[] {
  const nativeLayerIds = layer.metadata.nativeLayerIds;
  return Array.isArray(nativeLayerIds)
    ? nativeLayerIds.filter((id): id is string => typeof id === "string")
    : [];
}

function identifyStyleLayerIds(layer: GeoLibreLayer): string[] {
  return [
    ...nativeIdentifyLayerIds(layer),
    ...nativeIdentifyLayerIds(layer).map(externalExtrusionLayerId),
    ...mbtilesStyleLayerIds(layer),
    markerLayerId(layer.id),
    circleLayerId(layer.id),
    lineLayerId(layer.id),
    fillExtrusionLayerId(layer.id),
    fillLayerId(layer.id),
    ...vectorTileStyleLayerIds(layer),
  ];
}

function findFeatureId(layer: GeoLibreLayer, feature: maplibregl.MapGeoJSONFeature): string | null {
  if (feature.id != null) return String(feature.id);
  if (!layer.geojson) return null;

  const properties = feature.properties ?? {};
  const propertyKeys = Object.keys(properties);
  const index = layer.geojson.features.findIndex((candidate) => {
    const candidateProperties = candidate.properties ?? {};
    return propertyKeys.every((key) => candidateProperties[key] === properties[key]);
  });

  return index >= 0 ? String(layer.geojson.features[index].id ?? index) : null;
}

function isWmsLayer(layer: GeoLibreLayer): boolean {
  return layer.type === "wms";
}

/**
 * The features to highlight for the current selection: the full multi-select
 * set when present, otherwise the single anchor (or none). Shared by the
 * selection effect and the map/basemap style-load handlers so a style reload
 * never collapses a multi-selection down to its anchor.
 */
function resolveHighlightIds(state: {
  selectedFeatureIds: string[];
  selectedFeatureId: string | null;
}): string[] {
  if (state.selectedFeatureIds.length > 0) return state.selectedFeatureIds;
  return state.selectedFeatureId ? [state.selectedFeatureId] : [];
}

function duckDBBridge(): GeoLibreDuckDBBridge | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as Window & { __GEOLIBRE_DUCKDB__?: GeoLibreDuckDBBridge }).__GEOLIBRE_DUCKDB__;
}

function timeSliderBridge(): GeoLibreTimeSliderBridge | undefined {
  return typeof window === "undefined"
    ? undefined
    : (
        window as Window & {
          __GEOLIBRE_TIME_SLIDER__?: GeoLibreTimeSliderBridge;
        }
      ).__GEOLIBRE_TIME_SLIDER__;
}

/**
 * Whether Identify should read source pixel values for this layer rather than
 * query vector features. Set by the Time Slider for its COG/mosaic sources,
 * which resolve to a different file per timeline date.
 */
function isPixelIdentifyLayer(layer: GeoLibreLayer): boolean {
  return layer.metadata.pixelIdentify === true;
}

/** Turn a pixel reading into the flat key/value rows the identify popup shows. */
function pixelIdentifyProperties(
  result: TimeSliderPixelIdentifyBridgeResult,
): Record<string, unknown> {
  const properties: Record<string, unknown> = { Date: result.date };
  for (const band of result.bands) {
    // Prefer the COG's own band name, falling back to the 1-based index so
    // unnamed bands still get a stable, distinct row label.
    const key = band.name ?? `Band ${band.index}`;
    const formatted = formatPixelValue(band.value);
    properties[key] = band.isNodata ? `${formatted} (nodata)` : formatted;
  }
  return properties;
}

function stringSource(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function appendWmsQuery(endpoint: string, params: Array<[string, string]>): string {
  // Prefer URL parsing so our control parameters override any duplicates the
  // endpoint already carries (e.g. a pasted GetMap URL) and land before any
  // fragment, which the browser would otherwise strip along with the query.
  try {
    const url = new URL(endpoint);
    const controlKeys = new Set(params.map(([key]) => key.toLowerCase()));
    for (const existing of [...url.searchParams.keys()]) {
      if (controlKeys.has(existing.toLowerCase())) {
        url.searchParams.delete(existing);
      }
    }
    for (const [key, value] of params) {
      url.searchParams.append(key, value);
    }
    return url.toString();
  } catch {
    // Fall back to plain concatenation for non-absolute endpoints.
    const fragIdx = endpoint.indexOf("#");
    const base = fragIdx >= 0 ? endpoint.slice(0, fragIdx) : endpoint;
    const separator = base.includes("?")
      ? base.endsWith("?") || base.endsWith("&")
        ? ""
        : "&"
      : "?";
    const query = params
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
    return `${base}${separator}${query}`;
  }
}

function lngLatToWebMercator(lng: number, lat: number): [number, number] {
  const clampedLat = Math.max(-WEB_MERCATOR_MAX_LATITUDE, Math.min(WEB_MERCATOR_MAX_LATITUDE, lat));
  const x = (WEB_MERCATOR_EARTH_RADIUS * (lng * Math.PI)) / 180;
  const y =
    WEB_MERCATOR_EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (clampedLat * Math.PI) / 360));
  return [x, y];
}

function wmsIdentifyResolution(zoom: number): number {
  const normalizedZoom = Number.isFinite(zoom) ? Math.max(0, zoom) : 0;
  return WEB_MERCATOR_WORLD_SIZE / (MAPLIBRE_TILE_SIZE * 2 ** normalizedZoom);
}

function wmsIdentifyBbox3857(map: maplibregl.Map, lngLat: maplibregl.LngLat): string {
  const [centerX, centerY] = lngLatToWebMercator(lngLat.lng, lngLat.lat);
  const halfSpan = (WMS_IDENTIFY_QUERY_SIZE * wmsIdentifyResolution(map.getZoom())) / 2;
  return [centerX - halfSpan, centerY - halfSpan, centerX + halfSpan, centerY + halfSpan].join(",");
}

function isViteDevServer(): boolean {
  return Boolean(
    (
      import.meta as ImportMeta & {
        env?: { DEV?: boolean };
      }
    ).env?.DEV,
  );
}

// Only the Vite dev server proxies GetFeatureInfo requests (to dodge CORS in
// the browser). Production builds target the Tauri webview, which does not
// enforce same-origin restrictions, so the raw URL is used directly. A WMS
// server lacking CORS headers would fail if this app were ever hosted as a
// plain web page; such a deployment would need its own proxy.
function proxyWmsRequestUrl(url: string): string {
  return isViteDevServer() ? `${WMS_PROXY_PATH}?url=${encodeURIComponent(url)}` : url;
}

function createWmsGetFeatureInfoUrl(
  layer: GeoLibreLayer,
  map: maplibregl.Map,
  event: maplibregl.MapMouseEvent,
  infoFormat: string,
): string | null {
  const endpoint = stringSource(layer.source.url) ?? layer.sourcePath;
  const layers = stringSource(layer.source.layers);
  if (!endpoint || !layers) return null;

  const styles = stringSource(layer.source.styles) ?? "";
  const format = stringSource(layer.source.format) ?? "image/png";
  // WMS 1.3.0 renames the SRS parameter to CRS and the pixel coordinates from
  // X/Y to I/J. EPSG:3857 keeps easting/northing axis order across both
  // versions, so the BBOX layout is unchanged.
  const version = stringSource(layer.source.version) ?? "1.1.1";
  const isV13 = version.startsWith("1.3");
  const crsParam = isV13 ? "CRS" : "SRS";
  // Treat a deliberate featureCount of 0 ("all features" on some servers) as
  // intentional; only fall back to 1 when it is unset (null/undefined), blank,
  // or non-numeric. Number(null) and Number("") are both 0, so guard those.
  const featureCount =
    layer.source.featureCount != null && layer.source.featureCount !== ""
      ? Number(layer.source.featureCount)
      : NaN;

  return appendWmsQuery(endpoint, [
    ["SERVICE", "WMS"],
    ["REQUEST", "GetFeatureInfo"],
    ["VERSION", version],
    ["LAYERS", layers],
    ["QUERY_LAYERS", layers],
    ["STYLES", styles],
    ["FORMAT", format],
    ["TRANSPARENT", layer.source.transparent === false ? "FALSE" : "TRUE"],
    [crsParam, "EPSG:3857"],
    ["BBOX", wmsIdentifyBbox3857(map, event.lngLat)],
    ["WIDTH", String(WMS_IDENTIFY_QUERY_SIZE)],
    ["HEIGHT", String(WMS_IDENTIFY_QUERY_SIZE)],
    [isV13 ? "I" : "X", String(WMS_IDENTIFY_QUERY_CENTER)],
    [isV13 ? "J" : "Y", String(WMS_IDENTIFY_QUERY_CENTER)],
    ["INFO_FORMAT", infoFormat],
    ["FEATURE_COUNT", String(Number.isFinite(featureCount) ? featureCount : 1)],
  ]);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function textFromHtml(value: string): string {
  const document = new DOMParser().parseFromString(value, "text/html");
  return normalizeText(document.body.textContent ?? "");
}

function isWmsExceptionResponse(value: string): boolean {
  return /<([\w:]+)?(ServiceException|ExceptionReport)\b/i.test(value);
}

function parseWmsJsonProperties(value: unknown): {
  featureId?: string | number;
  properties: Record<string, unknown>;
} | null {
  if (!value || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    // Some servers return a bare array of features instead of a FeatureCollection.
    if (value.length === 0) return { properties: {} };
    const first = value[0];
    // A plain property bag (no "properties"/"features" key) is not a GeoJSON
    // Feature; delegate so the catch-all below returns its own keys rather than
    // wrapping it into a feature whose properties resolve to {}.
    if (
      first &&
      typeof first === "object" &&
      !Array.isArray(first) &&
      !("properties" in first) &&
      !("features" in first && Array.isArray((first as Record<string, unknown>).features))
    ) {
      return parseWmsJsonProperties(first);
    }
    return parseWmsJsonProperties({
      type: "FeatureCollection",
      features: [first],
    });
  }

  if ("features" in value && Array.isArray(value.features)) {
    // An empty collection is the standard "no hit" response: report success
    // with no properties rather than null, so we don't probe other formats.
    if (value.features.length === 0) return { properties: {} };
    const [feature] = value.features;
    if (!feature || typeof feature !== "object") return null;
    const properties =
      "properties" in feature &&
      feature.properties &&
      typeof feature.properties === "object" &&
      !Array.isArray(feature.properties)
        ? (feature.properties as Record<string, unknown>)
        : {};
    const featureId =
      "id" in feature && (typeof feature.id === "string" || typeof feature.id === "number")
        ? feature.id
        : undefined;
    return { featureId, properties };
  }

  return { properties: value as Record<string, unknown> };
}

async function fetchWmsIdentifyProperties(
  layer: GeoLibreLayer,
  map: maplibregl.Map,
  event: maplibregl.MapMouseEvent,
  signal: AbortSignal,
): Promise<{
  featureId?: string | number;
  properties: Record<string, unknown>;
} | null> {
  let fallbackText = "";

  // Honor an explicitly configured INFO_FORMAT so we issue a single request
  // instead of probing JSON/HTML/plain-text in sequence.
  const configuredFormat = stringSource(layer.source.infoFormat);
  const infoFormats = configuredFormat ? [configuredFormat] : WMS_IDENTIFY_INFO_FORMATS;

  for (const infoFormat of infoFormats) {
    const targetUrl = createWmsGetFeatureInfoUrl(layer, map, event, infoFormat);
    if (!targetUrl) return null;

    const response = await fetch(proxyWmsRequestUrl(targetUrl), { signal });
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? infoFormat;
    // Response.text() cannot take a signal, so bail out as soon as the read
    // resolves if the request was aborted meanwhile, skipping parsing.
    const text = await response.text();
    if (signal.aborted) return null;
    if (!response.ok) {
      // HTTP/2 drops the reason phrase, so statusText is often "". Fall back to
      // the status code so a failed request never surfaces as "No attributes".
      fallbackText = normalizeText(text) || response.statusText || `HTTP ${response.status}`;
      continue;
    }

    const trimmed = text.trim();
    const looksLikeJson =
      contentType.includes("json") ||
      infoFormat.includes("json") ||
      trimmed.startsWith("{") ||
      trimmed.startsWith("[");

    // Only run the XML exception check on bodies that are not JSON, so a JSON
    // response that merely mentions "ServiceException" is not misread as one.
    if (!looksLikeJson && isWmsExceptionResponse(text)) {
      fallbackText = normalizeText(text);
      continue;
    }

    if (looksLikeJson) {
      try {
        const parsed = parseWmsJsonProperties(JSON.parse(text));
        if (parsed) return parsed;
        // Valid JSON the parser couldn't map: keep the raw text as a fallback
        // so an unrecognized-but-real response isn't silently discarded.
        fallbackText = fallbackText || normalizeText(text);
      } catch {
        fallbackText = normalizeText(text);
      }
      continue;
    }

    if (contentType.includes("html")) {
      const resultText = textFromHtml(text);
      if (resultText) return { properties: { result: resultText } };
      continue;
    }

    const resultText = normalizeText(text);
    if (!resultText) continue;
    // Only treat plain text as the final answer when we actually probed a
    // text format; a body that arrived in an unexpected format is stashed as
    // a fallback so the remaining info formats are still tried.
    if (infoFormat.includes("plain")) return { properties: { result: resultText } };
    fallbackText = resultText;
  }

  return fallbackText ? { properties: { result: fallbackText } } : null;
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === "AbortError";
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringProperty(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberProperty(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const record = recordFromUnknown(error);
  return stringProperty(record, "message") ?? "MapLibre reported an error.";
}

function stringifyDiagnosticDetail(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (key, nestedValue: unknown) => {
        // Only clamp object-valued targets (Map, XHR, DOM nodes) that risk
        // circular or huge output; keep string targets such as tile URLs.
        if (key === "target" && typeof nestedValue === "object" && nestedValue !== null) {
          return "[Map]";
        }
        if (typeof nestedValue !== "object" || nestedValue === null) {
          return nestedValue;
        }
        if (seen.has(nestedValue)) return "[Circular]";
        seen.add(nestedValue);
        return nestedValue;
      },
      2,
    );
  } catch {
    return undefined;
  }
}

function mapErrorDiagnosticEvent(event: maplibregl.ErrorEvent): MapDiagnosticEvent {
  const eventRecord = recordFromUnknown(event);
  const errorRecord = recordFromUnknown(event.error);
  const source = stringProperty(eventRecord, "sourceId") ?? stringProperty(errorRecord, "sourceId");
  const url =
    stringProperty(eventRecord, "url") ??
    stringProperty(errorRecord, "url") ??
    stringProperty(errorRecord, "resource");
  const status = numberProperty(eventRecord, "status") ?? numberProperty(errorRecord, "status");

  return {
    message: errorMessage(event.error),
    detail: stringifyDiagnosticDetail({
      type: event.type,
      source,
      status,
      url,
      dataType: eventRecord?.dataType,
      sourceDataType: eventRecord?.sourceDataType,
      tile: eventRecord?.tile,
      error: event.error,
    }),
    source,
    status,
    url,
  };
}

export const MapCanvas = memo(function MapCanvas({
  controllerRef,
  onMapDiagnosticEvent,
  onControllerReady,
  canUseRemoteElevation,
  identifyAllLabels = DEFAULT_IDENTIFY_ALL_LABELS,
  identifyRasterLayerAt,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controller = useRef<MapController | null>(null);
  // Read the latest callback through a ref so the setup effect can stay
  // dependency-free. Adding onControllerReady to its deps would tear down and
  // recreate the entire map (losing layers, plugins, and view) whenever a
  // caller passes a non-memoized callback.
  const onControllerReadyRef = useRef(onControllerReady);
  onControllerReadyRef.current = onControllerReady;
  const onMapDiagnosticEventRef = useRef(onMapDiagnosticEvent);
  onMapDiagnosticEventRef.current = onMapDiagnosticEvent;

  const basemapStyleUrl = useAppStore((s) => s.basemapStyleUrl);
  const basemapVisible = useAppStore((s) => s.basemapVisible);
  const basemapOpacity = useAppStore((s) => s.basemapOpacity);
  const blankBackgroundColor = useAppStore((s) => s.blankBackgroundColor);
  const mapPreferences = useAppStore((s) => s.preferences.map);
  const mapView = useAppStore((s) => s.mapView);
  const layers = useAppStore((s) => s.layers);
  const layerGroups = useAppStore((s) => s.layerGroups);
  const layerGroupsRef = useRef(layerGroups);
  layerGroupsRef.current = layerGroups;
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const selectedFeatureId = useAppStore((s) => s.selectedFeatureId);
  const selectedFeatureIds = useAppStore((s) => s.selectedFeatureIds);
  const identifyLayerId = useAppStore((s) => s.identifyLayerId);
  const zoomToSelectedFeature = useAppStore((s) => s.ui.zoomToSelectedFeature);
  const selectFeature = useAppStore((s) => s.selectFeature);
  const selectLayer = useAppStore((s) => s.selectLayer);
  const setMapView = useAppStore((s) => s.setMapView);
  const setPointerCoords = useAppStore((s) => s.setPointerCoords);
  const setPointerElevation = useAppStore((s) => s.setPointerElevation);
  const setCameraAltitude = useAppStore((s) => s.setCameraAltitude);
  const showPointerElevation = useAppStore((s) => s.preferences.map.showPointerElevation);
  const projectGeneration = useAppStore((s) => s.projectGeneration);
  const pointerElevationRef = useRef<PointerElevationResolver | null>(null);
  // Held in a ref so the once-only init effect can read the current predicate
  // without re-creating the map when the consent flag changes.
  const canUseRemoteElevationRef = useRef<() => boolean>(() => true);
  canUseRemoteElevationRef.current = canUseRemoteElevation ?? (() => false);

  // loadProject resets the readout, but a lookup already in flight for the
  // previous project would repaint it a moment later -- including Earth to
  // Earth, where neither the body nor the pointer changed.
  useEffect(() => {
    pointerElevationRef.current?.invalidate();
  }, [projectGeneration]);

  // The resolver consults the preference, but only when a pointer event asks it
  // to. Switching the toggle off with the cursor resting motionless over the
  // map (a keyboard-only toggle) would otherwise leave the last resolved value
  // on screen until the next mousemove.
  useEffect(() => {
    if (!showPointerElevation) {
      // invalidate() before clearing: a lookup scheduled inside the 500ms
      // debounce window would otherwise still fire the request, and only be
      // suppressed afterwards by the isEnabled() re-check. Cancelling the timer
      // means the request is never made at all.
      pointerElevationRef.current?.invalidate();
      setPointerElevation(null);
      return;
    }
    // Symmetrically, switching it *on* while the cursor sits still would show
    // nothing until the next mousemove. Resolve once for wherever the pointer
    // already is, so the readout appears with the toggle.
    const coords = useAppStore.getState().pointerCoords;
    if (coords) pointerElevationRef.current?.update(coords);
  }, [showPointerElevation, setPointerElevation]);
  const previousSelectedFeatureKey = useRef<string | null>(null);
  const previousDuckDBSelectionLayerId = useRef<string | null>(null);
  // The layer all-layer Identify last activated, so a click that hits nothing
  // can retire that selection without touching one the user made themselves.
  const globalIdentifyActivatedLayerId = useRef<string | null>(null);
  const identifyPopup = useRef<maplibregl.Popup | null>(null);
  const photoPopup = useRef<maplibregl.Popup | null>(null);
  const hoverTooltip = useRef<maplibregl.Popup | null>(null);
  // Set for the duration of a map selection gesture. The other click handlers
  // bound to the same map (Identify, geotagged-photo popups) read it and bail,
  // so a rectangle drag or a polygon vertex click never also opens a popup.
  const featureSelectionActive = useRef(false);
  // Tears down the gesture in progress, if any. Held at component scope so the
  // Identify effect can end a half-drawn selection when the user switches
  // tools instead of finishing or pressing Esc.
  const cancelFeatureSelection = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!containerRef.current || controller.current) return;

    const mc = createMapController();
    const map = mc.init(containerRef.current, {
      styleUrl: basemapStyleUrl,
      mapView,
      mapPreferences,
    });
    controller.current = mc;
    if (controllerRef) controllerRef.current = mc;

    // Ground elevation under the cursor for the status bar (issue #1813).
    // Terrain sampling is synchronous so the readout tracks the pointer live;
    // the resolver only falls back to the network once the pointer settles.
    const pointerElevation = createPointerElevationResolver({
      getMap: () => map,
      isEarth: () => getActiveEllipsoid().id === "earth",
      // Read per call, not captured: the map is initialised once, so a captured
      // value would freeze at whatever the toggle was at mount.
      isEnabled: () => useAppStore.getState().preferences.map.showPointerElevation,
      // Only the Open-Meteo fallback is gated; the terrain path sends nothing
      // anywhere. Checked here rather than by scrubbing the stored preference,
      // so a project that arrives with the readout switched on still cannot
      // reach the network without local consent.
      canUseRemote: () => canUseRemoteElevationRef.current(),
      emit: setPointerElevation,
    });
    pointerElevationRef.current = pointerElevation;

    map.on("mousemove", (e) => {
      const point: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      setPointerCoords(point);
      pointerElevation.update(point);
    });
    map.on("mouseout", () => {
      // invalidate() rather than update(null): both cancel a pending lookup, but
      // update(null) also emits null, and setPointerCoords(null) already clears
      // the stored elevation — so emitting here would be a second store write
      // and re-render saying the same thing.
      pointerElevation.invalidate();
      setPointerCoords(null);
    });
    map.on("error", (event) => {
      // Cancelled tile fetches are already surfaced (as info) by the
      // network capture; logging them here would double-count aborts.
      if (isAbortError(event.error)) return;
      onMapDiagnosticEventRef.current?.(mapErrorDiagnosticEvent(event));
    });

    const updateView = (event?: { originalEvent?: unknown; flightCameraToken?: number }) => {
      // While presenting a story map the presenter owns the camera. Syncing its
      // transient chapter flies and rotations back into the store would both
      // overwrite the saved project view and, worse, re-enter the applyView
      // effect below: its jumpTo cancels an in-flight chapter fly, after which
      // the rotate handler starts orbiting the previous chapter instead of the
      // one just clicked. Skipping the sync keeps the presenter authoritative.
      if (useAppStore.getState().ui.storymapPresenting) return;
      // The flight simulator likewise owns the camera while it flies, and jumps
      // it every animation frame. Writing each of those into the store would
      // overwrite the project's saved view ~60 times a second.
      if (event?.flightCameraToken !== undefined) return;
      setMapView(mc.readView(), Boolean(event?.originalEvent));
      // Same moveend cadence as zoom/bearing/pitch: a bar where one number is
      // live and the rest lag during a drag reads as broken.
      setCameraAltitude(mc.readCameraAltitude());
    };
    map.on("moveend", updateView);

    // Persist user clicks on MapLibre's GlobeControl into project preferences so
    // a project reopens with the projection it was saved in. See
    // `globe-control-toggle.ts` for why the click, and not MapLibre's
    // `projectiontransition` event, is what this listens to.
    const updateProjection = () => {
      const projection = mc.readProjection();
      // Functional update so a concurrent preference change (zoom-limit edit,
      // loadProject) between read and write is not clobbered by a stale snapshot.
      useAppStore.setState((s) => {
        if (s.preferences.map.projection === projection) return s;
        return {
          preferences: {
            ...s.preferences,
            map: { ...s.preferences.map, projection },
          },
          isDirty: true,
        };
      });
    };
    const handleProjectionControlClick = (event: MouseEvent) => {
      // The control's own handler runs on the button before the event reaches
      // this container-level listener, and `setProjection` is synchronous, so
      // `readProjection()` already reflects the toggle.
      if (!isGlobeControlToggleClick(event.target)) return;
      updateProjection();
    };
    map.getContainer().addEventListener("click", handleProjectionControlClick);
    map.on("load", () => {
      const state = useAppStore.getState();
      mc.setBasemapVisible(state.basemapVisible);
      mc.setBasemapOpacity(state.basemapOpacity);
      mc.highlightFeature(
        state.layers.find((layer) => layer.id === state.selectedLayerId),
        resolveHighlightIds(state),
      );
      updateView();
      onControllerReadyRef.current?.();
    });

    const disposeResizeScheduler = createMapResizeScheduler({
      getMap: () => mc.getMap(),
      container: containerRef.current,
    });

    return () => {
      disposeResizeScheduler();
      pointerElevation.dispose();
      map.getContainer().removeEventListener("click", handleProjectionControlClick);
      mc.destroy();
      controller.current = null;
      if (controllerRef) controllerRef.current = null;
    };
    // The map is initialised exactly once; onControllerReady is read via
    // onControllerReadyRef so it is intentionally excluded from the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prevBasemap = useRef(basemapStyleUrl);
  useEffect(() => {
    const map = controller.current?.getMap();
    if (!map || prevBasemap.current === basemapStyleUrl) return;
    prevBasemap.current = basemapStyleUrl;
    map.once("style.load", () => {
      const state = useAppStore.getState();
      controller.current?.setBasemapVisible(state.basemapVisible);
      controller.current?.setBasemapOpacity(state.basemapOpacity);
      controller.current?.highlightFeature(
        state.layers.find((layer) => layer.id === state.selectedLayerId),
        resolveHighlightIds(state),
      );
      onControllerReadyRef.current?.();
    });
    controller.current?.setStyle(basemapStyleUrl);
    // Switching the active body without moving the camera -- the planet switcher
    // or a different planetary basemap -- changes the radius the altitude is
    // scaled by, but fires no moveend, so the readout would keep the previous
    // body's number until the next pan. Mirrors how setStyle refreshes the
    // scale bar for the same reason.
    setCameraAltitude(controller.current?.readCameraAltitude() ?? null);
    // setCameraAltitude is a stable store action; the effect is keyed on the
    // basemap alone so it does not re-run on unrelated store changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemapStyleUrl]);

  useEffect(() => {
    controller.current?.setBasemapVisible(basemapVisible);
  }, [basemapVisible]);

  useEffect(() => {
    controller.current?.setBasemapOpacity(basemapOpacity);
  }, [basemapOpacity]);

  useEffect(() => {
    controller.current?.setBlankBackgroundColor(blankBackgroundColor);
    if (blankBackgroundColor !== null || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => controller.current?.setBlankBackgroundColor(null));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [blankBackgroundColor]);

  useEffect(() => {
    controller.current?.applyMapPreferences(mapPreferences);
  }, [mapPreferences]);

  // Fold group visibility/opacity into each child layer before syncing so the
  // map sync keeps treating every layer independently. This also re-runs when
  // only a group's visibility/opacity changes (the raw `layers` array is then
  // unchanged), because `renderLayers` depends on `layerGroups`.
  const renderLayers = useMemo(() => applyGroupEffects(layers, layerGroups), [layers, layerGroups]);

  useEffect(() => {
    controller.current?.waitAndSyncLayers(renderLayers);
  }, [renderLayers]);

  useEffect(() => {
    const map = controller.current?.getMap();
    if (!map) return;

    // Only the drawn shapes scan the layer; `single` goes through
    // queryRenderedFeatures, which is bounded by what is on screen. Checked
    // both when the gesture starts — so the user is not left waiting on a scan
    // that was never going to finish promptly — and again when it completes,
    // since a connection-backed layer can refresh past the limit while a
    // polygon or freehand gesture is still open.
    const tooManyToScan = (candidate: GeoLibreLayer, shape: FeatureSelectionShape) => {
      const featureCount = candidate.geojson?.features?.length ?? 0;
      if (shape === "single" || featureCount <= MAX_SELECTION_SCAN_FEATURES) return false;
      onMapDiagnosticEventRef.current?.({
        message: `Selecting by shape would test ${featureCount} features (limit ${MAX_SELECTION_SCAN_FEATURES})`,
        detail:
          "Use Select by expression or Select by location on this layer instead — they run the same match without blocking the map.",
        source: candidate.name,
      });
      return true;
    };

    const begin = (request: FeatureSelectionRequest) => {
      cancelFeatureSelection.current?.();
      const state = useAppStore.getState();
      const layer = state.layers.find((item) => item.id === request.layerId);
      if (!layer?.geojson?.features) return;
      // A gesture on a hidden layer would match features the user cannot see —
      // and the `single` shape, which queries rendered features, would match
      // none at all. Folded through the group chain, so a layer hidden only by
      // its group counts as hidden. LayerPanel disables the menu items; this is
      // the guard for a layer hidden between opening the menu and drawing.
      if (!effectiveLayerRenderState(layer, state.layerGroups).visible) return;
      if (tooManyToScan(layer, request.shape)) return;

      const canvas = map.getCanvas();
      const container = map.getContainer();

      // Every side effect below registers its own rollback as it happens, and
      // the teardown is armed before the first of them. Arming it at the end
      // instead would leave a throw part-way through to strand the overlay in
      // the DOM with the camera handlers disabled and no way back.
      const cleanups: Array<() => void> = [];
      cancelFeatureSelection.current = () => {
        cleanups.forEach((cleanup) => cleanup());
        featureSelectionActive.current = false;
        cancelFeatureSelection.current = null;
      };

      const overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      overlay.setAttribute("aria-hidden", "true");
      Object.assign(overlay.style, {
        position: "absolute",
        inset: "0",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: "5",
      });
      const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
      shape.setAttribute("fill", "rgba(37, 99, 235, 0.16)");
      shape.setAttribute("stroke", "#2563eb");
      shape.setAttribute("stroke-width", "2");
      shape.setAttribute("stroke-dasharray", "6 4");
      overlay.append(shape);
      container.append(overlay);
      cleanups.push(() => overlay.remove());

      // A drawn shape freezes the camera outright; click selection keeps it
      // live but still gives up box zoom, which would otherwise swallow every
      // Shift+click. See suspendedCameraHandlers() for why.
      for (const name of suspendedCameraHandlers(request.shape)) {
        const handler = map[name];
        if (!handler.isEnabled()) continue;
        handler.disable();
        cleanups.push(() => handler.enable());
      }
      canvas.style.cursor = "crosshair";
      cleanups.push(() => {
        canvas.style.cursor = "";
      });
      featureSelectionActive.current = true;
      window.dispatchEvent(new Event(FEATURE_SELECTION_BEGIN_EVENT));

      let points: maplibregl.Point[] = [];
      let dragging = false;
      const render = () => {
        if (points.length === 0) return shape.setAttribute("d", "");
        if (request.shape === "rectangle" && points.length > 1) {
          const [a, b] = points;
          shape.setAttribute(
            "d",
            `M ${a.x} ${a.y} L ${b.x} ${a.y} L ${b.x} ${b.y} L ${a.x} ${b.y} Z`,
          );
          return;
        }
        if (request.shape === "radius" && points.length > 1) {
          const [center, edge] = points;
          const radius = center.dist(edge);
          shape.setAttribute(
            "d",
            `M ${center.x - radius} ${center.y} a ${radius} ${radius} 0 1 0 ${
              radius * 2
            } 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0`,
          );
          return;
        }
        const closed = request.shape !== "freehand" || !dragging;
        shape.setAttribute(
          "d",
          `${points
            .map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`)
            .join(" ")}${closed && points.length > 2 ? " Z" : ""}`,
        );
      };
      const polygonFromPoints = (): Polygon | null => {
        let ring = points;
        // A click with no drag leaves the two points coincident, which would
        // otherwise build a zero-area rectangle or a zero-radius circle. Say
        // "no shape was drawn" outright rather than leaning on Turf to reject
        // the degenerate ring.
        const twoPointShape = request.shape === "rectangle" || request.shape === "radius";
        if (twoPointShape && (points.length < 2 || points[0].equals(points[1]))) return null;
        if (request.shape === "rectangle" && points.length >= 2) {
          const [a, b] = points;
          ring = [a, new maplibregl.Point(b.x, a.y), b, new maplibregl.Point(a.x, b.y)];
        } else if (request.shape === "radius" && points.length >= 2) {
          const [center, edge] = points;
          const radius = center.dist(edge);
          ring = Array.from({ length: 64 }, (_, index) => {
            const angle = (index / 64) * Math.PI * 2;
            return new maplibregl.Point(
              center.x + Math.cos(angle) * radius,
              center.y + Math.sin(angle) * radius,
            );
          });
        }
        if (ring.length < 3) return null;
        const coordinates = ring.map((point) => {
          const lngLat = map.unproject(point);
          return [lngLat.lng, lngLat.lat] as [number, number];
        });
        coordinates.push(coordinates[0]);
        return { type: "Polygon", coordinates: [coordinates] };
      };

      const finish = (event: { shiftKey?: boolean; altKey?: boolean }) => {
        // Re-read the layer rather than trusting the snapshot taken at gesture
        // start: a polygon or freehand gesture stays open for as long as the
        // user keeps drawing, long enough for a connection refresh to replace
        // the features, for the layer to be hidden, or for it to be removed
        // outright. Matching a deleted layer would also point selectedLayerId
        // at something that no longer exists.
        const store = useAppStore.getState();
        const live = store.layers.find((item) => item.id === layer.id);
        if (
          !live?.geojson?.features ||
          !effectiveLayerRenderState(live, store.layerGroups).visible ||
          tooManyToScan(live, request.shape)
        ) {
          cancelFeatureSelection.current?.();
          return;
        }
        let matched: string[] = [];
        if (request.shape === "single" && points[0]) {
          const point = points[0];
          const queryIds = identifyStyleLayerIds(live).filter((id) => map.getLayer(id));
          const rendered = map.queryRenderedFeatures(
            [
              [point.x - 4, point.y - 4],
              [point.x + 4, point.y + 4],
            ],
            { layers: queryIds },
          );
          const id = rendered[0] ? findFeatureId(live, rendered[0]) : null;
          if (id != null) matched = [id];
        } else {
          const polygon = polygonFromPoints();
          // Nothing was drawn — a stray click rather than a drag. Leave the
          // selection as it was instead of letting mode "new" replace it with
          // the empty match. (Click-to-deselect stays the `single` shape's job,
          // where an empty click is the deliberate gesture.)
          if (!polygon) {
            cancelFeatureSelection.current?.();
            return;
          }
          matched = featuresIntersectingPolygon(live.geojson.features, polygon);
        }
        applyMatchedSelection(
          layer.id,
          matched,
          selectionModeFromModifiers(Boolean(event.shiftKey), Boolean(event.altKey), request.mode),
        );
        // Click selection is a continuous map tool: keep its handler and
        // crosshair armed so the next click can add, remove, or intersect via
        // modifiers. Drawn shapes remain one-shot because their completed
        // geometry is the whole interaction. Escape and any newly-started map
        // tool still run the shared teardown.
        if (!keepsFeatureSelectionActive(request.shape)) cancelFeatureSelection.current?.();
      };
      const onMouseDown = (event: maplibregl.MapMouseEvent) => {
        if (request.shape === "polygon" || request.shape === "single") return;
        dragging = true;
        points = [event.point];
        render();
      };
      // The map's own mouse events stop at the canvas, so a drag released over
      // the layer panel or the browser chrome would never deliver a mouseup and
      // would leave the gesture armed with pan/zoom still disabled. Window
      // listeners extend tracking past the canvas edge, the same way
      // print-extent.ts does for its rubber band. Both sources feed the two
      // helpers below, which are idempotent so the duplicate events a release
      // inside the canvas produces cost nothing.
      const canvasPoint = (clientX: number, clientY: number) => {
        const rect = canvas.getBoundingClientRect();
        return new maplibregl.Point(clientX - rect.left, clientY - rect.top);
      };
      const moveTo = (point: maplibregl.Point) => {
        if (!dragging) return;
        if (request.shape === "freehand") {
          // Sample rather than take every mousemove: a slow trace would
          // otherwise accumulate thousands of near-coincident vertices, and
          // both render() (which rebuilds the whole path string) and the
          // closing intersection test scale with the ring.
          const last = points.at(-1);
          if (last && last.dist(point) < FREEHAND_MIN_POINT_DISTANCE) return;
          points.push(point);
        } else {
          if (points[1]?.equals(point)) return;
          points = [points[0], point];
        }
        render();
      };
      const endDrag = (point: maplibregl.Point, modifiers: MouseEvent) => {
        if (!dragging) return;
        dragging = false;
        // `.equals()`, not `!==`: every mouse event carries a freshly built
        // Point, so a reference check would never skip the duplicate.
        if (request.shape === "freehand" && !points.at(-1)?.equals(point)) points.push(point);
        else if (request.shape !== "freehand") points = [points[0], point];
        finish(modifiers);
      };
      const onMouseMove = (event: maplibregl.MapMouseEvent) => moveTo(event.point);
      const onWindowMouseMove = (event: MouseEvent) =>
        moveTo(canvasPoint(event.clientX, event.clientY));
      const onMouseUp = (event: maplibregl.MapMouseEvent) =>
        endDrag(event.point, event.originalEvent);
      const onWindowMouseUp = (event: MouseEvent) =>
        endDrag(canvasPoint(event.clientX, event.clientY), event);
      const onClick = (event: maplibregl.MapMouseEvent) => {
        if (request.shape === "single") {
          points = [event.point];
          finish(event.originalEvent);
        } else if (request.shape === "polygon") {
          points.push(event.point);
          render();
        }
      };
      const onDoubleClick = (event: maplibregl.MapMouseEvent) => {
        if (request.shape !== "polygon") return;
        event.preventDefault();
        // A double-click fires two clicks first; drop the duplicate tail vertex
        // they leave behind (same fix as ElevationProfileControl's drawing).
        const [last, previous] = [points.at(-1), points.at(-2)];
        if (last && previous && last.dist(previous) <= DOUBLE_CLICK_VERTEX_TOLERANCE) points.pop();
        if (points.length > 2) finish(event.originalEvent);
      };
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") cancelFeatureSelection.current?.();
      };
      // Only while a drag is in flight: that is the case where losing focus
      // (Alt+Tab, a system dialog) means the mouseup never arrives. A polygon
      // is drawn click by click with no armed state, so blurring away to check
      // something must not throw away the vertices already placed.
      const onBlur = () => {
        if (dragging) cancelFeatureSelection.current?.();
      };
      map.on("mousedown", onMouseDown);
      map.on("mousemove", onMouseMove);
      map.on("mouseup", onMouseUp);
      map.on("click", onClick);
      map.on("dblclick", onDoubleClick);
      window.addEventListener("mousemove", onWindowMouseMove);
      window.addEventListener("mouseup", onWindowMouseUp);
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("blur", onBlur);
      cleanups.push(
        () => map.off("mousedown", onMouseDown),
        () => map.off("mousemove", onMouseMove),
        () => map.off("mouseup", onMouseUp),
        () => map.off("click", onClick),
        () => map.off("dblclick", onDoubleClick),
        () => window.removeEventListener("mousemove", onWindowMouseMove),
        () => window.removeEventListener("mouseup", onWindowMouseUp),
        () => window.removeEventListener("keydown", onKeyDown),
        () => window.removeEventListener("blur", onBlur),
      );
    };
    const onRequest = (event: Event) =>
      begin((event as CustomEvent<FeatureSelectionRequest>).detail);
    window.addEventListener(FEATURE_SELECTION_EVENT, onRequest);
    return () => {
      window.removeEventListener(FEATURE_SELECTION_EVENT, onRequest);
      cancelFeatureSelection.current?.();
    };
  }, []);

  // Stable key over just the geotagged-photo layer ids, so the photo-click
  // effect re-binds only when such a layer is added/removed, not on every
  // unrelated layer edit (e.g. a coordinate update while dragging a pin).
  const photoLayerKey = useMemo(
    () =>
      layers
        .filter((layer) => layer.metadata.sourceKind === "geotagged-photos")
        .map((layer) => layer.id)
        .join(","),
    [layers],
  );

  useEffect(() => {
    const layer = layers.find((item) => item.id === selectedLayerId);
    // Highlight the full multi-selection (attribute table Ctrl/Shift picks).
    const highlightIds = resolveHighlightIds({
      selectedFeatureIds,
      selectedFeatureId,
    });
    // Key on the whole selection set, not just the anchor: a Shift-range pick
    // keeps the anchor fixed while adding features, so an anchor-only key would
    // never re-fit. Any change to the set re-triggers the fit to frame them all.
    // Join on NUL — a byte that can't appear in a feature id — so ids containing
    // commas (e.g. ["a,b"] vs ["a","b"]) don't collide into the same key.
    const nextKey =
      selectedLayerId && highlightIds.length > 0
        ? `${selectedLayerId}:${highlightIds.join("\u0000")}`
        : null;
    const shouldFit = Boolean(
      zoomToSelectedFeature && nextKey && nextKey !== previousSelectedFeatureKey.current,
    );
    previousSelectedFeatureKey.current = nextKey;
    controller.current?.highlightFeature(layer, highlightIds, {
      fit: shouldFit,
    });
    if (layer && isDuckDBQueryLayer(layer)) {
      duckDBBridge()?.setSelectedFeature?.(layer.id, selectedFeatureId);
      if (shouldFit && selectedFeatureId) {
        const bounds = duckDBBridge()?.getFeatureBounds?.(layer.id, selectedFeatureId);
        if (bounds) controller.current?.fitBounds(bounds);
      }
      previousDuckDBSelectionLayerId.current = layer.id;
    } else if (previousDuckDBSelectionLayerId.current) {
      duckDBBridge()?.setSelectedFeature?.(previousDuckDBSelectionLayerId.current, null);
      previousDuckDBSelectionLayerId.current = null;
    }
  }, [layers, selectedLayerId, selectedFeatureId, selectedFeatureIds, zoomToSelectedFeature]);

  useEffect(() => {
    const map = controller.current?.getMap();
    const identifyAllLayers = identifyLayerId === IDENTIFY_ALL_LAYERS_ID;
    const layer = identifyAllLayers
      ? undefined
      : layers.find((item) => item.id === identifyLayerId);
    if (!map || (!layer && !identifyAllLayers)) {
      identifyPopup.current?.remove();
      identifyPopup.current = null;
      // Same guard as the cleanup below: picking a gesture turns Identify off,
      // and begin() has already claimed the crosshair by the time this runs.
      if (map && !featureSelectionActive.current) map.getCanvas().style.cursor = "";
      return;
    }

    // Switching to Identify ends a half-drawn selection. Without this the
    // gesture stays live and its handlers keep swallowing map clicks, so the
    // Identify button would light up while Identify itself did nothing.
    cancelFeatureSelection.current?.();

    if (identifyAllLayers) {
      map.getCanvas().style.cursor = "crosshair";
      let globalIdentifyAbortController: AbortController | null = null;
      const handleIdentifyAllClick = (event: maplibregl.MapMouseEvent) => {
        if (featureSelectionActive.current) return;

        globalIdentifyAbortController?.abort();
        const abortController = new AbortController();
        globalIdentifyAbortController = abortController;

        const owners = new Map<string, GeoLibreLayer>();
        // effectiveLayerRenderState rebuilds an id -> group map on every call
        // when handed the array form, so fold every candidate against one map
        // built once per click instead of one per layer.
        const groupById = new Map(layerGroupsRef.current.map((group) => [group.id, group]));
        const eligibleLayers = layers.filter(
          (candidate) =>
            effectiveLayerRenderState(candidate, groupById).visible &&
            resolveLayerCapabilities(candidate).query &&
            isPopupClickEnabled(candidate.popup),
        );
        for (const candidate of eligibleLayers) {
          for (const styleLayerId of identifyStyleLayerIds(candidate)) {
            if (map.getLayer(styleLayerId)) owners.set(styleLayerId, candidate);
          }
        }

        const hits: GlobalIdentifyHit[] = [];
        const acceptHit = createGlobalIdentifyHitDeduper();
        const queryLayerIds = [...owners.keys()];
        const rendered =
          queryLayerIds.length === 0
            ? []
            : map.queryRenderedFeatures(event.point, { layers: queryLayerIds });
        for (const feature of rendered) {
          const owner = owners.get(feature.layer.id);
          if (!owner) continue;
          const hit: GlobalIdentifyHit = {
            layer: owner,
            properties: feature.properties ?? {},
            feature,
            featureId: findFeatureId(owner, feature),
          };
          if (!acceptHit(hit.layer.id, hit.featureId, feature)) continue;
          hits.push(hit);
        }

        // DuckDB query layers draw through deck.gl, so they own no MapLibre
        // style layer and never surface in queryRenderedFeatures. The plugin
        // bridge picks them the same way the single-layer path does.
        for (const candidate of eligibleLayers) {
          if (!isDuckDBQueryLayer(candidate)) continue;
          const result = duckDBBridge()?.identifyLayerAtPoint?.(candidate.id, {
            x: event.point.x,
            y: event.point.y,
          });
          if (!result) continue;
          hits.push({
            layer: candidate,
            properties: result.properties,
            featureId: result.featureId,
          });
        }

        const activate = (hit: GlobalIdentifyHit) => {
          selectLayer(hit.layer.id);
          selectFeature(hit.featureId);
          globalIdentifyActivatedLayerId.current = hit.layer.id;
        };
        const showPopup = (content: HTMLElement) => {
          identifyPopup.current?.remove();
          identifyPopup.current = new maplibregl.Popup({
            className: "geolibre-identify-popup",
            closeButton: true,
            closeOnClick: false,
            maxWidth: "560px",
          })
            .setLngLat(event.lngLat)
            .setDOMContent(content)
            .addTo(map);
        };
        const finish = (allHits: GlobalIdentifyHit[]) => {
          if (abortController.signal.aborted) return;
          const order = new Map(layers.map((candidate, index) => [candidate.id, index]));
          allHits.sort((a, b) => (order.get(b.layer.id) ?? -1) - (order.get(a.layer.id) ?? -1));
          if (allHits.length === 0) {
            identifyPopup.current?.remove();
            identifyPopup.current = null;
            selectFeature(null);
            // Retire the layer selection only when this mode is what set it.
            // A layer the user picked in the Layers panel — to edit its style,
            // say — is theirs to keep, and the single-layer Identify path
            // never clears it either.
            if (
              globalIdentifyActivatedLayerId.current !== null &&
              useAppStore.getState().selectedLayerId === globalIdentifyActivatedLayerId.current
            ) {
              selectLayer(null);
            }
            globalIdentifyActivatedLayerId.current = null;
            return;
          }
          activate(allHits[0]);
          showPopup(
            createGlobalIdentifyPopupElement(allHits, map.getZoom(), activate, identifyAllLabels),
          );
        };

        const asyncLayers = eligibleLayers.filter(
          (candidate) =>
            isWmsLayer(candidate) ||
            isPixelIdentifyLayer(candidate) ||
            candidate.type === "cog" ||
            candidate.metadata.sourceKind === NETCDF_IMAGE_SOURCE_KIND,
        );
        if (asyncLayers.length === 0) {
          finish(hits);
          return;
        }

        selectFeature(null);
        showPopup(
          createIdentifyMessagePopupElement(
            identifyAllLabels.loadingTitle,
            identifyAllLabels.loading,
          ),
        );
        const loadingPopup = identifyPopup.current;
        const onLoadingClose = () => abortController.abort();
        loadingPopup?.once("close", onLoadingClose);

        void Promise.all(
          asyncLayers.map(async (candidate): Promise<GlobalIdentifyHit | null> => {
            try {
              if (isWmsLayer(candidate)) {
                const result = await fetchWmsIdentifyProperties(
                  candidate,
                  map,
                  event,
                  abortController.signal,
                );
                if (
                  !result ||
                  (result.featureId == null && Object.keys(result.properties).length === 0)
                ) {
                  return null;
                }
                return {
                  layer: candidate,
                  properties: result.properties,
                  featureId: result.featureId == null ? null : String(result.featureId),
                };
              }

              // Ordered before the pixel-identify branch on purpose: the
              // NetCDF dialog marks these layers `pixelIdentify` too, and that
              // branch reads through the Time Slider bridge, which knows
              // nothing about a retained NetCDF grid.
              if (candidate.metadata.sourceKind === NETCDF_IMAGE_SOURCE_KIND) {
                const result = await identifyRasterLayerAt?.(
                  candidate,
                  [event.lngLat.lng, event.lngLat.lat],
                  { signal: abortController.signal },
                );
                return result
                  ? {
                      layer: candidate,
                      properties: result.properties,
                      featureId: null,
                      title: result.title ?? identifyAllLabels.pixel,
                    }
                  : null;
              }

              if (isPixelIdentifyLayer(candidate)) {
                const result = await timeSliderBridge()?.identifyPixelAt?.(
                  candidate.id,
                  [event.lngLat.lng, event.lngLat.lat],
                  { signal: abortController.signal },
                );
                return result
                  ? {
                      layer: candidate,
                      properties: pixelIdentifyProperties(result),
                      featureId: null,
                      title: identifyAllLabels.pixel,
                    }
                  : null;
              }

              const result = await identifyRasterLayerAt?.(
                candidate,
                [event.lngLat.lng, event.lngLat.lat],
                { signal: abortController.signal },
              );
              return result
                ? {
                    layer: candidate,
                    properties: result.properties,
                    featureId: null,
                    title: result.title ?? identifyAllLabels.pixel,
                  }
                : null;
            } catch (error: unknown) {
              if (abortController.signal.aborted || isAbortError(error)) return null;
              return {
                layer: candidate,
                properties: {
                  [identifyAllLabels.errorLabel]:
                    error instanceof Error ? error.message : identifyAllLabels.error,
                },
                featureId: null,
              };
            }
          }),
        ).then((asyncHits) => {
          if (abortController.signal.aborted) return;
          loadingPopup?.off("close", onLoadingClose);
          finish([...hits, ...asyncHits.filter((hit): hit is GlobalIdentifyHit => hit !== null)]);
        });
      };

      map.on("click", handleIdentifyAllClick);
      return () => {
        globalIdentifyAbortController?.abort();
        map.off("click", handleIdentifyAllClick);
        identifyPopup.current?.remove();
        identifyPopup.current = null;
        globalIdentifyActivatedLayerId.current = null;
        if (!featureSelectionActive.current) map.getCanvas().style.cursor = "";
      };
    }

    if (!layer) return;

    // An author can turn the click popup off for a layer they only want
    // hovered (or only styled). Identify then does nothing for it rather than
    // opening a popup the shared map was designed without.
    if (!isPopupClickEnabled(layer.popup)) {
      identifyPopup.current?.remove();
      identifyPopup.current = null;
      return;
    }

    // COG layers are identified by the raster control's pixel inspector (driven
    // by useRasterIdentify in the desktop app), not this vector/WMS feature
    // query. Bail so the two don't both register a map-click handler. (Only
    // "cog" is identify-enabled; plain "raster" never reaches here.)
    if (layer.type === "cog") return;

    // Likewise for a NetCDF grid baked to pixels: useNetcdfIdentify reads its
    // retained grid directly, and the image layer has no features to query.
    if (layer.metadata.sourceKind === NETCDF_IMAGE_SOURCE_KIND) return;

    map.getCanvas().style.cursor = "crosshair";

    let wmsIdentifyAbortController: AbortController | null = null;
    let pixelIdentifyAbortController: AbortController | null = null;

    const handleIdentifyClick = (event: maplibregl.MapMouseEvent) => {
      // A selection gesture owns the map clicks while it runs.
      if (featureSelectionActive.current) return;
      const clearIdentifyResult = () => {
        wmsIdentifyAbortController?.abort();
        wmsIdentifyAbortController = null;
        selectFeature(null);
        identifyPopup.current?.remove();
        identifyPopup.current = null;
      };
      const showIdentifyPopup = (content: HTMLElement) => {
        identifyPopup.current?.remove();
        identifyPopup.current = new maplibregl.Popup({
          className: "geolibre-identify-popup",
          closeButton: true,
          closeOnClick: false,
          maxWidth: "560px",
        })
          .setLngLat(event.lngLat)
          .setDOMContent(content)
          .addTo(map);
      };

      if (isPixelIdentifyLayer(layer)) {
        const identifyPixelAt = timeSliderBridge()?.identifyPixelAt;
        if (!identifyPixelAt) {
          clearIdentifyResult();
          return;
        }
        pixelIdentifyAbortController?.abort();
        const abortController = new AbortController();
        pixelIdentifyAbortController = abortController;
        selectFeature(null);
        showIdentifyPopup(createIdentifyMessagePopupElement(layer.name, "Loading..."));
        // Same dismissal dance as the WMS branch: the × on the loading popup
        // must cancel the read, but the programmatic swap to the result popup
        // also fires "close", so track user dismissal with a flag rather than
        // treating every close as a cancel.
        let userDismissed = false;
        const loadingPopup = identifyPopup.current;
        const onLoadingClose = () => {
          userDismissed = true;
          abortController.abort();
          if (pixelIdentifyAbortController === abortController) {
            pixelIdentifyAbortController = null;
          }
        };
        loadingPopup!.once("close", onLoadingClose);

        void identifyPixelAt(layer.id, [event.lngLat.lng, event.lngLat.lat], {
          signal: abortController.signal,
        })
          .then((result) => {
            if (userDismissed || abortController.signal.aborted) return;
            pixelIdentifyAbortController = null;
            loadingPopup?.off("close", onLoadingClose);
            // A null result means the click landed off the image grid, which is
            // an ordinary miss rather than a failure.
            showIdentifyPopup(
              result
                ? createIdentifyPopupElement(layer.name, pixelIdentifyProperties(result))
                : createIdentifyMessagePopupElement(layer.name, "No data at this location."),
            );
          })
          .catch((error: unknown) => {
            if (userDismissed || isAbortError(error) || abortController.signal.aborted) return;
            pixelIdentifyAbortController = null;
            loadingPopup?.off("close", onLoadingClose);
            const message =
              error instanceof Error ? error.message : "The pixel value could not be read.";
            showIdentifyPopup(createIdentifyMessagePopupElement(layer.name, message));
          });
        return;
      }

      if (isWmsLayer(layer)) {
        wmsIdentifyAbortController?.abort();
        const abortController = new AbortController();
        wmsIdentifyAbortController = abortController;
        selectFeature(null);
        showIdentifyPopup(createIdentifyMessagePopupElement(layer.name, "Loading..."));
        // Closing the loading popup (the × button) must cancel the in-flight
        // request so its result does not reopen a popup the user dismissed.
        // Track user dismissal with a flag rather than the abort signal: the
        // result swap calls remove() on this popup, which also fires "close",
        // and we must not treat that programmatic swap as a dismissal. Guard the
        // shared controller by identity so a newer request is not clobbered.
        let userDismissed = false;
        const loadingPopup = identifyPopup.current;
        const onLoadingClose = () => {
          userDismissed = true;
          abortController.abort();
          if (wmsIdentifyAbortController === abortController) {
            wmsIdentifyAbortController = null;
          }
        };
        // showIdentifyPopup just assigned identifyPopup.current, so it is set.
        loadingPopup!.once("close", onLoadingClose);

        void fetchWmsIdentifyProperties(layer, map, event, abortController.signal)
          .then((result) => {
            if (userDismissed || abortController.signal.aborted) return;
            wmsIdentifyAbortController = null;
            // Detach before the swap so remove()'s synchronous "close" does not
            // spuriously abort the request that just succeeded.
            loadingPopup?.off("close", onLoadingClose);
            showIdentifyPopup(
              createIdentifyPopupElement(layer.name, result?.properties ?? {}, result?.featureId),
            );
          })
          .catch((error: unknown) => {
            if (userDismissed || isAbortError(error) || abortController.signal.aborted) return;
            wmsIdentifyAbortController = null;
            loadingPopup?.off("close", onLoadingClose);
            const message =
              error instanceof Error ? error.message : "The WMS GetFeatureInfo request failed.";
            showIdentifyPopup(createIdentifyMessagePopupElement(layer.name, message));
          });
        return;
      }

      if (isDuckDBQueryLayer(layer)) {
        const result = duckDBBridge()?.identifyLayerAtPoint?.(layer.id, {
          x: event.point.x,
          y: event.point.y,
        });
        if (!result) {
          clearIdentifyResult();
          return;
        }

        selectFeature(result.featureId);
        showIdentifyPopup(
          createIdentifyPopupElement(layer.name, result.properties, result.featureId, {
            popup: layer.popup,
            fieldVisibility: layer.fieldVisibility,
            zoom: map.getZoom(),
          }),
        );
        return;
      }

      const queryLayerIds = identifyStyleLayerIds(layer).filter((id) => map.getLayer(id));
      if (queryLayerIds.length === 0) {
        clearIdentifyResult();
        return;
      }

      const [feature] = map.queryRenderedFeatures(event.point, {
        layers: queryLayerIds,
      });
      if (!feature) {
        clearIdentifyResult();
        return;
      }

      const featureId = findFeatureId(layer, feature);
      selectFeature(featureId);

      showIdentifyPopup(
        createIdentifyPopupElement(layer.name, feature.properties ?? {}, featureId ?? feature.id, {
          popup: layer.popup,
          fieldVisibility: layer.fieldVisibility,
          feature,
          zoom: map.getZoom(),
        }),
      );
    };

    map.on("click", handleIdentifyClick);

    return () => {
      wmsIdentifyAbortController?.abort();
      pixelIdentifyAbortController?.abort();
      map.off("click", handleIdentifyClick);
      identifyPopup.current?.remove();
      identifyPopup.current = null;
      // Starting a selection gesture turns Identify off, so this cleanup runs
      // after the gesture has already claimed the crosshair — leave its cursor
      // alone rather than resetting it out from under the drawing.
      if (!featureSelectionActive.current) map.getCanvas().style.cursor = "";
    };
  }, [
    identifyAllLabels,
    identifyLayerId,
    identifyRasterLayerAt,
    layers,
    selectFeature,
    selectLayer,
  ]);

  // Geotagged photos: clicking a photo point opens a resizable popup with the
  // photo, without needing the Identify tool. The popup is photo-specific, and
  // its box uses CSS `resize` so the thumbnail enlarges as it is dragged bigger.
  useEffect(() => {
    const map = controller.current?.getMap();
    if (!map) return;
    const photoLayerIds = photoLayerKey ? photoLayerKey.split(",") : [];
    if (photoLayerIds.length === 0) return;

    const removePhotoPopup = () => {
      photoPopup.current?.remove();
      photoPopup.current = null;
    };

    const handleClick = (event: maplibregl.MapLayerMouseEvent) => {
      // The Identify tool already renders the photo in its own popup; skip ours
      // so one click never opens two popups. Likewise while a selection gesture
      // is drawing, where a click is a vertex rather than a pick.
      if (useAppStore.getState().identifyLayerId || featureSelectionActive.current) return;
      const feature = event.features?.[0];
      if (!feature) return;
      // Anchor to the feature's own coordinate rather than the click point, so
      // the tip stays on the photo point even when the user clicks the edge of
      // a large marker.
      const geometry = feature.geometry;
      const anchor =
        geometry.type === "Point" ? (geometry.coordinates as [number, number]) : event.lngLat;
      removePhotoPopup();
      photoPopup.current = new maplibregl.Popup({
        className: "geolibre-photo-popup-root",
        closeButton: true,
        closeOnClick: true,
        maxWidth: "none",
      })
        .setLngLat(anchor)
        .setDOMContent(createPhotoPopupElement(feature.properties ?? {}))
        .addTo(map);
    };
    const handleEnter = () => {
      if (useAppStore.getState().identifyLayerId || featureSelectionActive.current) return;
      map.getCanvas().style.cursor = "pointer";
    };
    const handleLeave = () => {
      if (useAppStore.getState().identifyLayerId || featureSelectionActive.current) return;
      map.getCanvas().style.cursor = "";
    };

    // Photo points render as a circle by default, or a marker symbol when the
    // user enables markers; bind to whichever style layers actually exist.
    let boundIds: string[] = [];
    const unbind = () => {
      for (const id of boundIds) {
        map.off("click", id, handleClick);
        map.off("mouseenter", id, handleEnter);
        map.off("mouseleave", id, handleLeave);
      }
      boundIds = [];
    };
    const bind = () => {
      unbind();
      boundIds = photoLayerIds
        .flatMap((id) => [circleLayerId(id), markerLayerId(id)])
        .filter((id) => map.getLayer(id));
      for (const id of boundIds) {
        map.on("click", id, handleClick);
        map.on("mouseenter", id, handleEnter);
        map.on("mouseleave", id, handleLeave);
      }
    };

    bind();
    // syncLayers creates the circle/marker style layers and then dispatches this
    // event, so re-bind on it to catch layers that did not exist yet when this
    // effect first ran (e.g. before the style finished loading).
    window.addEventListener("geolibre-layer-labels-change", bind);
    // Close the photo popup when the Identify tool is turned on (which may
    // happen via a toolbar button, with no map click to dismiss it), so the
    // photo and identify popups never coexist.
    const unsubscribeIdentify = useAppStore.subscribe((state, prev) => {
      // Only on the off->on transition: the listener runs on every store change
      // (e.g. setPointerCoords on each mousemove), so guarding on the current
      // value alone would keep clobbering the Identify crosshair cursor.
      if (state.identifyLayerId && !prev.identifyLayerId) {
        removePhotoPopup();
        // If Identify is enabled while the cursor already sits on a photo point,
        // mouseleave never fires, so clear the hover cursor here too.
        map.getCanvas().style.cursor = "";
      }
    });

    return () => {
      window.removeEventListener("geolibre-layer-labels-change", bind);
      unsubscribeIdentify();
      unbind();
      removePhotoPopup();
    };
  }, [photoLayerKey]);

  // Hover tooltips (#2113): a lightweight tip following the pointer over the
  // layers whose author turned one on, showing the fields they flagged for
  // hover. Keyed on the ids AND the popup blocks, so editing the tooltip's
  // fields in the Style panel rebinds immediately.
  const hoverTooltipKey = useMemo(
    () =>
      layers
        // Group-aware, like the Identify handler and the selection query: a
        // layer whose own switch is on can still be hidden by its group, and
        // binding pointer handlers to it would be binding to something the
        // user cannot see. `applyGroupEffects` also sets the synced MapLibre
        // layer's visibility to `none`, so nothing fires today either way —
        // this keeps the two from drifting if that ever stops being true.
        .filter(
          (layer) =>
            effectiveLayerRenderState(layer, layerGroups).visible &&
            isPopupHoverEnabled(layer.popup),
        )
        .map((layer) => `${layer.id}\u0000${JSON.stringify(layer.popup ?? {})}`)
        .join("\u0001"),
    [layers, layerGroups],
  );

  useEffect(() => {
    const map = controller.current?.getMap();
    if (!map || !hoverTooltipKey) return;
    const hoverLayerIds = hoverTooltipKey.split("\u0001").map((part) => part.split("\u0000")[0]);

    // The pointer move that has not been drawn yet, and the frame that will
    // draw it. `mousemove` fires far more often than the screen refreshes, and
    // each tip rebuilds a small DOM tree, so moves are coalesced to one render
    // per frame rather than one per event.
    let pending: {
      layerId: string;
      feature: maplibregl.MapGeoJSONFeature;
      lngLat: maplibregl.LngLat;
    } | null = null;
    let pendingFrame = 0;
    // A `mouseleave` waiting for the same frame to decide. One logical layer
    // renders as several MapLibre style layers (a polygon's fill and its own
    // stroke, a point's circle and its marker), and this effect binds to each
    // of them, so crossing from a feature's fill onto that feature's own
    // stroke fires `mouseleave` on the first and `mousemove` on the second
    // from a single pointer event. Removing on the spot would tear the popup
    // down and rebuild it on every such crossing — and if the leave arrived
    // after the move, it would cancel the redraw and blank the tip until the
    // pointer moved again. Deferring the decision to the frame lets a move
    // anywhere in the same layer outvote the leave.
    let pendingLeave = false;

    /** Drop the tooltip now, discarding anything waiting on a frame. */
    const removeTooltip = () => {
      pending = null;
      pendingLeave = false;
      if (pendingFrame) {
        cancelAnimationFrame(pendingFrame);
        pendingFrame = 0;
      }
      hoverTooltip.current?.remove();
      hoverTooltip.current = null;
    };

    const drawPending = () => {
      pendingFrame = 0;
      const next = pending;
      const leaving = pendingLeave;
      pending = null;
      pendingLeave = false;
      // A move seen this frame means the pointer is still over one of this
      // layer's style layers, whichever one it left.
      if (!next) {
        if (leaving) removeTooltip();
        return;
      }
      // Read the layer from the store rather than from a captured array, so an
      // edit to the tooltip's fields shows on the very next pointer move.
      const layer = useAppStore.getState().layers.find((item) => item.id === next.layerId);
      if (!layer) {
        removeTooltip();
        return;
      }
      const content = createHoverTooltipElement(layer.name, next.feature.properties ?? {}, {
        popup: layer.popup,
        fieldVisibility: layer.fieldVisibility,
        feature: next.feature,
        zoom: map.getZoom(),
      });
      if (!content) {
        removeTooltip();
        return;
      }
      if (!hoverTooltip.current) {
        hoverTooltip.current = new maplibregl.Popup({
          className: "geolibre-hover-tooltip",
          closeButton: false,
          closeOnClick: false,
          // The tip must never sit under the cursor, or it would steal the
          // pointer from the feature and flicker itself in and out.
          offset: 12,
          maxWidth: "280px",
        }).addTo(map);
      }
      hoverTooltip.current.setLngLat(next.lngLat).setDOMContent(content);
    };

    const handleLeave = () => {
      pendingLeave = true;
      if (!pendingFrame) pendingFrame = requestAnimationFrame(drawPending);
    };

    /** Build the pointer handler for one hovered layer. */
    const moveHandlerFor = (layerId: string) => (event: maplibregl.MapLayerMouseEvent) => {
      // A selection gesture owns the pointer while it draws, and the Identify
      // crosshair means the user is about to click for the full popup: neither
      // wants a tip trailing the cursor.
      if (featureSelectionActive.current || useAppStore.getState().identifyLayerId) {
        removeTooltip();
        return;
      }
      const feature = event.features?.[0];
      if (!feature) {
        removeTooltip();
        return;
      }
      pending = { layerId, feature, lngLat: event.lngLat };
      pendingLeave = false;
      if (!pendingFrame) pendingFrame = requestAnimationFrame(drawPending);
    };

    // Style-layer id -> the handler bound to it, so unbinding detaches the very
    // same function reference MapLibre was given.
    let bound: {
      id: string;
      move: (event: maplibregl.MapLayerMouseEvent) => void;
    }[] = [];
    const unbind = () => {
      for (const entry of bound) {
        map.off("mousemove", entry.id, entry.move);
        map.off("mouseleave", entry.id, handleLeave);
      }
      bound = [];
    };
    const bind = () => {
      unbind();
      const layersById = new Map(useAppStore.getState().layers.map((layer) => [layer.id, layer]));
      for (const layerId of hoverLayerIds) {
        const layer = layersById.get(layerId);
        if (!layer) continue;
        const move = moveHandlerFor(layerId);
        for (const styleLayerId of identifyStyleLayerIds(layer)) {
          if (!map.getLayer(styleLayerId)) continue;
          map.on("mousemove", styleLayerId, move);
          map.on("mouseleave", styleLayerId, handleLeave);
          bound.push({ id: styleLayerId, move });
        }
      }
    };

    bind();
    // syncLayers creates the style layers and then dispatches this event, so
    // re-bind on it to catch layers that did not exist yet on the first run.
    window.addEventListener("geolibre-layer-labels-change", bind);
    // A selection gesture takes the pointer the same way Identify does, and can
    // be armed from a menu with the cursor sitting still on a hovered feature.
    window.addEventListener(FEATURE_SELECTION_BEGIN_EVENT, removeTooltip);
    // Identify is armed from the toolbar, with no pointer event to hide a tip
    // that is already open. `mouseleave` does not fire under a motionless
    // cursor, so without this the tooltip would sit there while the Identify
    // popup opened beside it. Same off->on guard as the photo-popup effect:
    // this listener runs on every store change, so testing the current value
    // alone would keep clearing a tip the user is still reading.
    const unsubscribeIdentify = useAppStore.subscribe((state, prev) => {
      if (state.identifyLayerId && !prev.identifyLayerId) removeTooltip();
    });

    return () => {
      window.removeEventListener("geolibre-layer-labels-change", bind);
      window.removeEventListener(FEATURE_SELECTION_BEGIN_EVENT, removeTooltip);
      unsubscribeIdentify();
      unbind();
      removeTooltip();
    };
  }, [hoverTooltipKey]);

  useEffect(() => {
    controller.current?.applyView(mapView);
  }, [mapView.center[0], mapView.center[1], mapView.zoom, mapView.bearing, mapView.pitch]);

  return <div ref={containerRef} className="h-full w-full" data-testid="map-canvas" />;
});
