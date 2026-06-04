import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  type LayerStyle,
  styleValue,
} from "@geolibre/core";
import { addProtocol, config } from "maplibre-gl";
import type maplibregl from "maplibre-gl";
import { PMTiles, Protocol } from "pmtiles";
import {
  circleLayerId,
  detectGeometryProfile,
  fillExtrusionLayerId,
  fillLayerId,
  lineLayerId,
  sourceId,
} from "./geojson-loader";
import { isPlaceholderLayer } from "./placeholders";
import {
  circlePaint,
  fillExtrusionPaint,
  fillPaint,
  linePaint,
  rasterPaint,
} from "./style-mapper";

const WMS_PROXY_PATH = "/__geolibre_wms_proxy";
const PMTILES_PROTOCOL = "pmtiles";
const PMTILES_PROTOCOL_GLOBAL_KEY = "__geolibrePMTilesProtocol";
const MIN_LAYER_ZOOM = DEFAULT_LAYER_STYLE.minZoom;
const MAX_LAYER_ZOOM = DEFAULT_LAYER_STYLE.maxZoom;

// Native layer ids whose zoom range GeoLibre has taken over. A pristine external
// layer keeps its source-declared range, but once the user sets a non-default
// range we keep applying the style range on every sync, including a later reset
// back to the full [0, 24] window.
const managedZoomRangeLayerIds = new Set<string>();

function clampLayerZoom(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_LAYER_ZOOM, Math.max(MIN_LAYER_ZOOM, value));
}

function styleLayerZoomRange(style: LayerStyle): {
  maxzoom: number;
  minzoom: number;
} {
  const minzoom = clampLayerZoom(styleValue(style, "minZoom"), MIN_LAYER_ZOOM);
  const maxzoom = clampLayerZoom(styleValue(style, "maxZoom"), MAX_LAYER_ZOOM);
  return {
    minzoom: Math.min(minzoom, maxzoom),
    maxzoom: Math.max(minzoom, maxzoom),
  };
}

// Intersect a native layer's source-declared zoom range with the user-configured
// style range, taking the tighter bound on each end. This keeps a tile
// service's zoom floor/ceiling intact while still letting the user narrow the
// window from the Style panel. When the two ranges do not overlap the bounds
// are swapped so MapLibre never receives an inverted (minzoom > maxzoom) range.
function intersectZoomRange(
  nativeSpec: { minzoom?: number; maxzoom?: number },
  style: LayerStyle,
): { minzoom: number; maxzoom: number } {
  const styleRange = styleLayerZoomRange(style);
  const minzoom = Math.max(
    nativeSpec.minzoom ?? MIN_LAYER_ZOOM,
    styleRange.minzoom,
  );
  const maxzoom = Math.min(
    nativeSpec.maxzoom ?? MAX_LAYER_ZOOM,
    styleRange.maxzoom,
  );
  return {
    minzoom: Math.min(minzoom, maxzoom),
    maxzoom: Math.max(minzoom, maxzoom),
  };
}

export function syncLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  if (isExternalNativeLayer(layer)) {
    syncExternalNativeLayer(map, layer, beforeId);
    return;
  }

  if (isPlaceholderLayer(layer)) return;

  if (layer.type === "geojson" && layer.geojson) {
    syncGeoJsonLayer(map, layer, beforeId);
    return;
  }

  if (
    layer.type === "raster" ||
    layer.type === "wms" ||
    layer.type === "wmts" ||
    layer.type === "xyz"
  ) {
    syncRasterTileLayer(map, layer, beforeId);
    return;
  }

  if (layer.type === "vector-tiles") {
    syncVectorTileLayer(map, layer, beforeId);
    return;
  }

  if (layer.type === "mbtiles") {
    syncMbtilesLayer(map, layer, beforeId);
  }
}

function isExternalNativeLayer(layer: GeoLibreLayer): boolean {
  return getExternalNativeLayerIds(layer).length > 0;
}

function syncExternalNativeLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  const nativeLayerIds = getExternalNativeLayerIds(layer);
  if (isPMTilesExternalLayer(layer)) {
    ensurePMTilesExternalLayer(map, layer, nativeLayerIds, beforeId);
  }

  // Custom render layers (e.g. 3D Tiles) manage their own visibility, opacity,
  // and zoom behavior through the control that registered them, so the standard
  // visibility/paint/zoom-range sync below must be skipped — only ordering is
  // handled here.
  if (isExternalCustomLayer(layer)) {
    for (const nativeLayerId of nativeLayerIds) {
      moveLayer(map, nativeLayerId, beforeId);
    }
    return;
  }

  if (isWaybackExternalRasterLayer(layer)) {
    syncWaybackExternalRasterLayer(map, layer, nativeLayerIds, beforeId);
    return;
  }

  const nativeFillLayerSpecs = nativeLayerIds
    .map((nativeLayerId) => getStyleLayerSpec(map, nativeLayerId))
    .filter(isFillStyleLayerSpec);

  if (layer.style.extrusionEnabled && nativeFillLayerSpecs.length > 0) {
    for (const nativeLayerId of nativeLayerIds) {
      setNativeLayerVisibility(map, nativeLayerId, "none");
    }

    for (const fillLayerSpec of nativeFillLayerSpecs) {
      const extrusionLayerId = externalExtrusionLayerId(fillLayerSpec.id);
      ensureLayer(
        map,
        extrusionLayerId,
        {
          id: extrusionLayerId,
          type: "fill-extrusion",
          source: fillLayerSpec.source,
          "source-layer": fillLayerSpec["source-layer"],
          filter: fillLayerSpec.filter,
          ...intersectZoomRange(fillLayerSpec, layer.style),
          paint: fillExtrusionPaint(layer.style, layer.opacity),
          layout: { visibility: layer.visible ? "visible" : "none" },
        },
        beforeId,
      );
    }
    return;
  }

  for (const nativeLayerId of nativeLayerIds) {
    removeIfExists(map, externalExtrusionLayerId(nativeLayerId));
  }

  for (const nativeLayerId of nativeLayerIds) {
    const nativeLayer = map.getLayer(nativeLayerId);
    if (!nativeLayer) continue;

    setNativeLayerVisibility(
      map,
      nativeLayerId,
      layer.visible ? "visible" : "none",
    );

    setExternalNativeLayerPaint(map, nativeLayerId, nativeLayer.type, layer);
    // External layers carry their own zoom range from the control or tile
    // service that registered them, so we leave a pristine layer's native range
    // alone. Once the user moves off the defaults GeoLibre owns the range and
    // keeps applying it, so a later reset to the full [0, 24] window still takes
    // effect rather than stranding the layer at the narrowed range.
    const zoomRange = styleLayerZoomRange(layer.style);
    const isDefaultRange =
      zoomRange.minzoom === MIN_LAYER_ZOOM &&
      zoomRange.maxzoom === MAX_LAYER_ZOOM;
    if (!isDefaultRange) {
      managedZoomRangeLayerIds.add(nativeLayerId);
    }
    if (managedZoomRangeLayerIds.has(nativeLayerId)) {
      setLayerZoomRange(map, nativeLayerId, zoomRange);
    }

    moveLayer(map, nativeLayerId, beforeId);
  }
}

function isPMTilesExternalLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "pmtiles" &&
    layer.metadata.sourceKind === "pmtiles-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function isExternalCustomLayer(layer: GeoLibreLayer): boolean {
  return typeof layer.metadata.customLayerType === "string";
}

function ensurePMTilesExternalLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  nativeLayerIds: string[],
  beforeId?: string,
): void {
  const rawUrl = stringSource(layer.source.url) ?? layer.sourcePath;
  const sourceId = getPMTilesSourceId(layer);
  if (!rawUrl || !sourceId) return;

  ensurePMTilesProtocol(rawUrl);

  if (!map.getSource(sourceId)) {
    const tileUrl = normalizePMTilesUrl(rawUrl);
    if (getPMTilesTileType(layer) === "raster") {
      map.addSource(sourceId, {
        type: "raster",
        url: tileUrl,
        tileSize: 256,
      });
    } else {
      map.addSource(sourceId, {
        type: "vector",
        url: tileUrl,
      });
    }
  }

  if (getPMTilesTileType(layer) === "raster") {
    ensureLayer(
      map,
      nativeLayerIds[0] ?? `${sourceId}-raster`,
      {
        id: nativeLayerIds[0] ?? `${sourceId}-raster`,
        type: "raster",
        source: sourceId,
        ...styleLayerZoomRange(layer.style),
        paint: rasterPaint(layer.style, layer.opacity),
        layout: { visibility: layer.visible ? "visible" : "none" },
      },
      beforeId,
    );
    return;
  }

  const sourceLayers = getPMTilesRenderableSourceLayers(
    layer,
    sourceId,
    nativeLayerIds,
  );

  if (sourceLayers.length === 0) {
    // Vector tile sources require a `source-layer` on every layer. With no
    // known source layer there is nothing valid to render, so skip rather
    // than add a layer MapLibre would reject at runtime.
    return;
  }

  for (const sourceLayer of sourceLayers) {
    const fillId = getPMTilesNativeLayerId(
      nativeLayerIds,
      pmtilesVectorLayerId(sourceId, sourceLayer, "fill"),
    );
    const lineId = getPMTilesNativeLayerId(
      nativeLayerIds,
      pmtilesVectorLayerId(sourceId, sourceLayer, "line"),
    );
    const circleId = getPMTilesNativeLayerId(
      nativeLayerIds,
      pmtilesVectorLayerId(sourceId, sourceLayer, "circle"),
    );

    ensureLayer(
      map,
      fillId,
      {
        id: fillId,
        type: "fill",
        source: sourceId,
        "source-layer": sourceLayer,
        ...styleLayerZoomRange(layer.style),
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: fillPaint(layer.style, layer.opacity),
        layout: { visibility: layer.visible ? "visible" : "none" },
      },
      beforeId,
    );

    ensureLayer(
      map,
      lineId,
      {
        id: lineId,
        type: "line",
        source: sourceId,
        "source-layer": sourceLayer,
        ...styleLayerZoomRange(layer.style),
        filter: [
          "any",
          ["==", ["geometry-type"], "LineString"],
          ["==", ["geometry-type"], "Polygon"],
        ],
        paint: linePaint(layer.style, layer.opacity),
        layout: { visibility: layer.visible ? "visible" : "none" },
      },
      beforeId,
    );

    ensureLayer(
      map,
      circleId,
      {
        id: circleId,
        type: "circle",
        source: sourceId,
        "source-layer": sourceLayer,
        ...styleLayerZoomRange(layer.style),
        filter: ["==", ["geometry-type"], "Point"],
        paint: circlePaint(layer.style, layer.opacity),
        layout: { visibility: layer.visible ? "visible" : "none" },
      },
      beforeId,
    );
  }
}

function ensurePMTilesProtocol(url: string): void {
  const protocol = getSharedPMTilesProtocol();

  // Register the same instance we add archives to so MapLibre routes tile
  // requests through it. isMapLibreProtocolRegistered() reflects MapLibre's
  // live state, so this also re-registers after setStyle() clears protocols.
  if (!isMapLibreProtocolRegistered()) {
    addProtocol(PMTILES_PROTOCOL, protocol.tile);
  }

  protocol.add(new PMTiles(stripPMTilesProtocol(url)));
}

function getSharedPMTilesProtocol(): Protocol {
  const globalScope = globalThis as typeof globalThis & {
    [PMTILES_PROTOCOL_GLOBAL_KEY]?: Protocol;
  };
  if (!globalScope[PMTILES_PROTOCOL_GLOBAL_KEY]) {
    globalScope[PMTILES_PROTOCOL_GLOBAL_KEY] = new Protocol();
  }
  return globalScope[PMTILES_PROTOCOL_GLOBAL_KEY];
}

function isMapLibreProtocolRegistered(): boolean {
  return Boolean(
    (
      config as {
        REGISTERED_PROTOCOLS?: Record<string, unknown>;
      }
    ).REGISTERED_PROTOCOLS?.[PMTILES_PROTOCOL],
  );
}

function normalizePMTilesUrl(url: string): string {
  return url.startsWith(`${PMTILES_PROTOCOL}://`)
    ? url
    : `${PMTILES_PROTOCOL}://${url}`;
}

function stripPMTilesProtocol(url: string): string {
  return url.startsWith(`${PMTILES_PROTOCOL}://`)
    ? url.slice(`${PMTILES_PROTOCOL}://`.length)
    : url;
}

function getPMTilesSourceId(layer: GeoLibreLayer): string | undefined {
  return (
    stringMetadata(layer.metadata.sourceId) ??
    stringSource(layer.source.sourceId) ??
    layer.id
  );
}

function getPMTilesTileType(layer: GeoLibreLayer): "raster" | "vector" {
  return layer.metadata.tileType === "raster" || layer.source.type === "raster"
    ? "raster"
    : "vector";
}

function getPMTilesRenderableSourceLayers(
  layer: GeoLibreLayer,
  sourceId: string,
  nativeLayerIds: string[],
): string[] {
  const sourceLayers = getPMTilesSourceLayers(layer);
  const savedSourceLayers = sourceLayers.filter((sourceLayer) =>
    hasPMTilesNativeSourceLayer(nativeLayerIds, sourceId, sourceLayer),
  );

  return savedSourceLayers.length > 0 ? savedSourceLayers : sourceLayers;
}

function hasPMTilesNativeSourceLayer(
  nativeLayerIds: string[],
  sourceId: string,
  sourceLayer: string,
): boolean {
  return ["fill", "line", "circle"].some((kind) =>
    nativeLayerIds.includes(pmtilesVectorLayerId(sourceId, sourceLayer, kind)),
  );
}

function pmtilesVectorLayerId(
  sourceId: string,
  sourceLayer: string,
  kind: string,
): string {
  return `${sourceId}-${encodeVectorTileLayerPart(sourceLayer)}-${kind}`;
}

function getPMTilesSourceLayers(layer: GeoLibreLayer): string[] {
  const sourceLayers = layer.source.sourceLayers ?? layer.metadata.sourceLayers;
  return Array.isArray(sourceLayers)
    ? sourceLayers.filter(
        (sourceLayer): sourceLayer is string =>
          typeof sourceLayer === "string" && sourceLayer.length > 0,
      )
    : [];
}

function getPMTilesNativeLayerId(
  nativeLayerIds: string[],
  fallbackId: string,
): string {
  return (
    nativeLayerIds.find((nativeLayerId) => nativeLayerId === fallbackId) ??
    fallbackId
  );
}

function isWaybackExternalRasterLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "raster" &&
    (layer.metadata.sourceKind === "esri-wayback-current" ||
      layer.metadata.sourceKind === "esri-wayback-persistent") &&
    layer.metadata.externalNativeLayer === true
  );
}

function syncWaybackExternalRasterLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  nativeLayerIds: string[],
  beforeId?: string,
): void {
  const nativeLayerId = nativeLayerIds[0] ?? layer.id;
  const sourceId = getExternalSourceIds(layer)[0] ?? `${nativeLayerId}-source`;
  const tileUrl = getWaybackTileUrl(layer);
  if (!tileUrl) return;

  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, {
      type: "raster",
      tiles: [tileUrl],
      tileSize: 256,
      maxzoom: 23,
    });
  }

  ensureLayer(
    map,
    nativeLayerId,
    {
      id: nativeLayerId,
      type: "raster",
      source: sourceId,
      ...styleLayerZoomRange(layer.style),
      paint: rasterPaint(layer.style, layer.opacity),
      layout: { visibility: layer.visible ? "visible" : "none" },
    },
    beforeId,
  );
}

function getWaybackTileUrl(layer: GeoLibreLayer): string | null {
  const rawUrl =
    stringMetadata(layer.metadata.waybackItemUrl) ??
    stringSource(layer.source.url) ??
    layer.sourcePath;
  if (!rawUrl) return null;
  return rawUrl
    .replace(/\{level\}/g, "{z}")
    .replace(/\{row\}/g, "{y}")
    .replace(/\{col\}/g, "{x}");
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringSource(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function setNativeLayerVisibility(
  map: maplibregl.Map,
  nativeLayerId: string,
  visibility: "visible" | "none",
): void {
  try {
    map.setLayoutProperty(nativeLayerId, "visibility", visibility);
  } catch {
    // Custom layers from external controls may not accept layout updates.
  }
}

function getStyleLayerSpec(
  map: maplibregl.Map,
  layerId: string,
): maplibregl.LayerSpecification | null {
  return map.getStyle().layers?.find((layer) => layer.id === layerId) ?? null;
}

function isFillStyleLayerSpec(
  layer: maplibregl.LayerSpecification | null,
): layer is maplibregl.FillLayerSpecification {
  return layer?.type === "fill";
}

export function externalExtrusionLayerId(nativeLayerId: string): string {
  return `${nativeLayerId}-geolibre-extrusion`;
}

function setExternalNativeLayerPaint(
  map: maplibregl.Map,
  nativeLayerId: string,
  nativeLayerType: string,
  layer: GeoLibreLayer,
): void {
  const paint =
    nativeLayerType === "fill"
      ? fillPaint(layer.style, layer.opacity)
      : nativeLayerType === "line"
        ? linePaint(layer.style, layer.opacity)
        : nativeLayerType === "circle"
          ? circlePaint(layer.style, layer.opacity)
          : nativeLayerType === "raster"
            ? rasterPaint(layer.style, layer.opacity)
            : null;

  if (!paint) return;

  for (const [property, value] of Object.entries(paint)) {
    try {
      map.setPaintProperty(nativeLayerId, property, value);
    } catch {
      // External controls can create heterogeneous style layers. Ignore paint
      // properties that do not apply to a specific native layer type.
    }
  }
}

function syncGeoJsonLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  const src = sourceId(layer.id);
  const profile = detectGeometryProfile(layer.geojson!);

  if (!map.getSource(src)) {
    map.addSource(src, {
      type: "geojson",
      data: layer.geojson!,
    });
  } else {
    (map.getSource(src) as maplibregl.GeoJSONSource).setData(layer.geojson!);
  }

  const visibility = layer.visible ? "visible" : "none";
  const opacity = layer.opacity;

  if (profile.hasPolygon) {
    if (layer.style.extrusionEnabled) {
      removeIfExists(map, fillLayerId(layer.id));
      ensureLayer(
        map,
        fillExtrusionLayerId(layer.id),
        {
          id: fillExtrusionLayerId(layer.id),
          type: "fill-extrusion",
          source: src,
          ...styleLayerZoomRange(layer.style),
          filter: [
            "match",
            ["geometry-type"],
            ["Polygon", "MultiPolygon"],
            true,
            false,
          ],
          paint: fillExtrusionPaint(layer.style, opacity),
          layout: { visibility },
        },
        beforeId,
      );
    } else {
      removeIfExists(map, fillExtrusionLayerId(layer.id));
      ensureLayer(
        map,
        fillLayerId(layer.id),
        {
          id: fillLayerId(layer.id),
          type: "fill",
          source: src,
          ...styleLayerZoomRange(layer.style),
          filter: [
            "match",
            ["geometry-type"],
            ["Polygon", "MultiPolygon"],
            true,
            false,
          ],
          paint: fillPaint(layer.style, opacity),
          layout: { visibility },
        },
        beforeId,
      );
    }
  } else {
    removeIfExists(map, fillLayerId(layer.id));
    removeIfExists(map, fillExtrusionLayerId(layer.id));
  }

  if (
    !layer.style.extrusionEnabled &&
    (profile.hasLine || profile.hasPolygon)
  ) {
    ensureLayer(
      map,
      lineLayerId(layer.id),
      {
        id: lineLayerId(layer.id),
        type: "line",
        source: src,
        ...styleLayerZoomRange(layer.style),
        filter: [
          "match",
          ["geometry-type"],
          ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
          true,
          false,
        ],
        paint: linePaint(layer.style, opacity),
        layout: { visibility },
      },
      beforeId,
    );
  } else {
    removeIfExists(map, lineLayerId(layer.id));
  }

  if (!layer.style.extrusionEnabled && profile.hasPoint) {
    ensureLayer(
      map,
      circleLayerId(layer.id),
      {
        id: circleLayerId(layer.id),
        type: "circle",
        source: src,
        ...styleLayerZoomRange(layer.style),
        filter: [
          "match",
          ["geometry-type"],
          ["Point", "MultiPoint"],
          true,
          false,
        ],
        paint: circlePaint(layer.style, opacity),
        layout: { visibility },
      },
      beforeId,
    );
  } else {
    removeIfExists(map, circleLayerId(layer.id));
  }
}

function syncRasterTileLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  const src = sourceId(layer.id);
  const lid = `layer-${layer.id}-raster`;
  const tiles = getRenderableRasterTiles(layer);
  const tileSize = (layer.source.tileSize as number | undefined) ?? 256;
  if (tiles.length === 0) return;
  if (!map.getSource(src)) {
    map.addSource(src, { type: "raster", tiles, tileSize });
  }
  ensureLayer(
    map,
    lid,
    {
      id: lid,
      type: "raster",
      source: src,
      ...styleLayerZoomRange(layer.style),
      paint: rasterPaint(layer.style, layer.opacity),
      layout: { visibility: layer.visible ? "visible" : "none" },
    },
    beforeId,
  );
}

function getRenderableRasterTiles(layer: GeoLibreLayer): string[] {
  const tiles = (layer.source.tiles as string[]) ?? [];
  if (layer.type !== "wms" || !isViteDevServer()) return tiles;
  return tiles.map(proxyWmsTileUrl);
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

function proxyWmsTileUrl(tileUrl: string): string {
  const encodedUrl = encodeURIComponent(tileUrl).replaceAll(
    "%7Bbbox-epsg-3857%7D",
    "{bbox-epsg-3857}",
  );
  return `${WMS_PROXY_PATH}?url=${encodedUrl}`;
}

function syncVectorTileLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  const src = sourceId(layer.id);
  const url = layer.source.url as string | undefined;
  if (!url) return;
  if (!map.getSource(src)) {
    map.addSource(src, { type: "vector", url });
  }
  const visibility = layer.visible ? "visible" : "none";
  const sourceLayers = getVectorTileSourceLayers(layer);
  const currentLayerIds = new Set(vectorTileStyleLayerIds(layer));

  for (const sourceLayer of sourceLayers) {
    const layerPart = vectorTileScopedSourceLayer(layer, sourceLayer);
    if (layer.style.extrusionEnabled) {
      removeIfExists(map, vectorTileLayerId(layer.id, false, layerPart));
      removeIfExists(map, vectorTileLineLayerId(layer.id, layerPart));
      removeIfExists(map, vectorTileCircleLayerId(layer.id, layerPart));
      ensureLayer(
        map,
        vectorTileLayerId(layer.id, true, layerPart),
        {
          id: vectorTileLayerId(layer.id, true, layerPart),
          type: "fill-extrusion",
          source: src,
          "source-layer": sourceLayer,
          ...styleLayerZoomRange(layer.style),
          filter: [
            "match",
            ["geometry-type"],
            ["Polygon", "MultiPolygon"],
            true,
            false,
          ],
          paint: fillExtrusionPaint(layer.style, layer.opacity),
          layout: { visibility },
        },
        beforeId,
      );
    } else {
      removeIfExists(map, vectorTileLayerId(layer.id, true, layerPart));
      ensureLayer(
        map,
        vectorTileLayerId(layer.id, false, layerPart),
        {
          id: vectorTileLayerId(layer.id, false, layerPart),
          type: "fill",
          source: src,
          "source-layer": sourceLayer,
          ...styleLayerZoomRange(layer.style),
          filter: [
            "match",
            ["geometry-type"],
            ["Polygon", "MultiPolygon"],
            true,
            false,
          ],
          paint: fillPaint(layer.style, layer.opacity),
          layout: { visibility },
        },
        beforeId,
      );
      ensureLayer(
        map,
        vectorTileLineLayerId(layer.id, layerPart),
        {
          id: vectorTileLineLayerId(layer.id, layerPart),
          type: "line",
          source: src,
          "source-layer": sourceLayer,
          ...styleLayerZoomRange(layer.style),
          filter: [
            "match",
            ["geometry-type"],
            ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
            true,
            false,
          ],
          paint: linePaint(layer.style, layer.opacity),
          layout: { visibility },
        },
        beforeId,
      );
      ensureLayer(
        map,
        vectorTileCircleLayerId(layer.id, layerPart),
        {
          id: vectorTileCircleLayerId(layer.id, layerPart),
          type: "circle",
          source: src,
          "source-layer": sourceLayer,
          ...styleLayerZoomRange(layer.style),
          filter: [
            "match",
            ["geometry-type"],
            ["Point", "MultiPoint"],
            true,
            false,
          ],
          paint: circlePaint(layer.style, layer.opacity),
          layout: { visibility },
        },
        beforeId,
      );
    }
  }

  removeStaleVectorTileLayers(map, layer.id, currentLayerIds);
}

function syncMbtilesLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  if (layer.metadata.tileType === "raster" || layer.source.type === "raster") {
    syncRasterTileLayer(map, layer, beforeId);
    return;
  }

  syncMbtilesVectorLayer(map, layer, beforeId);
}

function syncMbtilesVectorLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  const src = sourceId(layer.id);
  const tiles = (layer.source.tiles as string[] | undefined) ?? [];
  if (tiles.length === 0) return;

  if (!map.getSource(src)) {
    map.addSource(src, {
      type: "vector",
      tiles,
      bounds: layer.source.bounds as
        | [number, number, number, number]
        | undefined,
      maxzoom: layer.source.maxzoom as number | undefined,
      minzoom: layer.source.minzoom as number | undefined,
    });
  }

  const visibility = layer.visible ? "visible" : "none";
  const sourceLayers = getMbtilesSourceLayers(layer);
  const currentLayerIds = new Set(mbtilesStyleLayerIds(layer));

  for (const sourceLayer of sourceLayers) {
    const fillId = mbtilesFillLayerId(layer.id, sourceLayer);
    const extrusionId = mbtilesExtrusionLayerId(layer.id, sourceLayer);

    if (layer.style.extrusionEnabled) {
      removeIfExists(map, fillId);
      ensureLayer(
        map,
        extrusionId,
        {
          id: extrusionId,
          type: "fill-extrusion",
          source: src,
          "source-layer": sourceLayer,
          ...styleLayerZoomRange(layer.style),
          filter: [
            "match",
            ["geometry-type"],
            ["Polygon", "MultiPolygon"],
            true,
            false,
          ],
          paint: fillExtrusionPaint(layer.style, layer.opacity),
          layout: { visibility },
        },
        beforeId,
      );
    } else {
      removeIfExists(map, extrusionId);
      ensureLayer(
        map,
        fillId,
        {
          id: fillId,
          type: "fill",
          source: src,
          "source-layer": sourceLayer,
          ...styleLayerZoomRange(layer.style),
          filter: [
            "match",
            ["geometry-type"],
            ["Polygon", "MultiPolygon"],
            true,
            false,
          ],
          paint: fillPaint(layer.style, layer.opacity),
          layout: { visibility },
        },
        beforeId,
      );
    }
    if (layer.style.extrusionEnabled) {
      removeIfExists(map, mbtilesLineLayerId(layer.id, sourceLayer));
      removeIfExists(map, mbtilesCircleLayerId(layer.id, sourceLayer));
    } else {
      ensureLayer(
        map,
        mbtilesLineLayerId(layer.id, sourceLayer),
        {
          id: mbtilesLineLayerId(layer.id, sourceLayer),
          type: "line",
          source: src,
          "source-layer": sourceLayer,
          ...styleLayerZoomRange(layer.style),
          filter: [
            "match",
            ["geometry-type"],
            ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
            true,
            false,
          ],
          paint: linePaint(layer.style, layer.opacity),
          layout: { visibility },
        },
        beforeId,
      );
      ensureLayer(
        map,
        mbtilesCircleLayerId(layer.id, sourceLayer),
        {
          id: mbtilesCircleLayerId(layer.id, sourceLayer),
          type: "circle",
          source: src,
          "source-layer": sourceLayer,
          ...styleLayerZoomRange(layer.style),
          filter: [
            "match",
            ["geometry-type"],
            ["Point", "MultiPoint"],
            true,
            false,
          ],
          paint: circlePaint(layer.style, layer.opacity),
          layout: { visibility },
        },
        beforeId,
      );
    }
  }

  removeStaleMbtilesLayers(map, layer.id, currentLayerIds);
}

function getMbtilesSourceLayers(layer: GeoLibreLayer): string[] {
  const sourceLayers = layer.source.sourceLayers ?? layer.metadata.sourceLayers;
  return Array.isArray(sourceLayers)
    ? sourceLayers.filter(
        (sourceLayer): sourceLayer is string =>
          typeof sourceLayer === "string" && sourceLayer.length > 0,
      )
    : [];
}

function removeStaleMbtilesLayers(
  map: maplibregl.Map,
  layerId: string,
  currentLayerIds: Set<string>,
): void {
  const prefix = `layer-${layerId}-mbtiles-`;
  for (const styleLayer of map.getStyle().layers ?? []) {
    if (
      styleLayer.id.startsWith(prefix) &&
      !currentLayerIds.has(styleLayer.id)
    ) {
      removeIfExists(map, styleLayer.id);
    }
  }
}

function encodeMbtilesLayerPart(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

function encodeVectorTileLayerPart(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

export function mbtilesFillLayerId(
  layerId: string,
  sourceLayer: string,
): string {
  return `layer-${layerId}-mbtiles-${encodeMbtilesLayerPart(sourceLayer)}-fill`;
}

export function mbtilesExtrusionLayerId(
  layerId: string,
  sourceLayer: string,
): string {
  return `layer-${layerId}-mbtiles-${encodeMbtilesLayerPart(sourceLayer)}-extrusion`;
}

export function mbtilesLineLayerId(
  layerId: string,
  sourceLayer: string,
): string {
  return `layer-${layerId}-mbtiles-${encodeMbtilesLayerPart(sourceLayer)}-line`;
}

export function mbtilesCircleLayerId(
  layerId: string,
  sourceLayer: string,
): string {
  return `layer-${layerId}-mbtiles-${encodeMbtilesLayerPart(sourceLayer)}-circle`;
}

export function mbtilesStyleLayerIds(layer: GeoLibreLayer): string[] {
  if (layer.type !== "mbtiles") return [];
  if (layer.metadata.tileType === "raster" || layer.source.type === "raster") {
    return [`layer-${layer.id}-raster`];
  }

  return getMbtilesSourceLayers(layer).flatMap((sourceLayer) => [
    mbtilesCircleLayerId(layer.id, sourceLayer),
    mbtilesLineLayerId(layer.id, sourceLayer),
    layer.style.extrusionEnabled
      ? mbtilesExtrusionLayerId(layer.id, sourceLayer)
      : mbtilesFillLayerId(layer.id, sourceLayer),
  ]);
}

export function mbtilesAllStyleLayerIds(layer: GeoLibreLayer): string[] {
  if (layer.type !== "mbtiles") return [];
  if (layer.metadata.tileType === "raster" || layer.source.type === "raster") {
    return [`layer-${layer.id}-raster`];
  }

  return getMbtilesSourceLayers(layer).flatMap((sourceLayer) => [
    mbtilesCircleLayerId(layer.id, sourceLayer),
    mbtilesLineLayerId(layer.id, sourceLayer),
    mbtilesFillLayerId(layer.id, sourceLayer),
    mbtilesExtrusionLayerId(layer.id, sourceLayer),
  ]);
}

export function vectorTileLayerId(
  layerId: string,
  extrusionEnabled = false,
  sourceLayer?: string,
): string {
  if (sourceLayer) {
    return `layer-${layerId}-vector-${encodeVectorTileLayerPart(sourceLayer)}-${extrusionEnabled ? "extrusion" : "fill"}`;
  }
  return `layer-${layerId}-${extrusionEnabled ? "vector-extrusion" : "vector"}`;
}

export function vectorTileLineLayerId(
  layerId: string,
  sourceLayer?: string,
): string {
  if (sourceLayer) {
    return `layer-${layerId}-vector-${encodeVectorTileLayerPart(sourceLayer)}-line`;
  }
  return `layer-${layerId}-vector-line`;
}

export function vectorTileCircleLayerId(
  layerId: string,
  sourceLayer?: string,
): string {
  if (sourceLayer) {
    return `layer-${layerId}-vector-${encodeVectorTileLayerPart(sourceLayer)}-circle`;
  }
  return `layer-${layerId}-vector-circle`;
}

export function vectorTileStyleLayerIds(layer: GeoLibreLayer): string[] {
  if (layer.type !== "vector-tiles") return [];
  return getVectorTileSourceLayers(layer).flatMap((sourceLayer) => {
    const layerPart = vectorTileScopedSourceLayer(layer, sourceLayer);
    if (layer.style.extrusionEnabled) {
      return [vectorTileLayerId(layer.id, true, layerPart)];
    }
    return [
      vectorTileCircleLayerId(layer.id, layerPart),
      vectorTileLineLayerId(layer.id, layerPart),
      vectorTileLayerId(layer.id, false, layerPart),
    ];
  });
}

function vectorTileAllStyleLayerIds(layer: GeoLibreLayer): string[] {
  if (layer.type !== "vector-tiles") return [];
  return getVectorTileSourceLayers(layer).flatMap((sourceLayer) => {
    const layerPart = vectorTileScopedSourceLayer(layer, sourceLayer);
    return [
      vectorTileCircleLayerId(layer.id, layerPart),
      vectorTileLineLayerId(layer.id, layerPart),
      vectorTileLayerId(layer.id, false, layerPart),
      vectorTileLayerId(layer.id, true, layerPart),
    ];
  });
}

function getVectorTileSourceLayers(layer: GeoLibreLayer): string[] {
  const sourceLayers = layer.source.sourceLayers ?? layer.metadata.sourceLayers;
  if (Array.isArray(sourceLayers)) {
    return sourceLayers.filter(
      (sourceLayer): sourceLayer is string =>
        typeof sourceLayer === "string" && sourceLayer.length > 0,
    );
  }

  const sourceLayer = layer.source.sourceLayer;
  return typeof sourceLayer === "string" && sourceLayer.length > 0
    ? [sourceLayer]
    : [];
}

function vectorTileScopedSourceLayer(
  layer: GeoLibreLayer,
  sourceLayer: string,
): string | undefined {
  return getVectorTileSourceLayers(layer).length > 1 ? sourceLayer : undefined;
}

function removeStaleVectorTileLayers(
  map: maplibregl.Map,
  layerId: string,
  currentLayerIds: Set<string>,
): void {
  const prefix = `layer-${layerId}-vector`;
  for (const styleLayer of map.getStyle().layers ?? []) {
    if (
      styleLayer.id.startsWith(prefix) &&
      !currentLayerIds.has(styleLayer.id)
    ) {
      removeIfExists(map, styleLayer.id);
    }
  }
}

function ensureLayer(
  map: maplibregl.Map,
  id: string,
  spec: maplibregl.AddLayerObject & {
    // Required so every caller supplies an explicit zoom range; omitting it
    // would silently reset an existing layer's range to the full [0, 24]
    // window on the next sync.
    maxzoom: number;
    minzoom: number;
    paint?: Record<string, unknown>;
    layout?: Record<string, unknown>;
  },
  beforeId?: string,
): void {
  if (map.getLayer(id)) {
    if (spec.paint) {
      for (const [key, value] of Object.entries(spec.paint)) {
        map.setPaintProperty(id, key, value);
      }
    }
    if (spec.layout) {
      for (const [key, value] of Object.entries(spec.layout)) {
        map.setLayoutProperty(id, key, value);
      }
    }
    setLayerZoomRange(map, id, {
      minzoom: spec.minzoom,
      maxzoom: spec.maxzoom,
    });
    moveLayer(map, id, beforeId);
    return;
  }
  const validBeforeId =
    beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  map.addLayer(spec, validBeforeId);
}

function setLayerZoomRange(
  map: maplibregl.Map,
  id: string,
  range: { minzoom?: number; maxzoom?: number },
): void {
  const minzoom = range.minzoom ?? MIN_LAYER_ZOOM;
  const maxzoom = range.maxzoom ?? MAX_LAYER_ZOOM;
  const current = map.getLayer(id) as
    | { minzoom?: number; maxzoom?: number }
    | undefined;
  // setLayerZoomRange invalidates MapLibre's style internally, so skip no-op
  // calls. syncLayer runs this for every layer on every pass.
  if (current?.minzoom === minzoom && current?.maxzoom === maxzoom) {
    return;
  }
  try {
    map.setLayerZoomRange(id, minzoom, maxzoom);
  } catch (error) {
    // Custom layers from external controls do not support zoom range updates,
    // so that failure is expected and ignored. Surface anything else (e.g. an
    // error on a GeoLibre-owned layer) so a real invariant violation is not
    // silently swallowed.
    if (map.getLayer(id)?.type !== "custom") {
      console.warn("[GeoLibre] setLayerZoomRange failed for layer", id, error);
    }
  }
}

function removeIfExists(map: maplibregl.Map, id: string): void {
  if (map.getLayer(id)) map.removeLayer(id);
}

function moveLayer(map: maplibregl.Map, id: string, beforeId?: string): void {
  try {
    if (beforeId && beforeId !== id && map.getLayer(beforeId)) {
      map.moveLayer(id, beforeId);
      return;
    }
    map.moveLayer(id);
  } catch {
    // Reordering can race style reloads; the next sync pass will retry.
  }
}

export function removeLayerFromMap(
  map: maplibregl.Map,
  layerId: string,
  layer?: GeoLibreLayer,
): void {
  for (const id of [
    ...getExternalNativeLayerIds(layer),
    ...getExternalNativeLayerIds(layer).map(externalExtrusionLayerId),
    ...(layer ? mbtilesAllStyleLayerIds(layer) : []),
    fillLayerId(layerId),
    fillExtrusionLayerId(layerId),
    lineLayerId(layerId),
    circleLayerId(layerId),
    `layer-${layerId}-raster`,
    ...(layer ? vectorTileAllStyleLayerIds(layer) : []),
    vectorTileCircleLayerId(layerId),
    vectorTileLineLayerId(layerId),
    vectorTileLayerId(layerId),
    vectorTileLayerId(layerId, true),
  ]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const src of [...getExternalSourceIds(layer), sourceId(layerId)]) {
    if (src && map.getSource(src)) map.removeSource(src);
  }
}

function getExternalNativeLayerIds(layer?: GeoLibreLayer): string[] {
  const nativeLayerIds = layer?.metadata.nativeLayerIds;
  return Array.isArray(nativeLayerIds)
    ? nativeLayerIds.filter((id): id is string => typeof id === "string")
    : [];
}

function getExternalSourceIds(layer?: GeoLibreLayer): string[] {
  const sourceIds = layer?.metadata.sourceIds;
  if (Array.isArray(sourceIds)) {
    return sourceIds.filter((id): id is string => typeof id === "string");
  }

  return typeof layer?.metadata.sourceId === "string"
    ? [layer.metadata.sourceId]
    : [];
}
