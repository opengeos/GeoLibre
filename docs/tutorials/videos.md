# Video Tutorials

Recorded walkthroughs of GeoLibre, oldest first — start at the top for a
guided tour, or jump to the one that matches your task. Every video is part
of the [GeoLibre playlist](https://www.youtube.com/playlist?list=PLAxJ4-o7ZoPf3nB7t3RKjQoYKvvswLdWL)
on the Open Geospatial Solutions channel — subscribe there to catch new ones.

For written, step-by-step versions of the same workflows, see the
[Tutorials overview](index.md); for a still-image tour of the app, see
[Demos](../demos.md).

[Watch the full playlist](https://www.youtube.com/playlist?list=PLAxJ4-o7ZoPf3nB7t3RKjQoYKvvswLdWL){ .md-button .md-button--primary }

## GeoLibre 1.0: A Free, Open-Source Cloud-Native GIS That Runs Anywhere

<div class="video-embed">
  <iframe src="https://www.youtube-nocookie.com/embed/87Cm0QagtxI" title="GeoLibre 1.0: A Free, Open-Source Cloud-Native GIS That Runs Anywhere (Browser, Desktop and Jupyter)" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
</div>

**40:18 · June 2026 · [Watch on YouTube](https://youtu.be/87Cm0QagtxI)**

The full introduction, and the best place to start. Installs and runs all three
builds — browser, desktop, and Jupyter — then works through projects, vector
and raster data, attribute and geometry editing, streaming a 180 GB dataset
without downloading it, PMTiles, 3D tiles, LiDAR, DuckDB, the map controls, and
sharing.

Related: [Getting Started](../getting-started.md) ·
[Interface Overview](../user-guide/interface.md) ·
[Your First Map](first-map.md)

??? note "Topics covered"

    The chapter timestamps in the video description run past the recording's
    40:18 length, so they are listed here without times.

    - What GeoLibre is, and the three ways to run it (browser, desktop, Jupyter)
    - The responsive web layout and light/dark mode
    - Installing the desktop app; running GeoLibre in a Jupyter notebook
    - Saving and loading projects; the website tour and the tech stack
    - 3D tiles and navigating the map canvas; the Layers and Style panels
    - Creating a project and choosing a basemap
    - Drag-and-drop vector data and the identify tool
    - Attribute table: select, edit, and export; editing geometry
    - Drag-and-drop raster data (DEM); adding a GeoParquet layer
    - Streaming a 180 GB vector dataset without downloading it
    - Vector styling: zoom levels, labels, 3D extrusion
    - Raster data: COGs, local files, color maps, pixel inspection
    - CSV/lat-long points, GPS (GPX) tracks, and XYZ/WFS/WMS services
    - PMTiles (Overture buildings) in 2D and 3D; LiDAR point clouds and 3D tiles
    - Connecting to DuckDB
    - Map controls: scale, terrain, search, color bar, legend, measurement, bookmarks, minimap
    - Plugins, sharing projects, tokens, and map-only embed links

## Geoprocessing in the Browser: 700+ Free GIS Tools in GeoLibre, Zero Install

<div class="video-embed">
  <iframe src="https://www.youtube-nocookie.com/embed/W32bIQO_nG8" title="Geoprocessing in the Browser: 700+ Free GIS Tools in GeoLibre, Zero Install" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
</div>

**21:52 · June 2026 · [Watch on YouTube](https://youtu.be/W32bIQO_nG8)**

The Whitebox Next Gen toolbox running entirely on WebAssembly — terrain,
hydrology, LiDAR, remote sensing, raster, and vector tools, with nothing
installed. Walks the category-browsable Processing menu, runs terrain and
hydrology tools on a DEM, and covers plugins, large local files, and the
JupyterLite panel.

The toolbox has since grown past 1,000 tools; see
[Processing Tools](../user-guide/processing.md) for the current list.

Related: [Terrain Analysis](terrain-analysis.md) ·
[Vector Analysis](vector-analysis.md) ·
[Notebook Panel](../notebook.md)

??? note "Chapters"

    - 00:00 Introduction and GeoLibre 1.7 overview
    - 03:10 Opening the web app and creating a project
    - 04:03 Adding data and styling raster layers
    - 06:26 Web-based geoprocessing with Whitebox tools
    - 09:18 Running terrain and hydrology analysis
    - 12:03 Vector data, labels, and centroid processing
    - 14:38 Plugins and extending GeoLibre
    - 17:39 Loading large local files
    - 20:25 JupyterLite and field data collection
    - 21:31 Wrap-up and feedback

## Access Free High-Resolution Disaster Satellite Imagery in Your Browser

<div class="video-embed">
  <iframe src="https://www.youtube-nocookie.com/embed/QQ9i5CTNh84" title="Access Free High-Resolution Disaster Satellite Imagery in Your Browser" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
</div>

**8:26 · July 2026 · [Watch on YouTube](https://youtu.be/QQ9i5CTNh84)**

Installs the [Vantor Open Data plugin](https://github.com/opengeos/maplibre-gl-vantor),
searches its STAC catalog for a disaster event, and compares pre- and
post-event high-resolution imagery on the map — then downloads the original
Cloud Optimized GeoTIFFs and shares the result as a link.

Related: [Plugins & Marketplace](../user-guide/plugins.md) ·
[Adding Data](../user-guide/adding-data.md)

??? note "Chapters"

    - 00:00 Introduction
    - 00:53 What is GeoLibre and Vantor Open Data?
    - 01:27 Installing the Vantor Open Data plugin
    - 02:30 Browsing disaster events
    - 03:00 Searching pre- and post-event imagery
    - 03:55 Visualizing high-resolution satellite imagery
    - 04:21 Comparing before and after imagery
    - 05:06 Identifying earthquake damage
    - 05:54 Downloading original imagery
    - 06:18 Loading multiple image scenes
    - 07:05 Accessing source URLs and sharing maps
    - 07:53 Automatic STAC catalog updates
    - 08:20 Wrap-up

## Regularize Building Footprints in the Browser with GeoLibre

<div class="video-embed">
  <iframe src="https://www.youtube-nocookie.com/embed/xjfPYxgEEEc" title="Regularize Building Footprints in the Browser with GeoLibre" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
</div>

**16:25 · July 2026 · [Watch on YouTube](https://youtu.be/xjfPYxgEEEc)**

Cleans up irregular building polygons — the kind an AI segmentation model or
hand digitizing produces — with the Rust-based regularization tool, entirely in
the browser. Covers loading the data, projected coordinate systems, tuning the
parameters, comparing before and after, and exporting the result.

Try it yourself with the
[live sample project](https://web.geolibre.app/?url=https://share.geolibre.app/giswqs/regularize-building-footprints.geolibre.json).

Related: [Processing Tools](../user-guide/processing.md) ·
[AI Segmentation](../user-guide/segmentation.md)

??? note "Chapters"

    - 00:00 Introduction
    - 00:30 Why building footprint regularization matters
    - 01:00 The traditional Whitebox workflow
    - 02:20 GeoLibre overview
    - 03:05 Launching GeoLibre in the browser
    - 04:05 Loading sample building data
    - 05:00 Importing your own building footprints
    - 06:10 Coordinate systems and data preparation
    - 06:45 Opening the building regularization tool
    - 07:20 Configuring tool parameters
    - 08:05 Running the tool and comparing results
    - 09:05 Understanding regularization options
    - 10:10 Working with different building shapes
    - 11:10 Exploring additional Whitebox tools
    - 12:20 Example: extracting urban areas
    - 13:20 GeoLibre's Whitebox integration
    - 14:30 More geoprocessing tools in GeoLibre
    - 15:30 GeoLibre desktop and mobile apps
    - 16:10 Downloading GeoLibre
    - 16:17 Conclusion

## GeoLibre + GeoLens: A Modern GIS Stack for Self-Hosting Geospatial Data

<div class="video-embed">
  <iframe src="https://www.youtube-nocookie.com/embed/kQqgrxXGd4o" title="GeoLibre + GeoLens: A Modern GIS Stack for Self-Hosting Geospatial Data" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
</div>

**25:41 · August 2026 · [Watch on YouTube](https://youtu.be/kQqgrxXGd4o)**

Pairs GeoLibre with [GeoLens](https://github.com/geolens-io/geolens) for a
fully self-hosted stack: deploy GeoLens, browse its catalog from GeoLibre,
build a 3D NYC map with extrusions and expression-driven styling, animate
building growth over time, then edit footprints and push the edits back to
GeoLens.

Related: [Data Integrations](../user-guide/data-integrations.md) ·
[Styling Layers](../user-guide/styling.md) ·
[Self-Hosting](../self-hosting.md)

??? note "Chapters"

    - 00:00 Introduction: a modern open-source GIS stack
    - 01:15 Introduction to GeoLens
    - 02:19 Exploring the GeoLens demo and data catalog
    - 03:51 Introduction to GeoLibre
    - 04:52 Self-hosting and managing data with GeoLens
    - 06:31 Connecting GeoLibre to GeoLens
    - 08:16 Exploring the NYC 3D sample project
    - 08:58 Animating NYC building growth over time
    - 10:21 Building a 3D NYC map from scratch
    - 11:34 Creating 3D building extrusions
    - 12:27 Styling buildings with expressions
    - 14:41 Adding and styling NYC subway data
    - 16:50 Creating a time animation
    - 17:26 Sharing a GeoLibre project
    - 17:52 Editing GeoLens data from GeoLibre
    - 19:12 Loading editable GeoJSON data
    - 20:02 Creating and editing building footprints
    - 21:30 Saving changes back to GeoLens
    - 22:27 Editing large vector datasets by map extent
    - 23:03 Visualizing raster and Sentinel-2 data
    - 24:23 GeoLens + GeoLibre as a modern GIS stack
    - 24:29 Other GeoLibre data connectors and analysis tools
    - 25:14 Conclusion

## Create Reusable GIS Workflows with GeoLibre Model Builder and AI Assistant

<div class="video-embed">
  <iframe src="https://www.youtube-nocookie.com/embed/dzjNKM6slgs" title="Create Reusable GIS Workflows with GeoLibre Model Builder and AI Assistant" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
</div>

**18:55 · August 2026 · [Watch on YouTube](https://youtu.be/dzjNKM6slgs)**

Build graphical, reusable geoprocessing workflows in the browser: a simple
vector chain first, then a full hydrology model that extracts a stream network
from a DEM. The second half hands the same job to the
[AI Assistant](../user-guide/ai-assistant.md), which assembles and wires the
model from a natural-language prompt, and shows how to edit what it produced.

Related: [Processing Tools](../user-guide/processing.md) ·
[Terrain Analysis](terrain-analysis.md)

??? note "Chapters"

    - 00:00 Introduction
    - 00:49 Model Builder overview
    - 02:23 Building a simple workflow
    - 04:19 Running the model
    - 04:54 Importing and exporting models
    - 05:23 Building a hydrology workflow
    - 11:08 Running the hydrology model
    - 13:01 Building models with AI
    - 14:46 Generating a workflow with a prompt
    - 17:32 Customizing AI-generated models
    - 18:25 Conclusion

## More videos

The channel also covers GeoAI, DuckDB, and geospatial Python more broadly:

- [Open Geospatial Solutions on YouTube](https://youtube.com/@giswqs)
- [GeoAI playlist](https://www.youtube.com/playlist?list=PLAxJ4-o7ZoPcvENqwaPa_QwbbkZ5sctZE)

Have a workflow you would like covered? Open a
[discussion](https://github.com/opengeos/GeoLibre/discussions) and suggest it.
