# GeoLibre Plugin API

## Interface

```typescript
export interface GeoLibrePlugin {
  id: string;
  name: string;
  version: string;
  activate: (app: GeoLibreAppAPI) => void;
  deactivate: (app: GeoLibreAppAPI) => void;
}

export interface GeoLibreAppAPI {
  setBasemap: (styleUrl: string) => void;
  addGeoJsonLayer: (
    name: string,
    data: FeatureCollection,
    sourcePath?: string,
  ) => void;
  getActiveBasemap: () => string;
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

## Example plugin

```typescript
export const myPlugin: GeoLibrePlugin = {
  id: "my-plugin",
  name: "My Plugin",
  version: "0.1.0",
  activate(app) {
    app.setBasemap("https://example.com/style.json");
  },
  deactivate() {},
};
```

## Roadmap (v0.6)

- Dynamic plugin loading from `plugins/` directory
- Plugin manifest (`plugin.json`)
- Sandboxed worker plugins
