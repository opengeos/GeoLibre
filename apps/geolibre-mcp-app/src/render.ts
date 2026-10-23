import {
  applyGroupEffects,
  isPopupClickEnabled,
  type GeoLibreProject,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  createBlankMapStyle,
  createIdentifyPopupElement,
  createLayerSync,
  identifyStyleLayerIds,
  isMapboxStyleUrl,
  resolveMapStyle,
  sourceId,
} from "@geolibre/map/headless";
import type { RequestTransformFunction } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import { previewableLayers } from "./unsupported-content";

export interface PreviewRenderOptions {
  transformRequest: RequestTransformFunction;
  onReady(): void;
  onError(source: string, message: string): void;
}

type PreviewMapError = maplibregl.ErrorEvent & {
  sourceId?: string;
  sourceLayer?: string;
};

function errorSource(event: PreviewMapError, layers: GeoLibreLayer[]): string {
  const sourceIdValue = event.sourceId;
  if (!sourceIdValue) return "map style";
  const layer = layers.find(
    (candidate) =>
      sourceId(candidate.id) === sourceIdValue ||
      candidate.id === sourceIdValue ||
      (Array.isArray(candidate.metadata.sourceIds) &&
        candidate.metadata.sourceIds.includes(sourceIdValue)),
  );
  return layer
    ? `${layer.name} (${sourceIdValue}${event.sourceLayer ? ` · ${event.sourceLayer}` : ""})`
    : event.sourceLayer
      ? `${sourceIdValue} (${event.sourceLayer})`
      : sourceIdValue;
}

function safeErrorMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
      try {
        return new URL(value).origin;
      } catch {
        return "[remote URL]";
      }
    })
    .replace(/([?&](?:[^=\s&]+)=)[^\s&]+/g, "$1[redacted]");
}

function reportMapError(
  event: PreviewMapError,
  layers: GeoLibreLayer[],
  options: PreviewRenderOptions,
): void {
  options.onError(errorSource(event, layers), safeErrorMessage(event.error.message));
}

function previewPopup(layer: GeoLibreLayer): GeoLibreLayer["popup"] {
  const popup = layer.popup;
  if (!popup?.fields?.some((field) => field.kind === "image")) return popup;
  // The shared popup renderer assigns image values directly to img.src, outside
  // MapLibre's request transform. Show these values as text in this sandbox.
  return {
    ...popup,
    fields: popup.fields.map((field) =>
      field.kind === "image" ? { ...field, kind: "text" } : field,
    ),
  };
}

export function renderProject(
  container: HTMLElement,
  project: GeoLibreProject,
  options: PreviewRenderOptions,
): maplibregl.Map {
  const useBlankStyle =
    project.basemapVisible === false || isMapboxStyleUrl(project.basemapStyleUrl);
  const map = new maplibregl.Map({
    container,
    style: useBlankStyle ? createBlankMapStyle() : resolveMapStyle(project.basemapStyleUrl),
    center: project.mapView.center,
    zoom: project.mapView.zoom,
    bearing: project.mapView.bearing,
    pitch: project.mapView.pitch,
    attributionControl: { compact: true },
    maplibreLogo: false,
    transformRequest: options.transformRequest,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  const layers = applyGroupEffects(project.layers, project.layerGroups ?? []);
  const renderable = previewableLayers({ ...project, layers });
  let styleReady = false;
  let usedBlankFallback = useBlankStyle;
  let notifiedReady = false;

  const registerLayers = (): void => {
    for (const layer of renderable) {
      try {
        // One sync owner per layer isolates failures while preserving the project’s
        // bottom-to-top order: each successful MapLibre layer is added above the last.
        createLayerSync(map).sync([layer]);
      } catch {
        options.onError(
          layer.id,
          `Could not register layer “${layer.name}”; other layers will still be shown.`,
        );
      }
    }
    if (!notifiedReady) {
      notifiedReady = true;
      options.onReady();
    }
  };

  // Attach before load so a failed remote style cannot strand the view. A style
  // document failure falls back once; later tile/source failures are reported
  // without replacing the working style or its already registered layers.
  map.on("error", (event) => {
    const previewError = event as PreviewMapError;
    reportMapError(previewError, renderable, options);
    if (!styleReady && !usedBlankFallback && !previewError.sourceId) {
      usedBlankFallback = true;
      map.setStyle(createBlankMapStyle());
    }
  });
  map.on("style.load", () => {
    if (styleReady) return;
    styleReady = true;
    registerLayers();
  });

  const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "340px" });
  map.on("click", (event) => {
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const layer = layers[index];
      if (!layer.visible || !isPopupClickEnabled(layer.popup)) continue;
      const ids = identifyStyleLayerIds(layer).filter((id) => map.getLayer(id));
      if (ids.length === 0) continue;
      const [feature] = map.queryRenderedFeatures(event.point, { layers: ids });
      if (!feature) continue;
      popup
        .setLngLat(event.lngLat)
        .setDOMContent(
          createIdentifyPopupElement(layer.name, feature.properties ?? {}, feature.id, {
            popup: previewPopup(layer),
            fieldVisibility: layer.fieldVisibility,
            feature,
            zoom: map.getZoom(),
          }),
        )
        .addTo(map);
      return;
    }
    popup.remove();
  });
  return map;
}
