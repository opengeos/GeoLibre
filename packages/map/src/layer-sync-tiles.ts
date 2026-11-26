// Raster tile, video, image, vector tile and MBTiles layers.

import { type GeoLibreLayer, isTileAddressError, resolveLayerTileAddress } from "@geolibre/core";
import { encodeVectorTileLayerPart } from "./vector-tile-layer-ids";
import type * as maplibregl from "maplibre-gl";
import { sourceId } from "./geojson-loader";
import { circlePaint, fillExtrusionPaint, fillPaint, linePaint, rasterPaint } from "./style-mapper";
import { proxyWmsTiles } from "./wms-proxy";
import { tileTemplatesForMapCrs } from "./active-map-crs";
import {
  withFeatureFilters,
  styleLayerZoomRange,
  boundsSource,
  numberSource,
  stringSource,
  ensureLayer,
  removeIfExists,
} from "./layer-sync-common";

export function syncRasterTileLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  const src = sourceId(layer.id);
  const lid = `layer-${layer.id}-raster`;
  const rawTiles = getRenderableRasterTiles(map, layer);
  const tileSize = numberSource(layer.source.tileSize) ?? 256;
  if (rawTiles.length === 0) return;
  // A saved template that mixes {y} and {-y} must not abort the rest of the
  // layer pass. New layers are rejected before they are stored.
  let addressed: ReturnType<typeof resolveLayerTileAddress>;
  try {
    addressed = resolveLayerTileAddress(layer, rawTiles);
  } catch (error) {
    if (!isTileAddressError(error)) throw error;
    console.warn(
      `[GeoLibre] skipping layer "${layer.name || layer.id}": a tile template can use {y} or {-y}, not both.`,
    );
    return;
  }
  if (!map.getSource(src)) {
    const bounds = boundsSource(layer.source.bounds);
    const minzoom = numberSource(layer.source.minzoom);
    const maxzoom = numberSource(layer.source.maxzoom);
    const attribution = stringSource(layer.source.attribution);
    map.addSource(src, {
      type: "raster",
      tiles: addressed.tiles,
      tileSize,
      ...(minzoom !== undefined ? { minzoom } : {}),
      ...(maxzoom !== undefined ? { maxzoom } : {}),
      ...(bounds ? { bounds } : {}),
      ...(addressed.scheme === "tms" ? { scheme: "tms" as const } : {}),
      ...(attribution ? { attribution } : {}),
    });
  } else if (
    typeof layer.metadata.stacRendering === "string" ||
    typeof layer.metadata.arcgisRenderingRule === "string"
  ) {
    // A STAC rendering's recipe, or an ArcGIS ImageServer's raster function, is
    // in its tile URL, and the Style panel, the Earthdata GIS browser (and an
    // undo) change it. A raster source is otherwise added once and left, so its
    // tiles are handed over here.
    const source = map.getSource(src) as
      | { tiles?: string[]; setTiles?: (tiles: string[]) => void }
      | undefined;
    const current = source?.tiles;
    const same =
      current !== undefined &&
      current.length === addressed.tiles.length &&
      current.every((tile, index) => tile === addressed.tiles[index]);
    if (source?.setTiles && !same) source.setTiles(addressed.tiles);
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

type CornerCoordinates = [[number, number], [number, number], [number, number], [number, number]];

/**
 * Validate persisted overlay corners (video/image): four [lng, lat] pairs.
 *
 * A corner may lie up to one world past ±180, so a quad can cross the
 * antimeridian (a NetCDF grid on 150E..250E is stored as 210W..110W). Its
 * centre must stay within -180..180, though: MapLibre files an image source
 * under the tile holding that centre and throws for a tile outside the world.
 */
export function isCornerCoordinates(value: unknown): value is CornerCoordinates {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every(
      (corner) =>
        Array.isArray(corner) &&
        corner.length === 2 &&
        Number.isFinite(corner[0]) &&
        Number.isFinite(corner[1]) &&
        corner[0] >= -360 &&
        corner[0] <= 360 &&
        corner[1] >= -90 &&
        corner[1] <= 90,
    )
  ) {
    return false;
  }
  const lngs = (value as CornerCoordinates).map((corner) => corner[0]);
  const centre = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  return centre >= -180 && centre <= 180 && Math.max(...lngs) - Math.min(...lngs) <= 360;
}

/**
 * A georeferenced video overlay (MapLibre `type: "video"` source rendered as a
 * raster layer). The source carries the media `urls` (format fallbacks) and the
 * four corner `coordinates` in [lng, lat] order: top-left, top-right,
 * bottom-right, bottom-left. The video host must send CORS headers so MapLibre
 * can read its frames into the map texture.
 */
export function syncVideoLayer(map: maplibregl.Map, layer: GeoLibreLayer, beforeId?: string): void {
  const src = sourceId(layer.id);
  const lid = `layer-${layer.id}-video`;
  // Validate the persisted source payload — a malformed project must not make
  // map.addSource throw and abort the rest of the layer-sync pass.
  const urls = Array.isArray(layer.source.urls)
    ? layer.source.urls.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  const coordinates = isCornerCoordinates(layer.source.coordinates)
    ? layer.source.coordinates
    : undefined;
  if (urls.length === 0 || !coordinates) return;
  if (!map.getSource(src)) {
    map.addSource(src, { type: "video", urls, coordinates });
    // MapLibre's VideoSource exposes setCoordinates() but no URL setter, so a
    // future edit-layer flow would need to remove + re-add to change urls.
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

/**
 * A georeferenced image overlay (MapLibre `type: "image"` source rendered as a
 * raster layer), produced by the Raster Georeferencer. The source carries a
 * single image `url` (an http(s) or data URL) and the four corner `coordinates`
 * in [lng, lat] order: top-left, top-right, bottom-right, bottom-left.
 */
export function syncImageLayer(map: maplibregl.Map, layer: GeoLibreLayer, beforeId?: string): void {
  const src = sourceId(layer.id);
  const lid = `layer-${layer.id}-image`;
  const url =
    typeof layer.source.url === "string" && layer.source.url.length > 0
      ? layer.source.url
      : undefined;
  const coordinates = isCornerCoordinates(layer.source.coordinates)
    ? layer.source.coordinates
    : undefined;
  if (!url || !coordinates) return;
  const existing = map.getSource(src);
  if (!existing) {
    map.addSource(src, { type: "image", url, coordinates });
  } else if (existing.type === "image") {
    // Unlike VideoSource, MapLibre's ImageSource can replace both the url and
    // the corners in place, so a re-render (e.g. a future edit-GCPs flow) keeps
    // the overlay in sync instead of leaving the old image pinned.
    (existing as maplibregl.ImageSource).updateImage({ url, coordinates });
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

// Adapted to the map's CRS before the dev proxy wraps them: the adaptation
// reads the template's query string, which the proxy URL-encodes.
function getRenderableRasterTiles(map: maplibregl.Map, layer: GeoLibreLayer): string[] {
  return proxyWmsTiles(
    layer.type,
    tileTemplatesForMapCrs(map, (layer.source.tiles as string[]) ?? []),
  );
}

/** The parts of MapLibre's `VectorTileSource` this module reads and updates. */
interface VectorSourceLike {
  url?: string;
  tiles?: string[];
  setUrl?: (url: string) => unknown;
  setTiles?: (tiles: string[]) => unknown;
}

/**
 * Point an existing vector source at a new endpoint, if it moved.
 *
 * `setUrl`/`setTiles` reload the source, which drops its cached tiles and
 * re-requests them, so this is deliberately a no-op when nothing changed — a
 * needless reload would blank the layer for a frame on every sync.
 */
function updateVectorSourceEndpoint(
  source: VectorSourceLike,
  url: string | undefined,
  tiles: string[] | undefined,
): void {
  if (url) {
    if (source.url !== url && typeof source.setUrl === "function") source.setUrl(url);
    return;
  }
  if (!tiles || tiles.length === 0 || typeof source.setTiles !== "function") return;
  const current = Array.isArray(source.tiles) ? source.tiles : [];
  const unchanged = current.length === tiles.length && current.every((t, i) => t === tiles[i]);
  if (unchanged) return;
  source.setTiles(tiles);
}

export function syncVectorTileLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  beforeId?: string,
): void {
  const src = sourceId(layer.id);
  const url = layer.source.url as string | undefined;
  // OGC API tilesets (and any raw tile template) are added from `tiles` when no
  // TileJSON URL is available; MapLibre then needs the zoom range up front so it
  // does not request tiles outside the tileset's advertised levels.
  const tiles = Array.isArray(layer.source.tiles)
    ? (layer.source.tiles as unknown[]).filter(
        (tile): tile is string => typeof tile === "string" && tile.length > 0,
      )
    : undefined;
  if (!url && !(tiles && tiles.length > 0)) return;
  const existingSource = map.getSource(src) as VectorSourceLike | undefined;
  if (!existingSource) {
    if (url) {
      map.addSource(src, { type: "vector", url });
    } else {
      const bounds = layer.source.bounds;
      map.addSource(src, {
        type: "vector",
        tiles: tiles as string[],
        ...(typeof layer.source.minzoom === "number" ? { minzoom: layer.source.minzoom } : {}),
        ...(typeof layer.source.maxzoom === "number" ? { maxzoom: layer.source.maxzoom } : {}),
        ...(Array.isArray(bounds) && bounds.length === 4
          ? { bounds: bounds as [number, number, number, number] }
          : {}),
      });
    }
  } else {
    // The source already exists, so a changed endpoint has to be pushed into it:
    // MapLibre keeps serving whatever it has already cached otherwise, and the
    // store update alone would never reach the map. This is what makes a
    // re-signed tile URL (GeoLens mints short-lived tokens) take effect, and
    // what re-renders already-loaded zoom levels after the underlying data
    // changes — without it only zooms the user had not visited yet look updated.
    updateVectorSourceEndpoint(existingSource, url, tiles);
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
          filter: withFeatureFilters(layer, [
            "match",
            ["geometry-type"],
            ["Polygon", "MultiPolygon"],
            true,
            false,
          ]),
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
          filter: withFeatureFilters(layer, [
            "match",
            ["geometry-type"],
            ["Polygon", "MultiPolygon"],
            true,
            false,
          ]),
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
          filter: withFeatureFilters(layer, [
            "match",
            ["geometry-type"],
            ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
            true,
            false,
          ]),
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
          filter: withFeatureFilters(layer, [
            "match",
            ["geometry-type"],
            ["Point", "MultiPoint"],
            true,
            false,
          ]),
          paint: circlePaint(layer.style, layer.opacity),
          layout: { visibility },
        },
        beforeId,
      );
    }
  }

  removeStaleVectorTileLayers(map, layer.id, currentLayerIds);
}

export function syncMbtilesLayer(
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
      bounds: layer.source.bounds as [number, number, number, number] | undefined,
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
          filter: withFeatureFilters(layer, [
            "match",
            ["geometry-type"],
            ["Polygon", "MultiPolygon"],
            true,
            false,
          ]),
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
          filter: withFeatureFilters(layer, [
            "match",
            ["geometry-type"],
            ["Polygon", "MultiPolygon"],
            true,
            false,
          ]),
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
          filter: withFeatureFilters(layer, [
            "match",
            ["geometry-type"],
            ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
            true,
            false,
          ]),
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
          filter: withFeatureFilters(layer, [
            "match",
            ["geometry-type"],
            ["Point", "MultiPoint"],
            true,
            false,
          ]),
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
    if (styleLayer.id.startsWith(prefix) && !currentLayerIds.has(styleLayer.id)) {
      removeIfExists(map, styleLayer.id);
    }
  }
}

function encodeMbtilesLayerPart(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

export function mbtilesFillLayerId(layerId: string, sourceLayer: string): string {
  return `layer-${layerId}-mbtiles-${encodeMbtilesLayerPart(sourceLayer)}-fill`;
}

export function mbtilesExtrusionLayerId(layerId: string, sourceLayer: string): string {
  return `layer-${layerId}-mbtiles-${encodeMbtilesLayerPart(sourceLayer)}-extrusion`;
}

export function mbtilesLineLayerId(layerId: string, sourceLayer: string): string {
  return `layer-${layerId}-mbtiles-${encodeMbtilesLayerPart(sourceLayer)}-line`;
}

export function mbtilesCircleLayerId(layerId: string, sourceLayer: string): string {
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

export function vectorTileLineLayerId(layerId: string, sourceLayer?: string): string {
  if (sourceLayer) {
    return `layer-${layerId}-vector-${encodeVectorTileLayerPart(sourceLayer)}-line`;
  }
  return `layer-${layerId}-vector-line`;
}

export function vectorTileCircleLayerId(layerId: string, sourceLayer?: string): string {
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

export function vectorTileAllStyleLayerIds(layer: GeoLibreLayer): string[] {
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
  return typeof sourceLayer === "string" && sourceLayer.length > 0 ? [sourceLayer] : [];
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
    if (styleLayer.id.startsWith(prefix) && !currentLayerIds.has(styleLayer.id)) {
      removeIfExists(map, styleLayer.id);
    }
  }
}
