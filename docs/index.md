---
hide:
  - toc
---

<section class="hero">
  <div class="hero__content">
    <p class="eyebrow">Cloud-native desktop GIS</p>
    <h1>MapLibre-powered GIS for local projects and modern geospatial workflows.</h1>
    <p class="hero__lead">
      GeoLibre is a lightweight desktop GIS prototype built with Tauri, React,
      TypeScript, MapLibre GL JS, DuckDB-WASM Spatial, and deck.gl. It focuses
      on fast local data work, project files, styling, plugins, and a practical
      path toward cloud-native geospatial workflows.
    </p>
    <div class="hero__actions">
      <a class="md-button md-button--primary" href="https://viewer.geolibre.app/">Open live demo</a>
      <a class="md-button" href="getting-started/">Get started</a>
      <a class="md-button" href="downloads/">Download app</a>
    </div>
  </div>
  <figure class="hero__media">
    <img src="https://files.opengeos.org/GeoLibre-demo.webp" alt="GeoLibre map interface showing the desktop GIS workspace">
  </figure>
</section>

## What GeoLibre does today

<div class="feature-grid" markdown>

<div class="feature-card" markdown>
### MapLibre map workspace

Use OpenFreeMap basemaps, a blank background, smooth pan and zoom, and toggle built-in map controls for navigation, terrain, globe view, geolocation, scale, attribution, and logo display.
</div>

<div class="feature-card" markdown>
### Local and remote data

Load local vector data supported by DuckDB-WASM Spatial, add web tile and service layers, inspect attributes, style layers, reorder visibility, and save or reopen `.geolibre.json` projects from the desktop app.
</div>

<div class="feature-card" markdown>
### Plugin-ready UI

Built-in plugins cover basemaps, sample data, layer control, MapLibre components, swipe, street view, LiDAR, GeoAgent, and GeoEditor integrations.
</div>

<div class="feature-card" markdown>
### Advanced layer formats

Add Data supports XYZ, WMS, GeoJSON URLs, vector tiles, COG and GeoTIFF rasters, MBTiles, ArcGIS layers, FlatGeobuf, PMTiles, Zarr, LiDAR, and Gaussian splats.
</div>

<div class="feature-card" markdown>
### Processing foundation

The processing toolbox includes client-side algorithms now, with a roadmap toward DuckDB Spatial and an optional Python sidecar for heavier geoprocessing.
</div>

<div class="feature-card" markdown>
### SQL Workspace

Run DuckDB Spatial SQL in the browser against loaded layers, local files, and remote URLs. Auto-wraps bare URLs into the matching reader and streams remote files over HTTP range requests. Includes sample queries, query history, and adding a result (with an optional layer name) to the map or exporting it as CSV or GeoParquet.
</div>

</div>

## Try it in the browser

The live demo is the browser-capable version of the GeoLibre desktop UI. It is useful for exploring the map, loading browser-selected vector data supported by DuckDB-WASM Spatial, adding URL-based layers, styling layers, and testing plugins. Desktop-only file dialogs, local MBTiles, local raster reads, and filesystem save/open operations still require the installed Tauri app.

Open a project by passing a public `.geolibre.json` URL with the `url` query parameter:

```text
https://viewer.geolibre.app/?url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json
```

For narrow embeds, add `?layout=compact` to the demo URL to use icon-only toolbar buttons and hide project metadata:

```text
https://viewer.geolibre.app/?url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json&layout=compact
```

For map-focused embeds, add `&panels=none` to hide the Layers, Style, and Attribute table panels:

```text
https://viewer.geolibre.app/?url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json&layout=compact&panels=none
```

Use `toolbar=icons` when you only want icon-only toolbar buttons. `panels=hidden`, `panels=hide`, `panels=off`, and `hidePanels=true` are accepted aliases for hiding panels.

For a fully chrome-free, map-only embed, add `&maponly` to hide the toolbar menu, all panels, and the status bar:

```text
https://viewer.geolibre.app/?url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json&maponly
```

| Parameter | Example | Description |
| --- | --- | --- |
| `url` | `url=https://share.geolibre.app/giswqs/3d-tiles.geolibre.json` | Loads a `.geolibre.json` project from a public URL. |
| `layout` | `layout=compact` | Uses the compact embed layout with icon-only toolbar buttons and hidden project metadata. `embed` and `iframe` are aliases. |
| `toolbar` | `toolbar=icons` | Shows icon-only toolbar buttons without enabling the full compact layout. |
| `panels` | `panels=none` | Hides the Layers, Style, and Attribute table panels. `hidden`, `hide`, and `off` are aliases. |
| `hidePanels` | `hidePanels=true` | Alternative way to hide the Layers, Style, and Attribute table panels. |
| `maponly` | `maponly` | Hides all chrome (toolbar menu, Layers/Style/Attribute panels, and status bar), leaving only the map. The bare flag or any of `true`, `1`, `yes`, `on` enable it. |

[Open the live demo](https://viewer.geolibre.app/){ .md-button .md-button--primary }
[Read the architecture](architecture.md){ .md-button }

## Project status

GeoLibre is an active prototype. Version 0.9.0 includes the map workspace, project format, plugin API, browser vector import, DuckDB-WASM Spatial loading, advanced Add Data workflows, MBTiles desktop support, ArcGIS layers, COG and GeoTIFF raster rendering, PMTiles, Zarr, LiDAR, Gaussian splats, 3D Tiles, WFS layers, delimited text layers, GPX layers, WMS GetFeatureInfo identify, plugin-state persistence, external plugin manifests, dynamic plugin zip loading, map settings, runtime environment variables, inline attribute editing, multiple DuckDB SQL query-result layers, diagnostics, and the Whitebox toolbox. This release adds the SQL Workspace, Planetary Computer and Earth Engine panels, Overture Maps and federal Web Services plugins, plugin-backed Add Raster and Add Vector dialogs, DuckDB layer identify, selection, and attribute table, a Conversion menu (Vector to GeoParquet, Raster to COG), Whitebox batch tools, a consolidated Project menu, a Controls menu (Measure, Bookmark, Minimap, View State), a Print menu, Layout settings, plugin URL query parameters, the `maponly` embed mode, `VITE_DUCKDB_SPATIAL_EXTENSION_PATH` for offline spatial extension loading, and Docker support for the browser app. See the [roadmap](roadmap.md) for planned work on expanded processing pipelines and external plugin distribution.
