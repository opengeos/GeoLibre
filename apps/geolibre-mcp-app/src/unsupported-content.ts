import {
  applyGroupEffects,
  geojsonHasZCoordinates,
  type GeoLibreLayer,
  type GeoLibreProject,
} from "@geolibre/core";
import {
  classifyLayer,
  layerKindSupport,
  MAPLIBRE_SUPPORTED_LAYER_KINDS,
  isMapboxStyleUrl,
  resolveMapStyle,
} from "@geolibre/map/headless";

const LAYER_KIND_NAMES: Record<string, string> = {
  arcgis: "ArcGIS service",
  zarr: "Zarr",
  lidar: "LiDAR",
  "gaussian-splat": "Gaussian splat",
  "3d-tiles": "3D Tiles",
  cog: "Cloud Optimized GeoTIFF",
  "vector-file": "file-backed vector data",
  "duckdb-query": "DuckDB query",
  "deckgl-viz": "deck.gl visualization",
  video: "video overlay",
  image: "image overlay",
  "tile-archive": "tile archive",
};

function layerKindName(layer: GeoLibreLayer): string {
  const kind = classifyLayer(layer);
  return (
    (kind && LAYER_KIND_NAMES[kind]) || (kind ? `${kind} layer` : `unknown type “${layer.type}”`)
  );
}

function missingData(layer: GeoLibreLayer): string | undefined {
  const source = layer.source as Record<string, unknown> | undefined;
  switch (layer.type) {
    case "geojson":
      return layer.geojson ? undefined : "missing inline GeoJSON data";
    case "raster":
    case "wms":
    case "wmts":
    case "xyz":
    case "vector-tiles":
      return (Array.isArray(source?.tiles) &&
        source.tiles.some((url) => typeof url === "string" && url.length > 0)) ||
        (typeof source?.url === "string" && source.url.length > 0)
        ? undefined
        : "missing a tile source URL";
    case "image":
      return typeof source?.url === "string" && Array.isArray(source.coordinates)
        ? undefined
        : "missing image URL or coordinates";
    default:
      return undefined;
  }
}

function isDesktopOnly(layer: GeoLibreLayer): boolean {
  if (layer.type === "mbtiles" || layer.type === "pmtiles") return true;
  if (layer.type === "geojson" && layer.geojson) return false;
  const source = layer.source as Record<string, unknown> | undefined;
  const urls = [
    layer.sourcePath,
    source?.url,
    ...(Array.isArray(source?.tiles) ? source.tiles : []),
  ];
  return urls.some(
    (value) =>
      typeof value === "string" && /^(?:file:|mbtiles:|tauri:|\/|[A-Za-z]:[\\/])/i.test(value),
  );
}

function isDeckOnlyGeoJson(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "geojson" &&
    layer.style.elevation3dEnabled === true &&
    geojsonHasZCoordinates(layer.geojson)
  );
}

function hasImagePopupFields(layer: GeoLibreLayer): boolean {
  return layer.popup?.fields?.some((field) => field.kind === "image") ?? false;
}

/** Native MapLibre layers this preview can instantiate with consent-gated requests. */
export function previewableLayers(project: GeoLibreProject): GeoLibreLayer[] {
  return project.layers.filter((layer) => {
    if (
      !layer.visible ||
      layer.metadata?.externalNativeLayer === true ||
      layer.metadata?.sourceKind === "maplibre-gl-vector"
    )
      return false;
    const kind = classifyLayer(layer);
    if (layerKindSupport(MAPLIBRE_SUPPORTED_LAYER_KINDS, kind) !== "native") return false;
    if (
      layer.type === "video" ||
      layer.type === "mbtiles" ||
      layer.type === "pmtiles" ||
      missingData(layer) ||
      isDesktopOnly(layer) ||
      isDeckOnlyGeoJson(layer)
    )
      return false;
    return true;
  });
}

/** Origins known before loading the map; never inspect feature properties or fetch styles. */
export function previewOrigins(project: GeoLibreProject): string[] {
  const origins = new Set<string>();
  function addUrl(value: unknown): void {
    if (typeof value !== "string") return;
    try {
      const url = new URL(value);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password
      ) {
        origins.add(url.origin);
      }
    } catch {
      // Non-network sources and malformed URLs are handled by the renderer.
    }
  }
  function addSource(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const source = value as Record<string, unknown>;
    if (source.type === "video") return;
    addUrl(source.url);
    if (source.type === "geojson") addUrl(source.data);
    if (Array.isArray(source.tiles)) source.tiles.forEach(addUrl);
  }
  if (project.basemapVisible !== false && !isMapboxStyleUrl(project.basemapStyleUrl)) {
    const style = resolveMapStyle(project.basemapStyleUrl);
    if (typeof style === "string") {
      addUrl(style);
    } else {
      addUrl(style.glyphs);
      if (typeof style.sprite === "string") addUrl(style.sprite);
      else style.sprite?.forEach((sprite) => addUrl(sprite.url));
      Object.values(style.sources).forEach(addSource);
    }
  }
  const layers = applyGroupEffects(project.layers, project.layerGroups ?? []);
  for (const layer of previewableLayers({ ...project, layers })) addSource(layer.source);
  return [...origins];
}

/** Human-readable content present in the saved project but not rendered by this view. */
export function unsupportedContent(project: GeoLibreProject): string[] {
  const notices: string[] = [];
  for (const layer of applyGroupEffects(project.layers, project.layerGroups ?? [])) {
    if (!layer.visible) continue;
    const missing = missingData(layer);
    const pluginOwned =
      layer.metadata?.externalNativeLayer === true ||
      layer.metadata?.sourceKind === "maplibre-gl-vector";
    const desktopOnly = isDesktopOnly(layer);
    const kind = classifyLayer(layer);
    const pluginKind = layerKindSupport(MAPLIBRE_SUPPORTED_LAYER_KINDS, kind) === "plugin";
    const reason =
      layer.type === "video"
        ? "video loading bypasses the consent-gated request path"
        : layer.type === "pmtiles"
          ? "requires the PMTiles plugin, whose loader is not available in this preview"
          : desktopOnly
            ? "requires a desktop-local source"
            : missing
              ? missing
              : isDeckOnlyGeoJson(layer)
                ? "requires the deck.gl elevation renderer"
                : pluginOwned
                  ? "owned by a plugin/native map control not loaded in this preview"
                  : pluginKind
                    ? "requires a plugin renderer not loaded in this preview"
                    : layerKindSupport(MAPLIBRE_SUPPORTED_LAYER_KINDS, kind) === "unsupported"
                      ? "not supported by this preview renderer"
                      : undefined;
    if (reason) notices.push(`Layer “${layer.name}” (${layerKindName(layer)}): ${reason}.`);
    if (hasImagePopupFields(layer)) {
      notices.push(
        `Layer “${layer.name}”: configured popup image fields are shown as text because popup images bypass preview network consent.`,
      );
    }
  }
  if (project.basemapVisible !== false && isMapboxStyleUrl(project.basemapStyleUrl)) {
    notices.push("The Mapbox basemap is not shown because preview credentials are redacted.");
  }

  if (project.plugins?.activePluginIds.length)
    notices.push("Active plugins are not loaded in this preview.");
  if (project.legend?.panelVisible || Object.keys(project.legend?.customEntries ?? {}).length > 0) {
    notices.push("The configured legend is not shown in this preview.");
  }
  if (Object.values(project.interaction?.controls ?? {}).some(Boolean))
    notices.push("Configured map controls are not shown in this preview.");
  if (
    (project.secondaryMapViews?.length ?? 0) > 0 ||
    (project.mapLayout?.rows ?? 1) * (project.mapLayout?.cols ?? 1) > 1
  ) {
    notices.push("Additional map views are not shown in this preview.");
  }
  // eslint-disable-next-line local/no-renderer-kind-checks -- Names the saved engine omitted by this MapLibre-only view, not a capability decision.
  if (project.primaryRenderer && project.primaryRenderer !== "maplibre") {
    notices.push(
      `The project’s primary renderer (“${project.primaryRenderer}”) is not reproduced; this preview uses MapLibre.`,
    );
  }
  return notices;
}
