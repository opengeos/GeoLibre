// CesiumLayerSync layer: in-place style, filter and appearance updates.
// The class is split across modules as an inheritance chain (base, selection,
// appearance, imagery, entries, then CesiumLayerSync); see cesium-layer-sync.ts.

import { i3sGroundOffset, DEFAULT_LAYER_STYLE, extrusionColorValue } from "@geolibre/core";
import { imageryColorAdjustments } from "./raster-color-adjustments";
import { featureFilter } from "@maplibre/maplibre-gl-style-spec";
import type { Feature } from "geojson";
import { zoomToDisplayDistance } from "./cesium-camera";
import { createFeatureStyleResolver, type FeatureStyleResolver } from "./feature-style";
import { labelBaseColors } from "./cesium-labels";
import { horizonDepthDistance } from "./cesium-horizon";
import { pointCloudGroundOffset, setPointCloudOpacity } from "./cesium-point-cloud";
import {
  clusterActiveAtZoom,
  clusterAppearance,
  configureClustering,
  isBatchedPointRef,
  planPointRendering,
  restylePointBatch,
} from "./cesium-points";
import {
  compileTilesetStyle,
  tilesetStyleKey,
  type TilesetStyleSpec,
} from "./cesium-tileset-style";
import { renderFillPatternCanvas } from "./fill-patterns";
import { getLayerBounds } from "./geojson-loader";
import { renderMarkerCanvas } from "./markers";
import type { Cartesian2, Cartographic, Color, DistanceDisplayCondition } from "@cesium/core";
import type {
  Cesium3DTileset,
  DataSource,
  Entity,
  I3SDataProvider,
  ImageryLayer,
  PointPrimitiveCollection,
} from "@cesium/engine";
import { isI3sLayer, composeLayerFeatureFilter } from "./cesium-layer-records";
import {
  type CameraEvent,
  type LayerEntry,
  i3sTilesets,
  applyI3sBuildingVisibility,
} from "./cesium-layer-entry";
import { styleSignature } from "./cesium-layer-rebuild";
import { FEATURE_INDEX_KEY } from "./cesium-geojson-entities";
import { CesiumLayerSyncSelection } from "./cesium-layer-sync-selection";

type CesiumNs = typeof import("@cesium/engine");

/** Whether a serialized filter reads `["zoom"]`, so its result depends on the camera. */
const ZOOM_OPERAND = /\[\s*"zoom"\s*\]/;

/** Most marker sprites baked for one layer (one per distinct classified colour). */
const MAX_MARKER_SPRITES = 64;

/** Ground metres one fill-pattern tile spans on a draped polygon. */
const PATTERN_TILE_METERS = 20;

/**
 * In-place appearance updates for {@link CesiumLayerSync}: GeoJSON styles and
 * filters, zoom-dependent markers, point batches and clustering, and 3D Tiles
 * and point cloud styling and grounding.
 */
export class CesiumLayerSyncAppearance extends CesiumLayerSyncSelection {
  /** Removes the camera listeners installed by {@link watchCameraZoom}, or null when none are. */
  protected unwatchCamera: (() => void) | null = null;

  /**
   * Keep camera listeners installed exactly while some entry's filter reads
   * `["zoom"]`. MapLibre evaluates such a filter live; on the globe the filter
   * is re-run when the camera settles (`moveEnd`) or moves far enough to fire
   * `changed`, and {@link applyGeoJsonFilter} skips the work unless the integer
   * zoom actually crossed a level.
   */
  protected watchCameraZoom(): void {
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
  protected resolverFor(entry: LayerEntry): FeatureStyleResolver {
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
  protected async prepareSymbolImages(
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
  protected installPointGraphics(
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
        // Over terrain on the near side, hidden by the Earth on the far side.
        disableDepthTestDistance: horizonDepthDistance(Cesium, viewer).property,
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
  protected installZoomRange(entry: LayerEntry, dataSource: DataSource): void {
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

  /**
   * Cluster a point-only layer whose style asks for it (issue #2282) through
   * the data source's `EntityCluster`, styled like the 2D map's cluster
   * bubbles, and switched off past `clusterMaxZoom` as the camera zooms in.
   */
  protected installClustering(entry: LayerEntry, dataSource: DataSource): void {
    const plan = planPointRendering(entry.layer);
    entry.plan = plan;
    if (!plan.cluster || !dataSource.clustering?.clusterEvent) return;
    entry.cluster = configureClustering(
      this.Cesium,
      dataSource,
      plan,
      () => clusterAppearance(entry.layer, this.effectiveOpacity(entry)),
      horizonDepthDistance(this.Cesium, this.viewer),
    );
    entry.zoomCluster = true;
    entry.cluster.setEnabled(clusterActiveAtZoom(plan, this.cameraZoom()));
    this.watchCameraZoom();
  }

  protected pointStyleKey(entry: LayerEntry, zoom: number): string {
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

  /**
   * Where each tileset sat before any offset moved it. Read once, while its
   * model matrix is still the identity: `boundingSphere` follows the model
   * matrix (and lags it until the next frame), so re-reading it after a move
   * would compound the offsets.
   */
  private readonly tilesetAnchors = new WeakMap<Cesium3DTileset, Cartographic>();

  /**
   * Raise/lower a 3D Tiles entry by the layer's altitude offset (metres).
   *
   * Applied in place on every sync rather than at creation, so editing the
   * offset (the Style panel's height field, #3107) moves the loaded tileset
   * instead of rebuilding it. A zero offset restores the identity matrix.
   *
   * @param entry The 3D Tiles entry to position.
   */
  protected applyTilesetAltitude(entry: LayerEntry): void {
    const raw = Number(entry.layer.source.altitudeOffset);
    const offset = (Number.isFinite(raw) ? raw : 0) + this.i3sEntryGroundOffset(entry);
    if ((entry.appliedAltitude ?? 0) === offset) return;
    const { Cesium } = this;
    const tilesets = this.entryTilesets(entry);
    // Nothing to move yet (an I3S provider before its sub-layers exist): leave
    // the offset unrecorded so the next sync tries again.
    if (tilesets.length === 0) return;
    for (const tileset of tilesets) {
      let anchor = this.tilesetAnchors.get(tileset);
      if (!anchor) {
        anchor = Cesium.Cartographic.fromCartesian(tileset.boundingSphere.center);
        this.tilesetAnchors.set(tileset, anchor);
      }
      if (offset === 0) {
        tileset.modelMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
        continue;
      }
      const surface = Cesium.Cartesian3.fromRadians(anchor.longitude, anchor.latitude, 0);
      const target = Cesium.Cartesian3.fromRadians(anchor.longitude, anchor.latitude, offset);
      const translation = Cesium.Cartesian3.subtract(target, surface, new Cesium.Cartesian3());
      tileset.modelMatrix = Cesium.Matrix4.fromTranslation(translation);
    }
    entry.appliedAltitude = offset;
    this.viewer.scene.requestRender();
  }

  /**
   * Lower a decoded point cloud onto a globe without terrain (#3476).
   *
   * A LiDAR survey stores absolute heights (the Knoxville COPC sample spans
   * 181 to 342 m). The 2D map's LiDAR control lowers a cloud by its ground
   * height so it sits on the basemap; on the bare ellipsoid the globe has no
   * ground either, so the cloud floated a survey height above the imagery and
   * drifted off it in a tilted view. This applies the same offset as a model
   * matrix, so switching terrain on (which keeps the absolute heights) or off
   * moves the loaded cloud in place instead of decoding it again.
   *
   * @param entry The point-cloud entry to position.
   */
  protected applyPointCloudGround(entry: LayerEntry): void {
    // A streamed cloud's collection is in the scene before start() resolves
    // and sets the handle, so nodes landing in the first refresh are grounded too.
    const collection = (entry.handle ??
      entry.streamer?.collection ??
      null) as PointPrimitiveCollection | null;
    if (!collection || entry.kind !== "pointcloud") return;
    // A streamed cloud's ground height can change as nodes land (the root
    // replaces a fallback node's), so it is read from the streamer each time.
    const base = entry.streamer ? entry.streamer.baseHeight : entry.pointCloudBase;
    const offset = pointCloudGroundOffset(base, this.globeHasTerrain());
    if ((entry.appliedAltitude ?? 0) === offset) return;
    const { Cesium } = this;
    if (offset === 0) {
      collection.modelMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
    } else {
      // Any point of the cloud anchors the local "up". One translation is
      // exact for a survey a few kilometres across; at distance d from the
      // anchor it drifts sideways by about offset * d / R (a few metres for
      // a 100 km cloud 200 m up), which a per-node anchor would remove.
      const sample = collection.length > 0 ? collection.get(0)?.position : undefined;
      // Nothing shown yet: leave the offset unrecorded so a later pass retries.
      if (!sample) return;
      const anchor = Cesium.Cartographic.fromCartesian(sample);
      const surface = Cesium.Cartesian3.fromRadians(anchor.longitude, anchor.latitude, 0);
      const target = Cesium.Cartesian3.fromRadians(anchor.longitude, anchor.latitude, offset);
      const translation = Cesium.Cartesian3.subtract(target, surface, new Cesium.Cartesian3());
      collection.modelMatrix = Cesium.Matrix4.fromTranslation(translation);
    }
    entry.appliedAltitude = offset;
    this.viewer.scene.requestRender();
  }

  /**
   * How far to lower an I3S scene layer onto a globe without terrain (#3374).
   *
   * A scene layer stores absolute elevations (Building E in Redlands sits at
   * 383 to 445 m, NAVD 88). On the default globe, the bare ellipsoid, the
   * ground is at 0 m, so the building floated out of sight above the camera.
   * As on the 2D map, a layer whose geometry starts above 0 m is lowered onto
   * the ground; with terrain the absolute heights are kept.
   *
   * @param entry The 3D Tiles entry.
   * @returns The offset in metres, or 0.
   */
  private i3sEntryGroundOffset(entry: LayerEntry): number {
    if (!isI3sLayer(entry.layer) || !entry.handle) return 0;
    if (this.globeHasTerrain()) return 0;
    const data = (entry.handle as Partial<I3SDataProvider>).data as
      | { fullExtent?: { zmin?: unknown } }
      | undefined;
    // The provider's own document first; the probed value when it has none.
    const zmin = data?.fullExtent?.zmin;
    return i3sGroundOffset(
      typeof zmin === "number" && Number.isFinite(zmin)
        ? zmin
        : entry.layer.metadata?.i3sBaseElevation,
      false,
    );
  }

  /**
   * Apply visual appearance (visibility, opacity, symbology, filters) to an active entry.
   *
   * @param entry The layer entry to update on the globe.
   */
  protected applyAppearance(entry: LayerEntry): void {
    const { handle, layer } = entry;
    if (!handle) return;
    const moving = this.movingPointLayers.get(layer.id);
    if (moving) moving.collection.show = layer.visible;
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
    } else if (entry.kind === "czml" || entry.kind === "kml") {
      (handle as DataSource).show = layer.visible;
      if (entry.overlayContainer) {
        entry.overlayContainer.style.display = layer.visible ? "" : "none";
        entry.overlayContainer.style.opacity = String(this.effectiveOpacity(entry));
      }
    } else if (entry.kind === "video") {
      (handle as DataSource).show = layer.visible;
      const opacity = this.effectiveOpacity(entry);
      const polygonMat = entry.videoEntity?.polygon?.material as { color?: unknown } | undefined;
      if (polygonMat && "color" in polygonMat) {
        polygonMat.color = this.Cesium.Color.WHITE.withAlpha(opacity);
      }
      if (entry.videoElement) {
        if (layer.visible) void Promise.resolve(entry.videoElement.play?.()).catch(() => {});
        else entry.videoElement.pause?.();
      }
    } else if (entry.kind === "pointcloud") {
      const collection = handle as PointPrimitiveCollection;
      collection.show = layer.visible;
      const opacity = this.effectiveOpacity(entry);
      const key = String(opacity);
      if (entry.appliedAlpha !== key) {
        entry.appliedAlpha = key;
        setPointCloudOpacity(collection, opacity);
      }
      this.applyPointCloudGround(entry);
    } else if (entry.kind === "points") {
      (handle as PointPrimitiveCollection).show = layer.visible;
      this.applyPointBatchStyle(entry);
      this.applyGeoJsonFilter(entry);
    } else {
      (handle as Cesium3DTileset | I3SDataProvider).show = layer.visible;
      if (isI3sLayer(layer)) applyI3sBuildingVisibility(handle as I3SDataProvider, layer);
      this.applyTilesetAltitude(entry);
      this.applyTilesetStyle(entry);
    }
  }

  /** Every `Cesium3DTileset` behind a 3D Tiles entry (an I3S provider drives several). */
  private entryTilesets(entry: LayerEntry): Cesium3DTileset[] {
    const handle = entry.handle;
    if (!handle) return [];
    const provider = handle as Partial<I3SDataProvider>;
    if (Array.isArray(provider.layers)) return i3sTilesets(provider);
    return [handle as Cesium3DTileset];
  }

  /**
   * Classify a tileset's features from the layer's symbology (issue #2290).
   *
   * The layer's own colour expression and per-feature filter are translated
   * into a `Cesium3DTileStyle`, so a building tileset categorizes, graduates,
   * or follows a rule tree exactly as an extruded vector layer does — and the
   * Layers-panel opacity slider, which had no effect on a tileset at all,
   * reaches it as a white multiply that fades textured tiles without tinting
   * them. A layer that neither classifies nor filters at full opacity clears
   * the style so the tileset draws its own colours.
   */
  private applyTilesetStyle(entry: LayerEntry): void {
    const spec: TilesetStyleSpec | null = compileTilesetStyle(
      entry.layer,
      this.effectiveOpacity(entry),
      composeLayerFeatureFilter(entry.layer),
    );
    const key = tilesetStyleKey(spec);
    if (entry.appliedAlpha === key) return;
    entry.appliedAlpha = key;
    let style: InstanceType<CesiumNs["Cesium3DTileStyle"]> | undefined;
    if (spec) {
      try {
        style = new this.Cesium.Cesium3DTileStyle(spec);
      } catch (error) {
        // The styling language is compiled by Cesium, not by the translator,
        // so a shape that translates but does not compile (an unexpected
        // property name, a colour Cesium rejects) must not take the sync down.
        console.warn("[GeoLibre] could not apply the 3D Tiles style", error);
        return;
      }
    }
    for (const tileset of this.entryTilesets(entry)) tileset.style = style;
    this.viewer.scene.requestRender();
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
    const indexKey = FEATURE_INDEX_KEY;
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
              if (point.show !== show) point.show = show;
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
          // A redundant write still marks the entity dirty, so only a real
          // change is written (#2311).
          setShow: (show) => {
            if (entity.show !== show) entity.show = show;
          },
        };
      });
    };

    // Every `show` write is batched into one definition-change event: writing
    // them one at a time makes Cesium cancel and rebuild the ground-primitive
    // batch mid-compile, which starves polygon geometry on a large layer
    // (#2311). A point batch has no entity collection and needs no suspension.
    const entities = entry.kind === "points" ? null : (entry.handle as DataSource).entities;
    const batched = (apply: () => void) => {
      (entities as { suspendEvents?: () => void } | null)?.suspendEvents?.();
      try {
        apply();
      } finally {
        (entities as { resumeEvents?: () => void } | null)?.resumeEvents?.();
      }
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
      batched(() => {
        for (const target of targets()) target.setShow(true);
      });
      return;
    }
    // Bound to a const so the null-narrowing survives into the batched closure.
    const compiledFilter = compiled;

    const typeMap: Record<string, 1 | 2 | 3> = {
      Point: 1,
      MultiPoint: 1,
      LineString: 2,
      MultiLineString: 2,
      Polygon: 3,
      MultiPolygon: 3,
    };

    batched(() => {
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
          visible = compiledFilter.filter({ zoom }, {
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
    });
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
    // A data-defined label opacity replaces the layer opacity but still
    // follows a story fade, scaled by how far the fade has taken the layer
    // from its own opacity (a fade to 0 hides it).
    const story = this.storyOpacities.get(entry.layer.id);
    const storyFactor = !story
      ? 1
      : entry.layer.opacity > 0
        ? story.currentOpacity / entry.layer.opacity
        : story.currentOpacity > 0
          ? 1
          : 0;
    const isExtruded = Boolean(style.extrusionEnabled);
    const extColorVal = isExtruded ? extrusionColorValue(style) : null;
    const extColorStr =
      typeof extColorVal === "string"
        ? extColorVal
        : style.extrusionColor || style.fillColor || "#3b82f6";
    const extFill = Cesium.Color.fromCssColorString(extColorStr).withAlpha(extOpacity);
    const hasColorExpr =
      isExtruded &&
      (typeof extColorVal !== "string" ||
        (style.extrusionAdvancedStyleEnabled && Boolean(style.extrusionColorExpression)));
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
    // Every material/colour write marks its entity dirty; batching the whole
    // restyle pass into one definition-change event keeps Cesium from
    // cancelling and rebuilding the ground-primitive batch per entity (#2311).
    (dataSource.entities as { suspendEvents?: () => void }).suspendEvents?.();
    try {
      for (const entity of dataSource.entities.values) {
        const ref = this.featureRefs.get(entity);
        const feature = ref && features ? features[ref.index] : undefined;
        const symbol = resolver.resolve(feature, zoom);
        if (entity.polygon) {
          if (hasColorExpr) {
            // ColorMaterialProperty wraps its colour in a ConstantProperty, so
            // resolve the Property before re-alphaing the per-feature colour.
            const colorProp = (entity.polygon.material as { color?: unknown } | undefined)
              ?.color as
              | {
                  getValue?: (time: unknown) => Color | undefined;
                  withAlpha?: (a: number) => Color;
                }
              | undefined;
            const current =
              typeof colorProp?.getValue === "function"
                ? colorProp.getValue(currentTime)
                : colorProp;
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
          // A label built with per-feature colours or a data-defined opacity
          // keeps them; only the layer opacity is reapplied.
          const base = labelBaseColors.get(entity);
          const alpha =
            base?.opacity === undefined ? opacity : Math.min(1, base.opacity * storyFactor);
          entity.label.fillColor = new Cesium.ConstantProperty(
            base ? base.fill.withAlpha(base.fill.alpha * alpha) : labelFill,
          );
          entity.label.outlineColor = new Cesium.ConstantProperty(
            base ? base.outline.withAlpha(base.outline.alpha * alpha) : labelOutline,
          );
        }
      }
    } finally {
      (dataSource.entities as { resumeEvents?: () => void }).resumeEvents?.();
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
}
