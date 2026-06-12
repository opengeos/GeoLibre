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

/**
 * GeoLibre's own deck.gl modules, handed to a plugin via
 * {@link GeoLibreAppAPI.getDeckGL}. Lets an external plugin render deck.gl
 * layers using the host's single deck.gl instance instead of bundling its own.
 */
export interface GeoLibreDeckGL {
  /** `@deck.gl/core` (Deck, the Layer base classes, view/state helpers). */
  core: typeof import("@deck.gl/core");
  /** `@deck.gl/layers` (ArcLayer, ScatterplotLayer, GeoJsonLayer, ...). */
  layers: typeof import("@deck.gl/layers");
  /** `@deck.gl/aggregation-layers` (HexagonLayer, HeatmapLayer, GridLayer, ScreenGridLayer, ContourLayer). */
  aggregationLayers: typeof import("@deck.gl/aggregation-layers");
  /** `@deck.gl/geo-layers` (TileLayer, H3HexagonLayer, S2Layer, ...). */
  geoLayers: typeof import("@deck.gl/geo-layers");
  /** `@deck.gl/mesh-layers` (SimpleMeshLayer, ScenegraphLayer). */
  meshLayers: typeof import("@deck.gl/mesh-layers");
  /** `@deck.gl/mapbox` - use `mapbox.MapboxOverlay` for interleaved MapLibre rendering. */
  mapbox: typeof import("@deck.gl/mapbox");
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
  /**
   * Resolve a fetchable URL for an asset shipped alongside an external
   * plugin's manifest (e.g. sample data bundled in the plugin folder). The
   * host resolves `relativePath` against the plugin's own directory. Returns
   * null for built-in plugins, for plugins installed from the desktop
   * filesystem (which have no URL base), or when `relativePath` escapes the
   * plugin directory. `pluginId` should be the calling plugin's own id; since
   * all plugins share one JS context the host cannot verify the caller, so this
   * is a convention rather than an enforced boundary. It is not a privilege
   * boundary: the resolved URL grants no access a plugin does not already have,
   * since any plugin can fetch any same-origin URL directly.
   */
  resolvePluginAssetUrl?: (
    pluginId: string,
    relativePath: string,
  ) => string | null;
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
   *
   * Web-only caveat: browsers do not fire a cancel event for `<input
   * type="file">`, so on the web the returned promise stays pending if the
   * user dismisses the dialog without choosing a file. Under Tauri (the
   * primary desktop target) cancel resolves to null as expected.
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
  /**
   * Resolve GeoLibre's own deck.gl modules so an external plugin can render
   * deck.gl layers (e.g. an `ArcLayer`) on the host's single deck.gl instance.
   * Bundling a second copy is not viable: deck.gl and luma.gl throw on a
   * version mismatch and share global singletons, so a plugin's own copy fails
   * to render. Always present on the GeoLibre desktop and web hosts; typed
   * optional for forward-compatibility with host variants that may not ship
   * deck.gl, so plugins should still call it with optional chaining.
   */
  getDeckGL?: () => Promise<GeoLibreDeckGL>;
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
