/// <reference path="../arcgis-maplibre.d.ts" />

import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { HostedLayer, VectorTileLayer } from "@esri/maplibre-arcgis";
import type { Feature, FeatureCollection } from "geojson";
import type * as maplibregl from "maplibre-gl";
import type { GeoLibreAppAPI } from "../types";

export type ArcGISLayerType = "feature" | "vector-tile" | "map-service" | "image-service";
export type ArcGISSourceType = "url" | "portal-item";

/**
 * Every {@link ArcGISLayerType}, as a runtime list so a stored value (a saved
 * service-library entry, a hand-edited project) can be validated against it
 * instead of being coerced to a default that silently loads the wrong service.
 */
export const ARCGIS_LAYER_TYPES: readonly ArcGISLayerType[] = [
  "feature",
  "vector-tile",
  "map-service",
  "image-service",
];

/**
 * Narrow an untrusted string to an {@link ArcGISLayerType}.
 *
 * @param value - The stored or user-supplied layer type.
 * @param fallback - The type to use when `value` is not a known layer type.
 * @returns The matching layer type, or `fallback`.
 */
export function parseArcGISLayerType(
  value: unknown,
  fallback: ArcGISLayerType = "feature",
): ArcGISLayerType {
  return ARCGIS_LAYER_TYPES.find((layerType) => layerType === value) ?? fallback;
}

/**
 * `metadata.sourceKind` for the two image-producing service types. A MapServer
 * or ImageServer renders as ordinary raster tiles, so the layer these produce is
 * a plain `raster` layer rather than an `arcgis` one; the source kind is what
 * marks where it came from.
 */
export const ARCGIS_MAP_SERVICE_SOURCE_KIND = "arcgis-map-service";
export const ARCGIS_IMAGE_SERVICE_SOURCE_KIND = "arcgis-image-service";
export const ARCGIS_MAP_SERVICE_URL_ERROR = "Enter an ArcGIS MapServer URL.";
export const ARCGIS_IMAGE_SERVICE_URL_ERROR = "Enter an ArcGIS ImageServer URL.";

/** Tile size requested from `/export` and `/exportImage`, in pixels. */
const ARCGIS_EXPORT_TILE_SIZE = 256;

/**
 * The Web Mercator tiling scheme a cached ArcGIS service must use for its
 * `/tile/{z}/{y}/{x}` endpoint to be an XYZ source MapLibre can consume: the
 * top-left origin and the level-0 resolution of the standard scheme (a 256 px
 * tile spanning the whole world).
 */
const WEB_MERCATOR_ORIGIN_X = -20037508.342787;
const WEB_MERCATOR_ORIGIN_Y = 20037508.342787;
const WEB_MERCATOR_LEVEL0_RESOLUTION = 156543.03392800014;

/**
 * Features requested per `/query` call when the service does not advertise a
 * smaller `maxRecordCount`.
 *
 * Deliberately far below the 1000-50000 `maxRecordCount` services typically
 * advertise: that ceiling is what the service will *return*, not what it can
 * assemble without falling over. Asking a large layer for everything at once is
 * exactly what fails (GeoLibre#1745 — a 41k-polygon FeatureServer answers the
 * unbounded query with an HTTP 500 "Error performing query operation" while the
 * same data pages back fine).
 */
const DEFAULT_ARCGIS_PAGE_SIZE = 1000;

/**
 * Runaway guard for the paging loops. At the default page size this is 5M
 * features, well past any layer that belongs in an in-memory GeoJSON source, so
 * it only ever trips on a service that keeps answering without making progress.
 */
const MAX_ARCGIS_PAGES = 5000;

/**
 * `metadata.sourceKind` on a feature layer loaded through the paged query path.
 * `layer-refresh.ts` matches on it to replay the paging on refresh instead of
 * re-fetching the stored URL, which would return only the first page.
 */
export const ARCGIS_FEATURE_SOURCE_KIND = "arcgis-feature-query";

export interface ArcGISLayerOptions {
  beforeLayerId?: string | null;
  itemId?: string;
  layerType: ArcGISLayerType;
  /**
   * Stop after this many features. Defaults to no cap (the whole layer).
   *
   * Only meaningful for `layerType: "feature"`, whose features are pulled into
   * an in-memory GeoJSON source; a cap is the escape hatch for a layer too big
   * to hold in the browser at all.
   *
   * In the interactive app a feature layer loads by viewport, so the cap
   * applies to each viewport query rather than to the layer as a whole: every
   * pan issues a fresh bounded download of up to this many features. Headless
   * callers, which download the layer whole, get the total cap.
   */
  maxFeatures?: number;
  name?: string;
  /**
   * Called after each page of a feature layer's download, with the features
   * loaded so far and the service's total count (`null` when the service would
   * not answer `returnCountOnly`). Lets a caller show progress across what can
   * be dozens of requests.
   */
  onProgress?: (loaded: number, total: number | null) => void;
  /**
   * Features to request per `/query` call (ArcGIS `resultRecordCount`).
   * Defaults to the smaller of {@link DEFAULT_ARCGIS_PAGE_SIZE} and the
   * service's advertised `maxRecordCount`. Lower it for a service that times
   * out even on the default page.
   */
  pageSize?: number;
  portalUrl?: string;
  /**
   * ImageServer rendering rule, as the JSON ArcGIS expects for the
   * `renderingRule` parameter (e.g. `{"rasterFunction":"Hillshade"}`).
   *
   * Only meaningful for `layerType: "image-service"`. Supplying one forces the
   * dynamic `/exportImage` path: a cached service's tiles were rendered when
   * the cache was built, so they cannot honor a rule chosen here.
   */
  renderingRule?: string;
  sourceType: ArcGISSourceType;
  /**
   * MapServer sublayers to draw, as the comma-separated id list ArcGIS takes in
   * `layers=show:<ids>` (e.g. `0,2,5`). Blank draws the service's own default
   * set of visible sublayers.
   *
   * Only meaningful for `layerType: "map-service"`. Supplying a list forces the
   * dynamic `/export` path, because a cached service serves one fused image per
   * tile that no longer has separable sublayers.
   */
  sublayers?: string;
  token?: string;
  url?: string;
  /**
   * Whether to fit the map to the layer once its bounds are known. Defaults to
   * true, which is what an interactive Add Data flow wants.
   *
   * Project import sets it false: the view has already been restored from the
   * project file, and fitting each imported service in turn would pan the map
   * away from the extent the project saved. Mirrors `addRasterToMap`'s option
   * of the same name.
   */
  zoomTo?: boolean;
}

interface ArcGISFeatureLayerInfo {
  advancedQueryCapabilities?: {
    supportsOrderBy?: boolean;
    supportsPagination?: boolean;
  };
  copyrightText?: string;
  extent?: ArcGISExtent;
  geometryType?: string;
  maxRecordCount?: number;
  name?: string;
  objectIdField?: string;
}

interface ArcGISFeatureServiceInfo {
  layers?: Array<{
    id: number;
    subLayerIds?: number[];
  }>;
}

interface ArcGISServiceInfo {
  extent?: ArcGISExtent;
  fullExtent?: ArcGISExtent;
  initialExtent?: ArcGISExtent;
}

/**
 * The `?f=json` description of a MapServer or ImageServer, narrowed to what the
 * raster path reads: the extent to fit, the credit line, and whether the service
 * has a Web Mercator tile cache that can be consumed as XYZ tiles.
 */
interface ArcGISImageProducingServiceInfo extends ArcGISServiceInfo {
  copyrightText?: string;
  layers?: Array<{
    defaultVisibility?: boolean;
    id?: number;
    subLayerIds?: number[] | null;
  }>;
  mapName?: string;
  name?: string;
  singleFusedMapCache?: boolean;
  tileInfo?: ArcGISTileInfo;
}

/** One selectable layer advertised by an ArcGIS MapServer. */
export interface ArcGISMapServiceSublayer {
  id: number;
  name: string;
}

/** One raster function advertised by an ArcGIS ImageServer. */
export interface ArcGISImageServiceRasterFunction {
  description: string;
  name: string;
}

interface ArcGISTileInfo {
  cols?: number;
  lods?: Array<{ level?: number; resolution?: number }>;
  origin?: { x?: number; y?: number };
  rows?: number;
  spatialReference?: {
    latestWkid?: number;
    wkid?: number;
  };
}

/** A cached service's tile endpoint, resolved to what a raster source needs. */
interface ArcGISTileScheme {
  maxzoom: number;
  minzoom: number;
  tileSize: number;
}

interface ArcGISPortalItemInfo {
  extent?: [[number, number], [number, number]];
  url?: string;
}

interface ArcGISExtent {
  spatialReference?: {
    latestWkid?: number;
    wkid?: number;
  };
  xmax: number;
  xmin: number;
  ymax: number;
  ymin: number;
}

type ArcGISLayerModule = typeof import("@esri/maplibre-arcgis");
interface ArcGISRuntimeLayer {
  readonly bounds?: [number, number, number, number];
  readonly layers: Readonly<maplibregl.LayerSpecification[]>;
  readonly sources: Readonly<Record<string, maplibregl.SourceSpecification>>;
  addSourcesAndLayersTo(map: maplibregl.Map): ArcGISRuntimeLayer;
  setSourceId(oldId: string, newId: string): void;
}

let arcgisLayerSequence = 0;
const arcgisLayerInstances = new Map<string, ArcGISRuntimeLayer>();
let arcgisStoreUnsubscribe: (() => void) | null = null;

/** A live viewport-bound FeatureServer download for one GeoJSON layer. */
interface ArcGISViewportLoader {
  /** The in-flight request, aborted when a newer viewport supersedes it. */
  abort: AbortController | null;
  /** Re-run the query for the map's current extent. */
  load: () => Promise<FeatureCollection>;
  map: maplibregl.Map;
  /** The `moveend` handler, kept so it can be detached on removal. */
  move: () => void;
}

const arcgisFeatureLoaders = new Map<string, ArcGISViewportLoader>();
let arcgisFeatureLoaderUnsubscribe: (() => void) | null = null;

export async function addArcGISLayer(
  app: GeoLibreAppAPI,
  options: ArcGISLayerOptions,
): Promise<string> {
  const input = getArcGISInput(options);

  // A feature layer is just attributed vector data, so load it as a regular
  // GeoJSON layer rather than an opaque external-native layer. That unlocks the
  // host's full vector styling surface for it — labels (with uppercase/offset/
  // rotation formatting), the attribute table, identify, symbology, and export —
  // instead of only the fill/stroke paint an external-native layer exposes.
  if (options.layerType === "feature") {
    return addArcGISFeatureLayerAsGeoJson(app, options, input);
  }

  // A MapServer or ImageServer hands back rendered images, not data, so it is
  // loaded as an ordinary raster layer (cached tiles when the service has a Web
  // Mercator cache, otherwise an `/export` request per tile). That keeps the
  // whole raster surface — opacity, brightness/contrast, reordering, and project
  // save/reload — working without a bespoke handler.
  if (options.layerType === "map-service" || options.layerType === "image-service") {
    return addArcGISImageServiceLayer(app, options, input);
  }

  const map = app.getMap?.();
  if (!map) {
    throw new Error("The map is not ready.");
  }

  const arcgis = await import("@esri/maplibre-arcgis");
  const hostedLayer = await createArcGISHostedLayer(arcgis, options, input);
  const id = createArcGISLayerId();
  const sourceIds = prefixArcGISSourceIds(hostedLayer, id);
  const nativeLayerIds = prefixArcGISStyleLayerIds(hostedLayer, id);
  const bounds = await resolveArcGISLayerBounds(input, options, hostedLayer);

  addArcGISRuntimeLayerToMap(hostedLayer, map);
  ensureArcGISStoreCleanup();
  arcgisLayerInstances.set(id, hostedLayer);

  const layer = createArcGISStoreLayer({
    id,
    input,
    nativeLayerIds,
    options,
    bounds,
    sourceIds,
  });
  const store = useAppStore.getState();
  store.addLayer(layer, options.beforeLayerId);
  if (bounds && options.zoomTo !== false) app.fitBounds?.(bounds);
  return id;
}

/**
 * Retrieve the named layer catalog exposed by an ArcGIS MapServer.
 *
 * Group layers are included because ArcGIS accepts their ids in the dynamic
 * export `layers=show:` parameter and selecting one is a convenient way to
 * draw all of its descendants.
 */
export async function fetchArcGISMapServiceSublayers(params: {
  url: string;
  token?: string;
  signal?: AbortSignal;
}): Promise<ArcGISMapServiceSublayer[]> {
  const { serviceUrl } = resolveArcGISImageServiceUrl(params.url, "map-service");
  const json = await fetchArcGISJson<{ layers?: unknown[] }>(
    serviceUrl,
    { layerType: "map-service", sourceType: "url", token: params.token },
    undefined,
    params.signal,
  );
  return Array.isArray(json.layers)
    ? json.layers.filter(
        (layer): layer is ArcGISMapServiceSublayer =>
          typeof layer === "object" &&
          layer !== null &&
          Number.isSafeInteger((layer as Partial<ArcGISMapServiceSublayer>).id) &&
          ((layer as Partial<ArcGISMapServiceSublayer>).id ?? -1) >= 0 &&
          typeof (layer as Partial<ArcGISMapServiceSublayer>).name === "string",
      )
    : [];
}

/**
 * Retrieve the named raster functions advertised by an ArcGIS ImageServer.
 *
 * @param params - ImageServer URL and optional request credentials/cancellation.
 * @returns The service's valid named raster functions in advertised order.
 */
export async function fetchArcGISImageServiceRasterFunctions(params: {
  url: string;
  token?: string;
  signal?: AbortSignal;
}): Promise<ArcGISImageServiceRasterFunction[]> {
  const { serviceUrl } = resolveArcGISImageServiceUrl(params.url, "image-service");
  const json = await fetchArcGISJson<{ rasterFunctionInfos?: unknown[] }>(
    serviceUrl,
    { layerType: "image-service", sourceType: "url", token: params.token },
    undefined,
    params.signal,
  );
  if (!Array.isArray(json.rasterFunctionInfos)) return [];

  const rasterFunctions: ArcGISImageServiceRasterFunction[] = [];
  const names = new Set<string>();
  for (const rasterFunction of json.rasterFunctionInfos) {
    if (typeof rasterFunction !== "object" || rasterFunction === null) continue;
    const candidate = rasterFunction as Partial<ArcGISImageServiceRasterFunction>;
    const name = typeof candidate.name === "string" ? candidate.name.trim() : undefined;
    if (!name || names.has(name)) continue;
    names.add(name);
    rasterFunctions.push({
      name,
      description: typeof candidate.description === "string" ? candidate.description.trim() : "",
    });
  }
  return rasterFunctions;
}

function ensureArcGISStoreCleanup(): void {
  arcgisStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    for (const layer of previous.layers) {
      if (layer.type === "arcgis" && !state.layers.some((current) => current.id === layer.id)) {
        arcgisLayerInstances.delete(layer.id);
      }
    }
  });
}

async function createArcGISHostedLayer(
  arcgis: ArcGISLayerModule,
  options: ArcGISLayerOptions,
  input: string,
): Promise<ArcGISRuntimeLayer> {
  const layerOptions = {
    portalUrl: options.portalUrl?.trim() || undefined,
    token: options.token?.trim() || undefined,
  };

  return options.sourceType === "url"
    ? (arcgis.VectorTileLayer as typeof VectorTileLayer).fromUrl(input, layerOptions)
    : (arcgis.VectorTileLayer as typeof VectorTileLayer).fromPortalItem(input, layerOptions);
}

function getArcGISInput(options: ArcGISLayerOptions): string {
  const input = options.sourceType === "url" ? options.url?.trim() : options.itemId?.trim();
  if (!input) {
    throw new Error(
      options.sourceType === "url"
        ? "Enter an ArcGIS service URL."
        : "Enter an ArcGIS portal item ID.",
    );
  }
  return input;
}

function prefixArcGISSourceIds(hostedLayer: ArcGISRuntimeLayer, layerId: string): string[] {
  const originalSourceIds = Object.keys(hostedLayer.sources);
  return originalSourceIds.map((sourceId, index) => {
    const nextSourceId = `${layerId}-source-${index}-${sanitizeIdPart(sourceId)}`;
    hostedLayer.setSourceId(sourceId, nextSourceId);
    return nextSourceId;
  });
}

function prefixArcGISStyleLayerIds(hostedLayer: ArcGISRuntimeLayer, layerId: string): string[] {
  const mutableLayers = hostedLayer.layers as maplibregl.LayerSpecification[];
  return mutableLayers.map((styleLayer, index) => {
    const nextLayerId = `${layerId}-layer-${index}-${sanitizeIdPart(styleLayer.id)}`;
    styleLayer.id = nextLayerId;
    return nextLayerId;
  });
}

function addArcGISRuntimeLayerToMap(hostedLayer: ArcGISRuntimeLayer, map: maplibregl.Map): void {
  for (const [sourceId, source] of Object.entries(hostedLayer.sources)) {
    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, source);
    }
  }

  for (const layer of hostedLayer.layers) {
    if (!map.getLayer(layer.id)) {
      map.addLayer(layer);
    }
  }
}

/**
 * Load an ArcGIS FeatureServer layer as a host-managed GeoJSON layer.
 *
 * The features are fetched up front (`/query?f=geojson`, paged — see
 * {@link fetchArcGISFeaturePages}) and handed to the store's GeoJSON layer path,
 * so the layer is a first-class vector layer with its attributes available —
 * enabling labels and their formatting, the attribute table, identify,
 * symbology, and export. Vector tile layers keep the external-native runtime
 * path; only feature layers come through here.
 *
 * @param app - The host app API (used to fit the view to the layer extent).
 * @param options - The ArcGIS layer options (source type, URL/item, token).
 * @param input - The resolved service URL or portal item id from the options.
 * @returns The new GeoLibre layer's id.
 */
async function addArcGISFeatureLayerAsGeoJson(
  app: GeoLibreAppAPI,
  options: ArcGISLayerOptions,
  input: string,
): Promise<string> {
  const layerUrl =
    options.sourceType === "url"
      ? await resolveFeatureLayerUrl(input, options, undefined)
      : await resolvePortalFeatureLayerUrl(input, options, undefined);
  const layerInfo = await fetchArcGISJson<ArcGISFeatureLayerInfo>(layerUrl, options, undefined);
  if (!layerInfo.geometryType) {
    throw new Error("The ArcGIS feature layer metadata is missing geometry type.");
  }

  // The token is kept out of the persisted refresh URL so it is never written
  // to a saved project; it is only appended to the live requests below.
  const queryUrl = `${trimTrailingSlash(layerUrl)}/query`;
  const refreshUrl = appendArcGISParams(queryUrl, {
    f: "geojson",
    outFields: "*",
    returnGeometry: "true",
    where: "1=1",
  });
  const name =
    options.name?.trim() || layerInfo.name || layerNameFromArcGISInput(layerUrl, "ArcGIS Layer");
  const store = useAppStore.getState();
  const map = app.getMap?.();
  // Headless/API consumers have no viewport to query, so retain the complete
  // paged download for them. The interactive app takes the bounded path below.
  const initialData: FeatureCollection = map
    ? { type: "FeatureCollection", features: [] }
    : await fetchArcGISFeaturePages(queryUrl, options, layerInfo);
  // Add the layer before downloading features. Large services must not hold the
  // Add Data dialog open while hundreds of thousands of records are fetched.
  const id = store.addGeoJsonLayer(name, initialData, refreshUrl, options.beforeLayerId ?? null);

  store.updateLayer(id, {
    source: {
      type: "geojson",
      // Preserve the service's copyright watermark in MapLibre's attribution
      // control, matching the prior URL-source behavior.
      attribution: layerInfo.copyrightText?.trim() || undefined,
      // What a refresh needs to replay the same paged download. Re-fetching the
      // stored query URL on its own would shrink the layer back to a single
      // page (the ArcGIS twin of the OGC API - Features case in layer-refresh).
      // The token is deliberately absent: it is never persisted, so refreshing
      // a token-protected layer fails the same way it does today.
      arcgisQueryUrl: queryUrl,
      maxFeatures: options.maxFeatures,
      pageSize: options.pageSize,
    },
    metadata: { sourceKind: ARCGIS_FEATURE_SOURCE_KIND, viewportLoading: Boolean(map) },
  });

  const bounds = arcgisExtentToBounds(layerInfo.extent);
  if (bounds && options.zoomTo !== false) app.fitBounds?.(bounds);
  if (map) startArcGISViewportLoader(id, map, queryUrl, options, () => Promise.resolve(layerInfo));
  return id;
}

/**
 * Keep one FeatureServer layer synchronized with the settled map viewport.
 *
 * `resolveLayerInfo` is a thunk rather than a value so the restore path can
 * register a loader before it has the service metadata: the fetch then happens
 * on the first query, and a failed one is retried by the next.
 */
function startArcGISViewportLoader(
  layerId: string,
  map: maplibregl.Map,
  queryUrl: string,
  options: ArcGISLayerOptions,
  resolveLayerInfo: () => Promise<ArcGISFeatureLayerInfo>,
): void {
  let abort: AbortController | null = null;
  let requestSequence = 0;
  // The Add Data dialog's progress callback belongs to the initial download. It
  // is unmounted well before the first viewport query lands, so carrying it for
  // the layer's lifetime would keep that closure alive to no purpose.
  const queryOptions: ArcGISLayerOptions = { ...options, onProgress: undefined };
  const maxFeatures = positiveInteger(options.maxFeatures);
  const loader: ArcGISViewportLoader = {
    abort: null,
    load: () => Promise.resolve({ type: "FeatureCollection", features: [] }),
    map,
    move: () => undefined,
  };

  /**
   * Query the map's current extent, publishing each page as it lands.
   *
   * Resolves with whatever the layer holds — never rejects, whatever the
   * error — when a newer viewport supersedes the call: the replacement is
   * already publishing, so a failure the superseded request happened to hit
   * (an abort, or a request that failed just before its abort landed) is not
   * this layer's problem. A refresh running concurrently with a pan must not be
   * reported as a failed refresh (and, under an `onFailure` of `"clear"`, wipe
   * a layer that is perfectly healthy).
   */
  const load = async (): Promise<FeatureCollection> => {
    abort?.abort();
    const controller = new AbortController();
    abort = controller;
    loader.abort = controller;
    const sequence = ++requestSequence;
    let layerInfo: ArcGISFeatureLayerInfo;
    try {
      layerInfo = await resolveLayerInfo();
    } catch (error) {
      if (sequence !== requestSequence) return currentArcGISLayerGeojson(layerId);
      throw error;
    }
    const envelopes = arcgisViewportEnvelopes(map.getBounds());
    // One bucket per envelope, so a viewport split across the antimeridian
    // publishes both halves together instead of each replacing the other.
    const pages: Feature[][] = envelopes.map(() => []);
    const collect = (): FeatureCollection => {
      const features = mergeArcGISViewportFeatures(pages, layerInfo.objectIdField);
      // A split viewport issues one request per envelope, each honoring
      // `maxFeatures` on its own, so the merge is trimmed to keep the option a
      // bound on what the layer holds for one viewport rather than per half.
      return {
        type: "FeatureCollection",
        features: maxFeatures === null ? features : features.slice(0, maxFeatures),
      };
    };
    const publish = (): void => {
      if (
        sequence !== requestSequence ||
        !useAppStore.getState().layers.some((l) => l.id === layerId)
      ) {
        return;
      }
      useAppStore.getState().updateLayer(layerId, { geojson: collect() });
      // Clear as soon as the service answers at all, not when the whole walk
      // finishes: a dense extent pages for tens of seconds, and leaving a stale
      // "zoom in" on screen while its features stream in reads as a live error.
      reportArcGISViewportError(layerId, null);
    };
    // `allSettled`, not `all`: a split viewport must not report a failure while
    // its surviving half is still running, or that half's later pages would
    // publish over an already-reported error with nothing to clear it.
    const walk = async (envelope: ArcGISEnvelope, index: number, attempt = 0): Promise<void> => {
      try {
        const data = await fetchArcGISFeaturePages(queryUrl, queryOptions, layerInfo, {
          params: {
            geometry: envelope.join(","),
            geometryType: "esriGeometryEnvelope",
            inSR: "4326",
            spatialRel: "esriSpatialRelIntersects",
          },
          signal: controller.signal,
          onPage: (features) => {
            pages[index] = features;
            publish();
          },
        });
        pages[index] = data.features;
        publish();
      } catch (error) {
        // The service timing out under load is the common failure on a wide
        // extent, and it clears on a retry far more often than not, so one is
        // worth the wait rather than leaving the user an empty layer.
        if (attempt === 0 && !controller.signal.aborted && isArcGISTransientQueryError(error)) {
          return walk(envelope, index, attempt + 1);
        }
        throw error;
      }
    };
    const results = await Promise.allSettled(envelopes.map((e, index) => walk(e, index)));
    if (sequence !== requestSequence) return currentArcGISLayerGeojson(layerId);
    // One half failing still leaves the other's features on the map; the error
    // says the view is incomplete rather than pretending it is whole.
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    reportArcGISViewportError(layerId, null);
    return collect();
  };

  const move = (): void => {
    void load().catch((error: unknown) => {
      // A timeout that survived its retry gets guidance the user can act on;
      // ArcGIS's own wording for it blames the query parameters, which are fine.
      if (isArcGISTransientQueryError(error)) {
        console.error("[GeoLibre] ArcGIS viewport query timed out", error);
        reportArcGISViewportError(layerId, ARCGIS_VIEWPORT_TIMEOUT);
        return;
      }
      handleArcGISViewportError(layerId, error);
    });
  };
  loader.load = load;
  loader.move = move;
  stopArcGISViewportLoader(layerId);
  map.on("moveend", move);
  arcgisFeatureLoaders.set(layerId, loader);
  ensureArcGISFeatureLoaderCleanup();
  // fitBounds may still be animating. Its moveend will replace this first query.
  if (!map.isMoving()) move();
}

/**
 * Re-run the viewport query for a layer that loads by extent.
 *
 * A refresh must not fall back to the unbounded paged download for these
 * layers: that would pull the whole service into memory behind the user's
 * back, which is the very thing viewport loading exists to avoid.
 *
 * @param layerId - The layer to reload.
 * @returns The features for the map's current extent, or `null` when the layer
 *   has no live loader (a project restored from disk, or a headless host).
 */
export function reloadArcGISViewportLayer(layerId: string): Promise<FeatureCollection> | null {
  return arcgisFeatureLoaders.get(layerId)?.load() ?? null;
}

/**
 * Re-attach viewport loaders after a project is loaded.
 *
 * {@link startArcGISViewportLoader} only runs in the Add Data flow, but
 * `metadata.viewportLoading` round-trips through the saved project. Without
 * this, a reopened project's feature layer is frozen on whichever extent was in
 * view when it was saved: panning fetches nothing, and a refresh falls back to
 * the unbounded download the viewport path exists to avoid.
 *
 * Loaders are registered synchronously, before the service metadata they need
 * is fetched, so there is no window in which a refresh finds the layer
 * unbound.
 *
 * @param app - The host app API, for the map the loaders bind to.
 */
export function restoreArcGISViewportLayers(app: GeoLibreAppAPI): void {
  const map = app.getMap?.();
  if (!map) return;
  for (const layer of useAppStore.getState().layers) {
    // Skip only a loader already bound to *this* map: the restore effect also
    // runs when the map is reinitialized, and a loader left on the old instance
    // would listen to a dead map and query its stale bounds.
    if (
      layer.metadata.viewportLoading !== true ||
      layer.metadata.sourceKind !== ARCGIS_FEATURE_SOURCE_KIND ||
      arcgisFeatureLoaders.get(layer.id)?.map === map
    ) {
      continue;
    }
    const source = layer.source as {
      arcgisQueryUrl?: unknown;
      maxFeatures?: unknown;
      pageSize?: unknown;
    };
    const queryUrl = typeof source.arcgisQueryUrl === "string" ? source.arcgisQueryUrl.trim() : "";
    if (!queryUrl) continue;
    const options: ArcGISLayerOptions = {
      layerType: "feature",
      maxFeatures: typeof source.maxFeatures === "number" ? source.maxFeatures : undefined,
      pageSize: typeof source.pageSize === "number" ? source.pageSize : undefined,
      sourceType: "url",
    };
    // Re-read the service metadata rather than trusting a stored copy, the same
    // reason refreshArcGISFeatureLayer does: paging capabilities and
    // `maxRecordCount` are the service's to change between sessions. Fetched
    // lazily on the first query and memoized, with a failure clearing the
    // memo — so a blocked or flaky reopen retries on the next pan or refresh
    // instead of leaving the layer permanently unbound.
    let pending: Promise<ArcGISFeatureLayerInfo> | null = null;
    const resolveLayerInfo = (): Promise<ArcGISFeatureLayerInfo> =>
      (pending ??= fetchArcGISJson<ArcGISFeatureLayerInfo>(
        trimTrailingSlash(queryUrl).replace(/\/query$/i, ""),
        options,
        undefined,
      ).catch((error: unknown) => {
        pending = null;
        throw error;
      }));
    startArcGISViewportLoader(layer.id, map, queryUrl, options, resolveLayerInfo);
  }
}

/**
 * Tear down viewport loaders for layers that have left the store.
 *
 * One shared subscription for every loader, matching
 * {@link ensureArcGISStoreCleanup}: a subscription per layer would run a linear
 * scan of `state.layers` on every unrelated store update for the life of the
 * app, multiplied by however many such layers are open.
 */
function ensureArcGISFeatureLoaderCleanup(): void {
  arcgisFeatureLoaderUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    if (arcgisFeatureLoaders.size === 0) return;
    for (const layer of previous.layers) {
      if (!state.layers.some((current) => current.id === layer.id)) {
        stopArcGISViewportLoader(layer.id);
      }
    }
  });
}

/** Cancel a layer's viewport loader and detach its `moveend` handler. */
function stopArcGISViewportLoader(layerId: string): void {
  const loader = arcgisFeatureLoaders.get(layerId);
  if (!loader) return;
  loader.abort?.abort();
  loader.map.off("moveend", loader.move);
  arcgisFeatureLoaders.delete(layerId);
}

function handleArcGISViewportError(layerId: string, error: unknown): void {
  if (isArcGISAbortError(error)) return;
  console.error("[GeoLibre] ArcGIS viewport query failed", error);
  reportArcGISViewportError(layerId, error instanceof Error ? error.message : String(error));
}

function isArcGISAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Shown when the service gave up on a viewport query. Deliberately not the
 * service's own wording: ArcGIS reports its timeout as a 400 blaming the query
 * parameters, which are correct — the identical request succeeds on a retry.
 */
const ARCGIS_VIEWPORT_TIMEOUT =
  "The ArcGIS service did not return features for this extent in time. Pan or zoom to try again, or zoom in to request fewer features.";

/**
 * Whether a failed query is worth retrying rather than reporting verbatim.
 *
 * A dense feature service can take tens of seconds to answer a geometry-bearing
 * query over a wide envelope, and exceeds its own timeout when it is busy. It
 * reports that either as a gateway/timeout status or — confusingly — as an
 * error envelope with `code` 400 whose detail reads "Unable to perform query.
 * Please check your parameters."
 *
 * Measured against Vicmap_Parcel (GeoLibre#1756): the same 0.25° envelope that
 * failed six times running at ~56s later succeeded three times running in
 * 19-34s. The failure is load, not the request.
 */
function isArcGISTransientQueryError(error: unknown): boolean {
  if (!(error instanceof ArcGISQueryError)) return false;
  if (error.status !== null) return [408, 429, 500, 502, 503, 504].includes(error.status);
  return error.code === 400 && /unable to perform query/i.test(error.message);
}

/** The features a layer currently holds, for a query that has nothing newer. */
function currentArcGISLayerGeojson(layerId: string): FeatureCollection {
  const layer = useAppStore.getState().layers.find((entry) => entry.id === layerId);
  return layer?.geojson ?? { type: "FeatureCollection", features: [] };
}

/**
 * Record a viewport query's outcome on the layer's connection record, which is
 * what the Layers panel already reads to show a synchronization error. Without
 * it a failed pan leaves the previous extent's features on screen with nothing
 * to say the query for the current one never landed.
 */
function reportArcGISViewportError(layerId: string, message: string | null): void {
  const layer = useAppStore.getState().layers.find((l) => l.id === layerId);
  // Only written when the state actually changes, so a successful pan over a
  // healthy layer does not dirty the project on every `moveend`.
  if (!layer || (layer.connection?.lastError ?? null) === message) return;
  useAppStore.getState().updateLayer(layerId, {
    connection: {
      interval: null,
      lastSyncedAt: null,
      onFailure: "keep-last",
      ...layer.connection,
      layerId,
      lastError: message,
    },
  });
}

/** A `[west, south, east, north]` query envelope, in WGS84 degrees. */
type ArcGISEnvelope = [number, number, number, number];

/**
 * The ArcGIS query envelopes covering a map viewport.
 *
 * MapLibre reports the viewport's raw longitudes, which run outside ±180 as
 * soon as the view crosses the antimeridian or the user keeps panning around
 * the globe. Clamping each edge on its own would either invert the envelope
 * (west 170, east -170) or collapse it to zero width (west 200, east 210), and
 * ArcGIS answers both with nothing for that part of the screen. So the span is
 * normalized onto ±180 and, when it straddles the antimeridian, split into the
 * two envelopes that cover it — the same treatment `splitAntimeridian` gives
 * the offline tile download.
 *
 * @param bounds - The map's current bounds.
 * @returns One envelope, or two when the viewport crosses the antimeridian.
 */
function arcgisViewportEnvelopes(bounds: {
  getEast(): number;
  getNorth(): number;
  getSouth(): number;
  getWest(): number;
}): ArcGISEnvelope[] {
  const south = Math.max(-90, Math.min(90, bounds.getSouth()));
  const north = Math.min(90, Math.max(-90, bounds.getNorth()));
  const rawWest = bounds.getWest();
  const rawEast = bounds.getEast();
  if (!Number.isFinite(rawWest) || !Number.isFinite(rawEast)) {
    return [[-180, south, 180, north]];
  }
  // A wrapped viewport reports east < west; unwrap it before measuring the span.
  const span = rawEast >= rawWest ? rawEast - rawWest : rawEast + 360 - rawWest;
  if (span >= 360) return [[-180, south, 180, north]];
  const west = wrapLongitude(rawWest);
  const east = west + span;
  return east > 180
    ? [
        [west, south, 180, north],
        [-180, south, wrapLongitude(east), north],
      ]
    : [[west, south, east, north]];
}

/** Fold a longitude onto ±180, which the map's raw bounds may run past. */
function wrapLongitude(longitude: number): number {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

/**
 * Concatenate the per-envelope results of one viewport query, dropping the
 * duplicate a feature straddling the antimeridian produces by matching both
 * halves. A feature the service gives no identifier for is kept as-is: showing
 * it twice is better than guessing at identity by geometry.
 */
function mergeArcGISViewportFeatures(
  pages: Feature[][],
  objectIdField: string | undefined,
): Feature[] {
  if (pages.length === 1) return [...pages[0]];
  const seen = new Set<string>();
  const merged: Feature[] = [];
  for (const page of pages) {
    for (const feature of page) {
      const key = arcgisFeatureKey(feature, objectIdField);
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      merged.push(feature);
    }
  }
  return merged;
}

function arcgisFeatureKey(feature: Feature, objectIdField: string | undefined): string | null {
  if (typeof feature.id === "string" || typeof feature.id === "number") return String(feature.id);
  const value = objectIdField ? feature.properties?.[objectIdField] : undefined;
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

/**
 * Load an ArcGIS MapServer or ImageServer as a raster tile layer.
 *
 * Both services answer with rendered images rather than data, so neither has a
 * useful GeoJSON or vector-tile form. They become an ordinary `raster` layer,
 * which is what makes the whole raster surface (opacity, the Style panel's
 * raster adjustments, reordering, project save and reload) work on them with no
 * dedicated handler anywhere else in the app.
 *
 * Two tile strategies, chosen from the service's own metadata:
 *
 * - **Cached tiles** (`/tile/{z}/{y}/{x}`) when the service advertises a fused
 *   cache built on the standard Web Mercator scheme. These are pre-rendered and
 *   CDN-friendly, so they are used whenever they are available and applicable.
 * - **Dynamic export** (`/export` for MapServer, `/exportImage` for ImageServer)
 *   otherwise, as a `{bbox-epsg-3857}` request template — the same mechanism
 *   GeoLibre's WMS layers use. This is also forced when the caller picked
 *   sublayers or a rendering rule, because a cache was rendered before either
 *   choice existed and cannot honor it.
 *
 * @param app - The host app API (used to fit the view to the service extent).
 * @param options - The ArcGIS layer options (source type, URL/item, token).
 * @param input - The resolved service URL or portal item id from the options.
 * @returns The new GeoLibre layer's id.
 */
async function addArcGISImageServiceLayer(
  app: GeoLibreAppAPI,
  options: ArcGISLayerOptions,
  input: string,
): Promise<string> {
  const resolved =
    options.sourceType === "url"
      ? resolveArcGISImageServiceUrl(input, options.layerType)
      : await resolvePortalArcGISImageServiceUrl(input, options);
  const { serviceUrl } = resolved;
  const info = await fetchArcGISJson<ArcGISImageProducingServiceInfo>(
    serviceUrl,
    options,
    undefined,
  );

  // Each option belongs to exactly one of the two service types, and the Add
  // Data form keeps both field values when the layer type is switched (so the
  // user's typing survives a change of mind). Reading only the applicable one
  // keeps a leftover rendering rule from blocking a MapServer submission — or,
  // when it happens to be valid JSON, from silently costing it its tile cache.
  const sublayers =
    options.layerType === "map-service"
      ? // A sublayer id read off the pasted URL is a default: the explicit field
        // wins when the user filled both in.
        (normalizeArcGISSublayers(options.sublayers) ?? resolved.sublayers)
      : undefined;
  const renderingRule =
    options.layerType === "image-service"
      ? validArcGISRenderingRule(options.renderingRule)
      : undefined;
  const token = options.token?.trim() || undefined;

  // Sublayers and rendering rules are dynamic-only, so the cache is only an
  // option when neither was asked for.
  const tileScheme = sublayers || renderingRule ? null : arcgisTileScheme(info);
  const tiles = tileScheme
    ? arcgisCachedTileUrl(serviceUrl, token)
    : arcgisExportTileUrl(serviceUrl, {
        layerType: options.layerType,
        renderingRule,
        sublayers,
        token,
      });

  const bounds =
    arcgisExtentToBounds(info.fullExtent ?? info.initialExtent ?? info.extent) ??
    (options.layerType === "map-service"
      ? await resolveArcGISMapServiceBounds(serviceUrl, info, options, sublayers)
      : undefined);
  const attribution = info.copyrightText?.trim() || undefined;
  const id = createArcGISLayerId();
  const layer: GeoLibreLayer = {
    id,
    name: options.name?.trim() || layerNameFromArcGISInput(serviceUrl, "ArcGIS Layer"),
    type: "raster",
    source: {
      type: "raster",
      tiles: [tiles],
      tileSize: tileScheme?.tileSize ?? ARCGIS_EXPORT_TILE_SIZE,
      ...(bounds ? { bounds } : {}),
      ...(attribution ? { attribution } : {}),
      ...(tileScheme ? { minzoom: tileScheme.minzoom, maxzoom: tileScheme.maxzoom } : {}),
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      arcgisLayerType: options.layerType,
      arcgisSourceType: options.sourceType,
      arcgisTiled: tileScheme !== null,
      ...(bounds ? { bounds } : {}),
      // The token has to travel in the tile URL for the tiles to render at all,
      // unlike the feature path where it is only on the live requests. It is
      // flagged here for the same reason the vector-tile path flags it, and
      // `redactCredentials` (core) strips the `token` parameter from any project
      // that leaves the app through sharing, embedding, or collaboration.
      hasAccessToken: Boolean(token),
      ...(options.sourceType === "portal-item" ? { itemId: input } : {}),
      ...(options.portalUrl?.trim() ? { portalUrl: options.portalUrl.trim() } : {}),
      ...(renderingRule ? { arcgisRenderingRule: renderingRule } : {}),
      ...(sublayers ? { arcgisSublayers: sublayers } : {}),
      sourceKind:
        options.layerType === "image-service"
          ? ARCGIS_IMAGE_SERVICE_SOURCE_KIND
          : ARCGIS_MAP_SERVICE_SOURCE_KIND,
    },
    sourcePath: serviceUrl,
  };

  useAppStore.getState().addLayer(layer, options.beforeLayerId ?? null);
  if (bounds && options.zoomTo !== false) app.fitBounds?.(bounds);
  return id;
}

/**
 * Ask selected MapServer layers to project their data extents to WGS84.
 *
 * ArcGIS services frequently publish in a local projected CRS whose WKID is
 * not built into the browser. The server already owns the datum transform, so
 * `/query?returnExtentOnly=true&outSR=4326` is both more reliable and much
 * cheaper than downloading features merely to derive a camera target.
 */
async function resolveArcGISMapServiceBounds(
  serviceUrl: string,
  info: ArcGISImageProducingServiceInfo,
  options: ArcGISLayerOptions,
  sublayers: string | undefined,
): Promise<[number, number, number, number] | undefined> {
  const requestedIds = sublayers?.split(",").map(Number);
  const ids =
    requestedIds ??
    (info.layers ?? [])
      .filter(
        (layer) =>
          layer.defaultVisibility !== false &&
          (!Array.isArray(layer.subLayerIds) || layer.subLayerIds.length === 0),
      )
      .map((layer) => layer.id)
      .filter((id): id is number => Number.isSafeInteger(id) && (id ?? -1) >= 0);
  if (ids.length === 0) return undefined;

  const extents: Array<[number, number, number, number]> = [];
  // Keep request pressure modest for public ArcGIS servers with many layers.
  for (let index = 0; index < ids.length; index += 6) {
    const batch = await Promise.allSettled(
      ids.slice(index, index + 6).map(async (id) => {
        const queryUrl = appendArcGISParams(`${serviceUrl}/${id}/query`, {
          f: "json",
          outSR: "4326",
          returnExtentOnly: "true",
          where: "1=1",
        });
        const result = await fetchArcGISJson<{ extent?: ArcGISExtent }>(
          queryUrl,
          options,
          undefined,
        );
        return arcgisExtentToBounds(result.extent);
      }),
    );
    for (const result of batch) {
      if (result.status === "fulfilled" && result.value) extents.push(result.value);
    }
  }
  if (extents.length === 0) return undefined;
  return extents.reduce<[number, number, number, number]>(
    (union, bounds) => [
      Math.min(union[0], bounds[0]),
      Math.min(union[1], bounds[1]),
      Math.max(union[2], bounds[2]),
      Math.max(union[3], bounds[3]),
    ],
    [...extents[0]],
  );
}

/**
 * Validate a MapServer/ImageServer URL and split off a trailing sublayer id.
 *
 * `/export` and `/exportImage` live on the service root, so a URL that points at
 * one MapServer sublayer (`.../MapServer/3`, which is what the REST directory
 * links to) is rewritten to the root plus a `show:3` sublayer selection rather
 * than rejected.
 *
 * @param input - The URL the caller supplied.
 * @param layerType - Which of the two service types is expected.
 * @returns The service root URL and any sublayer id read from the input.
 */
function resolveArcGISImageServiceUrl(
  input: string,
  layerType: ArcGISLayerType,
): { serviceUrl: string; sublayers?: string } {
  // A URL copied from the REST directory often carries `?f=html` (or a token);
  // the query is rebuilt from scratch below, so drop whatever came in.
  const url = trimTrailingSlash(stripArcGISUrlQuery(input));
  if (layerType === "image-service") {
    if (!/\/ImageServer$/i.test(url)) {
      throw new Error(ARCGIS_IMAGE_SERVICE_URL_ERROR);
    }
    return { serviceUrl: url };
  }

  const match = /^(.*\/MapServer)(?:\/(\d+))?$/i.exec(url);
  if (!match) {
    throw new Error(ARCGIS_MAP_SERVICE_URL_ERROR);
  }
  return { serviceUrl: match[1], ...(match[2] ? { sublayers: match[2] } : {}) };
}

/** Resolves a portal item to the MapServer/ImageServer URL it points at. */
async function resolvePortalArcGISImageServiceUrl(
  itemId: string,
  options: ArcGISLayerOptions,
): Promise<{ serviceUrl: string; sublayers?: string }> {
  const itemInfo = await fetchArcGISPortalItemInfo(itemId, options, undefined);
  if (!itemInfo.url) {
    throw new Error("The ArcGIS portal item does not include a service URL.");
  }
  return resolveArcGISImageServiceUrl(itemInfo.url, options.layerType);
}

function stripArcGISUrlQuery(input: string): string {
  const trimmed = input.trim();
  const cut = trimmed.search(/[?#]/);
  return cut === -1 ? trimmed : trimmed.slice(0, cut);
}

/**
 * Normalize a sublayer selection to the comma-separated id list ArcGIS takes.
 *
 * A non-numeric entry throws rather than being dropped: silently ignoring it
 * would draw the service's default sublayers, which looks like the selection
 * was honored.
 *
 * @param value - The caller's raw `sublayers` input.
 * @returns The normalized id list, or undefined when nothing was selected.
 * @throws If the input contains anything that is not a sublayer id.
 */
function normalizeArcGISSublayers(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const ids = trimmed.split(/[\s,]+/).filter(Boolean);
  if (!ids.every((id) => /^\d+$/.test(id))) {
    throw new Error("Enter the MapServer sublayers as numeric ids, for example 0,2,5.");
  }
  return ids.join(",");
}

/**
 * Validate an ImageServer rendering rule. ArcGIS answers an unparseable rule
 * with an error image on every tile, so a bad rule is rejected up front where
 * the message can still reach the dialog.
 *
 * @param value - The caller's raw `renderingRule` input.
 * @returns The trimmed rule JSON, or undefined when none was supplied.
 * @throws If the rule is not valid JSON.
 */
function validArcGISRenderingRule(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    JSON.parse(trimmed);
  } catch {
    throw new Error('The rendering rule must be JSON, for example {"rasterFunction":"Hillshade"}.');
  }
  return trimmed;
}

/**
 * The `/tile/{z}/{y}/{x}` template for a cached service.
 *
 * Built by hand rather than through `appendArcGISParams`: the WHATWG URL parser
 * percent-encodes the braces, and MapLibre only substitutes literal `{z}`/`{x}`/
 * `{y}` placeholders.
 */
function arcgisCachedTileUrl(serviceUrl: string, token: string | undefined): string {
  const template = `${trimTrailingSlash(serviceUrl)}/tile/{z}/{y}/{x}`;
  return token ? `${template}?token=${encodeURIComponent(token)}` : template;
}

/**
 * The `/export` (MapServer) or `/exportImage` (ImageServer) request template for
 * a service with no usable cache, as a MapLibre `{bbox-epsg-3857}` raster tile
 * URL. `png32` with `transparent=true` keeps the service drawable as an overlay
 * over the basemap rather than an opaque sheet.
 */
function arcgisExportTileUrl(
  serviceUrl: string,
  options: {
    layerType: ArcGISLayerType;
    renderingRule: string | undefined;
    sublayers: string | undefined;
    token: string | undefined;
  },
): string {
  const isImageService = options.layerType === "image-service";
  const size = `${ARCGIS_EXPORT_TILE_SIZE},${ARCGIS_EXPORT_TILE_SIZE}`;
  const params: Array<[string, string]> = [
    ["bbox", "{bbox-epsg-3857}"],
    ["bboxSR", "3857"],
    ["imageSR", "3857"],
    ["size", size],
    ["format", "png32"],
    ["transparent", "true"],
  ];
  if (!isImageService) params.push(["dpi", "96"]);
  if (!isImageService && options.sublayers) params.push(["layers", `show:${options.sublayers}`]);
  if (isImageService && options.renderingRule) {
    params.push(["renderingRule", options.renderingRule]);
  }
  if (options.token) params.push(["token", options.token]);
  params.push(["f", "image"]);

  const query = params
    // The bbox placeholder is the one value MapLibre substitutes, so it has to
    // survive as literal braces; everything else is encoded normally.
    .map(
      ([key, value]) =>
        `${key}=${value === "{bbox-epsg-3857}" ? value : encodeURIComponent(value)}`,
    )
    .join("&");
  return `${trimTrailingSlash(serviceUrl)}/${isImageService ? "exportImage" : "export"}?${query}`;
}

/**
 * Read a service's tile cache as an XYZ scheme, when it is one.
 *
 * A fused cache is only usable as a MapLibre raster source if it was built on
 * the standard Web Mercator scheme: the same projection, the same top-left
 * origin, and resolutions that halve per level from the world-in-one-tile
 * level 0. Caches in other projections or with custom LOD tables exist and would
 * render misaligned, so anything that does not match falls back to `/export`,
 * which is correct for every service.
 *
 * @param info - The service's `?f=json` description.
 * @returns The tile size and zoom range, or null when the cache is not usable.
 */
function arcgisTileScheme(info: ArcGISImageProducingServiceInfo): ArcGISTileScheme | null {
  const tileInfo = info.tileInfo;
  if (info.singleFusedMapCache !== true || !tileInfo) return null;

  const wkid = tileInfo.spatialReference?.latestWkid ?? tileInfo.spatialReference?.wkid;
  if (wkid !== 3857 && wkid !== 102100 && wkid !== 102113) return null;

  const tileSize = tileInfo.cols;
  if (typeof tileSize !== "number" || tileSize !== tileInfo.rows) return null;
  if (tileSize !== 256 && tileSize !== 512) return null;

  // Both axes: a cache anchored at the correct left edge but a different top
  // edge would line up horizontally and be off vertically, which reads as
  // imagery that is subtly in the wrong place rather than as an obvious break.
  // One metre of slack, since services round the origin to varying precision.
  const originX = tileInfo.origin?.x;
  const originY = tileInfo.origin?.y;
  if (typeof originX !== "number" || Math.abs(originX - WEB_MERCATOR_ORIGIN_X) > 1) return null;
  if (typeof originY !== "number" || Math.abs(originY - WEB_MERCATOR_ORIGIN_Y) > 1) return null;

  const levels = (tileInfo.lods ?? []).filter(
    (lod): lod is { level: number; resolution: number } =>
      typeof lod.level === "number" &&
      Number.isFinite(lod.level) &&
      typeof lod.resolution === "number" &&
      lod.resolution > 0,
  );
  if (levels.length === 0) return null;

  // Compare against the standard resolution for each level rather than assuming
  // the cache starts at level 0 — plenty of caches begin partway down.
  const level0Resolution = WEB_MERCATOR_LEVEL0_RESOLUTION * (256 / tileSize);
  const matchesScheme = levels.every((lod) => {
    const expected = level0Resolution / 2 ** lod.level;
    return Math.abs(lod.resolution - expected) / expected < 0.01;
  });
  if (!matchesScheme) return null;

  return {
    maxzoom: Math.max(...levels.map((lod) => lod.level)),
    minzoom: Math.min(...levels.map((lod) => lod.level)),
    tileSize,
  };
}

/**
 * Re-download an ArcGIS feature layer, replaying the paging it was added with.
 *
 * A refresh cannot just re-fetch the layer's stored `sourcePath`: that URL is
 * the unbounded `where=1=1` query, which is the very request that truncates at
 * `maxRecordCount` or fails outright on a large service (GeoLibre#1745). Going
 * back through {@link fetchArcGISFeaturePages} keeps a refreshed layer the same
 * size as the one that was added.
 *
 * @param params - The paging state persisted on the layer's source.
 * @returns The re-downloaded features.
 */
export async function refreshArcGISFeatureLayer(params: {
  maxFeatures?: number;
  pageSize?: number;
  queryUrl: string;
}): Promise<FeatureCollection> {
  const queryUrl = trimTrailingSlash(params.queryUrl).replace(/\/query$/i, "");
  const options: ArcGISLayerOptions = {
    layerType: "feature",
    maxFeatures: params.maxFeatures,
    pageSize: params.pageSize,
    sourceType: "url",
  };
  // Re-read the metadata rather than trusting a stored copy: `maxRecordCount`
  // and the paging capabilities are the service's to change between sessions.
  const layerInfo = await fetchArcGISJson<ArcGISFeatureLayerInfo>(queryUrl, options, undefined);
  return fetchArcGISFeaturePages(`${queryUrl}/query`, options, layerInfo);
}

/**
 * Everything the paging strategies need, resolved once from the layer metadata.
 */
interface ArcGISPagingPlan {
  /** Hard cap on features to keep, or `null` for the whole layer. */
  maxFeatures: number | null;
  /** The layer's ObjectID field, when the service names one. */
  objectIdField: string | undefined;
  onProgress: ArcGISLayerOptions["onProgress"];
  onPage?: (features: Feature[]) => void;
  /** Features to request per `/query` call. */
  pageSize: number;
  /** Query params every page shares (including the token, if any). */
  params: Record<string, string | undefined>;
  /** The `/query` endpoint, without paging params. */
  queryUrl: string;
  signal?: AbortSignal;
  /** Whether the service claims to honor `resultOffset`. */
  supportsPagination: boolean;
  /** Whether the service accepts `orderByFields` (needed for stable paging). */
  supportsOrderBy: boolean;
  /** The service's feature count, or `null` when it would not report one. */
  total: number | null;
}

/**
 * Download every feature of an ArcGIS feature layer, one page at a time.
 *
 * A single unbounded `where=1=1` query is what the old code sent, and it does
 * not scale: past some layer size the service either truncates the result at
 * `maxRecordCount` (loading a silently partial layer) or gives up entirely with
 * an HTTP 500 (GeoLibre#1745). Paging keeps every individual request small
 * enough for the service to answer, so the layer that used to fail outright now
 * loads in full.
 *
 * Two strategies, because not every service supports the first:
 *
 * - `resultOffset`/`resultRecordCount` paging, when the layer advertises
 *   `advancedQueryCapabilities.supportsPagination` (ArcGIS 10.3+). Cheapest —
 *   no extra round trip.
 * - ObjectID-range paging otherwise: ask for the layer's ObjectIDs
 *   (`returnIdsOnly`), then walk them in sorted chunks with a
 *   `<oidField> >= a AND <oidField> <= b` filter. Works on any service that can
 *   run a query at all, which is what older ArcGIS Server deployments need.
 *
 * A service that advertises pagination but ignores `resultOffset` would page
 * forever over the same rows, so that is detected (each page's first feature is
 * compared with the previous page's) and falls back to the ObjectID walk.
 *
 * @param queryUrl - The layer's `/query` endpoint, with no query string.
 * @param options - The ArcGIS layer options (token, page size, feature cap).
 * @param layerInfo - The layer's `?f=json` metadata.
 * @returns Every feature the service returned, as one FeatureCollection.
 */
async function fetchArcGISFeaturePages(
  queryUrl: string,
  options: ArcGISLayerOptions,
  layerInfo: ArcGISFeatureLayerInfo,
  request: {
    params?: Record<string, string>;
    signal?: AbortSignal;
    onPage?: (features: Feature[]) => void;
  } = {},
): Promise<FeatureCollection> {
  const plan = await planArcGISPaging(queryUrl, options, layerInfo, request);

  if (plan.supportsPagination) {
    const paged = await fetchArcGISPagesByOffset(plan);
    if (!paged.truncated) return finishArcGISPaging(plan, paged.features, false);
    // The service advertised `supportsPagination` but handed back the same rows
    // for a second offset. Walking ObjectIDs does not rely on that promise.
    const byObjectId = await fetchArcGISPagesByObjectId(plan);
    if (byObjectId) return finishArcGISPaging(plan, byObjectId.features, byObjectId.truncated);
    return finishArcGISPaging(plan, paged.features, true);
  }

  const byObjectId = await fetchArcGISPagesByObjectId(plan);
  if (byObjectId) return finishArcGISPaging(plan, byObjectId.features, byObjectId.truncated);
  // No usable ObjectIDs either. Try offset paging anyway — plenty of services
  // honor it without advertising it — and accept a single page if they do not.
  const paged = await fetchArcGISPagesByOffset(plan);
  return finishArcGISPaging(plan, paged.features, paged.truncated);
}

async function planArcGISPaging(
  queryUrl: string,
  options: ArcGISLayerOptions,
  layerInfo: ArcGISFeatureLayerInfo,
  request: {
    params?: Record<string, string>;
    signal?: AbortSignal;
    onPage?: (features: Feature[]) => void;
  },
): Promise<ArcGISPagingPlan> {
  const params = {
    f: "geojson",
    outFields: "*",
    returnGeometry: "true",
    where: "1=1",
    token: options.token?.trim() || undefined,
    ...request.params,
  };
  return {
    maxFeatures: positiveInteger(options.maxFeatures),
    objectIdField: layerInfo.objectIdField?.trim() || undefined,
    onProgress: options.onProgress,
    onPage: request.onPage,
    pageSize: resolveArcGISPageSize(options.pageSize, layerInfo.maxRecordCount),
    params,
    queryUrl,
    signal: request.signal,
    supportsPagination: layerInfo.advancedQueryCapabilities?.supportsPagination === true,
    supportsOrderBy: layerInfo.advancedQueryCapabilities?.supportsOrderBy !== false,
    // Spatial counts can be as expensive as fetching the first page on large
    // polygon services. Start rendering immediately for viewport queries.
    total: request.params ? null : await fetchArcGISFeatureCount(queryUrl, params),
  };
}

/**
 * The page size to request.
 *
 * A caller-supplied size wins (that is the point of the Add Data field), but is
 * still held under the service's own `maxRecordCount` — asking for more only
 * gets the cap back, and would make a truncated page look like the last one.
 *
 * @param requested - The caller's `pageSize` option, if any.
 * @param maxRecordCount - The service's advertised per-query ceiling, if any.
 */
function resolveArcGISPageSize(
  requested: number | undefined,
  maxRecordCount: number | undefined,
): number {
  const serviceCap = positiveInteger(maxRecordCount);
  const wanted = positiveInteger(requested) ?? DEFAULT_ARCGIS_PAGE_SIZE;
  return serviceCap ? Math.min(wanted, serviceCap) : wanted;
}

function positiveInteger(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : null;
}

/**
 * The layer's feature count, used for progress reporting and as a stop
 * condition. Best-effort: a service that will not answer `returnCountOnly`
 * still pages fine, so any failure resolves to `null` rather than throwing.
 *
 * Takes no abort signal, and needs none: {@link planArcGISPaging} skips the
 * count entirely for a viewport query (the only cancellable caller), because a
 * spatial count can cost as much as the first page.
 *
 * @param queryUrl - The layer's `/query` endpoint.
 * @param params - The query params every request in the plan shares.
 */
async function fetchArcGISFeatureCount(
  queryUrl: string,
  params: Record<string, string | undefined>,
): Promise<number | null> {
  try {
    const response = await fetch(
      appendArcGISParams(queryUrl, {
        ...params,
        f: "json",
        returnCountOnly: "true",
        where: "1=1",
      }),
    );
    if (!response.ok) return null;
    const json = (await response.json()) as { count?: unknown };
    return typeof json.count === "number" && Number.isFinite(json.count) && json.count >= 0
      ? json.count
      : null;
  } catch {
    return null;
  }
}

/**
 * Page with `resultOffset`/`resultRecordCount`.
 *
 * @param plan - The resolved paging plan.
 * @returns The features collected, plus whether the walk stopped with rows the
 *   service still had — either because it was caught ignoring `resultOffset`
 *   (the features are then only the first page, and the caller should try
 *   another strategy) or because the page guard tripped.
 */
async function fetchArcGISPagesByOffset(
  plan: ArcGISPagingPlan,
): Promise<{ features: Feature[]; truncated: boolean }> {
  const features: Feature[] = [];
  // Paging is only coherent over a stable sort. Services default to ObjectID
  // order, but say so explicitly when the layer names an ObjectID field and
  // accepts `orderByFields`, so pages cannot overlap or skip rows.
  const orderByFields = plan.supportsOrderBy && plan.objectIdField ? plan.objectIdField : undefined;
  let previousSignature: string | null = null;
  let pageSize = plan.pageSize;

  for (let page = 0; ; page += 1) {
    if (page >= MAX_ARCGIS_PAGES) return { features, truncated: true };

    const wanted = remainingArcGISFeatures(plan, features.length, pageSize);
    if (wanted <= 0) break;

    const chunk = await fetchArcGISGeoJson(
      appendArcGISParams(plan.queryUrl, {
        ...plan.params,
        orderByFields,
        resultOffset: String(features.length),
        resultRecordCount: String(wanted),
      }),
      plan.signal,
    );
    if (chunk.features.length === 0) break;

    const signature = arcgisPageSignature(chunk.features[0]);
    if (page > 0 && signature !== null && signature === previousSignature) {
      // The same first row came back for a different offset: the service is
      // ignoring `resultOffset`, so every further page would be this one again.
      return { features: features.slice(0, plan.pageSize), truncated: true };
    }
    previousSignature = signature;

    features.push(...chunk.features);
    plan.onPage?.(features);
    plan.onProgress?.(features.length, plan.total);

    if (plan.total !== null && features.length >= plan.total) break;
    if (chunk.features.length >= wanted) continue;
    // A short page normally means the last one — unless the service flagged the
    // transfer limit, which means it capped the page below what was asked for.
    // Adopt its cap and keep going rather than stopping on a partial dataset.
    if (!chunk.exceededTransferLimit) break;
    pageSize = chunk.features.length;
  }

  return { features, truncated: false };
}

/**
 * Page by walking the layer's ObjectIDs in sorted chunks.
 *
 * The chunks are expressed as an inclusive `>= a AND <= b` range rather than an
 * `objectIds=` list so the request URL stays short whatever the page size.
 * Because the range is cut from the service's own complete, sorted ID list, it
 * selects exactly that chunk.
 *
 * @param plan - The resolved paging plan.
 * @returns The features collected, plus whether the page guard stopped the walk
 *   with ObjectIDs still unread; `null` when the service would not list its
 *   ObjectIDs at all (so the caller can fall back).
 */
async function fetchArcGISPagesByObjectId(
  plan: ArcGISPagingPlan,
): Promise<{ features: Feature[]; truncated: boolean } | null> {
  const idInfo = await fetchArcGISObjectIds(plan);
  if (!idInfo || idInfo.objectIds.length === 0) return null;

  const { field, objectIds } = idInfo;
  const features: Feature[] = [];
  let pageSize = plan.pageSize;
  let start = 0;

  for (let page = 0; start < objectIds.length; page += 1) {
    // Stopping here leaves ObjectIDs unread, so say so: without a `total` to
    // compare against, that is the only signal the layer is short.
    if (page >= MAX_ARCGIS_PAGES) return { features, truncated: true };

    const wanted = remainingArcGISFeatures(plan, features.length, pageSize);
    if (wanted <= 0) break;

    const end = Math.min(start + wanted, objectIds.length);
    const chunk = await fetchArcGISGeoJson(
      appendArcGISParams(plan.queryUrl, {
        ...plan.params,
        where: `${field} >= ${objectIds[start]} AND ${field} <= ${objectIds[end - 1]}`,
      }),
      plan.signal,
    );

    // The range spans `end - start` ObjectIDs, so a shorter capped page would
    // silently drop the rest of them — the ids are consumed by advancing past
    // the range, not by what came back. Reachable whenever the page size
    // exceeds the service's real cap, which is what happens when the layer
    // metadata omits `maxRecordCount`. Adopt the cap and redo this range at the
    // smaller size rather than advancing over the ids that were not returned.
    if (chunk.exceededTransferLimit && chunk.features.length > 0) {
      if (chunk.features.length < end - start) {
        pageSize = chunk.features.length;
        continue;
      }
    }

    features.push(...chunk.features);
    plan.onPage?.(features);
    start = end;
    plan.onProgress?.(features.length, plan.total ?? objectIds.length);
  }
  // Ran to the end of the id list, or stopped on the caller's `maxFeatures`
  // cap — which `finishArcGISPaging` reports on its own.
  return { features, truncated: false };
}

async function fetchArcGISObjectIds(
  plan: ArcGISPagingPlan,
): Promise<{ field: string; objectIds: number[] } | null> {
  try {
    const response = await fetch(
      appendArcGISParams(plan.queryUrl, {
        ...plan.params,
        f: "json",
        returnIdsOnly: "true",
        where: "1=1",
      }),
      { signal: plan.signal },
    );
    if (!response.ok) return null;
    const json = (await response.json()) as {
      objectIdFieldName?: unknown;
      objectIds?: unknown;
    };
    if (!Array.isArray(json.objectIds)) return null;
    const objectIds = json.objectIds
      .filter((id): id is number => typeof id === "number" && Number.isFinite(id))
      .sort((a, b) => a - b);
    const field =
      (typeof json.objectIdFieldName === "string" ? json.objectIdFieldName.trim() : "") ||
      plan.objectIdField;
    return field && objectIds.length > 0 ? { field, objectIds } : null;
  } catch (error) {
    if (plan.signal?.aborted) throw error;
    return null;
  }
}

/** Features still wanted for this page, honoring the caller's `maxFeatures`. */
function remainingArcGISFeatures(plan: ArcGISPagingPlan, loaded: number, pageSize: number): number {
  return plan.maxFeatures === null ? pageSize : Math.min(pageSize, plan.maxFeatures - loaded);
}

/**
 * A cheap identity for a page's first feature, used to catch a service that
 * ignores `resultOffset` and keeps replaying the same page. Prefers the GeoJSON
 * `id` (which ArcGIS populates from the ObjectID); properties are the fallback
 * because they are small next to a polygon's coordinates.
 */
function arcgisPageSignature(feature: Feature | undefined): string | null {
  if (!feature) return null;
  if (feature.id !== undefined && feature.id !== null) return `id:${String(feature.id)}`;
  if (feature.properties && Object.keys(feature.properties).length > 0) {
    return `p:${JSON.stringify(feature.properties)}`;
  }
  return feature.geometry ? `g:${JSON.stringify(feature.geometry)}` : null;
}

/**
 * Wrap the collected features and report anything the user should know about
 * the result being short of the whole layer. A partial layer still loads — it
 * is better than nothing, and matches what the single-query path used to do —
 * but the shortfall is surfaced so a partial attribute table or export is not
 * mistaken for the complete dataset.
 *
 * @param plan - The resolved paging plan.
 * @param features - The features collected.
 * @param truncated - Whether the walk gave up with rows still unread.
 */
function finishArcGISPaging(
  plan: ArcGISPagingPlan,
  features: Feature[],
  truncated: boolean,
): FeatureCollection {
  if (plan.maxFeatures !== null && features.length >= plan.maxFeatures) {
    console.warn(
      `[GeoLibre] ArcGIS feature download stopped at the requested maximum of ` +
        `${plan.maxFeatures} features (partial dataset).`,
    );
  } else if (truncated || (plan.total !== null && features.length < plan.total)) {
    const of = plan.total === null ? "" : ` of ${plan.total}`;
    console.warn(
      `[GeoLibre] ArcGIS feature query was truncated: loaded ${features.length}${of} ` +
        `features (partial dataset).`,
    );
  }
  return { type: "FeatureCollection", features };
}

/** The JSON error envelope ArcGIS returns, usually with an HTTP 200 status. */
interface ArcGISErrorEnvelope {
  code?: unknown;
  message?: string;
  details?: unknown;
}

/**
 * A `/query` the service answered with a failure, carrying enough of that
 * failure to tell "this extent is too much for me" apart from a fault the user
 * could act on differently. ArcGIS reports the former either as a gateway
 * timeout or — confusingly — as an error envelope whose `code` is 400 and whose
 * detail blames the parameters, which are in fact fine: the identical query
 * over a smaller extent succeeds.
 */
class ArcGISQueryError extends Error {
  /** HTTP status, when the transport itself failed. */
  readonly status: number | null;
  /** `error.code` from an ArcGIS error envelope returned with HTTP 200. */
  readonly code: number | null;
  constructor(message: string, source: { status?: number | null; code?: number | null } = {}) {
    super(message);
    this.name = "ArcGISQueryError";
    this.status = source.status ?? null;
    this.code = source.code ?? null;
  }
}

/**
 * The most specific text available from an ArcGIS error envelope.
 *
 * `message` is frequently an empty string, with the only useful text in
 * `details` — asking a hosted FeatureServer for a layer id it does not have
 * answers `{"code":400,"message":"","details":["The requested layer (layerId:
 * 0) was not found."]}`. Reading `message` alone drops that and reports the
 * generic fallback, which says nothing about what to correct.
 *
 * @param error - The `error` member of an ArcGIS JSON response.
 * @param fallback - The message to use when the envelope carries no text.
 */
function arcgisErrorMessage(error: ArcGISErrorEnvelope | undefined, fallback: string): string {
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  if (message) return message;
  const details = Array.isArray(error?.details)
    ? error.details.filter(
        (detail): detail is string => typeof detail === "string" && detail.trim() !== "",
      )
    : [];
  return details.length > 0 ? details.join(" ").trim() : fallback;
}

/**
 * Fetch and validate one page of GeoJSON from an ArcGIS query URL.
 *
 * ArcGIS can answer a `f=geojson` request with a JSON error envelope rather than
 * GeoJSON, so both the transport status and the payload shape are checked.
 *
 * @param url - The fully-built `/query?f=geojson` request URL.
 * @returns The parsed FeatureCollection, with the service's
 *   `exceededTransferLimit` flag normalized onto it for the paging loop.
 */
async function fetchArcGISGeoJson(
  url: string,
  signal?: AbortSignal,
): Promise<FeatureCollection & { exceededTransferLimit: boolean }> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new ArcGISQueryError(`ArcGIS feature query failed with ${response.status}.`, {
      status: response.status,
    });
  }
  // ArcGIS Enterprise (and services behind a WAF) can answer 200 with an HTML
  // login/redirect page when a token is missing or expired. Read the body as
  // text first so that surfaces as a clear message instead of a raw
  // `SyntaxError: Unexpected token '<'` from JSON.parse.
  const text = await response.text();
  if (/^\s*</.test(text)) {
    throw new Error(
      "The ArcGIS service returned HTML instead of GeoJSON (the layer may require a token or sign-in).",
    );
  }
  let json: FeatureCollection & {
    error?: ArcGISErrorEnvelope;
    exceededTransferLimit?: boolean;
    properties?: { exceededTransferLimit?: boolean };
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("The ArcGIS feature layer did not return GeoJSON features.");
  }
  if (json.error) {
    throw new ArcGISQueryError(arcgisErrorMessage(json.error, "ArcGIS feature query failed."), {
      code: typeof json.error.code === "number" ? json.error.code : null,
    });
  }
  if (json.type !== "FeatureCollection" || !Array.isArray(json.features)) {
    throw new Error("The ArcGIS feature layer did not return GeoJSON features.");
  }
  // ArcGIS caps a single query at the service's maxRecordCount and flags the
  // shortfall with `exceededTransferLimit`. In `f=geojson` output that flag is
  // not always where the `f=json` output puts it — some servers only nest it
  // under `properties` (GeoJSON has no place for a top-level extension member),
  // so both are read. The paging loop uses it to tell a capped page from the
  // genuinely last one.
  return {
    ...json,
    exceededTransferLimit: Boolean(
      json.exceededTransferLimit || json.properties?.exceededTransferLimit,
    ),
  };
}

async function resolveFeatureLayerUrl(
  input: string,
  options: ArcGISLayerOptions,
  cause: unknown,
): Promise<string> {
  if (/\/FeatureServer\/\d+\/?$/i.test(input)) return trimTrailingSlash(input);
  if (!/\/FeatureServer\/?$/i.test(input)) {
    throw new Error("Enter an ArcGIS FeatureServer layer URL.", { cause });
  }

  const serviceInfo = await fetchArcGISJson<ArcGISFeatureServiceInfo>(input, options, cause);
  const layerId = serviceInfo.layers?.find((layer) => !layer.subLayerIds)?.id;
  if (layerId == null) {
    throw new Error("The ArcGIS feature service does not list a feature layer.", {
      cause,
    });
  }
  return `${trimTrailingSlash(input)}/${layerId}`;
}

async function resolvePortalFeatureLayerUrl(
  itemId: string,
  options: ArcGISLayerOptions,
  cause: unknown,
): Promise<string> {
  const itemInfo = await fetchArcGISPortalItemInfo(itemId, options, cause);
  if (!itemInfo.url) {
    throw new Error("The ArcGIS portal item does not include a service URL.", {
      cause,
    });
  }
  return resolveFeatureLayerUrl(itemInfo.url, options, cause);
}

async function fetchArcGISPortalItemInfo(
  itemId: string,
  options: ArcGISLayerOptions,
  cause: unknown,
): Promise<ArcGISPortalItemInfo> {
  const portalUrl = options.portalUrl?.trim() || "https://www.arcgis.com/sharing/rest";
  const itemUrl = appendArcGISParams(`${trimTrailingSlash(portalUrl)}/content/items/${itemId}`, {
    f: "json",
    token: options.token?.trim(),
  });
  const response = await fetch(itemUrl);
  if (!response.ok) {
    throw new Error(`ArcGIS portal item request failed with ${response.status}.`, {
      cause,
    });
  }
  return (await response.json()) as ArcGISPortalItemInfo;
}

async function fetchArcGISJson<T>(
  url: string,
  options: ArcGISLayerOptions,
  cause: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    appendArcGISParams(url, {
      f: "json",
      token: options.token?.trim(),
    }),
    { signal },
  );
  if (!response.ok) {
    throw new Error(`ArcGIS service request failed with ${response.status}.`, {
      cause,
    });
  }
  const json = (await response.json()) as T & {
    error?: ArcGISErrorEnvelope;
  };
  if (json.error) {
    throw new Error(arcgisErrorMessage(json.error, "ArcGIS service request failed."), {
      cause,
    });
  }
  return json;
}

async function resolveArcGISLayerBounds(
  input: string,
  options: ArcGISLayerOptions,
  hostedLayer: ArcGISRuntimeLayer,
): Promise<[number, number, number, number] | undefined> {
  const sourceBounds = getArcGISSourceBounds(hostedLayer);
  if (sourceBounds) return sourceBounds;
  if (hostedLayer.bounds) return hostedLayer.bounds;

  try {
    if (options.sourceType === "portal-item") {
      const itemInfo = await fetchArcGISPortalItemInfo(input, options, undefined);
      const itemBounds = arcgisPortalItemExtentToBounds(itemInfo.extent);
      if (itemBounds) return itemBounds;
      if (itemInfo.url) {
        return resolveArcGISServiceBounds(itemInfo.url, options);
      }
      return undefined;
    }

    return resolveArcGISServiceBounds(input, options);
  } catch {
    return undefined;
  }
}

async function resolveArcGISServiceBounds(
  url: string,
  options: ArcGISLayerOptions,
): Promise<[number, number, number, number] | undefined> {
  const serviceInfo = await fetchArcGISJson<ArcGISServiceInfo>(url, options, undefined);
  return arcgisExtentToBounds(
    serviceInfo.fullExtent ?? serviceInfo.initialExtent ?? serviceInfo.extent,
  );
}

function getArcGISSourceBounds(
  hostedLayer: ArcGISRuntimeLayer,
): [number, number, number, number] | undefined {
  for (const source of Object.values(hostedLayer.sources)) {
    const bounds = "bounds" in source ? source.bounds : undefined;
    if (isGeoBounds(bounds)) return bounds;
  }
  return undefined;
}

function arcgisPortalItemExtentToBounds(
  extent: ArcGISPortalItemInfo["extent"],
): [number, number, number, number] | undefined {
  if (!Array.isArray(extent) || extent.length !== 2) return undefined;
  const [[west, south], [east, north]] = extent;
  return isGeoBounds([west, south, east, north]) ? [west, south, east, north] : undefined;
}

function arcgisExtentToBounds(
  extent: ArcGISExtent | undefined,
): [number, number, number, number] | undefined {
  if (!extent) return undefined;
  const wkid = extent.spatialReference?.latestWkid ?? extent.spatialReference?.wkid;
  if (wkid === 102100 || wkid === 102113 || wkid === 3857) {
    return [
      mercatorXToLongitude(extent.xmin),
      mercatorYToLatitude(extent.ymin),
      mercatorXToLongitude(extent.xmax),
      mercatorYToLatitude(extent.ymax),
    ];
  }

  const bounds: [number, number, number, number] = [
    extent.xmin,
    extent.ymin,
    extent.xmax,
    extent.ymax,
  ];
  return isGeoBounds(bounds) ? bounds : undefined;
}

function mercatorXToLongitude(x: number): number {
  return (x / 20037508.34) * 180;
}

function mercatorYToLatitude(y: number): number {
  const latitude = (y / 20037508.34) * 180;
  return (180 / Math.PI) * (2 * Math.atan(Math.exp((latitude * Math.PI) / 180)) - Math.PI / 2);
}

function isGeoBounds(value: unknown): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item)) &&
    value[0] >= -180 &&
    value[2] <= 180 &&
    value[1] >= -90 &&
    value[3] <= 90 &&
    value[0] < value[2] &&
    value[1] < value[3]
  );
}

function appendArcGISParams(url: string, params: Record<string, string | undefined>): string {
  const parsedUrl = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value) parsedUrl.searchParams.set(key, value);
  }
  return parsedUrl.toString();
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function createArcGISStoreLayer(args: {
  bounds?: [number, number, number, number];
  id: string;
  input: string;
  nativeLayerIds: string[];
  options: ArcGISLayerOptions;
  sourceIds: string[];
}): GeoLibreLayer {
  const { bounds, id, input, nativeLayerIds, options, sourceIds } = args;
  const sourceKind = `arcgis-${options.layerType}-${options.sourceType}`;
  const sourceType = options.layerType === "feature" ? "geojson" : "vector";
  const name = options.name?.trim() || layerNameFromArcGISInput(input, id);

  return {
    id,
    name,
    type: "arcgis",
    source: {
      itemId: options.sourceType === "portal-item" ? input : undefined,
      bounds,
      layerType: options.layerType,
      portalUrl: options.portalUrl?.trim() || undefined,
      sourceId: sourceIds[0],
      sourceIds,
      type: sourceType,
      url: options.sourceType === "url" ? input : undefined,
    },
    visible: true,
    opacity: 1,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillColor: "#2563eb",
      fillOpacity: 0.45,
      strokeColor: "#1d4ed8",
    },
    metadata: {
      arcgisLayerType: options.layerType,
      arcgisSourceType: options.sourceType,
      bounds,
      externalNativeLayer: true,
      hasAccessToken: Boolean(options.token?.trim()),
      nativeLayerIds,
      portalUrl: options.portalUrl?.trim() || undefined,
      sourceId: sourceIds[0],
      sourceIds,
      sourceKind,
    },
    sourcePath: input,
  };
}

function layerNameFromArcGISInput(input: string, fallback: string): string {
  try {
    const url = new URL(input);
    const parts = url.pathname.split("/").filter(Boolean);
    const serverIndex = parts.findIndex((part) =>
      /^(FeatureServer|VectorTileServer|MapServer|ImageServer)$/i.test(part),
    );
    const namePart = serverIndex > 0 ? parts[serverIndex - 1] : parts[parts.length - 1];
    return decodeURIComponent(namePart ?? "").replaceAll("_", " ") || fallback;
  } catch {
    return input || fallback;
  }
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "id";
}

function createArcGISLayerId(): string {
  arcgisLayerSequence += 1;
  return `arcgis-layer-${arcgisLayerSequence}`;
}
