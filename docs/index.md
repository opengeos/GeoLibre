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
      <a class="md-button md-button--primary" href="/demo/">Open live demo</a>
      <a class="md-button" href="getting-started/">Get started</a>
      <a class="md-button" href="downloads/">Download app</a>
    </div>
  </div>
  <figure class="hero__media">
    <img src="assets/geolibre-app.png" alt="GeoLibre map interface showing the desktop GIS workspace">
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

</div>

## Try it in the browser

The live demo is the browser-capable version of the GeoLibre desktop UI. It is useful for exploring the map, loading browser-selected vector data supported by DuckDB-WASM Spatial, adding URL-based layers, styling layers, and testing plugins. Desktop-only file dialogs, local MBTiles, local raster reads, and filesystem save/open operations still require the installed Tauri app.

[Open the live demo](/demo/){ .md-button .md-button--primary }
[Read the architecture](architecture.md){ .md-button }

## Project status

GeoLibre is an active prototype. Version 0.5.0 includes the map workspace, project format, plugin API, browser vector import, DuckDB-WASM Spatial loading, advanced Add Data workflows, MBTiles desktop support, ArcGIS layers, COG and GeoTIFF raster rendering, PMTiles, Zarr, LiDAR, and Gaussian splats. See the [roadmap](roadmap.md) for planned work on SQL workflows, persisted recent projects, the Python processing sidecar, and external plugin loading.
