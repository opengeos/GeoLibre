import type { MapControlPosition } from "./types";

/**
 * Typed escape hatch for focused capabilities that do not belong on the core
 * engine contract. Runtime modules may augment this interface.
 */
export interface MapEngineExtensionMap {
  "hosted-plugin.activate": {
    input: {
      pluginId: string;
      position?: MapControlPosition;
      collapsed?: boolean;
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
}
