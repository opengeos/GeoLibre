// External PMTiles, Wayback, basemap-control and web-service raster tile layers.

import { styleValue, type GeoLibreLayer } from "@geolibre/core";
import {
  normalizePMTilesUrl,
  pmtilesControlLayerId,
  pmtilesIdNamesSourceLayer,
  pmtilesLayerKinds,
  pmtilesLayerDrawsLineDecorations,
  pmtilesLineDecorationLayerId,
  pmtilesVectorLayerId,
} from "./pmtiles-layer";
import type * as maplibregl from "maplibre-gl";
import { ensurePMTilesProtocol } from "./pmtiles-archive";
import { sourceId } from "./geojson-loader";
import { ensureGeneratedImageHandler } from "./generated-images";
import { prepareLineDecoration } from "./line-decorations";
import { circlePaint, fillPaint, linePaint, rasterPaint } from "./style-mapper";
import { isViteDevServer, proxyWmsTileUrl } from "./wms-proxy";
import { getActiveMapCrs, tileTemplatesForMapCrs } from "./active-map-crs";
import {
  withFeatureFilters,
  styleLayerZoomRange,
  boundsSource,
  numberSource,
  stringMetadata,
  stringSource,
  ensureLayer,
  removeIfExists,
  getExternalSourceIds,
} from "./layer-sync-common";

export function isPMTilesExternalLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "pmtiles" &&
    layer.metadata.sourceKind === "pmtiles-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

export function ensurePMTilesExternalLayer(
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
      const encoding = layer.source.encoding;
      map.addSource(sourceId, {
        type: "vector",
        url: tileUrl,
        // An MLT archive decodes through a different worker path than plain MVT.
        ...(encoding === "mlt" ? { encoding } : {}),
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

  const sourceLayers = getPMTilesRenderableSourceLayers(layer, sourceId, nativeLayerIds);

  if (sourceLayers.length === 0) {
    // Vector tile sources require a `source-layer` on every layer. With no
    // known source layer there is nothing valid to render, so skip rather
    // than add a layer MapLibre would reject at runtime.
    return;
  }

  for (const sourceLayer of sourceLayers) {
    const fillId = getPMTilesNativeLayerId(nativeLayerIds, sourceId, sourceLayer, "fill");
    const lineId = getPMTilesNativeLayerId(nativeLayerIds, sourceId, sourceLayer, "line");
    const circleId = getPMTilesNativeLayerId(nativeLayerIds, sourceId, sourceLayer, "circle");

    ensureLayer(
      map,
      fillId,
      {
        id: fillId,
        type: "fill",
        source: sourceId,
        "source-layer": sourceLayer,
        ...styleLayerZoomRange(layer.style),
        filter: withFeatureFilters(layer, ["==", ["geometry-type"], "Polygon"]),
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
        filter: withFeatureFilters(layer, [
          "any",
          ["==", ["geometry-type"], "LineString"],
          ["==", ["geometry-type"], "Polygon"],
        ]),
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
        filter: withFeatureFilters(layer, ["==", ["geometry-type"], "Point"]),
        paint: circlePaint(layer.style, layer.opacity),
        layout: { visibility: layer.visible ? "visible" : "none" },
      },
      beforeId,
    );
  }
}

// Bound cleanup to the decorations this map instance has actually created.
export const pmtilesDecorationOwners = new WeakMap<maplibregl.Map, Map<string, Set<string>>>();

/**
 * Line decorations (flow-direction arrows and other repeated symbols) for a
 * vector PMTiles archive: one GeoLibre-owned symbol layer per rendered source
 * layer, reading the archive's own source, mirroring
 * {@link applyLineDecorationLayer} on the GeoJSON path. With line placement
 * MapLibre rotates each icon to follow its line, so an arrow points along the
 * direction the feature was digitized in. Decoration layers for source layers
 * no longer rendered (or every one, when decorations are off, the layer is
 * extruded, or the archive is raster) are removed.
 *
 * @param map - The MapLibre map to reconcile against.
 * @param layer - The store layer.
 * @param nativeLayerIds - Native layer ids registered for the archive.
 * @param beforeId - The style layer the decorations are placed below.
 */
export function syncPMTilesLineDecorations(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  nativeLayerIds: string[],
  beforeId?: string,
): void {
  if (!isPMTilesExternalLayer(layer)) return;
  const sourceId = getPMTilesSourceId(layer);
  const imageId =
    sourceId &&
    map.getSource(sourceId) &&
    pmtilesLayerDrawsLineDecorations(layer) &&
    !layer.style.extrusionEnabled
      ? prepareLineDecoration(layer.style)
      : null;
  const rendered = new Set(
    imageId && sourceId ? getPMTilesRenderableSourceLayers(layer, sourceId, nativeLayerIds) : [],
  );
  removeStalePMTilesLineDecorations(
    map,
    layer.id,
    new Set([...rendered].map((name) => pmtilesLineDecorationLayerId(layer.id, name))),
  );
  if (rendered.size > 0) ensureGeneratedImageHandler(map);
  for (const sourceLayer of new Set([...getPMTilesSourceLayers(layer), ...rendered])) {
    const decorationId = pmtilesLineDecorationLayerId(layer.id, sourceLayer);
    if (!imageId || !sourceId || !rendered.has(sourceLayer)) {
      removeIfExists(map, decorationId);
      continue;
    }
    ensureLayer(
      map,
      decorationId,
      {
        id: decorationId,
        type: "symbol",
        source: sourceId,
        "source-layer": sourceLayer,
        ...styleLayerZoomRange(layer.style),
        metadata: { "geolibre:internal": true, "geolibre:line-decoration-owner": layer.id },
        filter: withFeatureFilters(layer, [
          "match",
          ["geometry-type"],
          ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
          true,
          false,
        ]),
        layout: {
          "icon-image": imageId,
          "icon-size": 1,
          "symbol-placement": "line",
          "symbol-spacing": Math.max(1, styleValue(layer.style, "lineDecorationSpacing")),
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-rotation-alignment": "map",
          visibility: layer.visible ? "visible" : "none",
        },
        paint: { "icon-opacity": layer.opacity },
      },
      beforeId,
    );
    let owners = pmtilesDecorationOwners.get(map);
    if (!owners) pmtilesDecorationOwners.set(map, (owners = new Map()));
    let ids = owners.get(layer.id);
    if (!ids) owners.set(layer.id, (ids = new Set()));
    ids.add(decorationId);
  }
}

/** Remove owned decorations absent from the desired set, including source layers no longer in metadata. */
export function removeStalePMTilesLineDecorations(
  map: maplibregl.Map,
  layerId: string,
  keep: ReadonlySet<string> = new Set(),
): void {
  const owners = pmtilesDecorationOwners.get(map);
  const ids = owners?.get(layerId);
  if (!ids) return;
  for (const id of ids) {
    if (keep.has(id)) continue;
    const metadata = map.getLayer(id)?.metadata as Record<string, unknown> | undefined;
    if (
      metadata?.["geolibre:internal"] === true &&
      metadata["geolibre:line-decoration-owner"] === layerId
    )
      removeIfExists(map, id);
    ids.delete(id);
  }
  if (ids.size === 0) owners?.delete(layerId);
  if (owners?.size === 0) pmtilesDecorationOwners.delete(map);
}

export function getPMTilesSourceId(layer: GeoLibreLayer): string | undefined {
  return stringMetadata(layer.metadata.sourceId) ?? stringSource(layer.source.sourceId) ?? layer.id;
}

export function getPMTilesTileType(layer: GeoLibreLayer): "raster" | "vector" {
  return layer.metadata.tileType === "raster" || layer.source.type === "raster"
    ? "raster"
    : "vector";
}

export function getPMTilesRenderableSourceLayers(
  layer: GeoLibreLayer,
  sourceId: string,
  nativeLayerIds: string[],
): string[] {
  const sourceLayers = getPMTilesSourceLayers(layer);
  const savedSourceLayers = sourceLayers.filter((sourceLayer) =>
    pmtilesIdNamesSourceLayer(nativeLayerIds, sourceId, sourceLayer),
  );

  return savedSourceLayers.length > 0 ? savedSourceLayers : sourceLayers;
}

export function getPMTilesSourceLayers(layer: GeoLibreLayer): string[] {
  const sourceLayers = layer.source.sourceLayers ?? layer.metadata.sourceLayers;
  return Array.isArray(sourceLayers)
    ? sourceLayers.filter(
        (sourceLayer): sourceLayer is string =>
          typeof sourceLayer === "string" && sourceLayer.length > 0,
      )
    : [];
}

/**
 * The id this source layer is already drawn under, or the one to draw it under. Both schemes are
 * consulted — see `pmtilesControlLayerId` — or a control-added layer gets a second set over it.
 */
export function getPMTilesNativeLayerId(
  nativeLayerIds: string[],
  sourceId: string,
  sourceLayer: string,
  kind: (typeof pmtilesLayerKinds)[number],
): string {
  const encoded = pmtilesVectorLayerId(sourceId, sourceLayer, kind);
  if (nativeLayerIds.includes(encoded)) return encoded;
  const raw = pmtilesControlLayerId(sourceId, sourceLayer, kind);
  return nativeLayerIds.includes(raw) ? raw : encoded;
}

export function isWaybackExternalRasterLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "raster" &&
    (layer.metadata.sourceKind === "esri-wayback-current" ||
      layer.metadata.sourceKind === "esri-wayback-persistent") &&
    layer.metadata.externalNativeLayer === true
  );
}

export function syncWaybackExternalRasterLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  nativeLayerIds: string[],
  beforeId?: string,
): void {
  const nativeLayerId = nativeLayerIds[0] ?? layer.id;
  const sourceId = getExternalSourceIds(layer)[0] ?? `${nativeLayerId}-source`;
  const tileUrl = getWaybackTileUrl(layer);
  // Wayback serves Web Mercator XYZ tiles only.
  if (!tileUrl || getActiveMapCrs(map)) return;

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

export function isBasemapControlRasterLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "raster" &&
    layer.metadata.sourceKind === "maplibre-basemap-control" &&
    layer.metadata.externalNativeLayer === true
  );
}

// A raster layer registered by a third-party plugin through
// registerExternalNativeLayer that supplies its own XYZ tile template(s) in
// `source.tiles`. Unlike the basemap/web-service/PMTiles raster paths above it
// carries no GeoLibre-internal sourceKind, so it is matched structurally: any
// external raster layer with concrete tiles and no dedicated handler.
export function isExternalRasterTileLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "raster" &&
    layer.metadata.externalNativeLayer === true &&
    getSourceTiles(layer).length > 0
  );
}

// Build the MapLibre source and raster layer for a generic external raster tile
// registration. Mirrors syncBasemapControlRasterLayer/syncWebServiceTileRasterLayer
// but reads everything from the registration's own `source`, so any plugin that
// hands GeoLibre an XYZ raster source renders without needing a bespoke handler.
export function syncExternalRasterTileLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  nativeLayerIds: string[],
  beforeId?: string,
): void {
  const nativeLayerId = nativeLayerIds[0] ?? layer.id;
  const sourceId = getExternalSourceIds(layer)[0] ?? `${nativeLayerId}-source`;
  const tiles = tileTemplatesForMapCrs(map, getSourceTiles(layer));
  if (tiles.length === 0) return;

  // The source is built once and never rebuilt while it exists, matching the
  // other raster handlers above. A plugin that re-registers the same sourceId
  // with a different `tiles` array will keep serving the original tiles; to
  // switch tile URLs it must register under a new sourceId.
  if (!map.getSource(sourceId)) {
    const bounds = boundsSource(layer.source.bounds);
    map.addSource(sourceId, {
      type: "raster",
      tiles,
      tileSize: numberSource(layer.source.tileSize) ?? 256,
      ...(numberSource(layer.source.minzoom) !== undefined
        ? { minzoom: numberSource(layer.source.minzoom) }
        : {}),
      ...(numberSource(layer.source.maxzoom) !== undefined
        ? { maxzoom: numberSource(layer.source.maxzoom) }
        : {}),
      ...(bounds ? { bounds } : {}),
      ...(layer.source.scheme === "tms" ? { scheme: "tms" as const } : {}),
      ...(stringSource(layer.source.attribution)
        ? { attribution: stringSource(layer.source.attribution) }
        : {}),
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

// Raster basemaps selected in the basemap control are normally rendered by the
// control itself. Rebuilding them here too keeps them on the map after a style
// reload (e.g. reopening a project), where the control does not replay them.
// The native source/layer ids match the control's deterministic ids, so this
// is idempotent during a live session.
export function syncBasemapControlRasterLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  nativeLayerIds: string[],
  beforeId?: string,
): void {
  const nativeLayerId = nativeLayerIds[0] ?? layer.id;
  const sourceId = getExternalSourceIds(layer)[0] ?? `${nativeLayerId}-source`;
  const tiles = tileTemplatesForMapCrs(map, getBasemapControlTiles(layer));
  if (tiles.length === 0) return;

  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, {
      type: "raster",
      tiles,
      tileSize: numberSource(layer.source.tileSize) ?? 256,
      ...(numberSource(layer.source.minzoom) !== undefined
        ? { minzoom: numberSource(layer.source.minzoom) }
        : {}),
      ...(numberSource(layer.source.maxzoom) !== undefined
        ? { maxzoom: numberSource(layer.source.maxzoom) }
        : {}),
      ...(layer.source.scheme === "tms" ? { scheme: "tms" as const } : {}),
      ...(stringSource(layer.source.attribution)
        ? { attribution: stringSource(layer.source.attribution) }
        : {}),
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

// Store-layer metadata.sourceKind values written by the Web Services
// plugins. Each entry pairs with a plugin id in WEB_SERVICE_PLUGIN_IDS in
// @geolibre/plugins' web-service-sync; keep the two lists in step when
// adding a web service plugin.
export const WEB_SERVICE_SOURCE_KINDS = new Set([
  "fema-wms",
  "nasa-earthdata",
  "enviroatlas",
  "national-map",
]);

export function isWebServiceTileRasterLayer(layer: GeoLibreLayer): boolean {
  return (
    (layer.type === "raster" || layer.type === "wms") &&
    typeof layer.metadata.sourceKind === "string" &&
    WEB_SERVICE_SOURCE_KINDS.has(layer.metadata.sourceKind) &&
    layer.metadata.externalNativeLayer === true
  );
}

// Web service layers (FEMA NFHL, NASA Earthdata, US EPA EnviroAtlas, USGS
// National Map) are normally rendered by their panel controls. Rebuilding
// them here keeps them on the map after a style reload (e.g. reopening a
// project), where the controls do not replay them. The native source/layer
// ids match the controls' deterministic ids, so this is idempotent during a
// live session.
export function syncWebServiceTileRasterLayer(
  map: maplibregl.Map,
  layer: GeoLibreLayer,
  nativeLayerIds: string[],
  beforeId?: string,
): void {
  const nativeLayerId = nativeLayerIds[0] ?? layer.id;
  const sourceId = getExternalSourceIds(layer)[0] ?? `${nativeLayerId}-source`;
  const tiles = getWebServiceTiles(map, layer);
  if (tiles.length === 0) return;

  if (!map.getSource(sourceId)) {
    const bounds = boundsSource(layer.source.bounds);
    map.addSource(sourceId, {
      type: "raster",
      tiles,
      tileSize: numberSource(layer.source.tileSize) ?? 256,
      ...(numberSource(layer.source.minzoom) !== undefined
        ? { minzoom: numberSource(layer.source.minzoom) }
        : {}),
      ...(numberSource(layer.source.maxzoom) !== undefined
        ? { maxzoom: numberSource(layer.source.maxzoom) }
        : {}),
      ...(bounds ? { bounds } : {}),
      ...(stringSource(layer.source.attribution)
        ? { attribution: stringSource(layer.source.attribution) }
        : {}),
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

// WMS-style web service tiles carry a {bbox-epsg-3857} placeholder and hit
// federal endpoints without permissive CORS headers, so the dev server
// routes them through the WMS proxy. The external-native path bypasses
// getRenderableRasterTiles, hence the dedicated proxying here.
export function getWebServiceTiles(map: maplibregl.Map, layer: GeoLibreLayer): string[] {
  const tiles = tileTemplatesForMapCrs(map, getBasemapControlTiles(layer));
  if (layer.type !== "wms" || !isViteDevServer()) return tiles;
  return tiles.map((tile) =>
    // Skip already proxied templates so repeated sync passes cannot nest
    // proxy URLs.
    /\{bbox(-epsg-3857)?\}/.test(tile) && /^https?:\/\//i.test(tile) ? proxyWmsTileUrl(tile) : tile,
  );
}

// Concrete XYZ tile templates from the registration's own `source.tiles`. This
// is the documented external-raster contract and the only source the generic
// external-raster path reads — it deliberately does not look at
// metadata.tileUrl (see getBasemapControlTiles for that basemap-internal key).
export function getSourceTiles(layer: GeoLibreLayer): string[] {
  const tiles = layer.source.tiles;
  if (!Array.isArray(tiles)) return [];
  return tiles.filter((tile): tile is string => typeof tile === "string" && tile.length > 0);
}

export function getBasemapControlTiles(layer: GeoLibreLayer): string[] {
  const tiles = getSourceTiles(layer);
  if (tiles.length > 0) return tiles;
  // The basemap control stores its single tile template under this internal
  // metadata key rather than source.tiles; that fallback is specific to the
  // basemap/web-service paths and intentionally not part of getSourceTiles.
  const tileUrl = stringMetadata(layer.metadata.tileUrl);
  return tileUrl ? [tileUrl] : [];
}

export function getWaybackTileUrl(layer: GeoLibreLayer): string | null {
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
