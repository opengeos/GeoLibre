import { useAppStore } from "@geolibre/core";
import {
  maplibreBasemapControlPlugin,
  maplibreComponentsPlugin,
  maplibreEsriWaybackPlugin,
  maplibreGeoAgentPlugin,
  maplibreGeoEditorPlugin,
  maplibreLayerControlPlugin,
  maplibreLidarPlugin,
  maplibreStreetViewPlugin,
  maplibreSwipePlugin,
  PluginManager,
} from "@geolibre/plugins";
import type { MapController } from "@geolibre/map";
import type { GeoLibreMapControlPosition } from "@geolibre/plugins";
import type { RefObject } from "react";
import { useEffect, useSyncExternalStore } from "react";
import { loadExternalPlugins } from "../lib/external-plugins";
import { mergeStringLists } from "../lib/string-lists";
import { useDesktopSettingsStore } from "./useDesktopSettings";

const RASTER_PROXY_PATH = "/__geolibre_raster_proxy";

interface TauriRuntimeWindow extends Window {
  __TAURI_INTERNALS__?: unknown;
}

const manager = new PluginManager();
manager.registerAll([
  maplibreLayerControlPlugin,
  maplibreBasemapControlPlugin,
  maplibreEsriWaybackPlugin,
  maplibreGeoAgentPlugin,
  maplibreGeoEditorPlugin,
  maplibreLidarPlugin,
  maplibreStreetViewPlugin,
  maplibreSwipePlugin,
  maplibreComponentsPlugin,
]);

let externalPluginsLoaded = false;
let externalPluginsLoadPromise: Promise<void> | null = null;
let externalPluginsLoadKey: string | null = null;
const externalPluginsListeners = new Set<() => void>();
const EMPTY_PLUGIN_MANIFEST_URLS: string[] = [];

export function getPluginManager(): PluginManager {
  return manager;
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
      const before = JSON.stringify(manager.getProjectState());
      manager.toggle(id, appApi);
      persistProjectPluginState(before);
    },
    setMapControlPosition: (
      id: string,
      appApi: ReturnType<typeof createAppAPI>,
      position: GeoLibreMapControlPosition,
    ) => {
      const before = JSON.stringify(manager.getProjectState());
      manager.setMapControlPosition(id, appApi, position);
      persistProjectPluginState(before);
    },
  };
}

// Built-in plugins are registered at module load so the toolbar can render
// plugin menu items on the first pass. This hook additionally kicks off the
// external plugin scan and reports whether it has finished.
export function useExternalPluginsReady(): boolean {
  const desktopSettings = useDesktopSettingsStore(
    (state) => state.desktopSettings,
  );
  const projectPluginManifestUrls = useAppStore(
    (state) => state.projectPlugins?.manifestUrls ?? EMPTY_PLUGIN_MANIFEST_URLS,
  );

  useEffect(() => {
    void ensureExternalPluginsLoadedWithSettings(
      desktopSettings,
      projectPluginManifestUrls,
    );
  }, [desktopSettings, projectPluginManifestUrls]);

  return useSyncExternalStore(
    (listener) => {
      externalPluginsListeners.add(listener);
      return () => externalPluginsListeners.delete(listener);
    },
    () => externalPluginsLoaded,
    () => externalPluginsLoaded,
  );
}

function ensureExternalPluginsLoadedWithSettings(
  desktopSettings: ReturnType<
    typeof useDesktopSettingsStore.getState
  >["desktopSettings"],
  projectPluginManifestUrls: string[],
): Promise<void> {
  const pluginManifestUrls = mergeStringLists(
    desktopSettings.pluginManifestUrls,
    projectPluginManifestUrls,
  );
  const loadKey = JSON.stringify({
    additionalPluginDirectories: desktopSettings.additionalPluginDirectories,
    pluginManifestUrls,
  });
  if (externalPluginsLoaded && externalPluginsLoadKey === loadKey) {
    return Promise.resolve();
  }
  if (externalPluginsLoadPromise && externalPluginsLoadKey === loadKey) {
    return externalPluginsLoadPromise;
  }

  setExternalPluginsLoaded(false);
  externalPluginsLoadKey = loadKey;
  // Serialize scans: loadExternalPlugins reads and writes module-level state
  // (the loaded-plugin map) across awaits, so two in-flight scans could both
  // pass the dedup check and double-register the same plugin. Waiting for the
  // previous scan (which never rejects) keeps at most one scan running.
  const previousLoad = externalPluginsLoadPromise ?? Promise.resolve();
  const loadPromise = previousLoad
    .then(() =>
      loadExternalPlugins(
        manager,
        desktopSettings.additionalPluginDirectories,
        pluginManifestUrls,
      ),
    )
    .then((result) => {
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
      externalPluginsLoadPromise = null;
      setExternalPluginsLoaded(true);
    });

  externalPluginsLoadPromise = loadPromise;
  return loadPromise;
}

export function createAppAPI(
  mapControllerRef?: RefObject<MapController | null>,
) {
  const store = useAppStore.getState();
  return {
    setBasemap: (url: string) => store.setBasemapStyleUrl(url),
    addGeoJsonLayer: (
      name: string,
      data: GeoJSON.FeatureCollection,
      sourcePath?: string,
    ) => {
      const id = store.addGeoJsonLayer(name, data, sourcePath);
      return id;
    },
    getActiveBasemap: () => useAppStore.getState().basemapStyleUrl,
    onBasemapChange: (callback: (styleUrl: string) => void) =>
      useAppStore.subscribe((state, prev) => {
        if (state.basemapStyleUrl !== prev.basemapStyleUrl) {
          callback(state.basemapStyleUrl);
        }
      }),
    fetchArrayBuffer: fetchRemoteArrayBuffer,
    fitBounds: (bounds: [number, number, number, number]) =>
      mapControllerRef?.current?.fitBounds(bounds),
    getMap: () => mapControllerRef?.current?.getMap() ?? null,
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
  };
}

async function fetchRemoteArrayBuffer(url: string): Promise<ArrayBuffer> {
  if (isTauriRuntime() && isLocalFileReference(url)) {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    return normalizeBytes(await readFile(localPathFromReference(url)));
  }

  if (isTauriRuntime()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const bytes = await invoke<number[] | Uint8Array>("fetch_url_bytes", {
        url,
      });
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

function persistProjectPluginState(previousJson: string): void {
  const nextState = {
    ...manager.getProjectState(),
    manifestUrls:
      useAppStore.getState().projectPlugins?.manifestUrls ??
      EMPTY_PLUGIN_MANIFEST_URLS,
  };
  if (JSON.stringify(nextState) === previousJson) return;
  useAppStore.getState().setProjectPlugins(nextState);
}
