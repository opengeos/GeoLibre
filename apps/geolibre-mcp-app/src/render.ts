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
  registerPMTilesSource,
  resolveMapStyle,
  sourceId,
  styleLayerZoomRange,
  unregisterPMTilesArchive,
} from "@geolibre/map/headless";
import type { RequestTransformFunction } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import { loadCogPreview } from "./cog-preview";
import type { NetworkConsent } from "./network-consent";
import {
  ConsentPMTilesSource,
  isRegisteredPMTilesRequest,
  pmtilesArchiveKey,
  pmtilesArchiveUrl,
  previewPMTilesStyleLayerIds,
} from "./pmtiles-preview";
import { previewRenderLayers } from "./unsupported-content";
import { previewI18n } from "./preview-i18n";

const t = previewI18n.getFixedT(null, "translation", "mcpPreview.render");

export interface PreviewRenderOptions {
  transformRequest: RequestTransformFunction;
  /** Consent-gated range reads, for PMTiles archives and COGs. */
  fetchRange: NetworkConsent["fetchRange"];
  onReady(): void;
  onError(source: string, message: string): void;
  /** A note about a layer that rendered with a caveat (e.g. an unknown colormap). */
  onNotice?(message: string): void;
}

/** Decoded COG previews served to MapLibre's image source, by request URL. */
const COG_PROTOCOL = "geolibre-cog";
const cogImages = new Map<string, ArrayBuffer>();
let cogImageSequence = 0;

async function encodePng(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<ArrayBuffer> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(t("canvasFailed"));
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error(t("encodeFailed"));
  return blob.arrayBuffer();
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
  const layers = applyGroupEffects(project.layers, project.layerGroups ?? []);
  const plan = previewRenderLayers({ ...project, layers });
  const renderable = plan.map(({ layer }) => layer);

  // Each remote archive reads through consent before layer sync can open a
  // direct FetchSource for it under the same key.
  const pmtilesKeys = new Set<string>();
  for (const { layer, kind } of plan) {
    if (kind !== "pmtiles") continue;
    const key = pmtilesArchiveKey(layer);
    const url = pmtilesArchiveUrl(layer);
    if (!key || !url || pmtilesKeys.has(key)) continue;
    registerPMTilesSource(new ConsentPMTilesSource(key, url, options.fetchRange));
    pmtilesKeys.add(key);
  }
  const ownCogUrls = new Set<string>();
  const transformRequest: RequestTransformFunction = (url, resourceType) => {
    if (isRegisteredPMTilesRequest(url, pmtilesKeys)) return { url };
    if (ownCogUrls.has(url)) return { url };
    return options.transformRequest(url, resourceType);
  };
  maplibregl.addProtocol(COG_PROTOCOL, async (request) => {
    const data = cogImages.get(request.url);
    if (!data) throw new Error(t("imageUnavailable"));
    return { data };
  });
  const lifecycle = new AbortController();

  const map = new maplibregl.Map({
    container,
    style: useBlankStyle ? createBlankMapStyle() : resolveMapStyle(project.basemapStyleUrl),
    center: project.mapView.center,
    zoom: project.mapView.zoom,
    bearing: project.mapView.bearing,
    pitch: project.mapView.pitch,
    attributionControl: { compact: true },
    maplibreLogo: false,
    transformRequest,
  });
  map.once("remove", () => {
    lifecycle.abort();
    for (const key of pmtilesKeys) unregisterPMTilesArchive(key);
    for (const url of ownCogUrls) cogImages.delete(url);
    maplibregl.removeProtocol(COG_PROTOCOL);
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  let styleReady = false;
  let usedBlankFallback = useBlankStyle;
  let notifiedReady = false;

  const addCogLayer = async (layer: GeoLibreLayer, anchorId: string): Promise<void> => {
    try {
      const image = await loadCogPreview(layer, options.fetchRange, lifecycle.signal);
      if (image.unknownColormap) {
        options.onNotice?.(
          t("unknownColormap", { name: layer.name, colormap: image.unknownColormap }),
        );
      }
      const png = await encodePng(image.rgba, image.width, image.height);
      if (lifecycle.signal.aborted) return;
      const url = `${COG_PROTOCOL}://${(cogImageSequence += 1)}`;
      cogImages.set(url, png);
      ownCogUrls.add(url);
      const id = `${layer.id}-cog-preview`;
      map.addSource(id, { type: "image", url, coordinates: image.corners });
      map.addLayer(
        {
          id,
          type: "raster",
          source: id,
          ...styleLayerZoomRange(layer.style),
          paint: { "raster-opacity": layer.opacity, "raster-fade-duration": 0 },
        },
        map.getLayer(anchorId) ? anchorId : undefined,
      );
    } catch (error) {
      if (lifecycle.signal.aborted) return;
      options.onError(
        layer.name,
        safeErrorMessage(error instanceof Error ? error.message : String(error)),
      );
    }
  };

  const registerLayers = (): void => {
    for (const { layer, kind } of plan) {
      try {
        if (kind === "cog") {
          // Holds the COG's place in the stack while it decodes, so it lands
          // under the layers above it rather than on top of everything.
          const anchorId = `${layer.id}-cog-anchor`;
          map.addLayer({
            id: anchorId,
            type: "background",
            layout: { visibility: "none" },
          });
          void addCogLayer(layer, anchorId);
          continue;
        }
        // One sync owner per layer isolates failures while preserving the project’s
        // bottom-to-top order: each successful MapLibre layer is added above the last.
        createLayerSync(map).sync([layer]);
      } catch {
        options.onError(layer.id, t("registrationFailed", { name: layer.name }));
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
      const ids = [
        ...new Set([...identifyStyleLayerIds(layer), ...previewPMTilesStyleLayerIds(layer)]),
      ].filter((id) => map.getLayer(id));
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
