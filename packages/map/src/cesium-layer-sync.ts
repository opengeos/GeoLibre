import {
  compileFeatureExpression,
  compileQuickFilters,
  DEFAULT_LAYER_STYLE,
  geojsonHasZCoordinates,
  resolveThreeDTilesRequestHeaders,
  ruleBasedVisibilityFilter,
  transformGeojsonElevation,
  styleValue,
  type GeoLibreLayer,
  type LayerStyle,
} from "@geolibre/core";
import { featureFilter } from "@maplibre/maplibre-gl-style-spec";
import type { Feature } from "geojson";
import { readMapViewFromCamera, zoomToDisplayDistance } from "./cesium-camera";
import {
  cachingCogTiler,
  cogRenderSignature,
  cogSourceUrl,
  createCogImageryProvider,
  type CogTilerModule,
} from "./cesium-cog-imagery";
import { drapeSignature, isDrapedLayer, MapLibreDrape } from "./cesium-drape";
import { createFeatureStyleResolver, type FeatureStyleResolver } from "./cesium-feature-style";
import { createCesiumLabeler, pickLabelPart } from "./cesium-labels";
import {
  buildPointCloudCollection,
  isSplatTilesetUrl,
  loadCopcPointCloud,
  pointCloudSourceKind,
  setPointCloudOpacity,
  type LoadCopcOptions,
} from "./cesium-point-cloud";
import {
  buildPointBatch,
  clusterActiveAtZoom,
  clusterAppearance,
  configureClustering,
  isBatchedPointRef,
  planPointRendering,
  restylePointBatch,
  type PointRenderPlan,
} from "./cesium-points";
import {
  hasRegisteredProtocol,
  ProtocolImageryProvider,
  protocolScheme,
  webMercatorRectangle,
} from "./cesium-protocol-imagery";
import { renderFillPatternCanvas } from "./fill-patterns";
import { getLayerBounds } from "./geojson-loader";
import { getPMTilesArchive } from "./layer-sync";
import { renderMarkerCanvas } from "./markers";
import { normalizePMTilesUrl } from "./pmtiles-layer";
import type { Header as PMTilesHeader } from "pmtiles";
import type {
  Cartesian2,
  Cesium3DTileset,
  CesiumWidget,
  Color,
  DataSource,
  DistanceDisplayCondition,
  Entity,
  I3SDataProvider,
  ImageryLayer,
  ImageryProvider,
  PointPrimitiveCollection,
  Resource,
  TilingScheme,
} from "@cesium/engine";

// Reconciles the store's `GeoLibreLayer[]` onto a Cesium globe, mirroring what
// MapController.syncLayers does for MapLibre. M3 covers the layer kinds where
// Cesium is the natural renderer: GeoJSON-backed data (as a draped
// GeoJsonDataSource), XYZ / WMS / WMTS / raster / image tiles (as
// ImageryLayers), and 3D Tiles (as a Cesium3DTileset).
// Other kinds are skipped on the globe (they still render in
// the 2D panes); the exported `isCesiumSupportedLayerType` lets the UI flag them.
//
// The engine is injected (the `Cesium` namespace + a `CesiumWidget`) so this module
// carries only type-only Cesium imports and never pulls the engine into the
// build graph itself.

type CesiumNs = typeof import("@cesium/engine");

/** Whether a serialized filter reads `["zoom"]`, so its result depends on the camera. */
const ZOOM_OPERAND = /\[\s*"zoom"\s*\]/;

/** Most marker sprites baked for one layer (one per distinct classified colour). */
const MAX_MARKER_SPRITES = 64;

/** Ground metres one fill-pattern tile spans on a draped polygon. */
const PATTERN_TILE_METERS = 20;

/** The subset of a Cesium `Event` the camera watch needs. */
interface CameraEvent {
  addEventListener(listener: () => void): unknown;
  removeEventListener(listener: () => void): unknown;
}

/** Layer kinds this pass renders on the globe. */
const IMAGERY_TYPES = new Set(["raster", "xyz", "wms", "wmts", "image"]);

/**
 * Tile-archive kinds that render on the globe when the archive holds raster
 * tiles (issue #2283). Their vector form has no globe renderer (#2284), so the
 * predicate reads the archive's tile type rather than the layer type alone.
 */
const RASTER_ARCHIVE_TYPES = new Set(["pmtiles", "mbtiles"]);

/** Whether a PMTiles/MBTiles layer describes a raster archive. */
function isRasterArchive(layer: GeoLibreLayer): boolean {
  return (
    RASTER_ARCHIVE_TYPES.has(layer.type) &&
    (layer.metadata?.tileType === "raster" || layer.source?.type === "raster")
  );
}

/** Whether this is a maplibre-gl-raster COG layer the globe can open itself. */
function isCogLayer(layer: GeoLibreLayer): boolean {
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
const NON_GEOJSON_TYPES = new Set([
  ...IMAGERY_TYPES,
  "3d-tiles",
  "cog",
  "vector-tiles",
  "pmtiles",
  "mbtiles",
  "deckgl-viz",
  "arcgis",
]);

/**
 * `metadata.sourceKind` of the ArcGIS layers Cesium has a native provider for.
 * Must stay in sync with `ARCGIS_MAP_SERVICE_SOURCE_KIND` in
 * `packages/plugins/src/plugins/arcgis-layer.ts`, which writes it — `@geolibre/map`
 * cannot import from `@geolibre/plugins` (the dependency runs the other way).
 */
const ARCGIS_MAP_SERVICE_KIND = "arcgis-map-service";

type EntryKind = "imagery" | "geojson" | "3dtiles" | "points" | "pointcloud";

/** `metadata.sourceKind` of the ArcGIS I3S scene layers (`arcgis-i3s-tiles.ts`). */
const ARCGIS_I3S_SOURCE_KIND = "arcgis-i3s";

/** Whether a 3D Tiles-typed layer is an I3S scene layer rather than a tileset. */
function isI3sLayer(layer: GeoLibreLayer): boolean {
  return layer.type === "3d-tiles" && layer.metadata?.sourceKind === ARCGIS_I3S_SOURCE_KIND;
}

/** A point-cloud (`lidar`) layer's URL. */
function pointCloudUrl(layer: GeoLibreLayer): string | undefined {
  return str(layer.source.url) ?? str(layer.sourcePath);
}

/**
 * A 3D Tiles-shaped source the globe loads through `Cesium3DTileset`: a 3D
 * Tiles layer proper, a Gaussian-splat layer whose asset is a tileset (Cesium
 * renders `KHR_gaussian_splatting` tiles natively; a raw `.ply`/`.splat`
 * file has no globe loader), or a point cloud already in 3D Tiles form.
 */
function isTilesetLayer(layer: GeoLibreLayer): boolean {
  if (layer.type === "3d-tiles") return true;
  if (layer.type === "gaussian-splat")
    return isSplatTilesetUrl(str(layer.source.url) ?? str(layer.sourcePath));
  if (layer.type === "lidar") return pointCloudSourceKind(pointCloudUrl(layer)) === "tileset";
  return false;
}

/** A COPC point cloud the globe decodes itself (issue #2285). */
function isDecodedPointCloudLayer(layer: GeoLibreLayer): boolean {
  return layer.type === "lidar" && pointCloudSourceKind(pointCloudUrl(layer)) === "copc";
}

interface LayerEntry {
  kind: EntryKind;
  /** The layer as last applied, for change detection. */
  layer: GeoLibreLayer;
  /** The Cesium object, or null while an async create is in flight. */
  handle:
    | ImageryLayer
    | DataSource
    | Cesium3DTileset
    | I3SDataProvider
    | PointPrimitiveCollection
    | null;
  /** Aborts a decoded point cloud's download when the entry goes. */
  abort?: AbortController;
  /** Set when the entry is removed mid-load so the resolved handle is discarded. */
  cancelled: boolean;
  loadError?: string;
  /** Last opacity key applied in place to a geojson entry (skips redundant restyles). */
  appliedAlpha?: string;
  /** Last filter expression key applied in place (skips redundant filter evaluations). */
  appliedFilterKey?: string;
  /** Whether the applied filter reads `["zoom"]`, so it must re-run when the camera moves. */
  zoomFilter?: boolean;
  /** The per-feature style resolver for a geojson entry, compiled for {@link resolverKey}. */
  resolver?: FeatureStyleResolver;
  /** The style content {@link resolver} was compiled from (recompiled when it changes). */
  resolverKey?: string;
  /** Whether the resolver reads `["zoom"]`, so symbols must be re-resolved as the camera zooms. */
  zoomStyle?: boolean;
  /** Marker sprites baked per resolved marker colour (a classified marker layer has several). */
  markerImages?: Map<string, { canvas: HTMLCanvasElement; pixelRatio: number }>;
  /** A sprite bake in flight after a zoom step, and the zoom it resolves colours at. */
  markerBake?: Promise<boolean>;
  markerBakeZoom?: number;
  /** The fill pattern tile, when the style has one. */
  patternImage?: { canvas: HTMLCanvasElement; pixelRatio: number } | null;
  /** How the layer's points render (clustered, batched, plain). */
  plan?: PointRenderPlan;
  /** The clusterer handle for a clustered geojson entry. */
  cluster?: ReturnType<typeof configureClustering>;
  /** Whether clustering must switch on/off as the camera crosses `clusterMaxZoom`. */
  zoomCluster?: boolean;
}

/**
 * Compose a layer's per-feature filter expression from its transient time filter,
 * embed API filter, compiled quick filters, rule-based visibility filter, and
 * annotation visibility filter. Returns null when no filter constrains the layer.
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
  const quickFilter = compileQuickFilters(layer.quickFilters);
  if (quickFilter) {
    filters.push(quickFilter);
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

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Whether credential-bearing request headers may be sent to this URL.
 *
 * The scheme is read off a parsed URL rather than matched as a prefix, so an
 * unusually-cased `HTTPS://` from a hand-authored or MCP-generated project is
 * normalized instead of being misread as plaintext. A relative or unparseable
 * URL throws and is refused, matching `isAllowedPluginManifestUrl` in
 * `@geolibre/core`.
 */
function allowsCredentials(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === "https:") return true;
    // Loopback over http so a local dev tile server still works.
    return (
      protocol === "http:" &&
      (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function firstTile(layer: GeoLibreLayer): string | undefined {
  const tiles = layer.source.tiles;
  return Array.isArray(tiles) ? str(tiles[0]) : undefined;
}

function tilesetUrl(layer: GeoLibreLayer): string | undefined {
  return str(layer.source.url) ?? str(layer.sourcePath);
}

function hasGeoJsonCollection(layer: GeoLibreLayer): boolean {
  return !NON_GEOJSON_TYPES.has(layer.type) && layer.geojson?.type === "FeatureCollection";
}

function hasRenderableGeoJson(layer: GeoLibreLayer): boolean {
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
function arcgisToken(layer: GeoLibreLayer): string | undefined {
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
function imageBounds(layer: GeoLibreLayer): [number, number, number, number] | undefined {
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
function wmtsCapabilities(
  layer: GeoLibreLayer,
): { url: string; layer: string; tileMatrixSetID: string } | undefined {
  const url = str(layer.source.url);
  const id = str(layer.source.layer) ?? str(layer.source.layers);
  const tileMatrixSetID = str(layer.source.tileMatrixSetID) ?? str(layer.source.tileMatrixSet);
  if (!url || !id || !tileMatrixSetID) return undefined;
  return { url, layer: id, tileMatrixSetID };
}

/**
 * Whether the globe can render this layer *kind* at all (regardless of whether
 * its data has loaded yet). Exported so the UI can flag "2D only" layers on a
 * globe pane. See the module header for the supported kinds.
 */
export function isCesiumSupportedLayerType(layer: GeoLibreLayer): boolean {
  return (
    hasGeoJsonCollection(layer) ||
    layer.type === "geojson" ||
    isTilesetLayer(layer) ||
    isDecodedPointCloudLayer(layer) ||
    IMAGERY_TYPES.has(layer.type) ||
    isRasterArchive(layer) ||
    isCogLayer(layer) ||
    isDrapedLayer(layer)
  );
}

/** Whether this layer can render on the globe now (kind supported + data ready). */
function isSupported(layer: GeoLibreLayer): boolean {
  if (!isCesiumSupportedLayerType(layer)) return false;
  if (hasRenderableGeoJson(layer)) return true;
  // A layer that carries a FeatureCollection renders from it or not at all.
  // Falling through to the imagery checks below would let an incidental
  // `source.tiles` draw a layer whose features are empty or still loading.
  // `"geojson"` is named explicitly for the case where nothing has loaded yet
  // and there is no collection to recognize it by.
  if (hasGeoJsonCollection(layer) || layer.type === "geojson") return false;
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
  if (layer.type === "pmtiles") return Boolean(pmtilesArchiveUrl(layer));
  return Boolean(firstTile(layer));
}

/**
 * Every tileset an I3S provider drives. `I3SDataProvider.layers` is already
 * flat: a Building Scene Layer's nested sublayers register their `I3SLayer`s
 * there too (Cesium's `I3SDataProvider._fromData` pushes each sublayer's
 * layers into `_layers`), so one pass covers the whole tree.
 */
function i3sTilesets(provider: Partial<I3SDataProvider>): Cesium3DTileset[] {
  const tilesets: Cesium3DTileset[] = [];
  for (const layer of provider.layers ?? []) {
    if (layer.tileset && !tilesets.includes(layer.tileset)) tilesets.push(layer.tileset);
  }
  return tilesets;
}

/** Whether a tileset (or every tileset of an I3S provider) has loaded its tiles. */
function tilesLoaded(handle: Cesium3DTileset | I3SDataProvider): boolean {
  const provider = handle as Partial<I3SDataProvider>;
  if (Array.isArray(provider.layers)) {
    return i3sTilesets(provider).every((tileset) => tileset.tilesLoaded);
  }
  return Boolean((handle as Cesium3DTileset).tilesLoaded);
}

/** The archive URL a raster PMTiles layer draws from, with the `pmtiles://` prefix. */
function pmtilesArchiveUrl(layer: GeoLibreLayer): string | undefined {
  const raw = str(layer.source.url) ?? str(layer.sourcePath);
  return raw ? normalizePMTilesUrl(raw) : undefined;
}

// Floor for the contrast handed to Cesium. MapLibre can ask for a black point
// at or above mid-grey, which Cesium's brightness/contrast pair cannot express
// (see imageryColorAdjustments); flooring the contrast keeps the stretch exact
// and degrades only the lift, instead of letting the brightness factor run away.
const MIN_IMAGERY_CONTRAST = 0.1;

/**
 * Cesium's `ImageryLayer` colour controls for a layer's raster symbology.
 *
 * MapLibre and Cesium run the same four operations, but with different curves,
 * different neutral points, and a different order, so this is not a
 * property-by-property rename. Writing MapLibre's raster shader in order (hue
 * spin, saturation, contrast, brightness) and Cesium's `sampleAndBlend` in
 * order (brightness, contrast, hue, saturation):
 *
 * | step       | MapLibre                       | Cesium                     |
 * | ---------- | ------------------------------ | -------------------------- |
 * | saturation | `rgb += (avg - rgb) * f`       | `luma + (rgb - luma) * a`  |
 * | contrast   | `(rgb - 0.5) * k + 0.5`        | `0.5 + (rgb - 0.5) * k'`   |
 * | brightness | `mix(min, max, rgb)`           | `rgb * b`                  |
 *
 * where MapLibre derives `f` and `k` through
 * `f = s > 0 ? 1 - 1 / (1.001 - s) : -s` and `k = c > 0 ? 1 / (1 - c) : 1 + c`.
 *
 * Two things follow. Both curves bend above 0, so `1 + value` tracks MapLibre
 * only on the negative half and would leave the globe visibly flatter than the
 * 2D map for any positive contrast or saturation; both are mirrored exactly
 * here. (MapLibre pivots saturation on the channel average and Cesium on
 * luminance. That pivot is not something `ImageryLayer` exposes; the multiplier
 * is the part that translates.)
 *
 * And MapLibre's brightness is a *window*, not a gain: it scales by the
 * window's width and lifts the black point to `min`. Mapping the window onto
 * `brightness` alone would drop the width, so the globe would miss the
 * flattening that a narrowed window produces on the 2D map. Cesium has no
 * window, but its brightness and contrast compose into the same shape of
 * affine map, so the two are solved for together. With MapLibre's composed
 * contrast and brightness written as `out = S * in + I`:
 *
 *     S = k * (max - min)          I = (min + max) / 2 - S / 2
 *
 * and Cesium's composed brightness and contrast as
 * `out = (b * k') * in + 0.5 * (1 - k')`, matching slope and intercept gives
 * `k' = 1 - 2I` and `b = S / k'`. The one shape Cesium cannot reach is
 * `I >= 0.5`, hence {@link MIN_IMAGERY_CONTRAST}.
 */
export function imageryColorAdjustments(style: LayerStyle | undefined): {
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
} {
  const s = style ?? DEFAULT_LAYER_STYLE;
  const num = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const unit = (value: unknown, fallback: number) =>
    Math.min(1, Math.max(-1, num(value, fallback)));
  const min = num(styleValue(s, "rasterBrightnessMin"), 0);
  const max = num(styleValue(s, "rasterBrightnessMax"), 1);
  // The raster paint spec bounds both to [-1, 1] and MapLibre clamps on parse,
  // so a store value outside it would already be rendering differently in 2D.
  const contrast = unit(styleValue(s, "rasterContrast"), 0);
  const saturation = unit(styleValue(s, "rasterSaturation"), 0);

  // MapLibre's own curve, `1 / (1 - contrast)`, is +Infinity at contrast 1,
  // which is reachable: the Style panel's slider stops there. MapLibre hands that
  // Infinity to the shader and the framebuffer clamps it into a hard threshold
  // at mid-grey; here it would poison the slope/intercept solve below and set
  // brightness to NaN. Flooring the denominator keeps the curve exact
  // everywhere it is finite and turns the endpoint into the same very hard
  // threshold, rather than bending the whole positive half to dodge one point.
  const mapLibreContrast = contrast > 0 ? 1 / Math.max(1e-4, 1 - contrast) : 1 + contrast;
  const slope = mapLibreContrast * (max - min);
  const intercept = (min + max) / 2 - slope / 2;
  // A flat result (contrast -1, or a zero-width window) wants a contrast of 0,
  // which Cesium reaches exactly, so only floor the contrast when there is a
  // slope to divide by. Flooring unconditionally would leave the fully
  // flattened case a few percent off a target it can hit.
  const exactContrast = 1 - 2 * intercept;
  const cesiumContrast =
    slope > 0 ? Math.max(MIN_IMAGERY_CONTRAST, exactContrast) : Math.max(0, exactContrast);

  return {
    brightness: slope > 0 ? slope / cesiumContrast : 0,
    contrast: cesiumContrast,
    // 1.001 is MapLibre's own constant in saturationFactor, not a guard added
    // here; it is why this curve has no endpoint problem of its own.
    saturation: saturation > 0 ? 1 / (1.001 - saturation) : Math.max(0, 1 + saturation),
    hue: (num(styleValue(s, "rasterHueRotate"), 0) * Math.PI) / 180,
  };
}

function entryKind(layer: GeoLibreLayer): EntryKind {
  if (hasRenderableGeoJson(layer)) return planPointRendering(layer).batched ? "points" : "geojson";
  if (isTilesetLayer(layer)) return "3dtiles";
  if (isDecodedPointCloudLayer(layer)) return "pointcloud";
  return "imagery";
}

/**
 * Style fields re-applied in place by {@link CesiumLayerSync.applyGeoJsonStyle}
 * rather than by reloading the data source. Everything else in the style —
 * colours, classification stops and rules, expressions, widths, marker shape
 * and size, patterns, decorations, extrusion, elevation, labels, the zoom
 * range — bakes into the entities at load, so a change to any of them rebuilds.
 * Opacity is the hot path (a slider drag), and the fill opacity is a resolver
 * channel the in-place pass re-reads, so neither forces a reload.
 */
const IN_PLACE_STYLE_KEYS: ReadonlySet<string> = new Set(["fillOpacity", "extrusionOpacity"]);

/**
 * Style keys the globe never reads: the 2D map's blend mode, heatmap, diagram,
 * inverted fill, geometry generator, and line-decoration detail settings.
 * Editing one must not tear down and reload the data source. Anything not
 * listed here or in {@link IN_PLACE_STYLE_KEYS} rebuilds when it changes.
 */
const GLOBE_IGNORED_STYLE_KEYS: ReadonlySet<string> = new Set([
  "blendMode",
  // `pointRenderer`, `clusterRadius`, and `clusterMaxZoom` are read by the
  // clustering path (issue #2282) and so still rebuild.
  "heatmapRadius",
  "heatmapIntensity",
  "heatmapColorRamp",
  "heatmapWeightProperty",
  "diagramType",
  "diagramFields",
  "diagramSizeMode",
  "diagramSize",
  "diagramSizeProperty",
  "diagramMinZoom",
  "diagramDeclutter",
  "invertedFillEnabled",
  "lineDecorationColor",
  "lineDecorationSize",
  "lineDecorationSpacing",
  "geometryGenerator",
  "geometryGeneratorBufferDistance",
  "geometryGeneratorBufferProperty",
  "geometryGeneratorFillColor",
  "geometryGeneratorStrokeColor",
  "geometryGeneratorStrokeWidth",
  "geometryGeneratorOpacity",
  "geometryGeneratorCircleRadius",
  "geometryGeneratorSizeProperty",
  "geometryGeneratorSizeMinValue",
  "geometryGeneratorSizeMaxValue",
  "geometryGeneratorSizeMinRadius",
  "geometryGeneratorSizeMaxRadius",
]);

function styleSignature(layer: GeoLibreLayer): string {
  const style = (layer.style ?? {}) as unknown as Record<string, unknown>;
  const entries = Object.entries(style)
    .filter(
      ([key, value]) =>
        !IN_PLACE_STYLE_KEYS.has(key) && !GLOBE_IGNORED_STYLE_KEYS.has(key) && value !== undefined,
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Whether the Cesium object must be rebuilt (vs. just re-styled) for the change
 * from `prev` to `next`. Live-settable appearance (visibility, imagery alpha) is
 * excluded; only source/data/geometry changes force a rebuild. The GeoJSON
 * FeatureCollection is compared by reference (the store swaps it on edit) and
 * its fill/stroke colours bake into the Cesium colours at load, so a colour
 * change rebuilds; opacity is restyled in place (see styleSignature).
 */
function needsRebuild(prev: GeoLibreLayer, next: GeoLibreLayer): boolean {
  if (prev.type !== next.type) return true;
  const kind = entryKind(next);
  // Crossing the batching threshold, or switching clustering on, changes the
  // Cesium object kind outright.
  if (entryKind(prev) !== kind) return true;
  switch (kind) {
    case "geojson":
    case "points":
      return prev.geojson !== next.geojson || styleSignature(prev) !== styleSignature(next);
    case "imagery":
      return (
        (isCogLayer(next) && cogRenderSignature(prev) !== cogRenderSignature(next)) ||
        str(prev.metadata?.tileType) !== str(next.metadata?.tileType) ||
        // The Y-axis convention and the coverage rectangle bake into the
        // bridged provider.
        str(prev.source.scheme) !== str(next.source.scheme) ||
        JSON.stringify(prev.source.bounds ?? null) !== JSON.stringify(next.source.bounds ?? null) ||
        prev.source.tileSize !== next.source.tileSize ||
        firstTile(prev) !== firstTile(next) ||
        // min/maxzoom bake into UrlTemplateImageryProvider's min/maximumLevel.
        prev.source.maxzoom !== next.source.maxzoom ||
        prev.source.minzoom !== next.source.minzoom ||
        str(prev.source.url) !== str(next.source.url) ||
        str(prev.metadata?.sourceKind) !== str(next.metadata?.sourceKind) ||
        str(prev.sourcePath) !== str(next.sourcePath) ||
        str(prev.metadata?.arcgisSublayers) !== str(next.metadata?.arcgisSublayers) ||
        // Only the ArcGIS branch reads a token, and only the image branch reads
        // bounds. Gate both on the kind that consumes them: `metadata.bounds` is
        // set broadly (raster/time-slider layers too), and any tile URL can carry
        // an unrelated `token=` param, so diffing them for every imagery kind
        // would both waste work and force spurious rebuilds.
        (next.metadata?.sourceKind === ARCGIS_MAP_SERVICE_KIND &&
          arcgisToken(prev) !== arcgisToken(next)) ||
        str(prev.source.layers) !== str(next.source.layers) ||
        str(prev.source.layer) !== str(next.source.layer) ||
        str(prev.source.styles) !== str(next.source.styles) ||
        str(prev.source.style) !== str(next.source.style) ||
        str(prev.source.tileMatrixSetID) !== str(next.source.tileMatrixSetID) ||
        str(prev.source.tileMatrixSet) !== str(next.source.tileMatrixSet) ||
        str(prev.source.tilingScheme) !== str(next.source.tilingScheme) ||
        JSON.stringify(prev.source.tileMatrixLabels ?? null) !==
          JSON.stringify(next.source.tileMatrixLabels ?? null) ||
        // WMS/WMTS params baked into the provider at creation; a change must
        // rebuild it so the globe doesn't keep the stale provider.
        str(prev.source.format) !== str(next.source.format) ||
        str(prev.source.version) !== str(next.source.version) ||
        prev.source.transparent !== next.source.transparent ||
        (next.type === "image" &&
          JSON.stringify(imageBounds(prev)) !== JSON.stringify(imageBounds(next))) ||
        JSON.stringify(prev.source.requestHeaders ?? null) !==
          JSON.stringify(next.source.requestHeaders ?? null)
      );
    case "pointcloud":
      return (
        pointCloudUrl(prev) !== pointCloudUrl(next) ||
        // The offset bakes into every point's position.
        prev.source.altitudeOffset !== next.source.altitudeOffset
      );
    case "3dtiles":
      return (
        tilesetUrl(prev) !== tilesetUrl(next) ||
        str(prev.metadata?.sourceKind) !== str(next.metadata?.sourceKind) ||
        JSON.stringify(prev.source.requestHeaders ?? null) !==
          JSON.stringify(next.source.requestHeaders ?? null) ||
        prev.source.altitudeOffset !== next.source.altitudeOffset
      );
  }
}

/** The slice of a PMTiles header the raster branch reads. */
export type PMTilesRasterHeader = Pick<
  PMTilesHeader,
  "minZoom" | "maxZoom" | "minLon" | "minLat" | "maxLon" | "maxLat"
>;

/** Injection points for the environment-bound pieces of the sync (tests). */
export interface CesiumLayerSyncDeps {
  /** Loads the COG tiler module; defaults to `import("cog-tiler-wasm")`. */
  loadCogTiler?: () => Promise<CogTilerModule>;
  /**
   * Reads a raster PMTiles archive's header; defaults to the shared
   * `pmtiles://` protocol's archive (a range request over HTTP).
   */
  readPMTilesHeader?: (url: string) => Promise<PMTilesRasterHeader | undefined>;
  /**
   * Builds the hidden MapLibre map that drapes tile-backed vector layers
   * (issue #2284); defaults to a real one. `null` means draping is unavailable
   * (no WebGL context to spare), and those layers are reported as errors.
   */
  createDrape?: () => MapLibreDrape | null;
  /** Rasterises one marker sprite; defaults to the 2D map's marker renderer. */
  renderMarker?: typeof renderMarkerCanvas;
  /** Rasterises the fill-pattern tile; defaults to the 2D map's renderer. */
  renderFillPattern?: typeof renderFillPatternCanvas;
  /** Overrides for the COPC decoder (the module, the projector, the budget). */
  copcOptions?: Omit<LoadCopcOptions, "signal">;
}

async function readSharedPMTilesHeader(url: string): Promise<PMTilesRasterHeader | undefined> {
  const archive = getPMTilesArchive(url);
  return archive ? archive.getHeader() : undefined;
}

export class CesiumLayerSync {
  private readonly featureRefs = new WeakMap<object, { layerId: string; index: number }>();
  private readonly imageryRefs = new WeakMap<object, string>();
  private selection: { layerId: string; ids: Set<string> } | null = null;
  private highlightRestorers: Array<() => void> = [];

  /** Only live, visible entities owned by this synchronizer can identify a feature. */
  resolveFeature(entity: object) {
    // A batched point primitive carries its reference on `id` rather than
    // being an Entity the WeakMap knows.
    if (isBatchedPointRef(entity)) {
      const entry = this.entries.get(entity.geolibreLayerId);
      if (
        !entry ||
        entry.cancelled ||
        entry.kind !== "points" ||
        !entry.layer.visible ||
        entry.layer.opacity <= 0
      )
        return null;
      // A primitive the filter hid is not pickable, matching hidden entities;
      // the reference carries its primitive, so this is a field read on the
      // hover path rather than a scan of the batch.
      if (entity.primitive && !entity.primitive.show) return null;
      const feature = entry.layer.geojson?.features[entity.index];
      return feature
        ? {
            layerId: entity.geolibreLayerId,
            featureId: String(feature.id ?? entity.index),
            properties: feature.properties ?? {},
            geometry: feature.geometry,
          }
        : null;
    }
    const ref = this.featureRefs.get(entity);
    if (!ref) return null;
    const entry = this.entries.get(ref.layerId);
    if (
      !entry ||
      entry.cancelled ||
      !entry.layer.visible ||
      entry.layer.opacity <= 0 ||
      entry.kind !== "geojson" ||
      (entity as { show?: boolean }).show === false ||
      !(entry.handle as DataSource | null)?.entities.contains(entity as Entity)
    )
      return null;
    const feature = entry.layer.geojson?.features[ref.index];
    return feature
      ? {
          layerId: ref.layerId,
          featureId: String(feature.id ?? ref.index),
          properties: feature.properties ?? {},
          geometry: feature.geometry,
        }
      : null;
  }

  /**
   * Retained for future asynchronous imagery feature queries, as requested in #2274.
   * Imagery has a layer identity, but no synchronous GeoJSON feature identity.
   */
  imageryLayerId(imagery: object): string | undefined {
    return this.imageryRefs.get(imagery);
  }

  highlight(layerId: string | undefined, ids: string[]): void {
    this.restoreHighlight();
    this.selection = layerId && ids.length ? { layerId, ids: new Set(ids) } : null;
    this.applyHighlight();
    this.viewer.scene.requestRender();
  }

  private restoreHighlight(): void {
    for (const restore of this.highlightRestorers.splice(0)) restore();
  }

  private applyHighlight(): void {
    const selected = this.selection;
    const entry = selected && this.entries.get(selected.layerId);
    if (!selected || !entry || !entry.handle) return;
    const C = this.Cesium;
    const color = C.Color.fromCssColorString("#facc15");
    if (entry.kind === "points") {
      const collection = entry.handle as PointPrimitiveCollection;
      const features = entry.layer.geojson?.features ?? [];
      for (let i = 0; i < collection.length; i++) {
        const point = collection.get(i);
        const ref = point.id;
        if (!isBatchedPointRef(ref)) continue;
        const feature = features[ref.index];
        if (!feature || !selected.ids.has(String(feature.id ?? ref.index))) continue;
        const original = point.color;
        point.color = color;
        this.highlightRestorers.push(() => {
          point.color = original;
        });
      }
      this.viewer.scene.requestRender();
      return;
    }
    if (entry.kind !== "geojson") return;
    for (const entity of (entry.handle as DataSource).entities.values) {
      const ref = this.featureRefs.get(entity);
      const feature = ref && entry.layer.geojson?.features[ref.index];
      if (!feature || !selected.ids.has(String(feature.id ?? ref?.index))) continue;
      for (const key of ["polygon", "polyline", "billboard", "point"] as const) {
        const original = entity[key];
        if (!original) continue;
        const highlighted = original.clone();
        if (key === "polygon" || key === "polyline") {
          (highlighted as NonNullable<Entity["polygon"]>).material = new C.ColorMaterialProperty(
            color,
          );
        } else {
          (highlighted as NonNullable<Entity["point"]>).color = new C.ConstantProperty(color);
        }
        // Keep the actual Property objects, including time-varying styles, intact.
        Object.assign(entity, { [key]: highlighted });
        this.highlightRestorers.push(() => Object.assign(entity, { [key]: original }));
      }
    }
    this.viewer.scene.requestRender();
  }

  private readonly entries = new Map<string, LayerEntry>();

  getRenderStatus(): { pending: string[]; errors: string[] } {
    const pending: string[] = [];
    const errors: string[] = [];
    for (const layer of this.currentLayers) {
      if (!layer.visible || layer.opacity === 0) continue;
      if (hasGeoJsonCollection(layer) && !layer.geojson?.features.length) continue;
      // "2D only" kinds (PMTiles, Zarr, LiDAR, deck.gl-viz, ...) are skipped on
      // the globe by design and flagged as such in the layer list, so they are
      // not load failures: reporting them in `errors` would make every capture
      // throw for an ordinary mixed project.
      if (!isCesiumSupportedLayerType(layer)) continue;
      if (isDrapedLayer(layer)) {
        if (this.drapeError) errors.push(`${layer.name}: ${this.drapeError}`);
        else if (!this.drape || this.drape.pending > 0) pending.push(layer.name);
        continue;
      }
      const entry = this.entries.get(layer.id);
      if (entry?.handle?.show === false) continue;
      if (entry?.loadError) errors.push(`${layer.name}: ${entry.loadError}`);
      // sync() registers no entry for a kind the globe supports whose source is
      // unusable (no tile template, no image bounds), so without this it would
      // read as pending forever. A bare "geojson" layer is still loading.
      else if (!entry && layer.type !== "geojson" && !isSupported(layer))
        errors.push(`${layer.name}: missing or unsupported source configuration`);
      else if (!entry?.handle) pending.push(layer.name);
      // `allTilesLoaded` is an Event (always truthy); `tilesLoaded` is the flag.
      else if (
        entry.kind === "3dtiles" &&
        !tilesLoaded(entry.handle as Cesium3DTileset | I3SDataProvider)
      )
        pending.push(layer.name);
      else if (entry.kind === "geojson" && (entry.handle as DataSource).isLoading)
        pending.push(layer.name);
      else if (entry.kind === "imagery" && !(entry.handle as ImageryLayer).ready)
        pending.push(layer.name);
    }
    return { pending, errors };
  }
  /** Imagery id order last asserted on the globe, to skip redundant reorders. */
  private lastImageryOrder = "";
  /** Active layer list from the current/latest sync pass. */
  private currentLayers: GeoLibreLayer[] = [];

  /**
   * @param readZoom Supplies the camera's MapLibre zoom for `["zoom"]` filters;
   *   defaults to reading the live camera and is injectable for tests.
   */
  constructor(
    private readonly Cesium: CesiumNs,
    private readonly viewer: CesiumWidget,
    private readonly readZoom: () => number = () => readMapViewFromCamera(Cesium, viewer).zoom,
    private readonly deps: CesiumLayerSyncDeps = {},
  ) {}

  /**
   * The WASM COG tiler, loaded on first use and shared by every COG layer.
   * Lazy for the same reason the raster control loads it lazily: the module
   * and its peers are several megabytes that a globe without a COG never
   * needs. Injectable through {@link CesiumLayerSyncDeps} for tests.
   */
  private cogTiler: Promise<ReturnType<typeof cachingCogTiler>> | null = null;
  private loadCogTiler(): Promise<ReturnType<typeof cachingCogTiler>> {
    this.cogTiler ??= (this.deps.loadCogTiler ?? (() => import("cog-tiler-wasm")))().then(
      cachingCogTiler,
      (error) => {
        // A failed module load must not poison every later COG for the life
        // of the globe; the next COG layer retries the import.
        this.cogTiler = null;
        throw error;
      },
    );
    return this.cogTiler;
  }

  /** Drop a COG source from the cache once no remaining entry reads it. */
  private forgetCogSource(entry: LayerEntry): void {
    const url = cogSourceUrl(entry.layer);
    if (!url || !this.cogTiler) return;
    for (const other of this.entries.values()) {
      if (other !== entry && isCogLayer(other.layer) && cogSourceUrl(other.layer) === url) return;
    }
    // A tiler that failed to load has nothing to forget; keep the rejection quiet.
    void this.cogTiler.then((tiler) => tiler.forget(url)).catch(() => {});
  }

  /** Reconcile the globe to `layers` (order preserved for imagery stacking). */
  sync(layers: GeoLibreLayer[]): void {
    this.restoreHighlight();
    this.currentLayers = layers;
    for (const layer of layers) {
      if (Array.isArray(layer.timeFilter) && layer.timeFilter.length > 0) {
        const d = extractTimeFilterDate(layer.timeFilter);
        if (d) {
          this.setTime(d);
          break;
        }
      }
    }
    const nextIds = new Set(layers.map((l) => l.id));
    for (const [id, entry] of this.entries) {
      if (!nextIds.has(id)) {
        this.destroyEntry(entry);
        // A layer that left the project releases its COG source; a rebuild
        // (below) keeps it, which is the point of the cache.
        if (isCogLayer(entry.layer)) this.forgetCogSource(entry);
        this.entries.delete(id);
      }
    }

    // Tracks a create/rebuild of an imagery layer this pass (which re-appends it
    // to the top), so the reorder pass below runs even when the store id order
    // is unchanged.
    let imageryRebuilt = false;
    // Tile-backed vector layers are drawn by the shared MapLibre drape rather
    // than by an entry each (issue #2284).
    const draped = layers.filter(isDrapedLayer);
    if (this.syncDrape(draped)) imageryRebuilt = true;
    for (const layer of layers) {
      if (isDrapedLayer(layer) || !isSupported(layer)) {
        // A previously-supported layer that became unrenderable (e.g. its data
        // was cleared), or that now draws through the drape (a render-mode
        // switch keeps the id), is torn down.
        const stale = this.entries.get(layer.id);
        if (stale) {
          this.destroyEntry(stale);
          if (isCogLayer(stale.layer)) this.forgetCogSource(stale);
          this.entries.delete(layer.id);
        }
        continue;
      }

      const existing = this.entries.get(layer.id);
      if (!existing) {
        this.createEntry(layer);
        if (entryKind(layer) === "imagery") imageryRebuilt = true;
      } else if (needsRebuild(existing.layer, layer)) {
        this.destroyEntry(existing);
        this.entries.delete(layer.id);
        // A COG whose source moved (a re-read blob URL, an authoring swap)
        // leaves its old source behind unless something forgets it.
        if (
          isCogLayer(existing.layer) &&
          (!isCogLayer(layer) || cogSourceUrl(existing.layer) !== cogSourceUrl(layer))
        ) {
          this.forgetCogSource(existing);
        }
        this.createEntry(layer);
        if (entryKind(layer) === "imagery") imageryRebuilt = true;
      } else {
        existing.layer = layer;
        this.applyAppearance(existing);
      }
    }

    // addImageryProvider always appends to the top, so a rebuild/create re-adds
    // imagery above its store neighbours, and a panel reorder (which doesn't
    // rebuild) changes the intended order without touching the globe. Re-assert
    // store order by raising each imagery layer to the top in turn (the base
    // imagery, never raised, stays at the bottom) — but only when the order
    // could actually have changed. sync() also runs on unrelated changes (e.g.
    // an opacity drag), and each raiseToTop is O(n), so reordering every time
    // would be a needless O(n²) on that hot path.
    // Draped layers have no entry, yet the drape's stacking position among the
    // native imagery follows the store order too, so they join the key.
    const imageryOrder = layers
      .filter((l) => this.entries.get(l.id)?.kind === "imagery" || isDrapedLayer(l))
      .map((l) => l.id)
      .join("\n");
    if (imageryRebuilt || imageryOrder !== this.lastImageryOrder) {
      this.reorderImagery();
      this.lastImageryOrder = imageryOrder;
    }
    this.applyHighlight();
    this.watchCameraZoom();
  }

  destroy(): void {
    this.restoreHighlight();
    this.selection = null;
    for (const entry of this.entries.values()) this.destroyEntry(entry);
    this.entries.clear();
    if (this.drapeLayer) {
      const provider = this.drapeLayer.imageryProvider;
      this.viewer.imageryLayers.remove(this.drapeLayer, true);
      if (provider instanceof ProtocolImageryProvider) provider.destroy();
      this.drapeLayer = null;
    }
    this.drape?.destroy();
    this.drape = undefined;
    this.drapeKey = "";
    void this.cogTiler?.then((tiler) => tiler.clear()).catch(() => {});
    this.unwatchCamera?.();
    this.unwatchCamera = null;
  }

  /** Removes the camera listeners installed by {@link watchCameraZoom}, or null when none are. */
  private unwatchCamera: (() => void) | null = null;

  /**
   * Keep camera listeners installed exactly while some entry's filter reads
   * `["zoom"]`. MapLibre evaluates such a filter live; on the globe the filter
   * is re-run when the camera settles (`moveEnd`) or moves far enough to fire
   * `changed`, and {@link applyGeoJsonFilter} skips the work unless the integer
   * zoom actually crossed a level.
   */
  private watchCameraZoom(): void {
    let wanted = false;
    for (const entry of this.entries.values()) {
      if (entry.zoomFilter || entry.zoomStyle || entry.zoomCluster) {
        wanted = true;
        break;
      }
    }
    if (wanted === Boolean(this.unwatchCamera)) return;
    if (!wanted) {
      this.unwatchCamera?.();
      this.unwatchCamera = null;
      return;
    }
    const camera = this.viewer.camera as
      | { moveEnd?: CameraEvent; changed?: CameraEvent }
      | undefined;
    const events = [camera?.moveEnd, camera?.changed].filter((e): e is CameraEvent => Boolean(e));
    if (events.length === 0) return;
    const onMove = () => this.reapplyZoomFilters();
    for (const event of events) event.addEventListener(onMove);
    this.unwatchCamera = () => {
      for (const event of events) event.removeEventListener(onMove);
    };
  }

  /**
   * Re-run every zoom-dependent filter and restyle every zoom-dependent
   * symbology (metre-unit strokes, per-rule zoom ranges); renders only if
   * something actually changed.
   */
  private reapplyZoomFilters(): void {
    let changed = false;
    for (const entry of this.entries.values()) {
      if ((entry.kind !== "geojson" && entry.kind !== "points") || !entry.handle) continue;
      if (entry.zoomFilter) {
        const before = entry.appliedFilterKey;
        this.applyGeoJsonFilter(entry);
        if (entry.appliedFilterKey !== before) changed = true;
      }
      if (entry.zoomStyle) {
        const before = entry.appliedAlpha;
        if (entry.kind === "points") this.applyPointBatchStyle(entry);
        else this.applyGeoJsonStyle(entry);
        if (entry.appliedAlpha !== before) {
          changed = true;
          if (entry.kind === "geojson") this.bakeZoomMarkers(entry);
        }
      }
      if (entry.zoomCluster && entry.cluster && entry.plan) {
        entry.cluster.setEnabled(clusterActiveAtZoom(entry.plan, this.cameraZoom()));
      }
    }
    if (changed) this.viewer.scene?.requestRender?.();
  }

  /**
   * A marker colour can itself be zoom-dependent (a rule with a zoom range
   * compiles to a `["step", ["zoom"], …]` colour), so a zoom step may resolve
   * colours no sprite was baked for at load. Those entities fell back to the
   * base sprite in the restyle that just ran; bake the missing colours and
   * restyle once more when they land.
   */
  private bakeZoomMarkers(entry: LayerEntry): void {
    if (!entry.markerImages || !entry.resolver) return;
    const zoom = this.cameraZoom();
    // Both camera events can land after one zoom step; a bake already in
    // flight for this zoom covers the second. A further zoom step while a
    // bake runs queues behind it, so the same colour is never rasterised
    // twice and each completion restyles at most once.
    if (entry.markerBake && entry.markerBakeZoom === zoom) return;
    const { handle, resolver } = entry;
    const previous = entry.markerBake ?? Promise.resolve(false);
    entry.markerBakeZoom = zoom;
    const bake: Promise<boolean> = previous
      .then(() => (entry.cancelled ? false : this.prepareSymbolImages(entry, resolver, zoom)))
      .then((added) => {
        if (entry.markerBake === bake) entry.markerBake = undefined;
        if (!added || entry.cancelled || entry.handle !== handle) return false;
        entry.appliedAlpha = undefined;
        this.applyGeoJsonStyle(entry);
        this.viewer.scene?.requestRender?.();
        return true;
      });
    entry.markerBake = bake;
  }

  /**
   * The per-feature resolver for an entry, recompiled only when the style
   * *content* it reads changes. The store hands every edit a fresh style
   * object, so identity would recompile all channels on each opacity-slider
   * tick; the key is the rebuild signature plus the one in-place field the
   * resolver reads (the fill opacity), and a plain layer-opacity drag leaves
   * it untouched.
   */
  private resolverFor(entry: LayerEntry): FeatureStyleResolver {
    const style = entry.layer.style;
    const key = `${styleSignature(entry.layer)}|${style?.fillOpacity ?? ""}`;
    if (!entry.resolver || entry.resolverKey !== key) {
      entry.resolver = createFeatureStyleResolver(style);
      entry.resolverKey = key;
      entry.zoomStyle = entry.resolver.zoomDependent;
    }
    return entry.resolver;
  }

  /**
   * Rasterise the sprites a layer's symbology needs: one marker per distinct
   * marker colour resolved at `zoom` (capped, so a categorized field with
   * thousands of classes cannot bake thousands of canvases), the base marker
   * as the fallback for a colour past the cap or whose sprite failed, and the
   * fill pattern tile. Sprites already baked are kept, so a later call for
   * another zoom only adds the colours that zoom introduces. Both are async
   * (custom SVGs decode through an `Image`), which is why this runs at load
   * and on a zoom step rather than inside the synchronous restyle pass.
   * Resolves to whether any new sprite was added.
   */
  private async prepareSymbolImages(
    entry: LayerEntry,
    resolver: FeatureStyleResolver,
    zoom: number,
  ): Promise<boolean> {
    const style = { ...DEFAULT_LAYER_STYLE, ...entry.layer.style };
    const features = entry.layer.geojson?.features ?? [];
    const render = this.deps.renderMarker ?? renderMarkerCanvas;
    let added = false;
    if (style.markerEnabled) {
      const images = (entry.markerImages ??= new Map());
      const wanted = new Set<string>();
      if (!images.has("")) wanted.add("");
      for (const feature of features) {
        const type = feature.geometry?.type;
        if (type !== "Point" && type !== "MultiPoint") continue;
        const colour = resolver.resolveMarkerColor(feature, zoom);
        if (images.has(colour) || wanted.has(colour)) continue;
        // Check before adding, so the cap is the most sprites the layer holds.
        if (images.size + wanted.size >= MAX_MARKER_SPRITES) break;
        wanted.add(colour);
      }
      // The base sprite ("") is the layer's own marker colour, which is what
      // a flat marker style resolves every feature to; when that colour is
      // baked anyway, the fallback is an alias of it rather than a second
      // identical render (an SVG decode for custom shapes).
      const base = resolver.resolveMarkerColor(undefined, zoom);
      const aliasBase = wanted.has("") && (wanted.has(base) || images.has(base));
      if (aliasBase) wanted.delete("");
      // The colours are independent, so their (possibly SVG-decoding) renders
      // run together rather than one await at a time.
      const baked = await Promise.all(
        [...wanted].map(
          async (colour) =>
            [colour, await render(style, colour || undefined).catch(() => null)] as const,
        ),
      );
      for (const [colour, image] of baked) {
        if (!image || images.has(colour)) continue;
        images.set(colour, image);
        added = true;
      }
      if (aliasBase && !images.has("")) {
        const image = images.get(base);
        if (image) {
          images.set("", image);
          added = true;
        }
      }
    }
    if (style.fillPattern !== "none" && entry.patternImage === undefined) {
      const renderPattern = this.deps.renderFillPattern ?? renderFillPatternCanvas;
      entry.patternImage = await renderPattern(style).catch(() => null);
    }
    return added;
  }

  /**
   * Draw points the way the 2D map does — a circle sized by the layer's
   * `circleRadius` — instead of the pin billboard `GeoJsonDataSource` creates,
   * unless the layer renders markers, in which case the billboard stays and
   * receives its sprite in the restyle pass.
   */
  private installPointGraphics(
    entry: LayerEntry,
    dataSource: DataSource,
    clampToGround: boolean,
  ): void {
    const { Cesium, viewer } = this;
    const style = { ...DEFAULT_LAYER_STYLE, ...entry.layer.style };
    if (style.markerEnabled && entry.markerImages?.size) return;
    const heightReference = (
      clampToGround
        ? (Cesium.HeightReference?.CLAMP_TO_GROUND ?? 1)
        : (Cesium.HeightReference?.NONE ?? 0)
    ) as number;
    for (const entity of dataSource.entities.values) {
      if (!entity.billboard || entity.point) continue;
      const graphics = {
        pixelSize: style.circleRadius * 2,
        color: Cesium.Color.fromCssColorString(style.fillColor),
        outlineColor: Cesium.Color.fromCssColorString(style.strokeColor),
        outlineWidth: style.strokeWidth,
        heightReference,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      };
      entity.billboard = undefined;
      entity.point = (
        Cesium.PointGraphics ? new Cesium.PointGraphics(graphics as never) : graphics
      ) as never;
    }
    viewer.scene?.requestRender?.();
  }

  /**
   * Map the layer's `minZoom` / `maxZoom` onto one `DistanceDisplayCondition`
   * shared by every entity of the layer, evaluated per frame against the
   * current canvas size and scene mode (the way the labeler does), so the
   * layer appears and disappears at the same zoom levels as on the 2D map.
   * The latitude the zoom-to-distance conversion needs is the layer's
   * extent centre — one condition per layer, not one per feature.
   */
  private installZoomRange(entry: LayerEntry, dataSource: DataSource): void {
    const { Cesium, viewer } = this;
    const style = { ...DEFAULT_LAYER_STYLE, ...entry.layer.style };
    const minZoom = Number.isFinite(style.minZoom) ? style.minZoom : 0;
    const maxZoom = Number.isFinite(style.maxZoom) ? style.maxZoom : 24;
    if (minZoom <= 0 && maxZoom >= 24) return;
    if (!Cesium.CallbackProperty || !Cesium.DistanceDisplayCondition) return;
    const bounds = getLayerBounds(entry.layer);
    const latitude = bounds ? (bounds[1] + bounds[3]) / 2 : 0;
    let conditionKey = "";
    let near = 0;
    let far = Number.POSITIVE_INFINITY;
    const displayKey = () => {
      const canvas = viewer.scene.canvas;
      return `${canvas.clientWidth}x${canvas.clientHeight}:${viewer.scene.mode}`;
    };
    const condition = new Cesium.CallbackProperty((_time, result?: DistanceDisplayCondition) => {
      const key = displayKey();
      if (key !== conditionKey) {
        conditionKey = key;
        near = maxZoom >= 24 ? 0 : zoomToDisplayDistance(Cesium, viewer, maxZoom, latitude);
        far =
          minZoom <= 0
            ? Number.POSITIVE_INFINITY
            : zoomToDisplayDistance(Cesium, viewer, minZoom, latitude);
      }
      const out = result ?? new Cesium.DistanceDisplayCondition();
      out.near = near;
      out.far = far;
      return out;
    }, false);
    for (const entity of dataSource.entities.values) {
      for (const key of ["polygon", "polyline", "point", "billboard"] as const) {
        const graphics = entity[key] as { distanceDisplayCondition?: unknown } | undefined;
        if (graphics) graphics.distanceDisplayCondition = condition;
      }
    }
  }

  /** The camera's integer MapLibre zoom, as `["zoom"]` filters evaluate at integer levels. */
  private cameraZoom(): number {
    try {
      const zoom = this.readZoom();
      return Number.isFinite(zoom) ? Math.floor(zoom) : 0;
    } catch {
      return 0;
    }
  }

  private reorderImagery(): void {
    for (const layer of this.currentLayers) {
      const entry = this.entries.get(layer.id);
      if (entry?.kind === "imagery" && entry.handle) {
        this.viewer.imageryLayers.raiseToTop(entry.handle as ImageryLayer);
      }
      // The drape stacks where its topmost layer sits in the store order; the
      // draped layers keep their order among themselves inside the drape.
      if (this.drapeLayer && layer.id === this.drapeTopId) {
        this.viewer.imageryLayers.raiseToTop(this.drapeLayer);
      }
    }
  }

  /** The hidden MapLibre map draping tile-backed vector layers, once one is needed. */
  private drape: MapLibreDrape | null | undefined;
  /** The imagery layer the drape's tiles land on. */
  private drapeLayer: ImageryLayer | null = null;
  private drapeKey = "";
  private drapeTopId: string | null = null;
  private drapeError: string | null = null;

  /**
   * Reconcile the drape with the store's draped layers. Returns whether the
   * imagery stack changed (a new imagery layer was added), so the caller
   * re-asserts the order.
   */
  private syncDrape(draped: GeoLibreLayer[]): boolean {
    const key = draped.length ? drapeSignature(draped) : "";
    if (key === this.drapeKey) return false;
    this.drapeKey = key;
    this.drapeTopId = draped.length ? draped[draped.length - 1].id : null;
    const removed = this.drapeLayer !== null;
    if (this.drapeLayer) {
      // As in destroyEntry: Cesium destroys the layer but not the provider,
      // whose abort controller cancels the tile renders still queued.
      const provider = this.drapeLayer.imageryProvider;
      this.viewer.imageryLayers.remove(this.drapeLayer, true);
      if (provider instanceof ProtocolImageryProvider) provider.destroy();
      this.drapeLayer = null;
    }
    if (!draped.length) {
      this.drape?.destroy();
      this.drape = undefined;
      this.drapeError = null;
      return removed;
    }
    if (this.drape === undefined) {
      this.drape = (this.deps.createDrape ?? (() => MapLibreDrape.create()))();
      this.drapeError = this.drape ? null : "the globe could not start a MapLibre drape";
    }
    if (!this.drape) {
      // Leave the slot empty so the next change to a draped layer retries the
      // creation; the error stands until a retry succeeds.
      this.drape = undefined;
      return false;
    }
    // A new provider per change: Cesium caches the tiles it has, so restyling
    // in place would leave stale tiles on screen.
    this.drape.sync(draped);
    const layer = this.viewer.imageryLayers.addImageryProvider(
      this.drape.createProvider(this.Cesium),
    );
    this.drapeLayer = layer;
    return true;
  }

  private createEntry(layer: GeoLibreLayer): void {
    const kind = entryKind(layer);
    const entry: LayerEntry = { kind, layer, handle: null, cancelled: false };
    this.entries.set(layer.id, entry);
    if (kind === "imagery") void this.createImagery(entry);
    else if (kind === "geojson") void this.createGeoJson(entry);
    else if (kind === "pointcloud") void this.createPointCloud(entry);
    else if (kind === "points") this.createPointBatch(entry);
    else void this.createTileset(entry);
  }

  /**
   * Decode a COPC point cloud in the browser and draw it as primitives
   * (issue #2285). The download is bounded (see `cesium-point-cloud.ts`) and
   * abortable, so removing the layer mid-load wastes no further bandwidth.
   */
  private async createPointCloud(entry: LayerEntry): Promise<void> {
    const { Cesium, viewer } = this;
    const url = pointCloudUrl(entry.layer);
    if (!url) return;
    const abort = new AbortController();
    entry.abort = abort;
    try {
      const cloud = await loadCopcPointCloud(url, {
        ...this.deps.copcOptions,
        signal: abort.signal,
      });
      if (entry.cancelled) return;
      const collection = buildPointCloudCollection(
        Cesium,
        cloud,
        this.effectiveOpacity(entry),
        Number(entry.layer.source.altitudeOffset),
      );
      viewer.scene.primitives.add(collection);
      entry.handle = collection;
      entry.appliedAlpha = String(this.effectiveOpacity(entry));
      this.applyAppearance(entry);
      if (cloud.truncated)
        console.info(
          `[GeoLibre] "${
            entry.layer.name
          }" on the globe shows a ${cloud.count.toLocaleString()}-point preview of the point cloud`,
        );
    } catch (error) {
      if (entry.cancelled) return;
      entry.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * The primitive path for large point-only layers (issue #2282): one
   * `PointPrimitiveCollection` built synchronously from the features, with
   * each primitive's `id` carrying the feature reference so picking and
   * highlighting work as they do for entities.
   */
  private createPointBatch(entry: LayerEntry): void {
    const { Cesium, viewer } = this;
    try {
      const resolver = this.resolverFor(entry);
      const zoom = resolver.zoomDependent ? this.cameraZoom() : 0;
      // The same ground-clamping decision the entity path makes: extruded or
      // 3D-elevated layers keep their heights, everything else sits on terrain.
      const style = entry.layer.style ?? {};
      const clampToGround = !(
        style.extrusionEnabled ||
        style.elevation3dEnabled ||
        geojsonHasZCoordinates(entry.layer.geojson)
      );
      const collection = buildPointBatch(
        Cesium,
        entry.layer,
        resolver,
        this.effectiveOpacity(entry),
        zoom,
        { scene: viewer.scene, clampToGround },
      );
      viewer.scene.primitives.add(collection);
      entry.handle = collection;
      entry.plan = planPointRendering(entry.layer);
      // The build already applied the current opacity and symbols; seed the
      // restyle key so the appearance pass below only applies visibility and
      // the filter.
      entry.appliedAlpha = this.pointStyleKey(entry, zoom);
      this.applyAppearance(entry);
    } catch (error) {
      entry.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Cluster a point-only layer whose style asks for it (issue #2282) through
   * the data source's `EntityCluster`, styled like the 2D map's cluster
   * bubbles, and switched off past `clusterMaxZoom` as the camera zooms in.
   */
  private installClustering(entry: LayerEntry, dataSource: DataSource): void {
    const plan = planPointRendering(entry.layer);
    entry.plan = plan;
    if (!plan.cluster || !dataSource.clustering?.clusterEvent) return;
    entry.cluster = configureClustering(this.Cesium, dataSource, plan, () =>
      clusterAppearance(entry.layer, this.effectiveOpacity(entry)),
    );
    entry.zoomCluster = true;
    entry.cluster.setEnabled(clusterActiveAtZoom(plan, this.cameraZoom()));
    this.watchCameraZoom();
  }

  private pointStyleKey(entry: LayerEntry, zoom: number): string {
    return `${this.effectiveOpacity(entry)}|${zoom}|${entry.resolverKey ?? ""}`;
  }

  /** Re-colour a batched point layer in place (opacity, fill opacity, zoom-dependent sizes). */
  private applyPointBatchStyle(entry: LayerEntry): void {
    const collection = entry.handle as PointPrimitiveCollection | null;
    if (!collection) return;
    const resolver = this.resolverFor(entry);
    const zoom = resolver.zoomDependent ? this.cameraZoom() : 0;
    const key = this.pointStyleKey(entry, zoom);
    if (entry.appliedAlpha === key) return;
    entry.appliedAlpha = key;
    restylePointBatch(
      this.Cesium,
      collection,
      entry.layer,
      resolver,
      this.effectiveOpacity(entry),
      zoom,
    );
  }

  private async createImagery(entry: LayerEntry): Promise<void> {
    const { Cesium, viewer } = this;
    const layer = entry.layer;
    try {
      let provider: ImageryProvider | undefined;
      let isAsync = false;
      const headers = layer.source.requestHeaders as Record<string, string> | undefined;
      const hasHeaders = Boolean(headers && Object.keys(headers).length);
      // A tile template wins over the capabilities metadata: it needs no
      // provider-side matrix-set negotiation.
      const wmtsCaps =
        layer.type === "wmts" && !firstTile(layer) ? wmtsCapabilities(layer) : undefined;
      // Credentials (request headers, an ArcGIS token) never go out over
      // plaintext — loopback excepted, so a local dev tile server still works.
      // Residual exposure: Cesium.Resource issues these through XHR/fetch, which
      // give no redirect control, so a service that 3xx-redirects cross-origin
      // still sees non-Authorization headers replayed (the browser strips only
      // Authorization). CORS preflight means the redirect target must opt into
      // the header by name, and the endpoint is user-configured, so this is
      // accepted rather than proxied.
      // Refusing the whole layer beats quietly stripping them: an
      // unauthenticated request would look like a working layer that renders
      // nothing. The outer catch turns this into the same best-effort skip a
      // failing provider already gets.
      const requireSecure = (url: string, what: string) => {
        if (allowsCredentials(url)) return;
        console.warn(
          `[GeoLibre] skipping "${layer.name}" on the globe: ${what} cannot be sent over ${url}`,
        );
        throw new Error("credentials require https");
      };
      // Every provider's `url` option is typed `Resource | string`, so the
      // union is passed through as-is rather than cast.
      const makeResource = (url: string): string | Resource => {
        if (!hasHeaders) return url;
        requireSecure(url, "request headers");
        return new Cesium.Resource({ url, headers });
      };

      if (
        layer.type === "raster" &&
        layer.metadata?.sourceKind === ARCGIS_MAP_SERVICE_KIND &&
        str(layer.sourcePath)
      ) {
        isAsync = true;
        const url = String(layer.sourcePath);
        const resource = makeResource(url);
        const sublayers = str(layer.metadata?.arcgisSublayers);
        // arcgis-layer.ts writes a bare id list ("0,2,5"); the `show:` prefix only
        // ever appears in the tile URL's query string. Stripping it here is purely
        // defensive, for a hand-authored or MCP project that copies the ArcGIS
        // `layers=show:0,1` param form straight into the metadata field.
        const cleanLayers = sublayers?.replace(/^show:/i, "").trim() || undefined;
        const options: Record<string, unknown> = {};
        if (cleanLayers) options.layers = cleanLayers;
        const token = arcgisToken(layer);
        if (token) {
          requireSecure(url, "an access token");
          options.token = token;
        }

        provider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(resource, options);
      } else if (layer.type === "image" && str(layer.source.url)) {
        isAsync = true;
        const url = String(layer.source.url);
        const bounds = imageBounds(layer);
        if (!bounds) throw new Error("the image layer has no usable bounds");
        const resource = makeResource(url);
        const rectangle = Cesium.Rectangle.fromDegrees(bounds[0], bounds[1], bounds[2], bounds[3]);
        const options = { rectangle };

        provider = await Cesium.SingleTileImageryProvider.fromUrl(resource, options);
      } else if (layer.type === "wms" && str(layer.source.url)) {
        const url = String(layer.source.url);
        const resource = makeResource(url);
        provider = new Cesium.WebMapServiceImageryProvider({
          url: resource,
          layers: String(layer.source.layers ?? ""),
          parameters: {
            transparent: layer.source.transparent !== false,
            format: str(layer.source.format) ?? "image/png",
            styles: str(layer.source.styles) ?? "",
            version: str(layer.source.version) ?? "1.1.1",
          },
        });
      } else if (wmtsCaps) {
        const url = wmtsCaps.url;
        const resource = makeResource(url);
        const maxLevel = Number(layer.source.maxzoom);
        const minLevel = Number(layer.source.minzoom);
        // No UI writes `tilingScheme`/`tileMatrixLabels` today; they come from a
        // hand-authored or MCP-generated `.geolibre.json` (`source` is a
        // free-form record), which is how non-default WMTS matrix sets are
        // expressed. Left in so those projects render on the globe.
        const schemeId = str(layer.source.tilingScheme);
        let tilingScheme: TilingScheme | undefined;
        if (schemeId) {
          if (schemeId === "GeographicTilingScheme")
            tilingScheme = new Cesium.GeographicTilingScheme();
          else if (schemeId === "WebMercatorTilingScheme")
            tilingScheme = new Cesium.WebMercatorTilingScheme();
          else {
            // Warn rather than bail silently: the layer still reads as
            // globe-supported in the layer menu, so a mute skip looks like a
            // broken renderer.
            console.warn(
              `[GeoLibre] skipping "${layer.name}" on the globe: unsupported WMTS tiling scheme "${schemeId}"`,
            );
            throw new Error(`unsupported WMTS tiling scheme "${schemeId}"`);
          }
        }
        const labels = layer.source.tileMatrixLabels;
        const tileMatrixLabels = Array.isArray(labels) ? labels.map(String) : undefined;

        provider = new Cesium.WebMapTileServiceImageryProvider({
          url: resource,
          layer: wmtsCaps.layer,
          style: str(layer.source.style) ?? str(layer.source.styles) ?? "",
          // Cesium's own WebMapTileServiceImageryProvider default. The WMS
          // branch above defaults to image/png instead because WMS overlays are
          // usually drawn transparent over the globe, while WMTS sets are
          // typically opaque base imagery — the asymmetry is deliberate.
          format: str(layer.source.format) ?? "image/jpeg",
          tileMatrixSetID: wmtsCaps.tileMatrixSetID,
          maximumLevel: Number.isFinite(maxLevel) ? maxLevel : undefined,
          minimumLevel: Number.isFinite(minLevel) ? minLevel : undefined,
          tilingScheme,
          tileMatrixLabels,
        });
      } else if (isCogLayer(layer)) {
        // The WASM tiler renders the tiles itself (issue #2283), so neither
        // request headers nor a Resource apply: the COG is range-read by the
        // tiler from the same URL the raster control opened it from.
        isAsync = true;
        provider = await createCogImageryProvider(Cesium, await this.loadCogTiler(), layer);
      } else if (layer.type === "pmtiles" && pmtilesArchiveUrl(layer)) {
        // Raster PMTiles ride the shared `pmtiles://` protocol the 2D map
        // registers, through the same archive object, so a local (in-memory)
        // archive and a remote one both answer. The header bounds the tile
        // requests to what the archive actually holds.
        isAsync = true;
        const url = pmtilesArchiveUrl(layer)!;
        const header = await (this.deps.readPMTilesHeader ?? readSharedPMTilesHeader)(url);
        if (entry.cancelled) return;
        const rectangle =
          header &&
          [header.minLon, header.minLat, header.maxLon, header.maxLat].every(Number.isFinite)
            ? webMercatorRectangle(Cesium, [
                header.minLon,
                header.minLat,
                header.maxLon,
                header.maxLat,
              ])
            : undefined;
        provider = new ProtocolImageryProvider(Cesium, {
          template: `${url}/{z}/{x}/{y}`,
          rectangle,
          minimumLevel: Number.isFinite(header?.minZoom) ? header?.minZoom : undefined,
          maximumLevel: Number.isFinite(header?.maxZoom) ? header?.maxZoom : undefined,
          credit: str(layer.source.attribution),
        });
      } else {
        const url = firstTile(layer);
        if (!url) throw new Error("no tile URL template");
        const maxLevel = Number(layer.source.maxzoom);
        const minLevel = Number(layer.source.minzoom);
        const scheme = protocolScheme(url);
        if (scheme) {
          // A custom-protocol template (local MBTiles, the desktop's native
          // XYZ/WMS fetcher, a KML super-overlay, the COG DEM): the tiles come
          // from the handler MapLibre registered, not from HTTP. An
          // unregistered scheme is refused rather than rendered blank, so the
          // layer reads as failed instead of as a working layer drawing
          // nothing.
          if (!hasRegisteredProtocol(scheme))
            throw new Error(`no MapLibre protocol handler registered for "${scheme}://"`);
          const bounds = layer.source.bounds;
          const rectangle =
            Array.isArray(bounds) &&
            bounds.length === 4 &&
            bounds.every((v) => typeof v === "number" && Number.isFinite(v))
              ? webMercatorRectangle(Cesium, bounds as [number, number, number, number])
              : undefined;
          // The tile size drives Cesium's level selection the way it drives
          // MapLibre's, so a 512 px source fetches the same zoom on both.
          const tileSize = Number(layer.source.tileSize);
          const tileWidth = Number.isFinite(tileSize) && tileSize > 0 ? tileSize : undefined;
          provider = new ProtocolImageryProvider(Cesium, {
            template: url,
            scheme: layer.source.scheme === "tms" ? "tms" : "xyz",
            tileWidth,
            tileHeight: tileWidth,
            rectangle,
            maximumLevel: Number.isFinite(maxLevel) ? maxLevel : undefined,
            minimumLevel: Number.isFinite(minLevel) ? minLevel : undefined,
            credit: str(layer.source.attribution),
          });
        } else {
          const resource = makeResource(url);
          provider = new Cesium.UrlTemplateImageryProvider({
            url: resource,
            maximumLevel: Number.isFinite(maxLevel) ? maxLevel : undefined,
            minimumLevel: Number.isFinite(minLevel) ? minLevel : undefined,
          });
        }
      }

      if (!provider || entry.cancelled) {
        // Reachable: the branches above await (the COG tiler, the PMTiles
        // header, ArcGIS/single-tile fromUrl), and the layer can be removed or
        // rebuilt in that window. Nothing has requested a tile yet, but the
        // provider still owns an abort controller, so tear it down rather than
        // dropping it.
        if (provider instanceof ProtocolImageryProvider) provider.destroy();
        // Redundant today, and deliberately kept. A removal that races the
        // (multi-megabyte) tiler import runs forgetCogSource against a cache
        // this URL has not reached yet, so it only works because that forget is
        // itself deferred through `this.cogTiler.then(...)` while openCog is
        // reached synchronously from the earlier-queued continuation here: the
        // open always lands first and the forget always finds it. Nothing
        // enforces that ordering, and an await added before openCog in
        // createCogImageryProvider would silently turn it into a leaked
        // CogSource, so forget once more where the open has certainly happened.
        if (isCogLayer(layer)) this.forgetCogSource(entry);
        return;
      }
      // addImageryProvider appends above the base imagery (and earlier store
      // layers), so store order maps to Cesium's bottom-to-top stacking.
      const imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
      if (entry.cancelled) {
        // Unreachable today: nothing awaits between the check above and here,
        // so `cancelled` cannot flip. Kept as the guard it was written to be,
        // and tearing the provider down the way destroyEntry does, so adding an
        // await in between cannot silently start leaking a bridged provider's
        // abort controller and the handler requests still in flight.
        viewer.imageryLayers.remove(imageryLayer, true);
        if (provider instanceof ProtocolImageryProvider) provider.destroy();
        return;
      }
      this.imageryRefs.set(imageryLayer, layer.id);
      entry.handle = imageryLayer;
      this.applyAppearance(entry);
      if (isAsync) {
        // Unlike sync()'s reorder this one is unguarded, since the store order
        // key can't tell whether an async layer has landed yet. Each resolve
        // therefore costs its own O(n) raiseToTop sweep, so a project loading
        // many ArcGIS/image layers at once pays O(n^2) overall. Fine for the
        // handful a project typically has; worth coalescing into one deferred
        // reorder if that stops being true.
        this.reorderImagery();
      }
    } catch (error) {
      // A provider that throws synchronously (e.g. malformed params) or rejects
      entry.loadError = error instanceof Error ? error.message : String(error);
      // should not abort the sync pass; mirror createGeoJson/createTileset's best-effort.
      // The entry stays registered with a null handle rather than being deleted:
      // sync() re-runs on every unrelated store change (an opacity drag, a
      // reorder), so a deleted entry would be recreated — re-issuing the failing
      // request and re-warning — on every pass. Retrying is left to needsRebuild,
      // i.e. an actual change to this layer's source.
      if (this.entries.get(entry.layer.id) === entry) {
        entry.cancelled = true;
        if (entry.handle) {
          viewer.imageryLayers.remove(entry.handle as ImageryLayer, true);
          entry.handle = null;
        }
      }
    }
  }

  private async createGeoJson(entry: LayerEntry): Promise<void> {
    const { Cesium, viewer } = this;
    const layer = entry.layer;
    if (!layer.geojson) return;
    const style = layer.style ?? {};
    const fill = Cesium.Color.fromCssColorString(style.fillColor ?? "#3b82f6");
    const stroke = Cesium.Color.fromCssColorString(style.strokeColor ?? "#1e40af");
    // Fold the layer + fill opacity into the fill colour (a GeoJsonDataSource has
    // no global alpha). A later opacity change re-applies this alpha in place
    // (applyGeoJsonStyle) rather than reloading the whole data source.
    const fillAlpha = (style.fillOpacity ?? 0.6) * layer.opacity;

    const has3dElevation = Boolean(
      style.elevation3dEnabled || geojsonHasZCoordinates(layer.geojson),
    );
    const clampToGround = !(style.extrusionEnabled || has3dElevation);

    const verticalScale = Number.isFinite(style.elevation3dVerticalScale)
      ? (style.elevation3dVerticalScale as number)
      : 1;
    const offset = Number.isFinite(style.elevation3dOffset)
      ? (style.elevation3dOffset as number)
      : 0;
    const sourceGeoJson = has3dElevation
      ? transformGeojsonElevation(layer.geojson, verticalScale, offset)
      : layer.geojson;

    try {
      // Cesium splits multipart geometries into several entities. A private
      // property survives that split; feature ids alone do not (Cesium suffixes them).
      const indexKey = "__geolibre_cesium_feature_index";
      const data = {
        ...sourceGeoJson,
        features: sourceGeoJson.features.map((feature, index) => ({
          ...feature,
          id: JSON.stringify([layer.id, index]),
          properties: { ...feature.properties, [indexKey]: index },
        })),
      };
      const dataSource = await Cesium.GeoJsonDataSource.load(data, {
        stroke,
        strokeWidth: style.strokeWidth ?? 2,
        fill: fill.withAlpha(fillAlpha),
        markerColor: Cesium.Color.fromCssColorString(style.markerColor ?? "#3b82f6"),
        clampToGround,
      });
      if (entry.cancelled) return;
      await viewer.dataSources.add(dataSource);
      if (entry.cancelled) {
        viewer.dataSources.remove(dataSource, true);
        return;
      }
      // A multipart feature arrives as several entities sharing one index; it
      // gets one label, on its largest part (pickLabelPart), not one per part.
      // The grouping (and pickLabelPart's geometry math) is skipped outright
      // when the layer has no labels, so an unlabelled boundary set pays nothing.
      const labelsEnabled = Boolean({ ...DEFAULT_LAYER_STYLE.labels, ...style.labels }.enabled);
      const labelEntity = labelsEnabled ? createCesiumLabeler(Cesium, viewer, layer) : null;
      const parts = new Map<number, Entity[]>();
      for (const entity of dataSource.entities.values) {
        const propIndex = entity.properties?.[indexKey];
        const index =
          typeof propIndex?.getValue === "function"
            ? propIndex.getValue(viewer.clock?.currentTime)
            : propIndex;
        if (Number.isInteger(index)) {
          this.featureRefs.set(entity, { layerId: layer.id, index });
          if (!labelEntity) continue;
          const group = parts.get(index);
          if (group) group.push(entity);
          else parts.set(index, [entity]);
        }
      }
      if (labelEntity)
        for (const [index, entities] of parts)
          labelEntity(pickLabelPart(Cesium, viewer, entities), index);
      // Per-feature symbology (issue #2278): the resolver evaluates the same
      // expressions the 2D map paints with, and the sprites it needs (marker
      // shapes per classified colour, the fill pattern tile) are rasterised
      // once per layer before the first restyle pass bakes them in.
      const resolver = this.resolverFor(entry);
      await this.prepareSymbolImages(
        entry,
        resolver,
        resolver.zoomDependent ? this.cameraZoom() : 0,
      );
      if (entry.cancelled) return;
      this.installPointGraphics(entry, dataSource, clampToGround);
      this.installZoomRange(entry, dataSource);
      this.installClustering(entry, dataSource);
      entry.handle = dataSource;
      // applyAppearance → applyGeoJsonStyle fades every entity kind (fill,
      // stroke, marker) by the layer opacity right after load, so points/lines
      // match the 2D map instead of rendering fully opaque.
      this.applyAppearance(entry);

      const heightRef = (Cesium.HeightReference?.RELATIVE_TO_GROUND ?? 2) as number;
      const ConstantProperty = (Cesium as { ConstantProperty?: new (v: unknown) => unknown })
        .ConstantProperty;
      const ColorMaterialProperty = (
        Cesium as {
          ColorMaterialProperty?: new (c: unknown) => unknown;
        }
      ).ColorMaterialProperty;
      const makeProp = (v: unknown) => (ConstantProperty ? new ConstantProperty(v) : v);
      const makeMat = (c: unknown) =>
        ColorMaterialProperty ? new ColorMaterialProperty(c) : { color: c };
      // Cesium flags a polygon whose ring carries Z as perPositionHeight and then
      // ignores height/heightReference on it (with a one-time console warning),
      // keeping each vertex's own ellipsoid height. Only flat polygons take the
      // terrain-relative references.
      // Highest Z on a polygon feature's rings (0 when none carries a height).
      const ringTopAltitude = (feature: Feature | null): number => {
        const geometry = feature?.geometry;
        const polygons =
          geometry?.type === "Polygon"
            ? [geometry.coordinates]
            : geometry?.type === "MultiPolygon"
              ? geometry.coordinates
              : [];
        let top = Number.NEGATIVE_INFINITY;
        for (const rings of polygons)
          for (const ring of rings)
            for (const position of ring) {
              const z = position[2];
              if (typeof z === "number" && Number.isFinite(z) && z > top) top = z;
            }
        return Number.isFinite(top) ? top : 0;
      };
      const perPositionHeight = (polygon: { perPositionHeight?: unknown }): boolean => {
        const prop = polygon.perPositionHeight as
          | { getValue?: (time: unknown) => unknown }
          | boolean
          | undefined;
        return Boolean(
          typeof prop === "object" && typeof prop.getValue === "function"
            ? prop.getValue(viewer.clock?.currentTime)
            : prop,
        );
      };

      if (style.extrusionEnabled) {
        const heightProp = style.extrusionHeightProperty?.trim() || "height";
        const heightScale = Number.isFinite(style.extrusionHeightScale)
          ? (style.extrusionHeightScale as number)
          : 1;
        const base = Number.isFinite(style.extrusionBase) ? (style.extrusionBase as number) : 0;
        const extColorStr = style.extrusionColor || style.fillColor || "#3b82f6";
        const extOpacity =
          (Number.isFinite(style.extrusionOpacity) ? (style.extrusionOpacity as number) : 0.8) *
          layer.opacity;

        let heightEvaluator: ((f: Feature) => unknown) | undefined;
        if (style.extrusionAdvancedStyleEnabled && style.extrusionHeightExpression) {
          const res = compileFeatureExpression(style.extrusionHeightExpression, {
            expectedType: "number",
          });
          if (res.ok && res.evaluate) heightEvaluator = res.evaluate;
        }

        let colorEvaluator: ((f: Feature) => unknown) | undefined;
        if (style.extrusionAdvancedStyleEnabled && style.extrusionColorExpression) {
          const res = compileFeatureExpression(style.extrusionColorExpression, {
            expectedType: "color",
          });
          if (res.ok && res.evaluate) colorEvaluator = res.evaluate;
        }

        // Parsed once: a full 3D-buildings layer would otherwise re-parse the
        // same CSS string per polygon. withAlpha() below returns a fresh Color.
        const baseColor = Cesium.Color.fromCssColorString(extColorStr);
        const features = sourceGeoJson.features;
        for (const entity of dataSource.entities.values) {
          if (!entity.polygon) continue;
          const propIndex = entity.properties?.[indexKey];
          const index =
            typeof propIndex?.getValue === "function"
              ? propIndex.getValue(viewer.clock?.currentTime)
              : propIndex;
          const feat = Number.isInteger(index) && features ? features[index] : null;

          let rawHeight: unknown;
          if (feat && heightEvaluator) {
            try {
              rawHeight = heightEvaluator(feat);
            } catch {
              rawHeight = feat.properties?.[heightProp];
            }
          } else if (feat) {
            rawHeight = feat.properties?.[heightProp];
          } else {
            const prop = entity.properties?.[heightProp];
            rawHeight =
              typeof prop?.getValue === "function"
                ? prop.getValue(viewer.clock?.currentTime)
                : prop;
          }

          const num =
            typeof rawHeight === "number" && Number.isFinite(rawHeight)
              ? rawHeight
              : Number(rawHeight);
          const height = Number.isFinite(num) ? num : 0;
          // Never below the base: a negative height property or expression would
          // otherwise put the roof under the floor.
          const relativeTop = Math.max(base, height * heightScale + base);
          // With perPositionHeight Cesium takes each vertex's own height as the
          // base but reads extrudedHeight as an absolute altitude, so lift the
          // roof by the ring's highest vertex; otherwise it would extrude down
          // to `relativeTop` metres above the ellipsoid.
          const extrudedHeight = perPositionHeight(entity.polygon)
            ? ringTopAltitude(feat) + relativeTop
            : relativeTop;

          let resolvedColor = baseColor;
          if (feat && colorEvaluator) {
            try {
              const colVal = colorEvaluator(feat);
              if (typeof colVal === "string") {
                resolvedColor = Cesium.Color.fromCssColorString(colVal);
              } else if (
                colVal &&
                typeof (colVal as { toString?: () => string }).toString === "function"
              ) {
                resolvedColor = Cesium.Color.fromCssColorString(
                  (colVal as { toString: () => string }).toString(),
                );
              }
            } catch {
              // fallback to extColorStr
            }
          }

          entity.polygon.extrudedHeight = makeProp(extrudedHeight) as never;
          if (!perPositionHeight(entity.polygon)) {
            entity.polygon.height = makeProp(base) as never;
            entity.polygon.heightReference = makeProp(heightRef) as never;
            entity.polygon.extrudedHeightReference = makeProp(heightRef) as never;
          }
          entity.polygon.material = makeMat(resolvedColor.withAlpha(extOpacity)) as never;
        }
      }
      // Runs alongside extrusion too: a collection mixing extruded buildings
      // with Z-carrying points/lines loads unclamped (clampToGround is false
      // whenever either applies), so those entities still need their
      // terrain-relative reference; the polygons were handled above.
      if (has3dElevation) {
        for (const entity of dataSource.entities.values) {
          if (entity.polygon && !style.extrusionEnabled && !perPositionHeight(entity.polygon)) {
            entity.polygon.heightReference = makeProp(heightRef) as never;
          }
          if (entity.billboard) {
            entity.billboard.heightReference = makeProp(heightRef) as never;
          }
          if (entity.point) {
            entity.point.heightReference = makeProp(heightRef) as never;
          }
          if (entity.polyline) {
            (entity.polyline as { clampToGround?: unknown }).clampToGround = makeProp(false);
          }
        }
      }

      this.restoreHighlight();
      this.applyHighlight();
    } catch (error) {
      // A malformed FeatureCollection should not break the whole sync.
      entry.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  private async createTileset(entry: LayerEntry): Promise<void> {
    const { Cesium, viewer } = this;
    const layer = entry.layer;
    const url = tilesetUrl(layer);
    if (!url) return;
    // Google Photorealistic tiles strip their X-GOOG-API-KEY from the store, so
    // resolve it back (from runtime env) exactly as the 2D render path does —
    // otherwise the tileset would silently 401/403 and never render on the globe.
    const headers = resolveThreeDTilesRequestHeaders(
      url,
      layer.source.requestHeaders as Record<string, string> | undefined,
    );
    const resource =
      headers && Object.keys(headers).length ? new Cesium.Resource({ url, headers }) : url;
    try {
      if (isI3sLayer(layer)) {
        // An ArcGIS scene layer: Cesium's own I3S provider converts the
        // scene service into 3D Tiles on the fly (issue #2285), no loaders.gl.
        const provider = await Cesium.I3SDataProvider.fromUrl(resource, {
          cesium3dTilesetOptions: {},
        });
        if (entry.cancelled) {
          provider.destroy();
          return;
        }
        viewer.scene.primitives.add(provider);
        const offset = Number(layer.source.altitudeOffset);
        for (const tileset of i3sTilesets(provider)) this.applyTilesetAltitude(tileset, offset);
        entry.handle = provider;
        this.applyAppearance(entry);
        return;
      }
      const tileset = await Cesium.Cesium3DTileset.fromUrl(resource, {});
      if (entry.cancelled) {
        tileset.destroy();
        return;
      }
      viewer.scene.primitives.add(tileset);
      this.applyTilesetAltitude(tileset, Number(layer.source.altitudeOffset));
      if (layer.type === "lidar" && tileset.pointCloudShading) {
        // Eye-dome lighting and attenuation: the reading aids the 2D LiDAR
        // control's dynamic mode gives, native in Cesium's point-cloud shader.
        tileset.pointCloudShading.attenuation = true;
        tileset.pointCloudShading.eyeDomeLighting = true;
      }
      entry.handle = tileset;
      this.applyAppearance(entry);
    } catch (error) {
      // A tileset that fails to load should not break the whole sync.
      entry.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  /** Raise/lower a tileset by an altitude offset (metres) at its centre. */
  private applyTilesetAltitude(tileset: Cesium3DTileset, offset: number): void {
    if (!Number.isFinite(offset) || offset === 0) return;
    const { Cesium } = this;
    const carto = Cesium.Cartographic.fromCartesian(tileset.boundingSphere.center);
    const surface = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 0);
    const target = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, offset);
    const translation = Cesium.Cartesian3.subtract(target, surface, new Cesium.Cartesian3());
    tileset.modelMatrix = Cesium.Matrix4.fromTranslation(translation);
  }

  private applyAppearance(entry: LayerEntry): void {
    const { handle, layer } = entry;
    if (!handle) return;
    if (entry.kind === "imagery") {
      const imagery = handle as ImageryLayer;
      imagery.show = layer.visible;
      imagery.alpha = this.effectiveOpacity(entry);
      // The raster symbology (Style panel → brightness, contrast, saturation,
      // hue) maps onto ImageryLayer's own adjustments; applied on every sync
      // since the four assignments are cheaper than a change key.
      const colour = imageryColorAdjustments(layer.style);
      imagery.brightness = colour.brightness;
      imagery.contrast = colour.contrast;
      imagery.saturation = colour.saturation;
      imagery.hue = colour.hue;
    } else if (entry.kind === "geojson") {
      (handle as DataSource).show = layer.visible;
      this.applyGeoJsonStyle(entry);
      this.applyGeoJsonFilter(entry);
    } else if (entry.kind === "pointcloud") {
      const collection = handle as PointPrimitiveCollection;
      collection.show = layer.visible;
      const opacity = this.effectiveOpacity(entry);
      const key = String(opacity);
      if (entry.appliedAlpha !== key) {
        entry.appliedAlpha = key;
        setPointCloudOpacity(collection, opacity);
      }
    } else if (entry.kind === "points") {
      (handle as PointPrimitiveCollection).show = layer.visible;
      this.applyPointBatchStyle(entry);
      this.applyGeoJsonFilter(entry);
    } else {
      (handle as Cesium3DTileset | I3SDataProvider).show = layer.visible;
    }
  }

  private readonly storyOpacities = new Map<
    string,
    { originalOpacity: number; currentOpacity: number }
  >();

  private effectiveOpacity(entry: LayerEntry): number {
    const override = this.storyOpacities.get(entry.layer.id);
    return override !== undefined ? override.currentOpacity : entry.layer.opacity;
  }

  /**
   * Synchronize the viewer clock's current time to a date (e.g. from the Time Slider).
   *
   * @param date Date, timestamp string, or epoch milliseconds to set on the Cesium clock.
   */
  setTime(date: Date | string | number): void {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return;
    const JulianDate = (this.Cesium as { JulianDate?: { fromDate?: (d: Date) => unknown } })
      ?.JulianDate;
    if (JulianDate?.fromDate && this.viewer.clock) {
      this.viewer.clock.currentTime = JulianDate.fromDate(d) as never;
    } else if (this.viewer.clock) {
      (this.viewer.clock as unknown as { currentTime: unknown }).currentTime = d;
    }
    this.viewer.scene?.requestRender?.();
  }

  /**
   * Temporarily override a layer's opacity for story playback without mutating the
   * underlying layer in the project store.
   *
   * @param layerId Unique identifier of the layer whose opacity to override.
   * @param opacity Desired opacity clamped between 0 and 1.
   */
  setStoryLayerOpacity(layerId: string, opacity: number): void {
    const entry = this.entries.get(layerId);
    if (!entry) return;
    const clamped = Math.min(1, Math.max(0, opacity));
    const existing = this.storyOpacities.get(layerId);
    if (!existing) {
      this.storyOpacities.set(layerId, {
        originalOpacity: entry.layer.opacity,
        currentOpacity: clamped,
      });
    } else {
      existing.currentOpacity = clamped;
    }
    // The override is stored either way; while the async create is still in
    // flight there is nothing to restyle yet, and the create path applies the
    // effective (story) opacity once the handle lands.
    if (!entry.handle) return;
    entry.appliedAlpha = undefined;
    this.applyAppearance(entry);
    this.viewer.scene?.requestRender?.();
  }

  /**
   * Revert all temporary story opacities applied by {@link setStoryLayerOpacity}
   * back to the stored layer opacity.
   */
  restoreStoryLayerStyles(): void {
    if (this.storyOpacities.size === 0) return;
    const layersToRestore = Array.from(this.storyOpacities.keys());
    this.storyOpacities.clear();
    for (const layerId of layersToRestore) {
      const entry = this.entries.get(layerId);
      if (!entry || !entry.handle) continue;
      entry.appliedAlpha = undefined;
      this.applyAppearance(entry);
    }
    this.viewer.scene?.requestRender?.();
  }

  /**
   * Evaluate a layer's composed feature filter (timeFilter, embedFilter, quickFilters,
   * rule-based visibility) against each entity — or each batched point primitive —
   * toggling its `show` in place.
   */
  private applyGeoJsonFilter(entry: LayerEntry): void {
    if (!entry.handle) return;
    const filter = composeLayerFeatureFilter(entry.layer);
    const filterKey = filter ? JSON.stringify(filter) : "";
    // A rule-based visibility filter carries `["zoom"]` for per-rule zoom
    // bounds (and an embed filter may too). The integer camera zoom joins the
    // cache key so the filter re-runs exactly when the camera crosses a level.
    const zoomDependent = ZOOM_OPERAND.test(filterKey);
    const zoom = zoomDependent ? this.cameraZoom() : 0;
    const key = zoomDependent ? `${filterKey}@z${zoom}` : filterKey;
    entry.zoomFilter = zoomDependent;
    this.watchCameraZoom();
    if (entry.appliedFilterKey === key) return;
    entry.appliedFilterKey = key;

    const { viewer } = this;
    const currentTime = viewer.clock?.currentTime;
    const indexKey = "__geolibre_cesium_feature_index";
    const features = entry.layer.geojson?.features;

    // The things to show or hide: entities of a data source, or the primitives
    // of a point batch, each paired with the feature it came from.
    type Target = {
      feature: Feature | null;
      properties?: object;
      setShow(show: boolean): void;
    };
    const targets = (): Iterable<Target> => {
      if (entry.kind === "points") {
        const collection = entry.handle as PointPrimitiveCollection;
        const out: Target[] = [];
        for (let i = 0; i < collection.length; i++) {
          const point = collection.get(i);
          const ref = point.id;
          out.push({
            feature: isBatchedPointRef(ref) ? (features?.[ref.index] ?? null) : null,
            setShow: (show) => {
              point.show = show;
            },
          });
        }
        return out;
      }
      const dataSource = entry.handle as DataSource;
      return dataSource.entities.values.map((entity) => {
        const propIndex = entity.properties?.[indexKey];
        const index =
          typeof propIndex?.getValue === "function" ? propIndex.getValue(currentTime) : propIndex;
        return {
          feature: Number.isInteger(index) && features ? features[index] : null,
          properties: entity.properties,
          setShow: (show) => {
            entity.show = show;
          },
        };
      });
    };

    let compiled: ReturnType<typeof featureFilter> | null = null;
    if (filter) {
      try {
        compiled = featureFilter(filter as never, "layers[0].filter");
      } catch {
        compiled = null;
      }
    }
    if (!compiled) {
      for (const target of targets()) target.setShow(true);
      return;
    }

    const typeMap: Record<string, 1 | 2 | 3> = {
      Point: 1,
      MultiPoint: 1,
      LineString: 2,
      MultiLineString: 2,
      Polygon: 3,
      MultiPolygon: 3,
    };

    for (const target of targets()) {
      const feat = target.feature;
      let properties: Record<string, unknown> = {};
      let geomType: 0 | 1 | 2 | 3 = 1;
      let id: unknown = undefined;

      if (feat) {
        properties = (feat.properties as Record<string, unknown>) ?? {};
        geomType = (feat.geometry?.type && typeMap[feat.geometry.type]) ?? 1;
        id = feat.id;
      } else if (target.properties) {
        const propBag = target.properties as Record<string, unknown>;
        const names = Array.isArray(propBag.propertyNames)
          ? propBag.propertyNames
          : Object.keys(propBag);
        for (const name of names) {
          if (name === indexKey) continue;
          const val = propBag[name];
          properties[name] =
            typeof (val as { getValue?: (t: unknown) => unknown })?.getValue === "function"
              ? (val as { getValue: (t: unknown) => unknown }).getValue(currentTime)
              : val;
        }
      }

      let visible = true;
      try {
        visible = compiled.filter({ zoom }, {
          type: geomType,
          properties,
          id,
          geometry: feat?.geometry,
        } as never);
      } catch {
        visible = true;
      }
      target.setShow(visible);
    }
  }

  /**
   * Re-apply a GeoJSON layer's opacity in place, so dragging the opacity slider
   * restyles the entities instead of reloading the whole GeoJsonDataSource.
   * Bake every entity's symbology from the per-feature resolver (issue #2278),
   * folded with the layer (or story) opacity. Runs after load and again on
   * every opacity change, style-object change, or — for zoom-dependent
   * styles — integer zoom change; the key on the entry makes an unrelated
   * sync a string compare.
   *
   * Polygons take the resolved fill (or the fill-pattern material), outline
   * colour, and outline width; lines the resolved stroke and width (an arrow
   * decoration becomes Cesium's arrow material); circles the resolved radius,
   * fill, and outline; markers their baked sprite for the resolved colour,
   * scaled by proportional sizing. Extruded polygons keep the extrusion
   * colour path, which has its own expression.
   */
  private applyGeoJsonStyle(entry: LayerEntry): void {
    const dataSource = entry.handle as DataSource | null;
    if (!dataSource) return;
    const style = entry.layer.style ?? {};
    const opacity = this.effectiveOpacity(entry);
    const extOpacity =
      (Number.isFinite(style.extrusionOpacity) ? (style.extrusionOpacity as number) : 0.8) *
      opacity;
    const resolver = this.resolverFor(entry);
    const zoom = resolver.zoomDependent ? this.cameraZoom() : 0;
    // Any opacity change, any style-object change (the in-place fields), and a
    // zoom step for a zoom-dependent style all reach the entities; the style
    // object is identified by the resolver compiled from it.
    const key = `${opacity}|${extOpacity}|${zoom}|${entry.resolverKey ?? ""}`;
    if (entry.appliedAlpha === key) return;
    entry.appliedAlpha = key;
    const { Cesium } = this;
    const features = entry.layer.geojson?.features;
    const currentTime = this.viewer.clock?.currentTime;
    const colour = (css: string, alpha: number) =>
      Cesium.Color.fromCssColorString(css).withAlpha(Math.min(1, Math.max(0, alpha)));
    // Point pins and marker sprites keep their baked-in colour; multiplying by
    // white+alpha only fades them.
    const marker = Cesium.Color.WHITE.withAlpha(opacity);
    const isExtruded = Boolean(style.extrusionEnabled);
    const extColorStr = style.extrusionColor || style.fillColor || "#3b82f6";
    const extFill = Cesium.Color.fromCssColorString(extColorStr).withAlpha(extOpacity);
    const hasColorExpr =
      isExtruded && style.extrusionAdvancedStyleEnabled && Boolean(style.extrusionColorExpression);
    const arrow =
      style.lineDecoration === "arrow" &&
      Boolean(
        (Cesium as { PolylineArrowMaterialProperty?: unknown }).PolylineArrowMaterialProperty,
      );
    const pattern = entry.patternImage ?? null;

    // Scale the label colour's own alpha (an rgba()/#rrggbbaa label colour) by
    // the layer opacity, as text-opacity does on the 2D map, rather than
    // replacing it. Computed once: this runs on every opacity-slider drag.
    const labels = { ...DEFAULT_LAYER_STYLE.labels, ...style.labels };
    const labelColor = Cesium.Color.fromCssColorString(labels.color);
    const labelFill = labelColor.withAlpha(labelColor.alpha * opacity);
    const halo = Cesium.Color.fromCssColorString(labels.haloColor);
    const labelOutline = halo.withAlpha(halo.alpha * opacity);
    for (const entity of dataSource.entities.values) {
      const ref = this.featureRefs.get(entity);
      const feature = ref && features ? features[ref.index] : undefined;
      const symbol = resolver.resolve(feature, zoom);
      if (entity.polygon) {
        if (hasColorExpr) {
          // ColorMaterialProperty wraps its colour in a ConstantProperty, so
          // resolve the Property before re-alphaing the per-feature colour.
          const colorProp = (entity.polygon.material as { color?: unknown } | undefined)?.color as
            | {
                getValue?: (time: unknown) => Color | undefined;
                withAlpha?: (a: number) => Color;
              }
            | undefined;
          const current =
            typeof colorProp?.getValue === "function" ? colorProp.getValue(currentTime) : colorProp;
          if (current?.withAlpha) {
            entity.polygon.material = new Cesium.ColorMaterialProperty(
              current.withAlpha(extOpacity),
            );
          }
        } else if (isExtruded) {
          entity.polygon.material = new Cesium.ColorMaterialProperty(extFill);
        } else if (pattern && Cesium.ImageMaterialProperty) {
          entity.polygon.material = new Cesium.ImageMaterialProperty({
            image: pattern.canvas,
            repeat: this.patternRepeat(entity),
            transparent: true,
            color: Cesium.Color.WHITE.withAlpha(symbol.fillOpacity * opacity),
          }) as never;
        } else {
          entity.polygon.material = new Cesium.ColorMaterialProperty(
            colour(symbol.fill, symbol.fillOpacity * opacity),
          );
        }
        // A polygon boundary is a line layer on the 2D map, so it takes the
        // line colour channel; the outline channel is the circle stroke.
        entity.polygon.outlineColor = new Cesium.ConstantProperty(
          colour(symbol.stroke, symbol.strokeOpacity * opacity),
        ) as never;
        entity.polygon.outlineWidth = new Cesium.ConstantProperty(symbol.strokeWidth) as never;
      }
      if (entity.polyline) {
        const stroke = colour(symbol.stroke, symbol.strokeOpacity * opacity);
        entity.polyline.material = (
          arrow
            ? new (
                Cesium as {
                  PolylineArrowMaterialProperty: new (c: Color) => unknown;
                }
              ).PolylineArrowMaterialProperty(stroke)
            : new Cesium.ColorMaterialProperty(stroke)
        ) as never;
        entity.polyline.width = new Cesium.ConstantProperty(symbol.strokeWidth) as never;
      }
      if (entity.point) {
        entity.point.pixelSize = new Cesium.ConstantProperty(symbol.radius * 2) as never;
        entity.point.color = new Cesium.ConstantProperty(
          colour(symbol.pointFill, symbol.pointFillOpacity * opacity),
        ) as never;
        entity.point.outlineColor = new Cesium.ConstantProperty(
          colour(symbol.outline, symbol.strokeOpacity * opacity),
        ) as never;
        entity.point.outlineWidth = new Cesium.ConstantProperty(symbol.strokeWidth) as never;
      }
      if (entity.billboard) {
        const sprite =
          entry.markerImages?.get(symbol.markerColor) ?? entry.markerImages?.get("") ?? null;
        if (sprite) {
          entity.billboard.image = new Cesium.ConstantProperty(sprite.canvas) as never;
          entity.billboard.scale = new Cesium.ConstantProperty(
            symbol.markerScale / sprite.pixelRatio,
          ) as never;
        }
        entity.billboard.color = new Cesium.ConstantProperty(marker);
      }
      if (entity.label) {
        entity.label.fillColor = new Cesium.ConstantProperty(labelFill);
        entity.label.outlineColor = new Cesium.ConstantProperty(labelOutline);
      }
    }
    // Cluster bubbles read the appearance when they form, so an in-place
    // restyle (an opacity drag, a story fade) re-clusters to pick it up
    // instead of waiting for the camera to move.
    entry.cluster?.refresh();
  }

  /**
   * How many times a fill-pattern tile repeats across a polygon. Cesium's
   * image material spans texture coordinates 0..1 over the polygon's extent,
   * so the repeat count is derived from that extent in metres to keep the
   * pattern's ground density roughly constant (one tile per
   * {@link PATTERN_TILE_METERS}); the 2D map draws its pattern in screen
   * pixels, which the globe cannot reproduce on a draped surface.
   */
  private patternRepeat(entity: Entity): Cartesian2 {
    // The extent only changes with a rebuild, which creates new entities, so
    // the answer is cached per entity: the restyle pass re-runs on every
    // opacity-slider tick and must not recompute a bounding sphere per polygon.
    const cached = this.patternRepeats.get(entity);
    if (cached) return cached;
    const { Cesium, viewer } = this;
    let repeat = 8;
    try {
      const ring = entity.polygon?.hierarchy?.getValue(viewer.clock?.currentTime)?.positions;
      if (ring?.length && Cesium.BoundingSphere) {
        const radius = Cesium.BoundingSphere.fromPoints(ring).radius;
        if (Number.isFinite(radius) && radius > 0)
          repeat = Math.min(256, Math.max(1, Math.round((2 * radius) / PATTERN_TILE_METERS)));
      }
    } catch {
      // Keep the default density.
    }
    const result = (
      Cesium.Cartesian2 ? new Cesium.Cartesian2(repeat, repeat) : { x: repeat, y: repeat }
    ) as Cartesian2;
    this.patternRepeats.set(entity, result);
    return result;
  }

  /** Fill-pattern repeat counts, by entity; see {@link patternRepeat}. */
  private readonly patternRepeats = new WeakMap<Entity, Cartesian2>();

  private destroyEntry(entry: LayerEntry): void {
    entry.cancelled = true;
    entry.abort?.abort();
    this.storyOpacities.delete(entry.layer.id);
    const { handle } = entry;
    if (!handle) return;
    if (entry.kind === "imagery") {
      const imagery = handle as ImageryLayer;
      // Cesium destroys the layer but not its provider; a bridged provider
      // holds an abort controller for the handler requests still in flight.
      // Read the provider before the layer is destroyed, so the abort never
      // depends on what `destroy()` leaves behind.
      const provider = imagery.imageryProvider as { destroy?: () => void } | undefined;
      this.viewer.imageryLayers.remove(imagery, true);
      if (provider instanceof ProtocolImageryProvider) provider.destroy();
    } else if (entry.kind === "geojson") {
      entry.cluster?.dispose();
      entry.cluster = undefined;
      this.viewer.dataSources.remove(handle as DataSource, true);
    } else {
      // A tileset, an I3S provider, a point batch, or a point-cloud collection: all
      // scene primitives.
      this.viewer.scene.primitives.remove(
        handle as Cesium3DTileset | I3SDataProvider | PointPrimitiveCollection,
      );
    }
  }
}
