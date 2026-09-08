import {
  compileFeatureExpression,
  compileQuickFilters,
  DEFAULT_LAYER_STYLE,
  geojsonHasZCoordinates,
  resolveThreeDTilesRequestHeaders,
  ruleBasedVisibilityFilter,
  transformGeojsonElevation,
  type GeoLibreLayer,
} from "@geolibre/core";
import { featureFilter } from "@maplibre/maplibre-gl-style-spec";
import type { Feature } from "geojson";
import { readMapViewFromCamera, zoomToDisplayDistance } from "./cesium-camera";
import { createFeatureStyleResolver, type FeatureStyleResolver } from "./cesium-feature-style";
import { createCesiumLabeler, pickLabelPart } from "./cesium-labels";
import { renderFillPatternCanvas } from "./fill-patterns";
import { getLayerBounds } from "./geojson-loader";
import { renderMarkerCanvas } from "./markers";
import type {
  Cartesian2,
  Cesium3DTileset,
  CesiumWidget,
  Color,
  DataSource,
  DistanceDisplayCondition,
  Entity,
  ImageryLayer,
  ImageryProvider,
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

type EntryKind = "imagery" | "geojson" | "3dtiles";

interface LayerEntry {
  kind: EntryKind;
  /** The layer as last applied, for change detection. */
  layer: GeoLibreLayer;
  /** The Cesium object, or null while an async create is in flight. */
  handle: ImageryLayer | DataSource | Cesium3DTileset | null;
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
    layer.type === "3d-tiles" ||
    IMAGERY_TYPES.has(layer.type)
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
  return Boolean(firstTile(layer));
}

function entryKind(layer: GeoLibreLayer): EntryKind {
  if (hasRenderableGeoJson(layer)) return "geojson";
  if (layer.type === "3d-tiles") return "3dtiles";
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
  "pointRenderer",
  "heatmapRadius",
  "heatmapIntensity",
  "heatmapColorRamp",
  "heatmapWeightProperty",
  "clusterRadius",
  "clusterMaxZoom",
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
  switch (entryKind(next)) {
    case "geojson":
      return prev.geojson !== next.geojson || styleSignature(prev) !== styleSignature(next);
    case "imagery":
      return (
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
    case "3dtiles":
      return (
        tilesetUrl(prev) !== tilesetUrl(next) ||
        JSON.stringify(prev.source.requestHeaders ?? null) !==
          JSON.stringify(next.source.requestHeaders ?? null) ||
        prev.source.altitudeOffset !== next.source.altitudeOffset
      );
  }
}

/** Collaborators the sync loads lazily or that tests replace. */
export interface CesiumLayerSyncDeps {
  /** Rasterises one marker sprite; defaults to the 2D map's marker renderer. */
  renderMarker?: typeof renderMarkerCanvas;
  /** Rasterises the fill-pattern tile; defaults to the 2D map's renderer. */
  renderFillPattern?: typeof renderFillPatternCanvas;
}

export class CesiumLayerSync {
  private readonly featureRefs = new WeakMap<object, { layerId: string; index: number }>();
  private readonly imageryRefs = new WeakMap<object, string>();
  private selection: { layerId: string; ids: Set<string> } | null = null;
  private highlightRestorers: Array<() => void> = [];

  /** Only live, visible entities owned by this synchronizer can identify a feature. */
  resolveFeature(entity: object) {
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
    if (!selected || !entry || entry.kind !== "geojson" || !entry.handle) return;
    const C = this.Cesium;
    const color = C.Color.fromCssColorString("#facc15");
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
      else if (entry.kind === "3dtiles" && !(entry.handle as Cesium3DTileset).tilesLoaded)
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
        this.entries.delete(id);
      }
    }

    // Tracks a create/rebuild of an imagery layer this pass (which re-appends it
    // to the top), so the reorder pass below runs even when the store id order
    // is unchanged.
    let imageryRebuilt = false;
    for (const layer of layers) {
      if (!isSupported(layer)) {
        // A previously-supported layer that became unrenderable (e.g. its data
        // was cleared) is torn down.
        const stale = this.entries.get(layer.id);
        if (stale) {
          this.destroyEntry(stale);
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
    const imageryOrder = layers
      .filter((l) => this.entries.get(l.id)?.kind === "imagery")
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
      if (entry.zoomFilter || entry.zoomStyle) {
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
      if (entry.kind !== "geojson" || !entry.handle) continue;
      if (entry.zoomFilter) {
        const before = entry.appliedFilterKey;
        this.applyGeoJsonFilter(entry);
        if (entry.appliedFilterKey !== before) changed = true;
      }
      if (entry.zoomStyle) {
        const before = entry.appliedAlpha;
        this.applyGeoJsonStyle(entry);
        if (entry.appliedAlpha !== before) {
          changed = true;
          this.bakeZoomMarkers(entry);
        }
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
    }
  }

  private createEntry(layer: GeoLibreLayer): void {
    const kind = entryKind(layer);
    const entry: LayerEntry = { kind, layer, handle: null, cancelled: false };
    this.entries.set(layer.id, entry);
    if (kind === "imagery") void this.createImagery(entry);
    else if (kind === "geojson") void this.createGeoJson(entry);
    else void this.createTileset(entry);
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
      } else {
        const url = firstTile(layer);
        if (!url) throw new Error("no tile URL template");
        const resource = makeResource(url);
        const maxLevel = Number(layer.source.maxzoom);
        const minLevel = Number(layer.source.minzoom);
        provider = new Cesium.UrlTemplateImageryProvider({
          url: resource,
          maximumLevel: Number.isFinite(maxLevel) ? maxLevel : undefined,
          minimumLevel: Number.isFinite(minLevel) ? minLevel : undefined,
        });
      }

      if (!provider || entry.cancelled) return;
      // addImageryProvider appends above the base imagery (and earlier store
      // layers), so store order maps to Cesium's bottom-to-top stacking.
      const imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
      if (entry.cancelled) {
        viewer.imageryLayers.remove(imageryLayer, true);
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
      const tileset = await Cesium.Cesium3DTileset.fromUrl(resource, {});
      if (entry.cancelled) {
        tileset.destroy();
        return;
      }
      viewer.scene.primitives.add(tileset);
      this.applyTilesetAltitude(tileset, Number(layer.source.altitudeOffset));
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
    } else if (entry.kind === "geojson") {
      (handle as DataSource).show = layer.visible;
      this.applyGeoJsonStyle(entry);
      this.applyGeoJsonFilter(entry);
    } else {
      (handle as Cesium3DTileset).show = layer.visible;
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
   * rule-based visibility) against each GeoJSON entity, toggling `entity.show` in place.
   */
  private applyGeoJsonFilter(entry: LayerEntry): void {
    const dataSource = entry.handle as DataSource | null;
    if (!dataSource) return;
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

    if (!filter) {
      for (const entity of dataSource.entities.values) {
        entity.show = true;
      }
      return;
    }

    let compiled: ReturnType<typeof featureFilter>;
    try {
      compiled = featureFilter(filter as never, "layers[0].filter");
    } catch {
      for (const entity of dataSource.entities.values) {
        entity.show = true;
      }
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

    for (const entity of dataSource.entities.values) {
      const propIndex = entity.properties?.[indexKey];
      const index =
        typeof propIndex?.getValue === "function" ? propIndex.getValue(currentTime) : propIndex;
      const feat = Number.isInteger(index) && features ? features[index] : null;
      let properties: Record<string, unknown> = {};
      let geomType: 0 | 1 | 2 | 3 = 1;
      let id: unknown = undefined;

      if (feat) {
        properties = (feat.properties as Record<string, unknown>) ?? {};
        geomType = (feat.geometry?.type && typeMap[feat.geometry.type]) ?? 1;
        id = feat.id;
      } else if (entity.properties) {
        const propBag = entity.properties as Record<string, unknown>;
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
      entity.show = visible;
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
            | { getValue?: (time: unknown) => Color | undefined; withAlpha?: (a: number) => Color }
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
                Cesium as { PolylineArrowMaterialProperty: new (c: Color) => unknown }
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
    this.storyOpacities.delete(entry.layer.id);
    const { handle } = entry;
    if (!handle) return;
    if (entry.kind === "imagery") {
      this.viewer.imageryLayers.remove(handle as ImageryLayer, true);
    } else if (entry.kind === "geojson") {
      this.viewer.dataSources.remove(handle as DataSource, true);
    } else {
      this.viewer.scene.primitives.remove(handle as Cesium3DTileset);
    }
  }
}
