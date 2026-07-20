import type { MapControlPosition, MapEngineClient } from "../engine/types";
import type {
  MapLibreHostedRuntime,
  MapLibreHostedRuntimeActivation,
  MapLibreHostedRuntimeContext,
  MapLibreHostedRuntimeLoader,
} from "./types";

const runtimeLoaders: Readonly<Record<string, MapLibreHostedRuntimeLoader>> = {
  "maplibre-layer-control": async () =>
    (await import("./layer-control")).maplibreLayerControlRuntime,
  "maplibre-gl-streetview": async () => (await import("./streetview")).maplibreStreetViewRuntime,
  "maplibre-gl-fema-wms": async () => (await import("./fema-wms")).maplibreFemaWmsRuntime,
  "maplibre-gl-national-map": async () =>
    (await import("./national-map")).maplibreNationalMapRuntime,
  "maplibre-gl-nasa-earthdata": async () =>
    (await import("./nasa-earthdata")).maplibreNasaEarthdataRuntime,
  "maplibre-gl-enviroatlas": async () => (await import("./enviroatlas")).maplibreEnviroAtlasRuntime,
  "maplibre-gl-usgs-lidar": async () => (await import("./usgs-lidar")).maplibreUsgsLidarRuntime,
  "maplibre-gl-esri-wayback": async () =>
    (await import("./esri-wayback")).maplibreEsriWaybackRuntime,
  "maplibre-gl-overture-maps": async () =>
    (await import("./overture-maps")).maplibreOvertureMapsRuntime,
  "maplibre-gl-basemap-control": async () =>
    (await import("./basemap-control")).maplibreBasemapControlRuntime,
};

/**
 * Owns loaded MapLibre-only runtimes for one engine instance. Loader functions
 * are deliberately evaluated only when the matching plugin receives its first
 * lifecycle command. This keeps inactive controls out of the startup bundle,
 * while still allowing an active-by-default built-in control to be hidden or
 * repositioned before it has needed a plugin activation.
 */
export class MapLibreHostedRuntimeRegistry {
  private readonly loaded = new Map<string, MapLibreHostedRuntime>();

  constructor(
    private readonly client: MapEngineClient,
    private readonly loaders: Readonly<
      Record<string, MapLibreHostedRuntimeLoader>
    > = runtimeLoaders,
    private readonly createContext: () => MapLibreHostedRuntimeContext = () => ({
      client: this.client,
    }),
  ) {}

  activate(pluginId: string, input: MapLibreHostedRuntimeActivation): boolean | Promise<boolean> {
    const knownRuntime = this.loaded.get(pluginId);
    if (knownRuntime) return normalizeActivation(knownRuntime.activate(this.context(), input));
    return this.load(pluginId).then((runtime) =>
      normalizeActivation(runtime.activate(this.context(), input)),
    );
  }

  deactivate(pluginId: string): void {
    const runtime = this.loaded.get(pluginId);
    if (runtime) {
      runtime.deactivate?.(this.context());
      return;
    }

    // Active-by-default controls are mounted by the engine before PluginManager
    // has an app API. Their first plugin lifecycle operation can therefore be
    // a deactivate during project restore. Load lazily here so the engine-owned
    // control is actually hidden instead of leaving it visible.
    void this.load(pluginId)
      .then((loadedRuntime) => loadedRuntime.deactivate?.(this.context()))
      .catch((error: unknown) => {
        console.warn(`[maplibre-hosted-runtime] failed to deactivate "${pluginId}":`, error);
      });
  }

  setPosition(pluginId: string, position: MapControlPosition): boolean {
    const runtime = this.loaded.get(pluginId);
    if (runtime) {
      if (!runtime.setPosition) return false;
      return runtime.setPosition(this.context(), position) !== false;
    }

    // See deactivate(): accept the requested position now and apply it once
    // the lazily loaded runtime is available. PluginManager persists the
    // descriptor position independently, so this optimistic result precisely
    // reflects that the request was accepted by the adapter.
    void this.load(pluginId)
      .then((loadedRuntime) => loadedRuntime.setPosition?.(this.context(), position))
      .catch((error: unknown) => {
        console.warn(`[maplibre-hosted-runtime] failed to position "${pluginId}":`, error);
      });
    return true;
  }

  getState(pluginId: string): unknown {
    return this.loaded.get(pluginId)?.getState?.();
  }

  applyState(pluginId: string, state: unknown): boolean {
    const runtime = this.loaded.get(pluginId);
    if (!runtime?.applyState) return false;
    return runtime.applyState(this.context(), state) !== false;
  }

  private async load(pluginId: string): Promise<MapLibreHostedRuntime> {
    const loader = this.loaders[pluginId];
    if (!loader) throw new Error(`No MapLibre runtime is registered for plugin "${pluginId}".`);
    const runtime = await loader();
    this.loaded.set(pluginId, runtime);
    return runtime;
  }

  private context(): MapLibreHostedRuntimeContext {
    return this.createContext();
  }
}

export function createMapLibreHostedRuntimeRegistry(
  client: MapEngineClient,
  loaders?: Readonly<Record<string, MapLibreHostedRuntimeLoader>>,
  createContext?: () => MapLibreHostedRuntimeContext,
): MapLibreHostedRuntimeRegistry {
  return new MapLibreHostedRuntimeRegistry(client, loaders, createContext);
}

function normalizeActivation(
  result: boolean | void | Promise<boolean | void>,
): boolean | Promise<boolean> {
  if (typeof (result as PromiseLike<boolean | void>)?.then === "function") {
    return Promise.resolve(result).then((resolved) => resolved !== false);
  }
  return result !== false;
}
