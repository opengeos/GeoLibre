# Features

A feature-by-feature list of what GeoLibre can do today — the latest release plus
what has landed on `main` since (see [Recently added](index.md#recently-added)).
For task-oriented walkthroughs, see the [User Guide](user-guide/interface.md) and
the [Tutorials](tutorials/index.md); for what is planned next, see the
[Roadmap](roadmap.md).

## Platforms and interface

- Runs across desktop (Tauri), web (browser), native Android (Tauri v2 mobile), and mobile or small screens
    - Responsive, touch-friendly layout that adapts menus, dialogs, and panels; on phones the Layers and Style panels overlay the map as slide-over sheets
    - Per-panel visibility through Layout settings
- Command palette (`Ctrl`/`Cmd` + `K`) that searches and runs menu and toolbar actions across Add Data, Processing, Controls, Plugins, and Help
    - Global keyboard shortcuts for New, Open, Save, and Save As
    - Google Earth-style camera resets: `N` north up, `U` top-down, `R` reset view
    - A `?` shortcuts cheat sheet
- Customizable UI profiles that tailor which menus, panels, and data sources are visible, so a deployment can present a focused subset of the app to its users. See [UI Profiles](ui-profiles.md)
- Internationalization framework with react-i18next and 15 complete per-build translation catalogs — including right-to-left Arabic with a fully mirrored interface — plus a `?locale`/`?lang` query parameter to set the embed language
- Accessibility pass with axe-checked screens, keyboard navigation, and screen-reader labels
- App-wide, section, and plugin React error boundaries that contain failures and keep the rest of the workspace usable
- Undo/redo for layer and style operations

## Map workspace and basemaps

- MapLibre map workspace
    - **Basemaps**: OpenFreeMap, Protomaps, EOX Sentinel-2 cloudless, and Openbasiskaart, with stacking of multiple raster basemaps, blank background support, and double-click to swap the core basemap from the layer panel
    - **Planetary basemaps**: Mars and the Moon (OpenPlanetaryMap), plus Mercury, Venus, the Galilean moons (Io, Europa, Ganymede, Callisto), Titan, Pluto, and Charon (USGS Astrogeology, reprojected to Web Mercator by the tiles Worker). A per-project ellipsoid drives distance, area, and scale measurements from that body's radius, and a planet switcher sits in the Layers panel
    - **Toggleable controls**: navigation, fullscreen, geolocation, globe, terrain, scale (metric, imperial, or nautical), attribution, and logo, plus a double-click terrain control for setting vertical exaggeration
    - **On-map helpers**: a right-click context menu for reading coordinates and quick actions, and a Gridlines coordinate-grid overlay with edge labels and a UTM easting/northing grid mode
    - **View menu**: viewport history navigation, a reset pitch and bearing control, a distinct north arrow, and View in Google Maps and View in Google Earth actions
- Multi-map grid that splits the workspace into a grid of synchronized map views, so you can compare basemaps, layers, or time steps side by side, with any **secondary** pane switchable to an optional CesiumJS 3D globe via its 2D/3D toggle — the primary map is always MapLibre (camera-synced with the 2D maps; requires a Cesium Ion token — see [Optional 3D globe credentials](getting-started.md#optional-3d-globe-credentials-cesium-ion))
- Timelapse mode that animates annual cloudless basemaps — EOX Sentinel-2 and NASA GIBS providers (Landsat/WELD and MODIS land cover) — with a provider picker and legend
- Weather menu with live cloud and precipitation radar overlays (RainViewer), a Clouds overlay in the Controls menu, and a Google Earth-style sun position simulation that lights the scene for a given date and time
- Wikipedia knowledge cards: click a place on the map to pull up its Wikipedia summary and info card

## Adding data

- Load local vector layers supported by DuckDB-WASM Spatial, including GeoJSON, GeoParquet, GeoPackage, Shapefile, FlatGeobuf, KML/KMZ, GML, delimited text (including CSV without coordinates, loaded as a standalone attribute table), GPX, and OpenStreetMap PBF extracts (parsed in-browser with osmix)
    - KML/KMZ is read by an in-house parser that honors embedded symbology (a file it cannot handle falls back to the DuckDB Spatial reader, which loads the geometry without the styling), renders `GroundOverlay` images as map overlays that animate through the Time Slider when time-tagged, displays embedded Collada `.dae` 3D models, and serves tiled `NetworkLink`-driven Super-Overlays to the map rather than loading the whole pyramid at once
- Reproject vector layers to EPSG:4326 on load, render vector layers that carry Z coordinates in true 3D rather than flattening them onto the ground plane, and split dragged GPX files into named waypoint, track, and route layers
- Large local vector layers render through client-side vector tiling, with a warning before loading very large files
- Add Data menu covering every remote and cloud-native source:
    - **Tile and map services**: XYZ tiles; WMS and WFS, with layers and feature types discovered from the service's GetCapabilities so you pick from a populated dropdown; vector tiles, including OGC API - Tiles services; and ArcGIS FeatureServer and VectorTileServer layers
    - **Feature services and feeds**: GeoJSON URLs; GeoRSS feeds from a URL or file; and OGC API - Features collections added as vector layers from whatever URL you have in hand — a landing page, `/collections`, a collection, or a full items URL
    - **Raster**: COG and GeoTIFF; Cloud-Optimized NetCDF/HDF via kerchunk references, plus local HDF5 and NetCDF-4 files; and MBTiles
    - **Cloud-native archives**: PMTiles, and Zarr from a remote store or a folder on disk, with variable and dimension pickers that offer the store's real coordinate values rather than raw indices
    - **Files with pickers**: multi-layer GeoPackages, with a layer picker so only the chosen feature tables load; delimited text with a source CRS field so projected easting/northing columns reproject correctly; CAD drawings (DXF/DWG) with a drawing-layer picker and CRS selector; and Esri File Geodatabases (`.gdb` folders, desktop) with a feature-class picker and automatic reprojection
    - **3D and media**: LiDAR; 3D Tiles, including authenticated tilesets via custom request headers; ArcGIS I3S scene layers (Integrated Mesh and 3D Object, rendered on deck.gl); Gaussian splats; glTF/GLB 3D models placed at coordinates; georeferenced video overlays; and geotagged photos imported as a point layer from their EXIF GPS, with manual placement and drag for photos lacking coordinates and a true native-resolution photo viewer
    - **Throughout**: a fully internationalized dialog, comma decimal support, drag-and-dropped CSV coordinate files, sample-data dropdowns on every upstream-backed panel for loading ready-made example datasets, and a saved service library for storing and re-adding frequently used web-service endpoints
- QGIS-style Browser panel (Data Source Manager) for exploring and adding data from one place: browse map Services and Recent items, connect to PostGIS databases and browse their schemas and tables, drill into local files, save and reopen Favorites, and add a New connection per service kind, with full keyboard navigation of the tree
- Layer Library: save a fully configured layer — source, style, labels, filters, joins, virtual fields, and attribute form — from the layer actions menu, then re-add it to any later project in one click from the Browser panel's **My Data** section
    - Entries can be renamed, removed, and exported or imported as a JSON bundle to share with a team
    - Entries store the source specification rather than the data, so a saved COG, PostGIS table, or remote GeoParquet always reflects its source's current contents
    - Layers whose features exist only in memory or in a local file embed them behind a size cap
- Deck.gl Layer builder for composing deck.gl overlays from uploaded files or remote URLs
- Cloud data integrations through the Planetary Computer and Earth Engine panels, the Overture Maps plugin, and federal Web Services plugins
- Manual and automatic refresh for WFS, GeoJSON URL, and Add Vector Layer URL layers, with the cadence, last-synchronized time, last error, and on-failure policy persisted with the project as a `connection` record — so a reopened project keeps refreshing on schedule and the Layers panel can show each live layer's synchronization status
- ArcGIS Hub, Socrata, and CKAN (Humanitarian Data Exchange) open-data browsers under Plugins → Web Services: search public dataset catalogs by keyword (or restrict the ArcGIS Hub search to the current map area), page through results, and add a dataset to the map or download it
- Drag and drop vector and GeoTIFF/COG raster files onto the map to add them as layers

## Layers, styling, and labels

- Layer panel for visibility, opacity, reordering, rename, zoom-to-layer, identify, labels, open attribute table, export, and remove actions
    - A per-row symbology swatch (dot, line, square, or image glyph) colored from the layer's own styling
    - Copy and paste of a layer's style onto another layer
    - A metadata dialog that reads a raster's real georeferencing from the GeoTIFF header: CRS and EPSG code, pixel size and extent in CRS units, data type, nodata, compression, tiling, and overviews
    - A Search places box in the footer that geocodes to a location, flies straight to a typed coordinate in decimal degrees, DMS, or DDM, or flies to an H3 cell index typed as either a hexadecimal string or a 64-bit integer (framing and outlining the cell) — all without leaving the panel
- Nested layer groups that give the layer stack a real hierarchy. See [Layer groups](user-guide/layers.md#layer-groups)
    - Create a group from scratch, from the current layer, or from a multi-selection
    - Move one layer or a whole selection into a group in one step, or add new data straight into a group
    - Set a group-level opacity, collapse and expand groups, and reorder them
    - Ungroup while keeping the layers, or delete the group with them
    - Hiding a group hides its layers, and a layer suppressed that way is marked as such rather than looking like one you switched off
- Auto-generated on-map Legend panel derived from the visible layers' symbology
    - Per-class rows for graduated, categorized, rule-based, and expression styling; gradient bars for heatmaps and continuous raster colormaps; proportional-symbol size ramps; diagram fields; and land-cover labels from a Raster Attribute Table
    - An edit mode for renaming, hiding, and reordering entries, adding a section from a color dictionary, choosing a corner, collapsing sections, resizing the panel, and exporting the rendered legend as JSON
    - Saved with the project and shared with the Print Layout legend
- Live style panel
    - **Renderers**: single, categorized, graduated, expression, and rule-based (filter-driven) symbology over fill, stroke, opacity, and circle radius, plus proportional symbols, fill patterns, a built-in marker library, and point heatmap and clustering renderers — all including for Add Vector Layer point layers
    - **Color**: an inline color ramp picker that previews each colormap's gradient on the trigger and beside every option, plus a transparent (no fill / no outline) option in the color picker
    - **Rule-based renderer**: per-rule symbol properties, scale-dependent visibility, nested rules, and per-rule toggles, and it can hide features matching no rule
    - **Style toolkit**: diagram symbology (pie, donut, and bar charts drawn on features); a symbology pack of inverted-polygon masks, arrow and marker lines, and geometry generators; and data-driven proportional sizing for marker icons
    - **Style Manager**: saves reusable symbol, color-ramp, and label presets to a personal library and applies them across projects
    - **Interchange**: vector layer symbology imports and exports as OGC SLD, QGIS QML, and Mapbox GL style JSON, so styles round-trip between GeoLibre, QGIS, and the Mapbox/MapLibre ecosystem
- Data-defined label engine for labeling vector features by any attribute or expression
    - ArcGIS-style placement and styling controls: anchor, X/Y offset, rotation, wrap width, and letter case
    - Expression-driven label properties and placement priority
    - A Duplicate labels option, plus unique and concatenate modes that collapse points stacked at the same coordinate into a single deduplicated label
- Single-band pseudocolor with classification, reversed and custom color ramps, the full colormap list shown as inline gradient swatches in the Color ramp picker, a Legend populated automatically from a paletted raster's embedded color table, and RGB band combination for styling raster layers, plus COG pixel-value inspection from the Identify icon

## Attribute data and expressions

- Attribute table
    - **Browsing**: filtering, sorting, resize controls, feature highlighting with Ctrl- and Shift-click multi-row selection, optional zoom to selected features, and virtualized rows for large layers
    - **Editing and derived fields**: add-field and field-calculator tools (including geometry length and area calculation), virtual fields (expression-backed computed columns that update with the data), and persistent attribute joins configured in layer properties
    - **Forms**: an attribute form designer with edit widgets, validation constraints, and conditional field visibility
    - **Analysis**: a Charts panel (histogram, scatter, bar, line, box) and a field statistics summary panel
    - **Columns**: rename, delete, hide/show, and reorder, plus a column explorer for finding and toggling fields in wide tables
    - **Export** to GeoJSON, GeoParquet, Shapefile, GeoPackage, or CSV
    - A **Raster Attribute Table** for single-band categorical rasters
- Shared Expression Builder with a function reference, searchable field list, live preview, and reusable variables, wired into filters, labels, styling, field calculation, and selection, plus Select by Expression and Select by Location for building feature selections

## SQL and databases

- SQL Workspace for running DuckDB Spatial SQL against loaded layers, local files, and remote URLs, docked as a resizable panel beside the map
    - Editor autocomplete for tables, columns, and SQL keywords, plus sample queries and query history
    - Add results to the map or export them
    - An in-browser PostGIS SQL engine via PGlite and an Apache Sedona spatial SQL engine
- Multiple DuckDB SQL query-result layers with identify, selection, and attribute table support

## Map tools, printing, and media

- Controls menu
    - Measure (including terrain-aware 3D measurements), Bookmark, Minimap, View State, and a Search panel
    - Map annotation tools that draw text, arrows, and highlights on the map, saved with the project
    - Persistent mode banners for the Directions and Reverse Geocode tools
    - A Camera Tour recorder that captures an animated keyframe tour to video, with per-keyframe recapture, per-keyframe hold and transition duration controls, and saving or loading a named tour setup as JSON
    - A Dashboard panel of configurable chart widgets that summarize the loaded layers: histogram, scatter, bar, line, box, and pie charts, plus big-number indicator tiles with count, sum, mean, min, max, or median aggregation and a custom prefix and suffix
- Print Layout composer (**Project → Print Layout...**) that exports the map to PNG or PDF: a user-editable legend, an explicit map-scale input, a title block with editable title and footer, page-size controls, a custom print extent, attribute-table and chart blocks, Atlas / map series generation that produces one page per feature or a uniform series of pages along a line, and Copy to Clipboard
- Record the map canvas, or a drawn bounding box, to a video file straight from the browser (with an optional title/source caption and on-map panel capture for HTML, legend, and colorbar overlays), and animate a marker along any line layer with 3D track-follow camera controls and MP4 export
- Bookmarks that capture the active layers alongside the camera, organized into folders, with selectable export, a resizable and reorderable panel, and a save-as name prompt
- Elements panel that lists the map's annotations — text, arrows, rectangle, ellipse and freehand highlights, pin markers, sticky notes, and placed images — so each one can be found and managed from a list instead of hunted for on the canvas. Most elements are anchored to a point and move with the map; a placed image can instead be pinned to an extent so it scales with the view. See [Annotations and the Elements panel](user-guide/map-controls.md#annotations-and-the-elements-panel)
- Dashboard **selector** widget that turns a categorical field into a set of chips and cross-filters every other widget bound to the same layer, in single- or multi-select mode. A selector never filters itself, so a choice can always be changed or cleared, and selections are a way of looking at the data rather than a property of it — they start empty each time the dashboard opens

## Field data collection

- Field Collection tool for capturing point, line, and polygon observations with a per-layer custom form (text, number, date, and choice fields plus an optional photo), placed by device GPS or by tapping the map, written to a GeoJSON layer that flows into the attribute table, export, and offline use
- Live GPS tracking with a moving position marker, a recorded track log, and digitizing new features directly from the GPS feed. See [GPS tracking](user-guide/map-controls.md#gps-tracking)
    - Reads either the device's own geolocation or an external **NMEA** GPS/GNSS receiver over Web Serial or Web Bluetooth, with a baud-rate picker and a live sentence and fix counter

## Storytelling and collaboration

- Story map builder that composes its chapters directly on the live map, with a presenter view, dedicated start and closing slides, an optional hide-itinerary toggle, a printable PDF handout generator (with subtitle and byline fields), and standalone HTML export
- Real-time multi-user collaboration (MVP; requires the `VITE_GEOLIBRE_COLLAB_URL` build variable — see [Collaboration](collaboration.md)) so several people can edit the same project together
    - Per-participant permissions and an in-app chat panel
    - An on-canvas session-status badge and roster — a live dot, a connected-participant count, and an expandable client list — while a session is active
- Anchored review comments: drop a pin on the map, write a note, and reply, resolve, reopen, or delete the thread, filtered by open, resolved, or all. Comments are saved in the project file so they travel with a shared project, and every mutation syncs live to the other participants during a collaboration session. See [Review comments](user-guide/map-controls.md#review-comments)

## AI, Python, and automation

- Natural-language GIS assistant that turns plain-English requests into auditable, undoable GeoLibre operations — Spatial SQL, symbology, add and remove data, and map control
    - Provider-pluggable with your own API key, also read from OS environment variables
    - A dedicated AI Providers settings section with per-feature provider dropdowns and multiple named profiles (provider, model, and credentials) you can switch between from the assistant panel
    - An in-panel model picker over the active profile's models, credentials that survive a provider change, and arrow-key recall of previous prompts
- In-app Python Console plus a Python automation API for scripting the app
- Notebook panel docked beside the map for running Jupyter against the live map. See [Notebook Panel](notebook.md)
    - The web build embeds a self-hosted JupyterLite site with an in-browser Pyodide kernel; the desktop build launches a uv-managed JupyterLab server
    - Notebook cells drive the map through an auto-loaded `geolibre` client, and external Jupyter frontends attached to that server (VS Code's Jupyter extension, `jupyter console`, nbclient) drive the map too
- Python package (`geolibre`) that embeds the full app in Jupyter notebooks as an [anywidget](https://anywidget.dev), with two-way project sync. See the [Python package guide](python.md)
    - An expanded leafmap-style API: local raster, marker/cluster, and choropleth layers; `split_map`, `add_legend`, and `add_colorbar` helpers; typed read-back of selected and drawn features; and `to_html` export
- Optional Python FastAPI sidecar for heavier processing workflows

## Processing and analysis

- Conversion menu for Vector to GeoParquet, FlatGeobuf, and PMTiles; a generic Vector to Vector converter that translates between any supported vector formats by file extension; CSV to GeoParquet; and Raster to COG
    - In the browser build every conversion runs client-side on DuckDB-WASM, the pure-JS writers, or `geolibre-wasm` (Vector to PMTiles on a background worker)
    - The desktop app prefers the Python sidecar, whose GDAL/rio-cogeo stack reads more input formats and tiles deeper
- Whitebox toolbox that runs entirely in the browser through a WebAssembly runtime with raster I/O — no Python sidecar required
    - Surfaces both Whitebox tools and GeoLibre's own WASM raster tools
    - Browsable by category directly in the Processing menu, with nested subcategory submenus and an offline-bundled tool catalog
    - Deep-linkable through a `?tool=` URL parameter that preselects a tool and pre-fills its form, with a Copy link button that builds the shareable link
    - Batch tools run against a selected input directory
- Vector menu
    - **Geometry and analysis**: buffer, centroids, convex hull, dissolve, bounding box, simplify, clip, intersection, difference, union, spatial join, attribute join, select by value, select by expression, select by location, random extract, movement, space-time, and cell coverage
    - **Data quality**: check validity, fix geometries, and check topology rules
    - **Engines**: Turf.js in the browser, an optional GeoPandas sidecar engine for every tool, and an in-browser GeoPandas engine via Pyodide (no server, same results as the sidecar)
- Raster menu with hillshade, slope, aspect, reproject, resample, clip by extent, clip by mask layer, polygonize, contour, zonal statistics, raster calculator, reclassify, mosaic, and focal statistics
    - Backed by a rasterio Python sidecar, with a client-side fallback so core tools also run in the browser when no sidecar is available
    - Plus in-browser extraction of COG, WMS, and XYZ bounding-box subsets, and a normalized-difference index builder for any HTTP COG
- Spectral Index toolbox (NDVI, GNDVI, NDWI, NDMI, NDBI, NBR, EVI, SAVI) with Sentinel-2, Landsat 8-9, NAIP, and custom band layouts, evaluated client-side with geotiff.js or on the rasterio sidecar
- Spatial Statistics toolbox, including Emerging Hot Spot Analysis that builds a space-time cube from timestamped points, runs Getis-Ord Gi\* per time slice, and classifies each cell as a new, intensifying, persistent, diminishing, sporadic, oscillating, or historical hot or cold spot
- Processing batch runner with model and pipeline chaining, to run a sequence of tools as one job
- Processing History panel that lists every tool run, re-runs any of them with one click, and copies the equivalent Python code
- Raster Georeferencer (Processing → Georeferencing) that pins a non-georeferenced image to the map with ground control points using a least-squares affine fit, reporting per-GCP and RMS residuals
- Network analysis tools for isochrones, service areas, origin–destination (OD) cost matrices, and sequential routes (directions) through an ordered set of waypoints
- Geocoding tools for forward, batch, and reverse geocoding through a multi-provider abstraction
- AI Segmentation (SamGeo) that turns imagery into vector features with [segment-geospatial](https://github.com/opengeos/segment-geospatial) and Meta's SAM 3 — text prompts ("trees", "buildings") or automatic segmentation, proxied to a separate `samgeo-api` model server (GPU recommended). See [AI Segmentation](user-guide/segmentation.md)
- In-browser object detection that runs ONNX/YOLO models directly in the webview, with no server or Python required, over map imagery or an imported geotagged photo layer
- H3 tools to create hexagonal grids over an extent and bin point layers into H3 cells

## Projects and sharing

- Project menu to create, open, save, and Save As `.geolibre.json` projects, export a project to a single standalone interactive HTML file that runs offline with no server, and a project gallery for browsing and opening shared projects with one click
- Autosave with a browsable project history. See [Projects](user-guide/projects.md#project-history-and-crash-recovery)
    - Snapshots are written to local device storage a few seconds after each change settles, and listed newest first with their layer count and zoom
    - Restoring a snapshot is an undoable step
    - Per-project, per-snapshot, and total-size caps keep history from growing without limit
    - In the browser build, outside an embedded (iframe) session, a crash-recovery prompt appears when a session ends without closing cleanly and a newer autosave exists than the last explicit save
- QGIS project import (`.qgs` and `.qgz`) that rebuilds layers, nested layer groups, group visibility, layer order, styling, and the saved map view, reporting per-layer why anything was skipped rather than failing the whole import. See [Projects](user-guide/projects.md#importing-a-qgis-project)
- ArcGIS Pro project import (`.aprx` and `.mapx`) that reads CIM JSON without ArcPy and restores the first 2D map's extent, local vector layers, nested groups, visibility, simple symbols, and field labels, with per-layer warnings for unsupported sources. See [Projects](user-guide/projects.md#importing-an-arcgis-pro-project)
- Reusable project templates saved to a personal library, with an option to keep the basemap, groups, styles, legend, widgets, and layout while stripping the data layer content

## Plugins

- Built-in plugins for the map surface: basemap, layer control, MapLibre components, and swipe
- Imagery and street level: street view, Mapillary coverage and street-level image viewer, OpenAerialMap open-aerial-imagery search, and Historical Imagery
- Data catalog browsers:
    - **Natural Earth** and **Source Cooperative**, including opening or streaming large GeoParquet from Source Cooperative
    - **STAC catalogs**, which discovers catalogs from STAC Index, connects to both static catalogs and STAC APIs, searches a collection's items, and adds any visualizable asset as a layer
    - **Earthdata GIS**, which searches NASA's EOSDIS ArcGIS portal and renders its imagery, map, and feature services and published web maps as first-class layers
    - **Hugging Face**, for searching the Hub, walking a dataset repo's folders, adding its vector and raster files to the map, and creating and uploading dataset repos
    - **[GeoLens](https://github.com/geolens-io/geolens)**, which connects to a self-hosted GeoLens server and adds datasets as signed vector tiles, OGC API Features GeoJSON, or server-rendered raster tiles — and writes edits to a GeoJSON-loaded dataset back to the GeoLens server, feature by feature, when the server allows it
- Analysis and editing integrations: Elevation Profile, Overture Maps, USGS LiDAR, GeoAgent, and GeoEditor
    - The GeoEditor can pull the vector features currently visible in the map view into the editor for editing without re-importing the source, and write edits back to their origin, including GeoPackage and GeoJSON files and PostGIS database tables
- Configurable control positions and external plugin manifests, and external plugins can:
    - Render on the host's shared deck.gl instance via `app.getDeckGL()`
    - Use the maplibre-gl-raster stack and the map projection control, and register native raster and tile layers
    - Render Zarr through the renderer the app already ships via `addZarrLayer`, with plugin-owned paint properties honored on custom layers so the Style panel's sliders apply
    - Expose layer groups of their own
    - Register first-class right-sidebar panels, toolbar menus, and floating panels through the plugin UI host API, including a shared-rail replace-style dock mode, and place their toolbar menus after the Help menu
- Time Slider plugin for animating time series raster and vector data
    - Binds existing vector layers already on the map to the timeline — GeoJSON as well as vector tiles, PMTiles, and MBTiles, whose timestamp field is detected from a live tile sample so a tiled layer animates over its full extent without a local copy of the data
    - Drives a layer's own internal time dimension through a generic temporal adapter, so a data cube such as a Zarr store joins the shared timeline
    - Steps through mosaic sources (a MosaicJSON or STAC collection of many COGs per date) rendered on either a GPU or a WASM engine
    - Plots a pixel time series, charting a sampled pixel's value across a raster stack
- Flight Simulator plugin with a continuous, interactive free-flight camera you steer over terrain and 3D layers from the keyboard, rather than declaring a destination and watching a scripted camera animation
- H3 hexagonal grid plugin that renders the H3 grid over the current view at a chosen resolution, identifies a cell to inspect its index, parent, children, neighbors, and center, and exports the grid or the selection as GeoJSON or CSV
- Atmosphere Effects plugin that renders a deep-space backdrop, parallax starfield, comets, and an atmospheric halo around the globe at low zoom (technique adapted from [Leonel Dias](https://leoneljdias.github.io/posts/globe-atmosphere-halo-comets/)), with a Spinning Globe panel and customizable atmosphere halo and deep-space colors
- Directions plugin for interactive routing via [maplibre-gl-directions](https://github.com/maplibre/maplibre-gl-directions): click the map to add waypoints, drag to reposition, and click a waypoint to remove it (uses the public OSRM demo server, driving only)
- Install external plugins from an uploaded zip on both desktop and web, plus external plugin zip loading from the app data plugins directory and local development plugin directories, with the Manage Plugins list sorted alphabetically
- Bundled drop-in plugins under `public/plugins/<id>/` that bake into both the web and desktop builds and load automatically with no manifest URL

See the [Plugin API](plugin-api.md) to build your own.

## Deployment and platform builds

- Browser deployment with Docker, with optional HTTP Basic Auth for the web container. See [Embedding & Sharing](user-guide/embedding.md)
    - Embed-friendly URL parameters, including `?url=` project deep links that skip the welcome wizard and a `?welcome=0` param to opt out of onboarding
    - A `maponly` chrome-free mode
    - A `layout=viewer` read-only preset that keeps Layers, View, Controls, basemaps, and search/identify while hiding every authoring path — menus, shortcuts, drag-and-drop import, and the plugins whose on-map control writes to the project — so an embed cannot be steered into editing
- Versioned `postMessage` API for a host page that frames the app. See [Talking to the map at runtime](user-guide/embedding.md#talking-to-the-map-at-runtime)
    - **Commands**: load a project, move the camera, highlight features, open a processing tool, toggle and list layers, apply filters, read the viewport, add a layer, and export the map as a PNG at runtime
    - **Events back out**: `ready`, `ack`, `projectLoaded`, `selectionChanged`, `viewChanged`, `toolCompleted`, and `serverFileWritten`
    - Protocol v2 is current, and v1 hosts stay supported
    - Off unless the deployment names its trusted origins (`GEOLIBRE_EMBED_ORIGINS`), which are enforced in both directions
- Dependency-free `@geolibre/embed` npm client for that protocol: `connect()` resolves once the app is ready, each typed command returns a promise settled from its correlated acknowledgement, and events are subscribed by name. Published from each GeoLibre release, so its version tracks the app. See [The typed client](user-guide/embedding.md#the-typed-client)
- Desktop app capabilities
    - A diagnostics panel that captures native Tauri HTTP requests in the network log and classifies failed `fetch()` errors
    - OS trust store and mTLS client-certificate support for native HTTP
    - Automatic layer reload when local files change on disk
    - A guided update workflow with a startup update check and update preferences
- Desktop packaging and distribution
    - MSIX packaging support, Windows Package Manager (winget) distribution as `OpenGeos.GeoLibre`, and a Windows portable zip build that runs without installation
    - macOS installers signed with an Apple Developer ID certificate and notarized by Apple, so they open without a Gatekeeper workaround
    - Linux AppImages that carry embedded update information and a published `.zsync`, so AppImageUpdate, AppImageLauncher, AppManager, and AM can update the app by transferring only the blocks that changed
- Native Android app built from the same codebase with Tauri v2 mobile, published on [Google Play](https://play.google.com/store/apps/details?id=org.geolibre.app). See [Android](android.md)
    - A GitHub Actions workflow builds both the universal App Bundle that Play ships and signed, per-architecture sideload APKs (~40 MB)
    - A permanent `org.geolibre.app` package id, API level 36, and 16 KB page-size alignment verified in CI
    - Tools that depend on a local desktop process (Whitebox, Raster, Conversion, AI Segmentation, PostgreSQL/Martin) are hidden on mobile, so nothing is shown that cannot run
- iOS build scaffolding on the same codebase, with Tauri iOS configuration, location permissions, and a CI workflow that signs and exports an `.ipa` when Apple signing secrets are present (bring-up: no iOS build has shipped yet). See [iOS](ios.md)
- Installable, offline-capable Progressive Web App (PWA) build, plus a **Download Offline Area** tool that pre-caches the current map view's basemap tiles, and service-worker caching of the CDN-loaded Pyodide and PGlite/PostGIS engines so browser SQL and Python keep working offline after first use
