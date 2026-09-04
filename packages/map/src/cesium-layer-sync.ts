import { resolveThreeDTilesRequestHeaders, type GeoLibreLayer } from "@geolibre/core";
import type {
  Cesium3DTileset,
  CesiumWidget,
  DataSource,
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
  /** Last opacity key applied in place to a geojson entry (skips redundant restyles). */
  appliedAlpha?: string;
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

// Fill/stroke *colours*, stroke width, and marker colour bake into the GeoJSON
// entities at load, so a change to any of them forces a rebuild. Opacity
// (layer.opacity × fill opacity) is deliberately excluded: it is re-applied in
// place by applyGeoJsonStyle, so dragging the opacity slider restyles the fill
// alpha instead of reloading the whole GeoJsonDataSource on every tick.
function styleSignature(layer: GeoLibreLayer): string {
  const style = layer.style ?? {};
  return [style.fillColor, style.strokeColor, style.strokeWidth, style.markerColor].join("|");
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

export class CesiumLayerSync {
  private readonly entries = new Map<string, LayerEntry>();
  /** Imagery id order last asserted on the globe, to skip redundant reorders. */
  private lastImageryOrder = "";
  /** Active layer list from the current/latest sync pass. */
  private currentLayers: GeoLibreLayer[] = [];

  constructor(
    private readonly Cesium: CesiumNs,
    private readonly viewer: CesiumWidget,
  ) {}

  /** Reconcile the globe to `layers` (order preserved for imagery stacking). */
  sync(layers: GeoLibreLayer[]): void {
    this.currentLayers = layers;
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
  }

  destroy(): void {
    for (const entry of this.entries.values()) this.destroyEntry(entry);
    this.entries.clear();
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
        if (!bounds) return;
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
            return;
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
        if (!url) return;
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
    } catch {
      // A provider that throws synchronously (e.g. malformed params) or rejects
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
    try {
      const dataSource = await Cesium.GeoJsonDataSource.load(layer.geojson, {
        stroke,
        strokeWidth: style.strokeWidth ?? 2,
        fill: fill.withAlpha(fillAlpha),
        markerColor: Cesium.Color.fromCssColorString(style.markerColor ?? "#3b82f6"),
        clampToGround: true,
      });
      if (entry.cancelled) return;
      await viewer.dataSources.add(dataSource);
      if (entry.cancelled) {
        viewer.dataSources.remove(dataSource, true);
        return;
      }
      entry.handle = dataSource;
      // applyAppearance → applyGeoJsonStyle fades every entity kind (fill,
      // stroke, marker) by the layer opacity right after load, so points/lines
      // match the 2D map instead of rendering fully opaque.
      this.applyAppearance(entry);
    } catch {
      // A malformed FeatureCollection should not break the whole sync.
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
    } catch {
      // A tileset that fails to load should not break the whole sync.
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
      imagery.alpha = layer.opacity;
    } else if (entry.kind === "geojson") {
      (handle as DataSource).show = layer.visible;
      this.applyGeoJsonStyle(entry);
    } else {
      (handle as Cesium3DTileset).show = layer.visible;
    }
  }

  /**
   * Re-apply a GeoJSON layer's opacity in place, so dragging the opacity slider
   * restyles the entities instead of reloading the whole GeoJsonDataSource.
   * Polygon fill uses layer opacity × fill opacity; polyline stroke and point
   * markers use the layer opacity alone (matching the 2D map, where opacity
   * fades lines and points too). Colours themselves bake in at load, so a colour
   * change still rebuilds; the `appliedAlpha` guard makes a no-op call cheap on
   * unrelated syncs.
   */
  private applyGeoJsonStyle(entry: LayerEntry): void {
    const dataSource = entry.handle as DataSource | null;
    if (!dataSource) return;
    const style = entry.layer.style ?? {};
    const opacity = entry.layer.opacity;
    const fillAlpha = (style.fillOpacity ?? 0.6) * opacity;
    // Key on both alphas so any opacity change is picked up (e.g. a lines-only
    // layer whose fill alpha never varies).
    const key = `${fillAlpha}|${opacity}`;
    if (entry.appliedAlpha === key) return;
    entry.appliedAlpha = key;
    const { Cesium } = this;
    const fill = Cesium.Color.fromCssColorString(style.fillColor ?? "#3b82f6").withAlpha(fillAlpha);
    const stroke = Cesium.Color.fromCssColorString(style.strokeColor ?? "#1e40af").withAlpha(
      opacity,
    );
    // Point pins keep their baked-in colour; multiplying by white+alpha only
    // fades them.
    const marker = Cesium.Color.WHITE.withAlpha(opacity);
    for (const feature of dataSource.entities.values) {
      if (feature.polygon) {
        feature.polygon.material = new Cesium.ColorMaterialProperty(fill);
      }
      if (feature.polyline) {
        feature.polyline.material = new Cesium.ColorMaterialProperty(stroke);
      }
      if (feature.billboard) {
        feature.billboard.color = new Cesium.ConstantProperty(marker);
      }
    }
  }

  private destroyEntry(entry: LayerEntry): void {
    entry.cancelled = true;
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
