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

| ID | Description |
|----|-------------|
| `osm-basemap` | OpenFreeMap Liberty style |
| `carto-light` | CARTO Positron GL style |
| `sample-geojson` | Loads `sample-data/sample.geojson` |
| `maplibre-gl-basemap-control` | Adds a MapLibre basemap picker |
| `maplibre-gl-components` | Adds the MapLibre Components control grid and panels for FlatGeobuf, COG, PMTiles, Zarr, LiDAR, and Gaussian splats |
| `maplibre-gl-geo-editor` | Adds GeoEditor drawing controls |
| `maplibre-gl-geoagent` | Adds GeoAgent map assistant controls |
| `maplibre-gl-lidar` | Adds LiDAR controls |
| `maplibre-gl-streetview` | Adds street view controls |
| `maplibre-gl-swipe` | Adds map swipe controls |

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

## Roadmap (v0.7)

- Dynamic plugin loading from a `plugins/` directory
- Plugin manifest (`plugin.json`)
- Sandboxed worker plugins
