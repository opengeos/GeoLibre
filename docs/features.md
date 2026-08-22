# Features

A feature-by-feature list of what GeoLibre can do today — the latest release plus
what has landed on `main` since (see [Recently added](index.md#recently-added)).
For task-oriented walkthroughs, see the [User Guide](user-guide/interface.md) and
the [Tutorials](tutorials/index.md); for what is planned next, see the
[Roadmap](roadmap.md). For how this stacks up against QGIS, ArcGIS, Felt, and
kepler.gl, see the [Comparison](comparison.md).

## Platforms and interface

- Runs across desktop (Tauri), web (browser), native Android (Tauri v2 mobile), and mobile or small screens
    - Responsive, touch-friendly layout that adapts menus, dialogs, and panels; on phones the Layers and Style panels overlay the map as slide-over sheets
    - Per-panel visibility through Layout settings
- Command palette (`Ctrl`/`Cmd` + `K`) that searches and runs menu and toolbar actions across Add Data, Processing, Controls, Plugins, and Help
    - Global keyboard shortcuts for New, Open, Save, and Save As
    - Google Earth-style camera resets: `N` north up, `U` top-down, `R` reset view
    - A `?` shortcuts cheat sheet
- Customizable UI profiles that tailor which menus, panels, and data sources are visible, so a deployment can present a focused subset of the app to its users. See [UI Profiles](ui-profiles.md)
- Internationalization framework with react-i18next and 18 complete per-build translation catalogs — including right-to-left Arabic and Persian with a fully mirrored interface, Persian set in Vazirmatn — plus a `?locale`/`?lang` query parameter to set the embed language
    - Plugin display names resolve through one place, so a plugin reads the same in the Plugins menu, the command palette, Settings, and Manage Plugins, and every processing tool name, description, group label, parameter, and select option is generated into the English catalog for translators to work from. See [Internationalization](i18n.md)
- Accessibility pass with axe-checked screens, keyboard navigation, and screen-reader labels
- App-wide, section, and plugin React error boundaries that contain failures and keep the rest of the workspace usable
- Undo/redo for layer and style operations
- A design system of the app's own: self-hosted IBM Plex Sans and IBM Plex Mono (no CDN, so the desktop build renders offline under its CSP) instead of whatever the platform's UI font happens to be, a dark-mode elevation ladder that separates canvas, panels, dialogs, and menus by surface rather than by a 1px border, theme-aware shadows that stay visible in dark mode, and one translucent map-glass treatment shared by every piece of chrome that floats over the map

## Map workspace and basemaps

- MapLibre map workspace
    - **Basemaps**: OpenFreeMap, Protomaps, EOX Sentinel-2 cloudless, and Openbasiskaart, with stacking of multiple raster basemaps, blank background support, and double-click to swap the core basemap from the layer panel
    - **Regional basemaps**: a collapsed Regional section in both the New Project and Change Basemap panels for providers with local coverage the global defaults lack, starting with five keyless Chinese basemaps (高德地图, 高德卫星, 高德混合, 腾讯地图, 腾讯深色), with the same providers plus Tianditu available through the Basemaps control plugin
    - **A remembered basemap**: an empty startup workspace opens on the basemap you last selected, while a project's own basemap stays authoritative
    - **Planetary basemaps**: Mars and the Moon (OpenPlanetaryMap), plus Mercury, Venus, the Galilean moons (Io, Europa, Ganymede, Callisto), Titan, Pluto, and Charon (USGS Astrogeology, reprojected to Web Mercator by the tiles Worker). A per-project ellipsoid drives distance, area, and scale measurements from that body's radius, and a planet switcher sits in the Layers panel
    - **Toggleable controls**: navigation, fullscreen, geolocation, globe, terrain, scale (metric, imperial, or nautical), attribution, and logo, plus a double-click terrain control for setting vertical exaggeration
    - **Your own DEM as the terrain source**: terrain settings accept a single-band EPSG:3857 or EPSG:4326 Cloud Optimized GeoTIFF over HTTP or from a local file, read in ranges and encoded to Terrarium tiles through a custom MapLibre protocol, so higher-resolution local elevation can shape the 3D view and the hillshade instead of the global tile set
    - **On-map helpers**: a right-click context menu that reads out and copies the clicked coordinate, opens it in Google Maps or Google Earth, and carries a **Quick analysis** submenu — buffers, drive- and walk-time isochrones, and a viewshed, each run on the clicked point with no dialog and no point layer to create first (the same submenu on a layer row runs buffers, centroids, convex hull, and bounding box over the whole layer) — plus a Gridlines coordinate-grid overlay with edge labels and a UTM easting/northing grid mode
    - **Interactive viewshed**: right-click anywhere and get what is visible from that spot within 2, 5, or 15 km, computed from the same public terrain tiles the map already renders — no DEM to find, download, or load, and 3D terrain need not even be on. The result is an ordinary image overlay layer, so it gets opacity, ordering, zoom-to, and project save for free. Earth curvature and refraction are not modelled; the Whitebox **Viewshed** tool remains the rigorous DEM-in-hand option
    - **Status bar readouts**: the pointer coordinate in decimal degrees, DMS, DDM, or UTM (click to cycle, or set it in Settings; UTM reuses the projection that draws the Gridlines grid, and falls back to degrees outside its valid latitude band), the ground elevation under the pointer, camera altitude above sea level as Google Earth-style **Eye alt** — scaled to the active celestial body, so it stays right on a Mars or Moon basemap — plus zoom, bearing, pitch, and the view bounding box
    - **Pointer elevation** resolved from the map's own 3D terrain whenever a usable sample is available there (instant, offline, nothing leaves the device), and from a public elevation API when terrain has no value to give — after the pointer settles, cached per cell, Earth-only, off by default, and gated behind an explicit consent notice, so declining is what keeps the readout off the network
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
    - **URL deep links**: open GeoJSON, GeoParquet, PMTiles, a REST endpoint returning a GeoJSON FeatureCollection, a COG, or a ZIP/REST response containing multiple GeoJSON files with `?data=`, repeated as many times as you have sources; optionally apply vector or raster style JSON with `?style=`, automatically fit the layer extent, and associate per-file ZIP styles by filename stem
    - **Tile and map services**: XYZ tiles; WMS and WFS, with layers and feature types discovered from the service's GetCapabilities so you pick from a populated dropdown; vector tiles, including OGC API - Tiles services; and ArcGIS FeatureServer, VectorTileServer, MapServer, and ImageServer layers. The last two load as ordinary raster layers, so opacity, the Style panel's brightness/contrast/saturation, reordering, and project save all apply, drawing from the service's own fused cache when it was built on the standard Web Mercator scheme and from `/export` or `/exportImage` otherwise. MapServer sublayers and ImageServer raster functions are browsed and picked from each service's advertised list, with custom raster function JSON still available for advanced ImageServer rules
    - **Feature services and feeds**: GeoJSON URLs; GeoRSS feeds from a URL or file; and OGC API - Features collections added as vector layers from whatever URL you have in hand — a landing page, `/collections`, a collection, or a full items URL
    - **Raster**: COG and GeoTIFF; Cloud-Optimized NetCDF/HDF via kerchunk references, plus local HDF5 and NetCDF-4 files; and MBTiles
    - **Cloud-native archives**: PMTiles, and Zarr from a remote store, an Icechunk repository, or a folder on disk, with variable and dimension pickers that offer the store's real coordinate values rather than raw indices
    - **Files with pickers**: multi-layer GeoPackages, with a layer picker so only the chosen feature tables load; Excel workbooks imported as point layers from their X and Y columns, with a worksheet picker; delimited text with a source CRS field so projected easting/northing columns reproject correctly, or an Addresses mode that concatenates the columns you pick and geocodes each row through the project's provider (unmatched rows are kept as null-geometry features so they stay visible and fixable in the attribute table); CAD drawings (DXF/DWG) with a drawing-layer picker and CRS selector; and Esri File Geodatabases (`.gdb` folders, desktop) with a feature-class picker and automatic reprojection
    - **3D and media**: LiDAR; 3D Tiles, including authenticated tilesets via custom request headers; ArcGIS I3S scene layers (Integrated Mesh and 3D Object, rendered on deck.gl); Gaussian splats; glTF/GLB 3D models placed at coordinates; georeferenced video overlays; and geotagged photos imported as a point layer from their EXIF GPS, with manual placement and drag for photos lacking coordinates and a true native-resolution photo viewer
    - **Throughout**: a fully internationalized dialog, comma decimal support, drag-and-dropped CSV coordinate files, sample-data dropdowns on every upstream-backed panel for loading ready-made example datasets, and a saved service library for storing and re-adding frequently used web-service endpoints
- Encoded polylines as a first-class format: a codec for Google and OSRM precision 5 and Valhalla and Mapbox precision 6, with an interactive preview and coordinate inspector in Add Data, batch parsing with custom delimiters, processing tools for encoding and decoding, layer export at either precision, and matching support in the Python package
- QGIS-style Browser panel (Data Source Manager) for exploring and adding data from one place: browse map Services and Recent items, connect to PostGIS databases and browse their schemas and tables (picking the geometry column explicitly on a table that registers more than one), drill into local files, save and reopen Favorites, and add a New connection per service kind, with full keyboard navigation of the tree
- Layer Library: save a fully configured layer — source, style, labels, filters, joins, virtual fields, and attribute form — from the layer actions menu, then re-add it to any later project in one click from the Browser panel's **My Data** section
    - Entries can be renamed, removed, and exported or imported as a JSON bundle to share with a team
    - Entries store the source specification rather than the data, so a saved COG, PostGIS table, or remote GeoParquet always reflects its source's current contents
    - Layers whose features exist only in memory or in a local file embed them behind a size cap
- Deck.gl Layer builder for composing deck.gl overlays from uploaded files or remote URLs
- Cloud data integrations through the Planetary Computer and Earth Engine panels, the Overture Maps plugin, and federal Web Services plugins
- Manual and automatic refresh for WFS, GeoJSON URL, and Add Vector Layer URL layers, with the cadence, last-synchronized time, last error, and on-failure policy persisted with the project as a `connection` record — so a reopened project keeps refreshing on schedule and the Layers panel can show each live layer's synchronization status
- ArcGIS Hub, Socrata, and CKAN (Humanitarian Data Exchange) open-data browsers under Plugins → Web Services: search public dataset catalogs by keyword (or restrict the ArcGIS Hub search to the current map area), page through results, and add a dataset to the map or download it
- Drag and drop vector and GeoTIFF/COG raster files onto the map to add them as layers
- **Open data in GeoLibre**, a [Chrome extension](https://chromewebstore.google.com/detail/open-data-in-geolibre/joinecgbfoldanidcoakpjgkbaceaooj) on the Chrome Web Store, that collects the supported dataset links and map services (WMS, WMTS, WFS, OGC API - Features, ArcGIS Feature Services, XYZ/TMS, and vector tiles) on the page you are viewing and opens the ones you pick together on one GeoLibre map

## Layers, styling, and labels

- Layer panel for visibility, opacity, reordering, rename, zoom-to-layer, identify, labels, open attribute table, open Style panel, export, and remove actions. Selecting a layer never pops the Style panel open over the map on its own; it expands from a palette button on the layer card or from the matching menu item
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
- Smart styling on add: each new vector layer takes the next unused color from a qualitative palette, with its outline derived from that fill and its sizing following the layer's dominant geometry, so a freshly loaded stack is legible before the Style panel is opened (deleting a layer frees its color rather than offsetting the cycle)
- Live style panel
    - **Style suggestions**: a dismissible strip offering up to three one-click renderers derived from the layer's own attributes — categorize by a low-cardinality label, graduate by the numeric column with the most spread, or a heatmap for a dense point layer — shown while the layer still carries its as-added symbology
    - **Vector-tile classification**: PMTiles, MBTiles, and remote vector-tile layers carry no local features, so the panel samples the features the viewport has already loaded to fill in the field list and the values graduated and categorized styling need, and 3D extrusion defaults to a real height property
    - **Renderers**: single, categorized, graduated, expression, and rule-based (filter-driven) symbology over fill, stroke, opacity, and circle radius, plus proportional symbols, fill patterns, a built-in marker library, and point heatmap and clustering renderers — all including for Add Vector Layer point layers
    - **Color**: an inline color ramp picker that previews each colormap's gradient on the trigger and beside every option, plus a transparent (no fill / no outline) option in the color picker
    - **Rule-based renderer**: per-rule symbol properties, scale-dependent visibility, nested rules, and per-rule toggles, and it can hide features matching no rule
    - **Style toolkit**: diagram symbology (pie, donut, and bar charts drawn on features); a symbology pack of inverted-polygon masks, arrow and marker lines, and geometry generators whose derived centroids can be sized and whose buffer distances can be driven by an attribute; and data-driven proportional sizing for marker icons
    - **Style Manager**: saves reusable symbol, color-ramp, and label presets to a personal library and applies them across projects
    - **Interchange**: vector layer symbology imports and exports as OGC SLD, QGIS QML, Mapbox GL style JSON, and compact GeoLibre URL style JSON; URL-style exports omit feature data, carry filename-matched sources for ZIP layers, work directly with `?style=`, and can be imported back onto any selected vector layer
- Data-defined label engine for labeling vector features by any attribute or expression
    - ArcGIS-style placement and styling controls: anchor, X/Y offset, rotation, wrap width, and letter case
    - Expression-driven label properties and placement priority
    - A Duplicate labels option, plus unique and concatenate modes that collapse points stacked at the same coordinate into a single deduplicated label
- Single-band pseudocolor with classification, reversed and custom color ramps, the full colormap list shown as inline gradient swatches in the Color ramp picker, a Legend populated automatically from a paletted raster's embedded color table, and RGB band combination for styling raster layers, plus COG pixel-value inspection from the Identify icon
- NetCDF and HDF grids are first-class raster layers rather than a single grey band
    - Local grids are colormapped in the browser from the same colormap catalog the Style panel uses, added as image overlays, and fitted to the camera on add, so Zoom to layer has a real extent to fly to
    - A hyperspectral cube gains an RGB band combination picked by wavelength
    - Identify reads a pixel's value off the map and, for a cube, walks the band axis to chart a spectral signature against wavelength — up to six sampled points, each drawn as a numbered dot in its chart color, compared in a draggable and resizable window over the map and exported as PNG or CSV
    - The same spectral profile works on any **multiband GeoTIFF or COG**, not just NetCDF/HDF — click a stacked Landsat or Sentinel scene to compare the response of water, vegetation, and asphalt across every band. Reads are range requests for the tile containing the pixel rather than the whole scene, the click is reprojected into the raster's own CRS, and the chart plots against wavelength when the file declares one per band and against band number otherwise
    - A **3D image cube** view renders the scene as its six exterior faces with draggable slice cuts, reading windowed and strided so a full EMIT reflectance variable stays within what the browser can hold

## Attribute data and expressions

- Attribute table
    - **Browsing**: filtering, sorting, resize controls, feature highlighting with Ctrl- and Shift-click multi-row selection, optional zoom to selected features, and virtualized rows for large layers
    - **Editing and derived fields**: add-field and field-calculator tools (including geometry length and area calculation), virtual fields (expression-backed computed columns that update with the data), persistent attribute joins configured in layer properties, and automatic editor tracking (created by/at and edited by/at)
    - **Forms**: an attribute form designer with edit widgets, validation constraints, and conditional field visibility
    - **Analysis**: a Charts panel (histogram, scatter, bar, line, box) and a field statistics summary panel, scoped to the whole layer or to just the selected features
    - **Columns**: rename, delete, hide/show, and reorder, plus a column explorer for finding and toggling fields in wide tables
    - **Export** to GeoJSON, GeoParquet, Shapefile, GeoPackage, CSV, KML, or KMZ, honoring the fields hidden in the table so a hidden column stays out of the exported file
    - A **Raster Attribute Table** for single-band categorical rasters
- Shared Expression Builder with a function reference, searchable field list, live preview, and reusable variables, wired into filters, labels, styling, field calculation, and selection, plus Select by Expression and Select by Location for building feature selections
- Select features by drawing on the map, QGIS-style: click, rectangle, polygon, freehand, and radius gestures from the layer's Select features menu, with Shift and Alt combining the result into the existing selection and Clear selection alongside them

## SQL and databases

- SQL Workspace for running DuckDB Spatial SQL against loaded layers, local files, and remote URLs, docked as a resizable panel beside the map
    - Editor autocomplete for tables, columns, and SQL keywords, plus sample queries and query history
    - Add results to the map or export them
    - An in-browser PostGIS SQL engine via PGlite and an Apache Sedona spatial SQL engine
- Multiple DuckDB SQL query-result layers with identify, selection, and attribute table support
- **Apache Iceberg** vector layers, read in-browser through DuckDB's `iceberg` and `spatial` extensions
    - Point at a table's metadata location, or attach an Iceberg REST catalog and pick a table from it — a source exposing a single table selects it automatically
    - Selecting a table reports its true row count (from the manifest metadata, without scanning) before anything is read, and the load is capped by a row limit so a table far larger than the browser can hold still opens as a usable subset
    - An optional SQL box, pre-filled with the generated `SELECT * FROM ...`, so a `WHERE`, a join, or a projection decides which geometries are rendered; editing it re-reports the row count and geometry column for that query
    - The geometry column and its **CRS are both read from the schema** — Iceberg records the coordinate system in the column type, so a projected table reprojects to WGS84 with nothing to fill in; only native `GEOMETRY` columns are offered, since Iceberg v3 has a real geometry type and a BLOB or VARCHAR here is an attribute
    - Due to the potential scale of huge iceberg tables, the resulting layer is a snapshot and is deliberately **never re-scanned on a timer** — the layer menu's automatic-refresh interval is unavailable for it; Refresh re-runs the scan on demand

## Map tools, printing, and media

- Controls menu
    - Measure (including terrain-aware 3D measurements and a heading readout — a true great-circle initial bearing with a 16-point compass label, plus a final bearing on lines long enough for the great circle to converge), Bookmark, Minimap, View State, and a Search panel
    - Map annotation tools that draw text, arrows, and highlights on the map, saved with the project
    - Persistent mode banners for the Directions and Reverse Geocode tools
    - A Camera Tour recorder that captures an animated keyframe tour to video, with per-keyframe recapture, per-keyframe hold and transition duration controls, and saving or loading a named tour setup as JSON
    - A Dashboard panel of configurable chart widgets that summarize the loaded layers: histogram, scatter, bar, line, box, and pie charts, plus big-number indicator tiles with count, sum, mean, min, max, or median aggregation and a custom prefix and suffix
- Print Layout composer (**Project → Print Layout...**) that exports the map to PNG or PDF: a user-editable legend, an explicit map-scale input, a title block with editable title and footer, page-size controls, a custom print extent drawn with the mouse or by touch, attribute-table and chart blocks (filterable to all features, only those contained by the page, or every feature the page intersects), Atlas / map series generation that produces one page per feature or a uniform series of pages along a line, and Copy to Clipboard
- Record the map canvas, or a drawn bounding box, to a video file straight from the browser (with an optional title/source caption and on-map panel capture for HTML, legend, and colorbar overlays), and animate a marker along any line layer with 3D track-follow camera controls and MP4 export
- Bookmarks that capture the active layers alongside the camera, organized into folders, with selectable export, a resizable and reorderable panel, and a save-as name prompt
- Elements panel that lists the map's annotations — text, arrows, rectangle, ellipse and freehand highlights, pin markers, sticky notes, and placed images — so each one can be found and managed from a list instead of hunted for on the canvas. Most elements are anchored to a point and move with the map; a placed image can instead be pinned to an extent so it scales with the view. See [Annotations and the Elements panel](user-guide/map-controls.md#annotations-and-the-elements-panel)
- Dashboard **selector** widget that turns a categorical field into a set of chips and cross-filters every other widget bound to the same layer, in single- or multi-select mode. A selector never filters itself, so a choice can always be changed or cleared, and selections are a way of looking at the data rather than a property of it — they start empty each time the dashboard opens

## Field data collection

- Field Collection tool for capturing point, line, and polygon observations with a per-layer custom form (text, number, date, and choice fields plus an optional photo), placed by device GPS or by tapping the map, written to a GeoJSON layer that flows into the attribute table, export, and offline use
- Live GPS tracking with a moving position marker, a recorded track log, and digitizing new features directly from the GPS feed. See [GPS tracking](user-guide/map-controls.md#gps-tracking)
    - Reads either the device's own geolocation or an external **NMEA** GPS/GNSS receiver over Web Serial or Web Bluetooth, with a baud-rate picker and a live sentence and fix counter

## Storytelling and collaboration

- Story map builder that composes its chapters directly on the live map, with a presenter view, dedicated start and closing slides, an optional hide-itinerary toggle, a printable PDF handout generator (with subtitle and byline fields, and optional location markers that open each chapter coordinate in Google Maps), and standalone HTML export
- Real-time multi-user collaboration (MVP; see [Collaboration](collaboration.md)) so several people can edit the same project together
    - Per-participant permissions and an in-app chat panel
    - An on-canvas session-status badge and roster — a live dot, a connected-participant count, and an expandable client list — while a session is active
    - Portable snapshots: shared layers embed their features rather than pointing at a local file or control-managed data the guest cannot read, the host seeds the first snapshot instead of waiting to make an edit, guests arrive at the host's viewport, and the session Copy button yields a joinable URL. Plugin activation and settings stay participant-local, so a peer's snapshot cannot deactivate your controls
- Anchored review comments: drop a pin on the map, write a note, and reply, resolve, reopen, or delete the thread, filtered by open, resolved, or all. Clicking a pin reveals, highlights, and scrolls to its card, `C` places a new comment from the command palette, and the panel sits on the Style rail. Comments are saved in the project file so they travel with a shared project, and every mutation syncs live to the other participants during a collaboration session. See [Review comments](user-guide/map-controls.md#review-comments)

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
    - Layer management and camera control as plain project mutations on `Map` and `Layer` — reorder, duplicate, rename, and remove layers, read attribute values, and frame the map — with the project authoring helpers exported for scripts that never display a widget, and credentials swept out of the layer records and basemap URLs a notebook cell prints back
    - The bundled Whitebox WASM catalog runs from the widget through `list_whitebox_tools` and `run_whitebox_tool`, resolving `Layer` handles to layer ids and adding both vector and raster outputs back to the map, so terrain and raster work no longer means leaving the notebook for the UI
- MCP server (`geolibre-mcp`) that lets an AI client author real `.geolibre.json` projects headlessly over stdio — no browser, no running app, and no bundled web build — composing them with the same builders the Python package uses, so anything it writes opens unchanged in the desktop app, the web app, and the Jupyter widget. Every read and write is confined to the roots given by `--root` or `GEOLIBRE_MCP_ROOTS`. See [MCP server](mcp.md)
- R package (`geolibre`) for interactive GeoLibre maps in RStudio, Quarto, R Markdown, and Shiny, with GeoJSON, `sf`, remote raster, camera, and project-file support. See the [R package guide](r.md)
- Optional Python FastAPI sidecar for heavier processing workflows

## Processing and analysis

- Conversion menu for Vector to GeoParquet, FlatGeobuf, and PMTiles; a generic Vector to Vector converter that translates between any supported vector formats by file extension; CSV to GeoParquet; and Raster to COG
    - In the browser build every conversion runs client-side on DuckDB-WASM, the pure-JS writers, or `geolibre-wasm` (Vector to PMTiles on a background worker)
    - The desktop app prefers the Python sidecar, whose GDAL/rio-cogeo stack reads more input formats and tiles deeper
- **1,000+ geoprocessing tools** in the Whitebox toolbox, running entirely in the browser through a WebAssembly runtime with raster and vector I/O — no Python sidecar required, so the full set works on the web, desktop, and Android
    - Surfaces both the Whitebox Next Gen suite and GeoLibre's own WASM tools, filterable by source
    - Nine categories: vector (~315 tools), raster (~255), remote sensing (~155), hydrology (~100), terrain (~100), LiDAR (~65), conversion (~50), network (~25), and projection (4)
    - Browsable by category directly in the Processing menu, with nested subcategory submenus and an offline-bundled tool catalog
    - A **Run locally (WASM)** toggle switches any tool between the in-browser runtime and the Python sidecar, which reads native file paths for batch runs over a directory
    - Deep-linkable through a `?tool=` URL parameter that preselects a tool and pre-fills its form, with a Copy link button that builds the shareable link
    - Batch tools run against a selected input directory
    - Distance parameters on WGS84 vector layers carry a metric unit picker (degrees, meters, kilometers, feet, miles) that converts to the degrees the tool actually reads, anchored at the input layer's center latitude
    - EPSG parameters sit beside a searchable CRS catalog grouped into Geographic and Projected, with the typed code's official EPSG name confirmed under the field
    - Download OSM Vector's four boundary numbers render as one Area of interest control with Use map extent and Draw on map shortcuts
- Vector menu
    - **Geometry and analysis**: buffer, centroids, convex hull, dissolve, bounding box, simplify, clip, intersection, difference, union, spatial join, attribute join, select by value, select by expression, select by location, random extract, movement, space-time, and cell coverage
    - **Data management**: merge layers, through a multi-layer parameter picker that unites attribute schemas and can record each feature's source layer
    - **Vertices and sampling**: extract vertices as points carrying their part and vertex index, and generate points along lines and polygon boundaries at a fixed geodesic interval
    - **Data quality**: check validity, fix geometries, and check topology rules
    - **Engines**: Turf.js in the browser, an optional GeoPandas sidecar engine for every tool, and an in-browser GeoPandas engine via Pyodide (no server, same results as the sidecar)
- Raster menu with hillshade, slope, aspect, reproject, resample, clip by extent, clip by mask layer, polygonize, contour, zonal statistics, raster calculator, reclassify, mosaic, and focal statistics
    - Backed by a rasterio Python sidecar, with a client-side fallback so core tools also run in the browser when no sidecar is available
    - Plus in-browser extraction of COG, WMS, and XYZ bounding-box subsets, and a normalized-difference index builder for any HTTP COG
- Spectral Index toolbox (NDVI, GNDVI, NDWI, NDMI, NDBI, NBR, EVI, SAVI) with Sentinel-2, Landsat 8-9, NAIP, and custom band layouts, evaluated client-side with geotiff.js or on the rasterio sidecar
- Spatial Statistics toolbox, including Emerging Hot Spot Analysis that builds a space-time cube from timestamped points, runs Getis-Ord Gi\* per time slice, and classifies each cell as a new, intensifying, persistent, diminishing, sporadic, oscillating, or historical hot or cold spot
- Model Builder, an ArcGIS-style canvas for processing workflows: drop tools as nodes, wire an output into the next tool's input, and save the graph as a model that re-runs as one job, with the whole graph validated (cycles, missing connections, invented parameters, wrong parameter types) before anything executes
    - The AI assistant can author a validated model from a plain-English description and open it for review before it runs, over the same palette the canvas uses: client-side vector tools plus the full Whitebox catalog
    - Any model copies out as a runnable Python script for the Notebook panel or JupyterLite
- Processing batch runner with model and pipeline chaining, to run a sequence of tools as one job
- Processing History panel that lists every tool run, re-runs any of them with one click, and copies the equivalent Python code
- Raster Georeferencer (Processing → GeoLibre Toolbox → Raster → Georeferencing) that pins a non-georeferenced image to the map with ground control points using a least-squares affine fit, reporting per-GCP and RMS residuals
- Network analysis tools for isochrones, service areas, origin–destination (OD) cost matrices, and sequential routes (directions) through an ordered set of waypoints
- Geocoding tools for forward, batch, and reverse geocoding through a multi-provider abstraction
- AI Segmentation (SamGeo) that turns imagery into vector features with [segment-geospatial](https://github.com/opengeos/segment-geospatial) and Meta's SAM 3 — text prompts ("trees", "buildings") or automatic segmentation, proxied to a separate `samgeo-api` model server (GPU recommended). See [AI Segmentation](user-guide/segmentation.md)
- In-browser object detection that runs ONNX/YOLO models directly in the webview, with no server or Python required, over map imagery or an imported geotagged photo layer
- H3 tools to create hexagonal grids over an extent and bin point layers into H3 cells
- DGGS tools for discrete global grid systems: a DGGS Generator that fills an extent with cells, DGGS Binning that aggregates a point layer into them, and DGGS Compact that collapses a complete set of children into their parent
- Quick analysis straight from the map's right-click menu and a layer's actions menu, with defaults already filled in: buffer the clicked point at three distances or run drive- and walk-time isochrones from it, and buffer, centroid, convex-hull, or bounding-box a whole layer. Buffer distances follow the scale bar's unit system, and every run lands in Processing History, re-runnable and copyable as Python

## Projects and sharing

- Project menu to create, open, save, and Save As `.geolibre.json` projects, export a project to a single standalone interactive HTML file that runs offline with no server, and a project gallery for browsing and opening shared projects with one click
- Share-readiness check in the Share dialog: before the upload, every data source the project references is classified and probed anonymously from the browser, and the ones a recipient could not load are listed with a plain-language reason and a fix, covering credential-gated services, hosts with no cross-origin headers, expired or moved links, and local or private-network sources. It informs rather than blocks. See [Projects](user-guide/projects.md#share-readiness-check)
- Autosave with a browsable project history. See [Projects](user-guide/projects.md#project-history-and-crash-recovery)
    - Snapshots are written to local device storage a few seconds after each change settles, and listed newest first with their layer count and zoom
    - Restoring a snapshot is an undoable step
    - Per-project, per-snapshot, and total-size caps keep history from growing without limit
    - In the browser build, outside an embedded (iframe) session, a crash-recovery prompt appears when a session ends without closing cleanly and a newer autosave exists than the last explicit save
- QGIS project import (`.qgs` and `.qgz`) that rebuilds layers, nested layer groups, group visibility, layer order, styling, and the saved map view, reporting per-layer why anything was skipped rather than failing the whole import. See [Projects](user-guide/projects.md#importing-a-qgis-project)
- ArcGIS Pro project import (`.aprx` and `.mapx`) that reads CIM JSON without ArcPy and restores the first 2D map's extent, local vector and GeoTIFF layers, nested groups, visibility, simple symbols, field labels, vector-tile portal items, and cached map services, with per-layer warnings for unsupported sources. See [Projects](user-guide/projects.md#importing-an-arcgis-pro-project)
- Reusable project templates saved to a personal library, with an option to keep the basemap, groups, styles, legend, widgets, and layout while stripping the data layer content
- Startup preferences on the desktop app: open the default workspace, reopen the last local project, or always open one chosen project, and choose whether an empty workspace starts as a 3D globe or a Mercator map. Remote share links are never replayed on launch, a project URL in the address bar takes precedence, and a startup project that has gone missing falls back to the default workspace with an explanation instead of an error. See [Settings](user-guide/settings.md#startup)

## Plugins

- Built-in plugins for the map surface: basemap, layer control, MapLibre components, and swipe
- Imagery and street level: street view, Mapillary coverage and street-level image viewer, OpenAerialMap open-aerial-imagery search, and Historical Imagery
- Data catalog browsers:
    - **Natural Earth** and **Source Cooperative**, including opening or streaming large GeoParquet from Source Cooperative
    - **STAC catalogs**, which discovers catalogs from STAC Index, connects to both static catalogs and STAC APIs, searches a collection's items, and adds any visualizable asset as a layer (COG, PMTiles, GeoParquet, and Zarr with a variable picker), including an Icechunk repository read through its own manifest and Azure-hosted assets signed at add time so private Planetary Computer containers open like public ones. A static catalog can also be walked as a tree, opening a folder to read it and starting a search from whatever you picked
    - **Earthdata GIS**, which searches NASA's EOSDIS ArcGIS portal and renders its imagery, map, and feature services and published web maps as first-class layers
    - **Hugging Face**, for searching the Hub, walking a dataset repo's folders, adding its vector and raster files to the map, and creating and uploading dataset repos
    - **[GeoLens](https://github.com/geolens-io/geolens)**, which connects to a self-hosted GeoLens server and adds datasets as signed vector tiles, OGC API Features GeoJSON, or server-rendered raster tiles — and writes edits to a GeoJSON-loaded dataset back to the GeoLens server, feature by feature, when the server allows it
- Analysis and editing integrations: Elevation Profile, Overture Maps, USGS LiDAR, GeoAgent, and GeoEditor
    - Elevation Profile charts a drawn line or the line features currently selected on a layer, so a route already on the map does not have to be traced again
    - USGS LiDAR clips a point cloud to an area of interest and downloads the result as COPC
    - The GeoEditor can pull the vector features currently visible in the map view into the editor for editing without re-importing the source, and write edits back to their origin, including GeoPackage and GeoJSON files and PostGIS database tables
    - Topological polygon digitizing, so a polygon drawn against its neighbor shares that edge instead of leaving a sliver or an overlap behind
    - Building massing: sketch a footprint, give it a height, and get an extruded mass, with the extrusion style managed as massing features come and go and ordinary polygon sketches left flat
- Configurable control positions and external plugin manifests, and external plugins can:
    - Render on the host's shared deck.gl instance via `app.getDeckGL()`
    - Use the maplibre-gl-raster stack and the map projection control, and register native raster and tile layers
    - Render Zarr through the renderer the app already ships via `addZarrLayer`, with plugin-owned paint properties honored on custom layers so the Style panel's sliders apply, and read a pixel or region back off that native layer with `queryZarrLayer` — a point for click-to-value, a polygon for region statistics — instead of reimplementing the reprojection and chunk indexing the renderer already did
    - Expose layer groups of their own
    - Query a layer's features read-only through the host, instead of re-fetching and re-parsing the source the app has already loaded
    - Register first-class right-sidebar panels, toolbar menus, and floating panels through the plugin UI host API, including a shared-rail replace-style dock mode, and place their toolbar menus after the Help menu
- Time Slider plugin for animating time series raster and vector data
    - Binds existing vector layers already on the map to the timeline — GeoJSON as well as vector tiles, PMTiles, and MBTiles, whose timestamp field is detected from a live tile sample so a tiled layer animates over its full extent without a local copy of the data
    - Drives a layer's own internal time dimension through a generic temporal adapter, so a data cube such as a Zarr store joins the shared timeline
    - Steps through mosaic sources (a MosaicJSON or STAC collection of many COGs per date) rendered on either a GPU or a WASM engine
    - Plots a pixel time series, charting a sampled pixel's value across a raster stack
- Flight Simulator plugin with a continuous, interactive free-flight camera you steer over terrain and 3D layers from the keyboard, rather than declaring a destination and watching a scripted camera animation
- H3 hexagonal grid plugin that renders the H3 grid over the current view at a chosen resolution, identifies a cell to inspect its index, parent, children, neighbors, and center, and exports the grid or the selection as GeoJSON or CSV
- DGGS plugins under Plugins → DGGS for three more discrete global grid systems — **A5**, **DGGRID**, and **DGGAL** — each rendering its grid over the current view at a chosen or automatic resolution with a cell-count guard, identifying a cell to read its id, parents, children, neighbors, and center, and adding the grid or the selection to the map as a layer or exporting it as GeoJSON
- Atmosphere Effects plugin that renders a deep-space backdrop, parallax starfield, comets, and an atmospheric halo around the globe at low zoom (technique adapted from [Leonel Dias](https://leoneljdias.github.io/posts/globe-atmosphere-halo-comets/)), with a Spinning Globe panel and customizable atmosphere halo and deep-space colors
- Directions plugin for interactive routing via [maplibre-gl-directions](https://github.com/maplibre/maplibre-gl-directions): click the map to add waypoints, drag to reposition, and click a waypoint to remove it (uses the public OSRM demo server, driving only)
- Install external plugins from an uploaded zip on both desktop and web, plus external plugin zip loading from the app data plugins directory and local development plugin directories, with the Manage Plugins list sorted alphabetically
- Bundled drop-in plugins under `public/plugins/<id>/` that bake into both the web and desktop builds and load automatically with no manifest URL

See the [Plugin API](plugin-api.md) to build your own.

## Deployment and platform builds

- Browser deployment with Docker, with optional HTTP Basic Auth for the web container. See [Embedding & Sharing](user-guide/embedding.md)
    - Embed-friendly URL parameters, including `?url=` project deep links that skip the welcome wizard and a `?welcome=0` param to opt out of onboarding
    - A `maponly` chrome-free mode, a `panels=collapsed` layout that keeps the Layers and Style icon rails reachable while starting both panels collapsed, and an option to hide the top toolbar outright for a focused viewer
    - A `layout=viewer` read-only preset that keeps Layers, View, Controls, basemaps, and search/identify while hiding every authoring path — menus, shortcuts, drag-and-drop import, and the plugins whose on-map control writes to the project — so an embed cannot be steered into editing
    - A `settingsUrl=` parameter that loads shared presentation settings (language, layout, accent theme, and UI profile) before the first render, restricted to presentation fields so a link cannot inject credentials, plugins, or local paths, and lasting for that page only rather than replacing what the user has saved
- Self-hostable sharing, accounts, and live collaboration, so a deployment keeps its projects on its own infrastructure
    - A documented version 1 projects and identity HTTP contract that any server may implement, with a FastAPI reference implementation in `backend/geolibre_server_api`. See [Server API](server-api.md)
    - A plain Node collaboration relay alongside the Cloudflare Durable Object one, both driven by a shared session core and both held to a single conformance suite so their permission behavior cannot drift
    - An activity log: a project owner can read who opened and edited a shared project, and a session host can download the session log, bounded in both entry count and stored bytes and read through a bearer token rather than a URL query
    - `GEOLIBRE_SHARE_URL` and `GEOLIBRE_COLLAB_URL` repoint a published web image at those servers at container runtime instead of requiring a rebuilt fork; `off` removes Share and the Project Gallery from the UI entirely, and a malformed value stops the container at boot rather than falling back to the public hosted service
- Optional Clerk access gate for a hosted deployment that needs individual sign-in, with an optional waitlist screen, loaded on demand and kept out of the default PWA precache. The gate is decided by the build target rather than by a client-controlled query parameter, so public, native, and embedded builds stay unchanged. See [Getting started](getting-started.md)
- `GEOLIBRE_NO_EXTERNAL_CDN=1` build for deployments that cannot load from untrusted third-party hosts: it strips the GeoLibre-controlled CDN references, vendors the PGlite and CereusDB engines into the build rather than dropping them, and makes the few features that genuinely need a remote host (GDAL export, ONNX object detection and Segment Everything, story map HTML export, Pyodide without a configured mirror) report that up front instead of failing at the end of a run. See [Self-hosting](self-hosting.md)
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
    - macOS installers signed with an Apple Developer ID certificate and notarized by Apple, so they open without a Gatekeeper workaround. An official [Homebrew Cask](https://github.com/Homebrew/homebrew-cask/blob/main/Casks/g/geolibre.rb) installs and upgrades them with no tap or trust step
    - A sandboxed [Mac App Store](https://apps.apple.com/app/geolibre-desktop/id6796848769) build of the same app, which trades the Python sidecar engines, server-backed PostgreSQL/PostGIS layers via martin, the local Jupyter server, Earth Engine sign-in, and external plugin installs for Store installation and updates. The in-browser SQL engines, including PGlite/PostGIS, still run. See [Downloads](downloads.md#mac-app-store)
    - Linux AppImages that carry embedded update information and a published `.zsync`, so AppImageUpdate, AppImageLauncher, AppManager, and AM can update the app by transferring only the blocks that changed
- Native Android app built from the same codebase with Tauri v2 mobile, published on [Google Play](https://play.google.com/store/apps/details?id=org.geolibre.app). See [Android](android.md)
    - A GitHub Actions workflow builds both the universal App Bundle that Play ships and signed, per-architecture sideload APKs (~40 MB)
    - A permanent `org.geolibre.app` package id, API level 36, and 16 KB page-size alignment verified in CI
    - Tools that depend on a local desktop process (Raster, Conversion, AI Segmentation, PostgreSQL/Martin) are hidden on mobile, so nothing is shown that cannot run; the WebAssembly geoprocessing toolbox needs no such process and stays available
- Native iOS app for iPhone and iPad built from the same codebase with Tauri v2 mobile, published on the [App Store](https://apps.apple.com/app/geolibre/id6796039674). See [iOS](ios.md)
    - A GitHub Actions workflow on a macOS runner archives unsigned and exports a signed, submittable `.ipa` when the Apple signing secrets are present, stamping a monotonic `CFBundleVersion` and asserting the bundle id, signature, and minimum OS version
    - The `NSLocationWhenInUseUsageDescription` string lives in a checked-in `Info.ios.plist` and covers Field Collection, GPS Tracking, and the GeoLocate control, so requesting location does not terminate the app
    - The same tools that need a local desktop process (Raster, Conversion, AI Segmentation, PostgreSQL/Martin) are hidden on iOS as they are on Android, since the iOS sandbox forbids spawning one; the WebAssembly geoprocessing toolbox stays available
- Installable, offline-capable Progressive Web App (PWA) build, plus a **Download Offline Area** tool that pre-caches the current map view's basemap tiles, and service-worker caching of the CDN-loaded Pyodide and PGlite/PostGIS engines so browser SQL and Python keep working offline after first use
