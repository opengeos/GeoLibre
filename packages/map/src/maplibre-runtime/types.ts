import type { MapControlPosition, MapEngineClient } from "../engine/types";

/**
 * Adapter-private context passed to a dynamically loaded MapLibre runtime.
 *
 * It intentionally contains only the engine client for the first runtime
 * slice. Subsequent runtime moves can extend this type with private MapLibre
 * facilities without exposing any of them to applications or external plugins.
 */
export interface MapLibreHostedRuntimeContext {
  readonly client: MapEngineClient;
}

export interface MapLibreHostedRuntimeActivation {
  readonly position?: MapControlPosition;
  readonly collapsed?: boolean;
}

/** A concrete renderer runtime, addressed only by its stable plugin id. */
export interface MapLibreHostedRuntime {
  activate(
    context: MapLibreHostedRuntimeContext,
    input: MapLibreHostedRuntimeActivation,
  ): boolean | void | Promise<boolean | void>;
  deactivate?(context: MapLibreHostedRuntimeContext): void;
  setPosition?(context: MapLibreHostedRuntimeContext, position: MapControlPosition): boolean | void;
  getState?(): unknown;
  applyState?(context: MapLibreHostedRuntimeContext, state: unknown): boolean | void;
}

export type MapLibreHostedRuntimeLoader = () => Promise<MapLibreHostedRuntime>;
