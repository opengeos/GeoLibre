# GeoLibre Plugin API

## Interface

```typescript
import type { Feature, FeatureCollection, Geometry } from "geojson";
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
  /** Plugins in the same group cannot be active at the same time. */
  exclusiveGroup?: string;
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

export interface GeoLibreLayerSummary {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  opacity: number;
}

export interface GeoLibreSelection {
  layerId: string | null;
  features: Feature<Geometry | null>[];
}

export interface GeoLibreAppAPI {
  setBasemap: (styleUrl: string) => void;
  addGeoJsonLayer: (
    name: string,
    data: FeatureCollection,
    sourcePath?: string,
  ) => string;
  listLayers?: () => GeoLibreLayerSummary[];
  getLayerFeatures?: (layerId: string) => Feature<Geometry | null>[];
  getSelectedFeatures?: () => Feature<Geometry | null>[];
  getSelectedLayerId?: () => string | null;
  getDrawnFeatures?: () => Feature<Geometry | null>[];
  onSelectionChange?: (
    callback: (selection: GeoLibreSelection) => void,
  ) => () => void;
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
  // Zarr through the host's own @carbonplan/zarr-layer instance, with
  // crs/proj4 reprojection (see "Zarr layers" below).
  addZarrLayer?: (
    name: string,
    url: string,
    options: GeoLibreZarrLayerOptions,
  ) => Promise<string>;
  setZarrLayerSelector?: (
    layerId: string,
    selector: Record<string, number | string>,
  ) => Promise<boolean>;
  // Click-to-value / region statistics on a Zarr layer (see "Zarr layers").
  queryZarrLayer?: (
    layerId: string,
    geometry: GeoLibreZarrQueryGeometry,
    selector?: GeoLibreZarrQuerySelector,
    options?: GeoLibreZarrQueryOptions,
  ) => Promise<GeoLibreZarrQueryResult | null>;
  // Register a layer the plugin added to the map itself, so it appears in the
  // Layers panel (see "Custom (WebGL) layers and paint ownership" below).
  registerExternalNativeLayer?: (
    layer: GeoLibreExternalNativeLayerRegistration,
  ) => void;
  unregisterExternalNativeLayer?: (id: string) => void;
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
  // Note: showing the "terrain" control (visible: true) also switches 3D
  // terrain on, mirroring the Controls menu so the user doesn't have to click
  // the control button as a second step. Hiding it turns terrain back off.
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
  // Localization (see "Following the app language" below).
  getLocale?: () => string;
  onLocaleChange?: (listener: (locale: string) => void) => () => void;
  translate?: (
    key: string,
    defaultValue: string,
    params?: Record<string, string | number>,
  ) => string;
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
  | "right-of-style" // right of the Style panel
  | "replace-style" // share the Style sidebar's single rail (shared-rail mode, default)
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
  /** Initial dock position; "replace-style" (default). */
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

## Add a built-in plugin (in this repository)

Built-in plugins ship with GeoLibre itself. Most plugins do **not** need to be
built in — see [External plugins](#external-plugins) to ship one without forking
GeoLibre. To add one to this repository:

1. Create a plugin file in `packages/plugins/src/plugins/`.

   ```typescript
   import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";

   export const myPlugin: GeoLibrePlugin = {
     id: "my-plugin",
     name: "My Plugin",
     version: "0.1.0",
     activate: (app: GeoLibreAppAPI) => {
       app.setBasemap("https://example.com/style.json");
     },
     deactivate: () => {
       /* basemap remains until the user changes it */
     },
   };
   ```

   Basemap plugins deliberately leave the style they applied in place on
   deactivate — the built-in `osm-basemap` and `carto-light` plugins do the
   same, since reverting the map under the user would be more surprising than
   keeping what they last selected. Plugins that add controls, listeners, or
   layers must undo them in `deactivate()`.

2. Export it from `packages/plugins/src/index.ts`.

   ```typescript
   export { myPlugin } from "./plugins/my-plugin";
   ```

3. Register it in `apps/geolibre-desktop/src/hooks/usePlugins.ts`.

   ```typescript
   import { myPlugin } from "@geolibre/plugins";

   manager.registerAll([
     maplibreLayerControlPlugin,
     maplibreGeoAgentPlugin,
     maplibreGeoEditorPlugin,
     myPlugin,
   ]);
   ```

For a MapLibre control plugin, add the package dependency, then call
`app.addMapControl(control, "top-left")` in `activate()` and
`app.removeMapControl(control)` in `deactivate()`. If the control's npm package
ships its own stylesheet, import that stylesheet in
`apps/geolibre-desktop/src/main.tsx`, alongside the existing
`maplibre-gl-*/style.css` imports. That is only for a dependency's own CSS —
any app-specific fixes on top of it belong in `index.css`, as described under
[Styling third-party controls](#styling-third-party-controls) below.

Built-in MapLibre controls such as Navigation, Fullscreen, Geolocate, Globe,
Terrain, Scale, Attribution, and Logo are toggled from the desktop app's
Controls menu, which also opens Search, a standalone place search panel backed
by the Components plugin. Keep project-specific controls such as Layer Control
and Components in the Plugins menu when they use the plugin API or need plugin
lifecycle behavior.

The Components plugin wraps `maplibre-gl-components` controls and wires their
layer events into the GeoLibre store. It provides Add Data shortcuts for
FlatGeobuf, PMTiles, Zarr, LiDAR, and Gaussian splats, while raster COG and
GeoTIFF layers can also be added through the standard Add Raster Layer dialog.

### Styling third-party controls

If a third-party MapLibre control needs app-specific styling fixes, add scoped
overrides in `apps/geolibre-desktop/src/index.css` instead of editing files in
`node_modules`. Keep selectors limited to the plugin's control class. For
example, GeoEditor toolbar buttons need a local override because MapLibre's
default control button CSS can override their flex centering:

```css
.geo-editor-control .geo-editor-tool-button {
  align-items: center;
  display: flex !important;
  justify-content: center;
  line-height: 0;
  padding: 0;
}

.geo-editor-control .geo-editor-tool-button svg {
  display: block;
  flex: 0 0 auto;
  margin: 0;
}
```

Run `npm run build` and `pre-commit run --all-files` before submitting the
change. If you also touched pages under `docs/`, build the site — CI runs
`zensical build --strict`, so a broken link or a page missing from the
`mkdocs.yml` `nav` fails the build. See
[Contributing](contributing.md#documentation) for both gates in full.

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

## Read-only layer and feature queries

External plugins can inspect the current layer list, a layer's GeoJSON features,
the current feature selection, and features in GeoEditor's Sketches layers. The
methods are optional so the same plugin remains compatible with older hosts.

```typescript
const layers = app.listLayers?.() ?? [];
const selectedLayerId = app.getSelectedLayerId?.() ?? null;
const selectedFeatures = app.getSelectedFeatures?.() ?? [];

if (selectedLayerId && app.getLayerFeatures) {
  const layerFeatures = app.getLayerFeatures(selectedLayerId);
  console.log(layers, layerFeatures, selectedFeatures);
}

const drawnFeatures = app.getDrawnFeatures?.() ?? [];
```

`getSelectedFeatures` returns every selected feature in the selected layer, not
only the most recently selected feature. Features without a GeoJSON `id` are
matched using their zero-based array index converted to a string. An empty
selection returns an empty array. `getLayerFeatures` throws when the layer id is
unknown and returns an empty array for a layer that has no GeoJSON features.

Selection subscriptions fire after the selected layer or selected feature-id
array changes. Keep and call the returned unsubscribe function during plugin
deactivation:

```typescript
const unsubscribe = app.onSelectionChange?.(({ layerId, features }) => {
  console.log(layerId, features);
});

// In deactivate or another cleanup path:
unsubscribe?.();
```

These methods are a read-only query surface: calling them does not change the
GeoLibre store. Plugins must also treat returned GeoJSON features as read-only
and use host APIs such as `addGeoJsonLayer` when they need to add data.

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

`options.engine` picks the renderer (`"maplibre-gl-raster"` for the GPU/deck.gl path, `"cog-tiler-wasm"` for the WebAssembly tiler, `"titiler"` for a TiTiler server). Unlike the other options it is **not per layer**: the raster control holds one engine for every raster it manages, so naming one re-renders the rasters already on the map. Pass `"auto"` to leave whatever the control is on alone; omit it and the GPU renderer is used. The GPU renderer requires a Mercator projection, so a plugin that expects to work on the globe should ask for `"cog-tiler-wasm"`.

`addTileLayer`/`addWmtsLayer`/`addWmsLayer` expect **pre-rendered tiles** (e.g. a COG already served through a tiler such as titiler as an XYZ endpoint). `addCogLayer` is different: it loads the **GeoTIFF itself** and renders it client-side, exposing band selection, rescale, colormap, and nodata in the raster panel. It is async (it fetches the file's header), so it returns a `Promise<string>` and rejects if the COG cannot be read.

The helpers are typed optional for forward-compatibility with host variants, so call them with optional chaining (`app.addTileLayer?.(...)`).

> **Desktop (Tauri) note:** The desktop app enforces a Content Security Policy that restricts which tile hosts the WebView can reach. If your plugin registers tiles from a host not already in the GeoLibre CSP allowlist, the layer is created but its tiles silently fail to load. For bundled (first-party) plugins, add the host to `connect-src` / `img-src` in `apps/geolibre-desktop/src-tauri/tauri.conf.json`; external plugins can only reach already-permitted hosts. The web build is unaffected.

## Zarr layers

`addZarrLayer` renders a Zarr store (Zarr v2/v3 over HTTP) through **GeoLibre's own** `@carbonplan/zarr-layer` instance and mirrors the result into the Layers panel. It is the Zarr counterpart of `addCogLayer`. Stores that are not read from a URL — a kerchunk-backed cloud NetCDF, an Icechunk repository, a folder on disk — reach the same renderer through an internal `store` option that this API does not expose, so they are added by GeoLibre's own panels rather than by a plugin.

Do not bundle `@carbonplan/zarr-layer` in a plugin: a second copy ships a duplicate numcodecs WASM payload, and adding the renderer's layer yourself with `getMap().addLayer()` produces a MapLibre **custom** layer, which has no paint properties for the Style panel to drive.

```typescript
export interface GeoLibreZarrLayerOptions {
  variable: string;                            // array to render (required)
  selector?: Record<string, number | string>;  // non-spatial dims, e.g. { time: 0 }
  clim?: [number, number];
  colormap?: string | string[];                // named ramp ("viridis") or hex stops
  opacity?: number;
  zarrVersion?: 2 | 3;
  crs?: string;                                // e.g. "EPSG:32633"
  proj4?: string;                              // for a CRS with no built-in
  bounds?: [number, number, number, number];   // [xMin, yMin, xMax, yMax] in the store's CRS
  spatialDimensions?: { lat?: string; lon?: string };
  headers?: Record<string, string>;            // authenticated stores
  beforeLayerId?: string;
}
```

```typescript
// A projected national grid: crs/proj4 are forwarded to the renderer, which
// reprojects on the GPU. Without them the store is read as WGS84 and lands in
// the wrong place.
const layerId = await app.addZarrLayer?.(
  "seNorge tmax",
  "https://example.no/senorge.zarr",
  {
    variable: "tmax",
    selector: { time: 0 },
    clim: [-30, 30],
    colormap: "viridis",
    crs: "EPSG:32633",
  },
);

// Drive a time slider without rebuilding the layer: the renderer keeps the
// chunks it already fetched. (`addZarrLayer` is optional, so guard the id.)
if (layerId) {
  await app.setZarrLayerSelector?.(layerId, { time: 12 });
}
```

`addZarrLayer` is headless: it does not open the Zarr panel (the user can still open it from **Add Data → Zarr Layer** to tweak colormap and color limits). It resolves with the new layer's id once the layer is registered, and rejects when `variable` is missing or the store cannot be read. The layer supports visibility, opacity, ordering, and removal from the Layers panel like any other layer.

`selector` picks a slice by coordinate **value**, not by index: on a `month` axis of 1-12, December is `{ month: 12 }`. The panel's Selector (JSON) field means the same thing, and editing it now re-slices the layers already on the map.

### Click-to-value and region statistics

`queryZarrLayer` reads the layer's values under a GeoJSON geometry: a `Point` for Identify, a `Polygon` / `MultiPolygon` for zonal statistics. It is the read counterpart of `setZarrLayerSelector`, reaching the same live renderer by layer id.

```typescript
export type GeoLibreZarrQueryGeometry =
  | { type: "Point"; coordinates: [number, number] }        // WGS84 lng/lat
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

// Dimension values to read instead of the slice on screen. A list per dimension
// (e.g. { month: [1, 7] }) nests the returned values by that dimension.
export type GeoLibreZarrQuerySelector = Record<
  string,
  number | string | number[] | string[] | { selected: number | string | number[] | string[]; type?: "index" | "value" }
>;

export interface GeoLibreZarrQueryOptions {
  signal?: AbortSignal;                    // cancel a query the user moved past
  includeSpatialCoordinates?: boolean;     // default true
}

// { [variable]: values, dimensions, coordinates }
export interface GeoLibreZarrQueryResult {
  [variable: string]: unknown;
  dimensions: string[];
  coordinates: { [key: string]: (number | string)[] };
}
```

```typescript
// Identify: read the value under a map click, for the slice on screen.
map.on("click", async (event) => {
  const { lng, lat } = event.lngLat;
  const result = await app.queryZarrLayer?.(layerId, {
    type: "Point",
    coordinates: [lng, lat],
  });
  const [value] = (result?.sst as number[]) ?? [];
  showReadout(value); // undefined outside the store's grid
});

// Zonal statistics: every pixel inside a polygon, on another time slice.
const region = await app.queryZarrLayer?.(layerId, aoi.geometry, { time: 12 });
```

The renderer already holds the store's grid, so it does the reprojection and fill-value masking: pass a WGS84 `[lng, lat]` straight from a map click rather than opening the store again with your own zarrita point read. Note the returned `coordinates` are in the store's **source** CRS (Web Mercator meters for EPSG:3857, degrees for EPSG:4326, source units for a custom-proj4 dataset), not WGS84.

Values come back **empty** rather than as an error for a geometry outside the store's grid, and for a layer whose first chunks have not loaded yet, so a query fired immediately after `addZarrLayer` resolves can be empty even though the id is live. `queryZarrLayer` itself resolves to `null` when no live Zarr layer has that id, and an aborted query **rejects** (an abort error), so guard the call if you cancel on every new click.

A `selector` passed here only scopes the read: the layer keeps rendering the slice it was on, so an Identify readout for another time does not disturb the map. Use `setZarrLayerSelector` when you do want the display to move.

The panel can also open a store from a folder on disk, via a **Browse folder** button next to the Zarr URL. It appears in the desktop app and in browsers with the File System Access API (Chromium), since reading a folder needs a filesystem API the plugin cannot supply; elsewhere the panel is unchanged. A local cube binds to the Time Slider like a remote one — its CF `units` are read out of the folder, because its recorded URL is an identifier rather than an address.

## Driving a layer's own time dimension from the Time Slider

The Time Slider understands three kinds of temporal layer. Two are built in: a **vector** layer filtered by a timestamp property, and a **raster time series** of dated sources the dock steps between. The third is for a layer that is *one store* with time as an **internal dimension** — a Zarr data cube, or a plugin's own frame-based layer — where the timeline picks a slice rather than a source.

That third kind is expressed as a **temporal adapter**:

```typescript
export interface TemporalLayerAdapter {
  getTimeValues: () => ReadonlyArray<Date | number | string>;  // the time coordinate, in index order
  setTime: (date: Date) => void | Promise<void>;               // apply a date to the layer
  dimension?: string;                                          // the axis name, default "time"
}
```

The slider owns the snapping: it reads `getTimeValues()`, finds the index nearest the current date, and calls `setTime()` with **that slice's own date**, skipping a tick that lands on the slice already showing. So a daily cube under a month-stepping timeline costs one chunk fetch per changed index, not one per tick. Calls are throttled while the handle is dragged, with the trailing edge always applied. Accepted value forms are `Date`s, epoch seconds/milliseconds, bare calendar years, and date strings.

A Zarr layer added with `addZarrLayer` **registers its own adapter** for its `time` axis (decoding CF `units` such as `"days since 1970-01-01"` from the store's metadata), so it needs no call here. Use `registerTemporalLayer` for a custom layer you render yourself:

```typescript
const times = frames.map((frame) => frame.timestamp); // Date[] | number[] | string[]

const detach = app.registerTemporalLayer?.(
  layerId,
  {
    dimension: "time",
    getTimeValues: () => times,
    setTime: (date) => showFrame(nearestFrame(date)),
  },
  { bind: true },
);
```

Registering makes the layer **bindable**: the Layers panel's row menu gains "Bind time dimension to Time Slider". Passing `{ bind: true }` binds it immediately and opens the dock, which is usually what a plugin that just loaded a cube wants. The binding is persisted on `layer.metadata.timeBinding` (as `{ kind: "selector", dimension, min, max, granularity }`) so it survives a project round-trip; the time values themselves are not persisted, because they belong to the data store — re-register the adapter when the layer is recreated and the timeline picks it back up.

Call the returned function, or `app.unregisterTemporalLayer?.(layerId)`, to drop the adapter. Removing the layer does it too.

A bound cube shares the timeline with any vector bindings and dated overlays: the track spans the union of their extents, and the widest dataset sets the stepping granularity.

**Closing the dock again.** A dock that a binding opened closes itself once the last temporal layer is gone, so it never lingers over a map with no timeline. Removing the bound layer is enough; if your plugin keeps the layer and only drops its binding, clear `layer.metadata.timeBinding` as well as unregistering the adapter. A dock the *user* opened from the Plugins menu is left alone, and so is one that still has raster sources of its own or a KML `<TimeSpan>` overlay to drive.

## Activating and deactivating other plugins

```typescript
await app.activatePlugin?.("maplibre-gl-time-slider");
app.deactivatePlugin?.("maplibre-gl-time-slider");
```

`activatePlugin` takes an optional second argument, a project-state patch applied once the target is active; it resolves false when the plugin is unavailable, refuses to activate, or rejects the state. `deactivatePlugin` is its counterpart and returns true when the plugin ended up inactive.

Neither may target the **calling** plugin: `activatePlugin` on yourself is meaningless, and deactivating yourself would unmount the code still on the stack. Both return false in that case.

## Custom (WebGL) layers and paint ownership

`registerExternalNativeLayer` mirrors a layer the plugin added to the map itself into GeoLibre's layer store, so it appears in the Layers panel and persists with the project:

```typescript
export interface GeoLibreExternalNativeLayerRegistration {
  id: string;
  name: string;
  type?: GeoLibreLayer["type"];        // closest built-in type, e.g. "raster"
  nativeLayerIds: string[];            // the MapLibre layer id(s) you added
  source?: Record<string, unknown>;
  sourceIds?: string[];
  sourceId?: string;
  geojson?: FeatureCollection;         // for vector layers
  beforeId?: string;
  opacity?: number;
  style?: Partial<LayerStyle>;
  metadata?: Record<string, unknown>;
  sourcePath?: string;
  paintMode?: "geolibre" | "plugin";   // see below
  paintBridge?: {                      // see below
    setOpacity?: (opacity: number) => void;
    setVisibility?: (visible: boolean) => void;
  };
}
```

A plugin that renders with its own MapLibre `CustomLayerInterface` — a WebGL layer that draws its own pixels — registers it the same way:

```typescript
const layer = new MyWebGLLayer({ id: "my-layer" });
app.getMap?.()?.addLayer(layer);

app.registerExternalNativeLayer?.({
  id: "my-layer",
  name: "My WebGL layer",
  type: "raster",
  nativeLayerIds: ["my-layer"],
  // The layer has no MapLibre paint properties, so GeoLibre must not offer
  // paint editors that cannot reach it.
  paintMode: "plugin",
  // Optional: keep the Opacity sliders live by forwarding them to the layer.
  paintBridge: {
    setOpacity: (opacity) => layer.setOpacity(opacity),
    setVisibility: (visible) => layer.setActive(visible),
  },
});
```

- `paintMode: "plugin"` tells the Style panel that the plugin paints the layer. It then shows only the controls that actually apply — insert-below, zoom range, and (with a bridge) opacity — instead of raster brightness/saturation/contrast/hue sliders that silently do nothing. Visibility, reordering, and removal keep working from the Layers panel; MapLibre honors `visibility` and the zoom range on a custom layer.
- `paintBridge` supplies the setters GeoLibre calls when the user changes opacity or visibility. Supplying `setOpacity` keeps the Opacity slider in both the Layers and Style panels; omitting it hides the slider rather than leaving an inert one. Supplying a bridge implies `paintMode: "plugin"`.
- The setters are called only when the value changes, not on every layer sync, and they are held outside the layer record (functions cannot be serialized into a project file). Re-register the layer after a project reload to restore the bridge, and call `unregisterExternalNativeLayer(id)` from `deactivate`.

For Zarr specifically, prefer `addZarrLayer` above: the host's renderer already integrates with the panels, so no custom layer or bridge is needed.

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

Every `label` (the menu button's, a submenu trigger's, an action's) accepts a **getter function** as well as a plain string, the same way panel titles do:

```typescript
app.registerToolbarMenu?.({
  id: "my-plugin-menu",
  label: () => app.translate?.("plugin.my-plugin.menu", "Workbench") ?? "Workbench",
  items: [
    {
      id: "open",
      label: () => app.translate?.("plugin.my-plugin.open", "Open workbench") ?? "Open workbench",
      onSelect: () => app.openRightPanel?.("my-workbench"),
    },
  ],
});
```

The host re-reads every label each time it renders the menu tree, and it re-renders on a language change, so a getter follows the app language without your plugin re-registering its menu. A plain string is frozen at registration time. A getter that throws or returns nothing usable degrades to the item's id path and warns once, so a broken label cannot make the menu disappear.

## Following the app language

The GeoLibre UI is translated with react-i18next, but a plugin renders its panels as plain DOM and cannot use the host's React hooks. Three methods bridge that gap:

```typescript
// The active catalog code ("en", "zh", "pt-BR", ...).
const locale = app.getLocale?.() ?? "en";

// Resolve a key, falling back to your own English text when no catalog has it.
const title = app.translate?.("plugin.my-plugin.title", "Workbench") ?? "Workbench";
const label = app.translate?.("plugin.my-plugin.count", "{{n}} features", { n: 3 });

// Re-render when the user switches language. Returns an unsubscribe function —
// call it from `deactivate`, or the listener keeps re-rendering DOM you no
// longer own.
const stop = app.onLocaleChange?.((next) => renderPanel(container, next));
```

Conventions:

- **Always pass your own English text as `defaultValue`.** GeoLibre's catalogs do not ship your plugin's strings, so the fallback is what makes your UI read correctly today; translations are an upgrade, not a prerequisite.
- **Namespace your keys by plugin id** (`plugin.<your-id>.<something>`) so they cannot collide with the host's own keys.
- These methods are typed optional like the rest of the API, so call them with optional chaining and keep a literal fallback.
- Panel titles and toolbar labels take getters precisely so they can call `app.translate?.()` and stay current; use those rather than re-registering on every language change.

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

Plugin project settings are treated as sensitive at the project egress
boundary. GeoLibre keeps them in a trusted local save only when the user
explicitly chooses to retain credentials, and removes the entire
`plugins.settings` object from shares, standalone HTML exports, embed
snapshots, and collaboration snapshots. Store portable, non-secret identifiers
such as broker references in layer source or metadata instead when recipients
need them.

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
