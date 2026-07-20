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
};

/**
 * Owns loaded MapLibre-only runtimes for one engine instance. Loader functions
 * are deliberately evaluated only when the matching plugin is activated.
 */
export class MapLibreHostedRuntimeRegistry {
  private readonly loaded = new Map<string, MapLibreHostedRuntime>();

  constructor(
    private readonly client: MapEngineClient,
    private readonly loaders: Readonly<
      Record<string, MapLibreHostedRuntimeLoader>
    > = runtimeLoaders,
  ) {}

  activate(pluginId: string, input: MapLibreHostedRuntimeActivation): boolean | Promise<boolean> {
    const knownRuntime = this.loaded.get(pluginId);
    if (knownRuntime) return normalizeActivation(knownRuntime.activate(this.context(), input));
    return this.load(pluginId).then((runtime) =>
      normalizeActivation(runtime.activate(this.context(), input)),
    );
  }

  deactivate(pluginId: string): void {
    this.loaded.get(pluginId)?.deactivate?.(this.context());
  }

  setPosition(pluginId: string, position: MapControlPosition): boolean {
    const runtime = this.loaded.get(pluginId);
    if (!runtime?.setPosition) return false;
    return runtime.setPosition(this.context(), position) !== false;
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
    return { client: this.client };
  }
}

export function createMapLibreHostedRuntimeRegistry(
  client: MapEngineClient,
  loaders?: Readonly<Record<string, MapLibreHostedRuntimeLoader>>,
): MapLibreHostedRuntimeRegistry {
  return new MapLibreHostedRuntimeRegistry(client, loaders);
}

function normalizeActivation(
  result: boolean | void | Promise<boolean | void>,
): boolean | Promise<boolean> {
  if (typeof (result as PromiseLike<boolean | void>)?.then === "function") {
    return Promise.resolve(result).then((resolved) => resolved !== false);
  }
  return result !== false;
}
