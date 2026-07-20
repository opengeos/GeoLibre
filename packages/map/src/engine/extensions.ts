import type { GeoLibreLayer, PixelTimeSeriesRequest, PixelTimeSeriesResult } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type { MapControlPosition } from "./types";

/** Plain-DOM right-panel contract used by an adapter-owned hosted runtime. */
export interface MapEngineRightPanelRegistration {
  readonly id: string;
  readonly title: string | (() => string);
  readonly dock?:
    | "left-of-layers"
    | "right-of-layers"
    | "left-of-style"
    | "right-of-style"
    | "replace-style"
    | "replace-layers";
  readonly render: (container: HTMLElement) => void | (() => void);
}

/** Optional host bridge for a renderer runtime that owns a docked settings panel. */
export interface MapEngineRightPanelHost {
  readonly register: (panel: MapEngineRightPanelRegistration) => () => void;
  readonly open: (id: string) => boolean;
}

/** Plain-DOM floating-panel contract used by an adapter-owned hosted runtime. */
export interface MapEngineFloatingPanelRegistration {
  readonly id: string;
  readonly title: string | (() => string);
  readonly defaultWidth?: number;
  readonly defaultHeight?: number;
  readonly position?: MapControlPosition;
  readonly render: (container: HTMLElement) => void | (() => void);
}

export interface MapEngineFloatingPanelHost {
  readonly register: (panel: MapEngineFloatingPanelRegistration) => () => void;
  readonly open: (id: string) => boolean;
}

/** Store-facing description of native layers owned privately by an adapter runtime. */
export interface MapEngineExternalNativeLayerRegistration {
  readonly id: string;
  readonly name: string;
  readonly type?: GeoLibreLayer["type"];
  readonly source?: Record<string, unknown>;
  readonly geojson?: FeatureCollection;
  readonly nativeLayerIds: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly sourceId?: string;
  readonly beforeId?: string;
  readonly opacity?: number;
  readonly style?: Partial<GeoLibreLayer["style"]>;
  readonly metadata?: Record<string, unknown>;
  readonly sourcePath?: string;
}

export interface MapEngineExternalLayerHost {
  readonly register: (layer: MapEngineExternalNativeLayerRegistration) => void;
  readonly unregister: (id: string) => void;
}

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
      /** Host bridge for an adapter-owned docked settings panel. */
      rightPanelHost?: MapEngineRightPanelHost;
      /** Host bridge for an adapter-owned floating panel. */
      floatingPanelHost?: MapEngineFloatingPanelHost;
      /** Store bridge for adapter-owned native layers. */
      externalLayerHost?: MapEngineExternalLayerHost;
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
  "time-slider.query-pixel-series": {
    input: PixelTimeSeriesRequest;
    output: Promise<PixelTimeSeriesResult>;
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
