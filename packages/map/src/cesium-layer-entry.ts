// The per-layer entry record CesiumLayerSync keeps for each rendered layer, and helpers over it.

import {
  isCesiumKmlLayer,
  visibleI3sBuildingSublayers,
  type I3sBuildingState,
  isCzmlLayer,
  type GeoLibreLayer,
} from "@geolibre/core";
import { PointCloudStreamer } from "./cesium-point-cloud-stream";
import type { FeatureStyleResolver } from "./feature-style";
import { configureClustering, planPointRendering, type PointRenderPlan } from "./cesium-points";
import type {
  Cesium3DTileset,
  Credit,
  DataSource,
  Entity,
  I3SDataProvider,
  ImageryLayer,
  PointPrimitiveCollection,
} from "@cesium/engine";
import {
  isTilesetLayer,
  isDecodedPointCloudLayer,
  hasRenderableGeoJson,
} from "./cesium-layer-records";

/** The subset of a Cesium `Event` the camera watch needs. */
export interface CameraEvent {
  addEventListener(listener: () => void): unknown;
  removeEventListener(listener: () => void): unknown;
}

/**
 * Cesium's BoundingSphereState enum values (internal runtime enum in `@cesium/engine`,
 * omitted from public TypeScript typings).
 * BoundingSphereState.PENDING indicates that asynchronous geometry workers are still
 * computing the visual representation / bounding volume.
 */
export const BOUNDING_SPHERE_STATE_PENDING = 1;

export type EntryKind =
  | "imagery"
  | "geojson"
  | "3dtiles"
  | "points"
  | "pointcloud"
  | "czml"
  | "kml"
  | "video";

/** The `clock` packet a loaded CZML data source carries, as Cesium exposes it. */
interface CzmlDocumentClock {
  startTime?: unknown;
  stopTime?: unknown;
  currentTime?: unknown;
  clockRange?: unknown;
  multiplier?: unknown;
}

/** The document clock of a loaded CZML data source, or undefined without one. */
export function czmlDocumentClock(handle: unknown): CzmlDocumentClock | undefined {
  return (handle as { clock?: CzmlDocumentClock } | null | undefined)?.clock ?? undefined;
}

/** The slice of a rendered tile's content the attribute-name discovery reads. */
export interface TileContentLike {
  featuresLength?: number;
  getFeature?: (index: number) => { getPropertyIds?: () => string[] } | undefined;
}

export interface LayerEntry {
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
  /** Streams an EPT cloud by view; destroyed with the entry. */
  streamer?: PointCloudStreamer;
  /** Removes the one-shot tile listener that reads a tileset's attribute names. */
  fieldsListener?: () => void;
  /** Stops counting an imagery entry's tile loads and failures. */
  tileHealth?: () => void;
  documentCleanup?: () => void;
  overlayContainer?: HTMLElement;
  /** Live HTMLVideoElement draped onto a quad for `video` layers. */
  videoElement?: HTMLVideoElement;
  /** Video polygon entity whose material alpha tracks layer opacity. */
  videoEntity?: Entity;
  /** True once the video element has decoded its first frame (readyState >= 2). */
  videoReady?: boolean;
  /** Detaches media event listeners attached to {@link videoElement}. */
  videoCleanup?: () => void;
  /** Static attribution registered for this layer while it is in the scene. */
  credit?: Credit;
  /** Set when the entry is removed mid-load so the resolved handle is discarded. */
  cancelled: boolean;
  /**
   * The request headers the entry was built with, resolved from `${NAME}`
   * references (JSON). The layer keeps only the template, so a changed
   * variable is detected by comparing this with a fresh resolution.
   */
  resolvedHeaders?: string;
  /**
   * Whether {@link handle} is actually in the scene. A geojson entry's handle is
   * assigned as soon as the data source loads, but the data source only joins
   * `viewer.dataSources` once every entity is built (#2311), so "handle exists"
   * and "handle renders" are not the same window.
   */
  added?: boolean;
  loadError?: string;
  /** The tileset or point-cloud altitude offset (metres) last applied as a model matrix. */
  appliedAltitude?: number;
  /**
   * A plain LAS cloud's ground height in metres (its low percentile, as
   * decoded, before any altitude offset), which the globe lowers onto the
   * ellipsoid when there is no terrain (#3476). A streamed cloud's comes from
   * its streamer instead.
   */
  pointCloudBase?: number;
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

/** Orbit metadata aligned by feature index with a plugin-owned moving point batch. */
export interface MovingPointFeatureDescription {
  name: string;
  tleLine1: string;
  tleLine2: string;
  orbitalPeriodMinutes: number;
}

/**
 * Every tileset an I3S provider drives. `I3SDataProvider.layers` is already
 * flat: a Building Scene Layer's nested sublayers register their `I3SLayer`s
 * there too (Cesium's `I3SDataProvider._fromData` pushes each sublayer's
 * layers into `_layers`), so one pass covers the whole tree.
 */
export function i3sTilesets(provider: Partial<I3SDataProvider>): Cesium3DTileset[] {
  const tilesets: Cesium3DTileset[] = [];
  for (const layer of provider.layers ?? []) {
    if (layer.tileset && !tilesets.includes(layer.tileset)) tilesets.push(layer.tileset);
  }
  return tilesets;
}

/** The parts of Cesium's `I3SSublayer` the Building visibility walk uses. */
interface I3sSublayerLike {
  data?: { id?: unknown; modelName?: unknown };
  sublayers?: I3sSublayerLike[];
  visibility: boolean;
}

/**
 * Show the Building Scene Layer sublayers the layer's Building settings pick.
 *
 * Cesium's `I3SDataProvider` loads every sublayer of a Building Scene Layer and
 * showed them all at once, the Overview shell over all of the Full Model's
 * categories. This applies the same choice the 2D overlay draws
 * (`metadata.i3sBuilding`, set in the Style panel's Building section); a layer
 * without that state (never opened on the 2D map) shows its Overview, the
 * same default as there. A provider with no sublayers is left alone.
 *
 * @param provider The layer's I3S provider.
 * @param layer The store layer.
 */
export function applyI3sBuildingVisibility(provider: I3SDataProvider, layer: GeoLibreLayer): void {
  const top = (provider as unknown as { sublayers?: I3sSublayerLike[] }).sublayers;
  if (!top?.length) return;
  const state = layer.metadata?.i3sBuilding as I3sBuildingState | undefined;
  let visible: Set<number>;
  if (state) {
    visible = new Set(visibleI3sBuildingSublayers(state));
  } else {
    const overview = top.find((sub) => sub.data?.modelName === "Overview");
    if (!overview) return;
    visible = new Set([Number(overview.data?.id)]);
  }
  const walk = (subs: I3sSublayerLike[]): boolean => {
    let any = false;
    for (const sub of subs) {
      const show = sub.sublayers?.length ? walk(sub.sublayers) : visible.has(Number(sub.data?.id));
      if (sub.visibility !== show) sub.visibility = show;
      any ||= show;
    }
    return any;
  };
  walk(top);
}

/** Whether a tileset (or every tileset of an I3S provider) has loaded its tiles. */
export function tilesLoaded(handle: Cesium3DTileset | I3SDataProvider): boolean {
  const provider = handle as Partial<I3SDataProvider>;
  if (Array.isArray(provider.layers)) {
    return i3sTilesets(provider).every((tileset) => tileset.tilesLoaded);
  }
  return Boolean((handle as Cesium3DTileset).tilesLoaded);
}

/**
 * Determine the synchronizer entry kind for a given layer.
 *
 * @param layer The layer to evaluate.
 * @returns The EntryKind categorization for the globe renderer.
 */
export function entryKind(layer: GeoLibreLayer): EntryKind {
  if (isCesiumKmlLayer(layer)) return "kml";
  if (isCzmlLayer(layer)) return "czml";
  if (layer.type === "video") return "video";
  if (hasRenderableGeoJson(layer)) return planPointRendering(layer).batched ? "points" : "geojson";
  if (isTilesetLayer(layer)) return "3dtiles";
  if (isDecodedPointCloudLayer(layer)) return "pointcloud";
  return "imagery";
}
