# GeoLibre Roadmap

## v0.1: Map viewer and GeoJSON

- [x] Tauri + React + MapLibre shell
- [x] GeoJSON load, layer panel, style panel
- [x] Attribute table (basic)
- [x] Processing UI with local algorithms
- [x] Plugin interface + sample plugins

## v0.2: Project persistence

- [x] `.geolibre.json` save/open
- [x] In-session recent project tracking
- [x] Feature highlight from attribute table
- [x] Optional zoom to selected feature
- [x] Recent projects UI and persistence

## v0.3: Cloud-native formats

- [x] GeoParquet import through DuckDB-WASM
- [x] FlatGeobuf import through DuckDB-WASM and URL-based Components plugin panel
- [x] PMTiles through Components plugin
- [x] COG and GeoTIFF raster rendering
- [x] Zoom to layer for GeoJSON and source-bounds-aware layer types

## v0.4: DuckDB Spatial

- [x] DuckDB-WASM integration
- [x] `INSTALL spatial` / `LOAD spatial`
- [x] Shapefile, KMZ/KML, GeoPackage, GeoParquet, FlatGeobuf, GML, and related vector import paths

## v0.5: Advanced Add Data and plugin-backed layers

- [x] Add Data dialogs for XYZ, WMS, vector files, GeoJSON URLs, vector tiles, raster tile templates, COG and GeoTIFF rasters, MBTiles, and ArcGIS layers
- [x] MapLibre Components plugin with FlatGeobuf, PMTiles, Zarr, LiDAR, and Gaussian splat panels
- [x] Desktop MBTiles metadata and tile reads through Tauri commands
- [x] Plugin control position controls in the Plugins menu
- [x] Layer control integration for GeoLibre-managed layers

## v0.6: Project access, web embeds, and expanded integrations

- [x] Persistent recent projects with desktop file recents and URL-backed web recents
- [x] Separate Open Project from File and Open Project from URL flows
- [x] Browser demo query options for compact layout, icon-only toolbar, and hidden panels
- [x] PostgreSQL layer workflow through desktop Martin server integration
- [x] STAC search workflow for adding catalog-backed raster layers
- [x] Esri Wayback, GeoAgent, GeoEditor, Street View, and Swipe plugin integrations

## v0.7: Add Data expansion, identify, settings, and processing

- [x] GPX loading from URL or local file, with selectable waypoint, track, and route layers
- [x] Delimited text loading from URL or local file using longitude and latitude fields
- [x] WFS GetFeature loading through the Add Data dialog
- [x] WMS GetFeatureInfo identify support with hardened popup handling
- [x] Whitebox toolbox backed by a managed Python sidecar
- [x] Inline attribute editing, horizontal table scrolling, and scrollable identify popups
- [x] Settings dialog for map preferences and runtime environment variables
- [x] Plugin state persistence in project files
- [x] Default GeoJSON sample URL and larger identify popup
- [x] Local raster file loading fix
- [x] Large-file pre-commit guard

## v0.8: Viewer, desktop packaging, plugins, and dynamic layers

- [x] Cloudflare Worker viewer served from `web.geolibre.app`
- [x] Browser demo links updated to the production viewer
- [x] GPX drag-and-drop split into named waypoint, track, and route layers
- [x] Vector layers reprojected to EPSG:4326 on load
- [x] Desktop About dialog update check
- [x] Dynamic external plugin zip loading from the app data plugins directory
- [x] Safe fallback for `crypto.randomUUID` in non-secure contexts
- [x] External plugin manifest support with `plugin.json`
- [x] 3D Tiles layer support through `maplibre-gl-3d-tiles`
- [x] 3D Tiles restoration when reopening projects
- [x] GeoParquet panel DuckDB startup fix
- [x] MSIX desktop packaging and cleaner build output
- [x] External native GeoJSON layers registered from local directories
- [x] Raster basemaps registered as external native layers
- [x] Text marker labels rendered on GeoJSON layers
- [x] Manual and automatic refresh for WFS and GeoJSON URL layers
- [x] Multiple DuckDB SQL query-result layers
- [x] Desktop diagnostics panel and improved diagnostics/status bar contrast
- [x] Toolbar toggles for Colorbar, Legend, and HTML panels

## v0.9: Data integrations, processing, and menu reorganization

- [x] SQL Workspace for running DuckDB Spatial SQL against loaded layers, local files, and remote URLs, with sample queries, query history, and adding results to the map or exporting them
- [x] Planetary Computer panel for browsing and loading STAC data
- [x] Earth Engine panel for browsing and loading datasets
- [x] Overture Maps plugin for loading Overture data themes
- [x] Time Slider plugin for animating time series raster and vector data, powered by `maplibre-gl-time-slider`
- [x] Web Services menu with four federal data plugins
- [x] Add Raster Layer powered by the `maplibre-gl-raster` plugin
- [x] Add Vector Layer powered by the `maplibre-gl-vector` plugin
- [x] Identify, selection, and attribute table support for DuckDB layers
- [x] Conversion menu under Processing for Vector to GeoParquet/FlatGeobuf/PMTiles, CSV to GeoParquet, and Raster to COG, backed by a hardened conversion sidecar with a path allowlist
- [x] Vector menu under Processing with common geometry tools (buffer, centroids, convex hull, dissolve, bounding box, simplify, clip, intersection, difference, union) running client-side with Turf.js, plus an optional GeoPandas sidecar engine
- [x] Raster menu under Processing with common raster tools (hillshade, slope, aspect, reproject, resample, clip by extent, clip by mask layer, polygonize, contour) backed by a rasterio sidecar, path in and path out
- [x] Drag and drop vector and GeoTIFF/COG raster files onto the map to add them as layers
- [x] Whitebox batch tools run against a selected input directory
- [x] Controls menu with Measure, Bookmark, Minimap, and View State tools
- [x] Print menu backed by `PrintControl`
- [x] Project menu consolidating New, Open, Save, and Save As
- [x] Layout settings with per-panel visibility toggles
- [x] Insert before dropdown for placing layers in the stack
- [x] Component panels persisted and controls reset on new project
- [x] Plugins can declare and handle URL query parameters
- [x] `maponly` query parameter for chrome-free map embeds
- [x] `theme` query parameter to set the initial light/dark theme for embeds
- [x] Docker support for the browser app
- [x] `VITE_DUCKDB_SPATIAL_EXTENSION_PATH` for offline spatial extension loading

## v1.0: Processing pipelines, external plugin system, and stable prototype

- [x] GDAL / Rasterio / GeoPandas pipelines
- [x] Buffer, reproject, and export GeoJSON processing tools
- [x] Expanded WhiteboxTools coverage
- [x] External plugin package distribution workflow
- [x] Plugin marketplace / registry design (see [Plugin marketplace and registry](#plugin-marketplace-and-registry-design))
- [x] Plugin marketplace MVP: curated registry plus browse and install UI
- [x] Plugin update (in-place re-fetch) and uninstall with confirmation
- [x] Project menu Share action that uploads to share.geolibre.app using a personal API token
- [x] Python package (`geolibre`) for Jupyter notebooks: embeds the full app as an [anywidget](https://anywidget.dev) with a leafmap-style API (`add_geojson`, `add_tile_layer`, `add_cog`) and two-way `.geolibre.json` project sync
- [x] Performance tuning and test suite
- [x] Cross-platform installers
- [x] Documentation and tutorials

## v1.1: Vector styling, attribute table management, and atmosphere effects

- [x] In-browser GeoPandas engine for the Vector tools via Pyodide (no server, same results as the optional sidecar)
- [x] Host deck.gl exposed to external plugins via `app.getDeckGL()`, so plugins render on the shared instance instead of bundling their own copy
- [x] Style panel support for Add Vector Layer (`maplibre-gl-vector`) layers, including single, categorized, graduated, and expression symbology applied to the control's native layers
- [x] Rename layers from the layer panel by double-clicking the name or from the layer actions menu
- [x] Open attribute table and Export actions added to the layer actions menu
- [x] Manual and automatic (timed) refresh extended to Add Vector Layer URL layers
- [x] Attribute table column management: rename, delete, hide/show, and reorder fields, persisted with the project
- [x] Atmospheric Effects plugin: deep-space backdrop, parallax starfield, comets, and a globe atmosphere halo at low zoom (toggled from the Controls menu)
- [x] conda-forge install instructions and a video tutorial in the documentation
- [x] MIT license
- [x] CSP allowance for `cdn.jsdelivr.net` so DuckDB-WASM loads its bundles in the browser build

## v1.2: New data sources, attribute analytics, routing, and platform polish

- [x] OpenStreetMap PBF file loading parsed in-browser with osmix
- [x] Cloud-Optimized NetCDF/HDF layers loaded via kerchunk references
- [x] Authenticated 3D Tiles tilesets via custom request headers
- [x] Georeferenced video overlay layers
- [x] Deck.gl Layer builder for composing deck.gl overlays from uploaded files and remote URLs
- [x] In-browser PostGIS SQL engine via PGlite, alongside the DuckDB Spatial SQL Workspace
- [x] Attribute table add-field and field-calculator tools
- [x] Attribute table Charts panel (histogram, scatter, bar, line, box)
- [x] Spatial join added to the Vector tools
- [x] Select by value and Select by location tools
- [x] H3 tools to create hexagonal grids and bin points into H3 cells
- [x] Point heatmap renderer and clustering, including for Add Vector Layer point layers
- [x] Directions plugin for interactive routing via `maplibre-gl-directions`, with a one-time privacy notice before enabling it
- [x] Undo/redo for layer and style operations
- [x] Command palette (`Ctrl`/`Cmd` + `K`) and global keyboard shortcuts with a `?` cheat sheet
- [x] Print layout composer with PNG and PDF export
- [x] Installable, offline-capable Progressive Web App (PWA) build
- [x] Internationalization framework (react-i18next) with extracted string catalogs and a `?locale`/`?lang` embed language parameter
- [x] Accessibility pass with axe checks across key screens
- [x] App, section, and plugin React error boundaries
- [x] Playwright end-to-end smoke tests and a CI job
- [x] Expanded Python `Map` API covering more Add Data layer types
- [x] CDN-loaded PGlite/PostGIS to shrink the Jupyter wheel and the desktop binary

## v1.3: Analysis depth, real-time collaboration, story maps, scripting, and an AI assistant

- [x] Spatial Statistics toolbox under Processing
- [x] Vector tools: Smooth, Regular grid, and Voronoi/Delaunay
- [x] IDW / kriging interpolation (point layer → continuous raster surface)
- [x] Attribute (table) join vector tool, joining a table's fields by a matching key
- [x] Raster analysis tools: zonal statistics, raster calculator, reclassify, mosaic, and focal statistics
- [x] Client-side raster processing fallback that runs in the browser when the Python sidecar is unavailable
- [x] Single-band pseudocolor with classification and RGB band combination for raster styling
- [x] Batch run and model/pipeline chaining for processing tools
- [x] Network analysis: isochrones, service areas, and origin–destination cost matrices
- [x] Collapsible layer groups/folders in the layer panel
- [x] glTF/GLB 3D model layers placed at coordinates
- [x] Client-side vector tiling for large local vector layers
- [x] Warning before loading very large vector files
- [x] Transparent rewrite of public S3, GCS, and Azure cloud-storage URLs in SQL queries
- [x] Shapefile and GeoPackage export
- [x] Apache Sedona as an additional SQL Workspace engine
- [x] Batch geocoding and reverse geocoding tools, with a multi-provider geocoding abstraction
- [x] Real-time multi-user collaboration (MVP) backed by a Cloudflare Worker
- [x] Scroll-driven story map builder, presenter, and standalone HTML export
- [x] User-editable legend for the print layout
- [x] Field statistics summary panel in the attribute table
- [x] AI Segmentation toolbox via [segment-geospatial](https://github.com/opengeos/segment-geospatial) (SamGeo) and Meta's SAM 3, proxied through the sidecar to a separate `samgeo-api` model server
- [x] Natural-language GIS assistant (Strands agent) that turns plain-English requests into auditable, undoable GeoLibre operations
- [x] Python automation API and an in-app Python Console
- [x] Python package: local raster, marker/cluster, and choropleth APIs; `split_map`, `add_legend`, and `add_colorbar` helpers; typed read-back of selected/drawn features; and `to_html` export
- [x] Homebrew Cask packaging for macOS
- [x] Native Android app from the same codebase via Tauri v2 mobile, with a CI workflow that builds signed, per-ABI release APKs (~40 MB) — see [Android](android.md)
- [x] `isMobile()` feature-gating that hides desktop-process tools (Whitebox, Raster, Conversion, AI Segmentation, PostgreSQL/Martin) on Android so nothing is shown that cannot run
- [x] Responsive, touch-friendly mobile layout: Layers/Style panels overlay the map as slide-over sheets on phones, pointer-event (touch) panel resizing, and safe-area insets so the toolbar clears the system status bar
- [x] Download Offline Area tool that pre-caches the current map view's basemap tiles into the service-worker cache
- [x] Service-worker caching of the CDN-loaded Pyodide and PGlite/PostGIS engines so browser SQL and Python keep working offline after first use

## v1.4: Jupyter beside the map, spectral indices, georeferencing, and field collection

- [x] Resizable, collapsible Notebook panel docked beside the map: the web build embeds a self-hosted JupyterLite site (in-browser Pyodide kernel) and the desktop build launches a uv-managed JupyterLab server, both seeded with a runnable Welcome tour. Notebook cells drive the live map through the shared scripting bridge via an auto-loaded `geolibre` client, and the JupyterLite theme follows the app theme — see [Notebook Panel](notebook.md)
- [x] Spectral Index toolbox under Processing → Raster (NDVI, GNDVI, NDWI, NDMI, NDBI, NBR, EVI, and SAVI) with Sentinel-2, Landsat 8-9, NAIP, and custom band layouts and a reflectance-scale knob, evaluated client-side via geotiff.js or on the rasterio sidecar through the existing raster calculator
- [x] Raster Georeferencer (Processing → Georeferencing): pin a non-georeferenced image to the map with ground control points, using a least-squares affine fit and per-GCP and RMS residuals, added as a corner-pinned overlay that persists in the project and works offline
- [x] Field Collection tool (Controls menu) for capturing point, line, and polygon observations with a per-layer custom form (text/number/date/choice fields and an optional inline photo), placed by device GPS or by tapping the map, with a floating quick-open control; captures are written to a tagged GeoJSON layer that flows into the attribute table, export, and offline use
- [x] Runtime overrides for `VITE_PYODIDE_INDEX_URL` and `VITE_DUCKDB_SPATIAL_EXTENSION_PATH` through the existing runtime-environment system, so air-gapped or corporate deployments can point Pyodide and the DuckDB Spatial extension at internal mirrors without rebuilding the app

## v1.5: Dashboards, in-browser Whitebox, map navigation history, and signed macOS installers

- [x] Dashboard panel of chart widgets that summarizes the loaded layers at a glance, with configurable charts and a collapsible layout that docks alongside the map
- [x] Whitebox toolbox now runs entirely in the browser through a WebAssembly runtime with raster I/O, so its tools (and GeoLibre's own WASM raster tools, now surfaced in the same toolbox) work with no Python sidecar
- [x] Print layout composer gained an explicit map-scale input, a title block with editable title and footer, page-size controls, and a custom print extent, with more reliable preview rendering for production-quality PNG and PDF map exports
- [x] Time Slider can bind existing vector layers already on the map to the timeline, animating their time-series attributes without re-importing the data
- [x] New View menu with viewport history navigation (step back and forward through previous map extents), a reset pitch and bearing control with a rotation indicator, a distinct north arrow in place of the ambiguous compass, a lock indicator when map bounds are restricted, and a refined default set of top-right map controls
- [x] Saved service library for web-service layers, so frequently used WMS, WFS, XYZ, and ArcGIS endpoints can be stored once and re-added with a click rather than re-entered each session
- [x] Add Data dialog is now fully internationalized and accepts comma decimal separators and drag-and-dropped CSV files for coordinate data
- [x] Inspect COG pixel values directly from the Identify icon, plus reversed and custom raster color ramps, the full colormap list, and a styling panel you can reopen from the layer actions menu
- [x] Customizable UI profiles that tailor which menus, panels, and data sources are visible, so a deployment can present a focused subset of the app to its users (see [UI Profiles](ui-profiles.md))
- [x] Bookmarks now capture the active layers alongside the camera, with selectable export, a resizable and reorderable panel, and a save-as name prompt
- [x] Sequential route (directions) network tool under Processing for computing routes through an ordered set of waypoints
- [x] Protomaps basemaps in the New map dialog, support for stacking multiple raster basemaps, and basemap element visibility presets in the layer control
- [x] Spinning Globe panel under Atmospheric Effects and customizable atmosphere halo and deep-space colors for the globe view
- [x] Notebook panel can split the workspace 50/50 with the map and auto-collapse the Style panel for more room, and the attribute table gains a column explorer for finding and toggling fields in wide tables
- [x] USGS LiDAR plugin replaces the previous LiDAR Viewer for browsing and loading USGS 3DEP point-cloud data, imported KML and KMZ layers honor their embedded symbology, and vector strokes can be sized in scale-proportional meters
- [x] macOS desktop installers are now signed with an Apple Developer ID certificate and notarized by Apple, so they open without a Gatekeeper workaround, with a generator for submitting GeoLibre to the official Homebrew cask (see [Downloads](downloads.md))

## v1.6: Multi-map layouts, advanced symbology and labeling, and plugin zip install

- [x] Multi-map grid that splits the workspace into a grid of map views with synchronized camera movement, so you can compare basemaps, layers, or time steps side by side
- [x] Advanced vector symbology with a rule-based renderer (filter-driven style rules), proportional symbols, fill patterns, and a built-in marker library for richer point and polygon styling
- [x] Label engine that labels vector features by any attribute, with placement and styling controls
- [x] Install external plugins from an uploaded zip on both desktop and web, alongside the existing manifest-URL and bundled drop-in paths, with the Manage Plugins list now sorted alphabetically
- [x] New vector analysis tools under Processing → Vector for movement, space-time, and cell-coverage analysis
- [x] Sample-data dropdowns standardized across every Add Data dialog, so each upstream-backed panel offers ready-to-load example datasets
- [x] Search places box in the Layers panel footer for geocoding to a location without leaving the panel
- [x] Accent color schemes beyond light and dark, so the UI theme can be tinted to a chosen accent color
- [x] Swap the core basemap by double-clicking it in the layer panel
- [x] Story map presenter gained a Reset button and auto-collapses the side panels while presenting for a cleaner full-screen story
- [x] Progressive Share setup that separates the website and local token steps for a clearer first-time configuration
- [x] Interactive sidecar help banners for the Whitebox toolbox and AI Segmentation that guide you when the Python sidecar is not running or fails to start
- [x] Guided update workflow with a startup update check, update preferences, and clearer status colors
- [x] Time Slider defaults an unspecified end date to the current date
- [x] Windows Package Manager (winget) packaging as `OpenGeos.GeoLibre`, so the app can be installed and updated through winget
- [x] [Microsoft Store](https://apps.microsoft.com/detail/9nwt67rv531x) listing, so Windows users can install the signed, auto-updating build directly from the Store (see [Downloads](downloads.md))

## v1.7: Plugin UI host API, color ramp previews, and category-browsed Whitebox tools

- [x] Plugin UI host API that lets plugins register first-class right-sidebar panels, toolbar menus, and floating panels that dock beside the built-in Style panel instead of emulating an overlay, with external plugin toolbar menus now placed after the Help menu (see [Plugin API](plugin-api.md))
- [x] Color ramp gradient swatches in both the vector Style panel and the raster Color ramp picker, so you can see each colormap's gradient inline (on the trigger and beside every option) while choosing rather than picking from a plain list of names
- [x] Richer vector labeling with ArcGIS-style controls (anchor, X/Y offset, rotation, wrap width, and letter case), a Duplicate labels option, and unique/concatenate modes that collapse points stacked at the same coordinate into a single deduplicated label
- [x] Whitebox toolbox is now browsable by category directly in the Processing menu, with nested subcategory submenus, GeoLibre's own WASM tools grouped under their own subheading, an offline-bundled tool catalog for restricted environments, and tools that open the dialog preselected and scrolled into view
- [x] On-canvas collaboration session-status badge and roster (a pulsing live dot, connected-participant count, and an expandable client list that announces joins and leaves), plus a clear "Go to map and collaborate" button so the host has a non-destructive way back to the map
- [x] Welcome wizard is suppressed for embeds: project deep links (`?url=`) skip onboarding automatically, and a new `?welcome=0` parameter lets any embed opt out

## v1.8: Camera tours, live story maps, standalone HTML export, and map annotations

- [x] Record an animated camera tour to video straight from the Controls menu, with a clearer keyframe layout, per-keyframe recapture, a two-step save, and the ability to save and reload the entire tour setup as a JSON file
- [x] Story Map plugin can now compose its chapters directly on the live map instead of a separate editor, and generates a printable PDF handout of the finished story
- [x] Export a project to a single standalone interactive HTML file that runs offline with no server, plus a project gallery for browsing and opening shared projects with one click
- [x] Map annotation layer for drawing text, arrows, and highlights directly on the map, persisted with the project
- [x] Gridlines overlay (renamed from Graticule) draws a coordinate grid with edge labels across the map
- [x] Import geotagged photos as a point layer from their EXIF GPS, with manual placement and drag-to-position for photos that have no embedded coordinates
- [x] GeoRSS feed support in Add Data, loaded from a URL or a local file
- [x] EOX Sentinel-2 cloudless satellite imagery and Openbasiskaart added to the basemap library (Openbasiskaart via basemap-control 0.7.0)
- [x] Right-click context menu on the map for reading coordinates and reaching quick actions without leaving the canvas
- [x] Per-participant permissions and an in-app chat panel for real-time collaboration sessions
- [x] Organize bookmarks into folders for tidier, grouped saved views
- [x] Dedicated AI Providers section in Settings with per-feature provider dropdowns for choosing and configuring AI backends
- [x] Plugin API can now register native raster and tile layers, and offers a shared-rail (replace-style) right-panel dock mode for plugin panels (see [Plugin API](plugin-api.md))
- [x] Time Slider draws a pixel time-series chart for raster stacks, plotting a sampled pixel's value across the timeline
- [x] Colorbar panel gains a stacking direction control, a resizable panel, and a stack-order fix for multiple colorbars
- [x] Persistent mode banner for the Directions and Reverse Geocode tools so the active interaction mode stays visible
- [x] Copy to Clipboard added to the Print Layout composer for pasting the rendered map straight into other apps
- [x] Clearer Set view coordinate input workflow with support for degrees-decimal-minutes (DDM) entry
- [x] Raster paint controls gain a greyscale toggle, a reset action, and numeric inputs, plus info icons explaining layer zoom-visibility controls
- [x] Inline numeric opacity input in the layer control, with a fixed-name notice on the Background layer
- [x] Windows portable zip build, so the desktop app can run without installation

## v1.9: CAD import, smarter service discovery, and a docked SQL workspace

- [x] Add CAD drawings (DXF/DWG) as a layer, with a layer picker for choosing which drawing layers to load and a CRS selector for placing the geometry correctly on the map
- [x] WMS and WFS panels now read the service's GetCapabilities document to list the available layers and feature types, so you pick from a populated dropdown instead of typing layer names by hand
- [x] Generic Vector to Vector conversion tool that converts between any supported vector formats by file extension, alongside the existing targeted converters
- [x] SQL Workspace docks as a resizable panel beside the map (rather than a floating window) and gains editor autocomplete for tables, columns, and SQL keywords
- [x] Camera tours gain per-keyframe hold and transition duration controls for finer pacing, plus the ability to save and reload a named tour setup
- [x] Story Map plugin adds a hide-itinerary toggle, subtitle and byline fields on the printable handout, and dedicated start and closing slides for a more polished presentation
- [x] Transparent fill and outline option in the color picker, so features can be styled with no fill or no stroke without leaving the picker
- [x] Plugins can now use the maplibre-gl-raster stack and the projection control, expanding what external plugins can render and configure (see [Plugin API](plugin-api.md))
- [x] Legend populates automatically from a paletted raster's embedded color table, matching the map colors without manual entry
- [x] Website and GitHub links added to the Help menu for quick access to the project home and source

## v1.10: I3S scene layers, OGC API vector tiles, and local NetCDF/HDF loading

- [x] Add ArcGIS I3S scene layers (Integrated Mesh and 3D Object layers) as a data source, streamed and rendered in 3D on the shared deck.gl instance through a Tile3DLayer with the I3SLoader
- [x] Add Data now supports OGC API - Tiles vector tile services as a remote source, so standards-based vector tile endpoints can be added alongside XYZ and ArcGIS vector tiles
- [x] Load local HDF5 and NetCDF-4 files directly from disk, extending the NetCDF/HDF workflow beyond Cloud-Optimized references to files already on your machine
- [x] GeoEditor plugin can pull the vector features currently visible in the map view into the editor, so you can start editing what you are looking at without re-importing the source data

## v2.0: A 3D globe, planetary mapping, symbology interchange, and editable source layers

- [x] Switch any map pane to a **CesiumJS 3D globe** view that stays camera-synced with the 2D maps and mirrors the layer stack, adding a true photorealistic globe alongside the flat workspace (requires a Cesium Ion token)
- [x] Planetary mapping with the OpenPlanetaryMap basemap set (Mars and the Moon) plus USGS Astrogeology basemaps for Mercury, Venus, the Galilean moons, Titan, Pluto, and Charon reprojected to Web Mercator, a per-project ellipsoid whose radius drives distance/area/scale, and a planet switcher in the Layers panel, plus an expanded EOX Maps catalog and dark-mode-aware basemap theming
- [x] Import and export vector layer symbology as OGC SLD, QGIS QML, and Mapbox GL style JSON, so styles round-trip between GeoLibre, QGIS, and the Mapbox/MapLibre ecosystem
- [x] Edit vector layers and write the changes back to their source, covering GeoPackage and GeoJSON files as well as PostGIS database tables
- [x] New Weather menu with live cloud and precipitation radar overlays (RainViewer), a Clouds overlay in the Controls menu, and a Google Earth-style sun position simulation for realistic lighting
- [x] Richer KML/KMZ support: render GroundOverlay images as map overlays (animated through the Time Slider when time-tagged) and display embedded Collada (.dae) 3D models
- [x] Render vector layers that carry Z coordinates in true 3D rather than flattening them onto the ground plane
- [x] Extract COG, WMS, and XYZ bounding-box subsets directly in the browser, and build a normalized-difference index from any HTTP COG
- [x] New built-in plugins: a Mapillary coverage and street-level image viewer, a Historical Imagery panel, and an Elevation Profile tool, plus a UTM easting/northing grid mode for the Gridlines overlay
- [x] Field Calculator can compute geometry length and area, and the attribute table supports Ctrl- and Shift-click multi-row selection
- [x] Google Earth-style camera-reset keyboard shortcuts, View in Google Maps and View in Google Earth actions, and a double-click terrain control for setting vertical exaggeration
- [x] Import delimited text (CSV) without coordinates as a standalone attribute table
- [x] All 13 locale catalogs completed, with the remaining hardcoded panel and dialog strings migrated to the translation system
- [x] The AI assistant can read provider API keys from OS environment variables, and the desktop diagnostics network log now captures native Tauri HTTP requests and classifies failed `fetch()` errors

## v2.1: A data-source Browser panel, route animation, in-browser object detection, and map recording

- [x] A QGIS-style **Browser panel** (Data Source Manager) for exploring and adding data from one place: browse map Services and Recent items, connect to PostGIS databases and browse their schemas and tables, drill into local files, save and reopen Favorites, add a New connection per service kind, and navigate the whole tree from the keyboard
- [x] **Route animation**: animate a marker along any line layer, follow the track in 3D with camera controls, and export the whole animation as an MP4 video
- [x] **In-browser object detection** that runs ONNX/YOLO models directly in the webview, no server or Python required
- [x] Record the map canvas (or a drawn bounding box) to a video file straight from the browser
- [x] A true native-resolution viewer for geotagged photos, so full-detail imagery stays crisp on the map
- [x] Wikipedia knowledge cards: click a place on the map to pull up its Wikipedia summary and info card
- [x] USGS planetary basemaps for nine more celestial bodies, extending the planetary mapping catalog
- [x] New OpenAerialMap plugin for searching open aerial imagery, plus a GEBCO ocean-bathymetry WMS sample with proper attribution
- [x] New Source Cooperative plugin for browsing [source.coop](https://source.coop) open data: search the catalog, walk a product's files, and add GeoParquet, PMTiles, COG, GeoJSON, and FlatGeobuf straight to the map (streamed from the source) or download them
- [x] The Whitebox toolbox is now a floating panel, and Processing subset tools can populate their bounding box from the current map view
- [x] Scale bar switches between metric, imperial, and nautical units
- [x] Bundled plugin drop-ins can set `activeByDefault` in their manifest, deployments can opt out of the welcome dialog, and the app now defaults to the Advanced interface and skips the welcome dialog on first run
- [x] Optional HTTP Basic Auth for the web (Docker) container

## v2.2: A styling overhaul, expression-driven fields and labels, print atlas, and browser-native conversions

- [x] A **rule-based renderer** with per-rule symbol properties, scale-dependent visibility, nested rules, and per-rule toggles, so a single layer can carry a full hierarchy of styling rules and hide anything that matches no rule when the else rule is off
- [x] A **Style Manager** that saves reusable symbol, color-ramp, and label presets to a personal library and applies them across projects
- [x] A symbology pack covering inverted-polygon masks, arrow and marker lines, and geometry generators (with attribute-driven centroid size and buffer distance), plus data-driven proportional sizing for marker icons
- [x] **Diagram symbology**: draw pie, donut, and bar charts on features straight from their attributes
- [x] A **data-defined labeling engine** with expression-driven label properties, placement priority, and full control over how labels are drawn
- [x] A shared **Expression Builder** — a function reference, searchable field list, live preview, and reusable variables — wired into filters, labels, styling, and selection
- [x] **Virtual fields**: expression-backed computed columns that update as the underlying data changes, plus a Raster Attribute Table for single-band categorical rasters
- [x] An **attribute form designer** with edit widgets, validation constraints, and conditional field visibility for structured data entry
- [x] **Persistent attribute joins** configured in layer properties, so a table can enrich a layer's features and stick across sessions
- [x] **Select by Expression** and **Select by Location**, plus live query layers backed by DuckDB SQL that re-run as the data updates
- [x] **Atlas / map series** in the Print Layout — generate one page per feature, or a uniform series of pages along a line such as a river or trail — and drop attribute-table and chart blocks onto the page
- [x] Browser-native format conversion for COG, FlatGeobuf, Shapefile, and GeoPackage, and Vector to PMTiles running on a background worker, no Python sidecar required
- [x] **Live GPS tracking**: a moving position marker, a recorded track log, and digitizing new features straight from the GPS feed
- [x] Data quality tools to check validity, fix geometries, and check topology rules, catching and repairing bad geometries before they cause trouble
- [x] A **Processing History** panel that lists every tool run, re-runs it with one click, and copies the equivalent Python code
- [x] Timelapse mode now animates EOX Sentinel-2 cloudless annual basemaps and NASA GIBS providers (Landsat/WELD and MODIS land cover) with a provider picker and legend
- [x] Desktop gains OS trust store and mTLS client-certificate support for native HTTP, automatic reload when local files change on disk, and Esri File Geodatabase (`.gdb`) layer support
- [x] New Natural Earth and Source Cooperative data browsers under Plugins > Web Services, including opening or streaming large GeoParquet from Source Cooperative
- [x] Terrain-aware 3D measurements in the Measure tool, optional title/source captions and on-map panel capture (HTML, legend, colorbar) in video recordings, and a new Georgian locale alongside full Arabic right-to-left support

## v2.3: An on-map Legend panel, iOS and Google Play, the GeoLens catalog, and space-time hot spots

- [x] An auto-generated **Legend panel** on the map that derives itself from the visible layers' symbology — per-class rows for graduated, categorized, rule-based, and expression styling, gradient bars for heatmaps and continuous raster colormaps, proportional-symbol size ramps, diagram fields, and land-cover labels read from a Raster Attribute Table — with an edit mode for renaming, hiding, and reordering entries, adding a section from a color dictionary, choosing a corner, collapsing sections, resizing the panel, and exporting the rendered legend as JSON, all saved with the project and shared with the Print Layout legend
- [x] **Symbology swatches in the Layers panel**: every row carries a dot, line, square, or image glyph colored from the layer's own styling, dimmed when the layer is hidden, so a tall layer stack reads at a glance
- [x] A new **GeoLens catalog browser** plugin for connecting to a self-hosted [GeoLens](https://github.com/geolens-io/geolens) server, searching its catalog, and adding datasets as signed vector tiles, OGC API Features GeoJSON, or server-rendered raster tiles, with automatic tile-token refresh and a Metadata link back to each dataset's page
- [x] **iOS support**, scaffolded end to end — Tauri iOS configuration, location permissions, a signing and TestFlight CI workflow, and a publishing guide. See [iOS](ios.md)
- [x] The **Android build is Google Play-ready**: a permanent `org.geolibre.app` package id, API level 36, 16 KB page-size alignment verified in CI, and a signed universal App Bundle published alongside the per-architecture sideload APKs. See [Android](android.md)
- [x] **Emerging Hot Spot Analysis**: aggregate timestamped points into a space-time cube, run Getis-Ord Gi\* per time slice, and classify every cell as a new, intensifying, persistent, diminishing, sporadic, oscillating, or historical hot or cold spot, entirely in the browser
- [x] The Time Slider animates **mosaic sources** — a MosaicJSON or STAC collection of many COGs per date — rendered as a full spatial mosaic through either the GPU or the WASM engine, with the WASM engine working in globe as well as mercator projection
- [x] **Copy and paste layer styles** between layers from the layer menu, so a set of vectors or rasters can be given one consistent look without restyling each in turn
- [x] **Multiple named AI profiles**: define several provider, model, and credential combinations, mark one as the default, and switch between them from the assistant panel
- [x] **Deep-link any Whitebox tool** with a `?tool=` URL parameter that opens the Processing dialog preselected and pre-fills the tool's form from the remaining query parameters, plus a Copy link button that builds a shareable link from the settings you changed
- [x] Add Data gains a source **CRS field for delimited text**, so CSVs with projected easting and northing columns land in the right place, and a **layer picker for multi-layer GeoPackages**, so a container full of feature tables adds only what you asked for
- [x] The layer metadata dialog reports a raster's real georeferencing read from the GeoTIFF header — CRS and EPSG code, pixel size and extent in CRS units, data type, nodata, compression, tiling, and overviews — in a resizable dialog
- [x] Type a coordinate into the place-search box to fly straight to it, in decimal degrees, DMS, or DDM, with no geocoder round-trip
- [x] A new Random extract vector tool, the active layer now persists with the project, turning on the Terrain control enables 3D relief immediately, and a Logos submenu adds Maptoolkit branding alongside the MapLibre logo

## v2.4: STAC and Earthdata catalogs, a free-flight camera, a timeline for tiles and data cubes, and a live embed API

- [x] A new **STAC catalogs browser** plugin that discovers public SpatioTemporal Asset Catalogs from STAC Index, connects to both static catalogs and STAC APIs, searches a collection's items, and adds any visualizable asset — COGs, GeoJSON, and the rest — straight to the map, so working with STAC no longer means leaving the app to hand-copy asset URLs
- [x] A new **Earthdata GIS browser** under Plugins > Web Services that searches NASA's EOSDIS ArcGIS portal and renders its imagery, map, and feature services, and its published web maps, as first-class layers, with the mosaic pixel-size limits that used to return blank tiles handled for you
- [x] A new **Hugging Face** panel that browses the Hub: search datasets or name an account, walk a repo's folders, and add its vector and raster files to the map through the readers that already handle each format — and go the other way, creating a dataset repo and uploading layers to it from inside GeoLibre
- [x] A **flight simulator**: a continuous, interactive free-flight camera you steer over terrain and 3D layers with the keyboard, instead of declaring a destination and watching a scripted `flyTo`
- [x] The **Time Slider now animates tiled data**: vector tiles, PMTiles, and MBTiles can be bound to the timeline and animated over their full extent, with the timestamp field detected from a live tile sample rather than requiring a local copy of the data
- [x] The Time Slider also drives a layer's **own internal time dimension** through a generic temporal adapter, so a data cube such as a Zarr store joins the shared timeline instead of carrying its own bespoke time control, and the binding is saved with the project
- [x] **Zarr gets a real Add Data path**: an Add Zarr Layer dialog for remote stores or a folder on disk, variable and dimension pickers that offer the store's actual coordinate values rather than raw indices, and a Selector field that now applies to a layer already on the map
- [x] **OGC API - Features** collections can be added as vector layers, the JSON-native successor to WFS, from whatever URL you have in hand — a landing page, `/collections`, or a full items URL
- [x] A versioned **`postMessage` API for host pages** that frame GeoLibre: load a project, move the camera, highlight features, and open a processing tool at runtime, with `ready`, `projectLoaded`, `selectionChanged`, `viewChanged`, `toolCompleted`, and `serverFileWritten` events coming back out. Off unless the deployment names its trusted origins. See [Embedding & Sharing](user-guide/embedding.md#talking-to-the-map-at-runtime)
- [x] **Jupyter clients outside the app can drive the map**: attaching VS Code's Jupyter extension, `jupyter console`, or nbclient to the desktop app's Jupyter server now makes `fly_to`, `add_geojson`, and the rest work, because the transport follows the kernel's server rather than how the notebook happens to be displayed
- [x] A new **H3 hexagonal grid plugin** that renders the H3 grid over the current view at a chosen resolution, identifies a cell to inspect its index, parent, children, neighbors, and center, and exports the grid or the selection as GeoJSON or CSV — plus typing an **H3 cell index** into the place-search box, as a hexadecimal string or a 64-bit integer, to frame and outline that cell
- [x] **Object detection on geotagged photos**: run the in-browser ONNX/YOLO models over an imported photo layer, not just map imagery
- [x] The AI assistant gains a **model picker in the panel itself**, refreshed model lists for every provider, credentials that survive a provider change, and arrow-key recall of previous prompts
- [x] **Indicator (KPI) tiles in the Dashboard panel**: a big-number widget with count, sum, mean, min, max, or median aggregation and custom prefix and suffix, alongside the existing chart widgets
- [x] **Editing GeoLens datasets in place**: a dataset added as GeoJSON can be redrawn with the GeoEditor or retyped in the attribute table, and the plugin's Edits section shows what changed and writes it back to the GeoLens dataset — added, moved, and deleted features become per-feature `POST`/`PUT`/`PATCH`/`DELETE` calls, with the row ids GeoLens assigns stamped back onto the layer. Private GeoLens rasters also render now, with the API key attached to exactly their tile URLs and nothing else
- [x] Plugins can call `addZarrLayer` to use the Zarr renderer GeoLibre already ships instead of bundling their own, keep their own paint properties on custom layers so the Style panel's sliders actually do something, and expose layer groups of their own
- [x] GeoLibre is on **[Google Play](https://play.google.com/store/apps/details?id=org.geolibre.app)**, so Android users can install the signed, auto-updating build in one tap instead of sideloading an APK (see [Downloads](downloads.md#android-installation))
- [x] GeoLibre Desktop is on the **[Mac App Store](https://apps.apple.com/app/geolibre-desktop/id6796848769)**, a sandboxed build of the same app that installs and updates through the Store. It trades the Python sidecar engines, server-backed PostgreSQL/PostGIS layers via martin, the local Jupyter server, Earth Engine sign-in, and external plugin installs for that convenience, so the Homebrew and DMG builds remain the full-feature route (see [Downloads](downloads.md#mac-app-store))
- [x] Linux **AppImage releases now carry update information and a `.zsync`**, so AppImageUpdate, AppImageLauncher, AppManager, and AM can update the app and transfer only the blocks that changed instead of the whole download
- [x] All 15 non-English locales are back at 100% coverage, Georgian included

## v2.5: QGIS and ArcGIS Pro project import, discrete global grids, hyperspectral cubes, and a self-hostable server

- [x] **QGIS project import**: open a `.qgs` or `.qgz` and get its layers, nested groups, group visibility, layer order, styling, and saved map view rebuilt in GeoLibre, with a per-layer report of anything that had to be skipped rather than an all-or-nothing failure. See [Projects](user-guide/projects.md#importing-a-qgis-project)
- [x] **ArcGIS Pro project import**: `.aprx` and `.mapx` files are read straight from their CIM JSON without ArcPy, restoring the first 2D map's extent, local vector and GeoTIFF layers, nested groups, visibility, simple symbols, field labels, vector-tile portal items, and cached map services. See [Projects](user-guide/projects.md#importing-an-arcgis-pro-project)
- [x] **Discrete global grid systems** arrive as three new plugins under Plugins > DGGS — **A5**, **DGGRID**, and **DGGAL** — that render the grid over the current view at a chosen or automatic resolution, identify a cell to read its id, parents, children, neighbors, and center, and add the grid or the selection to the map as a layer or export it
- [x] **DGGS processing tools** to match: a DGGS Generator that fills an extent with cells, DGGS Binning that aggregates a point layer into them, and DGGS Compact that collapses a full set of children into their parent
- [x] **Hyperspectral NetCDF and HDF grids become readable data rather than a single grey band**: local grids are colormapped in the browser from the same catalog the Style panel uses, the camera fits to the layer on add, and a cube gains an RGB band combination picked by wavelength
- [x] **A 3D image cube view** renders a hyperspectral scene as its six exterior faces with draggable slice cuts, so a volume can be read as a volume — windowed and strided reads keep a full EMIT reflectance variable within what the browser can hold
- [x] **Spectral profiles from a click**: identify a pixel on a NetCDF layer to read its value, walk the band axis to chart its spectrum against wavelength, and compare up to six sampled points, each marked on the map as a numbered dot in its chart color, in a floating draggable window that exports as PNG or CSV
- [x] **Sharing, accounts, and live collaboration can now be self-hosted**: the projects and identity contract is written down, with a FastAPI reference implementation and a plain Node collaboration relay sharing one session core, and a single conformance suite runs against both relays so their permission behavior cannot drift. See [Server API](server-api.md)
- [x] A published web image can be **pointed at that server at runtime** through `GEOLIBRE_SHARE_URL` and `GEOLIBRE_COLLAB_URL`, instead of forking the image to rebuild it, with `off` removing Share and the Project Gallery entirely and a malformed value refusing to boot rather than quietly uploading projects to the public hosted service
- [x] **Smart styling on add**: each new vector layer takes the next unused color from a qualitative palette with sizing that follows its dominant geometry, so a freshly loaded stack is legible before the Style panel is ever opened, and a dismissible **Style suggestions** strip offers up to three one-click renderers derived from the layer's own attributes
- [x] **Vector-tile layers can be classified by their tile attributes**: PMTiles, MBTiles, and remote vector tiles carry no local features, so the Style panel now samples what the viewport has already loaded to fill in the field list and the classifier's values, and 3D extrusion defaults to a real height property
- [x] **Quick analysis** from the map's right-click menu and a layer's actions menu: buffer the clicked point at three distances or drive and walk isochrones from it, and buffer, centroid, convex hull, or bounding-box a whole layer, with defaults filled in and every run landing in Processing History, re-runnable and copyable as Python
- [x] An **Elements panel** that lists the map's annotations — text, arrows, rectangle, ellipse and freehand highlights, pin markers, sticky notes, and placed images — so each one is managed from a list instead of hunted for on the canvas, with a placed image optionally pinned to an extent so it scales with the view. See [Annotations and the Elements panel](user-guide/map-controls.md#annotations-and-the-elements-panel)
- [x] A **Layer Library**: save a fully configured layer, with its source, style, labels, filters, joins, virtual fields, and attribute form, then re-add it to any later project in one click from the Browser panel's My Data section, and export the library as a JSON bundle to share with a team
- [x] **Project duplication, templates, and open-a-copy**: duplicate a project, save one as a reusable template that keeps the basemap, groups, styles, legend, widgets, and layout while stripping the data, and open a copy of anything in the gallery
- [x] **Live layer connections persist with the project**: the refresh cadence, last-synchronized time, last error, and on-failure policy for WFS, GeoJSON URL, and Add Vector Layer URL layers are saved as a `connection` record, so a reopened project keeps refreshing on schedule and the Layers panel shows each live layer's status
- [x] **Open-data catalog browsers** for **ArcGIS Hub**, **Socrata**, and **CKAN** (Humanitarian Data Exchange) under Plugins > Web Services: search public dataset catalogs by keyword, restrict an ArcGIS Hub search to the current map area, page through results, and add a dataset to the map or download it
- [x] **Geocode a CSV at import time**: the Delimited Text panel gains an Addresses mode that concatenates the columns you pick and geocodes each row through the project's provider, keeping unmatched rows as null-geometry features so they stay visible and fixable in the attribute table rather than being silently dropped
- [x] A **CartoCiudad (IGN España) geocoding provider** for forward and reverse geocoding against Spain's official address data, with no API key
- [x] **KML and KMZ layer export**, so a styled layer can go back out to Google Earth, and **KML Super-Overlay import**, which serves a `NetworkLink`-driven tile pyramid to the map instead of loading the whole thing at once
- [x] A **Dashboard selector widget** that turns a categorical field into a set of chips and cross-filters every other widget bound to the same layer, in single- or multi-select mode
- [x] **GPS Tracking reads an external NMEA receiver** over Web Serial or Web Bluetooth, with a baud-rate picker and a live sentence and fix counter, alongside the device's own geolocation. See [GPS tracking](user-guide/map-controls.md#gps-tracking)
- [x] The Processing dialog stops asking users to translate on their behalf: distance parameters on WGS84 vector layers get a **metric unit picker** that converts to the degrees the tool actually reads, EPSG parameters get a **searchable CRS catalog** grouped into Geographic and Projected, and Download OSM Vector's four boundary numbers become one **Area of interest** control with Use map extent and Draw on map
- [x] **GeoLibre Desktop is on the [Mac App Store](https://apps.apple.com/app/geolibre-desktop/id6796848769)**, a sandboxed build of the same app that installs and updates through the Store. See [Downloads](downloads.md#mac-app-store)
- [x] **GeoLibre is on the [App Store](https://apps.apple.com/app/geolibre/id6796039674)** as a native iPhone and iPad app, built from the same codebase via Tauri v2 mobile and approved by App Store review, so iOS users install and update it in one tap. See [iOS](ios.md)
- [x] The `geolibre` Python package gains **leafmap-parity helpers**: local raster, marker and cluster, and choropleth layers, `split_map`, `add_legend`, and `add_colorbar`, typed read-back of selected and drawn features, and `to_html` export. See [Python package](python.md)
- [x] **Thai** joins the shipped locales, bringing the catalogs to 16 languages besides English
- [x] Vector export honors the fields you hid in the attribute table, plugins can read a pixel off a native Zarr layer with `queryZarrLayer`, layers move into a group as a whole selection, and the print extent can be drawn by touch

## v2.6: Data and style deep links, an MCP server for AI clients, COG-backed terrain, and a design system of its own

- [x] **Deep links can carry the data itself**: `?data=` opens a hosted GeoJSON, GeoParquet, COG, PMTiles, a REST endpoint returning a FeatureCollection, or a ZIP of GeoJSON files without publishing a project file first, `?style=` applies vector or raster symbology beside it, and a compact GeoLibre style export makes that style file easy to produce from a layer already on the map. See [Embedding & Sharing](user-guide/embedding.md)
- [x] **ArcGIS MapServer and ImageServer join Add Data**: the two service types that serve rendered images load as ordinary raster layers, so opacity, the Style panel's brightness, contrast and saturation controls, reordering, and project save and reload all work on them, drawing tiles from the service's own fused cache where it was built on the standard Web Mercator scheme and from `/export` or `/exportImage` otherwise. Sublayers are browsed and picked from the service's own list rather than typed in as ids, and an ImageServer rendering rule is one field away
- [x] **A Cloud Optimized GeoTIFF can drive 3D terrain**: terrain was locked to the global AWS Terrarium tiles, so higher-resolution local elevation could not shape the hillshade. Terrain settings now accept a single-band EPSG:3857 or EPSG:4326 COG over HTTP or from a local file, read in ranges and encoded to Terrarium tiles through a custom MapLibre protocol
- [x] **Regional basemaps, starting with China**: GeoLibre's defaults are hosted outside mainland China with no presence inside it, so from there the picker offered nothing that loads. A collapsed **Regional** section in both the New Project and Change Basemap panels adds five keyless Chinese basemaps (高德地图, 高德卫星, 高德混合, 腾讯地图, 腾讯深色), with the same providers plus Tianditu in the Basemaps control plugin, and the section is driven by a table in core so a second region is an entry rather than another dialog change
- [x] **The basemap you picked is the one you come back to**: an empty startup workspace seeds from your last selected basemap, while a project's own basemap stays authoritative and planetary bodies keep their ellipsoid behavior
- [x] **Collaboration snapshots are portable**: a guest could join a session and see an empty map, because snapshots kept local file references and control-managed vector data the collaborator cannot read. Shared layers now embed their features, a host seeds the first snapshot instead of waiting to make an edit, guests arrive at the host's viewport, and the session Copy button yields a joinable URL. See [Collaboration](collaboration.md)
- [x] **Map comments become navigable**: clicking a pin on the map reveals, highlights, and scrolls to its card, the panel ships collapsed on the Style rail so it is discoverable, `C` places a new comment from the command palette, and comments are saved with the project. See [Review comments](user-guide/map-controls.md#review-comments)
- [x] **An MCP server for authoring projects**, `geolibre-mcp`: a headless stdio server that lets an AI client write real `.geolibre.json` files with no browser and no running app, composing them from the same builders the Python package already uses, so anything it writes opens unchanged in the desktop app, the web app, and the Jupyter widget. Every read and write is confined to the roots given by `--root` or `GEOLIBRE_MCP_ROOTS`. See [MCP server](mcp.md)
- [x] **The Python package manages layers and moves the camera without a browser round trip**: reorder, duplicate, rename, and remove layers, read attribute values, and frame the map as plain project mutations on `Map` and `Layer`, with the authoring helpers exported for scripts that never display a widget, and credentials swept out of anything a notebook cell might print back. See [Python package](python.md)
- [x] **Whitebox tools run from the Jupyter widget**: `list_whitebox_tools` and `run_whitebox_tool` reach the bundled WASM catalog over the same channel the camera and the client-side algorithms already use, resolving `Layer` handles to layer ids and adding both vector and raster outputs back to the map, so terrain and raster work no longer means leaving the notebook for the UI
- [x] **Topological polygon digitizing**, so a polygon drawn against its neighbor shares that edge instead of leaving a sliver or an overlap behind
- [x] **Print Layout gains an intersecting page filter**, so an attribute-table block can list every feature the page touches rather than only the ones that fall wholly inside it, correct across the antimeridian and for a view panned several world copies from home
- [x] **Story map PDF handouts get clickable location markers**: each chapter page carries a pin drawn with its tip on the chapter camera's centre coordinate and a PDF link that opens that coordinate in Google Maps, taking the story's marker color, so a reader of the printed handout can navigate to the place
- [x] **A design system of the app's own, in place of stock shadcn**: self-hosted IBM Plex Sans and IBM Plex Mono so the interface reads the same everywhere instead of Segoe UI on Windows, Roboto on Linux, and SF on macOS; a real dark-mode elevation ladder where panels, dialogs, and menus had all shared one near-identical color; theme-aware shadows that were effectively invisible in dark mode; and a single map-glass treatment for chrome floating over the map, replacing eleven drifted copies of it
- [x] **Embeds can lead with the map**: a `panels=collapsed` layout keeps the Layers and Style icon rails reachable while starting both panels collapsed, and the top toolbar can be hidden outright for a focused viewer, giving a middle ground between panels open and panels gone. See [Embedding & Sharing](user-guide/embedding.md)
- [x] **An optional Clerk access gate** for hosted deployments that need individual sign-in, with an optional waitlist screen, loaded on demand and kept out of the default PWA precache. The gate is decided by the build target rather than by a client-controlled query parameter, and public, native, and embedded builds are unchanged. See [Getting started](getting-started.md)
- [x] **A no-external-CDN build** for deployments that cannot load from untrusted third-party hosts: `GEOLIBRE_NO_EXTERNAL_CDN=1` strips the GeoLibre-controlled CDN references, vendors the PGlite and CereusDB engines into the build rather than dropping them, and makes the few features that genuinely need a remote host say so up front instead of failing at the end of a run. See [Self-hosting](self-hosting.md)
- [x] **External plugins can query layers read-only**, reading the features a layer holds through the host rather than re-fetching and re-parsing the source themselves. See [Plugin API](plugin-api.md)
- [x] **Persian and Vietnamese join the shipped locales**, bringing the catalogs to 18 languages besides English, with Persian set in Vazirmatn and only that font's arabic subset shipped, so no other locale pays for it
- [x] Selecting a layer no longer pops the Style panel open over the map; it expands from an explicit **Open Style panel** item in the layer's menu instead

## v2.7: A visual Model Builder, STAC assets of every kind, a Chrome data opener, and selection by drawing (current)

- [x] **Processing workflows are drawn on a canvas**, ArcGIS Model Builder style: drop tools as nodes, wire an output into the next tool's input, and save the graph as a model that re-runs as one job, with the whole graph validated (cycles, missing connections, invented parameters, a string where a number belongs) before anything executes
- [x] **The AI assistant can author a model from a plain-English description** and open it on the canvas for review before it runs, drawing on the same palette as the canvas itself, so a raster chain such as fill depressions to flow accumulation to extract streams is a valid model. It asks before replacing unsaved canvas work or a run still in flight. See [AI assistant](user-guide/ai-assistant.md)
- [x] **A model copies out as a runnable Python script**, so a workflow built by pointing and clicking continues in the Notebook panel or JupyterLite rather than stopping at the canvas
- [x] **The STAC browser adds every asset type the app can draw**: PMTiles archives, GeoParquet tables, and Zarr stores with a variable picker join the COGs it already loaded, an Icechunk repository is read through its own manifest and keyed by branch rather than by repository alone, and Azure-hosted assets are signed at add time so a private Planetary Computer container opens like a public one
- [x] **A static STAC catalog can be browsed as a tree**, not only searched: walk its collections and sub-collections, open a folder to read it, and start a search from whatever you picked, flying to that collection's own extent
- [x] **Select features by drawing on the map**: QGIS-style click, rectangle, polygon, freehand, and radius gestures, with Shift and Alt combining the result into the existing selection and Clear selection sitting alongside them, so picking a handful of features means pointing at them instead of describing them in an expression
- [x] **Open data in GeoLibre**, a [Chrome extension](https://chromewebstore.google.com/detail/open-data-in-geolibre/joinecgbfoldanidcoakpjgkbaceaooj) on the Chrome Web Store, collects the dataset links and map services on the page you are viewing (WMS, WMTS, WFS, OGC API - Features, ArcGIS Feature Services, XYZ/TMS, and vector tiles, including services detected inside embedded maps and raw responses) and opens the ones you pick together on one GeoLibre map
- [x] **Apache Iceberg tables load as vector layers**, read in-browser through DuckDB's `iceberg` and `spatial` extensions from a table's metadata location or an attached REST catalog, reporting the table's true row count from the manifest before anything is scanned, taking the geometry column's CRS from the schema, and letting an optional SQL box decide which rows are rendered
- [x] **Three vector tools the client-side suite was missing**: Merge layers, with a multi-layer parameter picker that unites attribute schemas and can record each feature's source layer; Extract vertices, which turns every vertex into a point carrying its part and vertex index; and Points along geometry, which walks lines and polygon boundaries geodesically at a fixed interval
- [x] **Encoded polylines become a first-class format**: a codec for Google and OSRM precision 5 and Valhalla and Mapbox precision 6, with an interactive preview and coordinate inspector in Add Data, batch parsing with custom delimiters, processing tools, layer export at either precision, and matching support in the Python package
- [x] **An activity log for shared projects and collaboration sessions**: a project owner can read who opened and edited a shared project, and a session host can download the session log, bounded in both entry count and stored bytes and read through a bearer token rather than a URL query. See [Server API](server-api.md)
- [x] **Automatic editor tracking on a vector layer**: created-by, created-at, edited-by, and edited-at fields fill themselves in as features are added and changed, configured per layer and saved with the project. See [Project format](project-format.md)
- [x] **Building massing authoring**: sketch a footprint, give it a height, and get an extruded mass, with the extrusion style managed for you as massing features come and go and ordinary polygon sketches left flat
- [x] **The Elevation Profile plugin profiles the line features you have selected**, so a route already on the map is charted without redrawing it by hand
- [x] **Plugins and processing tools are translatable**: plugin display names resolve through one place, so a plugin no longer reads translated in the Plugins menu and English in the command palette, and every registry tool name, description, group label, parameter, and select option is generated into the English catalog for translators to work from. See [Internationalization](i18n.md)
- [x] **A PostGIS table with more than one geometry column stops being a guess**: every registered geometry column is offered in Add Data, validated against the PostGIS catalogs, and carried through read, save, and refresh
- [x] **A shared link can carry presentation settings**: `settingsUrl=` loads language, layout, accent theme, and UI profile before the first render, restricted to presentation fields so a link cannot inject credentials, plugins, or local paths, and lasting for that page only instead of replacing what the user has saved. See [Embedding & Sharing](user-guide/embedding.md)
- [x] **Geometry generators become attribute-driven**: derived centroids scale with a field as proportional symbols, and each feature's buffer takes its distance from a column instead of one typed number, following QGIS's data-defined overrides
- [x] **Excel workbooks import as point layers** from their X and Y columns, with a worksheet picker
- [x] **The Layers panel search box searches the map's own data**: the typed query is matched against the attributes of the loaded vector layers alongside the geocoder, running locally so data matches appear before the network answers, grouped by layer above the place results and ranked exact match first, then prefix, then contains, with picking a feature selecting it on its layer and flying to it with the attribute table's highlight
- [x] A Style panel button on every layer card, field statistics scoped to the selected features, USGS LiDAR clipped and downloaded as COPC, ArcGIS ImageServer raster functions browsed from the service's own list, and `?data=` accepting several URLs at once

## Plugin marketplace and registry (design)

This captures the design for the `v1.0` "Plugin marketplace / registry" item. It
builds on the existing external-plugin foundation, the `plugin.json` manifest
contract, HTTPS manifest-URL loading, the desktop app data `plugins/` scan, and
the bundled `public/plugins/` drop-in mechanism, and it relates to the "External
plugin package distribution workflow" item.

### Goal

Let users discover, install, update, and remove trusted external plugins from a
curated registry without hand-entering manifest URLs, on both the desktop and
web builds, while keeping the existing trust model in which plugins are trusted
code.

### Registry

- A curated, versioned index published as static JSON (for example
  `registry.json` hosted on `geolibre.app`, or generated from a GitHub
  repository of submissions). No live backend is required for the MVP.
- Each entry carries `id`, `name`, `version`, `description`, `author`,
  `homepage`, `manifestUrl`, `categories`, `minGeoLibreVersion`, and optional
  `screenshots`.
- The index is fetched over HTTPS and cached; entries point at the same
  `plugin.json` manifests the existing loader already understands.

### Browse and install UI

- A standalone Manage Plugins dialog (Settings menu > Manage Plugins), modeled
  on QGIS, has All / Installed / Not installed / Upgradeable / Settings sections.
  The four browse sections list registry entries with search and per-entry
  install, installed, and update states; the Settings section manages plugin
  sources.
- Install reuses the current external-plugin loader: it resolves the entry's
  `manifestUrl`, validates it, and registers the plugin.
  - Desktop: download the bundle into the app data `plugins/<id>/` directory so
    it persists and loads on startup through the existing scan.
  - Web: record the entry's `manifestUrl` in desktop settings (and, for shared
    projects, in the project `plugins.manifestUrls`) so it loads on next open.
- Remove drops the recorded manifest URL and unregisters the plugin at runtime
  (tearing down any active control), so the change takes effect without a
  restart. (The MVP records manifest URLs rather than downloading bundles; the
  desktop bundle-download path above is a later enhancement.)

### Updates and versioning

- Compare the installed `version` against the registry entry, surface an update
  available state, and offer a one-click update that re-fetches the bundle.
- Honor `minGeoLibreVersion` so incompatible plugins are flagged, not installed.

### Trust and security

- The registry is an allowlist; only curated entries are offered for install.
- HTTPS-only manifests (the existing `isAllowedPluginManifestUrl` rule).
- Explicit user consent on install, because plugin entries execute as trusted
  code (the desktop CSP permits `blob:` script execution by design).
- The curated registry and explicit install consent are the primary controls.

### Relationship to bundled plugins

- Bundled `public/plugins/<id>/` drop-ins remain the zero-config way to ship
  first-party or private plugins inside a build. The marketplace covers
  discoverable, user-installed third-party plugins; the two are complementary
  and share the same `plugin.json` contract and loader.

### Phasing

1. Curated static registry plus browse and install through manifest URLs
   (reuses the current loader; records the manifest URL in settings). **Done.**
2. Version checks, update and removal flows.
3. Submission workflow for third-party authors.

### Implementation (phase 1)

The MVP ships in the desktop app and, because the same frontend serves the web
build, works in both:

- `apps/geolibre-desktop/src/lib/plugin-registry.ts` fetches and normalizes a
  registry (`{ "plugins": [...] }`), resolving each entry's `manifestUrl`
  against the registry location. The registry URL is
  `VITE_GEOLIBRE_PLUGIN_REGISTRY_URL` or, by default, the hosted registry at
  `https://plugins.geolibre.app/plugin-registry.json`.
- `apps/geolibre-desktop/src/components/layout/ManagePluginsDialog.tsx` is a
  standalone dialog (Settings menu > Manage Plugins) with All / Installed / Not
  installed / Upgradeable / Settings sections: search, install, a confirm step
  before uninstall, an Update action when a newer version is published,
  `minGeoLibreVersion` compatibility checks, and inline error handling. The
  Settings section manages additional local directories and manual manifest
  URLs. All actions apply immediately (live).
- Installing records the entry's manifest URL in the plugin manifest URL list,
  so the existing external-plugin loader fetches and registers it. No new trust
  path is introduced. Uninstalling (after confirmation) unregisters the plugin
  at runtime — tearing down any active map control — so the Plugins menu updates
  without a reload. Update re-fetches the manifest URL and re-registers the
  published version in place, fetching the new version before tearing down the
  old one so a failed update leaves the installed plugin intact.
- The registry and plugin bundles live in the
  [opengeos/geolibre-plugins](https://github.com/opengeos/geolibre-plugins) repo,
  published to GitHub Pages at `plugins.geolibre.app`; it ships a `sample/`
  template and maintainers add curated entries there.
