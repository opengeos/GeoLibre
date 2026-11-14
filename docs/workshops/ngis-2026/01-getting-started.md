# 1. Getting Started with GeoLibre and Cloud-Native GIS

!!! info "8:00 - 9:00 a.m."
    Lecture 15 min · Hands-on 35 min · Break 8:50 - 9:00

## Learning goals

By the end of this section you will be able to:

- Explain what "cloud-native" and "local-first" mean for a GIS, and why the
  combination lets a browser tab do real GIS work.
- Find your way around the GeoLibre workspace: the nine menus, the Layers,
  Browser, and Style panels, the status bar, the command palette, and the
  keyboard shortcuts.
- Find a place by name, by coordinates in several notations, or by an
  attribute value in your own data.
- Add data to a map from a URL, change the basemap, and inspect features.
- Name, save, recover, and reopen a project, and open GeoLibre at a location
  from a link.

## Lecture (15 min)

### What is cloud-native GIS?

Traditional desktop GIS assumes that data lives on your disk: you download a
zip, unpack it, convert it, and only then look at it. Cloud-native GIS flips
that around. Data stays where it is published, in object storage such as
Amazon S3 or Source Cooperative, or on a plain web server, and the client
reads only the parts it needs over HTTP.

Three ideas make that work:

1. **HTTP range requests.** A browser can ask a server for bytes 1,000 to
   2,000 of a file instead of the whole file. Formats designed for this keep a
   small index that a client reads first (a COG header at the start of the
   file, a GeoParquet footer at the end, Zarr metadata in its own small file),
   then fetch only the tiles or chunks for the current view. For GeoParquet,
   how much can be skipped depends on the file: spatially sorted row groups
   with bounding-box statistics, like the workshop files, let a reader skip
   most of them.
2. **Cloud-optimized formats.** Cloud-Optimized GeoTIFF (COG) for rasters,
   GeoParquet and FlatGeobuf for vectors, PMTiles for tiled maps, Zarr for
   multidimensional arrays, and COPC or EPT for point clouds. Section 2 loads
   each one.
3. **Catalogs and standard APIs.** STAC catalogs describe what data exists and
   where its files are. OGC APIs (WMS, WFS, OGC API - Features) serve maps and
   features on demand. Section 2 covers both.

The result: you can explore a 400 MB elevation model, a national county layer,
or a 20-billion-point LiDAR survey from a laptop browser in seconds, without a
server of your own.

### Cloud-native, local-first, open source

GeoLibre is a free, open-source (MIT) GIS built for this model. Three
properties define it, and they are worth keeping apart:

| Property | What it describes | In practice |
| --- | --- | --- |
| **Cloud-native** | The data GeoLibre is built to read | COG, GeoParquet, PMTiles, FlatGeobuf, Zarr, COPC, and STAC are first-class. A 400 GB Zarr store on S3 is an ordinary layer, because the app never tries to hold all of it |
| **Local-first** | Where computation and state live | Your project is a file on your disk, not a row in a vendor database. Files you open are parsed in your tab by DuckDB-WASM; the geoprocessing tools run on WebAssembly in the same tab. No account, no upload step, no server you must keep running |
| **Open source** | The license and the documented formats | The project file is documented JSON and the plugin API is public, so you can automate, embed, extend, and self-host GeoLibre without asking anyone |

Together they describe an app that streams a petabyte-scale public archive
without ever asking you to trust it with your own files. Your data leaves your
machine only when you share or export it, or when you send a request to a
remote AI provider through the AI Assistant. Searching places sends the search
text to a geocoding service, and catalog and service searches send the map
extent to that service.

### What runs in your browser tab

You do not need to know the stack to use GeoLibre, but it explains a lot of
the app's behavior:

| Component | Job |
| --- | --- |
| **MapLibre GL JS** (default renderer) | Draws the map. Mapbox GL JS, CesiumJS, and the ArcGIS Maps SDK can take its place under **View → Rendering engine** |
| **deck.gl** | Point clouds, 3D Tiles, glTF models, and large overlays |
| **DuckDB-WASM Spatial** | Converts vector files the renderer cannot draw, reads GeoParquet, and backs the SQL workspace |
| **WebAssembly geoprocessing** | More than 1,000 Whitebox and GeoLibre tools, entirely client-side |
| **Pyodide** | Runs GeoPandas code in the browser for the Python engine of the vector tools |
| **Tauri v2** | Wraps the same web app as the desktop, Android, and iOS apps |

The same app ships in several shells: the browser at
[web.geolibre.app](https://web.geolibre.app) (installable as a Progressive
Web App), desktop installers for Windows, macOS, and Linux, Android and iOS
apps, a Jupyter widget through the `geolibre` Python package, an R
htmlwidget, and an MCP server for AI agents. A project made in any of them
opens in all the others. The rule for what differs is simple: **anything that
needs a local process is missing where there is no local process.** The web
build has no native file dialogs and no Python sidecar, but the WebAssembly
toolbox works everywhere, which is why this workshop uses only the browser.

### How it compares

GeoLibre is not trying to replace QGIS or ArcGIS Pro. Think of it as the
GIS that is one click away.

| | GeoLibre | QGIS | ArcGIS Pro |
| --- | --- | --- | --- |
| Runs in a browser | The full app | No | No |
| Desktop | Windows, macOS, Linux | Windows, macOS, Linux | Windows only |
| Project file | `.geolibre`, open documented JSON | `.qgs` / `.qgz` | `.aprx`, proprietary |
| Geoprocessing | 1,000+ tools on WebAssembly, plus a Model Builder | 1,000+ native, GDAL, GRASS, SAGA | The most complete |
| Spatial SQL | DuckDB, PGlite/PostGIS, all client-side | Virtual layers, DB Manager | Enterprise geodatabases |
| Cost | Free, MIT | Free, GPL | Subscription |

Where it is *not* the right tool: multi-gigabyte local processing jobs
(browser memory is a real ceiling), the long tail of formats only GDAL reads,
and enterprise geodatabase administration. The tools also compose: GeoLibre
imports QGIS `.qgs`/`.qgz` and ArcGIS Pro `.aprx`/`.mapx` projects, so you
can author in one and publish with the other.

### The workspace

| Area | What it does |
| --- | --- |
| Top toolbar | **Project**, **Edit**, **View**, **Add data**, **Processing**, **Controls**, **Plugins**, **Settings**, **Help**. The light/dark toggle and the editable project name sit on the right |
| Layers panel (left) | The layer stack, basemap included as the **Background** row. Visibility, opacity, reorder, zoom to layer, identify, style, layer actions (**⋯**), metadata, remove |
| Browser panel (left rail) | A data-source tree: saved services, recent items, favorites, databases |
| Style and Comments panels (right rail) | Symbology, labels, and popups for the selected layer; review comments |
| Search box (bottom of the Layers panel) | Places, coordinates, H3 cells, and attribute matches from your own layers |
| Status bar (bottom) | Pointer coordinates, zoom, eye altitude, bearing, pitch, bounding box, and a **Diagnostics** counter for network and console errors |

**Edit** and **View** are the two most easily missed menus, because their
contents (undo, selections, Set view, split view, rendering engine) live
nowhere else.

!!! tip "Coming from QGIS or ArcGIS Pro"
    The Layers panel and Browser panel will feel familiar. What QGIS spreads
    across docks, a Processing Toolbox, and a Layout Manager, GeoLibre gathers
    into nine menus and one **command palette** (`Ctrl+K`, `Cmd+K` on macOS):
    type a tool or menu name and press Enter.

### Projects are references, not data

A **project** captures the whole workspace: the map view, the basemap and
rendering engine, every layer with its source and style, preferences, and
plugin state. Three things about it matter today:

- **It stores references, not copies.** A layer records *where* its data is,
  so a project that maps a national dataset is still a few kilobytes. The flip
  side is that a project can save perfectly and still draw nothing for a
  colleague who cannot reach its sources. The exceptions are layers with no
  URL to point at: points built from a CSV, features fetched from a feature
  service, layers you draw, and analysis results are embedded in the file.
  Check what a project embeds before you share one built from private data.
- **Sharing strips credentials.** Share links, HTML exports, embeds, and
  live sessions remove API keys and tokens. A local **Save** can keep them:
  the desktop app moves keys to the system keychain, and otherwise GeoLibre
  asks whether to keep or strip them. Choose strip before you commit a
  project to Git or email it. Redaction only knows common names such as
  `token` and `apiKey`, so check layer URLs for other keys before you share.
- **It is plain JSON.** Projects save as `.geolibre` files. Earlier releases
  used `.geolibre.json`, and GeoLibre still opens those everywhere (the
  workshop's finished projects use that name).

Behind the scenes, GeoLibre also **autosaves** a snapshot to your browser's
storage about three seconds after each change settles. Autosaves never touch
your project file, only **Save** does. **Project → History...** lists the
snapshots, compares any of them with the current map, and restores one in a
single undoable step.

## Hands-on (35 min)

### Exercise 1.1: Open GeoLibre and look around (3 min)

1. Open [web.geolibre.app](https://web.geolibre.app) in Chrome, Edge, or
   Firefox. If a welcome screen asks for your experience level, choose
   **Advanced** (or skip it) so you see every menu used today.
2. Open each top-level menu. Note that **Add data** groups its sources under
   five headings: **Files**, **Web services**, **Cloud formats**,
   **3D layers**, and **Databases**.
3. The map starts as a globe. Scroll to zoom in; the projection flattens to
   Web Mercator as you zoom. Watch the status bar update as you move.
4. Open **Help → About**. The version reads **v3.7.0** (or later).

### Exercise 1.2: The command palette and shortcuts (4 min)

1. Press `Ctrl+K` (`Cmd+K` on macOS) to open the command palette and type
   `hillshade`. The list groups the matches: the GeoLibre **Hillshade** tool
   under **Processing**, then **Hillshade**, **Lidar Hillshade**,
   **Hypsometrically Tinted Hillshade**, and **Multidirectional Hillshade**
   under **Whitebox toolbox**. Every individual tool is one search away.
   Press `Esc`.
2. Click on the map so it has focus, then press `?`. The **Keyboard
   shortcuts** sheet lists the global set, including `Ctrl+S` to save,
   `[` and `]` for previous and next view, and `N`, `U`, and `R` to reset
   bearing, pitch, or both. Press `Esc`.
3. Try navigating with the keyboard: arrow keys pan, `+` and `-` zoom,
   `Shift+←`/`→` rotate, `Shift+↑`/`↓` tilt. Press `R` to reset the camera,
   then `[` to step back through the views you just visited.

!!! tip "Shortcuts and text fields"
    Single-key shortcuts are ignored while you type in a text box, so they
    never fight with the search box or an attribute edit. If `?` does nothing,
    click the map first.

### Exercise 1.3: Find a place three ways (5 min)

The search box at the bottom of the Layers panel decides what you typed and
handles it accordingly.

1. **By name.** Type `Reno` and pick **Reno, Washoe County, Nevada, United
   States** from the results (it may not be the first entry). The map flies
   to Reno at about zoom 12.
2. **By coordinates.** Clear the box and type `39.5442, -119.8160` (latitude
   first). The only result is **Go to 39.5442, -119.816**. Pick it to fly to
   the University of Nevada, Reno campus, near this workshop's venue.
3. **Read the coordinate in other notations.** The **Coords** readout in the
   status bar follows the pointer and shows `–` when the pointer leaves the
   map. Click the readout to switch to the next format, then rest the pointer
   on the campus again to read it. Seven clicks cycle through seven formats.
   Near the campus you will see, in order:

    | Format | Readout |
    | --- | --- |
    | Decimal degrees (longitude first) | `-119.81600, 39.54406` |
    | Degrees, minutes, seconds | `39°32'38.64"N 119°48'57.6"W` |
    | Degrees, decimal minutes | `39°32.6441'N 119°48.96'W` |
    | UTM | `11S 258017mE 4380943mN` |
    | MGRS | `11SKD5801780942` |
    | USNG | `11S KD 58017 80942` |
    | Web Mercator | `-13337856.11, 4799906.95 (EPSG:3857)` |

    Your digits will differ slightly with the pointer position.
4. **By grid reference.** Type the MGRS reference `11SKD5801780942` into the
   search box. The result reads **Go to 11SKD5801780942 (39.544064,
   -119.815999)**: the same spot, parsed without a geocoder round trip.

!!! question "Discussion"
    Decimal degrees in the status bar are written longitude first, like
    GeoJSON, but you typed latitude first in the search box. Where has a
    swapped coordinate pair caught you out before, and which formats avoid the
    ambiguity entirely?

### Exercise 1.4: Change the basemap (3 min)

1. In the Layers panel, double-click the **Background** row (or click its
   **⋯** button) to open **Change background**.
2. Browse the families: **OpenFreeMap** (Liberty, Liberty 3D, Positron,
   Bright, Dark, Fiord), **Protomaps**, **Regional**, **The Moon**, **Mars**,
   **Other celestial bodies**, and **Other** (Blank, Custom URL).
3. Click **Positron**. The basemap switches to light gray and the dialog
   closes. Reopen it and try **Dark**, then **Liberty 3D**.
4. Finish on **Liberty**. Liberty 3D tilted the camera to 60° to show its
   buildings, and switching back keeps that pitch, so click the map and press
   `R` to level it.

!!! tip "Coming from QGIS or ArcGIS Pro"
    The basemap is a real row in the Layers panel, not a hidden setting. It
    sits at the bottom of the stack, takes an opacity slider like any other
    layer, and can be hidden with its eye icon.

### Exercise 1.5: Add data by URL and inspect it (8 min)

1. Choose **Add data → Vector layer**. The **Add Vector Layer** panel opens
   over the map.
2. Paste this URL into the URL box and click **Load**:

    ```text
    https://data.source.coop/opengeos/data/workshops/ngis-2026/nv_counties.geojson
    ```

3. Paste a second URL and click **Load** again:

    ```text
    https://data.source.coop/opengeos/data/workshops/ngis-2026/reno_sites.geojson
    ```

4. Close the panel with its **×**. The Layers panel now lists `reno_sites`
   above `nv_counties`, both tagged **VECTOR**, and the map has zoomed to the
   Reno-Tahoe area (about zoom 10).
5. **Identify one layer.** On the `reno_sites` row, click **Identify
   features** (the pointer icon) and click the point west of Washoe Lake. The
   popup shows `id` **5**, `name` **Mount Rose summit**, and `kind` **peak**.
   Click the icon again to turn identify off.
6. **Identify everything under the pointer.** Click **Identify visible
   layers** in the Layers panel header (the pointer icon next to the eye) and
   click inside Washoe County, north of Lake Tahoe. **Identified results**
   lists `nv_counties` with `GEOID` **32031**, `NAME` **Washoe**, `ALAND`
   **16358036858** (land area in square meters, about 16,358 km²), and
   `AWATER` **582745905**. Turn the tool off again.
7. **Search your own data.** Type `Esmeralda` into the search box. A group
   labeled **NV_COUNTIES** appears above the place results, with the match
   **Esmeralda** in the `NAME` field. Pick it: the county is selected and
   highlighted, and the map flies to it, around Tonopah. Clear the box.
8. Drag the opacity slider on `nv_counties` down to **0.50**.

![The first map: Nevada counties at half opacity and the Reno-Tahoe landmarks over the Liberty basemap](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s01-getting-started.webp)

!!! tip "Typing a county name finds your county"
    Attribute matches run locally and appear before the geocoder answers, so
    a parcel number, station ID, or county name finds the feature in your data
    rather than a similarly named place elsewhere. This is the QGIS Locator
    bar habit without configuring a locator filter.

### Exercise 1.6: Name the project, then recover from a mistake (5 min)

1. Double-click `nv_counties` in the Layers panel and rename it
   `Nevada counties`; press Enter. Rename `reno_sites` to `Reno-Tahoe sites`.
2. Click the project name at the top right (it reads **Untitled Project**),
   type `NGIS 2026 - 1 Getting started`, and press Enter.
3. Wait five seconds so an autosave lands. Then make a deliberate mistake:
   click the `Reno-Tahoe sites` row, press `Delete`, and confirm **Remove**
   in the **Remove layer?** dialog. The points disappear. Wait another five
   seconds.
4. Choose **Project → History...**. **Project history** lists the autosaved
   snapshots, newest first, each with a layer count and the zoom at that
   moment, for example **1 layers · zoom 8.3** above **2 layers · zoom 8.3**.
5. Click **Compare** on the newest **2 layers** snapshot. The comparison reads
   **1 change**, with **Layers 1** and the row **Removed · Reno-Tahoe
   sites**.
6. Click **Back to snapshots**, then **Restore** on that same **2 layers**
   snapshot. The dialog closes and `Reno-Tahoe sites` is back in the Layers
   panel. The map is still on Esmeralda County from the last exercise, so
   click **Zoom to layer** (the magnifier) on the restored row to see the
   points again.

![Project history comparing the pre-mistake snapshot with the current project](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s01-history-compare.webp)

!!! tip "Restore one layer instead of the whole snapshot"
    The **Removed · Reno-Tahoe sites** row in the comparison has its own
    **Restore this layer** button. It brings back just that layer and leaves
    everything else as it is now; the dialog confirms with **Restored
    "Reno-Tahoe sites". Use Undo to revert it.**

!!! tip "Undo is faster for the last step"
    **Edit → Undo** (`Ctrl+Z`) also brings back a removed layer. History is
    for going further back, or for seeing exactly what changed since a
    snapshot. A restore is itself undoable, so you can try one and back out.

!!! warning "History lives on this device only"
    Snapshots are stored in this browser, keyed by the project's name until
    you save it and by its file name afterwards. They are not uploaded, not
    shared, and not part of the project file. A browser profile that clears
    site data on exit loses them, so **Save** is still your real backup.

### Exercise 1.7: Save and read the project file (4 min)

1. Choose **Project → Save** (or press `Ctrl+S`, `Cmd+S` on macOS). Chrome and
   Edge open a system save dialog. Firefox asks for a **File name** and
   downloads the file to your downloads folder. The suggested name is
   `NGIS 2026 - 1 Getting started.geolibre`.
2. The project name in the toolbar is now followed by the file name.
3. Open the file in a text editor. It is about 20 KB of JSON. Find the
   `layers` array: each layer stores its `name`, its `opacity` (`0.5` for the
   counties), and a `source` with the data **URL**, not the data. Find
   `mapView`, which stores the camera's `center`, `zoom`, `bearing`, and
   `pitch`, and `basemapStyleUrl`, the Liberty style.

!!! question "Discussion"
    The counties file this project points to is on Source Cooperative. What
    happens to your map if that file is moved or deleted? What would you
    change if the project had to keep working for ten years?

### Exercise 1.8: Reopen from a link (3 min)

1. A project file on any public web server that allows cross-origin (CORS)
   requests opens with one link. Open the finished project for this section:

    ```text
    https://web.geolibre.app/?url=https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/01-getting-started.geolibre.json
    ```

    You can also paste the project URL into **Project → Open from → URL...**,
    or reopen the file you saved with **Project → Open from → File...**.
2. Links can also open a place instead of a project. Open this in a new tab:

    ```text
    https://web.geolibre.app/?14/39.5442/-119.8160
    ```

    The compact form is zoom/latitude/longitude, so the map opens on campus at
    zoom 14.00. Pan the map and watch the address bar: it gains
    `lat=...&lon=...&zoom=...` parameters that follow the view, so copying the
    URL is the quickest way to share where you are looking.

### If you finish early

- **Switch rendering engines.** Choose **View → Rendering engine → Cesium**.
  The same project redraws on a 3D globe over satellite imagery, with both
  layers intact; a notice explains that a Cesium Ion token adds terrain and
  Ion imagery. The **Diagnostics** counter picks up about nine Cesium
  warnings (deprecation notices and "outlines are unsupported on terrain");
  they are harmless. Switch back with **View → Rendering engine → MapLibre**.
- **Check a palette for color-vision deficiencies.** Choose **View → Color
  vision preview → Deuteranopia (green-blind)**. Only the map is filtered,
  and a badge reminds you the preview is on. It is never saved or exported.
  Choose **Off** to end it.
- **Simplify the interface.** Under **Settings → Interface**, pick
  **Beginner**. The **Add data** menu shrinks from more than 40 entries to 9
  (vector, raster, delimited text, MBTiles, XYZ, WCS, WMS, administrative
  boundaries, and GeoParquet). Nothing is removed; pick **Advanced** to bring
  everything back. An instructor can hand a class the same simplified view
  with an interface file.
- **Ask "What's here?"** Right-click the map. The context menu shows the
  clicked coordinate (click it to copy), **What's here?**, **Copy as
  GeoJSON**, directions, **Quick analysis**, and Google Maps and Google Earth
  hand-offs. **What's here?** first asks before sending the coordinate to
  Wikipedia, then shows a knowledge card with nearby places.

## Check your work

[Open the finished project](https://web.geolibre.app/?url=https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/01-getting-started.geolibre.json){ .md-button .md-button--primary }

The finished project opens on the Reno-Tahoe area at zoom 9 with the Liberty
basemap, `Reno-Tahoe sites`, and `Nevada counties` at 0.50 opacity. The raw
file is
[`01-getting-started.geolibre.json`](https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/01-getting-started.geolibre.json).

## Going further

- Browse the shared gallery with **Project → Open from → Gallery...**, or
  start from a curated example in the **Examples** section of
  **Project → New...**.
- **Project → Duplicate project** copies the open project into an unsaved one,
  so you can experiment without touching the original.
- **Project → Save as template...** with **Strip data layers** keeps your
  basemap, groups, and styles as a house-style starting point for new maps.
- The planet switcher (the orbit icon in the Layers panel header) moves the
  map to the Moon, Mars, and other bodies, and sets the ellipsoid that the
  scale bar and the Measure tool use.
- **Settings → Startup settings** sets where a new, empty map opens, so a
  personal install or a team deployment starts on Nevada instead of the whole
  world.
- Install the [desktop app](../../downloads.md) to open and save projects on
  disk, read local rasters and MBTiles, and run the optional Python sidecar.
- The [Open data in GeoLibre](../../user-guide/chrome-extension.md) browser
  extension lists the datasets linked on any web page and opens them in
  GeoLibre in one click.
- Read [Interface Overview](../../user-guide/interface.md),
  [Projects](../../user-guide/projects.md),
  [Map Controls](../../user-guide/map-controls.md),
  [Rendering Engines](../../user-guide/rendering-engines.md),
  [How GeoLibre Compares](../../comparison.md), and
  [Privacy](../../privacy.md).

---

**Break: 8:50 - 9:00.** Next: [2. Bringing In Cloud-Hosted Data](02-bringing-in-data.md)
