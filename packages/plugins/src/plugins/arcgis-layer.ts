/// <reference path="../arcgis-maplibre.d.ts" />

import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { HostedLayer, VectorTileLayer } from "@esri/maplibre-arcgis";
import type { Feature, FeatureCollection } from "geojson";
import type maplibregl from "maplibre-gl";
import type { GeoLibreAppAPI } from "../types";

export type ArcGISLayerType = "feature" | "vector-tile";
export type ArcGISSourceType = "url" | "portal-item";

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
  sourceType: ArcGISSourceType;
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
  const geojson = await fetchArcGISFeaturePages(queryUrl, options, layerInfo);

  const name =
    options.name?.trim() || layerInfo.name || layerNameFromArcGISInput(layerUrl, "ArcGIS Layer");
  const store = useAppStore.getState();
  // Persist the GeoJSON query endpoint (not the service-description base URL) as
  // the source path so the layer's GeoJSON refresh re-fetches valid features.
  const id = store.addGeoJsonLayer(name, geojson, refreshUrl, options.beforeLayerId ?? null);

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
    metadata: { sourceKind: ARCGIS_FEATURE_SOURCE_KIND },
  });

  const bounds = arcgisExtentToBounds(layerInfo.extent);
  if (bounds && options.zoomTo !== false) app.fitBounds?.(bounds);
  return id;
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
  /** Features to request per `/query` call. */
  pageSize: number;
  /** Query params every page shares (including the token, if any). */
  params: Record<string, string | undefined>;
  /** The `/query` endpoint, without paging params. */
  queryUrl: string;
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
): Promise<FeatureCollection> {
  const plan = await planArcGISPaging(queryUrl, options, layerInfo);

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
): Promise<ArcGISPagingPlan> {
  const params = {
    f: "geojson",
    outFields: "*",
    returnGeometry: "true",
    where: "1=1",
    token: options.token?.trim() || undefined,
  };
  return {
    maxFeatures: positiveInteger(options.maxFeatures),
    objectIdField: layerInfo.objectIdField?.trim() || undefined,
    onProgress: options.onProgress,
    pageSize: resolveArcGISPageSize(options.pageSize, layerInfo.maxRecordCount),
    params,
    queryUrl,
    supportsPagination: layerInfo.advancedQueryCapabilities?.supportsPagination === true,
    supportsOrderBy: layerInfo.advancedQueryCapabilities?.supportsOrderBy !== false,
    total: await fetchArcGISFeatureCount(queryUrl, params.token),
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
 * @param queryUrl - The layer's `/query` endpoint.
 * @param token - The access token to send, if any.
 */
async function fetchArcGISFeatureCount(
  queryUrl: string,
  token: string | undefined,
): Promise<number | null> {
  try {
    const response = await fetch(
      appendArcGISParams(queryUrl, {
        f: "json",
        returnCountOnly: "true",
        where: "1=1",
        token,
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
        f: "json",
        returnIdsOnly: "true",
        where: "1=1",
        token: plan.params.token,
      }),
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
  } catch {
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
  message?: string;
  details?: unknown;
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
): Promise<FeatureCollection & { exceededTransferLimit: boolean }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ArcGIS feature query failed with ${response.status}.`);
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
    throw new Error(arcgisErrorMessage(json.error, "ArcGIS feature query failed."));
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
): Promise<T> {
  const response = await fetch(
    appendArcGISParams(url, {
      f: "json",
      token: options.token?.trim(),
    }),
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
    const serverIndex = parts.findIndex((part) => /^(FeatureServer|VectorTileServer)$/i.test(part));
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
