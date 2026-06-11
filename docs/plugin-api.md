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
  ) => void;
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
| `sample-geojson`              | Loads `sample-data/sample.geojson`                                                                                  |
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
https://viewer.geolibre.app/?url=https://example.com/project.geolibre.json&exampleGeoJson=https://example.com/data.geojson
```

A URL parameter activates only an already-registered (installed) plugin that owns it; it never loads a plugin from the URL. For external plugins, include the plugin manifest URL in the project `plugins` state (so the plugin is registered) before relying on its URL handler — the matching parameter then activates and dispatches it even if it is not in the active set.

## External plugins

Use the [GeoLibre plugin template](https://github.com/opengeos/geolibre-plugin-template) as the recommended starting point for external plugin development. The template includes a MapLibre control wrapper, a `plugin.json` manifest, a GeoLibre plugin entry point, and a `package:geolibre` script that builds the zip layout GeoLibre Desktop expects.

GeoLibre Desktop loads external plugins from the app data `plugins/` directory at startup. External plugins are trusted code and can be installed as:

- A `.zip` file with a root `plugin.json`.
- An unpacked directory with a root `plugin.json`.
- A HTTPS `plugin.json` manifest URL.

The Plugins settings section can also add local development directories outside the app data folder. Each configured directory can contain plugin zips, unpacked plugin bundle folders, or be a single unpacked plugin bundle itself. Configured development directories are scanned before the app data `plugins/` directory, so a development copy can override an installed external plugin with the same ID. Built-in plugins still take precedence over all external plugins.

For the web app, use manifest URLs. GeoLibre fetches the manifest, resolves `entry` and `style` relative to the manifest URL, then loads the bundled ESM entry. Browser loading requires HTTPS except for `localhost` and depends on the host allowing CORS.

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

Manifest paths must be relative zip paths with forward slashes, no leading slash, no backslashes, and no `..` segments. External plugins cannot use `activeByDefault`; saved project state can still reactivate an external plugin by ID after the zip is loaded.

The optional `style` CSS is injected globally into the host document, not scoped to the plugin. Plugin authors are responsible for scoping their selectors (for example with a plugin-specific class prefix) so broad rules do not restyle the rest of the app. Injected CSS can also issue network requests through `url()` references and `@import`, so a plugin stylesheet can load external fonts, images, or additional sheets; treat plugin CSS with the same trust expectations as plugin code.

When using the template, update `geolibre-plugin/plugin.json` and `src/geolibre.ts` together so `id`, `name`, and `version` stay in sync. Run `npm run package:geolibre`, then either copy the generated zip into the desktop app data `plugins/` directory, add the template's `geolibre-plugin/` directory in Settings > Plugins for local development, or host the `geolibre-plugin/` directory and add its `plugin.json` URL.

### Plugin marketplace

The Settings menu's **Manage Plugins** entry opens a standalone dialog (modeled on QGIS's plugin manager) with **All**, **Installed**, **Not installed**, **Upgradeable**, and **Settings** sections. The first four list curated registry plugins so users can install, update, and uninstall them without hand-entering manifest URLs; the Settings section manages additional local plugin directories and manual manifest URLs. Actions apply immediately (install/uninstall/update are live; uninstall asks for confirmation). It is a thin layer over the manifest-URL loader above: installing an entry records its manifest URL in the plugin manifest URL list, and the existing loader fetches and registers it. It introduces no new trust path.

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
