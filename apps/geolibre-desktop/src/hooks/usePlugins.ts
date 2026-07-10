import { useAppStore } from "@geolibre/core";
import {
  addCogRasterLayer,
  maplibreAnnotationsPlugin,
  maplibreBasemapControlPlugin,
  maplibreComponentsPlugin,
  maplibreDeckGlVizPlugin,
  maplibreDirectionsPlugin,
  maplibreElevationProfilePlugin,
  maplibreEffectsPlugin,
  getEffectsSettings,
  setEffectsSettings,
  type EffectsSettings,
  maplibreEnviroAtlasPlugin,
  maplibreEsriWaybackPlugin,
  maplibreFemaWmsPlugin,
  maplibreGeoAgentPlugin,
  maplibreGeoEditorPlugin,
  maplibreLayerControlPlugin,
  maplibreNasaEarthdataPlugin,
  maplibreNationalMapPlugin,
  maplibreOvertureMapsPlugin,
  maplibreGraticulePlugin,
  maplibreCloudsPlugin,
  maplibrePrecipitationPlugin,
  maplibreReverseGeocodePlugin,
  maplibreStreetViewPlugin,
  maplibreSunPlugin,
  maplibreSwipePlugin,
  SWIPE_PLUGIN_ID,
  maplibreTimeSliderPlugin,
  maplibreUsgsLidarPlugin,
  PluginManager,
  registerRightPanel,
  unregisterRightPanel,
  openRightPanel,
  collapseRightPanel,
  closeRightPanel,
  getActiveRightPanel,
  setActiveRightPanelDock,
  getActiveRightPanelDock,
  registerToolbarMenu,
  unregisterToolbarMenu,
  registerFloatingPanel,
  unregisterFloatingPanel,
  openFloatingPanel,
  closeFloatingPanel,
  getOpenFloatingPanels,
} from "@geolibre/plugins";
import type { MapController } from "@geolibre/map";
import type {
  GeoLibreCogLayerOptions,
  GeoLibreDeckGL,
  GeoLibreExternalNativeLayerRegistration,
  GeoLibreFileDialogOptions,
  GeoLibreMapControlPosition,
  GeoLibreTileLayerOptions,
  GeoLibreWmsLayerOptions,
} from "@geolibre/plugins";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readDir, readFile } from "@tauri-apps/plugin-fs";
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { bundledPluginManifestPaths } from "virtual:bundled-plugins";
import {
  installWebPluginArchive,
  listInstalledWebPlugins,
  loadExternalPlugins,
  reloadExternalUrlPlugin,
  resolvePluginAssetUrlForLoadedPlugin,
  uninstallWebPlugin,
  unloadFilesystemPlugin,
  unloadRemovedUrlPlugins,
  type InstalledWebPlugin,
} from "../lib/external-plugins";
import { appendDiagnostic } from "../lib/diagnostics";
import { fetchUrlBytes } from "../lib/native-http";
import { partitionProjectPluginManifestUrls } from "../lib/plugin-trust";
import {
  createWmsTileUrl,
  normalizeWmsVersion,
} from "../components/layout/add-data/helpers";
import { createExternalNativeStoreLayer } from "../lib/external-native-layer";
import { mergeStringLists } from "../lib/string-lists";
import {
  browserSaveFallsBackToDownload,
  openLocalDataFileWithFallback,
  pickVectorFilesWithSidecars,
  readVectorFileWithSidecars,
  saveTextFileWithFallback,
} from "../lib/tauri-io";
import { useDesktopSettingsStore } from "./useDesktopSettings";
import { ensureFileExtension, useFileNamePrompt } from "./useFileNamePrompt";

const RASTER_PROXY_PATH = "/__geolibre_raster_proxy";

/**
 * Translate the public {@link GeoLibreTileLayerOptions} into the option bag
 * passed straight to `store.addTileLayer(name, opts, ...)`, dropping
 * `beforeLayerId` (which the store takes as a separate positional argument).
 * The remaining keys mix source-level fields (tileSize, bounds, ...) and
 * layer-level ones (visible, opacity); the store reads each by name.
 */
function tileLayerStoreOptions(options?: GeoLibreTileLayerOptions) {
  if (!options) return {};
  const { beforeLayerId: _beforeLayerId, ...rest } = options;
  return rest;
}

/** Records a plugin failure in the diagnostics panel without crashing the app. */
function reportPluginError(
  pluginId: string,
  action: string,
  error: unknown,
): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  appendDiagnostic({
    category: "runtime",
    level: "error",
    message: `Plugin "${pluginId}" failed to ${action}: ${normalized.message}`,
    detail: normalized.stack,
    source: `plugin:${pluginId}`,
  });
}

interface TauriRuntimeWindow extends Window {
  __TAURI_INTERNALS__?: unknown;
}

const manager = new PluginManager();
manager.registerAll([
  maplibreLayerControlPlugin,
  maplibreGeoEditorPlugin,
  maplibreAnnotationsPlugin,
  maplibreBasemapControlPlugin,
  // The four web service plugins are grouped into the "Web Services"
  // submenu, rendered where the first of them appears in this order.
  maplibreFemaWmsPlugin,
  maplibreNasaEarthdataPlugin,
  maplibreEnviroAtlasPlugin,
  maplibreNationalMapPlugin,
  maplibreEsriWaybackPlugin,
  maplibreTimeSliderPlugin,
  maplibreOvertureMapsPlugin,
  maplibreGeoAgentPlugin,
  maplibreUsgsLidarPlugin,
  maplibreStreetViewPlugin,
  maplibreElevationProfilePlugin,
  maplibreSwipePlugin,
  maplibreGraticulePlugin,
  maplibreCloudsPlugin,
  maplibrePrecipitationPlugin,
  maplibreEffectsPlugin,
  maplibreSunPlugin,
  maplibreDirectionsPlugin,
  maplibreReverseGeocodePlugin,
  maplibreDeckGlVizPlugin,
  maplibreComponentsPlugin,
]);

let externalPluginsLoaded = false;
let externalPluginsLoadPromise: Promise<void> | null = null;
let externalPluginsLoadKey: string | null = null;
let externalPluginLoadIssues = new Map<string, string>();
const externalPluginsListeners = new Set<() => void>();
const EMPTY_PLUGIN_MANIFEST_URLS: string[] = [];

export function getPluginManager(): PluginManager {
  return manager;
}

export function getExternalPluginLoadIssues(): ReadonlyMap<string, string> {
  return externalPluginLoadIssues;
}

export function subscribeToExternalPluginLoads(
  listener: () => void,
): () => void {
  // Shares the ready-state listener set so marketplace rows update for both
  // successful loads and per-plugin load issues.
  externalPluginsListeners.add(listener);
  return () => externalPluginsListeners.delete(listener);
}

// Upgrade an installed external plugin in place by re-fetching its manifest URL
// and re-registering the published version. Used by the marketplace's Update
// action.
export async function upgradeExternalPlugin(
  manifestUrl: string,
  mapControllerRef: RefObject<MapController | null>,
): Promise<void> {
  await reloadExternalUrlPlugin(
    manager,
    manifestUrl,
    createAppAPI(mapControllerRef),
  );
}

// Install a plugin from a local `.zip` archive (desktop only). The Rust backend
// validates the archive and copies it into GeoLibre's app-data plugins
// directory so it persists across restarts; the plugins directory is then
// re-scanned so the new plugin loads without a reload. A reinstall of an
// already-loaded plugin id is unloaded first so the updated archive replaces it
// instead of being skipped by the loaded-source dedup. Returns the installed
// plugin id.
export async function installPluginArchive(
  sourcePath: string,
  mapControllerRef: RefObject<MapController | null>,
): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error("Installing plugin archives requires the desktop app.");
  }
  const pluginId = await invoke<string>("install_external_plugin_archive", {
    sourcePath,
  });
  const app = createAppAPI(mapControllerRef);
  // The archive was overwritten in place for a reinstall; drop the loaded copy
  // so the forced re-scan re-registers the updated version under the same id.
  unloadFilesystemPlugin(manager, pluginId, app);
  const desktopSettings = useDesktopSettingsStore.getState().desktopSettings;
  await ensureExternalPluginsLoadedWithSettings(desktopSettings, app, {
    force: true,
  });
  return pluginId;
}

// Install a plugin from an uploaded `.zip` in the browser (web build). The
// archive is unpacked and validated client-side, registered immediately, and
// persisted in IndexedDB so it reloads on the next visit. On desktop, use
// installPluginArchive instead (it copies the zip onto disk via the backend).
// Returns the installed plugin id.
export async function installPluginArchiveFromFile(
  fileName: string,
  bytes: Uint8Array,
  mapControllerRef: RefObject<MapController | null>,
): Promise<string> {
  return installWebPluginArchive(
    manager,
    fileName,
    bytes,
    createAppAPI(mapControllerRef),
  );
}

// Uninstall a plugin that was installed from a file in the browser.
export async function uninstallPluginArchiveFromFile(
  pluginId: string,
  mapControllerRef: RefObject<MapController | null>,
): Promise<void> {
  await uninstallWebPlugin(manager, pluginId, createAppAPI(mapControllerRef));
}

// List plugins installed from a file (browser IndexedDB), for the Manage
// Plugins UI. Returns an empty list on desktop and where IndexedDB is absent.
export function listPluginArchivesFromFile(): Promise<InstalledWebPlugin[]> {
  return listInstalledWebPlugins();
}

export function usePluginRegistry() {
  useSyncExternalStore(
    (listener) => manager.subscribe(listener),
    () => manager.getVersion(),
    () => manager.getVersion(),
  );

  return {
    plugins: manager.list(),
    isActive: (id: string) => manager.isActive(id),
    getMapControlPosition: (id: string) => manager.getMapControlPosition(id),
    getProjectState: () => manager.getProjectState(),
    toggle: (id: string, appApi: ReturnType<typeof createAppAPI>) => {
      const before = JSON.stringify(projectPluginStateSnapshot());
      // Layer Swipe and split view are mutually exclusive comparison modes:
      // stacking the swipe slider over a multi-pane grid fragments the
      // workspace (#844). The reverse direction (entering split view turns
      // swipe off) is handled by useSwipeSplitViewExclusivity.
      const collapseGridForSwipe =
        id === SWIPE_PLUGIN_ID && !manager.isActive(id);
      // Plugin controls are imperative MapLibre code, so a throw here escapes
      // React's error boundaries. Contain it so one bad plugin can't break the
      // toggle handler — surface it in diagnostics instead. Return without
      // persisting so a half-applied failure is not written to the project.
      try {
        manager.toggle(id, appApi);
      } catch (error) {
        // Known limitation: if toggle throws after a partial mutation (e.g. the
        // control attached but a later step failed), the in-memory PluginManager
        // state may be inconsistent. Project persistence is protected by the
        // early return below; in-memory state is not rolled back.
        reportPluginError(id, "toggle", error);
        return;
      }
      // Collapse the grid only once swipe actually activated, so a failed
      // activation (a throw above, or addMapControl returning false) leaves the
      // user's split-view layout intact. Done synchronously before React flushes
      // effects so useSwipeSplitViewExclusivity sees the single-pane grid and
      // doesn't undo the activation it just allowed.
      // Relies on maplibre-swipe activating synchronously (activate returns
      // false/undefined, never a Promise). PluginManager.activate marks a plugin
      // active optimistically and only rolls back async failures via
      // watchAsyncActivation, so isActive() would read true here before an async
      // mount confirms — revisit this guard if swipe ever gains a dynamic import.
      if (collapseGridForSwipe && manager.isActive(id)) {
        const { mapLayout, setMapGrid } = useAppStore.getState();
        if (mapLayout.rows * mapLayout.cols > 1) setMapGrid(1, 1);
      }
      persistProjectPluginState(before);
    },
    setMapControlPosition: (
      id: string,
      appApi: ReturnType<typeof createAppAPI>,
      position: GeoLibreMapControlPosition,
    ) => {
      const before = JSON.stringify(projectPluginStateSnapshot());
      try {
        manager.setMapControlPosition(id, appApi, position);
      } catch (error) {
        reportPluginError(id, "reposition", error);
        return;
      }
      persistProjectPluginState(before);
    },
    getEffectsSettings,
    // Live preview: push the appearance change straight to the engine for an
    // instant redraw, but do NOT persist. A color-picker drag or slider scrub
    // fires this every frame, so keeping persistence out avoids marking the
    // project dirty and sweeping Zustand subscribers on every pixel of movement.
    previewEffectsSettings: (next: Partial<EffectsSettings>) => {
      // Contained like toggle/reposition: setEffectsSettings drives imperative
      // canvas code (engine.applySettings) that can throw and escape React's
      // error boundaries; surface it in diagnostics instead of crashing.
      try {
        setEffectsSettings(next);
      } catch (error) {
        reportPluginError(maplibreEffectsPlugin.id, "preview-effects", error);
      }
    },
    // Commit: called once when an edit gesture ends (slider release, color
    // input blur, reset, or the submenu closing). Persists only when the
    // appearance actually differs from what the project already holds, so a
    // no-op gesture does not flag the project dirty.
    commitEffectsSettings: () => {
      try {
        const storedSettings =
          useAppStore.getState().projectPlugins?.settings?.[
            maplibreEffectsPlugin.id
          ];
        const currentSettings = maplibreEffectsPlugin.getProjectState?.();
        if (
          JSON.stringify(storedSettings ?? null) ===
          JSON.stringify(currentSettings ?? null)
        ) {
          return;
        }
        useAppStore.getState().setProjectPlugins(projectPluginStateSnapshot());
      } catch (error) {
        reportPluginError(maplibreEffectsPlugin.id, "commit-effects", error);
      }
    },
  };
}

// Built-in plugins are registered at module load so the toolbar can render
// plugin menu items on the first pass. This hook additionally kicks off the
// external plugin scan and reports whether it has finished.
export function useExternalPluginsReady(
  mapControllerRef: RefObject<MapController | null>,
): boolean {
  const desktopSettings = useDesktopSettingsStore(
    (state) => state.desktopSettings,
  );

  useEffect(() => {
    // mapControllerRef is a stable ref object, so it is intentionally not a
    // dependency; createAppAPI dereferences .current lazily.
    //
    // Project-supplied plugin URLs are intentionally NOT loaded here: the scan
    // only ever fetches/imports the user's installed URLs (desktop settings) and
    // the bundled drop-ins. Untrusted project URLs are surfaced by
    // useProjectPluginTrust and only reach this scan after the user trusts them
    // (which adds them to desktopSettings and re-runs this effect). See #1062.
    void ensureExternalPluginsLoadedWithSettings(
      desktopSettings,
      createAppAPI(mapControllerRef),
    );
  }, [desktopSettings]);

  return useSyncExternalStore(
    (listener) => {
      externalPluginsListeners.add(listener);
      return () => externalPluginsListeners.delete(listener);
    },
    () => externalPluginsLoaded,
    () => externalPluginsLoaded,
  );
}

export interface ProjectPluginTrustState {
  /**
   * Project-supplied plugin manifest URLs awaiting the user's trust decision.
   * Empty when the opened project references no untrusted plugins (its URLs are
   * already installed or bundled), which is the common case for a user's own
   * saved projects.
   */
  pendingUrls: string[];
  /**
   * Trust every pending URL: add it to the persisted desktop settings so it is
   * installed like any marketplace/manual plugin. This re-runs the external
   * plugin scan (via useExternalPluginsReady's settings dependency), which is
   * what actually fetches and imports the now-trusted plugins.
   */
  trust: () => void;
  /** Dismiss the prompt for this session without loading or persisting anything. */
  dismiss: () => void;
}

/**
 * Gate the plugin manifest URLs carried inside an opened project behind an
 * explicit user trust decision (#1062).
 *
 * When a project is opened, its `plugins.manifestUrls` are compared against the
 * user's installed URLs and the bundled drop-ins. Any URL that is neither is
 * "untrusted" and is surfaced here so the shell can show a trust prompt before
 * the plugin's code is ever fetched or imported. Trusting persists the URLs to
 * desktop settings (which loads them); dismissing loads nothing and persists
 * nothing. A per-session dismissed set keeps a declined URL from re-prompting
 * on every render or when another project references the same URL.
 */
export function useProjectPluginTrust(): ProjectPluginTrustState {
  const projectManifestUrls = useAppStore(
    (state) => state.projectPlugins?.manifestUrls ?? EMPTY_PLUGIN_MANIFEST_URLS,
  );
  const trustedManifestUrls = useDesktopSettingsStore(
    (state) => state.desktopSettings.pluginManifestUrls,
  );
  const [dismissedUrls, setDismissedUrls] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const pendingUrls = useMemo(() => {
    const { untrusted } = partitionProjectPluginManifestUrls(
      projectManifestUrls,
      trustedManifestUrls,
      bundledPluginManifestUrls(),
    );
    return untrusted.filter((url) => !dismissedUrls.has(url));
  }, [projectManifestUrls, trustedManifestUrls, dismissedUrls]);

  const trust = useCallback(() => {
    if (pendingUrls.length === 0) return;
    const current = useDesktopSettingsStore.getState().desktopSettings;
    useDesktopSettingsStore.getState().setDesktopSettings({
      ...current,
      pluginManifestUrls: mergeStringLists(
        current.pluginManifestUrls,
        pendingUrls,
      ),
    });
  }, [pendingUrls]);

  const dismiss = useCallback(() => {
    if (pendingUrls.length === 0) return;
    setDismissedUrls((previous) => {
      const next = new Set(previous);
      for (const url of pendingUrls) next.add(url);
      return next;
    });
  }, [pendingUrls]);

  return { pendingUrls, trust, dismiss };
}

/**
 * Enforces mutual exclusivity between Layer Swipe and split view (#844). The two
 * are competing comparison tools: overlaying the swipe slider on a multi-pane
 * grid fragments the workspace, so whenever the grid becomes multi-pane the
 * Layer Swipe control is deactivated. The reverse direction (activating swipe
 * collapses the grid to a single map) lives in `usePluginRegistry().toggle`.
 *
 * Mounted once near the app root so it covers every way into split view — the
 * View menu, loading a project, or a plugin — not just the toolbar item.
 */
export function useSwipeSplitViewExclusivity(
  mapControllerRef: RefObject<MapController | null>,
): void {
  const paneCount = useAppStore(
    (state) => state.mapLayout.rows * state.mapLayout.cols,
  );

  useEffect(() => {
    if (paneCount <= 1 || !manager.isActive(SWIPE_PLUGIN_ID)) return;
    // Deactivate via the manager and persist, mirroring usePluginRegistry's
    // toggle so the project records swipe as off and a stray throw from the
    // imperative control can't escape React.
    const before = JSON.stringify(projectPluginStateSnapshot());
    try {
      manager.toggle(SWIPE_PLUGIN_ID, createAppAPI(mapControllerRef));
    } catch (error) {
      reportPluginError(SWIPE_PLUGIN_ID, "toggle", error);
      return;
    }
    persistProjectPluginState(before);
  }, [paneCount, mapControllerRef]);
}

// Manifest URLs for plugins baked into the build under public/plugins/<id>/.
// Resolved against the app origin and base so they fetch same-origin on both
// the web build and the desktop build (which serves the same frontend from
// tauri://localhost, allowed by `connect-src 'self'`). These are injected at
// load time rather than stored in Settings, so a baked-in plugin always loads
// and cannot be removed by the user. The URL loader skips the scheme allow-list
// applied to user/project URLs, so the desktop tauri:// origin is accepted.
export function bundledPluginManifestUrls(): string[] {
  if (typeof window === "undefined") return [];
  // Resolve against a base that always ends in "/" so a non-trailing-slash
  // BASE_URL (e.g. "/geolibre") cannot mangle the path into "/geolibreplugins".
  const base = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return bundledPluginManifestPaths.map(
    (path) => new URL(path, new URL(base, window.location.href)).href,
  );
}

function ensureExternalPluginsLoadedWithSettings(
  desktopSettings: ReturnType<
    typeof useDesktopSettingsStore.getState
  >["desktopSettings"],
  app: ReturnType<typeof createAppAPI>,
  options?: { force?: boolean },
): Promise<void> {
  // Only the user's installed URLs (desktop settings) and the bundled drop-ins
  // are auto-loaded. Project-supplied URLs are deliberately excluded here so
  // opening a project never fetches or imports third-party plugin code; they
  // reach this scan only after the user trusts them, at which point they are in
  // desktopSettings.pluginManifestUrls (see useProjectPluginTrust / #1062).
  const pluginManifestUrls = mergeStringLists(
    bundledPluginManifestUrls(),
    desktopSettings.pluginManifestUrls,
  );
  const loadKey = JSON.stringify({
    additionalPluginDirectories: desktopSettings.additionalPluginDirectories,
    pluginManifestUrls,
  });
  // `force` re-scans even when the merged settings are unchanged. Installing a
  // zip writes a new archive into the app-data plugins directory without
  // touching the settings that make up loadKey, so the cache-key short-circuits
  // below would otherwise skip loading the freshly installed plugin.
  if (!options?.force && externalPluginsLoaded && externalPluginsLoadKey === loadKey) {
    return Promise.resolve();
  }
  if (
    !options?.force &&
    externalPluginsLoadPromise &&
    externalPluginsLoadKey === loadKey
  ) {
    return externalPluginsLoadPromise;
  }

  externalPluginLoadIssues = new Map();
  notifyExternalPluginsListeners();
  setExternalPluginsLoaded(false);
  externalPluginsLoadKey = loadKey;
  // Serialize scans: loadExternalPlugins reads and writes module-level state
  // (the loaded-plugin map) across awaits, so two in-flight scans could both
  // pass the dedup check and double-register the same plugin. Waiting for the
  // previous scan (which never rejects) keeps at most one scan running.
  const previousLoad = externalPluginsLoadPromise ?? Promise.resolve();
  const loadPromise = previousLoad
    .then(() => {
      // Unregister URL plugins whose manifest URL was removed from the merged
      // list (e.g. uninstalled from the marketplace) so the Plugins menu updates
      // and any active control is torn down without a reload. This runs after
      // the previous scan settles so a plugin whose load was still in flight is
      // already recorded and can be removed.
      const unloaded = unloadRemovedUrlPlugins(manager, pluginManifestUrls, app);
      if (unloaded.length) {
        console.info(
          `Unloaded external GeoLibre plugins: ${unloaded.join(", ")}`,
        );
      }
      return loadExternalPlugins(
        manager,
        desktopSettings.additionalPluginDirectories,
        pluginManifestUrls,
      );
    })
    .then((result) => {
      externalPluginLoadIssues = new Map(
        result.issues.map((issue) => [
          issue.sourceUrl ?? issue.archiveName,
          issue.message,
        ]),
      );
      notifyExternalPluginsListeners();
      if (result.loadedPluginIds.length) {
        console.info(
          `Loaded external GeoLibre plugins from ${result.pluginSources.join(
            ", ",
          )}: ${result.loadedPluginIds.join(", ")}`,
        );
      }
      for (const issue of result.issues) {
        console.warn(
          `Skipped external plugin archive '${issue.archiveName}': ${issue.message}`,
        );
      }
    })
    .catch((error) => {
      console.warn("Could not load external GeoLibre plugins.", error);
    })
    .finally(() => {
      // A settings change can start a new load while this one is in flight.
      // Only the load that still owns the current key may mark plugins ready.
      if (externalPluginsLoadKey !== loadKey) return;
      // A forced re-scan (install) chains a second load onto this one under the
      // SAME key, so guard the clear by identity: only null the slot when it
      // still points at this promise, never at the newer in-flight load.
      if (externalPluginsLoadPromise === loadPromise) {
        externalPluginsLoadPromise = null;
      }
      setExternalPluginsLoaded(true);
    });

  externalPluginsLoadPromise = loadPromise;
  return loadPromise;
}

export function createAppAPI(
  mapControllerRef?: RefObject<MapController | null>,
) {
  const store = useAppStore.getState();
  // Captured so methods that delegate to plugin helpers taking the AppAPI
  // itself (e.g. addCogLayer -> addCogRasterLayer) can pass `api`. Only read
  // when those methods are called, which is always after assignment.
  const api = {
    setBasemap: (url: string) => store.setBasemapStyleUrl(url),
    addGeoJsonLayer: (
      name: string,
      data: GeoJSON.FeatureCollection,
      sourcePath?: string,
    ) => {
      const id = store.addGeoJsonLayer(name, data, sourcePath);
      return id;
    },
    addTileLayer: (
      name: string,
      url: string,
      options?: GeoLibreTileLayerOptions,
    ) =>
      store.addTileLayer(
        name,
        { type: "xyz", tiles: [url], url, ...tileLayerStoreOptions(options) },
        options?.beforeLayerId ?? null,
      ),
    // Intentionally identical to addTileLayer except for the layer `type`.
    // XYZ and WMTS tile templates render through the same syncRasterTileLayer
    // path; the distinct type only changes how the layer is labelled/stored,
    // so the two helpers share an implementation by design (not a copy-paste).
    addWmtsLayer: (
      name: string,
      url: string,
      options?: GeoLibreTileLayerOptions,
    ) =>
      store.addTileLayer(
        name,
        { type: "wmts", tiles: [url], url, ...tileLayerStoreOptions(options) },
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
        throw new Error(
          "addWmsLayer: options.layers must be a non-empty string.",
        );
      }
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
          `[GeoLibre] addWmsLayer: unsupported WMS version "${String(version)}"; using "${resolvedVersion}".`,
        );
      }
      const tileUrl = createWmsTileUrl({
        endpoint: url,
        layers,
        styles: resolvedStyles,
        format: resolvedFormat,
        transparent: resolvedTransparent,
        tileSize,
        version: resolvedVersion,
      });
      return store.addTileLayer(
        name,
        {
          type: "wms",
          tiles: [tileUrl],
          url,
          // Persist the WMS request parameters so the layer round-trips through
          // a saved project, mirroring the Add Data dialog's WMS source.
          source: {
            layers,
            styles: resolvedStyles,
            format: resolvedFormat,
            transparent: resolvedTransparent,
            version: resolvedVersion,
          },
          ...tileOptions,
        },
        beforeLayerId ?? null,
      );
    },
    // Unlike the tile helpers above, a COG is read client-side by the maplibre
    // raster control (band/rescale/colormap/nodata), so it delegates to the
    // components plugin's addCogRasterLayer rather than building a store layer
    // here. It takes the AppAPI itself (to mount the control on demand), so we
    // hand it the captured `api`.
    addCogLayer: (
      name: string,
      url: string,
      options?: GeoLibreCogLayerOptions,
    ) =>
      addCogRasterLayer(api, {
        url,
        name,
        ...(options?.bands !== undefined ? { bands: options.bands } : {}),
        // The public option is a loose `string` (so JS plugins need not import
        // the renderer's colormap union); the renderer validates the name and
        // falls back to its default for anything it doesn't recognize.
        ...(options?.colormap !== undefined
          ? {
              colormap:
                options.colormap as Parameters<
                  typeof addCogRasterLayer
                >[1]["colormap"],
            }
          : {}),
        ...(options?.rescaleMin !== undefined
          ? { rescaleMin: options.rescaleMin }
          : {}),
        ...(options?.rescaleMax !== undefined
          ? { rescaleMax: options.rescaleMax }
          : {}),
        ...(options?.nodata !== undefined ? { nodata: options.nodata } : {}),
        ...(options?.opacity !== undefined ? { opacity: options.opacity } : {}),
        beforeLayerId: options?.beforeLayerId ?? null,
      }),
    getActiveBasemap: () => useAppStore.getState().basemapStyleUrl,
    onBasemapChange: (callback: (styleUrl: string) => void) =>
      useAppStore.subscribe((state, prev) => {
        if (state.basemapStyleUrl !== prev.basemapStyleUrl) {
          callback(state.basemapStyleUrl);
        }
      }),
    fetchArrayBuffer: fetchRemoteArrayBuffer,
    resolvePluginAssetUrl: resolvePluginAssetUrlForLoadedPlugin,
    fitBounds: (bounds: [number, number, number, number]) =>
      mapControllerRef?.current?.fitBounds(bounds),
    getMap: () => mapControllerRef?.current?.getMap() ?? null,
    pickLocalDirectoryFiles,
    // Present only on desktop (filesystem access); the Vector panel keys off its
    // presence to auto-discover shapefile sidecars instead of forcing the user
    // to select every component, and to capture the file's path for restore.
    pickVectorFilesWithSidecars: isTauriRuntime()
      ? pickVectorFilesWithSidecars
      : undefined,
    readLocalVectorFile: readVectorFileWithSidecars,
    exportTextFile: (
      filename: string,
      content: string,
      options?: GeoLibreFileDialogOptions,
    ) => {
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
    registerExternalNativeLayer: (
      registration: GeoLibreExternalNativeLayerRegistration,
    ) => {
      const state = useAppStore.getState();
      const existing = state.layers.find(
        (layer) => layer.id === registration.id,
      );
      const layer = createExternalNativeStoreLayer(registration, existing);
      if (existing) {
        state.updateLayer(layer.id, layer);
      } else {
        state.addLayer(layer);
      }
    },
    unregisterExternalNativeLayer: (id: string) => {
      const state = useAppStore.getState();
      if (state.layers.some((layer) => layer.id === id)) {
        state.removeLayer(id);
      }
    },
    addMapControl: (
      control: Parameters<MapController["addControl"]>[0],
      position?: Parameters<MapController["addControl"]>[1],
    ) => mapControllerRef?.current?.addControl(control, position) ?? false,
    removeMapControl: (
      control: Parameters<MapController["removeControl"]>[0],
    ) => mapControllerRef?.current?.removeControl(control),
    setBuiltInMapControlVisible: (
      control: Parameters<MapController["setBuiltInControlVisible"]>[0],
      visible: boolean,
    ) =>
      mapControllerRef?.current?.setBuiltInControlVisible(control, visible) ??
      false,
    getBuiltInMapControlPosition: (
      control: Parameters<MapController["getBuiltInControlPosition"]>[0],
    ) =>
      mapControllerRef?.current?.getBuiltInControlPosition(control) ??
      "top-right",
    setBuiltInMapControlPosition: (
      control: Parameters<MapController["setBuiltInControlPosition"]>[0],
      position: Parameters<MapController["setBuiltInControlPosition"]>[1],
    ) =>
      mapControllerRef?.current?.setBuiltInControlPosition(control, position) ??
      false,
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
        ]).then(
          ([core, layers, aggregationLayers, geoLayers, meshLayers, mapbox]) => ({
            core,
            layers,
            aggregationLayers,
            geoLayers,
            meshLayers,
            mapbox,
          }),
        ));
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
          `[GeoLibre] setMapProjection: ignoring unknown projection "${String(projection)}" (expected "globe" or "mercator").`,
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
    registerRightPanel,
    unregisterRightPanel,
    openRightPanel,
    collapseRightPanel,
    closeRightPanel,
    getActiveRightPanel,
    setActiveRightPanelDock,
    getActiveRightPanelDock,
    registerToolbarMenu,
    unregisterToolbarMenu,
    registerFloatingPanel,
    unregisterFloatingPanel,
    openFloatingPanel,
    closeFloatingPanel,
    getOpenFloatingPanels,
  };
  return api;
}

async function fetchRemoteArrayBuffer(url: string): Promise<ArrayBuffer> {
  if (isTauriRuntime() && isLocalFileReference(url)) {
    return normalizeBytes(await readFile(localPathFromReference(url)));
  }

  if (isTauriRuntime()) {
    try {
      const bytes = await fetchUrlBytes(url, { context: "plugin resource" });
      return normalizeBytes(bytes);
    } catch {
      // Fall back to browser fetch for web builds and during local development.
    }
  }

  if (isLocalDevHost() && shouldUseDevRasterProxy(url)) {
    return fetchDevRasterProxy(url);
  }

  try {
    return await fetchArrayBuffer(url);
  } catch (error) {
    if (!isLocalDevHost()) throw error;
    return fetchDevRasterProxy(url);
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

function fetchDevRasterProxy(url: string): Promise<ArrayBuffer> {
  return fetchArrayBuffer(
    `${RASTER_PROXY_PATH}?url=${encodeURIComponent(url)}`,
  );
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.arrayBuffer();
}

function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as TauriRuntimeWindow).__TAURI_INTERNALS__);
}

function setExternalPluginsLoaded(loaded: boolean): void {
  if (externalPluginsLoaded === loaded) return;
  externalPluginsLoaded = loaded;
  notifyExternalPluginsListeners();
}

function notifyExternalPluginsListeners(): void {
  for (const listener of externalPluginsListeners) listener();
}

function isLocalDevHost(): boolean {
  if (typeof window === "undefined") return false;
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function shouldUseDevRasterProxy(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return (
      parsedUrl.hostname === "github.com" &&
      parsedUrl.pathname.includes("/releases/download/")
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

// The manager's getProjectState always returns an empty manifestUrls list,
// so the before/after snapshots both graft on the store's real list to keep
// the no-change comparison meaningful.
function projectPluginStateSnapshot() {
  return {
    ...manager.getProjectState(),
    manifestUrls:
      useAppStore.getState().projectPlugins?.manifestUrls ??
      EMPTY_PLUGIN_MANIFEST_URLS,
  };
}

function persistProjectPluginState(previousJson: string): void {
  const nextState = projectPluginStateSnapshot();
  if (JSON.stringify(nextState) === previousJson) return;
  useAppStore.getState().setProjectPlugins(nextState);
}
