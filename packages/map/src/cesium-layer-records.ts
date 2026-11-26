// Readers and predicates over GeoLibreLayer records for the Cesium layer sync: supported kinds, URLs, credits, bounds.

import {
  cesiumKmlSource,
  isCesiumKmlLayer,
  allowsCredentialHeaders,
  cesiumIonAssetId,
  compileLayerFilters,
  czmlSource,
  isCzmlLayer,
  ruleBasedVisibilityFilter,
  type GeoLibreLayer,
} from "@geolibre/core";
import { cogSourceUrl } from "./cesium-cog-imagery";
import { isDrapedLayer } from "./cesium-drape";
import { isGlobeDeckVizLayer } from "./cesium-deck-viz";
import { getZarrStore } from "./zarr-source";
import { isSplatTilesetUrl, pointCloudSourceKind } from "./cesium-point-cloud";
import {
  classifyLayer,
  hasLayerKindSupport,
  type LayerKind,
  type SupportedLayerKinds,
} from "./layer-kind";
import { normalizePMTilesUrl } from "./pmtiles-layer";

/**
 * Whether a PMTiles/MBTiles layer describes a raster archive. Tile archives
 * render on the globe when the archive holds raster tiles (issue #2283); their
 * vector form goes through the drape (#2284), so the predicate reads the
 * archive's tile type rather than the layer type alone.
 */
function isRasterArchive(layer: GeoLibreLayer): boolean {
  return (
    classifyLayer(layer) === "tile-archive" &&
    (layer.metadata?.tileType === "raster" || layer.source?.type === "raster")
  );
}

/** Whether this is a Zarr layer, which the globe draws through zarr-cesium (#2261). */
export function isZarrLayer(layer: GeoLibreLayer): boolean {
  return layer.type === "zarr";
}

/** Whether this is a maplibre-gl-raster COG layer the globe can open itself. */
export function isCogLayer(layer: GeoLibreLayer): boolean {
  return layer.type === "cog";
}

/**
 * Kinds that never take the GeoJSON path, whatever `layer.geojson` holds.
 *
 * Cesium draws imagery and 3D Tiles natively, so those go to their own
 * branches. The tile-backed vector kinds and the deck.gl overlay keep their
 * features somewhere Cesium has no renderer for, and a FeatureCollection that
 * lands on one of them is a partial read-back (the attribute table pulls one
 * off the map source), not the layer's contents — drawing it would show a
 * viewport's worth of features as if it were the whole layer. `"arcgis"`
 * belongs with them: every `type: "arcgis"` layer is VectorTileServer-backed,
 * because `addArcGISLayer` routes FeatureServer layers to `addGeoJsonLayer`
 * (making them `type: "geojson"`) and map/image services to a raster layer. No
 * in-app producer attaches a collection to one, but a hand-authored
 * `.geolibre.json`, an MCP-generated project, or the embed API could.
 *
 * Everything else is decided by the data rather than the type: any layer
 * carrying a FeatureCollection renders through the GeoJSON path, so a producer
 * that starts populating `layer.geojson` needs no change here.
 */
const NON_GEOJSON_KINDS: ReadonlySet<LayerKind> = new Set<LayerKind>([
  "raster-tiles",
  "image",
  "3d-tiles",
  "cog",
  "vector-tiles",
  "tile-archive",
  "deckgl-viz",
  "arcgis",
]);

/**
 * `metadata.sourceKind` of the ArcGIS layers Cesium has a native provider for.
 * Must stay in sync with `ARCGIS_MAP_SERVICE_SOURCE_KIND` in
 * `packages/plugins/src/plugins/arcgis-layer.ts`, which writes it — `@geolibre/map`
 * cannot import from `@geolibre/plugins` (the dependency runs the other way).
 */
export const ARCGIS_MAP_SERVICE_KIND = "arcgis-map-service";

/** `metadata.sourceKind` of the ArcGIS I3S scene layers (`arcgis-i3s-tiles.ts`). */
const ARCGIS_I3S_SOURCE_KIND = "arcgis-i3s";

/** Whether a 3D Tiles-typed layer is an I3S scene layer rather than a tileset. */
export function isI3sLayer(layer: GeoLibreLayer): boolean {
  return layer.type === "3d-tiles" && layer.metadata?.sourceKind === ARCGIS_I3S_SOURCE_KIND;
}

/** A point-cloud (`lidar`) layer's URL. */
export function pointCloudUrl(layer: GeoLibreLayer): string | undefined {
  return str(layer.source.url) ?? str(layer.sourcePath);
}

/**
 * A 3D Tiles-shaped source the globe loads through `Cesium3DTileset`: a 3D
 * Tiles layer proper, a Gaussian-splat layer whose asset is a tileset (Cesium
 * renders `KHR_gaussian_splatting` tiles natively; a raw `.ply`/`.splat`
 * file has no globe loader), or a point cloud already in 3D Tiles form.
 */
export function isTilesetLayer(layer: GeoLibreLayer): boolean {
  if (isCzmlLayer(layer) || isCesiumKmlLayer(layer)) return false;
  if (layer.type === "3d-tiles") return true;
  if (layer.type === "gaussian-splat")
    return isSplatTilesetUrl(str(layer.source.url) ?? str(layer.sourcePath));
  if (layer.type === "lidar") return pointCloudSourceKind(pointCloudUrl(layer)) === "tileset";
  return false;
}

/**
 * A point cloud the globe decodes itself: a COPC archive (issue #2285), or a
 * plain LAS/LAZ file or an EPT dataset (issue #2261).
 */
export function isDecodedPointCloudLayer(layer: GeoLibreLayer): boolean {
  if (layer.type !== "lidar") return false;
  const kind = pointCloudSourceKind(pointCloudUrl(layer));
  return kind === "copc" || kind === "las" || kind === "ept";
}

/**
 * Compose a layer's per-feature filter expression from its transient time
 * filter, embed API filter, persisted authored filters, rule-based visibility
 * filter, and annotation visibility filter. Returns null when no filter
 * constrains the layer.
 */
export function composeLayerFeatureFilter(layer: GeoLibreLayer): unknown[] | null {
  const filters: unknown[] = [];
  const timeFilter = layer.timeFilter;
  if (Array.isArray(timeFilter) && timeFilter.length > 0) {
    filters.push(timeFilter);
  }
  if (Array.isArray(layer.embedFilter) && layer.embedFilter.length > 0) {
    filters.push(layer.embedFilter);
  }
  const authoredFilter = compileLayerFilters(layer);
  if (authoredFilter) {
    filters.push(authoredFilter);
  }
  const ruleFilter = ruleBasedVisibilityFilter(layer.style ?? {});
  if (ruleFilter) {
    filters.push(ruleFilter);
  }
  if (layer.metadata?.sourceKind === "annotation") {
    filters.push(["!=", ["get", "visible"], false]);
  }
  if (filters.length === 0) return null;
  if (filters.length === 1) return filters[0] as unknown[];
  return ["all", ...filters];
}

/**
 * Recursively extracts a valid timestamp or ISO date string from a MapLibre filter
 * expression, returning a Date instance if found.
 *
 * @param filter The filter expression array or sub-expression to inspect.
 * @returns A parsed Date if a temporal value is found, or null otherwise.
 */
export function extractTimeFilterDate(filter: unknown): Date | null {
  if (!Array.isArray(filter)) return null;
  for (const item of filter) {
    if (Array.isArray(item)) {
      const d = extractTimeFilterDate(item);
      if (d) return d;
    } else if (typeof item === "number" && Number.isFinite(item)) {
      if (item > 100000000000 && item < 4102444800000) {
        return new Date(item);
      }
    } else if (typeof item === "string" && item.length >= 10) {
      const d = new Date(item);
      if (!Number.isNaN(d.getTime()) && d.getFullYear() >= 1970 && d.getFullYear() <= 2100) {
        return d;
      }
    }
  }
  return null;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** A layer's attribution, escaped for a provider's `credit` option. */
export function layerCredit(layer: GeoLibreLayer): string | undefined {
  const attribution = str(layer.source.attribution);
  return attribution ? escapeCreditHtml(attribution) : undefined;
}

/** Treat project attribution as text before handing it to Cesium's HTML credit sink. */
export function escapeCreditHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[character]!;
  });
}

/** See {@link allowsCredentialHeaders}; shared with the 2D 3D Tiles renderers. */
export const allowsCredentials = allowsCredentialHeaders;

/**
 * A Cesium proxy that refuses any request a credential-bearing resource would
 * send to a non-secure URL. Cesium hands the proxy to every resource derived
 * from the tileset's, so child tiles named by absolute `http:` URLs in the
 * tileset JSON fail instead of receiving the headers.
 */
export const CREDENTIAL_PROXY = {
  getURL(url: string): string {
    // `data:`/`blob:` never leave the process (embedded glTF buffers).
    if (!/^(?:data|blob):/i.test(url) && !allowsCredentials(url)) {
      throw new Error(`Request headers are not sent over ${url}`);
    }
    return url;
  },
};

/** An ArcGIS REST export template (`MapServer/export?`, `ImageServer/exportImage?`). */
export const ARCGIS_REST_EXPORT = /\/(?:Map|Image)Server\/export(?:Image)?\?/i;

/** A `{z}`/`{level}` placeholder: a `source.url` that is a tile template. */
const TILE_TEMPLATE = /\{(?:z|level)\}/;

/**
 * A raster layer's first tile template, in the `{z}/{x}/{y}` form Cesium's
 * template provider reads.
 *
 * `source.tiles` is the usual home. A raster record whose `source.url` is
 * itself a template is read too, as the ArcGIS renderer reads it: the Esri
 * Wayback control mirrors its release that way, with Esri's
 * `{level}/{row}/{col}` placeholders, which are rewritten here.
 */
export function firstTile(layer: GeoLibreLayer): string | undefined {
  const tiles = layer.source.tiles;
  const tile = Array.isArray(tiles) ? str(tiles[0]) : undefined;
  const url = layer.type === "raster" ? str(layer.source.url) : undefined;
  const template = tile ?? (url && TILE_TEMPLATE.test(url) ? url : undefined);
  return template
    ?.replaceAll("{level}", "{z}")
    .replaceAll("{row}", "{y}")
    .replaceAll("{col}", "{x}");
}

export function tilesetUrl(layer: GeoLibreLayer): string | undefined {
  return str(layer.source.url) ?? str(layer.sourcePath);
}

export function hasGeoJsonCollection(layer: GeoLibreLayer): boolean {
  const kind = classifyLayer(layer);
  return (
    !(kind !== undefined && NON_GEOJSON_KINDS.has(kind)) &&
    layer.geojson?.type === "FeatureCollection"
  );
}

export function hasRenderableGeoJson(layer: GeoLibreLayer): boolean {
  return hasGeoJsonCollection(layer) && Boolean(layer.geojson?.features?.length);
}

/**
 * Resolves the ArcGIS access token for a layer.
 *
 * The Add ArcGIS Layer flow bakes the token into the pre-built export/cache tile
 * URL rather than storing it on the layer (`arcgis-layer.ts`), and `sourcePath`
 * — the service URL Cesium's provider needs — is the bare, token-less one. So a
 * token-protected service renders in 2D but would authenticate nowhere on the
 * globe unless it is read back off the tile template.
 */
export function arcgisToken(layer: GeoLibreLayer): string | undefined {
  const explicit = str(layer.source.token);
  if (explicit) return explicit;
  const tile = firstTile(layer);
  if (!tile) return undefined;
  // A cached tile template carries no query string at all; without this guard
  // indexOf returns -1 and the whole URL would be parsed as if it were one.
  const q = tile.indexOf("?");
  if (q === -1) return undefined;
  return str(new URLSearchParams(tile.slice(q + 1)).get("token") ?? undefined);
}

/** The cached `[west, south, east, north]` an image layer's producer wrote, if usable. */
function boundsFromMetadata(layer: GeoLibreLayer): [number, number, number, number] | undefined {
  const b = layer.metadata?.bounds;
  if (
    Array.isArray(b) &&
    b.length === 4 &&
    b.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    return [b[0], b[1], b[2], b[3]];
  }
  return undefined;
}

/**
 * Extracts the 2D bounding box [west, south, east, north] in degrees from an
 * image layer's four corner coordinates, falling back to `metadata.bounds`.
 *
 * `source.coordinates` is preferred over the cached `metadata.bounds` because
 * it is what the 2D `ImageSource` renders from, it is antimeridian-aware (see
 * below), and it keeps `needsRebuild` honest for a future edit-GCPs flow that
 * would move the corners without rewriting `metadata.bounds`. Both current
 * producers (`cornersToBounds` in the Georeferencer, and the KML ground-overlay
 * importer) derive `metadata.bounds` from these same corners with a plain
 * min/max, which inverts across the antimeridian — so the fallback only matters
 * for a hand-authored project that omits the corners, and there the array's own
 * west/east order is taken as authoritative.
 */
export function imageBounds(layer: GeoLibreLayer): [number, number, number, number] | undefined {
  const c = layer.source.coordinates;
  if (
    Array.isArray(c) &&
    c.length === 4 &&
    c.every(
      (pt) =>
        Array.isArray(pt) &&
        pt.length >= 2 &&
        typeof pt[0] === "number" &&
        Number.isFinite(pt[0]) &&
        typeof pt[1] === "number" &&
        Number.isFinite(pt[1]),
    )
  ) {
    // Note: Reducing a georeferenced image's 4 corners to an axis-aligned min/max
    // bounding box will visibly distort rotated KML GroundOverlays since
    // SingleTileImageryProvider cannot render a skewed quad. This is an accepted
    // approximation for now.
    const lngs = c.map((pt) => pt[0]);
    const lats = c.map((pt) => pt[1]);
    let minLng = Math.min(...lngs);
    let maxLng = Math.max(...lngs);
    if (maxLng - minLng > 180) {
      const eastOfZero = lngs.filter((lng) => lng > 0);
      const westOfZero = lngs.filter((lng) => lng < 0);
      // In-range longitudes spanning more than 180° always straddle zero, so
      // both sides are non-empty. Out-of-range corners from a hand-authored
      // project can empty one, and Math.min/max of nothing is ±Infinity — fall
      // back to metadata.bounds rather than hand Cesium an infinite corner
      // (Rectangle.fromDegrees would throw into createImagery's catch, blanking
      // the layer with no diagnostic tied to this cause).
      if (!eastOfZero.length || !westOfZero.length) return boundsFromMetadata(layer);
      minLng = Math.min(...eastOfZero);
      maxLng = Math.max(...westOfZero);
    }
    return [minLng, Math.min(...lats), maxLng, Math.max(...lats)];
  }
  return boundsFromMetadata(layer);
}

/**
 * The pieces a capabilities-driven WMTS layer (no tile template) needs to build a
 * `WebMapTileServiceImageryProvider`, or undefined if any is missing.
 *
 * Cesium requires all three — it throws a `DeveloperError` on a missing
 * `tileMatrixSetID` rather than defaulting one. A guessed matrix set is worse
 * than none: the provider would request matrix identifiers the server does not
 * publish and 404 per tile, so the layer reads as globe-capable but renders
 * blank. Reporting an incomplete entry as 2D-only fails loudly instead.
 */
export function wmtsCapabilities(
  layer: GeoLibreLayer,
): { url: string; layer: string; tileMatrixSetID: string } | undefined {
  const url = str(layer.source.url);
  const id = str(layer.source.layer) ?? str(layer.source.layers);
  const tileMatrixSetID = str(layer.source.tileMatrixSetID) ?? str(layer.source.tileMatrixSet);
  if (!url || !id || !tileMatrixSetID) return undefined;
  return { url, layer: id, tileMatrixSetID };
}

export function videoUrls(layer: GeoLibreLayer): string[] {
  const urls = Array.isArray(layer.source.urls)
    ? layer.source.urls.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  if (urls.length > 0) return urls;
  const single = str(layer.source.url);
  return single ? [single] : [];
}

export function videoCorners(layer: GeoLibreLayer): [number, number][] | null {
  const coords = layer.source.coordinates;
  if (!Array.isArray(coords) || coords.length !== 4) return null;
  const parsed: [number, number][] = [];
  for (const pt of coords) {
    if (
      !Array.isArray(pt) ||
      pt.length < 2 ||
      typeof pt[0] !== "number" ||
      typeof pt[1] !== "number" ||
      !Number.isFinite(pt[0]) ||
      !Number.isFinite(pt[1])
    ) {
      return null;
    }
    parsed.push([pt[0], pt[1]]);
  }
  return parsed;
}

function hasVideoSource(layer: GeoLibreLayer): boolean {
  return layer.type === "video" && videoUrls(layer).length > 0 && videoCorners(layer) !== null;
}

function isDuckDBPluginLayer(layer: GeoLibreLayer): boolean {
  return layer.type === "duckdb-query" && layer.metadata?.sourceKind === "duckdb-query";
}

/**
 * What the globe's kind dispatch ({@link isCesiumSupportedLayerType}) does with
 * each layer kind. The globe has no plugin controls, so almost every kind it
 * draws is `"native"` (some only for certain data: a raster archive, a draped
 * style, a tileset URL). `deckgl-viz` is `"plugin"`: only the records the
 * Deck.gl Layer builder wrote are drawn, rewritten from its config. The
 * `"unsupported"` kinds stay in the 2D panes, unless their record carries a
 * FeatureCollection, CZML or KML, which the globe draws whatever the kind.
 */
export const CESIUM_SUPPORTED_LAYER_KINDS = Object.freeze({
  geojson: "native",
  "raster-tiles": "native",
  "vector-tiles": "native",
  arcgis: "native",
  "tile-archive": "native",
  zarr: "native",
  lidar: "native",
  "gaussian-splat": "native",
  "3d-tiles": "native",
  cog: "native",
  "vector-file": "unsupported",
  "duckdb-query": "plugin",
  "deckgl-viz": "plugin",
  video: "native",
  image: "native",
} as const satisfies SupportedLayerKinds);

/**
 * Whether the globe can render this layer *kind* at all (regardless of whether
 * its data has loaded yet). Exported so the UI can flag "2D only" layers on a
 * globe pane. See the module header for the supported kinds.
 */
export function isCesiumSupportedLayerType(layer: GeoLibreLayer): boolean {
  // Decided by the data whatever the kind: a CZML or KML document, or a
  // FeatureCollection on a kind that takes the GeoJSON path.
  if (isCzmlLayer(layer) || isCesiumKmlLayer(layer) || hasGeoJsonCollection(layer)) return true;
  const kind = classifyLayer(layer);
  // No globe renderer (vector files), or an unknown type: these stay in the 2D panes.
  if (hasLayerKindSupport(CESIUM_SUPPORTED_LAYER_KINDS, kind, "unsupported")) return false;
  switch (kind) {
    // GeoJSON (loaded or not yet), imagery (tile templates and a georeferenced
    // image as a single-tile provider) and COGs, which the globe opens itself.
    case "geojson":
    case "raster-tiles":
    case "image":
    case "cog":
    case "zarr":
      return true;
    case "video":
      return hasVideoSource(layer);
    case "duckdb-query":
      return isDuckDBPluginLayer(layer);
    case "3d-tiles":
    case "gaussian-splat":
      return isTilesetLayer(layer);
    case "lidar":
      return isTilesetLayer(layer) || isDecodedPointCloudLayer(layer);
    case "tile-archive":
      return isRasterArchive(layer) || isDrapedLayer(layer);
    case "vector-tiles":
    case "arcgis":
      return isDrapedLayer(layer);
    // Rewritten into a GeoJSON or CZML record by sync() (cesium-deck-viz.ts);
    // the screen-space and density kinds (heatmap, screen grid, contour) stay 2D.
    case "deckgl-viz":
      return isGlobeDeckVizLayer(layer);
  }
}

/** Whether this layer can render on the globe now (kind supported + data ready). */
export function isSupported(layer: GeoLibreLayer): boolean {
  if (!isCesiumSupportedLayerType(layer)) return false;
  if (isCesiumKmlLayer(layer)) return Boolean(cesiumKmlSource(layer));
  if (isCzmlLayer(layer)) {
    const src = czmlSource(layer);
    return Boolean(src && (src.url || src.data));
  }
  if (layer.type === "video") return hasVideoSource(layer);
  if (hasRenderableGeoJson(layer)) return true;
  // A layer that carries a FeatureCollection renders from it or not at all.
  // Falling through to the imagery checks below would let an incidental
  // `source.tiles` draw a layer whose features are empty or still loading.
  // `"geojson"` and `"duckdb-query"` are named explicitly for the case where
  // nothing has loaded yet and there is no collection to recognize them by.
  if (hasGeoJsonCollection(layer) || layer.type === "geojson" || layer.type === "duckdb-query")
    return false;
  // An Ion asset (issue #2290) needs only its id; the token is runtime config
  // and its absence is reported as a layer error, not as "unsupported".
  if (cesiumIonAssetId(layer) !== null) return true;
  if (layer.type === "3d-tiles") return Boolean(tilesetUrl(layer));
  if (layer.type === "gaussian-splat" || layer.type === "lidar")
    return isTilesetLayer(layer) || isDecodedPointCloudLayer(layer);
  // MapServer only: ArcGisMapServerImageryProvider speaks the MapServer REST
  // surface (a `?f=json` capabilities document, `/export`), which an ImageServer
  // does not expose (it answers `/exportImage` and takes a renderingRule instead
  // of layers). Image services keep falling through to their pre-built tile
  // template like any other raster.
  // Without a sourcePath there is no service URL for the provider, but
  // createImagery then falls through to the generic tile-template branch — so
  // stay in step with it rather than reporting the layer unsupported and
  // dropping globe rendering a plain raster would have had.
  if (layer.type === "raster" && layer.metadata?.sourceKind === ARCGIS_MAP_SERVICE_KIND) {
    return Boolean(str(layer.sourcePath)) || Boolean(firstTile(layer));
  }
  if (layer.type === "image") {
    return Boolean(str(layer.source.url)) && Boolean(imageBounds(layer));
  }
  // WebMapServiceImageryProvider defaults `layers` to "", so a service URL alone
  // is enough for WMS. WMTS needs a layer identifier: without one createImagery
  // has no branch to take and would register an entry that renders nothing.
  if (layer.type === "wms") return Boolean(str(layer.source.url)) || Boolean(firstTile(layer));
  if (layer.type === "wmts") {
    return Boolean(wmtsCapabilities(layer)) || Boolean(firstTile(layer));
  }
  if (isCogLayer(layer)) return Boolean(cogSourceUrl(layer));
  // A registered store (a local folder, an Icechunk repository) stands in for
  // the URL; zarr-cesium needs one or the other plus the variable.
  if (isZarrLayer(layer))
    return (
      Boolean(str(layer.source.variable)) &&
      (Boolean(str(layer.source.url)) || Boolean(getZarrStore(layer.id)))
    );
  if (layer.type === "pmtiles") return Boolean(pmtilesArchiveUrl(layer));
  return Boolean(firstTile(layer));
}

/** The archive URL a raster PMTiles layer draws from, with the `pmtiles://` prefix. */
export function pmtilesArchiveUrl(layer: GeoLibreLayer): string | undefined {
  const raw = str(layer.source.url) ?? str(layer.sourcePath);
  return raw ? normalizePMTilesUrl(raw) : undefined;
}
