/**
 * The host side of the public plugin API: the {@link GeoLibreAppAPI} object
 * handed to every plugin's `activate`/`deactivate`/state hooks.
 *
 * Everything the API reaches through the `@geolibre/plugins` and `@geolibre/map`
 * barrels, plus the shared {@link PluginManager} and its project-state
 * bookkeeping, arrives through an {@link AppApiHost} rather than a static
 * import, as does the app's i18next instance. Those barrels load every
 * built-in plugin (and MapLibre's CSS) and `i18n/` uses `import.meta.glob`, so
 * none of them load under node. Injecting them is what lets
 * `tests/app-api.test.ts` build the real API with fakes; `hooks/usePlugins.ts`
 * supplies the real host.
 */
import type * as Proj4 from "proj4";
import {
  clearExternalNativePaintBridge,
  setExternalNativePaintBridge,
  useAppStore,
  type AppState,
  explainS3ReadError,
  isCredentialedS3Url,
  resolveReadableUrl,
} from "@geolibre/core";
import type { CesiumEngine, getPrimaryCesiumControlHost, MapEngine } from "@geolibre/map";
import type * as GeoLibrePlugins from "@geolibre/plugins";
import type {
  GeoLibreActiveMapTool,
  GeoLibreCogLayerOptions,
  GeoLibreCogRenderEngine,
  GeoLibreDeckGL,
  GeoLibreDownloadFolder,
  GeoLibreExternalNativeLayerRegistration,
  GeoLibreFileDialogOptions,
  GeoLibreRasterWindowOptions,
  GeoLibreTileLayerOptions,
  GeoLibreWmsLayerOptions,
  GeoLibreZarrLayerOptions,
  GeoLibreZarrQueryGeometry,
  GeoLibreZarrQueryOptions,
  GeoLibreZarrQuerySelector,
  PluginManager,
  TemporalLayerAdapter,
} from "@geolibre/plugins";
import { GEO_EDITOR_PLUGIN_ID } from "@geolibre/plugins/plugin-ids";
import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir, readFile } from "@tauri-apps/plugin-fs";
import type { RefObject } from "react";
import {
  createWmsTileUrl,
  normalizeWmsCrs,
  normalizeWmsVersion,
} from "../components/layout/add-data/helpers";
import { ensureFileExtension, useFileNamePrompt } from "../hooks/useFileNamePrompt";
import type { buildProjectEgressSnapshot } from "./build-project-snapshot";
import { cogEngineDefaults } from "./cog-render-engine";
import { appendDiagnostic } from "./diagnostics";
import { createExternalNativeStoreLayer } from "./external-native-layer";
import { resolvePluginAssetUrlForLoadedPlugin } from "./external-plugins";
import { fetchNativeWithWebviewFallback } from "./native-fetch-fallback";
import { fetchUrlBytes } from "./native-http";
import { nativeWmsTileUrl } from "./native-wms-url";
import { openExternalLink } from "./open-external";
import type { pluginCredentialHost } from "./plugin-credentials";
import { createPluginLayerGroupActions } from "./plugin-layer-groups";
import { pluginLayerMetadata } from "./plugin-layer-metadata";
import { createPluginLayerQueries } from "./plugin-layer-queries";
import { createPluginLayerStyleActions } from "./plugin-layer-style";
import { createPluginLocaleApi, type PluginLocaleI18n } from "./plugin-locale";
import { createPluginHttpSend, createPluginNativeFetch } from "./plugin-native-fetch";
import { openProjectFromUrlForPlugin } from "./plugin-open-project";
import { createRemoteDownload, type RemoteDownloadProgress } from "./remote-download";
import { requestSpaceborneLidarGranule } from "./spaceborne-lidar-handoff";
import { addPluginWfsLayer } from "./plugin-wfs-layer";
import {
  browserSaveFallsBackToDownload,
  openLocalDataFileWithFallback,
  pickVectorFilesWithSidecars,
  readVectorFileWithSidecars,
  saveTextFileWithFallback,
} from "./tauri-io";
import {
  dedupeVectorUrlFetch,
  fetchBrowserShapefileZip,
  isBlockedUrlError,
  vectorDownloadFileName,
} from "./vector-url-fetch";

type PluginsModule = typeof GeoLibrePlugins;

/**
 * Everything {@link createAppAPI} needs from outside this module. The real
 * host is assembled once in `hooks/usePlugins.ts`; tests pass fakes.
 *
 * The UI-registry and raster/Zarr members are handed straight through to
 * plugins under the same name, so each keeps its `@geolibre/plugins` type.
 */
export interface AppApiHost extends Pick<
  PluginsModule,
  | "addRasterToMap"
  | "readRasterWindow"
  | "setRasterRenderEngine"
  | "addZarrRasterLayer"
  | "queryZarrLayer"
  | "setZarrLayerSelector"
  | "registerTemporalLayer"
  | "unregisterTemporalLayer"
  | "queryOvertureFeatures"
  | "registerRightPanel"
  | "unregisterRightPanel"
  | "openRightPanel"
  | "collapseRightPanel"
  | "closeRightPanel"
  | "getActiveRightPanel"
  | "setActiveRightPanelDock"
  | "getActiveRightPanelDock"
  | "registerAssistantTool"
  | "registerAssistantToolSpec"
  | "registerAssistantGuidance"
  | "registerToolbarMenu"
  | "unregisterToolbarMenu"
  | "registerMenuContribution"
  | "unregisterMenuContribution"
  | "registerFloatingPanel"
  | "unregisterFloatingPanel"
  | "openFloatingPanel"
  | "closeFloatingPanel"
  | "getOpenFloatingPanels"
> {
  /** The shared plugin manager, for `activatePlugin`/`deactivatePlugin`. */
  plugins: Pick<
    PluginManager,
    "activate" | "deactivate" | "isActive" | "applyPluginState" | "subscribe"
  >;
  /** The project's plugin state as it would be persisted right now. */
  projectPluginStateSnapshot: () => unknown;
  /** Writes the plugin state to the project when it differs from `previousJson`. */
  persistProjectPluginState: (previousJson: string) => void;
  /** Records a contained plugin failure in the diagnostics panel. */
  reportPluginError: (pluginId: string, action: string, error: unknown) => void;
  /** Binds a temporal layer to the Time Slider and opens its dock. */
  bindTemporalLayer: (
    layerId: string,
    adapter: TemporalLayerAdapter,
    mapControllerRef?: RefObject<MapEngine | null>,
  ) => boolean;
  /** Builds the egress-ready project snapshot behind `getProjectSnapshot`. */
  buildProjectSnapshot: typeof buildProjectEgressSnapshot;
  /**
   * The host credential store. Its `get`/`set` take the owner plugin id as a
   * trailing argument, which the plugin manager's per-plugin scope injects.
   */
  credentials: typeof pluginCredentialHost;
  /** The app's i18next instance, behind the plugin locale API. */
  i18n: PluginLocaleI18n;
  /** The Cesium scene when `engine` is the Cesium engine, otherwise null. */
  getCesiumScene: (
    engine: MapEngine | null | undefined,
  ) => ReturnType<CesiumEngine["getCesiumScene"]>;
  /** The control host of a Cesium-primary map, used when no 2D engine is mounted. */
  getPrimaryCesiumControlHost: typeof getPrimaryCesiumControlHost;
}

const RASTER_PROXY_PATH = "/__geolibre_raster_proxy";

/**
 * Translate the public {@link GeoLibreTileLayerOptions} into the option bag
 * passed straight to `store.addTileLayer(name, opts, ...)`, dropping
 * `beforeLayerId` (which the store takes as a separate positional argument).
 * The remaining keys mix source-level fields (tileSize, bounds, ...) and
 * layer-level ones (visible, opacity); the store reads each by name.
 */
function tileLayerStoreOptions(method: string, options?: GeoLibreTileLayerOptions) {
  if (!options) return {};
  const { beforeLayerId: _beforeLayerId, metadata, ...rest } = options;
  const validMetadata = pluginLayerMetadata(method, metadata);
  return validMetadata ? { ...rest, metadata: validMetadata } : rest;
}

interface TauriRuntimeWindow extends Window {
  __TAURI_INTERNALS__?: unknown;
}

/**
 * The basemap a plugin sees as active: the Mapbox-only style while Mapbox is
 * the primary renderer, otherwise the shared MapLibre/Cesium basemap.
 *
 * `setBasemap` writes the same two fields, so `getActiveBasemap` and
 * `onBasemapChange` must read them through this one helper or a Mapbox style
 * change is written but never reported to `onBasemapChange` subscribers.
 */
function effectiveBasemapUrl(
  state: Pick<AppState, "primaryRenderer" | "preferences" | "basemapStyleUrl">,
): string {
  // eslint-disable-next-line local/no-renderer-kind-checks -- Mapbox keeps its own persisted style URL
  return state.primaryRenderer === "mapbox"
    ? (state.preferences.map.mapboxStyleUrl ?? state.basemapStyleUrl)
    : state.basemapStyleUrl;
}

/**
 * The host tool that owns map clicks right now.
 *
 * Feature selection wins over Identify, and both win over the GeoEditor, which
 * counts as active for as long as its plugin is on (its toolbar is on the map
 * and any click may place a vertex or pick a feature to edit).
 *
 * @param state - The store fields Identify and feature selection live in.
 * @param plugins - The plugin manager, read for the GeoEditor's active state.
 * @returns The active tool, or null for ordinary map interaction.
 */
function activeMapTool(
  state: Pick<AppState, "identifyLayerId" | "featureSelectionActive">,
  plugins: Pick<PluginManager, "isActive">,
): GeoLibreActiveMapTool {
  if (state.featureSelectionActive) return "feature-selection";
  if (state.identifyLayerId !== null) return "identify";
  return plugins.isActive(GEO_EDITOR_PLUGIN_ID) ? "geo-editor" : null;
}

/**
 * Builds the {@link GeoLibreAppAPI} object handed to plugins.
 *
 * Each call returns a fresh object; members read the store and the map engine
 * lazily (`mapControllerRef.current` is dereferenced per call), so an API built
 * before the map mounts works once it has. Map accessors return null, false or
 * a default when no engine is mounted.
 *
 * @param mapControllerRef - The primary map engine, if any.
 * @param host - The plugin manager, UI registries and renderer services.
 * @returns The host's plugin API object.
 */
export function createAppAPI(
  mapControllerRef: RefObject<MapEngine | null> | undefined,
  host: AppApiHost,
) {
  const manager = host.plugins;
  const store = useAppStore.getState();
  // Captured so methods that delegate to plugin helpers taking the AppAPI
  // itself (e.g. addCogLayer -> addRasterToMap) can pass `api`. Only read
  // when those methods are called, which is always after assignment.
  const api = {
    setBasemap: (url: string) => {
      const state = useAppStore.getState();
      // eslint-disable-next-line local/no-renderer-kind-checks -- Mapbox keeps its own persisted style URL
      if (state.primaryRenderer === "mapbox") {
        state.setPreferences({
          ...state.preferences,
          map: { ...state.preferences.map, mapboxStyleUrl: url },
        });
      } else {
        state.setBasemapStyleUrl(url);
      }
    },
    addGeoJsonLayer: (name: string, data: GeoJSON.FeatureCollection, sourcePath?: string) => {
      const id = store.addGeoJsonLayer(name, data, sourcePath);
      return id;
    },
    ...createPluginLayerQueries(),
    getActiveMapTool: () => activeMapTool(useAppStore.getState(), manager),
    onActiveMapToolChange: (callback: (tool: GeoLibreActiveMapTool) => void) => {
      let previousTool = activeMapTool(useAppStore.getState(), manager);
      const emitIfChanged = () => {
        // Renderer subscriptions can cancel selection in a nested store
        // update. Read the live state and remember the delivered value so
        // the outer update cannot emit a stale or duplicate notification.
        const tool = activeMapTool(useAppStore.getState(), manager);
        if (tool === previousTool) return;
        previousTool = tool;
        callback(tool);
      };
      // The GeoEditor's on/off state lives in the plugin manager, not the store.
      const unsubscribeStore = useAppStore.subscribe(emitIfChanged);
      const unsubscribePlugins = manager.subscribe(emitIfChanged);
      return () => {
        unsubscribeStore();
        unsubscribePlugins();
      };
    },
    addTileLayer: (name: string, url: string, options?: GeoLibreTileLayerOptions) =>
      store.addTileLayer(
        name,
        { type: "xyz", tiles: [url], url, ...tileLayerStoreOptions("addTileLayer", options) },
        options?.beforeLayerId ?? null,
      ),
    // Intentionally identical to addTileLayer except for the layer `type`.
    // XYZ and WMTS tile templates render through the same syncRasterTileLayer
    // path; the distinct type only changes how the layer is labelled/stored,
    // so the two helpers share an implementation by design (not a copy-paste).
    addWmtsLayer: (name: string, url: string, options?: GeoLibreTileLayerOptions) =>
      store.addTileLayer(
        name,
        { type: "wmts", tiles: [url], url, ...tileLayerStoreOptions("addWmtsLayer", options) },
        options?.beforeLayerId ?? null,
      ),
    addWmsLayer: (name: string, options: GeoLibreWmsLayerOptions) => {
      const {
        beforeLayerId,
        url,
        layers,
        styles,
        format,
        transparent,
        version,
        crs,
        queryable,
        metadata,
        ...tileOptions
      } = options;
      // TypeScript enforces these, but an untyped JS plugin can pass "" — an
      // empty endpoint yields a relative GetMap URL that resolves against the
      // app origin and passes the store's empty-tile guard, persisting a layer
      // that only 404s. Reject at the API boundary instead.
      if (!url) {
        throw new Error("addWmsLayer: options.url must be a non-empty string.");
      }
      if (!layers) {
        throw new Error("addWmsLayer: options.layers must be a non-empty string.");
      }
      const validMetadata = pluginLayerMetadata("addWmsLayer", metadata);
      const tileSize = tileOptions.tileSize ?? 256;
      const resolvedStyles = styles ?? "";
      const resolvedFormat = format ?? "image/png";
      const resolvedTransparent = transparent ?? true;
      const resolvedVersion = normalizeWmsVersion(version);
      // Mirror setMapProjection's unrecognized-value warning so a typo'd
      // version from an untyped JS plugin is visible instead of silently
      // coerced. Valid shorthand in a recognized 1.x family (e.g. "1.3") is
      // not warned about — it normalizes cleanly.
      if (
        version !== undefined &&
        (typeof version !== "string" || !/^1\.\d/.test(version.trim()))
      ) {
        console.warn(
          `[GeoLibre] addWmsLayer: unsupported WMS version "${String(
            version,
          )}"; using "${resolvedVersion}".`,
        );
      }
      const resolvedCrs = normalizeWmsCrs(crs, resolvedVersion);
      const tileUrl = createWmsTileUrl({
        endpoint: url,
        layers,
        styles: resolvedStyles,
        format: resolvedFormat,
        transparent: resolvedTransparent,
        tileSize,
        version: resolvedVersion,
        crs: resolvedCrs,
      });
      return store.addTileLayer(
        name,
        {
          type: "wms",
          tiles: [isTauriRuntime() ? nativeWmsTileUrl(tileUrl) : tileUrl],
          url,
          // Persist the WMS request parameters so the layer round-trips through
          // a saved project, mirroring the Add Data dialog's WMS source.
          source: {
            layers,
            styles: resolvedStyles,
            format: resolvedFormat,
            transparent: resolvedTransparent,
            version: resolvedVersion,
            crs: resolvedCrs,
            ...(queryable === false ? { queryable: false } : {}),
          },
          ...tileOptions,
          ...(validMetadata ? { metadata: validMetadata } : {}),
        },
        beforeLayerId ?? null,
      );
    },
    addWfsLayer: addPluginWfsLayer,
    // Unlike the tile helpers above, a COG is read client-side by the shared
    // raster control. Besides keeping every COG path on one renderer, this is
    // what mirrors the layer as `maplibre-gl-raster`, making the full Raster
    // symbology section available in the Style panel.
    addCogLayer: (name: string, url: string, options?: GeoLibreCogLayerOptions) => {
      const bands = options?.bands
        ?.split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
      const range =
        options?.rescaleMin !== undefined && options.rescaleMax !== undefined
          ? ([options.rescaleMin, options.rescaleMax] as [number, number])
          : undefined;
      return host.addRasterToMap(api, url, {
        name,
        // Control-wide, not per layer: see cogEngineDefaults.
        defaults: cogEngineDefaults(options?.engine),
        state: {
          ...(bands?.length ? { bands, mode: bands.length >= 3 ? "rgb" : "single" } : {}),
          ...(options?.colormap !== undefined ? { colormap: options.colormap } : {}),
          ...(range ? { rescale: [range] } : {}),
          ...(options?.nodata !== undefined ? { nodata: options.nodata } : {}),
          ...(options?.opacity !== undefined ? { opacity: options.opacity } : {}),
        },
        ...(options?.beforeLayerId ? { beforeId: options.beforeLayerId } : {}),
        ...(options?.zoomTo !== undefined ? { zoomTo: options.zoomTo } : {}),
      });
    },
    setCogRenderEngine: (engine: GeoLibreCogRenderEngine) =>
      host.setRasterRenderEngine(api, engine),
    // Zarr goes through the components plugin's shared @carbonplan/zarr-layer
    // control for the same reason as addCogLayer: the host owns the renderer, so
    // a plugin does not bundle (and fail to activate) a second copy.
    addZarrLayer: (name: string, url: string, options: GeoLibreZarrLayerOptions) =>
      host.addZarrRasterLayer(api, {
        url,
        name,
        variable: options?.variable,
        ...(options?.selector !== undefined ? { selector: options.selector } : {}),
        ...(options?.clim !== undefined ? { clim: options.clim } : {}),
        ...(options?.colormap !== undefined ? { colormap: options.colormap } : {}),
        ...(options?.opacity !== undefined ? { opacity: options.opacity } : {}),
        ...(options?.zarrVersion !== undefined ? { zarrVersion: options.zarrVersion } : {}),
        ...(options?.crs !== undefined ? { crs: options.crs } : {}),
        ...(options?.proj4 !== undefined ? { proj4: options.proj4 } : {}),
        ...(options?.bounds !== undefined ? { bounds: options.bounds } : {}),
        ...(options?.spatialDimensions !== undefined
          ? { spatialDimensions: options.spatialDimensions }
          : {}),
        ...(options?.headers !== undefined ? { headers: options.headers } : {}),
        beforeLayerId: options?.beforeLayerId ?? null,
      }),
    setZarrLayerSelector: (layerId: string, selector: Record<string, number | string>) =>
      host.setZarrLayerSelector(layerId, selector),
    // Click-to-value and region statistics on a natively rendered cube: the
    // renderer owns the grid, so it reprojects the WGS84 geometry and masks fill
    // values itself instead of every plugin re-reading the store (#1555).
    queryZarrLayer: (
      layerId: string,
      geometry: GeoLibreZarrQueryGeometry,
      selector?: GeoLibreZarrQuerySelector,
      options?: GeoLibreZarrQueryOptions,
    ) => host.queryZarrLayer(layerId, geometry, selector, options),
    // A layer whose time is an internal dimension joins the Time Slider through
    // an adapter rather than a filter or a source swap. Registering only makes
    // it bindable; `bind` writes the binding and opens the dock, which is what a
    // plugin that just loaded a cube usually wants.
    registerTemporalLayer: (
      layerId: string,
      adapter: TemporalLayerAdapter,
      options?: { bind?: boolean },
    ) => {
      const detach = host.registerTemporalLayer(layerId, adapter);
      if (options?.bind) host.bindTemporalLayer(layerId, adapter, mapControllerRef);
      return detach;
    },
    unregisterTemporalLayer: (layerId: string) => host.unregisterTemporalLayer(layerId),
    getActiveBasemap: () => effectiveBasemapUrl(useAppStore.getState()),
    getBasemapLayerIds: () => mapControllerRef?.current?.getBasemapStyleLayerIds() ?? [],
    onBasemapChange: (callback: (styleUrl: string) => void) =>
      useAppStore.subscribe((state, prev) => {
        const current = effectiveBasemapUrl(state);
        if (current !== effectiveBasemapUrl(prev)) {
          callback(current);
        }
      }),
    getLayers: () => useAppStore.getState().layers.map((layer) => layer.id),
    onLayersChanged: (callback: (layerIds: string[]) => void) =>
      useAppStore.subscribe((state, prev) => {
        const layerIds = state.layers.map((layer) => layer.id);
        if (
          layerIds.length !== prev.layers.length ||
          layerIds.some((id, index) => id !== prev.layers[index]?.id)
        ) {
          callback(layerIds);
        }
      }),
    fetchArrayBuffer: fetchRemoteArrayBuffer,
    nativeFetch: isTauriRuntime() ? pluginNativeFetch() : undefined,
    downloadRemoteFile: isTauriRuntime()
      ? createRemoteDownload(invoke, () => new Channel<RemoteDownloadProgress>())
      : undefined,
    pickDownloadFolder: isTauriRuntime()
      ? () => invoke<GeoLibreDownloadFolder | null>("pick_download_folder")
      : undefined,
    openSpaceborneLidarGranule: (data: ArrayBuffer, fileName: string) =>
      requestSpaceborneLidarGranule({ data, fileName }),
    resolvePluginAssetUrl: resolvePluginAssetUrlForLoadedPlugin,
    activatePlugin: async (pluginId: string, state?: unknown) => {
      const activated = await manager.activate(pluginId, api);
      if (!activated || !manager.isActive(pluginId)) return false;
      return state === undefined ? true : manager.applyPluginState(pluginId, api, state);
    },
    // The counterpart of activatePlugin, so a plugin that opened another
    // plugin's panel can close it again (#1512). Persisted like the toolbar's
    // own toggle, so the project records the panel as off; a throw from the
    // target's imperative teardown is contained rather than escaping into the
    // caller.
    deactivatePlugin: (pluginId: string) => {
      if (!manager.isActive(pluginId)) return false;
      const before = JSON.stringify(host.projectPluginStateSnapshot());
      try {
        manager.deactivate(pluginId, api);
      } catch (error) {
        host.reportPluginError(pluginId, "deactivate", error);
        return false;
      }
      host.persistProjectPluginState(before);
      return !manager.isActive(pluginId);
    },
    queryOvertureFeatures: host.queryOvertureFeatures,
    ...createPluginLayerGroupActions(),
    ...createPluginLayerStyleActions(),
    fitBounds: (bounds: [number, number, number, number]) =>
      mapControllerRef?.current?.fitBounds(bounds),
    getViewBounds: () => mapControllerRef?.current?.getViewBounds() ?? null,
    getMap: () => mapControllerRef?.current?.getMap() ?? null,
    readRasterWindow: (layerId: string, options: GeoLibreRasterWindowOptions) =>
      host.readRasterWindow(layerId, options),
    getMapRenderer: () => useAppStore.getState().primaryRenderer,
    getArcgisView: () => {
      const engine = mapControllerRef?.current;
      // eslint-disable-next-line local/no-renderer-kind-checks -- reaches that engine's own handle
      return engine?.kind === "arcgis" &&
        "getView" in engine &&
        typeof engine.getView === "function"
        ? engine.getView()
        : null;
    },
    getArcgisControlMap: () => {
      const engine = mapControllerRef?.current;
      // eslint-disable-next-line local/no-renderer-kind-checks -- reaches that engine's own handle
      return engine?.kind === "arcgis" &&
        "getControlMap" in engine &&
        typeof engine.getControlMap === "function"
        ? engine.getControlMap()
        : null;
    },
    getMapboxMap: () => {
      const engine = mapControllerRef?.current;
      // eslint-disable-next-line local/no-renderer-kind-checks -- reaches that engine's own handle
      return engine?.kind === "mapbox" &&
        "getMapboxMap" in engine &&
        typeof engine.getMapboxMap === "function"
        ? engine.getMapboxMap()
        : null;
    },
    getMapboxGl: () => {
      const engine = mapControllerRef?.current;
      // eslint-disable-next-line local/no-renderer-kind-checks -- reaches that engine's own handle
      return engine?.kind === "mapbox" &&
        "getMapboxGl" in engine &&
        typeof engine.getMapboxGl === "function"
        ? engine.getMapboxGl()
        : null;
    },
    getMapboxAccessToken: () => {
      const engine = mapControllerRef?.current;
      // eslint-disable-next-line local/no-renderer-kind-checks -- reaches that engine's own handle
      return engine?.kind === "mapbox" &&
        "getMapboxAccessToken" in engine &&
        typeof engine.getMapboxAccessToken === "function"
        ? engine.getMapboxAccessToken()
        : null;
    },
    getCesiumScene: () => host.getCesiumScene(mapControllerRef?.current),
    getProjectSnapshot: () => host.buildProjectSnapshot(mapControllerRef ?? { current: null }),
    openExternalUrl: (url: string) => void openExternalLink(url),
    openProjectFromUrl: (url: string, signal?: AbortSignal) =>
      openProjectFromUrlForPlugin(
        url,
        (key, fallback, params) => host.i18n.t(key as never, { defaultValue: fallback, ...params }),
        signal,
      ),
    pickLocalDirectoryFiles,
    // Present only on desktop (filesystem access); the Vector panel keys off its
    // presence to auto-discover shapefile sidecars instead of forcing the user
    // to select every component, and to capture the file's path for restore.
    pickVectorFilesWithSidecars: isTauriRuntime() ? pickVectorFilesWithSidecars : undefined,
    // Shared across the sibling layers of one multi-layer container, which all
    // carry the container's URL: without this a six-layer KMZ downloaded itself
    // six times over on every project open and every refresh tick.
    fetchVectorUrl: (sourceUrl: string) =>
      dedupeVectorUrlFetch(sourceUrl, async () => {
        const name = vectorDownloadFileName(sourceUrl);
        // A private bucket's object URL is downloaded through a presigned
        // URL; the layer keeps `sourceUrl`, so a restore signs it again.
        const url = isCredentialedS3Url(sourceUrl)
          ? await resolveReadableUrl(sourceUrl)
          : sourceUrl;
        // Each attempt gets its own budget rather than sharing one across all
        // three. A shared deadline would be spent by the native call in exactly
        // the case the fallbacks exist for (a slow origin), leaving them to
        // reject instantly on an already-aborted signal. Sibling layers now
        // await a single download, so an unbounded fetch would hold all of them
        // pending, which is why each attempt is bounded at all.
        const budget = () => AbortSignal.timeout(VECTOR_DOWNLOAD_TIMEOUT_SECS * 1000);
        if (isTauriRuntime()) {
          try {
            const bytes = await fetchUrlBytes(url, {
              context: "Add Vector Layer",
              // The default budget on this command is tile-sized (8s). A vector
              // dataset is not a tile. A few megabytes from a slow origin
              // routinely needs longer, and timing out here used to drop the
              // layer entirely, so ask for a download-sized budget instead.
              timeoutSecs: VECTOR_DOWNLOAD_TIMEOUT_SECS,
            });
            const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            return new File([array as Uint8Array<ArrayBuffer>], name);
          } catch (error) {
            // The webview is not subject to the backend's SSRF guard, so a URL
            // the native command refused by policy must not be retried here.
            if (isBlockedUrlError(error)) throw error;
            // Keep the browser path as a fallback for CORS-enabled origins the
            // native command could not reach.
            try {
              const response = await fetch(url, { signal: budget() });
              if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`);
              }
              return new File([await response.blob()], name);
            } catch {
              // GitHub's /raw route rejects browser CORS, so fall through to the
              // same guarded proxy used by the web build.
            }
          }
        }
        if (url !== sourceUrl) {
          // Handing the control null would make it read the unsigned URL
          // itself, which a private bucket refuses. Download the signed one.
          // A bucket whose CORS rules block this origin fails as "Failed to
          // fetch"; explain that instead.
          const response = await fetch(url, { signal: budget() }).catch(async (error: unknown) => {
            throw await explainS3ReadError(sourceUrl, error, (key, fallback, params) =>
              host.i18n.t(key as never, { defaultValue: fallback, ...params }),
            );
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
          }
          return new File([await response.blob()], name);
        }
        const proxyUrl = githubRawVectorProxyUrl(url);
        if (!isTauriRuntime()) {
          // DuckDB-WASM cannot read `/vsizip//vsicurl/` in a browser. Download
          // remote Shapefile archives first so maplibre-gl-vector receives the
          // same File shape as a working local drop and can unzip/register its
          // components itself. Leave every non-ZIP URL alone so formats such as
          // GeoParquet retain their direct range-read path.
          try {
            const archive = await fetchBrowserShapefileZip(url, budget());
            if (archive) return archive;
          } catch (error) {
            // GitHub's /raw route rejects browser CORS, so its existing guarded
            // proxy gets one chance below. For every other origin, preserve the
            // browser's real download/CORS failure instead of falling through to
            // DuckDB's misleading "does not exist in the file system" error.
            if (!proxyUrl) throw error;
          }
        }
        if (!proxyUrl) return null;
        const response = await fetch(proxyUrl, { signal: budget() });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        return new File([await response.blob()], name);
      }),
    readLocalVectorFile: readVectorFileWithSidecars,
    exportTextFile: (filename: string, content: string, options?: GeoLibreFileDialogOptions) => {
      const description = options?.description ?? "GeoJSON";
      const extensions = options?.extensions ?? ["geojson", "json"];
      const mimeType = options?.mimeType ?? "application/geo+json";
      void (async () => {
        let defaultName = filename;
        // Browsers without the File System Access picker can only download under
        // a fixed name. When the caller opts in, prompt so the user can choose
        // it (Tauri and Chromium already offer a name via their save dialogs).
        if (options?.promptName && browserSaveFallsBackToDownload()) {
          const chosen = await useFileNamePrompt.getState().prompt({
            defaultName: filename,
          });
          if (chosen === null) return;
          defaultName = ensureFileExtension(chosen, extensions);
        }
        await saveTextFileWithFallback(content, {
          defaultName,
          filters: [{ name: description, extensions }],
          browserTypes: [
            {
              description,
              accept: { [mimeType]: extensions.map((ext) => `.${ext}`) },
            },
          ],
          mimeType,
        });
      })().catch((error) => {
        console.error(`Could not export ${filename}.`, error);
      });
    },
    importTextFile: (options?: GeoLibreFileDialogOptions) => {
      const extensions = options?.extensions ?? ["json"];
      return openLocalDataFileWithFallback({
        filters: [{ name: options?.description ?? "JSON", extensions }],
        accept: extensions.map((ext) => `.${ext}`).join(","),
        readText: true,
      }).then((result) => result?.text ?? null);
    },
    registerExternalNativeLayer: (registration: GeoLibreExternalNativeLayerRegistration) => {
      const state = useAppStore.getState();
      const existing = state.layers.find((layer) => layer.id === registration.id);
      const layer = createExternalNativeStoreLayer(registration, existing);
      // A re-registration that omits paintBridge drops the previous one, so the
      // plugin owns the bridge the same way it owns `style`/`source`. Set it
      // before the store write so the first sync already sees it.
      setExternalNativePaintBridge(registration.id, registration.paintBridge);
      if (existing) {
        state.updateLayer(layer.id, layer);
      } else {
        state.addLayer(layer);
      }
    },
    unregisterExternalNativeLayer: (id: string) => {
      const state = useAppStore.getState();
      clearExternalNativePaintBridge(id);
      if (state.layers.some((layer) => layer.id === id)) {
        state.removeLayer(id);
      }
    },
    addMapControl: (
      control: Parameters<MapEngine["addControl"]>[0],
      position?: Parameters<MapEngine["addControl"]>[1],
    ) =>
      mapControllerRef?.current?.addControl(control, position) ??
      host.getPrimaryCesiumControlHost()?.addControl(control, position) ??
      false,
    removeMapControl: (control: Parameters<MapEngine["removeControl"]>[0]) => {
      if (mapControllerRef?.current) {
        mapControllerRef.current.removeControl(control);
      } else {
        host.getPrimaryCesiumControlHost()?.removeControl(control);
      }
    },
    setBuiltInMapControlVisible: (
      control: Parameters<MapEngine["setBuiltInControlVisible"]>[0],
      visible: boolean,
    ) => mapControllerRef?.current?.setBuiltInControlVisible(control, visible) ?? false,
    setTerrainEnabled: (enabled: boolean) =>
      mapControllerRef?.current?.setTerrainEnabled(enabled) ?? false,
    isTerrainEnabled: () => mapControllerRef?.current?.isTerrainEnabled() ?? false,
    getBuiltInMapControlPosition: (
      control: Parameters<MapEngine["getBuiltInControlPosition"]>[0],
    ) => mapControllerRef?.current?.getBuiltInControlPosition(control) ?? "top-right",
    setBuiltInMapControlPosition: (
      control: Parameters<MapEngine["setBuiltInControlPosition"]>[0],
      position: Parameters<MapEngine["setBuiltInControlPosition"]>[1],
    ) => mapControllerRef?.current?.setBuiltInControlPosition(control, position) ?? false,
    // Hand external plugins GeoLibre's own deck.gl modules so they render on the
    // host's single deck.gl instance (a bundled second copy throws on the
    // deck.gl/luma.gl version guards and fails to render). Memoized so repeated
    // calls reuse one resolved module set.
    getDeckGL: (() => {
      let cached: Promise<GeoLibreDeckGL> | undefined;
      return () =>
        (cached ??= Promise.all([
          import("@deck.gl/core"),
          import("@deck.gl/layers"),
          import("@deck.gl/aggregation-layers"),
          import("@deck.gl/geo-layers"),
          import("@deck.gl/mesh-layers"),
          import("@deck.gl/mapbox"),
        ]).then(([core, layers, aggregationLayers, geoLayers, meshLayers, mapbox]) => ({
          core,
          layers,
          aggregationLayers,
          geoLayers,
          meshLayers,
          mapbox,
        })));
    })(),
    // Hand external plugins GeoLibre's own maplibre-gl-raster module so they
    // render COGs on the host's single deck.gl/luma.gl instance. A bundled
    // second copy throws on luma.gl's "already initialized" guard. Memoized so
    // repeated calls reuse one resolved module.
    getMaplibreGlRaster: (() => {
      let cached: Promise<typeof import("maplibre-gl-raster")> | undefined;
      return () =>
        (cached ??= import("maplibre-gl-raster").catch((error) => {
          // Don't memoize a rejection: a transient chunk-load failure would
          // otherwise poison getMaplibreGlRaster() for the whole session.
          cached = undefined;
          throw error;
        }));
    })(),
    // Share the host's proj4 instance; memoize loads but allow retry after failure.
    getProj4: (() => {
      let cached: Promise<typeof Proj4> | undefined;
      return () =>
        (cached ??= import("proj4").catch((error) => {
          cached = undefined;
          throw error;
        }));
    })(),
    // Set the persisted projection preference so the host's projection
    // enforcement keeps it (a raw map.setProjection is reverted on idle).
    // deck.gl-backed plugins need mercator; globe breaks deck tile traversal.
    setMapProjection: (projection: "globe" | "mercator") => {
      // External plugins call through a JS boundary where TypeScript can't
      // enforce the union, so reject anything else. An invalid value would be
      // persisted and make enforceProjection throw and reschedule on every idle
      // forever.
      if (projection !== "globe" && projection !== "mercator") {
        console.warn(
          `[GeoLibre] setMapProjection: ignoring unknown projection "${String(
            projection,
          )}" (expected "globe" or "mercator").`,
        );
        return;
      }
      const store = useAppStore.getState();
      const { map } = store.preferences;
      if (map.projection === projection) return;
      store.setPreferences({
        ...store.preferences,
        map: { ...map, projection },
      });
    },
    getMapProjection: () =>
      // Legacy projects may not carry a projection preference; default to globe
      // like MapController.enforceProjection so the declared return type holds.
      useAppStore.getState().preferences.map.projection ?? "globe",
    registerRightPanel: host.registerRightPanel,
    unregisterRightPanel: host.unregisterRightPanel,
    openRightPanel: host.openRightPanel,
    collapseRightPanel: host.collapseRightPanel,
    closeRightPanel: host.closeRightPanel,
    getActiveRightPanel: host.getActiveRightPanel,
    setActiveRightPanelDock: host.setActiveRightPanelDock,
    getActiveRightPanelDock: host.getActiveRightPanelDock,
    ...createPluginLocaleApi(host.i18n),
    credentials: host.credentials,
    registerAssistantTool: host.registerAssistantTool,
    registerAssistantToolSpec: host.registerAssistantToolSpec,
    registerAssistantGuidance: host.registerAssistantGuidance,
    registerToolbarMenu: host.registerToolbarMenu,
    unregisterToolbarMenu: host.unregisterToolbarMenu,
    registerMenuContribution: host.registerMenuContribution,
    unregisterMenuContribution: host.unregisterMenuContribution,
    registerFloatingPanel: host.registerFloatingPanel,
    unregisterFloatingPanel: host.unregisterFloatingPanel,
    openFloatingPanel: host.openFloatingPanel,
    closeFloatingPanel: host.closeFloatingPanel,
    getOpenFloatingPanels: host.getOpenFloatingPanels,
  };
  return api;
}

/**
 * The app's CORS/Tauri-aware whole-file fetch: native HTTP on the desktop
 * (bypassing webview CORS), the dev raster proxy in local development, plain
 * `fetch` otherwise.
 *
 * Exported for readers outside the plugin API that need the same path — the COG
 * spectral profile falls back to it when geotiff.js's own range requests are
 * refused (`useCogSpectralIdentify`).
 */
export async function fetchRemoteArrayBuffer(url: string): Promise<ArrayBuffer> {
  if (isTauriRuntime() && isLocalFileReference(url)) {
    return normalizeBytes(await readFile(localPathFromReference(url)));
  }

  if (isTauriRuntime()) {
    // The webview runs only when the server never answered the native request,
    // and a double failure reports the native reason (issue #2840).
    return fetchNativeWithWebviewFallback(
      async () => normalizeBytes(await fetchUrlBytes(url, { context: "plugin resource" })),
      (signal) => fetchWebviewArrayBuffer(url, signal),
    );
  }
  return fetchWebviewArrayBuffer(url);
}

/** The webview's own fetch, through the dev raster proxy in local development. */
async function fetchWebviewArrayBuffer(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (isLocalDevHost() && shouldUseDevRasterProxy(url)) {
    return fetchDevRasterProxy(url, signal);
  }

  try {
    return await fetchArrayBuffer(url, signal);
  } catch (error) {
    if (!isLocalDevHost()) throw error;
    return fetchDevRasterProxy(url, signal);
  }
}

async function pickLocalDirectoryFiles(): Promise<File[] | null> {
  if (!isTauriRuntime()) return null;
  const selected = await open({
    directory: true,
    multiple: false,
    recursive: true,
  });
  if (typeof selected !== "string") return null;
  return readTauriDirectoryFiles(selected);
}

async function readTauriDirectoryFiles(rootPath: string): Promise<File[]> {
  const rootName = localNameFromPath(rootPath) || "dataset";
  const files: File[] = [];
  const visited = new Set<string>();

  async function walk(directoryPath: string, relativePrefix: string): Promise<void> {
    if (visited.has(directoryPath)) return;
    visited.add(directoryPath);
    const entries = await readDir(directoryPath);
    for (const entry of entries) {
      const entryPath = joinLocalPath(directoryPath, entry.name);
      const relativePath = `${relativePrefix}${entry.name}`;
      if (entry.isDirectory) {
        await walk(entryPath, `${relativePath}/`);
        continue;
      }
      if (!entry.isFile) continue;
      const bytes = await readFile(entryPath);
      const file = new File([bytes], entry.name);
      Object.defineProperty(file, "webkitRelativePath", {
        configurable: true,
        value: `${rootName}/${relativePath}`,
      });
      files.push(file);
    }
  }

  await walk(rootPath, "");
  return files;
}

function joinLocalPath(parent: string, child: string): string {
  if (parent.endsWith("/") || parent.endsWith("\\")) return `${parent}${child}`;
  return `${parent}/${child}`;
}

function localNameFromPath(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? "";
}

function isLocalFileReference(value: string): boolean {
  if (value.startsWith("file://")) return true;
  return !/^[a-z][a-z\d+.-]*:/i.test(value);
}

function localPathFromReference(value: string): string {
  if (!value.startsWith("file://")) return value;
  return decodeURIComponent(new URL(value).pathname);
}

function fetchDevRasterProxy(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  return fetchArrayBuffer(`${RASTER_PROXY_PATH}?url=${encodeURIComponent(url)}`, signal);
}

async function fetchArrayBuffer(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.arrayBuffer();
}

let cachedPluginNativeFetch: typeof globalThis.fetch | null = null;

/** The desktop's native plugin fetch (lib/plugin-native-fetch.ts), built once. */
function pluginNativeFetch(): typeof globalThis.fetch {
  cachedPluginNativeFetch ??= createPluginNativeFetch(
    createPluginHttpSend(invoke, () => new Channel<void>()),
    appendDiagnostic,
  );
  return cachedPluginNativeFetch;
}

/** Whether the app runs in the Tauri desktop webview. */
export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as TauriRuntimeWindow).__TAURI_INTERNALS__);
}

const GITHUB_RAW_VECTOR_PROXY = "https://tiles.geolibre.app/github-raw";

/**
 * Budget for a native Add Vector Layer download, in seconds. Deliberately far
 * above `fetch_url_bytes`'s tile-sized default: this command carries whole
 * datasets, not 256px tiles, and a timeout here is not a slow tile that resolves
 * next frame but a layer that fails to restore.
 */
const VECTOR_DOWNLOAD_TIMEOUT_SECS = 180;

function githubRawVectorProxyUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443") ||
    url.search !== "" ||
    url.hash !== "" ||
    !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/raw\/.+$/.test(url.pathname)
  ) {
    return null;
  }
  const proxy = new URL(GITHUB_RAW_VECTOR_PROXY);
  proxy.searchParams.set("url", url.href);
  return proxy.href;
}

/**
 * Whether the dev raster proxy is there to use. It is served only by the Vite
 * dev server (`configureServer` in `vite.config.ts`), so the hostname alone is
 * not enough: the packaged desktop app on Linux and macOS also runs at
 * `tauri://localhost`, where the proxy path falls through to the SPA's
 * `index.html` and a failed request would "succeed" with the page's HTML
 * (issue #2840).
 *
 * @returns True on a local Vite dev server, including `tauri dev`.
 */
function isLocalDevHost(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function shouldUseDevRasterProxy(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return (
      parsedUrl.hostname === "github.com" && parsedUrl.pathname.includes("/releases/download/")
    );
  } catch {
    return false;
  }
}

function normalizeBytes(bytes: number[] | Uint8Array): ArrayBuffer {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}
