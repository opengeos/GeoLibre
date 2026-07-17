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
 * Options shared by the raster/tile registration helpers
 * ({@link GeoLibreAppAPI.addTileLayer}, {@link GeoLibreAppAPI.addWmtsLayer},
 * {@link GeoLibreAppAPI.addWmsLayer}). They mirror the MapLibre raster `source`
 * fields a tile service typically advertises, so the layer renders with the
 * right extent, zoom range, and attribution without the plugin touching the
 * map.
 */
export interface GeoLibreTileLayerOptions {
  /** Tile size in pixels (default 256). */
  tileSize?: number;
  /** Attribution string shown in the map's attribution control. */
  attribution?: string;
  /** Visible extent as `[west, south, east, north]` in WGS84 degrees. */
  bounds?: [number, number, number, number];
  /** Minimum zoom at which tiles are requested. */
  minzoom?: number;
  /** Maximum zoom at which tiles are requested. */
  maxzoom?: number;
  /** Tile y-axis scheme; `"tms"` flips the y origin. Defaults to `"xyz"`. */
  scheme?: "xyz" | "tms";
  /** Initial visibility (default true). */
  visible?: boolean;
  /** Initial opacity in [0, 1] (default 1). */
  opacity?: number;
  /** Insert the new layer directly beneath the layer with this id. */
  beforeLayerId?: string;
}

/**
 * Options for {@link GeoLibreAppAPI.addWmsLayer}. The GetMap tile URL is built
 * from the service `url` plus `layers`, so the plugin passes the WMS request
 * parameters instead of a tile URL template.
 */
export interface GeoLibreWmsLayerOptions extends GeoLibreTileLayerOptions {
  /** WMS service endpoint (the GetMap base URL). */
  url: string;
  /** Comma-separated WMS layer name(s) to request. */
  layers: string;
  /** Comma-separated style name(s) (default empty: the server default). */
  styles?: string;
  /** Image format, e.g. `"image/png"` (default) or `"image/jpeg"`. */
  format?: string;
  /** Request transparent tiles (default true). */
  transparent?: boolean;
  /**
   * WMS protocol version: `"1.1.1"` (default) or `"1.3.0"`. Version 1.3.0
   * sends `CRS` instead of `SRS`; some servers accept only one version.
   */
  version?: string;
}

/**
 * Options for {@link GeoLibreAppAPI.addCogLayer}: a native Cloud-Optimized
 * GeoTIFF layer read directly from a URL and rendered client-side, with band
 * selection, rescale, colormap, and nodata handling exposed in the Style/raster
 * panel. All fields are optional; the renderer infers sensible defaults from
 * the GeoTIFF when they are omitted.
 */
export interface GeoLibreCogLayerOptions {
  /** Band selection, e.g. `"1"` (single band) or `"1,2,3"` (RGB). */
  bands?: string;
  /**
   * Named colormap applied to a single-band COG (e.g. `"terrain"`,
   * `"viridis"`). Deliberately typed as a loose `string` so external JS
   * plugins are not forced to import the renderer's internal colormap union;
   * an unrecognized name falls back to the renderer default rather than
   * erroring.
   */
  colormap?: string;
  /** Lower bound of the value range mapped to the colormap/contrast stretch. */
  rescaleMin?: number;
  /** Upper bound of the value range mapped to the colormap/contrast stretch. */
  rescaleMax?: number;
  /** Pixel value rendered as transparent (overrides the file's NoData tag). */
  nodata?: number;
  /** Initial opacity in [0, 1] (default 1). */
  opacity?: number;
  /** Insert the new layer directly beneath the layer with this id. */
  beforeLayerId?: string;
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
  /**
   * For {@link GeoLibreAppAPI.exportTextFile}: when true, ask the user for a
   * file name first in browsers that cannot show a native save picker (Firefox,
   * Safari), where the export would otherwise download under a fixed name. Has
   * no effect under Tauri or in browsers with the File System Access picker,
   * which already let the user choose the name.
   */
  promptName?: boolean;
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

/**
 * A vector file picked through {@link GeoLibreAppAPI.pickVectorFilesWithSidecars},
 * with any shapefile sidecars the host found alongside it.
 */
export interface GeoLibrePickedVectorFile {
  /** The main vector file (the `.shp` for a shapefile). */
  file: File;
  /**
   * Shapefile sidecar files (`.shx`, `.dbf`, `.prj`, `.cpg`) discovered next to
   * a `.shp`; empty for any other format. Pass these to a vector control's
   * `addData(file, { companionFiles })` so a loose `.shp` loads as one layer.
   */
  companionFiles: File[];
  /**
   * Absolute filesystem path the main file was read from, so the Add Vector
   * Layer panel can persist it (`addData(file, { sourcePath })`) and re-read the
   * file when a saved project reopens.
   */
  sourcePath?: string;
  /**
   * FeatureCollection materialized by a desktop host's native vector reader.
   * When present, the Add Vector Layer bridge can load it as GeoJSON while
   * still persisting {@link sourcePath} for project restore.
   */
  nativeData?: FeatureCollection;
}

export interface GeoLibreAppAPI {
  setBasemap: (styleUrl: string) => void;
  addGeoJsonLayer: (
    name: string,
    data: FeatureCollection,
    sourcePath?: string,
  ) => string;
  /**
   * Add a native XYZ raster tile layer from a tile URL template (with
   * `{x}`/`{y}`/`{z}` placeholders) and return its layer id. Unlike calling
   * `getMap().addSource()/addLayer()` directly, the layer appears in the Layers
   * panel with full opacity/reorder/styling support and persists with the
   * project, matching {@link addGeoJsonLayer} for vector data. Typed optional
   * for forward-compatibility with host variants, so call it with optional
   * chaining.
   */
  addTileLayer?: (
    name: string,
    url: string,
    options?: GeoLibreTileLayerOptions,
  ) => string;
  /**
   * Add a native WMTS raster tile layer from a WMTS tile URL template and return
   * its layer id. Behaves like {@link addTileLayer} (the layer is a first-class
   * panel entry that persists with the project); the separate name keeps WMTS
   * layers labelled distinctly. Typed optional for forward-compatibility, so
   * call it with optional chaining.
   */
  addWmtsLayer?: (
    name: string,
    url: string,
    options?: GeoLibreTileLayerOptions,
  ) => string;
  /**
   * Add a native WMS raster layer and return its layer id. The host builds the
   * GetMap tile URL from {@link GeoLibreWmsLayerOptions.url} and
   * {@link GeoLibreWmsLayerOptions.layers}, so the plugin supplies the request
   * parameters rather than a tile URL template. The layer persists with the
   * project like {@link addTileLayer}. Typed optional for
   * forward-compatibility, so call it with optional chaining.
   */
  addWmsLayer?: (name: string, options: GeoLibreWmsLayerOptions) => string;
  /**
   * Add a native Cloud-Optimized GeoTIFF (COG) layer read directly from a URL
   * and rendered client-side, returning a promise for the new layer's id.
   * Unlike {@link addTileLayer} (which expects pre-rendered XYZ tiles), this
   * loads the GeoTIFF itself and exposes band/rescale/colormap/nodata controls,
   * matching the host's own COG raster layers. The layer appears in the Layers
   * panel and persists with the project. Resolves once the layer is registered;
   * rejects if the COG cannot be loaded. Typed optional for
   * forward-compatibility, so call it with optional chaining.
   */
  addCogLayer?: (
    name: string,
    url: string,
    options?: GeoLibreCogLayerOptions,
  ) => Promise<string>;
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
   * Prompt the user (desktop only) to pick one or more vector files via the
   * native dialog, returning each with any shapefile sidecars discovered in the
   * same directory and the absolute `sourcePath` it was read from. The sidecars
   * let a host with filesystem access load a loose `.shp` without the user
   * selecting every component (`.shx`, `.dbf`, ...); the path lets the Add
   * Vector Layer panel persist it so the layer can be re-read on reopen. Present
   * only on hosts with filesystem access (the desktop build); absent on the web
   * (browsers cannot read sibling files or expose paths), so its presence
   * doubles as a desktop capability check. Resolves to an empty array when the
   * dialog is cancelled.
   */
  pickVectorFilesWithSidecars?: () => Promise<GeoLibrePickedVectorFile[]>;
  /**
   * Read a local vector file back into a File (with any shapefile sidecars) from
   * the absolute path persisted on a layer's `sourcePath`, so the Add Vector
   * Layer restore can reload a desktop local-file layer when a project reopens.
   * Resolves to null off the desktop host, or when the file can no longer be
   * read (moved or deleted).
   */
  readLocalVectorFile?: (
    path: string,
  ) => Promise<{
    file: File;
    companionFiles: File[];
    nativeData?: FeatureCollection;
  } | null>;
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
  /**
   * Resolve GeoLibre's own `maplibre-gl-raster` module so an external plugin can
   * render Cloud-Optimized GeoTIFFs through the host's instance instead of
   * bundling its own. maplibre-gl-raster pulls in deck.gl and luma.gl, which
   * throw on a second copy (luma.gl: "already initialized"); a bundled plugin
   * copy therefore fails to activate. GeoLibre already ships maplibre-gl-raster
   * (the built-in raster layer uses it), so it hands plugins the same instance.
   * Always present on the GeoLibre desktop and web hosts; typed optional for
   * forward-compatibility, so plugins should call it with optional chaining.
   */
  getMaplibreGlRaster?: () => Promise<typeof import("maplibre-gl-raster")>;
  /**
   * Set the map projection preference (persisted in app state, so the host's
   * projection enforcement keeps it). deck.gl-backed plugins call this with
   * `"mercator"` because deck.gl's tiled rendering does not support globe view;
   * a raw `map.setProjection` is reverted on the next idle by the host.
   *
   * There is no automatic rollback: a plugin that forces a projection on
   * activate should save the user's choice with {@link getMapProjection} first
   * and restore it on `deactivate`, otherwise the user is left in the forced
   * projection after the plugin is turned off. Fall back when the getter is
   * absent on an older host so `deactivate` never passes `undefined` (the
   * runtime guard ignores it, stranding the user in the forced projection):
   *
   * ```ts
   * const saved = app.getMapProjection?.() ?? "globe";
   * app.setMapProjection?.("mercator");
   * // on deactivate:
   * app.setMapProjection?.(saved);
   * ```
   */
  setMapProjection?: (projection: "globe" | "mercator") => void;
  /** Current map projection preference. */
  getMapProjection?: () => "globe" | "mercator";
  /**
   * Register a plugin-owned right-sidebar panel that docks beside the built-in
   * Style panel and behaves like a first-class part of the workspace. Returns
   * an unregister function (call it from `deactivate`). The panel is not shown
   * until `openRightPanel(panel.id)` runs. While a plugin panel is the active
   * right-side workspace the host collapses the Style panel to its rail and
   * restores it when the plugin panel closes. Typed optional for
   * forward-compatibility with host variants without a right sidebar, so
   * plugins should call it with optional chaining.
   */
  registerRightPanel?: (panel: GeoLibreRightPanelRegistration) => () => void;
  /** Remove a previously registered right panel (closing it if active). */
  unregisterRightPanel?: (id: string) => void;
  /**
   * Make the panel the active right-side workspace and expand it. Returns false
   * if no panel with that id is registered. Re-opening a collapsed panel
   * expands it.
   */
  openRightPanel?: (id: string) => boolean;
  /** Collapse the active right panel to its rail without closing it. */
  collapseRightPanel?: (id: string) => void;
  /** Close the active right panel and restore the Style panel. */
  closeRightPanel?: (id: string) => void;
  /** Id of the active right-side workspace panel, or null when none is open. */
  getActiveRightPanel?: () => string | null;
  /**
   * Dock the active panel at any dock, mirroring the user-facing controls so a
   * plugin can reposition its own panel. The four positional docks behave like
   * the move buttons; `replace-style` switches the panel into the shared Style
   * rail (the inverse of detaching it back to a positional dock). No-op when no
   * panel is active. See {@link GeoLibreRightPanelDock}.
   */
  setActiveRightPanelDock?: (dock: GeoLibreRightPanelDock) => void;
  /** Where the active panel docks, or null when none is open. */
  getActiveRightPanelDock?: () => GeoLibreRightPanelDock | null;
  /**
   * Register a plugin-owned top-level toolbar menu shown in the GeoLibre banner
   * beside the built-in menus, with nested submenus and action items. Returns
   * an unregister function (call it from `deactivate`). Re-registering the same
   * id replaces the menu. Typed optional for forward-compatibility with hosts
   * that have no top toolbar, so call it with optional chaining.
   *
   * The host tracks which plugin owns each menu so the toolbar can place it by
   * owner (e.g. external plugin menus after Help); that is injected internally
   * by the PluginManager, so plugins never pass an owner here.
   */
  registerToolbarMenu?: (menu: GeoLibreToolbarMenu) => () => void;
  /** Remove a previously registered toolbar menu. */
  unregisterToolbarMenu?: (id: string) => void;
  /**
   * Register a plugin-owned floating panel: a draggable, closeable card the
   * host overlays on the map's top-left corner. Returns an unregister function
   * (call it from `deactivate`). The panel is not shown until
   * {@link openFloatingPanel} is called. Unlike a right panel, several floating
   * panels can be open at once and they do not shrink the map.
   */
  registerFloatingPanel?: (
    panel: GeoLibreFloatingPanelRegistration,
  ) => () => void;
  /** Remove a registered floating panel (closing it if open). */
  unregisterFloatingPanel?: (id: string) => void;
  /** Open a floating panel (or bring an already-open one to the front). */
  openFloatingPanel?: (id: string) => boolean;
  /** Close an open floating panel. */
  closeFloatingPanel?: (id: string) => void;
  /** Ids of the currently open floating panels, in stacking order. */
  getOpenFloatingPanels?: () => string[];
}

/**
 * An action item in a plugin {@link GeoLibreToolbarMenu}. Selecting it runs
 * {@link onSelect} (for example, to open a right panel or floating panel).
 */
export interface GeoLibreToolbarMenuAction {
  /** Discriminator; defaults to "action" when omitted. */
  type?: "action";
  /** Stable id, unique within the menu. */
  id: string;
  /** Label shown in the menu. */
  label: string;
  /** Optional icon: a URL or `data:` URI rendered as an image. */
  icon?: string;
  /** When true, the item is shown disabled and cannot be selected. */
  disabled?: boolean;
  /** Invoked when the user selects the item. */
  onSelect: () => void;
}

/** A nested submenu in a plugin {@link GeoLibreToolbarMenu}. */
export interface GeoLibreToolbarSubmenu {
  type: "submenu";
  /** Stable id, unique within the parent menu. */
  id: string;
  /** Label shown on the submenu trigger. */
  label: string;
  /** Optional icon: a URL or `data:` URI rendered as an image. */
  icon?: string;
  /** Child items (actions, separators, or further submenus). */
  items: GeoLibreToolbarMenuItem[];
}

/** A divider between groups of items in a plugin toolbar menu. */
export interface GeoLibreToolbarSeparator {
  type: "separator";
  /** Optional id (only needed as a stable React key when you have many). */
  id?: string;
}

/** One entry in a plugin toolbar menu: an action, a submenu, or a separator. */
export type GeoLibreToolbarMenuItem =
  | GeoLibreToolbarMenuAction
  | GeoLibreToolbarSubmenu
  | GeoLibreToolbarSeparator;

/**
 * A plugin-owned top-level toolbar menu. The host renders it as a dropdown
 * button in the banner beside the built-in menus.
 */
export interface GeoLibreToolbarMenu {
  /** Stable unique id used to unregister the menu. */
  id: string;
  /** Button label shown in the toolbar. */
  label: string;
  /** Optional icon: a URL or `data:` URI rendered as an image. */
  icon?: string;
  /** Top-level items (actions, separators, or submenus). */
  items: GeoLibreToolbarMenuItem[];
}

/**
 * A plugin-owned floating panel: a draggable, closeable card the host overlays
 * on the map's top-left corner. The plugin owns only the body via {@link render}
 * (plain DOM); the host provides the card chrome (a draggable title bar with a
 * close button). Several floating panels can be open at once, and they do not
 * shrink the map.
 */
export interface GeoLibreFloatingPanelRegistration {
  /** Stable unique id used to open/close the panel. */
  id: string;
  /**
   * Title shown in the card's title bar. Pass a getter function to make the
   * title reactive: it is re-evaluated on every `getFloatingPanel` call, so it
   * picks up a new language without re-registering the panel. Caveat: the
   * registry itself does not subscribe to i18n events, so the getter is only
   * re-run when a consumer re-reads the panel. Today every host component that
   * displays a title also calls `useTranslation()`, whose `languageChanged`
   * re-render re-reads the panel as a side effect; a host that reads a panel
   * without that subscription would show a stale title after a language switch
   * until the next registry mutation, and should re-read the panel itself on
   * language change. A plain string is frozen at registration time.
   */
  title: string | (() => string);
  /** Optional icon: a URL or `data:` URI rendered in the title bar. */
  icon?: string;
  /** Preferred card width in px (the host clamps it to a sensible range). */
  defaultWidth?: number;
  /**
   * Preferred card height in px. When set, the card opens at this height and its
   * body fills it (so a `height:100%` plugin element grows with the card);
   * omitted, the card sizes to its content. The host clamps it and lets the user
   * resize from the corner handle.
   */
  defaultHeight?: number;
  /**
   * Which corner of the map the card first opens at (default `top-left`). The
   * card stays freely draggable/resizable afterwards; a plugin can move it
   * between corners by re-registering with a new position (used to back the
   * Plugins-menu position submenu).
   */
  position?: GeoLibreMapControlPosition;
  /**
   * Populate the card body. Called once with an empty container the plugin
   * fills with its own DOM. The container stays mounted while the card is open,
   * so plugin state persists. May return a cleanup function the host runs when
   * the panel closes or is unregistered.
   */
  render: (container: HTMLElement) => void | (() => void);
  /** Called after the panel opens. */
  onOpen?: () => void;
  /** Called after the panel closes. */
  onClose?: () => void;
}

/**
 * Where a plugin panel docks. Four are positional, left to right: `left-of-layers`
 * (the far-left edge), `right-of-layers` (between the Layers panel and the map),
 * `left-of-style` (between the map and the Style panel), or `right-of-style` (the
 * far-right edge). The built-in panel on the docked side (Layers on the left,
 * Style on the right) collapses to its rail while the plugin panel is expanded
 * next to it.
 *
 * `replace-style` and `replace-layers` are non-positional **shared-rail** modes:
 * the panel shares the Style (right) or Layers (left) panel's sidebar surface
 * instead of sitting beside it as a separate rail. The host shows a single rail
 * on that edge listing both the plugin panel and the built-in panel; selecting
 * one expands it while the other stays as a rail entry, so a workbench-style
 * plugin feels like a first-class sidebar workspace rather than a second rail.
 * Unlike the positional docks, these modes are not part of the move-button step
 * sequence; the host's merge/detach buttons switch a panel in and out of them.
 */
export type GeoLibreRightPanelDock =
  | "left-of-layers"
  | "right-of-layers"
  | "left-of-style"
  | "right-of-style"
  | "replace-style"
  | "replace-layers";

/**
 * A plugin-owned dockable side panel. The host renders the registered panel in
 * its own dock (one of three positions beside the Layers/Style panels), with a
 * collapsible rail, a header (title plus move/collapse/close buttons), and a
 * resize handle. The plugin owns only the content: `render` is called once with
 * an empty container element the plugin fills with its own DOM (an external
 * plugin cannot share GeoLibre's React, so the contract is plain DOM rather
 * than a React node).
 */
export interface GeoLibreRightPanelRegistration {
  /** Stable unique id used to open/collapse/close the panel. */
  id: string;
  /**
   * Human-readable title shown in the panel header and collapsed rail.
   * Pass a getter function to make the title reactive: it is re-evaluated on
   * every `getRightPanel` call, so it picks up a new language without
   * re-registering the panel. Caveat: the registry itself does not subscribe
   * to i18n events, so the getter is only re-run when a consumer re-reads the
   * panel. Today every host component that displays a title also calls
   * `useTranslation()`, whose `languageChanged` re-render re-reads the panel
   * as a side effect; a host that reads a panel without that subscription
   * would show a stale title after a language switch until the next registry
   * mutation, and should re-read the panel itself on language change. A plain
   * string is frozen at registration time.
   */
  title: string | (() => string);
  /**
   * Where the panel docks initially: one of the four positional docks
   * (`left-of-layers`, `right-of-layers`, `left-of-style`, or `right-of-style`,
   * the default), or a shared-rail mode (`replace-style` / `replace-layers`).
   * With a positional dock the built-in panel on the docked side (Layers on the
   * left, Style on the right) collapses to its rail while the plugin panel is
   * expanded next to it, and the user can move the panel between positions at
   * runtime with the move buttons in its header (or a plugin via
   * {@link GeoLibreAppAPI.setActiveRightPanelDock}). With a shared-rail mode the
   * panel shares the Style or Layers sidebar's single rail instead and is not
   * steppable (the header's merge/detach buttons switch it in and out).
   */
  dock?: GeoLibreRightPanelDock;
  /**
   * Optional icon for the collapsed rail. A URL or `data:` URI is rendered as
   * an image; any other value is ignored in favor of a default glyph.
   */
  icon?: string;
  /**
   * Preferred width of the expanded panel in pixels (desktop only; the host
   * clamps it to a sensible range). Defaults to the host's standard panel
   * width.
   */
  defaultWidth?: number;
  /**
   * Populate the panel body. Called once with an empty container when the panel
   * first becomes active; the plugin appends its own DOM. The container is kept
   * mounted across collapse so plugin state persists. May return a cleanup
   * function invoked when the panel is closed or unregistered.
   */
  render: (container: HTMLElement) => void | (() => void);
  /** Called after the panel opens (becomes the active workspace). */
  onOpen?: () => void;
  /** Called after the panel collapses to its rail. */
  onCollapse?: () => void;
  /** Called after the panel closes (releases the workspace). */
  onClose?: () => void;
}

export interface GeoLibrePlugin {
  id: string;
  name: string;
  version: string;
  activeByDefault?: boolean;
  /** At least one name is required for handleUrlParameters to be called. */
  urlParameterNames?: string[];
  /**
   * Activate the plugin. Return `false` to refuse activation. A plugin that
   * mounts asynchronously (e.g. behind a dynamic import) may return a Promise
   * that resolves to `false` (or rejects) when the mount ultimately fails; the
   * host then rolls back the optimistic active state so the Plugins menu does
   * not show a plugin that never came up.
   *
   * If a plugin auto-opens its control panel on activation, expand it with a
   * `setTimeout(() => control.expand(), 0)` (the convention every built-in
   * control follows). On a project restore the host re-collapses panels one
   * tick after that expand so a loaded project does not bury the map (#952);
   * deferring the expand by more than one tick would defeat that and leave the
   * panel open after restore.
   */
  activate: (app: GeoLibreAppAPI) => boolean | void | Promise<boolean | void>;
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
  /**
   * Activate the plugin on startup when no saved plugin state overrides it.
   * Honored only for bundled drop-ins (public/plugins/<id>/), which are baked
   * into the build by the deployer and therefore as trusted as built-ins.
   * Ignored for plugins installed at runtime from zips or manifest URLs, so
   * third-party plugins cannot force themselves active.
   */
  activeByDefault?: boolean;
}
