import { useAppStore } from "@geolibre/core";
import { buildProjectEgressSnapshot } from "../lib/build-project-snapshot";
import { reserveBuiltInPluginIds } from "../lib/plugin-registry";
import { ensurePluginBlocklistLoaded, hasPluginBlocklistEntries } from "../lib/plugin-blocklist";
import {
  addRasterToMap,
  readRasterWindow,
  setRasterRenderEngine,
  addZarrRasterLayer,
  buildSelectorTimeBinding,
  queryZarrLayer,
  registerTemporalLayer,
  unregisterTemporalLayer,
  isTimeSliderIdle,
  TIME_SLIDER_PLUGIN_ID,
  type TemporalLayerAdapter,
  setZarrLayerSelector,
  setZarrLocalStoreProvider,
  maplibreAnnotationsPlugin,
  maplibreDimensionsPlugin,
  maplibreBasemapControlPlugin,
  maplibreComponentsPlugin,
  maplibreDeckGlVizPlugin,
  maplibreDirectionsPlugin,
  maplibreElevationProfilePlugin,
  maplibreEffectsPlugin,
  getEffectsSettings,
  setEffectsSettings,
  type EffectsSettings,
  maplibreEarthdataGisPlugin,
  setEarthdataCogSaver,
  setSatelliteEmbeddingsFileSaver,
  setFieldsOfTheWorldFileSaver,
  setOceanDataPlatformFileSaver,
  maplibreEnviroAtlasPlugin,
  maplibreEsriWaybackPlugin,
  maplibreFemaWmsPlugin,
  maplibreGeoAgentPlugin,
  maplibreGeoEditorPlugin,
  maplibreLayerControlPlugin,
  maplibreNasaEarthdataPlugin,
  maplibreNationalMapPlugin,
  maplibreUsgsDemPlugin,
  maplibreOpenAerialMapPlugin,
  maplibreOsmDownloaderPlugin,
  maplibreIgnLidarHdPlugin,
  maplibreArcGisHubPlugin,
  maplibreTennesseeGisPlugin,
  maplibreUsFederalGisPlugin,
  maplibreUsStateGisPlugin,
  maplibreUsLocalGisPlugin,
  maplibreCkanPlugin,
  maplibreSocrataPlugin,
  maplibreStacCatalogsPlugin,
  maplibreSourceCoopPlugin,
  maplibreS3BrowserPlugin,
  maplibreNaturalEarthPlugin,
  maplibreHuggingFacePlugin,
  maplibreSatelliteEmbeddingsPlugin,
  maplibreFieldsOfTheWorldPlugin,
  maplibreOceanDataPlatformPlugin,
  maplibreGeoLensPlugin,
  setGeoLensDefaultServerUrl,
  maplibreVantorPlugin,
  maplibrePlanetOpenDataPlugin,
  maplibrePortolanPlugin,
  maplibreOvertureMapsPlugin,
  queryOvertureFeatures,
  maplibreGraticulePlugin,
  maplibreH3Plugin,
  maplibreS2Plugin,
  maplibreA5Plugin,
  maplibreDggridPlugin,
  maplibreDggalPlugin,
  maplibreOlcPlugin,
  maplibreGeohashPlugin,
  maplibreTilecodePlugin,
  maplibreCloudsPlugin,
  maplibrePrecipitationPlugin,
  maplibreMapillaryPlugin,
  maplibreReverseGeocodePlugin,
  maplibreStreetViewPlugin,
  maplibreSamGeoPlugin,
  maplibreSunPlugin,
  maplibreRouteAnimationPlugin,
  flightSimulatorPlugin,
  godsEyeViewPlugin,
  maplibreSwipePlugin,
  SWIPE_PLUGIN_ID,
  DIRECTIONS_PLUGIN_ID,
  REVERSE_GEOCODE_PLUGIN_ID,
  maplibreTimelapsePlugin,
  maplibreTimeSliderPlugin,
  setTimelapseVideoSaver,
  setPointCloudAnnotationFileSaver,
  setPointCloudPrelabelRunner,
  setPointCloudLabelWriter,
  maplibreUsgsLidarPlugin,
  pointCloudAnnotationPlugin,
  maplibreUsgsNldiPlugin,
  PluginManager,
  registerRightPanel,
  unregisterRightPanel,
  openRightPanel,
  collapseRightPanel,
  closeRightPanel,
  getActiveRightPanel,
  setActiveRightPanelDock,
  getActiveRightPanelDock,
  registerAssistantTool,
  registerAssistantToolSpec,
  registerAssistantGuidance,
  registerToolbarMenu,
  unregisterToolbarMenu,
  registerMenuContribution,
  unregisterMenuContribution,
  registerFloatingPanel,
  unregisterFloatingPanel,
  openFloatingPanel,
  closeFloatingPanel,
  getOpenFloatingPanels,
} from "@geolibre/plugins";
import { getDeploymentPolicy, readDeploymentEnvValue } from "../lib/deployment-env";
import type { DeploymentPolicy } from "../lib/deployment-policy";
import { evaluatePlugin, type PluginPolicyDenial } from "../lib/plugin-policy";
import { fetchPluginRegistryShared } from "../lib/plugin-registry";
import { bundleFromZipBytes } from "../lib/plugin-archive-unpack";
import { CesiumEngine, getPrimaryCesiumControlHost, type MapEngine } from "@geolibre/map";
import type { GeoLibrePlugin, GeoLibreMapControlPosition } from "@geolibre/plugins";
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { bundledPluginManifestPaths } from "virtual:bundled-plugins";
import {
  assertBundleNotBlocklisted,
  installWebPluginArchive,
  listInstalledWebPlugins,
  loadExternalPlugins,
  reloadExternalUrlPlugin,
  uninstallWebPlugin,
  unloadFilesystemPlugin,
  unloadRemovedUrlPlugins,
  type HeldBackPluginBundle,
  type InstalledWebPlugin,
  PluginPolicyError,
} from "../lib/external-plugins";
import { appendDiagnostic } from "../lib/diagnostics";
import { pickZarrDirectory, zarrDirectoryPickerSupported } from "../lib/zarr-directory-picker";
import { partitionProjectPluginManifestUrls } from "../lib/plugin-trust";
import i18n from "../i18n";
import { pluginCredentialHost } from "../lib/plugin-credentials";
import { setTimeSliderOpenedByBinding, shouldCloseTimeSliderDock } from "../lib/time-slider-dock";
import { mergeStringLists } from "../lib/string-lists";
import { saveBinaryFileWithFallback } from "../lib/tauri-io";
import { createAppAPI as buildAppAPI, isTauriRuntime, type AppApiHost } from "../lib/app-api";
import { useDesktopSettingsStore } from "./useDesktopSettings";

/** Records a plugin failure in the diagnostics panel without crashing the app. */
function reportPluginError(pluginId: string, action: string, error: unknown): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  appendDiagnostic({
    category: "runtime",
    level: "error",
    message: `Plugin "${pluginId}" failed to ${action}: ${normalized.message}`,
    detail: normalized.stack,
    source: `plugin:${pluginId}`,
  });
}

const manager = new PluginManager();

/**
 * Seeds the GeoLens plugin's default server URL from the deployment settings.
 * Called once at startup after deployment.json has been applied, not at import
 * time, because the policy is fetched while this module loads.
 */
export function initGeoLensDefaultUrl(): void {
  setGeoLensDefaultServerUrl(readDeploymentEnvValue("VITE_GEOLENS_DEFAULT_URL"));
}

const BUILT_IN_PLUGINS: GeoLibrePlugin[] = [
  maplibreLayerControlPlugin,
  maplibreGeoEditorPlugin,
  maplibreAnnotationsPlugin,
  maplibreDimensionsPlugin,
  // The web service plugins (WEB_SERVICE_PLUGIN_IDS) are grouped into the
  // "Web Services" submenu, rendered where the first of them appears in this
  // order.
  maplibreFemaWmsPlugin,
  maplibreNasaEarthdataPlugin,
  maplibreEnviroAtlasPlugin,
  maplibreNationalMapPlugin,
  maplibreUsgsNldiPlugin,
  maplibreUsgsDemPlugin,
  maplibreUsgsLidarPlugin,
  maplibreVantorPlugin,
  maplibrePlanetOpenDataPlugin,
  maplibrePortolanPlugin,
  maplibreEarthdataGisPlugin,
  maplibreOpenAerialMapPlugin,
  maplibreOsmDownloaderPlugin,
  maplibreIgnLidarHdPlugin,
  maplibreArcGisHubPlugin,
  maplibreTennesseeGisPlugin,
  maplibreUsFederalGisPlugin,
  maplibreUsStateGisPlugin,
  maplibreUsLocalGisPlugin,
  maplibreSocrataPlugin,
  maplibreCkanPlugin,
  maplibreStacCatalogsPlugin,
  maplibreSourceCoopPlugin,
  maplibreS3BrowserPlugin,
  maplibreNaturalEarthPlugin,
  maplibreHuggingFacePlugin,
  maplibreSatelliteEmbeddingsPlugin,
  maplibreFieldsOfTheWorldPlugin,
  maplibreOceanDataPlatformPlugin,
  maplibreGeoLensPlugin,
  maplibreStreetViewPlugin,
  maplibreMapillaryPlugin,
  // The DGGS grid plugins (grouped into the Plugins menu's "DGGS" submenu,
  // rendered where the first of them appears in this order).
  maplibreH3Plugin,
  maplibreS2Plugin,
  maplibreA5Plugin,
  maplibreDggridPlugin,
  maplibreDggalPlugin,
  maplibreOlcPlugin,
  maplibreGeohashPlugin,
  maplibreTilecodePlugin,
  maplibreBasemapControlPlugin,
  maplibreEsriWaybackPlugin,
  maplibreTimeSliderPlugin,
  maplibreTimelapsePlugin,
  maplibreOvertureMapsPlugin,
  maplibreGeoAgentPlugin,
  maplibreElevationProfilePlugin,
  maplibreSwipePlugin,
  maplibreGraticulePlugin,
  maplibreCloudsPlugin,
  maplibrePrecipitationPlugin,
  maplibreEffectsPlugin,
  maplibreSunPlugin,
  maplibreRouteAnimationPlugin,
  flightSimulatorPlugin,
  godsEyeViewPlugin,
  maplibreSamGeoPlugin,
  pointCloudAnnotationPlugin,
  // Last visible entry of the Plugins menu is above; the ids below are
  // skipped by PluginsMenu and surface elsewhere.
  maplibreDirectionsPlugin,
  maplibreReverseGeocodePlugin,
  maplibreDeckGlVizPlugin,
  maplibreComponentsPlugin,
];
manager.registerAll(BUILT_IN_PLUGINS);
reserveBuiltInPluginIds(BUILT_IN_PLUGINS.map((plugin) => plugin.id));

/**
 * Built-in plugins a `?plugin=` deep link may not activate: they send what the
 * user clicks to a public third-party server, so they stay behind the one-time
 * consent notice the toolbar shows (see `useConsentGatedActions`).
 */
const CONSENT_GATED_PLUGIN_IDS: ReadonlySet<string> = new Set([
  DIRECTIONS_PLUGIN_ID,
  REVERSE_GEOCODE_PLUGIN_ID,
]);

/** Ids of the built-in plugins a `?plugin=` deep link may activate. */
export const DEEP_LINKABLE_PLUGIN_IDS: readonly string[] = BUILT_IN_PLUGINS.map(
  (plugin) => plugin.id,
).filter((id) => !CONSENT_GATED_PLUGIN_IDS.has(id));

// The Timelapse plugin records the map to a video blob but cannot depend on
// the app's Tauri I/O helpers, so the save step (native dialog under Tauri,
// download in the browser) is injected here once at startup.
setTimelapseVideoSaver((blob, { defaultName, extension, mimeType }) =>
  saveBinaryFileWithFallback(blob, {
    defaultName,
    filters: [{ name: "Video", extensions: [extension] }],
    browserTypes: [
      {
        description: "Video",
        accept: { [mimeType.split(";")[0]]: [`.${extension}`] },
      },
    ],
    mimeType,
  }),
);

// The point cloud annotator exports LAS files but cannot depend on the app's
// Tauri I/O helpers, so the binary save is injected here like the timelapse's.
setPointCloudAnnotationFileSaver((bytes, { defaultName, extension, mimeType, description }) =>
  saveBinaryFileWithFallback(bytes, {
    defaultName,
    filters: [{ name: description, extensions: [extension] }],
    browserTypes: [{ description, accept: { [mimeType]: [`.${extension}`] } }],
    mimeType,
  }),
);

// The point cloud annotator pre-labels with Whitebox LiDAR classifiers run by
// the in-browser WASM runner, which lives in the processing package the
// plugins package cannot import; loaded on first use to stay off startup.
setPointCloudPrelabelRunner(async (toolId, parameters, las) => {
  const { runWhiteboxToolWasm } = await import("@geolibre/processing");
  const job = await runWhiteboxToolWasm({
    tool_id: toolId,
    parameters,
    layer_inputs: { input: { name: "input.las", kind: "lidar_in", bytes: las } },
    tool: {
      id: toolId,
      params: [
        { name: "input", kind: "lidar_in", required: true },
        { name: "output", kind: "lidar_out", required: true },
        ...Object.keys(parameters).map((name) => ({ name, kind: "string" })),
      ],
    },
  });
  const output = job.outputs.output;
  if (job.status !== "succeeded" || !(output instanceof Uint8Array)) {
    throw new Error(job.error || job.messages.slice(-1)[0] || `${toolId} failed`);
  }
  return output;
});

// The point cloud annotator writes a whole local file with its saved labels
// through the sidecar's /pointcloud job; the client lives in the processing
// package, loaded on first use.
setPointCloudLabelWriter({
  available: async () => {
    const { fetchPointCloudStatus } = await import("@geolibre/processing");
    try {
      return (await fetchPointCloudStatus()).available;
    } catch {
      return false;
    }
  },
  write: async ({ inputPath, outputPath, labels, instances }) => {
    const { fetchConversionJob, runPointCloudApplyLabels } = await import("@geolibre/processing");
    let job = await runPointCloudApplyLabels({
      input_path: inputPath,
      output_path: outputPath,
      labels,
      instances,
    });
    // A long rewrite outlives a brief sidecar hiccup: retry a failed poll a
    // few times before giving up (the job keeps running on the server).
    let failures = 0;
    while (job.status === "pending" || job.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        job = await fetchConversionJob(job.id);
        failures = 0;
      } catch (error) {
        if (++failures >= 5) throw error;
      }
    }
    if (job.status !== "succeeded") {
      throw new Error(job.error || job.messages.slice(-1)[0] || "The point cloud job failed");
    }
    const result = (job.result ?? {}) as {
      points?: number;
      relabelled?: number;
      instanced?: number;
    };
    return {
      points: result.points ?? 0,
      relabelled: result.relabelled ?? 0,
      instanced: result.instanced ?? 0,
    };
  },
});

// The Earthdata GIS plugin exports an ArcGIS service as a plain GeoTIFF but
// cannot re-encode it: ArcGIS has no COG output (`format=cog` falls back to
// PNG, and `format=tiff` returns a tiled file with no overviews), and the
// plugins package owns neither the COG encoder nor the app's file dialogs. Both
// are injected here once at startup, mirroring setTimelapseVideoSaver.
setEarthdataCogSaver(async (geoTiffBytes, defaultName) => {
  // Imported on demand so the COG encoder's WASM is only fetched when a user
  // actually downloads one.
  const { convertGeoTiffToCog } = await import("@geolibre/processing");
  const cogBytes = await convertGeoTiffToCog(geoTiffBytes);
  const saved = await saveBinaryFileWithFallback(cogBytes, {
    defaultName,
    filters: [{ name: "Cloud Optimized GeoTIFF", extensions: ["tif"] }],
    browserTypes: [
      {
        description: "Cloud Optimized GeoTIFF",
        accept: { "image/tiff": [".tif"] },
      },
    ],
    mimeType: "image/tiff",
  });
  return saved !== null;
});

// The Satellite Embeddings plugin builds clipped GeoTIFFs in memory; saving
// them needs the app's file dialogs, injected the same way.
setSatelliteEmbeddingsFileSaver((blob, { defaultName, extension, mimeType, description }) =>
  saveBinaryFileWithFallback(blob, {
    defaultName,
    filters: [{ name: description, extensions: [extension] }],
    browserTypes: [{ description, accept: { [mimeType]: [`.${extension}`] } }],
    mimeType,
  }),
);

// The Fields of the World plugin saves tile GeoParquet and GeoJSON files the
// same way.
setFieldsOfTheWorldFileSaver((blob, { defaultName, extension, mimeType, description }) =>
  saveBinaryFileWithFallback(blob, {
    defaultName,
    filters: [{ name: description, extensions: [extension] }],
    browserTypes: [{ description, accept: { [mimeType]: [`.${extension}`] } }],
    mimeType,
  }),
);

// The Ocean Data Platform plugin saves GeoJSON files the same way.
setOceanDataPlatformFileSaver((blob, { defaultName, extension, mimeType, description }) =>
  saveBinaryFileWithFallback(blob, {
    defaultName,
    filters: [{ name: description, extensions: [extension] }],
    browserTypes: [{ description, accept: { [mimeType]: [`.${extension}`] } }],
    mimeType,
  }),
);

// The Zarr panel can open a store from a folder on disk, but reading a folder
// needs a filesystem API the plugins package does not have, so the picker is
// injected here the same way. Registered only where a folder dialog exists (the
// desktop app, or a browser with the File System Access API); elsewhere the
// panel shows no Browse folder button rather than one that cannot deliver.
if (zarrDirectoryPickerSupported()) {
  setZarrLocalStoreProvider(pickZarrDirectory);
}

// Forget that a binding opened the Time Slider dock as soon as the plugin goes
// inactive by any route (#1512), so a later manual activation is not mistaken
// for a binding-opened one and closed out from under the user.
let timeSliderWasActive = false;
manager.subscribe(() => {
  const active = manager.isActive(TIME_SLIDER_PLUGIN_ID);
  if (active === timeSliderWasActive) return;
  timeSliderWasActive = active;
  if (!active) setTimeSliderOpenedByBinding(false);
});

let externalPluginsLoaded = false;
let externalPluginsLoadPromise: Promise<void> | null = null;
let externalPluginsLoadKey: string | null = null;
type ExternalPluginLoadIssueDisplay = {
  message: string;
  policyDenial?: PluginPolicyDenial;
};
let externalPluginLoadIssues = new Map<string, ExternalPluginLoadIssueDisplay>();
let externalPluginHeldBack = new Map<string, HeldBackPluginBundle>();
const externalPluginsListeners = new Set<() => void>();
const EMPTY_PLUGIN_MANIFEST_URLS: string[] = [];

export function getPluginManager(): PluginManager {
  return manager;
}

export function getExternalPluginLoadIssues(): ReadonlyMap<string, ExternalPluginLoadIssueDisplay> {
  return externalPluginLoadIssues;
}

/** Bundles the SHA-256 pin held back, by manifest URL (see HeldBackPluginBundle). */
export function getExternalPluginHeldBack(): ReadonlyMap<string, HeldBackPluginBundle> {
  return externalPluginHeldBack;
}

export function subscribeToExternalPluginLoads(listener: () => void): () => void {
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
  mapControllerRef: RefObject<MapEngine | null>,
  expectedVersion?: string,
  expectedHash?: string,
): Promise<void> {
  // Never check an update against a blocklist that is still loading.
  await ensurePluginBlocklistLoaded();
  const policy = getDeploymentPolicy();
  const bundledManifestUrls = bundledPluginManifestUrls();
  const registryManifestUrls = await registryManifestUrlsForPolicy(
    policy,
    [manifestUrl],
    bundledManifestUrls,
  );
  const source = bundledManifestUrls.includes(manifestUrl)
    ? "bundled"
    : registryManifestUrls.includes(manifestUrl)
      ? "registry"
      : "manifest-url";
  await reloadExternalUrlPlugin(manager, manifestUrl, createAppAPI(mapControllerRef), {
    policy,
    source,
    expectedVersion,
    expectedHash,
  });
  // A held-back bundle that just loaded is no longer a failure.
  if (externalPluginHeldBack.has(manifestUrl) || externalPluginLoadIssues.has(manifestUrl)) {
    externalPluginHeldBack = new Map(externalPluginHeldBack);
    externalPluginHeldBack.delete(manifestUrl);
    externalPluginLoadIssues = new Map(externalPluginLoadIssues);
    externalPluginLoadIssues.delete(manifestUrl);
    notifyExternalPluginsListeners();
  }
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
  mapControllerRef: RefObject<MapEngine | null>,
): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error("Installing plugin archives requires the desktop app.");
  }
  await ensurePluginBlocklistLoaded();
  const policy = getDeploymentPolicy();
  // Reject sideloading before even reading the selected archive, and reject its
  // manifest id before the install IPC can persist it in the app-data directory.
  const sideloadDecision = evaluatePlugin("", "zip", policy);
  if (policy?.plugins?.sideload === false && !sideloadDecision.allowed) {
    throw new PluginPolicyError(sourcePath, sideloadDecision);
  }
  if (
    policy?.plugins?.allowed !== undefined ||
    policy?.plugins?.blocked?.length ||
    hasPluginBlocklistEntries()
  ) {
    const bundle = await bundleFromZipBytes(sourcePath, await readFile(sourcePath));
    const decision = evaluatePlugin(bundle.manifest.id, "zip", policy);
    if (!decision.allowed) {
      throw new PluginPolicyError(sourcePath, decision);
    }
    // Refuse a blocklisted release before the install persists it.
    await assertBundleNotBlocklisted(bundle);
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
  mapControllerRef: RefObject<MapEngine | null>,
): Promise<string> {
  const app = createAppAPI(mapControllerRef);
  const policy = getDeploymentPolicy();
  const pluginId = await installWebPluginArchive(manager, fileName, bytes, app, policy);
  if (policy?.plugins?.defaultActive?.includes(pluginId)) {
    // Re-enter the normal ready/restore cycle, just like a desktop archive
    // install, so defaults apply only when there is no saved project state.
    await ensureExternalPluginsLoadedWithSettings(
      useDesktopSettingsStore.getState().desktopSettings,
      app,
      { force: true },
    );
  }
  return pluginId;
}

// Uninstall a plugin that was installed from a file in the browser.
export async function uninstallPluginArchiveFromFile(
  pluginId: string,
  mapControllerRef: RefObject<MapEngine | null>,
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
      const collapseGridForSwipe = id === SWIPE_PLUGIN_ID && !manager.isActive(id);
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
          useAppStore.getState().projectPlugins?.settings?.[maplibreEffectsPlugin.id];
        const currentSettings = maplibreEffectsPlugin.getProjectState?.();
        if (JSON.stringify(storedSettings ?? null) === JSON.stringify(currentSettings ?? null)) {
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
export function useExternalPluginsReady(mapControllerRef: RefObject<MapEngine | null>): boolean {
  const desktopSettings = useDesktopSettingsStore((state) => state.desktopSettings);

  useEffect(() => {
    // mapControllerRef is a stable ref object, so it is intentionally not a
    // dependency; createAppAPI dereferences .current lazily.
    //
    // Project-supplied plugin URLs are intentionally NOT loaded here: the scan
    // only ever fetches/imports the user's installed URLs (desktop settings) and
    // the bundled drop-ins. Untrusted project URLs are surfaced by
    // useProjectPluginTrust and only reach this scan after the user trusts them
    // (which adds them to desktopSettings and re-runs this effect). See #1062.
    void ensureExternalPluginsLoadedWithSettings(desktopSettings, createAppAPI(mapControllerRef));
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
  const [dismissedUrls, setDismissedUrls] = useState<ReadonlySet<string>>(() => new Set());
  const policy = getDeploymentPolicy();

  const pendingUrls = useMemo(() => {
    const { untrusted } = partitionProjectPluginManifestUrls(
      projectManifestUrls,
      trustedManifestUrls,
      bundledPluginManifestUrls(),
      policy,
    );
    return untrusted.filter((url) => !dismissedUrls.has(url));
  }, [projectManifestUrls, trustedManifestUrls, dismissedUrls, policy]);

  const trust = useCallback(() => {
    if (getDeploymentPolicy()?.plugins?.sideload === false || pendingUrls.length === 0) return;
    const current = useDesktopSettingsStore.getState().desktopSettings;
    useDesktopSettingsStore.getState().setDesktopSettings({
      ...current,
      pluginManifestUrls: mergeStringLists(current.pluginManifestUrls, pendingUrls),
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
export function useSwipeSplitViewExclusivity(mapControllerRef: RefObject<MapEngine | null>): void {
  const paneCount = useAppStore((state) => state.mapLayout.rows * state.mapLayout.cols);

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

/**
 * Installed URL settings do not retain their marketplace origin. Under a
 * no-sideload policy, reclassify them against the current registry rather than
 * treating a past user trust decision as deployment approval. Bundled URLs
 * need no registry lookup; a failed lookup leaves all other URLs unapproved.
 */
async function registryManifestUrlsForPolicy(
  policy: DeploymentPolicy | null,
  manifestUrls: readonly string[],
  bundledManifestUrls: readonly string[],
): Promise<string[]> {
  if (
    policy?.plugins?.sideload !== false ||
    !manifestUrls.some((url) => !bundledManifestUrls.includes(url))
  ) {
    return [];
  }
  try {
    const registry = await fetchPluginRegistryShared();
    return registry.entries
      .filter((entry) => evaluatePlugin(entry.id, "registry", policy).allowed)
      .map((entry) => entry.manifestUrl);
  } catch (error) {
    console.warn("Could not classify installed plugins against the deployment registry.", error);
    return [];
  }
}

async function ensureExternalPluginsLoadedWithSettings(
  desktopSettings: ReturnType<typeof useDesktopSettingsStore.getState>["desktopSettings"],
  app: ReturnType<typeof createAppAPI>,
  options?: { force?: boolean },
): Promise<void> {
  // Only the user's installed URLs (desktop settings) and the bundled drop-ins
  // are auto-loaded. Project-supplied URLs are deliberately excluded here so
  // opening a project never fetches or imports third-party plugin code; they
  // reach this scan only after the user trusts them, at which point they are in
  // desktopSettings.pluginManifestUrls (see useProjectPluginTrust / #1062).
  // The registry's blocklist must be in place before any plugin code loads.
  await ensurePluginBlocklistLoaded();
  const bundledManifestUrls = bundledPluginManifestUrls();
  const policy = getDeploymentPolicy();
  const additionalPluginDirectories =
    policy?.plugins?.sideload === false ? [] : desktopSettings.additionalPluginDirectories;
  const pluginManifestUrls = mergeStringLists(
    bundledManifestUrls,
    desktopSettings.pluginManifestUrls,
  );
  const registryManifestUrls = await registryManifestUrlsForPolicy(
    policy,
    desktopSettings.pluginManifestUrls,
    bundledManifestUrls,
  );
  const eligibleManifestUrls =
    policy?.plugins?.sideload === false
      ? pluginManifestUrls.filter(
          (url) => bundledManifestUrls.includes(url) || registryManifestUrls.includes(url),
        )
      : pluginManifestUrls;
  const loadKey = JSON.stringify({
    additionalPluginDirectories,
    configuredPluginDirectories: desktopSettings.additionalPluginDirectories,
    pluginManifestUrls,
    eligibleManifestUrls,
    policy: policy?.plugins,
  });
  // `force` re-scans even when the merged settings are unchanged. Installing a
  // zip writes a new archive into the app-data plugins directory without
  // touching the settings that make up loadKey, so the cache-key short-circuits
  // below would otherwise skip loading the freshly installed plugin.
  if (!options?.force && externalPluginsLoaded && externalPluginsLoadKey === loadKey) {
    return Promise.resolve();
  }
  if (!options?.force && externalPluginsLoadPromise && externalPluginsLoadKey === loadKey) {
    return externalPluginsLoadPromise;
  }

  externalPluginLoadIssues = new Map();
  externalPluginHeldBack = new Map();
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
      // Remove uninstalled or no-longer-registry-approved URLs after the
      // previous scan settles, including forced scans. Keep installed URLs'
      // integrity pins so temporary denial cannot silently trust changed code.
      const unloaded = unloadRemovedUrlPlugins(
        manager,
        eligibleManifestUrls,
        app,
        pluginManifestUrls,
      );
      if (unloaded.length) {
        console.info(`Unloaded external GeoLibre plugins: ${unloaded.join(", ")}`);
      }
      return loadExternalPlugins(
        manager,
        additionalPluginDirectories,
        pluginManifestUrls,
        // Only manifests fetched from the bundled drop-in URLs may use
        // activeByDefault (they are baked into the build, hence trusted).
        {
          bundledManifestUrls,
          policy,
          registryManifestUrls,
          configuredPluginDirectories: desktopSettings.additionalPluginDirectories,
        },
      );
    })
    .then((result) => {
      externalPluginLoadIssues = new Map(
        result.issues.map((issue) => [
          issue.sourceUrl ?? issue.archiveName,
          {
            message: issue.message,
            ...(issue.policyDenial ? { policyDenial: issue.policyDenial } : {}),
          },
        ]),
      );
      externalPluginHeldBack = new Map(
        result.issues.flatMap((issue) =>
          issue.heldBack && issue.sourceUrl ? [[issue.sourceUrl, issue.heldBack] as const] : [],
        ),
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
        console.warn(`Skipped external plugin archive '${issue.archiveName}': ${issue.message}`);
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
/**
 * Bind a layer's internal time dimension to the Time Slider: persist the
 * binding on the layer's metadata (mirroring how a vector layer's `TimeBinding`
 * is stored, so it survives a project round-trip) and open the dock if it is not
 * already showing.
 *
 * Shared by the Layers panel's "Bind to Time Slider" action and the plugin API's
 * `registerTemporalLayer(..., { bind: true })`, so both write the same thing.
 *
 * @param layerId - The store layer to bind.
 * @param adapter - Its temporal adapter, whose time values set the timeline range.
 * @param mapControllerRef - Used to build the app API when activating the dock.
 * @returns True when the layer was bound; false when its time axis holds no
 *   usable timestamp, or the layer is gone.
 */
export function bindTemporalLayer(
  layerId: string,
  adapter: TemporalLayerAdapter,
  mapControllerRef?: RefObject<MapEngine | null>,
): boolean {
  const binding = buildSelectorTimeBinding(adapter.dimension ?? "time", adapter.getTimeValues(), {
    granularity: adapter.granularity,
    displayUnits: adapter.displayUnits,
  });
  if (!binding) return false;
  const store = useAppStore.getState();
  const layer = store.layers.find((item) => item.id === layerId);
  if (!layer) return false;
  store.updateLayer(layerId, {
    metadata: { ...layer.metadata, timeBinding: binding },
    // A selector binding replaces whatever was on the layer before. Drop any
    // transient filter a previous vector binding left behind, or it would keep
    // hiding features alongside the adapter (matching what the vector bind
    // dialog does when it commits).
    timeFilter: undefined,
  });
  activateTimeSliderForBinding(mapControllerRef);
  return true;
}

/**
 * Open the Time Slider dock because a layer was just bound to it, and remember
 * that the binding is what opened it so {@link useTimeSliderAutoClose} may close
 * it again when the last binding goes away (#1512).
 *
 * A no-op when the dock is already showing — including when the user opened it
 * themselves, which deliberately leaves the "opened by a binding" flag false so
 * their dock is never taken away underneath them.
 *
 * Call this **after** the binding has been written to the layer's metadata, so
 * the dock adopts it on activation.
 *
 * @param mapControllerRef - Used to build the app API for activation.
 */
export function activateTimeSliderForBinding(mapControllerRef?: RefObject<MapEngine | null>): void {
  if (manager.isActive(TIME_SLIDER_PLUGIN_ID)) return;
  const before = JSON.stringify(projectPluginStateSnapshot());
  try {
    manager.activate(TIME_SLIDER_PLUGIN_ID, createAppAPI(mapControllerRef));
  } catch (error) {
    // Plugin controls are imperative MapLibre code, so a throw here would escape
    // React's error boundaries. Contain it, exactly as usePluginRegistry.toggle
    // does, and leave the project state unwritten.
    reportPluginError(TIME_SLIDER_PLUGIN_ID, "toggle", error);
    return;
  }
  setTimeSliderOpenedByBinding(manager.isActive(TIME_SLIDER_PLUGIN_ID));
  persistProjectPluginState(before);
}

/**
 * Close a binding-opened Time Slider once it has nothing left to drive (#1512).
 *
 * `activatePlugin` / `registerTemporalLayer({ bind: true })` open the dock when
 * the first temporal layer appears, but nothing closed it again when the last
 * one went away by a route other than the Layers panel's explicit "Unbind"
 * action — removing the bound layer, or a plugin swapping a temporal dataset for
 * a single-period one. The dock then lingered over the map, implying a timeline
 * no layer has.
 *
 * Only a dock opened *by* a binding is closed; one the user opened from the
 * Plugins menu stays put. `isTimeSliderIdle` additionally keeps it open while
 * the dock's own raster sources or a KML `<TimeSpan>` overlay remain, since the
 * dock is the only way to reach those.
 *
 * Mounted once near the app root so it covers every way a binding can
 * disappear, not just the Layers panel.
 */
export function useTimeSliderAutoClose(mapControllerRef: RefObject<MapEngine | null>): void {
  useEffect(() => {
    // Subscribed rather than selected from the store so no component re-renders
    // on every layer edit just to run this check.
    const check = () => {
      if (!shouldCloseTimeSliderDock(manager.isActive(TIME_SLIDER_PLUGIN_ID), isTimeSliderIdle)) {
        return;
      }
      const before = JSON.stringify(projectPluginStateSnapshot());
      try {
        // Deactivating prunes the dock's own store layers, which re-enters this
        // subscription; those passes find the dock already idle-and-closing and
        // the plugin's own deactivate is a no-op once its control is gone.
        manager.deactivate(TIME_SLIDER_PLUGIN_ID, createAppAPI(mapControllerRef));
      } catch (error) {
        reportPluginError(TIME_SLIDER_PLUGIN_ID, "toggle", error);
        return;
      }
      persistProjectPluginState(before);
    };
    check();
    return useAppStore.subscribe(check);
  }, [mapControllerRef]);
}

/**
 * The real {@link AppApiHost}: the shared plugin manager, the
 * `@geolibre/plugins` UI registries and raster/Zarr services, and the Cesium
 * engine hooks.
 */
const appApiHost: AppApiHost = {
  plugins: manager,
  projectPluginStateSnapshot,
  persistProjectPluginState,
  reportPluginError,
  bindTemporalLayer,
  buildProjectSnapshot: buildProjectEgressSnapshot,
  credentials: pluginCredentialHost,
  i18n,
  getCesiumScene: (engine) => (engine instanceof CesiumEngine ? engine.getCesiumScene() : null),
  getPrimaryCesiumControlHost,
  addRasterToMap,
  readRasterWindow,
  setRasterRenderEngine,
  addZarrRasterLayer,
  queryZarrLayer,
  setZarrLayerSelector,
  registerTemporalLayer,
  unregisterTemporalLayer,
  queryOvertureFeatures,
  registerRightPanel,
  unregisterRightPanel,
  openRightPanel,
  collapseRightPanel,
  closeRightPanel,
  getActiveRightPanel,
  setActiveRightPanelDock,
  getActiveRightPanelDock,
  registerAssistantTool,
  registerAssistantToolSpec,
  registerAssistantGuidance,
  registerToolbarMenu,
  unregisterToolbarMenu,
  registerMenuContribution,
  unregisterMenuContribution,
  registerFloatingPanel,
  unregisterFloatingPanel,
  openFloatingPanel,
  closeFloatingPanel,
  getOpenFloatingPanels,
};

/**
 * Builds the plugin API ({@link GeoLibreAppAPI}) against the app's real host
 * services. The implementation lives in `lib/app-api.ts`.
 *
 * @param mapControllerRef - The primary map engine, if any.
 * @returns The host's plugin API object.
 */
export function createAppAPI(
  mapControllerRef?: RefObject<MapEngine | null>,
): ReturnType<typeof buildAppAPI> {
  return buildAppAPI(mapControllerRef, appApiHost);
}

function setExternalPluginsLoaded(loaded: boolean): void {
  if (externalPluginsLoaded === loaded) return;
  externalPluginsLoaded = loaded;
  notifyExternalPluginsListeners();
}

function notifyExternalPluginsListeners(): void {
  for (const listener of externalPluginsListeners) listener();
}
// The manager's getProjectState always returns an empty manifestUrls list,
// so the before/after snapshots both graft on the store's real list to keep
// the no-change comparison meaningful.
function projectPluginStateSnapshot() {
  return {
    ...manager.getProjectState(),
    manifestUrls: useAppStore.getState().projectPlugins?.manifestUrls ?? EMPTY_PLUGIN_MANIFEST_URLS,
  };
}

/**
 * Activates a plugin named by a `?plugin=` deep link and records it in the
 * project's plugin state, so a later map re-init (a basemap or renderer swap)
 * restores it instead of closing it. The write does not mark the project dirty:
 * opening a link is not an edit.
 *
 * @param pluginId - The id of a registered plugin.
 * @param mapControllerRef - The primary map engine.
 * @returns Whether the plugin is active afterwards.
 */
export async function activateDeepLinkedPlugin(
  pluginId: string,
  mapControllerRef: RefObject<MapEngine | null>,
): Promise<boolean> {
  const activated = await manager.activate(pluginId, createAppAPI(mapControllerRef));
  if (!activated || !manager.isActive(pluginId)) return false;
  const nextState = projectPluginStateSnapshot();
  if (JSON.stringify(nextState) !== JSON.stringify(useAppStore.getState().projectPlugins)) {
    useAppStore.getState().setProjectPlugins(nextState, false);
  }
  return true;
}

function persistProjectPluginState(previousJson: string): void {
  const nextState = projectPluginStateSnapshot();
  if (JSON.stringify(nextState) === previousJson) return;
  useAppStore.getState().setProjectPlugins(nextState);
}
