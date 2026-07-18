import {
  applyGroupEffects,
  isDuckDBQueryLayer,
  PHOTO_FULL_PROPERTY,
  PHOTO_PROPERTY,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import maplibregl from "maplibre-gl";
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
import { createMapController, type MapController } from "./map-controller";
import "maplibre-gl/dist/maplibre-gl.css";
import "maplibre-gl-layer-control/style.css";
import "./layer-control-overrides.css";

const PANEL_RESIZE_START_EVENT = "geolibre:panel-resize-start";
const PANEL_RESIZE_END_EVENT = "geolibre:panel-resize-end";
const WMS_PROXY_PATH = "/__geolibre_wms_proxy";
const WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066;
const WEB_MERCATOR_EARTH_RADIUS = 6378137;
const WEB_MERCATOR_WORLD_SIZE = 2 * Math.PI * WEB_MERCATOR_EARTH_RADIUS;
const MAPLIBRE_TILE_SIZE = 512;
const WMS_IDENTIFY_QUERY_SIZE = 101;
const WMS_IDENTIFY_QUERY_CENTER = Math.floor(WMS_IDENTIFY_QUERY_SIZE / 2);
const WMS_IDENTIFY_INFO_FORMATS = ["application/json", "text/html", "text/plain"];

export interface MapCanvasProps {
  controllerRef?: React.MutableRefObject<MapController | null>;
  onMapDiagnosticEvent?: (event: MapDiagnosticEvent) => void;
  onControllerReady?: () => void;
}

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

function stringifyIdentifyValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function createIdentifyPopupElement(
  layerName: string,
  properties: Record<string, unknown>,
  featureId?: string | number,
): HTMLElement {
  const root = document.createElement("div");
  root.className =
    "geolibre-identify-popup-root flex min-w-[min(18rem,calc(100vw-48px))] max-w-[min(520px,calc(100vw-48px))] flex-col text-xs";

  const title = document.createElement("div");
  title.className = "mb-2 font-semibold text-foreground";
  title.textContent = layerName;
  root.appendChild(title);

  const rows = document.createElement("div");
  rows.className = "geolibre-identify-popup-rows pe-2";
  root.appendChild(rows);

  const appendRow = (key: string, value: unknown) => {
    const row = document.createElement("div");
    row.className = "grid grid-cols-[minmax(5rem,0.45fr)_1fr] gap-2 border-t py-1";

    const keyCell = document.createElement("div");
    keyCell.className = "break-words font-medium text-muted-foreground";
    keyCell.textContent = key;

    const valueCell = document.createElement("div");
    valueCell.className = "break-words text-foreground";
    // Render inline image data URLs (e.g. a geotagged-photo or field-collection
    // thumbnail) as an actual thumbnail rather than a multi-kilobyte string.
    // Match base64 raster images only, excluding SVG (which can carry scripts)
    // so an untrusted GeoJSON value can't smuggle one in.
    if (typeof value === "string" && /^data:image\/(?!svg)[\w.+-]+;base64,/i.test(value)) {
      const image = document.createElement("img");
      image.src = value;
      image.alt = key;
      image.loading = "lazy";
      image.className = "max-h-40 max-w-full rounded";
      valueCell.appendChild(image);
    } else {
      valueCell.textContent = stringifyIdentifyValue(value);
    }

    row.append(keyCell, valueCell);
    rows.appendChild(row);
  };

  if (featureId != null) appendRow("id", featureId);

  // Skip the full-resolution image: it is an internal companion to the
  // thumbnail, so Identify shouldn't decode a multi-megapixel data URL just to
  // show a second copy of the same photo in the same small box. Filter before
  // the empty-state check so a feature whose only property is `photo_full` still
  // reports "No attributes" rather than rendering an empty panel.
  const entries = Object.entries(properties).filter(([key]) => key !== PHOTO_FULL_KEY);
  if (entries.length === 0 && featureId == null) {
    const empty = document.createElement("div");
    empty.className = "text-muted-foreground";
    empty.textContent = "No attributes";
    rows.appendChild(empty);
  } else {
    for (const [key, value] of entries) appendRow(key, value);
  }

  return root;
}

function createIdentifyMessagePopupElement(layerName: string, message: string): HTMLElement {
  return createIdentifyPopupElement(layerName, { status: message });
}

/** Match an inline base64 raster image (excludes SVG, which can carry scripts). */
const INLINE_IMAGE_DATA_URL = /^data:image\/(?!svg)[\w.+-]+;base64,/i;

// Feature-property keys for geotagged/field-collection photos, from the shared
// @geolibre/core schema: the popup shows the light thumbnail while the fullscreen
// viewer and "Save image" use the embedded full-resolution image.
const PHOTO_THUMBNAIL_KEY = PHOTO_PROPERTY;
const PHOTO_FULL_KEY = PHOTO_FULL_PROPERTY;

/** Return the value at `key` when it is an inline raster image data URL. */
function imageDataUrlAt(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key];
  return typeof value === "string" && INLINE_IMAGE_DATA_URL.test(value) ? value : null;
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
    if (key !== PHOTO_FULL_KEY && typeof value === "string" && INLINE_IMAGE_DATA_URL.test(value)) {
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
  const mapPreferences = useAppStore((s) => s.preferences.map);
  const mapView = useAppStore((s) => s.mapView);
  const layers = useAppStore((s) => s.layers);
  const layerGroups = useAppStore((s) => s.layerGroups);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const selectedFeatureId = useAppStore((s) => s.selectedFeatureId);
  const selectedFeatureIds = useAppStore((s) => s.selectedFeatureIds);
  const identifyLayerId = useAppStore((s) => s.identifyLayerId);
  const zoomToSelectedFeature = useAppStore((s) => s.ui.zoomToSelectedFeature);
  const selectFeature = useAppStore((s) => s.selectFeature);
  const setMapView = useAppStore((s) => s.setMapView);
  const setPointerCoords = useAppStore((s) => s.setPointerCoords);
  const previousSelectedFeatureKey = useRef<string | null>(null);
  const previousDuckDBSelectionLayerId = useRef<string | null>(null);
  const identifyPopup = useRef<maplibregl.Popup | null>(null);
  const photoPopup = useRef<maplibregl.Popup | null>(null);

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

    map.on("mousemove", (e) => {
      setPointerCoords([e.lngLat.lng, e.lngLat.lat]);
    });
    map.on("mouseout", () => setPointerCoords(null));
    map.on("error", (event) => {
      // Cancelled tile fetches are already surfaced (as info) by the
      // network capture; logging them here would double-count aborts.
      if (isAbortError(event.error)) return;
      onMapDiagnosticEventRef.current?.(mapErrorDiagnosticEvent(event));
    });

    const updateView = (event?: { originalEvent?: unknown }) => {
      // While presenting a story map the presenter owns the camera. Syncing its
      // transient chapter flies and rotations back into the store would both
      // overwrite the saved project view and, worse, re-enter the applyView
      // effect below: its jumpTo cancels an in-flight chapter fly, after which
      // the rotate handler starts orbiting the previous chapter instead of the
      // one just clicked. Skipping the sync keeps the presenter authoritative.
      if (useAppStore.getState().ui.storymapPresenting) return;
      setMapView(mc.readView(), Boolean(event?.originalEvent));
    };
    map.on("moveend", updateView);

    // Persist projection toggles (the GlobeControl) into project preferences so
    // a project reopens with the projection it was saved in. getProjection()
    // returns the configured type, so the internal globe→mercator switch at high
    // zoom (which also fires this event) leaves the stored preference unchanged.
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
    map.on("projectiontransition", updateProjection);
    map.on("load", () => {
      const state = useAppStore.getState();
      mc.waitAndSyncLayers(applyGroupEffects(state.layers, state.layerGroups));
      mc.setBasemapVisible(state.basemapVisible);
      mc.setBasemapOpacity(state.basemapOpacity);
      mc.highlightFeature(
        state.layers.find((layer) => layer.id === state.selectedLayerId),
        resolveHighlightIds(state),
      );
      updateView();
      onControllerReadyRef.current?.();
    });

    let resizeFrame: number | null = null;
    let panelResizeActive = false;
    let resizeAfterPanelResize = false;
    const resizeMap = () => {
      if (panelResizeActive) {
        resizeAfterPanelResize = true;
        return;
      }

      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        mc.getMap()?.resize();
      });
    };
    const onPanelResizeStart = () => {
      panelResizeActive = true;
      resizeAfterPanelResize = false;
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
      }
    };
    const onPanelResizeEnd = () => {
      panelResizeActive = false;
      if (resizeAfterPanelResize) {
        resizeAfterPanelResize = false;
      }
      resizeMap();
    };
    const resizeObserver = new ResizeObserver(resizeMap);
    resizeObserver.observe(containerRef.current);
    window.addEventListener(PANEL_RESIZE_START_EVENT, onPanelResizeStart);
    window.addEventListener(PANEL_RESIZE_END_EVENT, onPanelResizeEnd);
    resizeMap();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener(PANEL_RESIZE_START_EVENT, onPanelResizeStart);
      window.removeEventListener(PANEL_RESIZE_END_EVENT, onPanelResizeEnd);
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
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
      controller.current?.waitAndSyncLayers(applyGroupEffects(state.layers, state.layerGroups));
      controller.current?.setBasemapVisible(state.basemapVisible);
      controller.current?.setBasemapOpacity(state.basemapOpacity);
      controller.current?.highlightFeature(
        state.layers.find((layer) => layer.id === state.selectedLayerId),
        resolveHighlightIds(state),
      );
      onControllerReadyRef.current?.();
    });
    controller.current?.setStyle(basemapStyleUrl);
  }, [basemapStyleUrl]);

  useEffect(() => {
    controller.current?.setBasemapVisible(basemapVisible);
  }, [basemapVisible]);

  useEffect(() => {
    controller.current?.setBasemapOpacity(basemapOpacity);
  }, [basemapOpacity]);

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
    const layer = layers.find((item) => item.id === identifyLayerId);
    if (!map || !layer) {
      identifyPopup.current?.remove();
      identifyPopup.current = null;
      if (map) map.getCanvas().style.cursor = "";
      return;
    }

    // COG layers are identified by the raster control's pixel inspector (driven
    // by useRasterIdentify in the desktop app), not this vector/WMS feature
    // query. Bail so the two don't both register a map-click handler. (Only
    // "cog" is identify-enabled; plain "raster" never reaches here.)
    if (layer.type === "cog") return;

    map.getCanvas().style.cursor = "crosshair";

    let wmsIdentifyAbortController: AbortController | null = null;

    const handleIdentifyClick = (event: maplibregl.MapMouseEvent) => {
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
          createIdentifyPopupElement(layer.name, result.properties, result.featureId),
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
        createIdentifyPopupElement(layer.name, feature.properties ?? {}, featureId ?? feature.id),
      );
    };

    map.on("click", handleIdentifyClick);

    return () => {
      wmsIdentifyAbortController?.abort();
      map.off("click", handleIdentifyClick);
      identifyPopup.current?.remove();
      identifyPopup.current = null;
      map.getCanvas().style.cursor = "";
    };
  }, [identifyLayerId, layers, selectFeature]);

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
      // so one click never opens two popups.
      if (useAppStore.getState().identifyLayerId) return;
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
      if (useAppStore.getState().identifyLayerId) return;
      map.getCanvas().style.cursor = "pointer";
    };
    const handleLeave = () => {
      if (useAppStore.getState().identifyLayerId) return;
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

  useEffect(() => {
    controller.current?.applyView(mapView);
  }, [mapView.center[0], mapView.center[1], mapView.zoom, mapView.bearing, mapView.pitch]);

  return <div ref={containerRef} className="h-full w-full" data-testid="map-canvas" />;
});
