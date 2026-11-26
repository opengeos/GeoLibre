import { imageryColorAdjustments } from "./raster-color-adjustments";
import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { cogSourceUrl } from "./cesium-cog-imagery";
import { drapeSignature, isDrapedLayer, MapLibreDrape } from "./cesium-drape";
import { deckVizGlobeLayer } from "./cesium-deck-viz";
import { isZarrImageryProvider } from "./cesium-zarr-imagery";
import { ProtocolImageryProvider } from "./cesium-protocol-imagery";
import type { BoundingSphere } from "@cesium/core";
import type {
  Cesium3DTileset,
  DataSource,
  I3SDataProvider,
  ImageryLayer,
  PointPrimitiveCollection,
} from "@cesium/engine";
import {
  isZarrLayer,
  isCogLayer,
  isI3sLayer,
  extractTimeFilterDate,
  hasGeoJsonCollection,
  isCesiumSupportedLayerType,
  isSupported,
} from "./cesium-layer-records";
import {
  BOUNDING_SPHERE_STATE_PENDING,
  type LayerEntry,
  tilesLoaded,
  entryKind,
} from "./cesium-layer-entry";
import { needsRebuild } from "./cesium-layer-rebuild";
import { resolvedRequestHeaders } from "./cesium-imagery-providers";
import { CesiumLayerSyncEntries } from "./cesium-layer-sync-entries";
export { type PMTilesRasterHeader, type CesiumLayerSyncDeps } from "./cesium-layer-sync-base";
export { withoutGeoJsonCrs } from "./cesium-geojson-entities";
export {
  type MovingPointFeatureDescription,
  applyI3sBuildingVisibility,
} from "./cesium-layer-entry";
export {
  composeLayerFeatureFilter,
  extractTimeFilterDate,
  CESIUM_SUPPORTED_LAYER_KINDS,
  isCesiumSupportedLayerType,
} from "./cesium-layer-records";

// The imagery colour solve is shared with the ArcGIS engine
// (raster-color-adjustments.ts); re-exported here for existing importers.
export { imageryColorAdjustments };

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
//
// The class is split by concern across an inheritance chain, each layer in its
// own module: CesiumLayerSyncBase (engine handles and entry state) <-
// CesiumLayerSyncSelection (identify and highlight) <- CesiumLayerSyncAppearance
// (in-place styling) <- CesiumLayerSyncImagery (imagery providers and order) <-
// CesiumLayerSyncEntries (building each layer kind) <- CesiumLayerSync (the
// public sync, fit, status and teardown API). A formerly private member another
// layer reads is `protected`; the rest keep their visibility.

export class CesiumLayerSync extends CesiumLayerSyncEntries {
  private scratchBoundingSphere?: BoundingSphere;

  /**
   * Fly the camera to a layer's own extent, for the layers that have no bounds
   * in the store: an Ion asset, a tileset by URL, CZML, KML. Their extent is a
   * property of the loaded Cesium object (a tileset's bounding sphere, an
   * imagery layer's rectangle, a data source's entities), so `getLayerBounds`
   * has nothing to offer and `CesiumEngine.fitLayer` hands the fit here.
   *
   * A layer added a moment ago has no handle yet, so the request is remembered
   * and runs when that entry finishes loading. Only one is kept: a second
   * request replaces the first rather than queueing a flight behind it.
   *
   * @param layerId - The store id of the layer to frame.
   */
  zoomToLayer(layerId: string): void {
    this.pendingZoomLayerId = layerId;
    const entry = this.entries.get(layerId);
    if (entry) this.flushPendingZoom(entry);
  }

  getRenderStatus(): { pending: string[]; errors: string[] } {
    const pending: string[] = [];
    const errors: string[] = [];
    for (const layer of this.currentLayers) {
      if (!layer.visible || layer.opacity === 0) continue;
      if (hasGeoJsonCollection(layer) && !layer.geojson?.features.length) continue;
      // "2D only" kinds (vector files, DuckDB queries, deck.gl heatmaps, ...) are skipped on
      // the globe by design and flagged as such in the layer list, so they are
      // not load failures: reporting them in `errors` would make every capture
      // throw for an ordinary mixed project.
      if (!isCesiumSupportedLayerType(layer)) continue;
      if (isDrapedLayer(layer)) {
        const error = this.drapeError ?? this.drape?.error;
        if (error) errors.push(`${layer.name}: ${error}`);
        else if (!this.drape || !this.drape.ready || this.drape.pending > 0)
          pending.push(layer.name);
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
      else if (entry.kind === "geojson") {
        const ds = entry.handle as DataSource;
        // `entry.added` gates the bounding-sphere scan below: until the data
        // source joins `viewer.dataSources`, `getBoundingSphere` finds no owner
        // for its entities and answers FAILED rather than PENDING, which would
        // read as "settled" while the layer is still being built.
        if (ds.isLoading || !entry.added) {
          pending.push(layer.name);
        } else if (this.viewer.dataSourceDisplay) {
          const display = this.viewer.dataSourceDisplay as {
            getBoundingSphere?: (
              entity: unknown,
              allowPartial: boolean,
              result: unknown,
            ) => number | undefined;
          };
          if (typeof display.getBoundingSphere === "function") {
            const cesiumAny = this.Cesium as unknown as {
              BoundingSphereState?: { PENDING?: number };
            };
            const pendingState =
              cesiumAny.BoundingSphereState?.PENDING ?? BOUNDING_SPHERE_STATE_PENDING;
            const scratch = (this.scratchBoundingSphere ??= new this.Cesium.BoundingSphere());
            // Rescanned on every poll rather than memoised per entry: a clamped
            // polygon re-enters PENDING whenever new terrain tiles arrive, with
            // no style or filter change to invalidate a cache on, and Cesium's
            // own `DataSourceDisplay.ready` latches true and never drops back.
            // A stale "settled" is the #2311 bug; the scan short-circuits on the
            // first pending entity and only runs while a capture is polling.
            for (const entity of ds.entities.values) {
              if (entity.show === false) continue;
              if (entity.polygon || entity.polyline || entity.corridor || entity.wall) {
                const state = display.getBoundingSphere(entity, false, scratch);
                if (state === pendingState) {
                  pending.push(layer.name);
                  break;
                }
              }
            }
          }
        }
      } else if (entry.kind === "czml" || entry.kind === "kml") {
        const ds = entry.handle as DataSource;
        if (ds.isLoading || !entry.added) {
          pending.push(layer.name);
        }
      } else if (entry.kind === "video") {
        if (!entry.added || !entry.videoReady) {
          pending.push(layer.name);
        }
      } else if (entry.kind === "imagery" && !(entry.handle as ImageryLayer).ready)
        pending.push(layer.name);
    }
    return { pending, errors };
  }
  /** Imagery id order last asserted on the globe, to skip redundant reorders. */
  private lastImageryOrder = "";
  /** Un-materialized store layers from the latest sync pass (used for DuckDB edit refreshes). */
  private lastStoreLayers: GeoLibreLayer[] = [];

  private unsubscribeEnvironment: (() => void) | null = null;
  private unwatchTerrain: (() => void) | null = null;
  private unwatchDuckDB: (() => void) | null = null;

  /**
   * Re-sync materialized DuckDB query layers when attribute edits or query
   * refreshes invalidate the DuckDB bridge cache outside the layer store.
   */
  private watchDuckDB(): void {
    if (this.unwatchDuckDB || typeof window === "undefined") return;
    const handler = (event: Event) => {
      if (this.destroyed) return;
      const layerId = (event as CustomEvent<{ layerId?: string }>).detail?.layerId;
      const hasDuckDB = this.lastStoreLayers.some(
        (layer) => layer.type === "duckdb-query" && (layerId === undefined || layer.id === layerId),
      );
      if (hasDuckDB) this.sync(this.lastStoreLayers);
    };
    window.addEventListener("geolibre:duckdb-layer-updated", handler);
    this.unwatchDuckDB = () => window.removeEventListener("geolibre:duckdb-layer-updated", handler);
  }

  /**
   * Re-ground the I3S scene layers whenever the globe's terrain provider
   * changes (#3374). Their offset depends on whether there is terrain, and
   * switching it (including World Terrain arriving asynchronously after the
   * first sync) changes no layer record, so the store-driven sync never sees it.
   */
  private watchTerrain(): void {
    if (this.unwatchTerrain) return;
    const scene = this.viewer.scene as {
      terrainProviderChanged?: { addEventListener(listener: () => void): unknown };
    };
    const remove = scene.terrainProviderChanged?.addEventListener(() => {
      for (const entry of this.entries.values()) {
        if (entry.kind === "3dtiles" && isI3sLayer(entry.layer)) this.applyTilesetAltitude(entry);
        else if (entry.kind === "pointcloud") this.applyPointCloudGround(entry);
      }
    });
    this.unwatchTerrain = typeof remove === "function" ? (remove as () => void) : () => {};
  }

  /**
   * Rebuild the imagery and 3D Tiles entries whose `${NAME}` request headers
   * now resolve differently. The layer records are unchanged when only a
   * variable changes, so the regular store-driven sync never sees it.
   */
  private watchEnvironment(): void {
    if (this.unsubscribeEnvironment) return;
    this.unsubscribeEnvironment = useAppStore.subscribe((state, previous) => {
      if (state.preferences.environmentVariables === previous.preferences.environmentVariables) {
        return;
      }
      const stale = [...this.entries.values()].some(
        (entry) =>
          entry.resolvedHeaders !== undefined &&
          entry.resolvedHeaders !== resolvedRequestHeaders(entry.layer),
      );
      if (stale) this.sync(this.lastStoreLayers);
    });
  }

  /** Materialize a DuckDB query layer's active GeoArrow rows into GeoJSON when available. */
  private resolveDuckDBLayer(layer: GeoLibreLayer): GeoLibreLayer {
    if (layer.type !== "duckdb-query" || layer.geojson) return layer;
    const provider =
      this.deps.getDuckDBGeoJson ??
      (typeof window !== "undefined"
        ? (
            window as unknown as {
              __GEOLIBRE_DUCKDB__?: { getLayerGeoJson?: (id: string) => FeatureCollection | null };
            }
          ).__GEOLIBRE_DUCKDB__?.getLayerGeoJson
        : undefined);
    const geojson = provider?.(layer.id);
    if (!geojson) return layer;
    return { ...layer, geojson };
  }

  /** Reconcile the globe to `layers` (order preserved for imagery stacking). */
  sync(storeLayers: GeoLibreLayer[]): void {
    this.lastStoreLayers = storeLayers;
    // deck.gl has no globe renderer: a Deck.gl Layer builder record is drawn
    // as the GeoJSON or CZML record it rewrites to (issue #2261), and active
    // DuckDB query layers materialize their GeoArrow rows into GeoJSON.
    const layers = storeLayers.map(
      (layer) => deckVizGlobeLayer(layer) ?? this.resolveDuckDBLayer(layer),
    );
    this.restoreHighlight();
    this.currentLayers = layers;
    this.watchEnvironment();
    this.watchTerrain();
    this.watchDuckDB();
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
      } else if (
        needsRebuild(existing.layer, layer) ||
        (existing.resolvedHeaders !== undefined &&
          existing.resolvedHeaders !== resolvedRequestHeaders(layer))
      ) {
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
        if (isZarrLayer(layer) && existing.kind === "imagery")
          this.refreshZarrImagery(existing, layer);
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
      // Cancel any deferred async reorder since sync() is reordering now.
      this.imageryReorderGeneration += 1;
      this.imageryReorderScheduled = false;
      this.reorderImagery();
      this.lastImageryOrder = imageryOrder;
    }
    this.applyHighlight();
    this.watchCameraZoom();
    this.reorderKmlOverlays();
    // Reordering two loaded CZML layers changes which one comes first.
    this.electCzmlClockOwner();
  }

  /**
   * Re-append the KML ScreenOverlay containers in store order. `createKml`
   * appends each container once, so a later panel reorder (which rebuilds
   * nothing) would leave two overlapping overlays stacked the way they happened
   * to load. Sibling DOM order decides that stacking, so re-appending in turn
   * re-asserts it — skipped unless the order actually changed, since each pass
   * moves live DOM nodes on a hot path.
   */
  private reorderKmlOverlays(): void {
    const containers: HTMLElement[] = [];
    for (const layer of this.currentLayers) {
      const container = this.entries.get(layer.id)?.overlayContainer;
      if (container) containers.push(container);
    }
    const order = this.currentLayers
      .filter((l) => this.entries.get(l.id)?.overlayContainer)
      .map((l) => l.id)
      .join("\n");
    if (order === this.lastKmlOverlayOrder) return;
    this.lastKmlOverlayOrder = order;
    for (const container of containers) container.parentElement?.appendChild(container);
  }

  /** The KML overlay stacking order {@link reorderKmlOverlays} last asserted. */
  private lastKmlOverlayOrder = "";

  destroy(): void {
    this.destroyed = true;
    this.imageryReorderGeneration += 1;
    this.imageryReorderScheduled = false;
    this.restoreHighlight();
    this.selection = null;
    this.movingPointLayers.clear();
    // Nothing to hand the clock to while everything is torn down.
    this.czmlClockOwner = undefined;
    for (const entry of this.entries.values()) this.destroyEntry(entry);
    this.entries.clear();
    this.unsubscribeEnvironment?.();
    this.unsubscribeEnvironment = null;
    this.unwatchTerrain?.();
    this.unwatchTerrain = null;
    this.unwatchDuckDB?.();
    this.unwatchDuckDB = null;
    this.removeDrapeLayer();
    this.drape?.destroy();
    this.drape = undefined;
    this.drapeKey = "";
    void this.cogTiler?.then((tiler) => tiler.clear()).catch(() => {});
    this.unwatchCamera?.();
    this.unwatchCamera = null;
  }

  /** The hidden MapLibre map draping tile-backed vector layers, once one is needed. */
  private drape: MapLibreDrape | null | undefined;
  private drapeKey = "";
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
    const removed = this.removeDrapeLayer();
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

  /** Drop the drape's imagery layer, if any; returns whether there was one. */
  private removeDrapeLayer(): boolean {
    if (!this.drapeLayer) return false;
    // As in destroyEntry: Cesium destroys the layer but not the provider,
    // whose abort controller cancels the tile renders still queued.
    const provider = this.drapeLayer.imageryProvider;
    this.viewer.imageryLayers.remove(this.drapeLayer, true);
    if (provider instanceof ProtocolImageryProvider) provider.destroy();
    this.drapeLayer = null;
    return true;
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
   * Tear down an entry and release its Cesium resources from the scene.
   *
   * @param entry The layer entry being destroyed.
   */
  private destroyEntry(entry: LayerEntry): void {
    entry.cancelled = true;
    // A fit still waiting on this entry has nothing left to frame.
    if (this.pendingZoomLayerId === entry.layer.id) this.pendingZoomLayerId = null;
    entry.abort?.abort();
    if (entry.streamer) {
      entry.streamer.destroy();
      // Removed before its first load landed: the collection is already in
      // the scene but not yet the entry's handle.
      if (entry.handle !== entry.streamer.collection)
        this.viewer.scene.primitives.remove(entry.streamer.collection);
      entry.streamer = undefined;
    }
    entry.documentCleanup?.();
    entry.documentCleanup = undefined;
    entry.overlayContainer?.remove();
    entry.overlayContainer = undefined;
    entry.videoCleanup?.();
    entry.videoCleanup = undefined;
    if (entry.videoElement) {
      this.teardownVideoElement(entry.videoElement);
      entry.videoElement = undefined;
      entry.videoEntity = undefined;
      entry.videoReady = undefined;
    }
    if (entry.credit) {
      this.viewer.creditDisplay?.removeStaticCredit?.(entry.credit);
      entry.credit = undefined;
    }
    entry.fieldsListener?.();
    entry.fieldsListener = undefined;
    entry.tileHealth?.();
    entry.tileHealth = undefined;
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
      // zarr-cesium aborts its pending chunk reads and drops its tile cache.
      if (isZarrImageryProvider(provider)) provider.destroy();
    } else if (
      entry.kind === "geojson" ||
      entry.kind === "czml" ||
      entry.kind === "kml" ||
      entry.kind === "video"
    ) {
      // `cancelled` is already set, so the election skips this entry.
      if (this.czmlClockOwner === entry.layer.id) this.electCzmlClockOwner();
      entry.cluster?.dispose();
      entry.cluster = undefined;
      // A cancelled entry can hold a data source that never reached the scene;
      // `remove` would silently no-op on it.
      if (entry.added) this.viewer.dataSources.remove(handle as DataSource, true);
    } else {
      // A tileset, an I3S provider, a point batch, or a point-cloud collection: all
      // scene primitives.
      this.viewer.scene.primitives.remove(
        handle as Cesium3DTileset | I3SDataProvider | PointPrimitiveCollection,
      );
    }
  }
}
