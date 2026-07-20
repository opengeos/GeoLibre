import type { MapControlPosition } from "./types";

/**
 * Typed escape hatch for focused capabilities that do not belong on the core
 * engine contract. Runtime modules may augment this interface.
 */
export interface MapEngineExtensionMap {
  "viewport.resize": {
    input: undefined;
    output: void;
  };
  "story.set-layer-opacity": {
    input: { layerId: string; opacity: number; durationMs?: number };
    output: void;
  };
  "story.restore-layer-styles": {
    input: undefined;
    output: void;
  };
  "hosted-plugin.activate": {
    input: {
      pluginId: string;
      position?: MapControlPosition;
      collapsed?: boolean;
      state?: unknown;
      onStateChange?: (state: unknown) => void;
      exportTextFile?: (filename: string, content: string) => void;
      /** Host confirmation for an adapter-owned style-basemap replacement. */
      confirmStyleReplace?: (basemapName: string, count: number) => boolean;
    };
    output: boolean | Promise<boolean>;
  };
  "hosted-plugin.deactivate": {
    input: { pluginId: string };
    output: void;
  };
  "hosted-plugin.set-position": {
    input: {
      pluginId: string;
      position: MapControlPosition;
      collapsed?: boolean;
    };
    output: boolean;
  };
  "hosted-plugin.get-state": {
    input: { pluginId: string };
    output: unknown;
  };
  "hosted-plugin.apply-state": {
    input: { pluginId: string; state: unknown };
    output: boolean;
  };
  "directions.remove-last": {
    input: undefined;
    output: boolean;
  };
  "directions.clear": {
    input: undefined;
    output: boolean;
  };
  "earth-engine.hide": {
    input: undefined;
    output: boolean;
  };
}
