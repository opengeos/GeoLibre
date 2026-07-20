import type { MapControlPosition, MapEngineClient } from "../engine/types";
import type maplibregl from "maplibre-gl";

/**
 * Adapter-private context passed to a dynamically loaded MapLibre runtime.
 *
 * It is never exported through `MapEngineClient`: only a loaded runtime inside
 * this package can receive native controls or a map instance.
 */
export interface MapLibreHostedRuntimeContext {
  readonly client: MapEngineClient;
  readonly map?: maplibregl.Map;
  addControl?(control: maplibregl.IControl, position?: MapControlPosition): boolean;
  removeControl?(control: maplibregl.IControl): void;
}

export interface MapLibreHostedRuntimeActivation {
  readonly position?: MapControlPosition;
  readonly collapsed?: boolean;
  /** Last serializable project state captured by the hosted descriptor. */
  readonly state?: unknown;
  /** Reports a new serializable state snapshot back to the hosted descriptor. */
  readonly onStateChange?: (state: unknown) => void;
  /** Host-provided text export for controls that cannot rely on anchor downloads. */
  readonly exportTextFile?: (filename: string, content: string) => void;
  /** Host confirmation for an adapter-owned style-basemap replacement. */
  readonly confirmStyleReplace?: (basemapName: string, count: number) => boolean;
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
  /** Handles a named, typed engine command for this adapter-private runtime. */
  runCommand?(context: MapLibreHostedRuntimeContext, command: string): boolean | void;
}

export type MapLibreHostedRuntimeLoader = () => Promise<MapLibreHostedRuntime>;

/** Apply the PluginManager project's restored panel-collapse intent. */
export function restoreHostedControlPanel(
  control: { collapse?: () => void; expand?: () => void },
  collapsed: boolean | undefined,
): void {
  if (collapsed) {
    control.collapse?.();
    return;
  }
  // Avoid the activating menu click being processed as a click-outside event.
  setTimeout(() => control.expand?.(), 0);
}
