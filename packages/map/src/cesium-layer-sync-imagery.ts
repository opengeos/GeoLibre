// CesiumLayerSync layer: imagery providers and imagery ordering.
// The CesiumLayerSync layer chain is documented in cesium-layer-sync.ts.

import {
  installCogTilerDatumShift,
  withJpegTablesPatch,
  cesiumIonAssetId,
  getCesiumIonToken,
  type GeoLibreLayer,
} from "@geolibre/core";
import { cachingCogTiler, cogSourceUrl, createCogImageryProvider } from "./cesium-cog-imagery";
import {
  applyZarrRender,
  createZarrImageryProvider,
  isZarrImageryProvider,
  type ZarrCesiumModule,
} from "./cesium-zarr-imagery";
import { ProtocolImageryProvider, webMercatorRectangle } from "./cesium-protocol-imagery";
import { protocolScheme } from "./protocol-tiles";
import { getPMTilesArchive } from "./pmtiles-archive";
import { watchImageryTileHealth } from "./cesium-imagery-tile-health";
import type { ImageryLayer, ImageryProvider } from "@cesium/engine";
import {
  isZarrLayer,
  isCogLayer,
  ARCGIS_MAP_SERVICE_KIND,
  str,
  layerCredit,
  ARCGIS_REST_EXPORT,
  firstTile,
  wmtsCapabilities,
  pmtilesArchiveUrl,
} from "./cesium-layer-records";
import type { LayerEntry } from "./cesium-layer-entry";
import {
  type ImageryProviderRequest,
  imageryResourceFactory,
  arcgisMapServerImageryProvider,
  singleImageImageryProvider,
  wmsImageryProvider,
  wmtsImageryProvider,
  tileTemplateImageryProvider,
} from "./cesium-imagery-providers";
import type { PMTilesRasterHeader } from "./cesium-layer-sync-base";
import { CesiumLayerSyncAppearance } from "./cesium-layer-sync-appearance";

async function readSharedPMTilesHeader(url: string): Promise<PMTilesRasterHeader | undefined> {
  const archive = getPMTilesArchive(url);
  return archive ? archive.getHeader() : undefined;
}

/**
 * Imagery layers for `CesiumLayerSync`: building COG, Zarr, PMTiles and
 * service imagery providers, attaching them to the globe, and keeping the
 * imagery stack in store order.
 */
export class CesiumLayerSyncImagery extends CesiumLayerSyncAppearance {
  /**
   * The Ion token an asset layer loads with. Read at load time rather than at
   * construction, so a token added in Settings reaches the next sync.
   */
  protected ionAccessToken(): string {
    const token = (this.deps.ionToken ?? getCesiumIonToken)();
    if (!token) throw new Error("Cesium Ion token is not configured (Settings → Environment)");
    return token;
  }

  /**
   * The WASM COG tiler, loaded on first use and shared by every COG layer.
   * Lazy for the same reason the raster control loads it lazily: the module
   * and its peers are several megabytes that a globe without a COG never
   * needs. Injectable through `CesiumLayerSyncDeps` for tests.
   */
  protected cogTiler: Promise<ReturnType<typeof cachingCogTiler>> | null = null;

  private loadCogTiler(): Promise<ReturnType<typeof cachingCogTiler>> {
    this.cogTiler ??= (
      this.deps.loadCogTiler ??
      (async () => {
        const module = await import("cog-tiler-wasm");
        installCogTilerDatumShift(module);
        const { default: wasmUrl } = await import("lerc/lerc-wasm.wasm?url");
        module.configureLercDecoder({ wasmUrl });
        // JPEG COGs whose tiles omit their tables (Maxar/Vantor open data)
        // decode through geotiff.js, as on the 2D raster control.
        return withJpegTablesPatch(module);
      })
    )().then(cachingCogTiler, (error) => {
      // A failed module load must not poison every later COG for the life
      // of the globe; the next COG layer retries the import.
      this.cogTiler = null;
      throw error;
    });
    return this.cogTiler;
  }

  /** Drop a COG source from the cache once no remaining entry reads it. */
  protected forgetCogSource(entry: LayerEntry): void {
    const url = cogSourceUrl(entry.layer);
    if (!url || !this.cogTiler) return;
    for (const other of this.entries.values()) {
      if (other !== entry && isCogLayer(other.layer) && cogSourceUrl(other.layer) === url) return;
    }
    // A tiler that failed to load has nothing to forget; keep the rejection quiet.
    void this.cogTiler.then((tiler) => tiler.forget(url)).catch(() => {});
  }

  protected imageryReorderScheduled = false;

  protected imageryReorderGeneration = 0;

  private scheduleImageryReorder(): void {
    if (this.imageryReorderScheduled || this.destroyed) return;
    this.imageryReorderScheduled = true;
    const generation = this.imageryReorderGeneration;
    queueMicrotask(() => {
      this.imageryReorderScheduled = false;
      if (this.destroyed || this.imageryReorderGeneration !== generation) return;
      this.reorderImagery();
    });
  }

  protected reorderImagery(): void {
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

  /** The imagery layer the drape's tiles land on. */
  protected drapeLayer: ImageryLayer | null = null;

  protected drapeTopId: string | null = null;

  protected async createImagery(entry: LayerEntry): Promise<void> {
    const { viewer } = this;
    try {
      // Synchronous providers are attached in this same turn; only the
      // branches that fetch or import something await.
      const request = this.requestImageryProvider(entry);
      const provider = request.isAsync ? await request.pending : request.provider;
      // The layer was removed while its PMTiles header was read, before any
      // provider existed.
      if (provider === null) return;
      this.attachImageryProvider(entry, provider, request.isAsync);
    } catch (error) {
      // The layer was removed or rebuilt while its provider loaded: a real
      // cancellation, not a failure worth reporting.
      if (entry.cancelled) return;
      // A provider that throws synchronously (e.g. malformed params) or rejects
      // should not abort the sync pass; mirror createGeoJson/createTileset's
      // best-effort. The failure is recorded so settleEntry reports it.
      entry.loadError = error instanceof Error ? error.message : String(error);
      // The entry stays registered with a null handle rather than being deleted:
      // sync() re-runs on every unrelated store change (an opacity drag, a
      // reorder), so a deleted entry would be recreated (re-issuing the failing
      // request and re-warning) on every pass. Retrying is left to needsRebuild,
      // i.e. an actual change to this layer's source. Marking it cancelled keeps
      // later passes off it, and any imagery layer it did add is taken off the
      // globe, since an unready provider left there stops the whole globe
      // drawing.
      if (this.entries.get(entry.layer.id) === entry) {
        entry.cancelled = true;
        entry.tileHealth?.();
        entry.tileHealth = undefined;
        if (entry.handle) {
          viewer.imageryLayers.remove(entry.handle as ImageryLayer, true);
          entry.handle = null;
        }
      }
    }
  }

  /**
   * Start building the imagery provider an imagery entry draws with, picking
   * the branch its layer calls for: a Cesium Ion asset, an ArcGIS MapServer, a
   * georeferenced image, WMS, capabilities-driven WMTS, a COG, a raster
   * PMTiles archive, or (the fallback) a tile URL template. Throws what a
   * branch refuses.
   *
   * @returns The provider itself for the synchronous branches, or a pending
   *   one for the branches that await (so the imagery order must be
   *   re-asserted once it lands); a pending `null` means the layer was removed
   *   before a provider existed.
   */
  private requestImageryProvider(entry: LayerEntry): ImageryProviderRequest {
    const { Cesium } = this;
    const layer = entry.layer;
    // A tile template wins over the capabilities metadata: it needs no
    // provider-side matrix-set negotiation.
    const wmtsCaps =
      layer.type === "wmts" && !firstTile(layer) ? wmtsCapabilities(layer) : undefined;
    const { requireSecure, makeResource } = imageryResourceFactory(Cesium, layer);

    const ionAsset = cesiumIonAssetId(layer);
    if (ionAsset !== null) {
      return {
        isAsync: true,
        pending: Cesium.IonImageryProvider.fromAssetId(ionAsset, {
          accessToken: this.ionAccessToken(),
        }),
      };
    } else if (
      layer.type === "raster" &&
      layer.metadata?.sourceKind === ARCGIS_MAP_SERVICE_KIND &&
      str(layer.sourcePath)
    ) {
      return {
        isAsync: true,
        pending: arcgisMapServerImageryProvider(Cesium, layer, makeResource, requireSecure),
      };
    } else if (layer.type === "image" && str(layer.source.url)) {
      return { isAsync: true, pending: singleImageImageryProvider(Cesium, layer, makeResource) };
    } else if (
      layer.type === "wms" &&
      str(layer.source.url) &&
      // On desktop, routeWmsLayerThroughNativeProtocol rewrites `source.tiles`
      // to a `geolibre-wms://` template but leaves `source.url` as the plain
      // endpoint buildWmsLayer recorded. Matching on `source.url` alone would
      // therefore always take this branch and fetch the service straight from
      // the webview, which is the CORS failure the native fetcher exists to
      // avoid. Defer to the tile template whenever it names a protocol, so the
      // layer falls through to the bridge below (nothing between here and it
      // matches a WMS layer).
      !protocolScheme(firstTile(layer) ?? "") &&
      // A "wms" record whose tile is an ArcGIS REST export draws from that
      // template: Earthdata GIS records an ImageServer as `source.url` and its
      // `exportImage?bbox={bbox-epsg-3857}` as the tile, so a WMS provider
      // pointed at the url would request GetMap from a REST endpoint.
      !ARCGIS_REST_EXPORT.test(firstTile(layer) ?? "")
    ) {
      return { isAsync: false, provider: wmsImageryProvider(Cesium, layer, makeResource) };
    } else if (wmtsCaps) {
      return {
        isAsync: false,
        provider: wmtsImageryProvider(Cesium, layer, wmtsCaps, makeResource),
      };
    } else if (isCogLayer(layer)) {
      return { isAsync: true, pending: this.cogImageryProvider(layer) };
    } else if (isZarrLayer(layer)) {
      return { isAsync: true, pending: this.zarrImageryProvider(layer) };
    } else if (layer.type === "pmtiles" && pmtilesArchiveUrl(layer)) {
      return { isAsync: true, pending: this.pmtilesImageryProvider(entry) };
    } else {
      return {
        isAsync: false,
        provider: tileTemplateImageryProvider(Cesium, layer, makeResource),
      };
    }
  }

  /**
   * The WASM tiler renders the tiles itself (issue #2283), so neither
   * request headers nor a Resource apply: the COG is range-read by the
   * tiler from the same URL the raster control opened it from.
   */
  private async cogImageryProvider(layer: GeoLibreLayer): Promise<ImageryProvider> {
    return createCogImageryProvider(this.Cesium, await this.loadCogTiler(), layer);
  }

  /**
   * zarr-cesium reads the store itself (zarrita), from the layer's URL or the
   * store registered for it, so no Resource applies here either. The module
   * carries its colormap tables and 3D providers, so it loads on the first
   * Zarr layer the globe draws rather than with the globe.
   */
  private async zarrImageryProvider(layer: GeoLibreLayer): Promise<ImageryProvider> {
    this.zarrCesium ??= (this.deps.loadZarrCesium ?? (() => import("zarr-cesium")))().catch(
      (error: unknown) => {
        // Let the next Zarr layer retry a failed chunk load.
        this.zarrCesium = null;
        throw error;
      },
    );
    return createZarrImageryProvider(this.Cesium, await this.zarrCesium, layer);
  }

  private zarrCesium: Promise<ZarrCesiumModule> | null = null;

  /**
   * Draw the selector, colour limits and ramp `layer` asks for with the Zarr
   * entry's live provider, instead of reopening the store: the Time Slider
   * changes the selector on every step.
   *
   * Cesium caches the tiles an imagery layer has drawn, and a provider cannot
   * invalidate them, so a change that alters pixels swaps in a fresh
   * `ImageryLayer` over the same provider at the same stacking position — what
   * zarr-cesium's own `softRefreshCurrentView` does.
   */
  protected refreshZarrImagery(entry: LayerEntry, next: GeoLibreLayer): void {
    const previous = entry.layer;
    entry.layer = next;
    const imagery = entry.handle as ImageryLayer | null;
    // Still loading: attachImageryProvider applies the latest layer on arrival.
    if (!imagery) return;
    const provider = imagery.imageryProvider;
    if (!isZarrImageryProvider(provider)) return;
    if (!applyZarrRender(this.Cesium, provider, previous, next)) return;
    const layers = this.viewer.imageryLayers;
    const fresh = new this.Cesium.ImageryLayer(provider as unknown as ImageryProvider);
    layers.add(fresh, layers.indexOf(imagery));
    // Destroys the layer, not the provider, which the fresh layer now draws.
    layers.remove(imagery, true);
    this.imageryRefs.set(fresh, next.id);
    entry.handle = fresh;
  }

  /**
   * Raster PMTiles ride the shared `pmtiles://` protocol the 2D map
   * registers, through the same archive object, so a local (in-memory)
   * archive and a remote one both answer. The header bounds the tile
   * requests to what the archive actually holds.
   *
   * @returns The provider, or null when the entry was cancelled while the
   *   header was read.
   */
  private async pmtilesImageryProvider(entry: LayerEntry): Promise<ProtocolImageryProvider | null> {
    const { Cesium } = this;
    const layer = entry.layer;
    const url = pmtilesArchiveUrl(layer)!;
    const header = await (this.deps.readPMTilesHeader ?? readSharedPMTilesHeader)(url);
    if (entry.cancelled) return null;
    const rectangle =
      header && [header.minLon, header.minLat, header.maxLon, header.maxLat].every(Number.isFinite)
        ? webMercatorRectangle(Cesium, [header.minLon, header.minLat, header.maxLon, header.maxLat])
        : undefined;
    return new ProtocolImageryProvider(Cesium, {
      template: `${url}/{z}/{x}/{y}`,
      rectangle,
      minimumLevel: Number.isFinite(header?.minZoom) ? header?.minZoom : undefined,
      maximumLevel: Number.isFinite(header?.maxZoom) ? header?.maxZoom : undefined,
      credit: layerCredit(layer),
    });
  }

  /**
   * Add a built provider to the globe and register it as the entry's handle,
   * or tear it down when the entry was cancelled while it was being built.
   */
  private attachImageryProvider(
    entry: LayerEntry,
    provider: ImageryProvider | undefined,
    isAsync: boolean,
  ): void {
    const { viewer } = this;
    const layer = entry.layer;
    if (!provider || entry.cancelled) {
      // Reachable: the branches above await (the COG tiler, the PMTiles
      // header, ArcGIS/single-tile fromUrl), and the layer can be removed or
      // rebuilt in that window. Nothing has requested a tile yet, but the
      // provider still owns an abort controller, so tear it down rather than
      // dropping it.
      if (provider instanceof ProtocolImageryProvider) provider.destroy();
      if (isZarrImageryProvider(provider)) provider.destroy();
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
    // The provider was built from the layer as it was when the entry started;
    // a Time Slider step or restyle in the meantime was recorded on the entry.
    if (isZarrImageryProvider(provider)) applyZarrRender(this.Cesium, provider, undefined, layer);
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
      if (isZarrImageryProvider(provider)) provider.destroy();
      return;
    }
    this.imageryRefs.set(imageryLayer, layer.id);
    entry.handle = imageryLayer;
    const onTileFailure = this.deps.onTileFailure;
    if (onTileFailure)
      entry.tileHealth = watchImageryTileHealth(provider, (failure) => {
        // A rebuilt entry's provider can still settle tiles; only the current
        // one speaks for the layer.
        if (this.entries.get(layer.id) !== entry) return;
        onTileFailure({ ...failure, layerId: layer.id, layerName: layer.name });
      });
    this.applyAppearance(entry);
    if (isAsync) {
      // Coalesce concurrent async imagery resolutions into a single microtask
      // reorder pass instead of running an O(n) raiseToTop sweep per layer.
      this.scheduleImageryReorder();
    }
  }
}
