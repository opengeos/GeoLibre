// CesiumLayerSync layer: building the Cesium object for each layer kind.
// The CesiumLayerSync layer chain is documented in cesium-layer-sync.ts.

import {
  cesiumKmlSource,
  cesiumIonAssetId,
  czmlSource,
  DEFAULT_LAYER_STYLE,
  geojsonHasZCoordinates,
  parseCzml,
  resolveThreeDTilesRequestHeaders,
  transformGeojsonElevation,
  resolveProjectHeaderReferences,
  type GeoLibreLayer,
} from "@geolibre/core";
import { bindDocumentOpacity } from "./cesium-document-opacity";
import { DECK_VIZ_GLOBE_METADATA_KEY } from "./cesium-deck-viz";
import { PointCloudStreamer } from "./cesium-point-cloud-stream";
import { createCesiumLabeler, pickLabelPart } from "./cesium-labels";
import { horizonDepthDistance } from "./cesium-horizon";
import {
  buildPointCloudCollection,
  openCopcSource,
  openEptSource,
  loadLasPointCloud,
  pointCloudSourceKind,
} from "./cesium-point-cloud";
import { buildPointBatch, planPointRendering } from "./cesium-points";
import type { Cartesian2, Rectangle } from "@cesium/core";
import type { Cesium3DTileset, DataSource, Entity, ImageryLayer } from "@cesium/engine";
import {
  isI3sLayer,
  pointCloudUrl,
  str,
  escapeCreditHtml,
  allowsCredentials,
  CREDENTIAL_PROXY,
  tilesetUrl,
  videoUrls,
  videoCorners,
} from "./cesium-layer-records";
import {
  type EntryKind,
  czmlDocumentClock,
  type TileContentLike,
  type LayerEntry,
  i3sTilesets,
  entryKind,
} from "./cesium-layer-entry";
import { resolvedRequestHeaders } from "./cesium-imagery-providers";
import {
  indexedFeatureCollection,
  hideSlicedPolygonOutlines,
  entityFeatureIndex,
  entityHeightWriters,
  applyGeoJsonExtrusion,
  applyElevationHeightReferences,
} from "./cesium-geojson-entities";
import { CesiumLayerSyncImagery } from "./cesium-layer-sync-imagery";

/** Flight time for a zoom-to-layer, matching the engine's own fits. */
const ZOOM_TO_LAYER_SECONDS = 0.8;

/**
 * Entry kinds whose handle is one of the targets `Viewer.flyTo` frames. It
 * reads their extent for us — a tileset's bounding sphere, an imagery layer's
 * rectangle, a data source's entities — which is the whole reason a fit goes
 * through the handle rather than the store. The two point kinds are left out:
 * a `PointPrimitiveCollection` is not a flyTo target, and those layers carry
 * bounds in the store anyway.
 */
const FLY_TO_KINDS = new Set<EntryKind>(["imagery", "geojson", "kml", "czml", "3dtiles"]);

/** A tileset with a bounding sphere wider than this (metres) is framed at street level. */
const LARGE_TILESET_RADIUS_M = 20_000;

/** Above this radius (metres) a tileset is global, not regional, and is framed whole. */
const REGIONAL_TILESET_MAX_RADIUS_M = 1_000_000;

/** The camera distance (metres) for framing a large tileset's centre. */
const LARGE_TILESET_VIEW_RANGE_M = 1_200;

/**
 * Entry construction for `CesiumLayerSync`: building the Cesium object for
 * each layer kind (GeoJSON, KML, CZML, video, point clouds, point batches, 3D
 * Tiles), settling it, and flying to a layer once it has loaded.
 */
export class CesiumLayerSyncEntries extends CesiumLayerSyncImagery {
  /** Layer whose fit is waiting for its Cesium object to finish loading. */
  protected pendingZoomLayerId: string | null = null;

  /** Runs a pending {@link zoomToLayer} once `entry` has something to fly to. */
  protected flushPendingZoom(entry: LayerEntry): void {
    if (this.pendingZoomLayerId !== entry.layer.id) return;
    if (this.flyToHandle(entry)) this.pendingZoomLayerId = null;
  }

  /**
   * Fly to whatever `entry` put in the scene. Returns false when there is
   * nothing to frame yet (still loading, already removed, or a handle kind
   * that carries no extent), so the caller can leave the request pending.
   */
  private flyToHandle(entry: LayerEntry): boolean {
    const handle = entry.handle;
    if (!handle || entry.cancelled || !FLY_TO_KINDS.has(entry.kind)) return false;
    const viewer = this.viewer;
    // Cesium throws from `flyTo` mid-morph. Drop the fit (reported as handled)
    // the way the engine's own flights are skipped then.
    if (viewer.scene.mode === this.Cesium.SceneMode.MORPHING) return true;
    // An I3S scene layer is a `3dtiles` entry, but an I3SDataProvider is not a
    // target `Viewer.flyTo` accepts; it publishes its footprint as a rectangle.
    const extent = (handle as { extent?: Rectangle }).extent;
    this.deps.onFlyTo?.();
    if (extent) {
      viewer.camera.flyTo({
        destination: extent,
        duration: ZOOM_TO_LAYER_SECONDS,
        complete: () => this.deps.onFlyToComplete?.(),
      });
      return true;
    }
    if (this.flyToLargeTilesetCentre(entry)) return true;
    void Promise.resolve(
      viewer.flyTo(handle as ImageryLayer | DataSource | Cesium3DTileset, {
        duration: ZOOM_TO_LAYER_SECONDS,
      }),
    )
      // Resolves false when the flight was cancelled. A rejection still ends
      // the flight the engine was told about, or its terrain correction would
      // stay off.
      .then((completed) => {
        if (completed) this.deps.onFlyToComplete?.();
      })
      .catch(() => this.deps.onFlyToComplete?.());
    return true;
  }

  /**
   * Frame a tileset that spans a region at its centre, from street level.
   *
   * `Viewer.flyTo` frames a tileset's whole bounding sphere. For a national
   * building tileset such as 3D BAG (all of the Netherlands) that is a view
   * from about 100 km up, where its level of detail loads no buildings, so the
   * layer looked as if it had not drawn. A tileset wider than
   * {@link LARGE_TILESET_RADIUS_M} is framed at the ground point under its
   * centre instead, as the 2D map's fly-to does. (The sphere's own centre lies
   * kilometres underground for a region that wide, so it cannot be the target.)
   *
   * @param entry The entry being framed.
   * @returns True when it started the flight.
   */
  private flyToLargeTilesetCentre(entry: LayerEntry): boolean {
    if (entry.kind !== "3dtiles") return false;
    const sphere = (entry.handle as Partial<Cesium3DTileset> | undefined)?.boundingSphere;
    // A global tileset (a sphere the size of the Earth, centred near its core)
    // has no meaningful ground point; it keeps the whole-tileset framing.
    if (
      !sphere ||
      !(sphere.radius > LARGE_TILESET_RADIUS_M) ||
      sphere.radius > REGIONAL_TILESET_MAX_RADIUS_M
    ) {
      return false;
    }
    const { Cesium, viewer } = this;
    const centre = Cesium.Cartographic.fromCartesian(sphere.center);
    if (!centre) return false;
    const ground = Cesium.Cartesian3.fromRadians(centre.longitude, centre.latitude, 0);
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(ground, 1), {
      duration: ZOOM_TO_LAYER_SECONDS,
      offset: new Cesium.HeadingPitchRange(
        0,
        Cesium.Math.toRadians(-45),
        LARGE_TILESET_VIEW_RANGE_M,
      ),
      complete: () => this.deps.onFlyToComplete?.(),
    });
    return true;
  }

  protected createEntry(layer: GeoLibreLayer): void {
    const kind = entryKind(layer);
    const entry: LayerEntry = { kind, layer, handle: null, cancelled: false };
    if ((kind === "imagery" || kind === "3dtiles") && layer.source.requestHeaders) {
      entry.resolvedHeaders = resolvedRequestHeaders(layer);
    }
    this.entries.set(layer.id, entry);
    let created: Promise<void> | null = null;
    if (kind === "imagery") created = this.createImagery(entry);
    else if (kind === "geojson") created = this.createGeoJson(entry);
    else if (kind === "kml") created = this.createKml(entry);
    else if (kind === "czml") created = this.createCzml(entry);
    else if (kind === "video") created = this.createVideo(entry);
    else if (kind === "pointcloud") created = this.createPointCloud(entry);
    else if (kind === "points") this.createPointBatch(entry);
    else created = this.createTileset(entry);
    // Every create funnels through here, so this is where a fit requested
    // before the handle existed runs (see zoomToLayer) and where a load
    // failure is reported.
    if (created) void created.then(() => this.settleEntry(entry));
    else this.settleEntry(entry);
  }

  /** Runs the once-loaded work for `entry`: a pending fit, or a load failure. */
  private settleEntry(entry: LayerEntry): void {
    this.flushPendingZoom(entry);
    // Report a failure only while the entry is still the layer's current one:
    // a removed or rebuilt entry is gone from `entries`. `cancelled` cannot
    // decide this, since a failed imagery entry is parked as cancelled too.
    if (entry.loadError && this.entries.get(entry.layer.id) === entry) {
      this.deps.onLayerError?.({
        layerId: entry.layer.id,
        layerName: entry.layer.name,
        message: entry.loadError,
      });
    }
  }

  private async createVideo(entry: LayerEntry): Promise<void> {
    const { Cesium, viewer } = this;
    const urls = videoUrls(entry.layer);
    const corners = videoCorners(entry.layer);
    if (urls.length === 0 || !corners) return;

    const createEl =
      this.deps.createVideoElement ??
      (() => (typeof document !== "undefined" ? document.createElement("video") : null));
    const video = createEl();
    if (!video) {
      entry.loadError = "Video layers require a browser DOM.";
      return;
    }
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.autoplay = true;
    if (urls.length === 1) {
      video.src = urls[0];
    } else if (typeof document !== "undefined") {
      for (const srcUrl of urls) {
        const sourceEl = document.createElement("source");
        sourceEl.src = srcUrl;
        video.appendChild(sourceEl);
      }
    } else {
      video.src = urls[0];
    }

    const CustomDataSourceCtor = (
      Cesium as unknown as { CustomDataSource?: new (name?: string) => DataSource }
    ).CustomDataSource;
    if (!CustomDataSourceCtor) {
      entry.loadError = "Cesium CustomDataSource is unavailable for video overlays.";
      return;
    }
    const dataSource = new CustomDataSourceCtor(entry.layer.name);
    const flatCoords = corners.flatMap(([lng, lat]) => [lng, lat]);
    const hierarchy = Cesium.Cartesian3.fromDegreesArray(flatCoords);
    // MapLibre video `coordinates` are ordered [topLeft, topRight, bottomRight, bottomLeft].
    // Explicit `textureCoordinates` with `height: 0` (ellipsoid PolygonGeometry, not a
    // GroundPrimitive which ignores textureCoordinates) preserves exact 4-corner
    // correspondence for rotated and skewed quadrilaterals.
    const uvCoords = [
      Cesium.Cartesian2 ? new Cesium.Cartesian2(0, 1) : ({ x: 0, y: 1 } as Cartesian2),
      Cesium.Cartesian2 ? new Cesium.Cartesian2(1, 1) : ({ x: 1, y: 1 } as Cartesian2),
      Cesium.Cartesian2 ? new Cesium.Cartesian2(1, 0) : ({ x: 1, y: 0 } as Cartesian2),
      Cesium.Cartesian2 ? new Cesium.Cartesian2(0, 0) : ({ x: 0, y: 0 } as Cartesian2),
    ];
    const PolygonHierarchyCtor = (
      Cesium as unknown as { PolygonHierarchy?: new (positions: unknown[]) => unknown }
    ).PolygonHierarchy;
    const textureCoordinates = PolygonHierarchyCtor
      ? new PolygonHierarchyCtor(uvCoords)
      : { positions: uvCoords, holes: [] };
    const opacity = this.effectiveOpacity(entry);
    const ImageMatCtor = (
      Cesium as unknown as {
        ImageMaterialProperty?: new (options: Record<string, unknown>) => unknown;
      }
    ).ImageMaterialProperty;
    const material = ImageMatCtor
      ? new ImageMatCtor({
          image: video,
          transparent: true,
          color: Cesium.Color.WHITE.withAlpha(opacity),
        })
      : video;

    const entity = (
      dataSource.entities as unknown as { add: (spec: Record<string, unknown>) => Entity }
    ).add({
      id: `video:${entry.layer.id}`,
      name: entry.layer.name,
      polygon: {
        hierarchy,
        height: 0,
        heightReference: Cesium.HeightReference?.NONE ?? 0,
        textureCoordinates,
        material,
      },
    });
    entry.videoElement = video;
    entry.videoEntity = entity;
    entry.videoReady =
      typeof video.readyState === "number"
        ? video.readyState >= 2
        : typeof video.addEventListener !== "function";
    entry.handle = dataSource;

    const detachListeners = () => {
      if (typeof video.removeEventListener === "function") {
        video.removeEventListener("loadeddata", onVideoReady);
        video.removeEventListener("canplay", onVideoReady);
        video.removeEventListener("error", onVideoError);
      }
    };
    const onVideoReady = () => {
      if (entry.cancelled) return;
      entry.videoReady = true;
      viewer.scene?.requestRender?.();
    };
    const onVideoError = () => {
      if (entry.cancelled) return;
      const code = video.error?.code;
      const detail = video.error?.message?.trim();
      entry.loadError ??= detail
        ? `Video load error: ${detail}`
        : code !== undefined
          ? `Video load error (code ${code})`
          : "Video failed to load.";
      this.settleEntry(entry);
    };
    if (typeof video.addEventListener === "function") {
      video.addEventListener("loadeddata", onVideoReady);
      video.addEventListener("canplay", onVideoReady);
      video.addEventListener("error", onVideoError);
      entry.videoCleanup = detachListeners;
    }

    if (entry.cancelled) {
      entry.videoCleanup?.();
      entry.videoCleanup = undefined;
      this.teardownVideoElement(video);
      return;
    }
    await viewer.dataSources.add(dataSource);
    if (entry.cancelled) {
      viewer.dataSources.remove(dataSource, true);
      entry.videoCleanup?.();
      entry.videoCleanup = undefined;
      this.teardownVideoElement(video);
      return;
    }
    entry.added = true;
    this.applyAppearance(entry);
    if (entry.layer.visible) {
      void Promise.resolve(video.play?.()).catch((error: unknown) => {
        if (entry.cancelled) return;
        const name = error instanceof Error ? error.name : "";
        if (name === "AbortError") return;
        entry.loadError ??=
          error instanceof Error && error.message
            ? `Video playback error: ${error.message}`
            : "Video playback failed.";
        this.settleEntry(entry);
      });
    }
    viewer.scene?.requestRender?.();
  }

  protected teardownVideoElement(video: HTMLVideoElement): void {
    try {
      video.pause?.();
      while (video.firstChild) video.removeChild(video.firstChild);
      video.removeAttribute?.("src");
      video.load?.();
    } catch {
      // Best-effort teardown on synthetic or already-detached elements.
    }
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
      const kind = pointCloudSourceKind(url);
      if (kind === "ept" || kind === "copc") {
        // An octree cloud needs detail where the camera is, not one sample
        // of the whole cloud: stream it by view.
        const source =
          kind === "ept"
            ? await openEptSource(url, { ...this.deps.eptOptions, signal: abort.signal })
            : await openCopcSource(url, { ...this.deps.copcOptions, signal: abort.signal });
        if (entry.cancelled) return;
        const streamer = new PointCloudStreamer(Cesium, viewer, source, {
          opacity: () => this.effectiveOpacity(entry),
          altitudeOffset: Number(entry.layer.source.altitudeOffset),
          onError: (message) => {
            entry.loadError ??= message;
          },
          // The first nodes can land after start() (outside the first view),
          // and the root can replace a fallback node's ground height.
          onNodeShown: () => this.applyPointCloudGround(entry),
        });
        entry.streamer = streamer;
        viewer.scene.primitives.add(streamer.collection);
        await streamer.start();
        if (entry.cancelled) return;
        entry.handle = streamer.collection;
        entry.appliedAlpha = String(this.effectiveOpacity(entry));
        this.applyAppearance(entry);
        return;
      }
      // A plain LAS/LAZ file has no octree to stream: one bounded sample.
      const cloud = await loadLasPointCloud(url, {
        ...this.deps.lasOptions,
        // The LiDAR control records the WKT it read, for a file whose own
        // CRS records are missing or unreadable.
        fallbackWkt: str(entry.layer.metadata?.wkt),
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
      if (cloud.count > 0) entry.pointCloudBase = cloud.zMin;
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
        { scene: viewer.scene, clampToGround, horizon: horizonDepthDistance(Cesium, viewer) },
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
    const opacity = this.effectiveOpacity(entry);
    const fillAlpha = (style.fillOpacity ?? 0.6) * opacity;
    const extOpacity =
      (Number.isFinite(style.extrusionOpacity) ? (style.extrusionOpacity as number) : 0.8) *
      opacity;

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
      const data = indexedFeatureCollection(layer.id, sourceGeoJson);
      // Pre-bake initial alpha into fill, stroke, and marker load options so
      // entities are created with their final initial materials.
      const dataSource = await Cesium.GeoJsonDataSource.load(data, {
        stroke: stroke.withAlpha(opacity),
        strokeWidth: style.strokeWidth ?? 2,
        fill: fill.withAlpha(fillAlpha),
        markerColor: Cesium.Color.fromCssColorString(style.markerColor ?? "#3b82f6").withAlpha(
          opacity,
        ),
        clampToGround,
      });
      if (entry.cancelled) return;

      entry.handle = dataSource;

      // A throw anywhere in the build below must not leave the entity
      // collection suspended: it would silence every later change event for
      // this layer, so applyGeoJsonFilter/applyGeoJsonStyle would go on
      // mutating a collection the visualizers never hear from again.
      (dataSource.entities as { suspendEvents?: () => void }).suspendEvents?.();
      try {
        this.indexGeoJsonEntities(entry, dataSource);
        hideSlicedPolygonOutlines(viewer, dataSource, data);
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
        // applyAppearance → applyGeoJsonStyle fades every entity kind (fill,
        // stroke, marker) by the layer opacity right after load, so points/lines
        // match the 2D map instead of rendering fully opaque.
        this.applyAppearance(entry);

        const writers = entityHeightWriters(Cesium, viewer);
        if (style.extrusionEnabled) {
          applyGeoJsonExtrusion(
            Cesium,
            viewer,
            dataSource,
            style,
            sourceGeoJson.features,
            extOpacity,
            writers,
          );
        }
        // Runs alongside extrusion too: a collection mixing extruded buildings
        // with Z-carrying points/lines loads unclamped (clampToGround is false
        // whenever either applies), so those entities still need their
        // terrain-relative reference; the polygons were handled above.
        if (has3dElevation) {
          applyElevationHeightReferences(dataSource, style, writers);
        }
      } finally {
        (dataSource.entities as { resumeEvents?: () => void }).resumeEvents?.();
      }

      if (entry.cancelled) return;
      // Add the data source to the viewer ONLY after all entity properties,
      // materials, visibilities, and 3D heights are settled. Adding beforehand
      // causes Cesium's StaticGroundGeometryColorBatch to start building worker
      // batches that get repeatedly invalidated and rebuilt by subsequent
      // property mutations, starving polygon compilation (#2311).
      await viewer.dataSources.add(dataSource);
      if (entry.cancelled) {
        viewer.dataSources.remove(dataSource, true);
        return;
      }
      entry.added = true;

      this.restoreHighlight();
      this.applyHighlight();
    } catch (error) {
      // A malformed FeatureCollection should not break the whole sync.
      entry.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Map each loaded entity back to its feature (for picking and filtering)
   * and label each feature once when the layer has labels.
   */
  private indexGeoJsonEntities(entry: LayerEntry, dataSource: DataSource): void {
    const { Cesium, viewer } = this;
    const layer = entry.layer;
    const style = layer.style ?? {};
    // A multipart feature arrives as several entities sharing one index; it
    // gets one label, on its largest part (pickLabelPart), not one per part.
    // The grouping (and pickLabelPart's geometry math) is skipped outright
    // when the layer has no labels, so an unlabelled boundary set pays nothing.
    const labelsEnabled = Boolean({ ...DEFAULT_LAYER_STYLE.labels, ...style.labels }.enabled);
    const labelEntity = labelsEnabled ? createCesiumLabeler(Cesium, viewer, layer) : null;
    const parts = new Map<number, Entity[]>();
    for (const entity of dataSource.entities.values) {
      const index = entityFeatureIndex(viewer, entity);
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
  }

  /** Load native KML/KMZ geometry, styles, overlays, and network links. */
  private async createKml(entry: LayerEntry): Promise<void> {
    const { Cesium: C, viewer } = this;
    const source = cesiumKmlSource(entry.layer);
    if (!source) return;
    const container = document.createElement("div");
    Object.assign(container.style, { position: "absolute", inset: "0", pointerEvents: "none" });
    viewer.canvas.parentElement?.appendChild(container);
    entry.overlayContainer = container;
    const ds = new C.KmlDataSource({ camera: viewer.camera, canvas: viewer.canvas });
    try {
      const target = source.startsWith("<")
        ? new DOMParser().parseFromString(source, "application/xml")
        : source.startsWith("data:")
          ? await (await fetch(source)).blob()
          : source;
      if (entry.cancelled) {
        ds.destroy();
        container.remove();
        entry.overlayContainer = undefined;
        return;
      }
      await ds.load(target, { screenOverlayContainer: container });
      if (entry.cancelled) {
        ds.destroy();
        container.remove();
        entry.overlayContainer = undefined;
        return;
      }
      entry.handle = ds;
      entry.documentCleanup = bindDocumentOpacity(C, ds, () => this.effectiveOpacity(entry));
      this.applyAppearance(entry);
      await viewer.dataSources.add(ds);
      if (entry.cancelled) {
        viewer.dataSources.remove(ds, true);
        entry.documentCleanup?.();
        entry.documentCleanup = undefined;
        container.remove();
        entry.overlayContainer = undefined;
        entry.handle = null;
        return;
      }
      entry.added = true;
      viewer.scene.requestRender();
    } catch (error) {
      entry.documentCleanup?.();
      entry.documentCleanup = undefined;
      entry.handle = null;
      ds.destroy();
      container.remove();
      entry.overlayContainer = undefined;
      if (!entry.cancelled)
        entry.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Load a CZML (Cesium Language) document as a dynamic 3D scene (issue #2290).
   * Supports URL endpoints or inline packets (an array, or the same serialized
   * as a JSON string) with dynamic time-tagged positions, orbits, models, paths,
   * and clock synchronization. Which document drives the viewer clock is
   * decided by {@link electCzmlClockOwner}.
   *
   * @param entry The synchronizer entry tracking this CZML layer.
   */
  private async createCzml(entry: LayerEntry): Promise<void> {
    const { Cesium, viewer } = this;
    const source = czmlSource(entry.layer);
    if (!source) return;
    // `CzmlDataSource.load` treats a string as a URL to fetch, so a serialized
    // inline document has to be parsed before it reaches Cesium.
    const inline = typeof source.data === "string" ? parseCzml(source.data) : source.data;
    if (typeof source.data === "string" && !inline) {
      entry.loadError = "Invalid CZML document";
      return;
    }
    const target = inline ?? source.url;
    if (!target) return;

    try {
      const dataSource = await Cesium.CzmlDataSource.load(target);
      if (entry.cancelled) return;

      entry.handle = dataSource;
      dataSource.show = entry.layer.visible;
      // A deck.gl model layer fades with the layer opacity like the 2D overlay.
      if (entry.layer.metadata?.[DECK_VIZ_GLOBE_METADATA_KEY]) {
        entry.documentCleanup = bindDocumentOpacity(Cesium, dataSource, () =>
          this.effectiveOpacity(entry),
        );
      }

      await viewer.dataSources.add(dataSource);
      if (entry.cancelled) {
        viewer.dataSources.remove(dataSource, true);
        return;
      }
      entry.added = true;
      const attribution = str(entry.layer.source.attribution);
      if (attribution && Cesium.Credit && viewer.creditDisplay?.addStaticCredit) {
        entry.credit = new Cesium.Credit(escapeCreditHtml(attribution), false);
        viewer.creditDisplay.addStaticCredit(entry.credit);
      }
      // Only a document that reached the scene may drive the clock.
      this.electCzmlClockOwner();
      // The entities exist only now. A selection made — or merely re-applied by
      // the canvas effect — while the document was loading found no handle to
      // paint, so replay it the way `createGeoJson` does; a ten-minute feed
      // refresh rebuilds the document under a highlighted satellite.
      this.restoreHighlight();
      this.applyHighlight();
      viewer.scene?.requestRender?.();
    } catch (error) {
      if (entry.cancelled) return;
      entry.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Re-elect the CZML layer that drives the viewer clock: the first layer in
   * the synced layer order whose loaded document carries a `clock` packet. The
   * globe has a single clock, so election goes by layer order rather than by
   * load completion — two documents loading in parallel settle the same way
   * every time — and removing the owner hands the clock to the next document
   * instead of leaving the viewer on a stale interval. Nothing is written while
   * the owner stays the same, so a later CZML load never resets the Time
   * Slider's position, which keeps driving `currentTime` through
   * {@link setTime}. When the last CZML layer leaves, the clock is left where
   * that document set it: the Time Slider owns time from then on, and nothing
   * else on the globe expects a particular interval.
   */
  protected electCzmlClockOwner(): void {
    let owner: LayerEntry | undefined;
    for (const layer of this.currentLayers) {
      const entry = this.entries.get(layer.id);
      if (entry?.kind !== "czml" || entry.cancelled || !entry.added) continue;
      if (!czmlDocumentClock(entry.handle)) continue;
      owner = entry;
      break;
    }
    if (owner?.layer.id === this.czmlClockOwner) return;
    this.czmlClockOwner = owner?.layer.id;
    const clock = owner ? czmlDocumentClock(owner.handle) : undefined;
    const viewerClock = this.viewer.clock;
    if (!clock || !viewerClock) return;
    if (clock.startTime) viewerClock.startTime = clock.startTime as never;
    if (clock.stopTime) viewerClock.stopTime = clock.stopTime as never;
    if (clock.currentTime) viewerClock.currentTime = clock.currentTime as never;
    if (clock.clockRange !== undefined) viewerClock.clockRange = clock.clockRange as never;
    if (clock.multiplier !== undefined) viewerClock.multiplier = clock.multiplier as never;
  }

  private async createTileset(entry: LayerEntry): Promise<void> {
    const { Cesium, viewer } = this;
    const layer = entry.layer;
    const ionAsset = cesiumIonAssetId(layer);
    if (ionAsset !== null) {
      try {
        // `fromIonAssetId` only knows the global default token; resolve the
        // asset through an IonResource so the app's token is used instead.
        const resource = await Cesium.IonResource.fromAssetId(ionAsset, {
          accessToken: this.ionAccessToken(),
        });
        if (entry.cancelled) return;
        const tileset = await Cesium.Cesium3DTileset.fromUrl(resource, {});
        if (entry.cancelled) {
          tileset.destroy();
          return;
        }
        viewer.scene.primitives.add(tileset);
        entry.handle = tileset;
        this.discoverTilesetFields(entry, tileset);
        this.applyAppearance(entry);
      } catch (error) {
        if (!entry.cancelled) {
          entry.loadError = error instanceof Error ? error.message : String(error);
        }
      }
      return;
    }
    const url = tilesetUrl(layer);
    if (!url) return;
    // Google Photorealistic tiles strip their X-GOOG-API-KEY from the store, so
    // resolve it back (from runtime env) exactly as the 2D render path does —
    // otherwise the tileset would silently 401/403 and never render on the globe.
    const headers = resolveThreeDTilesRequestHeaders(
      url,
      resolveProjectHeaderReferences(
        layer.source.requestHeaders as Record<string, string> | undefined,
      ),
    );
    const hasHeaders = Boolean(headers && Object.keys(headers).length);
    if (hasHeaders && !allowsCredentials(url)) {
      console.warn(
        `[GeoLibre] skipping "${layer.name}" on the globe: request headers cannot be sent over ${url}`,
      );
      entry.loadError = "Request headers require an HTTPS tileset URL";
      return;
    }
    const resource = hasHeaders
      ? new Cesium.Resource({ url, headers, proxy: CREDENTIAL_PROXY })
      : url;
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
        const tilesets = i3sTilesets(provider);
        entry.handle = provider;
        // One sub-layer is enough for the schema: an I3S scene service publishes
        // one attribute set that every layer it drives shares.
        if (tilesets[0]) this.discoverTilesetFields(entry, tilesets[0]);
        this.applyAppearance(entry);
        return;
      }
      const tileset = await Cesium.Cesium3DTileset.fromUrl(resource, {});
      if (entry.cancelled) {
        tileset.destroy();
        return;
      }
      viewer.scene.primitives.add(tileset);
      if (layer.type === "lidar" && tileset.pointCloudShading) {
        // Eye-dome lighting and attenuation: the reading aids the 2D LiDAR
        // control's dynamic mode gives, native in Cesium's point-cloud shader.
        tileset.pointCloudShading.attenuation = true;
        tileset.pointCloudShading.eyeDomeLighting = true;
      }
      entry.handle = tileset;
      this.discoverTilesetFields(entry, tileset);
      this.applyAppearance(entry);
    } catch (error) {
      // A tileset that fails to load should not break the whole sync.
      entry.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Publish a tileset's attribute names the first time a tile with features
   * becomes visible (issue #2290).
   *
   * A tileset carries its schema in the tiles, not in the layer record, so
   * there is nothing to read until one has actually rendered. The listener is
   * one-shot — the names are a property of the tileset, not of the tile — and
   * is removed with the entry, so a layer dropped mid-load leaves nothing
   * subscribed to the scene.
   */
  private discoverTilesetFields(entry: LayerEntry, tileset: Cesium3DTileset): void {
    const publish = this.deps.onTilesetFields;
    if (!publish) return;
    const layerId = entry.layer.id;
    const stop = () => {
      entry.fieldsListener?.();
      entry.fieldsListener = undefined;
    };
    const remove = tileset.tileVisible.addEventListener((tile: unknown) => {
      const content = (tile as { content?: TileContentLike } | undefined)?.content;
      if (!content?.featuresLength || typeof content.getFeature !== "function") return;
      const ids = content.getFeature(0)?.getPropertyIds?.();
      stop();
      if (Array.isArray(ids) && ids.length > 0) publish(layerId, ids);
    });
    entry.fieldsListener = remove;
  }

  /**
   * Id of the CZML layer whose document `clock` the viewer clock follows; see
   * {@link electCzmlClockOwner}. Re-elected when that layer is destroyed.
   */
  protected czmlClockOwner: string | undefined;
}
