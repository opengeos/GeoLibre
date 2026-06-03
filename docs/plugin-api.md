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
  activate: (app: GeoLibreAppAPI) => boolean | void;
  deactivate: (app: GeoLibreAppAPI) => void;
  getMapControlPosition?: () => GeoLibreMapControlPosition;
  setMapControlPosition?: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => boolean | void;
  getProjectState?: () => unknown;
  applyProjectState?: (app: GeoLibreAppAPI, state: unknown) => boolean | void;
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

## External plugins

Use the [GeoLibre plugin template](https://github.com/opengeos/geolibre-plugin-template) as the recommended starting point for external plugin development. The template includes a MapLibre control wrapper, a `plugin.json` manifest, a GeoLibre plugin entry point, and a `package:geolibre` script that builds the zip layout GeoLibre Desktop expects.

GeoLibre Desktop loads external plugins from the app data `plugins/` directory at startup. External plugins are trusted code and can be installed as:

- A `.zip` file with a root `plugin.json`.
- An unpacked directory with a root `plugin.json`.
- A HTTPS `plugin.json` manifest URL.

The Plugins settings section can also add local development directories outside the app data folder. Each configured directory can contain plugin zips, unpacked plugin bundle folders, or be a single unpacked plugin bundle itself. Configured development directories are scanned before the app data `plugins/` directory, so a development copy can override an installed external plugin with the same ID. Built-in plugins still take precedence over all external plugins.

For the web app, use manifest URLs. GeoLibre fetches the manifest, resolves `entry` and `style` relative to the manifest URL, then loads the bundled ESM entry. Browser loading requires HTTPS except for `localhost` and depends on the host allowing CORS.

To include an external plugin folder in a GeoLibre web build, place the built plugin bundle under the Vite public directory:

```text
apps/geolibre-desktop/public/plugins/example-plugin/
  plugin.json
  dist/index.js
  dist/style.css
```

Vite copies files from `public/` into the final web build, so the manifest URL becomes:

```text
/plugins/example-plugin/plugin.json
```

This works in both development and production web builds. The browser still cannot scan `/plugins/` at runtime, so each bundled plugin must be loaded by an explicit manifest URL, such as one entered in Settings > Plugins. For plugins that should always ship as part of GeoLibre without user configuration, prefer registering them as built-in plugins.

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

When using the template, update `geolibre-plugin/plugin.json` and `src/geolibre.ts` together so `id`, `name`, and `version` stay in sync. Run `npm run package:geolibre`, then either copy the generated zip into the desktop app data `plugins/` directory, add the template's `geolibre-plugin/` directory in Settings > Plugins for local development, or host the `geolibre-plugin/` directory and add its `plugin.json` URL.

## Future plugin work

- Sandboxed worker plugins
