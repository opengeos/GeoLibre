# GeoLibre Plugin API

## Interface

```typescript
import type { FeatureCollection } from "geojson";
import type { IControl } from "maplibre-gl";

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

export interface GeoLibrePlugin {
  id: string;
  name: string;
  version: string;
  activeByDefault?: boolean;
  /** At least one name is required for handleUrlParameters to be called. */
  urlParameterNames?: string[];
  activate: (app: GeoLibreAppAPI) => boolean | void;
  deactivate: (app: GeoLibreAppAPI) => void;
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

// Resolved by app.getDeckGL(): GeoLibre's own deck.gl modules, so a plugin
// renders on the host's single instance instead of bundling its own copy.
export interface GeoLibreDeckGL {
  core: typeof import("@deck.gl/core");
  layers: typeof import("@deck.gl/layers");
  geoLayers: typeof import("@deck.gl/geo-layers");
  meshLayers: typeof import("@deck.gl/mesh-layers");
  mapbox: typeof import("@deck.gl/mapbox");
}

export interface GeoLibreAppAPI {
  setBasemap: (styleUrl: string) => void;
  addGeoJsonLayer: (
    name: string,
    data: FeatureCollection,
    sourcePath?: string,
  ) => string;
  // Native raster/tile layers (see "Raster and tile layers" below). Each
  // returns the new layer's id and the layer appears in the Layers panel and
  // persists with the project, like addGeoJsonLayer does for vector data.
  addTileLayer?: (
    name: string,
    url: string,
    options?: GeoLibreTileLayerOptions,
  ) => string;
  addWmtsLayer?: (
    name: string,
    url: string,
    options?: GeoLibreTileLayerOptions,
  ) => string;
  addWmsLayer?: (name: string, options: GeoLibreWmsLayerOptions) => string;
  // Native client-side COG (reads the GeoTIFF directly; band/rescale/colormap/
  // nodata controls). Resolves with the new layer's id (see "Raster and tile
  // layers" below).
  addCogLayer?: (
    name: string,
    url: string,
    options?: GeoLibreCogLayerOptions,
  ) => Promise<string>;
  getActiveBasemap: () => string;
  onBasemapChange: (callback: (styleUrl: string) => void) => () => void;
  fetchArrayBuffer?: (url: string) => Promise<ArrayBuffer>;
  fitBounds?: (bounds: [number, number, number, number]) => void;
  getMap?: () => import("maplibre-gl").Map | null;
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
  getDeckGL?: () => Promise<GeoLibreDeckGL>;
  // Right-sidebar panels (see "Right sidebar panels" below).
  registerRightPanel?: (panel: GeoLibreRightPanelRegistration) => () => void;
  unregisterRightPanel?: (id: string) => void;
  openRightPanel?: (id: string) => boolean;
  collapseRightPanel?: (id: string) => void;
  closeRightPanel?: (id: string) => void;
  getActiveRightPanel?: () => string | null;
  setActiveRightPanelDock?: (dock: GeoLibreRightPanelDock) => void;
  getActiveRightPanelDock?: () => GeoLibreRightPanelDock | null;
  // Top toolbar menus (see "Toolbar menus" below).
  registerToolbarMenu?: (menu: GeoLibreToolbarMenu) => () => void;
  unregisterToolbarMenu?: (id: string) => void;
  // Floating panels (see "Floating panels" below).
  registerFloatingPanel?: (panel: GeoLibreFloatingPanelRegistration) => () => void;
  unregisterFloatingPanel?: (id: string) => void;
  openFloatingPanel?: (id: string) => boolean;
  closeFloatingPanel?: (id: string) => void;
  getOpenFloatingPanels?: () => string[];
}

export interface GeoLibreToolbarMenu {
  id: string;
  label: string;
  icon?: string; // URL or data: URI
  items: GeoLibreToolbarMenuItem[];
}

export type GeoLibreToolbarMenuItem =
  | { type?: "action"; id: string; label: string; icon?: string; disabled?: boolean; onSelect: () => void }
  | { type: "submenu"; id: string; label: string; icon?: string; items: GeoLibreToolbarMenuItem[] }
  | { type: "separator"; id?: string };

export interface GeoLibreFloatingPanelRegistration {
  id: string;
  // A getter makes the title re-localize live on language changes: it is
  // re-evaluated on every getFloatingPanel() call, so it picks up the current
  // language without re-registering the panel. Caveat: the registry itself
  // does not subscribe to i18n events, so the getter is only re-run when a
  // consumer re-reads the panel. In practice every host component that renders
  // the title also calls useTranslation(), whose languageChanged re-render
  // re-reads the panel as a side effect; a host that reads the title without
  // that subscription would show a stale title after a language switch until
  // the next registry mutation, and must re-read the panel itself on language
  // change. A plain string is frozen at registration time.
  title: string | (() => string);
  icon?: string; // URL or data: URI
  defaultWidth?: number;
  render: (container: HTMLElement) => void | (() => void);
  onOpen?: () => void;
  onClose?: () => void;
}

export type GeoLibreRightPanelDock =
  | "left-of-layers" // left of the Layers panel
  | "right-of-layers" // between the Layers panel and the map
  | "left-of-style" // between the map and the Style panel
  | "right-of-style" // right of the Style panel (default)
  | "replace-style" // share the Style sidebar's single rail (shared-rail mode)
  | "replace-layers"; // share the Layers sidebar's single rail (shared-rail mode)

export interface GeoLibreRightPanelRegistration {
  id: string;
  // A getter makes the title re-localize live on language changes: it is
  // re-evaluated on every getRightPanel() call, so it picks up the current
  // language without re-registering the panel. Caveat: the registry itself
  // does not subscribe to i18n events, so the getter is only re-run when a
  // consumer re-reads the panel. In practice every host component that renders
  // the title also calls useTranslation(), whose languageChanged re-render
  // re-reads the panel as a side effect; a host that reads the title without
  // that subscription would show a stale title after a language switch until
  // the next registry mutation, and must re-read the panel itself on language
  // change. A plain string is frozen at registration time.
  title: string | (() => string);
  /** Initial dock position; "right-of-style" (default). */
  dock?: GeoLibreRightPanelDock;
  /** Optional rail icon: a URL or data: URI rendered as an image. */
  icon?: string;
  /** Preferred expanded width in px (desktop only; host-clamped). */
  defaultWidth?: number;
  /** Fill the panel body with your own DOM. May return a cleanup function. */
  render: (container: HTMLElement) => void | (() => void);
  onOpen?: () => void;
  onCollapse?: () => void;
  onClose?: () => void;
}
```

## Register a plugin

```typescript
import { PluginManager } from "@geolibre/plugins";

const manager = new PluginManager();
manager.register(myPlugin);
manager.activate("my-plugin", appApi);
```

## Built-in plugins

| ID                            | Description                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `osm-basemap`                 | OpenFreeMap Liberty style                                                                                           |
| `carto-light`                 | CARTO Positron GL style                                                                                             |
| `maplibre-gl-basemap-control` | Adds a MapLibre basemap picker                                                                                      |
| `maplibre-gl-components`      | Adds the MapLibre Components control grid and panels for FlatGeobuf, COG, PMTiles, Zarr, LiDAR, and Gaussian splats |
| `maplibre-gl-geo-editor`      | Adds GeoEditor drawing controls                                                                                     |
| `maplibre-gl-geoagent`        | Adds GeoAgent map assistant controls                                                                                |
| `maplibre-gl-lidar`           | Adds LiDAR controls                                                                                                 |
| `maplibre-gl-streetview`      | Adds street view controls                                                                                           |
| `maplibre-gl-swipe`           | Adds map swipe controls                                                                                             |

## Example plugin

```typescript
import type { GeoLibreAppAPI, GeoLibrePlugin } from "@geolibre/plugins";

export const myPlugin: GeoLibrePlugin = {
  id: "my-plugin",
  name: "My Plugin",
  version: "0.1.0",
  activate(app: GeoLibreAppAPI) {
    app.setBasemap("https://example.com/style.json");
  },
  deactivate() {
    // Clean up controls, listeners, and plugin state here.
  },
};
```

Map control plugins can optionally expose `getMapControlPosition()` and `setMapControlPosition()` so the desktop Plugins menu can move the control between map corners. Position-aware plugins should remove and recreate or re-add their control when the position changes.

Plugins with serializable runtime settings can expose `getProjectState()` and `applyProjectState()` so GeoLibre can save and restore those settings in the project file. A wrapper should use these hooks to adapt upstream control APIs such as `getState()` without requiring every upstream package to implement a GeoLibre-specific interface.

Plugins that render with deck.gl should call `app.getDeckGL()` (returns a promise) to obtain GeoLibre's own deck.gl modules — `core`, `layers`, `geoLayers`, `meshLayers`, and `mapbox` (use `mapbox.MapboxOverlay` for interleaved MapLibre rendering). Render on the host's single deck.gl instance rather than bundling a second copy: deck.gl and luma.gl throw on a version mismatch and share global singletons, so a bundled copy fails to render. Call it with optional chaining (`app.getDeckGL?.()`) since a host variant may not ship deck.gl.

Plugins can also declare URL query parameters and handle them when GeoLibre opens. URL parameter handlers run after the map is ready, external plugins are loaded, and project plugin state has been restored. GeoLibre calls handlers for plugins whose declared parameter names are present in the URL, and it suppresses repeated handling of the same URL context for the same plugin. If a matching plugin is registered (installed) but inactive, GeoLibre first attempts to activate it via `PluginManager.activate`; the handler runs only if activation succeeds (an `activate()` that returns `false` or throws leaves the plugin inactive and skips dispatch). Parameter names are case-sensitive, as URL query parameters are: declaring `exampleGeoJson` will not match `?ExampleGeoJson=…`.

```typescript
import type { GeoLibreAppAPI, GeoLibrePlugin } from "@geolibre/plugins";

export const plugin: GeoLibrePlugin = {
  id: "example-url-loader",
  name: "Example URL Loader",
  version: "0.1.0",
  urlParameterNames: ["exampleGeoJson"],
  activate() {
    // Set up controls or plugin state here.
  },
  deactivate() {
    // Clean up controls, listeners, and plugin state here.
  },
  async handleUrlParameters(app: GeoLibreAppAPI, params: URLSearchParams) {
    for (const dataUrl of params.getAll("exampleGeoJson")) {
      // URL parameter values are attacker-controlled: only fetch HTTPS URLs
      // and verify the origin is one you trust before loading. Parsing the
      // value rejects malformed URLs, and the protocol check blocks
      // non-HTTPS schemes (file://, data:, http://); neither protects
      // against SSRF to loopback or private-network addresses.
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(dataUrl);
      } catch {
        continue;
      }
      if (parsedUrl.protocol !== "https:") continue;
      const response = await fetch(parsedUrl.href);
      if (!response.ok) continue;
      app.addGeoJsonLayer("Example URL layer", await response.json(), dataUrl);
    }
  },
};
```

Validate URL parameter values before acting on them. Anyone can craft a link to GeoLibre, so handlers that fetch a parameter value should reject unexpected schemes (`file://`, `data:`, plain `http://`) and only contact origins they trust.

For example:

```text
https://web.geolibre.app/?url=https://example.com/project.geolibre.json&exampleGeoJson=https://example.com/data.geojson
```

A URL parameter activates only an already-registered (installed) plugin that owns it; it never loads a plugin from the URL. For external plugins, include the plugin manifest URL in the project `plugins` state (so the plugin is registered) before relying on its URL handler — the matching parameter then activates and dispatches it even if it is not in the active set.

## Raster and tile layers

`addGeoJsonLayer` registers vector data as a native layer. For raster and tile data there are three matching helpers — `addTileLayer` (XYZ), `addWmtsLayer` (WMTS), and `addWmsLayer` (WMS). Each returns the new layer's id, and the layer appears in the Layers panel with full opacity, reorder, and styling support and persists with the project, so a plugin no longer has to call `getMap().addSource()/addLayer()` directly (which leaves the layer invisible to GeoLibre's layer store).

```typescript
export interface GeoLibreTileLayerOptions {
  tileSize?: number; // default 256
  attribution?: string;
  bounds?: [number, number, number, number]; // [west, south, east, north] in WGS84
  minzoom?: number;
  maxzoom?: number;
  scheme?: "xyz" | "tms"; // default "xyz"
  visible?: boolean; // default true
  opacity?: number; // default 1
  beforeLayerId?: string; // insert beneath this layer
}

export interface GeoLibreWmsLayerOptions extends GeoLibreTileLayerOptions {
  url: string; // WMS GetMap endpoint
  layers: string; // comma-separated layer name(s)
  styles?: string;
  format?: string; // default "image/png"
  transparent?: boolean; // default true
  version?: string; // "1.1.1" (default) or "1.3.0" (sends CRS instead of SRS)
}

export interface GeoLibreCogLayerOptions {
  bands?: string; // "1" (single band) or "1,2,3" (RGB)
  colormap?: string; // named colormap for a single-band COG, e.g. "terrain"
  rescaleMin?: number;
  rescaleMax?: number;
  nodata?: number; // pixel value rendered transparent
  opacity?: number; // default 1
  beforeLayerId?: string;
}
```

```typescript
// XYZ tiles (e.g. an imagery, topo, or DEM hillshade endpoint).
app.addTileLayer?.("LINZ Aerial Imagery", "https://tiles.example.nz/aerial/{z}/{x}/{y}.png", {
  attribution: "Sourced from LINZ. CC BY 4.0",
  maxzoom: 22,
  bounds: [166.0, -47.5, 178.6, -34.0],
});

// WMTS tile URL template.
app.addWmtsLayer?.("LINZ Topo50", "https://tiles.example.nz/topo50/{z}/{x}/{y}.png");

// WMS — pass the request parameters; the host builds the GetMap tile URL.
app.addWmsLayer?.("LINZ Coverage", {
  url: "https://wms.example.nz/wms",
  layers: "coverage",
  transparent: true,
});

// COG — read the GeoTIFF directly (client-side), with raster controls.
const cogId = await app.addCogLayer?.(
  "LINZ DEM",
  "https://cog.example.nz/dem.tif",
  { colormap: "terrain", nodata: -9999 },
);
```

`addTileLayer`/`addWmtsLayer`/`addWmsLayer` expect **pre-rendered tiles** (e.g. a COG already served through a tiler such as titiler as an XYZ endpoint). `addCogLayer` is different: it loads the **GeoTIFF itself** and renders it client-side, exposing band selection, rescale, colormap, and nodata in the raster panel. It is async (it fetches the file's header), so it returns a `Promise<string>` and rejects if the COG cannot be read.

The helpers are typed optional for forward-compatibility with host variants, so call them with optional chaining (`app.addTileLayer?.(...)`).

> **Desktop (Tauri) note:** The desktop app enforces a Content Security Policy that restricts which tile hosts the WebView can reach. If your plugin registers tiles from a host not already in the GeoLibre CSP allowlist, the layer is created but its tiles silently fail to load. For bundled (first-party) plugins, add the host to `connect-src` / `img-src` in `apps/geolibre-desktop/src-tauri/tauri.conf.json`; external plugins can only reach already-permitted hosts. The web build is unaffected.

## Right sidebar panels

A plugin can register a native right-sidebar panel that docks beside the built-in Style panel and behaves like a first-class part of the workspace, instead of emulating one with a fixed overlay. The host renders the panel chrome (a header with collapse and close buttons, a collapsible rail, and a resize handle); the plugin owns only the body.

```typescript
export const myPlugin: GeoLibrePlugin = {
  id: "my-workbench",
  name: "Workbench",
  version: "0.1.0",
  activate(app) {
    // Register once, then open. registerRightPanel returns an unregister fn.
    this._unregister = app.registerRightPanel?.({
      id: "my-workbench",
      title: "Workbench",
      defaultWidth: 360,
      render(container) {
        const button = document.createElement("button");
        button.textContent = "Run analysis";
        container.appendChild(button);
        // Optional cleanup, run when the panel closes or is unregistered.
        return () => button.remove();
      },
      onOpen() {},
      onCollapse() {},
      onClose() {},
    });
    app.openRightPanel?.("my-workbench");
  },
  deactivate(app) {
    app.closeRightPanel?.("my-workbench");
    this._unregister?.();
  },
} as GeoLibrePlugin & { _unregister?: () => void };
```

Notes:

- `render(container)` is called once with an empty element you fill with plain DOM. An external plugin cannot share GeoLibre's React instance, so the contract is DOM, not a React node. The container stays mounted across collapse, so any state in your DOM persists; the returned cleanup runs on close or unregister.
- Only one plugin panel is active at a time. The built-in panel on the side the plugin panel is docked (Layers on the left, Style on the right) collapses to its rail while the plugin panel is expanded next to it, and restores when the plugin panel moves to the other side, collapses to its own rail, or closes.
- `openRightPanel(id)` makes the panel active and expanded (it also expands a collapsed panel); `collapseRightPanel(id)` collapses it to its rail without closing; `closeRightPanel(id)` releases the workspace; `getActiveRightPanel()` returns the active id or `null`.
- The panel is a flex sibling of the map, so opening it shrinks the map view (the map keeps filling the remaining space); no manual map padding is required.
- **Dock position:** a panel docks at one of four positions (left to right): `left-of-layers`, `right-of-layers` (between Layers and the map), `left-of-style` (between the map and Style), or `right-of-style` (the default). Set `dock` on the registration to choose the initial position. The user steps the panel between positions at runtime with the two move buttons in the panel header (disabled at the ends), and a plugin can set it directly with `app.setActiveRightPanelDock?.(...)`. The position resets to the panel's declared `dock` when it closes or another panel opens.
- **Shared-rail modes (`replace-style` / `replace-layers`):** two non-positional docks for workbench-style plugins that want to feel like a first-class sidebar workspace rather than a second rail beside Style (right) or Layers (left). Register with `dock: "replace-style"` (or `"replace-layers"`) and the host shows a single rail on that edge listing both your panel and the built-in panel; selecting one expands it while the other stays as a rail entry. The two are mutually exclusive, so the user never sees two adjacent rails. The built-in panel starts collapsed so the workbench reads as the active workspace, and the user can expand it (which collapses the workbench) at any time. Everything else (chrome, resize, collapse, close, lifecycle hooks) is unchanged.
- **Switching modes at runtime:** the modes are not exclusive choices baked in at registration. In a positional dock the panel header shows a **merge** button that joins the shared rail on its current side — a layers-side panel (`left-of-layers`/`right-of-layers`) joins the Layers rail, a style-side panel the Style rail. In a shared rail it shows a **detach** button that pops the panel back out to a movable positional panel on the same side (`right-of-layers` / `right-of-style`), where the left/right move buttons return. A plugin can drive the same switch with `app.setActiveRightPanelDock?.("replace-style" | "replace-layers" | "right-of-style" | ...)`. The shared rails are not part of the left/right *step* sequence (the arrows only walk the four positional docks); merge/detach is the way in and out.
- These methods are typed optional for forward-compatibility with host variants that have no right sidebar, so call them with optional chaining (`app.registerRightPanel?.(...)`).

## Toolbar menus

A plugin can add its own top-level menu button to the GeoLibre banner (beside Project / Edit / View / Plugins), with nested submenus and action items. Register the menu in `activate` and unregister it in `deactivate`:

```typescript
const unregister = app.registerToolbarMenu?.({
  id: "my-plugin-menu",
  label: "Workbench",
  items: [
    { id: "open", label: "Open workbench", onSelect: () => app.openRightPanel?.("my-workbench") },
    {
      type: "submenu",
      id: "tools",
      label: "Tools",
      items: [
        { id: "qa", label: "Data QA", onSelect: () => app.openFloatingPanel?.("my-qa") },
      ],
    },
    { type: "separator" },
    { id: "about", label: "About", disabled: false, onSelect: () => {} },
  ],
});
```

Each item is an **action** (`onSelect`, the default when `type` is omitted), a **submenu** (nested `items`), or a **separator**. Items typically open a right panel or a floating panel, but `onSelect` can run anything. Re-registering the same `id` replaces the menu, so you can rebuild it as your plugin's state changes.

Menus from **external plugins** (loaded from a zip, a manifest URL, or a bundled drop-in) render at the end of the banner, after the Help menu, so third-party menus sit together past the built-in menus. Menus from built-in plugins render beside the built-in menus. The host decides placement from the menu's owning plugin, so you do not need to do anything special.

## Floating panels

A floating panel is a draggable, closeable card the host overlays on the map's top-left corner. Unlike a dockable right panel (one active panel docked at a fixed position), several floating panels can be open at once and they do not shrink the map. The render contract is the same plain-DOM `render(container)` as right panels.

```typescript
const unregister = app.registerFloatingPanel?.({
  id: "my-qa",
  title: "Data QA",
  defaultWidth: 300,
  render(container) {
    container.textContent = "Rendered by the plugin via registerFloatingPanel().";
    return () => {
      // optional cleanup, run on close/unregister
    };
  },
});

app.openFloatingPanel?.("my-qa");   // open (or bring to front)
app.closeFloatingPanel?.("my-qa");  // close
app.getOpenFloatingPanels?.();      // -> string[] of open ids, stacking order
```

Use a right panel for a primary, persistent workspace and a floating panel for an ancillary tool or dashboard the user positions over the map. As with the other surfaces, call these methods with optional chaining since they are typed optional.

## External plugins

Use the [GeoLibre plugin template](https://github.com/opengeos/geolibre-plugin-template) as the recommended starting point for external plugin development. The template includes a MapLibre control wrapper, a `plugin.json` manifest, a GeoLibre plugin entry point, and a `package:geolibre` script that builds the zip layout GeoLibre Desktop expects.

GeoLibre Desktop loads external plugins from the app data `plugins/` directory at startup. External plugins are trusted code and can be installed as:

- A `.zip` file with a root `plugin.json`.
- An unpacked directory with a root `plugin.json`.
- A HTTPS `plugin.json` manifest URL.

The fastest way to install a `.zip` is **Manage Plugins > Settings > Install from file**: pick a packaged plugin archive and GeoLibre validates it (parsing `plugin.json`, enforcing the manifest rules, and checking the entry/style are present and within the size limit) before installing it. The plugin loads immediately and persists; reinstalling the same id replaces the previous copy and reloads the updated version. Persistence differs by build:

- **Desktop** copies the archive into the app data `plugins/` directory as `<plugin-id>.zip`, where the startup scan re-loads it.
- **Web** unpacks the archive in the browser and stores the bundle in IndexedDB, replaying it on the next visit. Web-installed plugins are listed under **Install from file** with an uninstall control (the desktop copies live on disk and are managed there).

The Plugins settings section can also add local development directories outside the app data folder. Each configured directory can contain plugin zips, unpacked plugin bundle folders, or be a single unpacked plugin bundle itself. Configured development directories are scanned before the app data `plugins/` directory, so a development copy can override an installed external plugin with the same ID. Built-in plugins still take precedence over all external plugins.

For the web app, use manifest URLs or **Install from file** (above). Manifest URLs: GeoLibre fetches the manifest, resolves `entry` and `style` relative to the manifest URL, then loads the bundled ESM entry. Browser loading requires HTTPS except for `localhost` and depends on the host allowing CORS. Install-from-file unpacks the uploaded zip in the browser (no network or CORS) and persists it in IndexedDB. Both paths execute the bundled ESM entry the same way (a `blob:` `import()`, allowed by the web build's `script-src`), so external plugins remain trusted code regardless of how they were installed.

### Bundled plugins (baked into the build)

To ship an external plugin as part of GeoLibre — loaded automatically, with no Settings entry and no manifest URL — drop its built bundle into the Vite public directory, one folder per plugin id:

```text
apps/geolibre-desktop/public/plugins/example-plugin/
  plugin.json
  dist/index.js
  dist/style.css
```

This is the **same content a manifest URL would serve**. A drop-in is all that is required — no source edits per plugin. The `bundledPlugins()` Vite plugin (`apps/geolibre-desktop/vite-plugins/bundled-plugins.ts`) scans `public/plugins/` at build and dev-server start, exposes the discovered manifest paths through the `virtual:bundled-plugins` module, and `usePlugins.ts` loads them through the normal external-plugin path (fetch → blob import → register). Discovery happens at build time, so restart the dev server or rebuild after adding, updating, or removing a plugin folder.

The same folder serves **both** the web and desktop builds: the desktop app bundles the identical frontend (`frontendDist` in `tauri.conf.json`) and serves it from `tauri://localhost`, which is same-origin and allowed by the desktop CSP (`connect-src 'self'`, `script-src ... blob:`). Bundled manifest URLs are injected at load time rather than stored in Settings, so a baked-in plugin always loads and cannot be removed by a user; they are deduplicated by plugin id against any user/project plugin of the same id.

Private plugins should be git-ignored under `public/plugins/` (see that folder's `.gitignore`) and copied in at build/deploy time (for example in CI before `npm run build`, or by a plugin repo's own install script) so their code stays out of GeoLibre's history. The discovery code is generic and committed; only the plugin payload is excluded.

A bundled drop-in's `plugin.json` may additionally set `"activeByDefault": true` to activate the plugin on startup, so its control appears without a trip to the Plugins menu. Saved plugin state still wins: a loaded project (or the user's persisted plugin state) that carries `activePluginIds` overrides the default. The flag is honored **only** for bundled drop-ins, since a deployer who bakes a plugin into the build is trusted like a built-in author; it is silently ignored on manifests installed at runtime from URLs or zips.

If instead you want a plugin compiled into the main JS bundle (no `plugin.json`, no fetch), register it as a built-in plugin (see "Add a plugin" in the repository README).

```json
{
  "id": "example-plugin",
  "name": "Example Plugin",
  "version": "0.1.0",
  "entry": "dist/index.js",
  "description": "Optional short description",
  "style": "dist/style.css"
}
```

The `entry` file must export a `GeoLibrePlugin` as either the default export or a named `plugin` export. The exported plugin `id`, `name`, and `version` must match `plugin.json`. The entry must be a self-contained `.js` or `.mjs` bundle because relative module imports inside the zip are not resolved by this first loader.

External plugin entries are executed with `import(URL.createObjectURL(...))`, which is why the desktop CSP in `tauri.conf.json` includes `blob:` in `script-src`. Removing `blob:` from `script-src` breaks external plugin loading. Combined with `'unsafe-eval'`, this means code that can create a blob URL can execute scripts, which is acceptable because external plugins are trusted local files installed by the user.

Because plugins run as trusted code in the host document, they can read `window.__GEOLIBRE_RUNTIME_ENV__`, the runtime environment map. On the desktop app this map includes the AI Assistant's [OS-environment keys](user-guide/ai-assistant.md#reading-keys-from-your-system-environment-desktop) (the allowlisted provider variables read from the user's shell), not only the values typed into Settings → Environment Variables. Treat any credential reachable through the app's environment as visible to installed plugins, and only install plugins you trust.

Manifest paths must be relative zip paths with forward slashes, no leading slash, no backslashes, and no `..` segments. External plugins cannot set `activeByDefault` on the exported plugin object, and the manifest-level flag is honored only for bundled drop-ins (see "Bundled plugins" above); saved project state can still reactivate an external plugin by ID after the zip is loaded.

The optional `style` CSS is injected globally into the host document, not scoped to the plugin. Plugin authors are responsible for scoping their selectors (for example with a plugin-specific class prefix) so broad rules do not restyle the rest of the app. Injected CSS can also issue network requests through `url()` references and `@import`, so a plugin stylesheet can load external fonts, images, or additional sheets; treat plugin CSS with the same trust expectations as plugin code.

When using the template, update `geolibre-plugin/plugin.json` and `src/geolibre.ts` together so `id`, `name`, and `version` stay in sync. Run `npm run package:geolibre`, then either copy the generated zip into the desktop app data `plugins/` directory, add the template's `geolibre-plugin/` directory in Settings > Plugins for local development, or host the `geolibre-plugin/` directory and add its `plugin.json` URL.

### Plugin marketplace

The Settings menu's **Manage Plugins** entry opens a standalone dialog (modeled on QGIS's plugin manager) with **All**, **Installed**, **Not installed**, **Upgradeable**, and **Settings** sections. The first four list curated registry plugins so users can install, update, and uninstall them without hand-entering manifest URLs; the Settings section installs a plugin from a local `.zip` and manages additional local plugin directories and manual manifest URLs. Actions apply immediately (install/uninstall/update are live; uninstall asks for confirmation). It is a thin layer over the manifest-URL loader above: installing an entry records its manifest URL in the plugin manifest URL list, and the existing loader fetches and registers it. It introduces no new trust path.

The registry is JSON, fetched from `VITE_GEOLIBRE_PLUGIN_REGISTRY_URL` or, by default, the hosted registry at `https://plugins.geolibre.app/plugin-registry.json` (the [opengeos/geolibre-plugins](https://github.com/opengeos/geolibre-plugins) repo, published to GitHub Pages with CORS enabled). It is an array, or an object with a `plugins` array, of entries:

```json
{
  "version": 1,
  "plugins": [
    {
      "id": "example-plugin",
      "name": "Example Plugin",
      "version": "1.0.0",
      "description": "Optional short description",
      "author": "Example Author",
      "homepage": "https://github.com/example/example-plugin",
      "manifestUrl": "https://example.com/example-plugin/plugin.json",
      "categories": ["Example"],
      "minGeoLibreVersion": "1.0.0"
    }
  ]
}
```

`id`, `name`, `version`, and `manifestUrl` are required; the rest are optional. A relative `manifestUrl` is resolved against the registry location, so a plugin hosted alongside the registry (e.g. `sample/plugin.json`) can be listed with a relative path. `minGeoLibreVersion` gates installation against the running app version. Curate the registry and host plugin bundles in the [opengeos/geolibre-plugins](https://github.com/opengeos/geolibre-plugins) repo, which ships a `sample/` template.

Uninstalling prompts for confirmation, then unregisters the plugin at runtime (deactivating any active map control) so the Plugins menu updates without a reload. When a registry entry advertises a newer `version` than the loaded plugin, the marketplace shows an Update action that re-fetches the manifest URL and re-registers the published version in place; the new version is fetched and validated before the old one is removed, so a failed update leaves the installed plugin intact.
