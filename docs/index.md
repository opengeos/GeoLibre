---
hide:
  - toc
---

<section class="hero">
  <div class="hero__content">
    <p class="eyebrow">Cloud-native GIS platform</p>
    <h1>A lightweight, cloud-native GIS platform for visualizing, exploring, and analyzing geospatial data.</h1>
    <p class="hero__lead">
      GeoLibre is built with Tauri, React, TypeScript, MapLibre GL JS,
      DuckDB-WASM Spatial, and deck.gl. The same workspace runs across desktop
      and web environments, adapting responsively to mobile screens, with fast
      local and cloud-native data work, project files, styling, plugins, and
      modern geospatial workflows.
    </p>
    <div class="hero__actions">
      <a class="md-button md-button--primary" href="https://viewer.geolibre.app/">Open live demo</a>
      <a class="md-button" href="getting-started/">Get started</a>
      <a class="md-button" href="user-guide/interface/">User guide</a>
      <a class="md-button" href="downloads/">Download app</a>
    </div>
  </div>
  <figure class="hero__media">
    <img src="https://files.opengeos.org/GeoLibre-demo.webp" alt="GeoLibre map interface showing the GIS workspace">
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

Built-in plugins cover basemaps, sample data, layer control, MapLibre components, swipe, street view, time slider, Overture Maps, LiDAR, GeoAgent, and GeoEditor integrations.
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

<div class="feature-card" markdown>
### Vector tools

Common geometry tools under Processing → Vector: buffer, centroids, convex hull, dissolve, bounding box, simplify, clip, intersection, difference, and union. They run in the browser with Turf.js, with an optional GeoPandas sidecar engine for every tool.
</div>

<div class="feature-card" markdown>
### Raster tools

Common raster tools under Processing → Raster: hillshade, slope, aspect, reproject, resample, clip by extent, clip by mask layer, polygonize, and contour. They run on a rasterio Python sidecar with a file path in and a file path out. Drag a GeoTIFF/COG onto the map to add it as a raster layer.
</div>

</div>

## Learn GeoLibre

New to GeoLibre? Start with the [User Guide](user-guide/interface.md) for a feature-by-feature tour of the workspace, menus, panels, and tools, then follow the [Tutorials](tutorials/index.md) for hands-on, end-to-end workflows.

- [Interface Overview](user-guide/interface.md): the toolbar, panels, map, and status bar.
- [Adding Data](user-guide/adding-data.md): every file, web service, cloud, 3D, and database source.
- [Processing Tools](user-guide/processing.md) and [SQL Workspace](user-guide/sql-workspace.md): analysis with vector, raster, conversion, Whitebox, and DuckDB Spatial SQL.
- [Plugins & Marketplace](user-guide/plugins.md): activate built-ins and install from the registry.
- [Your First Map](tutorials/first-map.md): add a layer, style it, inspect it, and share it.

[Read the User Guide](user-guide/interface.md){ .md-button .md-button--primary }
[Browse the Tutorials](tutorials/index.md){ .md-button }

## Try it in the browser

The live demo is the browser-capable version of the GeoLibre desktop UI. It is useful for exploring the map, loading browser-selected vector data supported by DuckDB-WASM Spatial, adding URL-based layers, styling layers, and testing plugins. Desktop-only file dialogs, local MBTiles, local raster reads, and filesystem save/open operations still require the installed Tauri app.

!!! note "Hosted on GitHub Pages, private by design"
    The live demo is a static site deployed on GitHub Pages and runs entirely in your browser. It is secure and does not track users: there is no analytics or account, and the data you load is processed client-side in your browser session. Data leaves your browser only when you choose to add a remote URL or explicitly share a project.

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

Other parameters control the toolbar, panels, and theme. See [Embedding & Sharing](user-guide/embedding.md) for the full parameter reference and `<iframe>` examples.

[Open the live demo](https://viewer.geolibre.app/){ .md-button .md-button--primary }
[Embedding & Sharing](user-guide/embedding.md){ .md-button }

## Project status

GeoLibre is an active prototype. Version 0.9.0 includes the map workspace, project format, plugin API, browser vector import, DuckDB-WASM Spatial loading, advanced Add Data workflows, MBTiles desktop support, ArcGIS layers, COG and GeoTIFF raster rendering, PMTiles, Zarr, LiDAR, Gaussian splats, 3D Tiles, WFS layers, delimited text layers, GPX layers, WMS GetFeatureInfo identify, plugin-state persistence, external plugin manifests, dynamic plugin zip loading, map settings, runtime environment variables, inline attribute editing, multiple DuckDB SQL query-result layers, diagnostics, and the Whitebox toolbox. This release adds the SQL Workspace, Planetary Computer and Earth Engine panels, Overture Maps and federal Web Services plugins, the Time Slider plugin for animating time series raster and vector data, plugin-backed Add Raster and Add Vector dialogs, DuckDB layer identify, selection, and attribute table, a Conversion menu (Vector to GeoParquet, Raster to COG), Whitebox batch tools, a consolidated Project menu, a Controls menu (Measure, Bookmark, Minimap, View State), a Print menu, Layout settings, plugin URL query parameters, the `maponly` embed mode, `VITE_DUCKDB_SPATIAL_EXTENSION_PATH` for offline spatial extension loading, and Docker support for the browser app. See the [roadmap](roadmap.md) for planned work on expanded processing pipelines and external plugin distribution.
