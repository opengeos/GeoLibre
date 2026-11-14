# 5. Analysis and Processing

!!! info "1:00 - 2:00 p.m."
    Lecture 12 min · Hands-on 38 min · Break 1:50 - 2:00

## Learning goals

By the end of this section you will be able to:

- Explain where each kind of analysis runs in GeoLibre (your browser, a
  WebAssembly toolbox, a Python sidecar, or a remote service) and pick an
  engine on purpose.
- Find any of the 1,000+ processing tools from the Processing menu search.
- Buffer features, attach attributes with a spatial join, and summarize the
  result without writing SQL.
- Bin points into H3 hexagons and test whether the clusters you see are
  statistically significant hot spots.
- Derive hillshade and slope from an elevation model, and run a viewshed and a
  drive-time isochrone from a right-click.
- Chain several tools into a reusable workflow with Model builder.

## Lecture (12 min)

### Where analysis runs

Section 4 used SQL for analysis. This section uses the point-and-click tools,
and the first thing to know about them is where they compute. Most run on
your own machine, inside the browser tab:

| Engine | Where it runs | Used for |
| --- | --- | --- |
| **Client (Turf.js)** | Browser | The default engine of the GeoLibre toolbox vector tools |
| **Python (Pyodide)** | Browser | The same GeoPandas and Shapely code as the sidecar, compiled to WebAssembly |
| **Client raster tools** | Browser | Hillshade, Slope, Aspect, Clip by extent, Raster calculator, Spectral index, Reclassify, Focal statistics |
| **DuckDB-WASM extensions** | Browser | DGGS tools (H3, A5, DGGRID) |
| **Spatial statistics** | Browser | Moran's I, Getis-Ord Gi\*, kernel density, Emerging Hot Spot, composite scores |
| **WhiteboxTools and GeoLibre tools (WebAssembly)** | Browser | The 1,000+ tool Whitebox toolbox and Model builder |
| **Python sidecar** (rasterio, GeoPandas) | Desktop app, or a self-hosted server | Reproject, Resample, Contour, Zonal statistics, Polygonize, and batch runs over folders |
| **Valhalla routing server** | Remote service | Isochrones, OD cost matrices, routes |

Everything in this section runs in the web app with no installation. The one
exception to "your data stays on your machine" is routing: a drive-time
isochrone sends the clicked coordinate to a public Valhalla server, and
GeoLibre asks before it does.

### Two toolboxes, one menu

The **Processing** menu holds two toolboxes, and category names such as
**Vector** and **Raster** appear in both:

- **Whitebox toolbox** and the category submenus under it (**Hydrology**,
  **LiDAR**, **Terrain**, **Remote sensing**, and others) are the WebAssembly
  catalog: more than 1,000 tools from WhiteboxTools and GeoLibre's own Rust
  tools. Hydrology and LiDAR live only here.
- **GeoLibre toolbox** holds guided dialogs: **Vector**, **Raster**,
  **Network**, **Spatial statistics**, **DGGS**, and a few more. These are the
  tools with an engine picker.

You do not need to remember which is which. The **Search processing tools...**
box at the top of the Processing menu searches both, and pressing `Enter`
opens the highlighted tool. Search for `Hillshade` and you get the GeoLibre
dialog first, then the Whitebox **Hillshade**, **Lidar Hillshade**,
**Hypsometrically Tinted Hillshade**, and **Multidirectional Hillshade** tools.

!!! tip "Coming from QGIS or ArcGIS Pro"
    The tool names are the familiar ones: Buffer, Clip, Dissolve, Spatial join,
    Hillshade, Slope. **GeoLibre toolbox** plays the role of the QGIS
    Processing Toolbox's native algorithms, the **Whitebox toolbox** is the
    WhiteboxTools plugin, **Model builder** is ModelBuilder or the Graphical
    Modeler, and **Processing → History** is the Geoprocessing History pane.

### Choosing a vector engine

Every GeoLibre toolbox vector tool offers three engines in an **Engine** menu:

| | Client (Turf.js) | Python (Pyodide) | Sidecar (GeoPandas) |
| --- | --- | --- | --- |
| Where it runs | Browser | Browser | Local Python process |
| Works on the web build | Yes | Yes | No |
| How a buffer gets to meters | Per feature, in its own local projection | One UTM zone for the whole layer | One UTM zone for the whole layer |
| Layer spanning more than 180° of longitude | Fine | Refused | Refused |
| First-run cost | None | Downloads the Python runtime once (tens of MB) | Needs the `vector` extra |
| Matches a GeoPandas script exactly | Approximately | Yes | Yes |

For a study area like ours (a county, a state) all three agree to well within
anything you could see on a map. For a continental or global layer, the
Client engine is the safer choice, because a single UTM zone stretches badly
far from its central meridian. We use the Client engine today because it has
no download and the venue network is shared.

Since v3.7, lengths and areas computed from geometry (field calculator
`$area`, movement tools, distance thresholds) are measured on the WGS 84
ellipsoid with GeographicLib, the same algorithms as PROJ and pyproj. Distance
parameters are typed in meters, kilometers, or miles and converted for you;
you never need to reproject first just to buffer.

### Grids and spatial statistics

Eight thousand earthquake points are hard to read; 500 hexagons with counts
are easy. A **discrete global grid system (DGGS)** bins the world into cells
of nearly equal area, so counts are comparable, and every cell has a stable
ID that does not change when a boundary is redrawn. **H3**, Uber's hexagonal
grid, is the most widely used:

| H3 resolution | Approximate edge length | Good for |
| --- | --- | --- |
| 5 | about 8 km | Regional patterns (today's exercise) |
| 7 | about 1.2 km | City-wide patterns |
| 9 | about 170 m | Neighborhoods |
| 11 | about 25 m | Buildings |

Binning shows a pattern. **Spatial statistics** ask whether the pattern is
distinguishable from chance. **Getis-Ord Gi\*** compares each cell and its
neighbors with the whole layer and labels statistically significant hot and
cold spots at 90, 95, and 99% confidence.

!!! warning "Three ways to fool yourself with a hot-spot map"
    1. **Significance is not importance.** With many cells, small differences
       reach significance.
    2. **The cell size is a choice.** Rerun at a coarser and a finer
       resolution; a pattern that survives all of them is real (this is the
       modifiable areal unit problem, and hexagons do not make it go away).
    3. **Counts are not rates.** A hot spot of incident counts is often a hot
       spot of population. For earthquakes there is no population
       denominator, but there is a detection one: the seismic network is
       denser in some places than others.

### Terrain from an elevation model

The client raster tools compute on the layer already on the map, so a
hillshade of a 2520 × 3240-pixel DEM takes seconds and needs no server. Two
notes:

- The **Z factor** converts vertical units to horizontal units. The browser
  engine handles our geographic (EPSG:4326) DEM correctly with a Z factor of
  1; if you take the same DEM to a desktop GIS, reproject it to a metric CRS
  first or the hillshade looks like crumpled paper.
- The right-click **Quick analysis** menu runs a **viewshed** or **line of
  sight** on the map's own global terrain tiles, so it needs no DEM at all.
  It is reconnaissance: the quick viewshed ignores Earth curvature and
  refraction (immaterial over a few kilometers), and the terrain tiles are a
  generalized global model that knows nothing about buildings or trees.

### From clicks to a reproducible workflow

Every toolbox and quick-analysis run is recorded in **Processing → History**
with its parameters, engine, and duration, and can be re-run, edited, or
copied as JSON or Python. **Model builder** goes one step further: wire tools
into a graph, and the whole graph is validated before anything runs, so a
missing input or a mismatched data type is a red message on the canvas rather
than a failure forty minutes in. A saved model re-runs on other layers,
exports to a `.model.json` file, or becomes a Python script for the `geolibre`
package (Section 8).

## Hands-on (38 min)

Start a new project: **Project → New...**, name it
`NGIS 2026 - 5 Analysis and processing`, and click **Create**. Use **Add data →
Vector layer** to load these three URLs (paste each and click **Load**), then
close the panel:

```text
https://data.source.coop/opengeos/data/workshops/ngis-2026/nv_counties.geojson
https://data.source.coop/opengeos/data/workshops/ngis-2026/nv_earthquakes.parquet
https://data.source.coop/opengeos/data/workshops/ngis-2026/reno_sites.geojson
```

Then use **Add data → Raster layer** to load the elevation model, and close
that panel too:

```text
https://data.source.coop/opengeos/data/workshops/ngis-2026/reno_tahoe_dem.tif
```

Hide `nv_counties` and `nv_earthquakes` (eye icon) so the map is not
cluttered. The earthquakes still take part in every analysis while hidden.

### Exercise 5.1: Buffer the landmarks (4 min)

1. Open the **Processing** menu and type `Buffer` into **Search processing
   tools...**. Press `Enter` on the first result. (The long way is
   **Processing → GeoLibre toolbox → Vector → Buffer**.)
2. The **Vector tools** dialog opens with **Buffer** selected. Notice the list
   on the left: Geometry, Overlay, Join, Select, DGGS, Movement & time, Data
   management, and Data quality tools all live in this one dialog.
3. Set **Input layer** to `reno_sites`, **Distance** to `10`, **Units** to
   Kilometers, and **Buffer side** to Outside (grow). Leave **Dissolve
   result** unticked and **Engine** on Client (Turf.js).
4. Click **Run**. The output reads **Buffered 8 feature(s) by 10 kilometers
   (outside)**, and a `Buffer` layer appears with one circle per landmark.

!!! tip "Three buffer sides"
    **Inside (shrink)** erodes a polygon (a setback, a riparian interior);
    **Both sides** keeps a band on either side of a boundary (a shoreline
    zone). Direction comes from the side setting, never from a negative
    distance.

### Exercise 5.2: Which earthquakes fall in each buffer? (6 min)

A **spatial join** attaches the attributes of one layer to the features of
another based on where they are. Keep the dialog open.

1. Click **Spatial join** in the **Join** group.
2. **Input layer**: `nv_earthquakes`. **Join layer**: `Buffer`.
   **Spatial relationship**: Within. **Join type**: Inner (keep only matched
   features).
3. Click **Run**. The output reads **Spatial join: produced 29 feature(s)**,
   and a `Spatial join` layer appears: the earthquakes within 10 km of a
   landmark, each now carrying that landmark's `name` and `kind`.
4. Close the dialog. On the `Spatial join` row, open **Layer actions (⋯) →
   Open attribute table**. The footer reads **29 features**.
5. Click **Explore all fields at a glance** in the table toolbar. The **Column
   explorer** shows the distribution of every field. Under `name`:

    | Landmark | Earthquakes within 10 km |
    | --- | --- |
    | Mount Rose summit | 13 |
    | Nevada State Capitol, Carson City | 7 |
    | Tahoe City | 5 |
    | Incline Village | 2 |
    | Reno-Tahoe International Airport | 1 |
    | Virginia City | 1 |

    The same counts come out of a SQL `ST_Intersects` join in the SQL
    workspace. The workshop venue and Downtown Reno are missing: an inner
    join drops landmarks with no matches.

6. Close the Column explorer and the attribute table.

!!! question "Discussion"
    The `name` counts add up to 29, but the `time` card in the Column explorer
    reports only **27 unique** values. Two earthquakes were counted twice.
    Look at the map: why? (Hint: the Mount Rose and Incline Village buffers
    overlap.) When would you want **Dissolve result** ticked on the buffer
    instead?

### Exercise 5.3: Bin earthquakes into H3 hexagons (6 min)

1. In **Search processing tools...**, type `DGGS Binning` and press `Enter`.
2. **DGGS type**: H3. **Input point layer**: `nv_earthquakes`. **Aggregate**:
   Count. **Resolution (0-15)**: `5`.
3. Click **Run**. The output reads **Binned points into 511 H3 cell(s) at
   resolution 5**, and the map zooms out to an `H3 bins (res 5)` layer
   covering Nevada and eastern California.
4. Close the dialog and open the new layer's attribute table. It has two
   fields, `h3` (the cell ID) and `count`. Click the `count` header twice to
   sort from high to low. The top three cells hold **802**, **765**, and
   **719** earthquakes.
5. Copy the top cell's ID, `85298eb3fffffff`, and paste it into the search box
   at the bottom left. The match in your `H3 bins (res 5)` layer is listed
   first; under **Places**, pick **Go to H3 cell 85298eb3fffffff (res 5)**. The map
   frames a hexagon in the Monte Cristo Range of west-central Nevada: the M6.5
   earthquake of May 15, 2020 and its aftershocks.
6. Close the attribute table and clear the search box.

!!! tip "Cells are the join key"
    The search box accepts any H3 index, as hex or as a 64-bit integer, so a
    cell ID in a spreadsheet, a log file, or a colleague's message becomes a
    place you can look at. **Plugins → DGGS → H3** draws the live grid and
    reports a clicked cell's parent, children, and neighbors.

### Exercise 5.4: Are the clusters real? Getis-Ord Gi\* (5 min)

1. In **Search processing tools...**, type `Getis` and press `Enter`. The
   **Spatial statistics** dialog opens on **Getis-Ord Gi\* hotspots**. The list
   on the left also has Global and Local Moran's I, Average nearest neighbor,
   Kernel density, Emerging Hot Spot, and Composite score.
2. **Layer**: `H3 bins (res 5)`. **Value field**: `count`. Keep **Spatial
   weights** on K nearest neighbors and **Neighbors (k)** at 8.
3. Click **Run**. The output reads **Getis-Ord Gi\* for "count": 34 hot-spot,
   0 cold-spot features (n=511).** A new layer, `H3 bins (res 5) — Gi*
   (count)`, appears. Its attribute table adds `count_gi_z`, `count_gi_p`,
   `count_gi_bin`, and `count_gi_class` (for example **Hot spot 99%**).
4. Close the dialog. Hide `H3 bins (res 5)`, then click the palette icon on
   the Gi\* layer. Under **Style suggestions**, click **Categorize by
   count_gi_bin**.
5. The significant cells (bin `3`, 99% confidence) turn yellow in two
   clusters: the Monte Cristo Range in west-central Nevada, and the
   Ridgecrest and Coso area of eastern California, home of the M7.1 Ridgecrest
   earthquake of July 2019.

![Getis-Ord Gi* hot spots of earthquake counts in H3 resolution 5 cells: two 99% clusters, in west-central Nevada and around Ridgecrest, California](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s05-h3-hotspots.webp)

!!! question "Discussion"
    The tool found **0 cold spots**. Is the rest of Nevada really "normal"?
    Think about which cells are in the input layer at all. Binning creates a
    cell only where at least one earthquake fell, so the quiet places that
    would make cold spots are missing. How would you fix that? (Hint: **DGGS
    Generator** fills an area with empty cells.)

### Exercise 5.5: Hillshade and slope in the browser (6 min)

1. Hide the Gi\* layer and click **Zoom to layer** on `reno_tahoe_dem.tif`.
2. Search for `Hillshade` in the Processing menu and press `Enter`. The
   **Raster tools** dialog opens.
3. **Engine**: Client (browser) (the sidecar option is greyed out on the web).
   **Use a layer on the map**: `reno_tahoe_dem.tif`. Keep **Azimuth
   (degrees)** 315, **Altitude (degrees)** 45, and **Z factor** 1.
4. Click **Run**. The log reports **Loaded raster: 2520×3240, 1 band(s).**, a
   note that the raster is large (8.2 M pixels), then **Computed "Hillshade"
   in the browser.** and **Added "hillshade.tif" to the map.**
5. Click **Slope** in the same dialog. Choose the DEM again, keep **Units** on
   Degrees, and click **Run**. A `slope` layer appears.
6. Close the dialog. In the Style panel for `slope`, open **Color ramp** and
   pick **magma**. Steep canyon walls and the Carson Range escarpment glow;
   Lake Tahoe and the valley floors go dark. Click **Inspect pixel values** on
   the `slope` row and click a few places to read slopes in degrees.
7. Hide `slope`. Drag the `hillshade` opacity slider to about 0.5, and give
   the DEM the **terrain** color ramp in its Style panel. Color now shows
   elevation and the hillshade shows relief.

!!! warning "Computed rasters are not saved"
    The hillshade and slope live only in browser memory. When you save,
    GeoLibre warns that local raster layers were not saved with the project.
    Click **Download GeoTIFF** in the tool dialog to keep one, then host it
    and add it by URL. The finished project points at a hosted copy,
    `reno_tahoe_hillshade.tif`. Vector results (buffers, joins, bins) are
    embedded in the project file instead.

### Exercise 5.6: Viewshed and drive time from a right-click (5 min)

1. The `reno_sites` points now sit under the DEM and the buffers, so go to
   Mount Rose by coordinates: **View → Set view...**, **Longitude**
   `-119.9179`, **Latitude** `39.3438`, **Zoom** `13`, and press `Enter`. The
   summit is now at the center of the map. Right-click the center and choose
   **Quick analysis → Viewshed from here (15 km)**.
2. A `Viewshed (15 km)` image layer appears within a few seconds and the map
   zooms out to its extent. Green is ground visible from an observer standing
   on that spot. No DEM was needed: it read the same global terrain tiles as
   3D terrain.
3. Hide the viewshed and the DEM. Go to the workshop venue the same way
   (**View → Set view...**, `-119.816`, `39.5444`, zoom `13`), right-click
   the center of the map, and choose **Quick analysis → Drive time from here
   (5, 10, 15 min)**.
4. The first time you run a network tool, a dialog, **Network analysis uses an
   external routing server**, explains that the coordinate will be sent to the
   public Valhalla server at `valhalla1.openstreetmap.de`. Click **Continue**.
   The browser remembers your answer, so later runs skip the dialog.
5. A `Drive time` layer appears: three nested areas reachable by car in 5, 10,
   and 15 minutes, stretching along I-80 and US-395 and thinning into the
   hills. In its Style panel, click the **Categorize by contour** suggestion
   to color the three bands.

!!! question "Discussion"
    Compare the 15-minute drive-time area with a 10 km circle around the
    venue. Which places are inside the circle but not reachable in 15
    minutes, and why? Which question does each answer?

### Exercise 5.7: A stream network with Model builder (6 min)

1. Choose **Processing → Model builder**. A floating panel opens: the tool
   palette on the left, the canvas in the middle, settings on the right, and a
   message log at the bottom.
2. Click **Samples** and pick **DEM stream network extraction**. The log
   reads **Added sample data "Sample DEM" to the map.** and **Loaded sample
   "DEM stream network extraction".** The canvas shows an **Input** node wired
   to a chain of Whitebox tools.
3. Point the model at our DEM instead of the sample: click the **Input** node,
   and in the settings on the right set **Source layer** to
   `reno_tahoe_dem.tif`.
4. Click **Run** in the Model builder toolbar. The log steps through **Fill
   Depressions Wang And Liu**, **D8 Pointer**, **D8 Flow Accum**, **Extract
   Streams**, and **Raster Streams To Vector**, converting each raster output
   to a Cloud-Optimized GeoTIFF, and ends with **Run finished — 1 output(s)
   added.** This takes a minute or two on a laptop.
5. Close Model builder. An `Extracted Stream Network` layer appears, 3,133
   line features. The map is still on the Oregon sample, so remove the
   `Sample DEM` layer (trash icon, then **Remove**) and click **Zoom to layer**
   on `Extracted Stream Network`: streams drain the Carson Range into the
   Truckee Meadows and Washoe Valley.

![The extracted stream network and the 15-minute drive-time area from the workshop venue, over the hillshaded Reno-Tahoe DEM](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s05-streams-drivetime.webp)

!!! tip "Why a model instead of five tool runs?"
    The graph is validated before it runs, intermediate rasters are discarded
    unless you press **Keep this result** on a node, and the same model re-runs
    on another DEM by changing one input. **Save** stores it in the project,
    **Export** writes a `.model.json` file, and after a successful run **Copy
    Python script** copies a `m.run_model_builder(...)` call for the `geolibre`
    package.

Save the project (**Project → Save**).

![The buffer and spatial-join exercise: 10 km circles around the Reno-Tahoe landmarks, the 29 matched earthquakes in red, over the hillshaded DEM](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s05-buffer-join.webp)

### Bonus: if you finish early

**5.8 Processing history (2 min).** Choose **Processing → History**. The
**Processing history** dialog lists every toolbox and network run in this
project, newest first (seven so far), each tagged with its engine (`client`)
and duration. Every entry has **Edit & re-run** and **Copy JSON**; the vector,
statistics, and network tools also have **Re-run**, and the vector and
statistics tools have **Copy Python**. Click **Edit & re-run** on the DGGS
Binning entry: the Vector tools dialog reopens with the same settings. Change
**Resolution** to `6` and click **Run**: **Binned points into 996 H3 cell(s)
at resolution 6**. Does the Monte Cristo Range still stand out?

**5.9 Line of sight (3 min).** Go back to Mount Rose with **View → Set
view...** (`-119.9179`, `39.3438`, zoom `10`), right-click the center of the
map, and choose **Quick analysis → Line of sight from here**, then click a
target, such as Carson City or a point across Lake Tahoe. The **Line of
sight** card reports **Target visible** or **Target not visible**, the
**Distance** (about 23.7 km to the Capitol), the **First obstruction** and
**Highest point** along the path, **Ground in view**, and the **Terrain
resolution**, with a profile chart underneath. The **Observer height (m)**
defaults to 1.7. If the first obstruction is only a few meters away, your
observer point landed just off the summit and the peak itself blocks the
view; **Clear** and right-click closer to the top. Untick **Earth curvature
and refraction** and watch whether the answer changes; at tens of kilometers it
can. Set **Target height (m)** to `30` to ask whether a mast, rather than its
base, is visible.

**5.10 Historical imagery (3 min).** Search for the venue and zoom in to about
zoom 15. Choose **Plugins → Historical imagery**. An `Esri Wayback` layer
named for the newest release date (for example `Esri Wayback 2026-10-29`)
appears, and the panel's **Release timeline** spans
every Esri World Imagery release since 2014-02-20, about 200 of them. Drag it
back through the years and watch the campus change; tick **Only versions with
local changes** to skip releases where nothing changed here. **Add persistent
layer** keeps a release as an ordinary layer.

## Check your work

[Open the finished project](https://web.geolibre.app/?url=https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/05-analysis-processing.geolibre.json){ .md-button .md-button--primary }

The finished project ([`05-analysis-processing.geolibre.json`](https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/05-analysis-processing.geolibre.json))
opens on the buffers, the joined earthquakes, and the drive-time area over the
DEM and the hosted hillshade. The H3 bins, the Gi\* hot spots, and the stream
network are in the Layers panel, hidden; toggle them on. It is about 3 MB
because the computed vector layers are embedded in it.

## Going further

- **Overlay tools.** In **Vector tools**, compare **Clip** with
  **Intersection**: both cut to the overlap, but only Intersection brings the
  overlay's attributes along. **Union** keeps no attributes on either engine.
- **Engines side by side.** Run the 10 km buffer again with **Engine:
  Python (Pyodide)** (it downloads the Python runtime once) and compare the
  circles with the Client result at a close zoom.
- **More statistics.** Run **Global Moran's I** on the H3 counts before
  mapping hot spots, or **Emerging Hot Spot (space-time cube)** on the raw
  earthquakes with a weekly time step to see where activity is new,
  intensifying, or fading.
- **Hydrology by hand.** Search the Processing menu for `Fill Depressions`,
  `D8 Flow Accum`, and `Extract Streams` and run the chain one tool at a time;
  then load the **Strahler stream order** or **Height above nearest drainage**
  sample in Model builder.
- **Loops and branches.** In Model builder, **Iterate features** with
  **Collect results** runs a tool once per feature (a clip per county), and
  **If/Else switch** sends features down different branches.
- **Routing.** **Processing → GeoLibre toolbox → Network** has **Isochrone /
  service area**, **OD cost matrix**, and **Sequential route (directions)**.
  For sensitive locations, point the tool at your own Valhalla server.
- **Share a tool run.** A **Copy link** in a Whitebox tool dialog builds a
  `?tool=` URL that reopens the tool with its form filled in, the most precise
  bug report there is.
- Read [Processing Tools](../../user-guide/processing.md),
  [Model Builder](../../user-guide/model-builder.md),
  [Vector Analysis](../../tutorials/vector-analysis.md), and
  [Terrain Analysis](../../tutorials/terrain-analysis.md).

---

**Break: 1:50 - 2:00.** Next: [6. Rendering Engines, 3D, and Time](06-3d-and-time.md)
