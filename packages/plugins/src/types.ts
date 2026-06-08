import type { GeoLibreLayer, LayerStyle } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type { IControl, Map as MapLibreMap } from "maplibre-gl";

export type GeoLibreMapControlPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type GeoLibreBuiltInMapControl =
  | "navigation"
  | "fullscreen"
  | "geolocate"
  | "globe"
  | "terrain"
  | "scale"
  | "attribution"
  | "logo"
  | "layer-control";

export interface GeoLibreExternalNativeLayerRegistration {
  id: string;
  name: string;
  type?: GeoLibreLayer["type"];
  source?: Record<string, unknown>;
  geojson?: FeatureCollection;
  nativeLayerIds: string[];
  sourceIds?: string[];
  sourceId?: string;
  beforeId?: string;
  opacity?: number;
  style?: Partial<LayerStyle>;
  metadata?: Record<string, unknown>;
  sourcePath?: string;
}

/**
 * Describes the file-type filter shown by the host's save/open dialog so
 * plugins can label exports/imports (e.g. JSON, GeoJSON, CSV) without knowing
 * whether they run under Tauri or in a browser.
 */
export interface GeoLibreFileDialogOptions {
  /** Human-readable file-type label, e.g. "Bookmarks" or "GeoJSON". */
  description?: string;
  /** Allowed extensions without the leading dot, e.g. ["json"]. */
  extensions?: string[];
  /** MIME type used for the browser download blob. */
  mimeType?: string;
}

export interface GeoLibreAppAPI {
  setBasemap: (styleUrl: string) => void;
  addGeoJsonLayer: (
    name: string,
    data: FeatureCollection,
    sourcePath?: string,
  ) => void;
  getActiveBasemap: () => string;
  onBasemapChange: (callback: (styleUrl: string) => void) => () => void;
  fetchArrayBuffer?: (url: string) => Promise<ArrayBuffer>;
  fitBounds?: (bounds: [number, number, number, number]) => void;
  getMap?: () => MapLibreMap | null;
  pickLocalDirectoryFiles?: () => Promise<File[] | null>;
  /**
   * Save text content to a file chosen by the user. The host handles the
   * platform specifics (a native save dialog under Tauri, a browser download
   * on the web), so plugins can export data without depending on the runtime.
   * Pass `options` to control the file-type label/extensions (defaults to
   * GeoJSON).
   */
  exportTextFile?: (
    filename: string,
    content: string,
    options?: GeoLibreFileDialogOptions,
  ) => void;
  /**
   * Prompt the user to pick a text file and return its contents (a native open
   * dialog under Tauri, a file input on the web). Resolves to null when the
   * user cancels. Plugins can import data without depending on the runtime.
   */
  importTextFile?: (
    options?: GeoLibreFileDialogOptions,
  ) => Promise<string | null>;
  registerExternalNativeLayer?: (
    layer: GeoLibreExternalNativeLayerRegistration,
  ) => void;
  unregisterExternalNativeLayer?: (id: string) => void;
  addMapControl: (
    control: IControl,
    position?: GeoLibreMapControlPosition,
  ) => boolean;
  removeMapControl: (control: IControl) => void;
  setBuiltInMapControlVisible: (
    control: GeoLibreBuiltInMapControl,
    visible: boolean,
  ) => boolean;
  getBuiltInMapControlPosition: (
    control: GeoLibreBuiltInMapControl,
  ) => GeoLibreMapControlPosition;
  setBuiltInMapControlPosition: (
    control: GeoLibreBuiltInMapControl,
    position: GeoLibreMapControlPosition,
  ) => boolean;
}

export interface GeoLibrePlugin {
  id: string;
  name: string;
  version: string;
  activeByDefault?: boolean;
  /** At least one name is required for handleUrlParameters to be called. */
  urlParameterNames?: string[];
  activate: (app: GeoLibreAppAPI) => boolean | void;
  deactivate: (app: GeoLibreAppAPI) => void;
  /**
   * Called once per URL context after the map and plugins are ready.
   * Requires urlParameterNames to be non-empty; otherwise this hook is never
   * invoked. A handler that throws is not counted as handled, so a later
   * dispatch for the same context retries it.
   */
  handleUrlParameters?: (
    app: GeoLibreAppAPI,
    params: URLSearchParams,
  ) => void | Promise<void>;
  getMapControlPosition?: () => GeoLibreMapControlPosition;
  setMapControlPosition?: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => boolean | void;
  getProjectState?: () => unknown;
  applyProjectState?: (app: GeoLibreAppAPI, state: unknown) => boolean | void;
}

export interface GeoLibreExternalPluginManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  description?: string;
  style?: string;
}
