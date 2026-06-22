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
  ) => Promise<{ file: File; companionFiles: File[] } | null>;
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
   * Dock the active panel at a specific position, mirroring the user-facing move
   * buttons so a plugin can reposition its own panel. No-op when no panel is
   * active. See {@link GeoLibreRightPanelDock}.
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
  /** Title shown in the card's title bar. */
  title: string;
  /** Optional icon: a URL or `data:` URI rendered in the title bar. */
  icon?: string;
  /** Preferred card width in px (the host clamps it to a sensible range). */
  defaultWidth?: number;
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
 * Where a plugin panel docks, left to right: `left-of-layers` (the far-left
 * edge), `right-of-layers` (between the Layers panel and the map), `left-of-style`
 * (between the map and the Style panel), or `right-of-style` (the far-right
 * edge). The built-in panel on the docked side (Layers on the left, Style on the
 * right) collapses to its rail while the plugin panel is expanded next to it.
 */
export type GeoLibreRightPanelDock =
  | "left-of-layers"
  | "right-of-layers"
  | "left-of-style"
  | "right-of-style";

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
  /** Human-readable title shown in the panel header and collapsed rail. */
  title: string;
  /**
   * Where the panel docks initially: `left-of-layers`, `right-of-layers`,
   * `left-of-style`, or `right-of-style` (the default). The built-in panel on
   * the docked side (Layers on the left, Style on the right) collapses to its
   * rail while the plugin panel is expanded next to it. The user can move the
   * panel between positions at runtime with the move buttons in its header (or
   * a plugin via {@link GeoLibreAppAPI.setActiveRightPanelDock}).
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
}
