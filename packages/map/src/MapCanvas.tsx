import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import maplibregl from "maplibre-gl";
import { memo, useEffect, useRef } from "react";
import {
  circleLayerId,
  fillExtrusionLayerId,
  fillLayerId,
  lineLayerId,
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
const WMS_IDENTIFY_INFO_FORMATS = [
  "application/json",
  "text/html",
  "text/plain",
];

export interface MapCanvasProps {
  controllerRef?: React.MutableRefObject<MapController | null>;
  onControllerReady?: () => void;
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
  rows.className = "geolibre-identify-popup-rows pr-2";
  root.appendChild(rows);

  const appendRow = (key: string, value: unknown) => {
    const row = document.createElement("div");
    row.className =
      "grid grid-cols-[minmax(5rem,0.45fr)_1fr] gap-2 border-t py-1";

    const keyCell = document.createElement("div");
    keyCell.className = "break-words font-medium text-muted-foreground";
    keyCell.textContent = key;

    const valueCell = document.createElement("div");
    valueCell.className = "break-words text-foreground";
    valueCell.textContent = stringifyIdentifyValue(value);

    row.append(keyCell, valueCell);
    rows.appendChild(row);
  };

  if (featureId != null) appendRow("id", featureId);

  const entries = Object.entries(properties);
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

function createIdentifyMessagePopupElement(
  layerName: string,
  message: string,
): HTMLElement {
  return createIdentifyPopupElement(layerName, { status: message });
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

function findFeatureId(
  layer: GeoLibreLayer,
  feature: maplibregl.MapGeoJSONFeature,
): string | null {
  if (feature.id != null) return String(feature.id);
  if (!layer.geojson) return null;

  const properties = feature.properties ?? {};
  const propertyKeys = Object.keys(properties);
  const index = layer.geojson.features.findIndex((candidate) => {
    const candidateProperties = candidate.properties ?? {};
    return propertyKeys.every(
      (key) => candidateProperties[key] === properties[key],
    );
  });

  return index >= 0 ? String(layer.geojson.features[index].id ?? index) : null;
}

function isWmsLayer(layer: GeoLibreLayer): boolean {
  return layer.type === "wms";
}

function stringSource(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function appendWmsQuery(
  endpoint: string,
  params: Array<[string, string]>,
): string {
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
      .map(
        ([key, value]) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
      )
      .join("&");
    return `${base}${separator}${query}`;
  }
}

function lngLatToWebMercator(lng: number, lat: number): [number, number] {
  const clampedLat = Math.max(
    -WEB_MERCATOR_MAX_LATITUDE,
    Math.min(WEB_MERCATOR_MAX_LATITUDE, lat),
  );
  const x = WEB_MERCATOR_EARTH_RADIUS * (lng * Math.PI) / 180;
  const y =
    WEB_MERCATOR_EARTH_RADIUS *
    Math.log(Math.tan(Math.PI / 4 + (clampedLat * Math.PI) / 360));
  return [x, y];
}

function wmsIdentifyResolution(zoom: number): number {
  const normalizedZoom = Number.isFinite(zoom) ? Math.max(0, zoom) : 0;
  return WEB_MERCATOR_WORLD_SIZE / (MAPLIBRE_TILE_SIZE * 2 ** normalizedZoom);
}

function wmsIdentifyBbox3857(
  map: maplibregl.Map,
  lngLat: maplibregl.LngLat,
): string {
  const [centerX, centerY] = lngLatToWebMercator(lngLat.lng, lngLat.lat);
  const halfSpan =
    (WMS_IDENTIFY_QUERY_SIZE * wmsIdentifyResolution(map.getZoom())) / 2;
  return [
    centerX - halfSpan,
    centerY - halfSpan,
    centerX + halfSpan,
    centerY + halfSpan,
  ].join(",");
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
  return isViteDevServer()
    ? `${WMS_PROXY_PATH}?url=${encodeURIComponent(url)}`
    : url;
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
      !(
        "features" in first &&
        Array.isArray((first as Record<string, unknown>).features)
      )
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
      "id" in feature &&
      (typeof feature.id === "string" || typeof feature.id === "number")
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
  const infoFormats = configuredFormat
    ? [configuredFormat]
    : WMS_IDENTIFY_INFO_FORMATS;

  for (const infoFormat of infoFormats) {
    const targetUrl = createWmsGetFeatureInfoUrl(layer, map, event, infoFormat);
    if (!targetUrl) return null;

    const response = await fetch(proxyWmsRequestUrl(targetUrl), { signal });
    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? infoFormat;
    // Response.text() cannot take a signal, so bail out as soon as the read
    // resolves if the request was aborted meanwhile, skipping parsing.
    const text = await response.text();
    if (signal.aborted) return null;
    if (!response.ok) {
      // HTTP/2 drops the reason phrase, so statusText is often "". Fall back to
      // the status code so a failed request never surfaces as "No attributes".
      fallbackText =
        normalizeText(text) || response.statusText || `HTTP ${response.status}`;
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
  return (
    (error instanceof DOMException || error instanceof Error) &&
    error.name === "AbortError"
  );
}

export const MapCanvas = memo(function MapCanvas({
  controllerRef,
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

  const basemapStyleUrl = useAppStore((s) => s.basemapStyleUrl);
  const basemapVisible = useAppStore((s) => s.basemapVisible);
  const basemapOpacity = useAppStore((s) => s.basemapOpacity);
  const mapPreferences = useAppStore((s) => s.preferences.map);
  const mapView = useAppStore((s) => s.mapView);
  const layers = useAppStore((s) => s.layers);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const selectedFeatureId = useAppStore((s) => s.selectedFeatureId);
  const identifyLayerId = useAppStore((s) => s.identifyLayerId);
  const zoomToSelectedFeature = useAppStore((s) => s.ui.zoomToSelectedFeature);
  const selectFeature = useAppStore((s) => s.selectFeature);
  const setMapView = useAppStore((s) => s.setMapView);
  const setPointerCoords = useAppStore((s) => s.setPointerCoords);
  const previousSelectedFeatureKey = useRef<string | null>(null);
  const identifyPopup = useRef<maplibregl.Popup | null>(null);

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

    const updateView = (event?: { originalEvent?: unknown }) =>
      setMapView(mc.readView(), Boolean(event?.originalEvent));
    map.on("moveend", updateView);
    map.on("load", () => {
      mc.waitAndSyncLayers(useAppStore.getState().layers);
      mc.setBasemapVisible(useAppStore.getState().basemapVisible);
      mc.setBasemapOpacity(useAppStore.getState().basemapOpacity);
      const state = useAppStore.getState();
      mc.highlightFeature(
        state.layers.find((layer) => layer.id === state.selectedLayerId),
        state.selectedFeatureId,
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
      controller.current?.waitAndSyncLayers(useAppStore.getState().layers);
      controller.current?.setBasemapVisible(
        useAppStore.getState().basemapVisible,
      );
      controller.current?.setBasemapOpacity(
        useAppStore.getState().basemapOpacity,
      );
      const state = useAppStore.getState();
      controller.current?.highlightFeature(
        state.layers.find((layer) => layer.id === state.selectedLayerId),
        state.selectedFeatureId,
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

  useEffect(() => {
    controller.current?.waitAndSyncLayers(layers);
  }, [layers]);

  useEffect(() => {
    const layer = layers.find((item) => item.id === selectedLayerId);
    const nextKey =
      selectedLayerId && selectedFeatureId
        ? `${selectedLayerId}:${selectedFeatureId}`
        : null;
    const shouldFit = Boolean(
      zoomToSelectedFeature &&
      nextKey &&
      nextKey !== previousSelectedFeatureKey.current,
    );
    previousSelectedFeatureKey.current = nextKey;
    controller.current?.highlightFeature(layer, selectedFeatureId, {
      fit: shouldFit,
    });
  }, [layers, selectedLayerId, selectedFeatureId, zoomToSelectedFeature]);

  useEffect(() => {
    const map = controller.current?.getMap();
    const layer = layers.find((item) => item.id === identifyLayerId);
    if (!map || !layer) {
      identifyPopup.current?.remove();
      identifyPopup.current = null;
      if (map) map.getCanvas().style.cursor = "";
      return;
    }

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
        showIdentifyPopup(
          createIdentifyMessagePopupElement(layer.name, "Loading..."),
        );
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

        void fetchWmsIdentifyProperties(
          layer,
          map,
          event,
          abortController.signal,
        )
          .then((result) => {
            if (userDismissed || abortController.signal.aborted) return;
            wmsIdentifyAbortController = null;
            // Detach before the swap so remove()'s synchronous "close" does not
            // spuriously abort the request that just succeeded.
            loadingPopup?.off("close", onLoadingClose);
            showIdentifyPopup(
              createIdentifyPopupElement(
                layer.name,
                result?.properties ?? {},
                result?.featureId,
              ),
            );
          })
          .catch((error: unknown) => {
            if (userDismissed || isAbortError(error) || abortController.signal.aborted)
              return;
            wmsIdentifyAbortController = null;
            loadingPopup?.off("close", onLoadingClose);
            const message =
              error instanceof Error
                ? error.message
                : "The WMS GetFeatureInfo request failed.";
            showIdentifyPopup(
              createIdentifyMessagePopupElement(layer.name, message),
            );
          });
        return;
      }

      const queryLayerIds = identifyStyleLayerIds(layer).filter((id) =>
        map.getLayer(id),
      );
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
        createIdentifyPopupElement(
          layer.name,
          feature.properties ?? {},
          featureId ?? feature.id,
        ),
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

  useEffect(() => {
    controller.current?.applyView(mapView);
  }, [
    mapView.center[0],
    mapView.center[1],
    mapView.zoom,
    mapView.bearing,
    mapView.pitch,
  ]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      data-testid="map-canvas"
    />
  );
});
