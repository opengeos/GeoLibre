# @geolibre/map

The headless half of [GeoLibre](https://geolibre.app)'s map layer: data loading,
layer synchronization, and the style engine, without React, the Zustand store,
Cesium, or any map controls.

```bash
npm install @geolibre/map maplibre-gl
```

```ts
import maplibregl from "maplibre-gl";
import { createLayerSync } from "@geolibre/map";

const map = new maplibregl.Map({ container: "map", style: "https://tiles.openfreemap.org/styles/liberty" });
const sync = createLayerSync(map);

map.on("load", () => {
  // Bottom-to-top stacking order; call again whenever the layer list changes.
  sync.sync(layers);
});
```

Alongside `createLayerSync` the entry point exports the paint builders
(`fillPaint`, `linePaint`, `circlePaint`, ...), the COG DEM and PMTiles protocol
registration helpers, and the Mapbox Style / SLD / QML import and export
functions. See
[`docs/architecture.md`](https://github.com/opengeos/GeoLibre/blob/main/docs/architecture.md).

The package is ESM-only and ships TypeScript declarations. `maplibre-gl` is a
dependency; `react` and `react-dom` are peer dependencies of the full
in-repository entry point and are not needed by the headless surface.

MIT licensed.
