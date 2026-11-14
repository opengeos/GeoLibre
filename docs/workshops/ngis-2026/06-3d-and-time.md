# 6. Rendering Engines, 3D, and Time

!!! info "2:00 - 3:00 p.m."
    Lecture 15 min · Hands-on 35 min · Break 2:50 - 3:00

## Learning goals

By the end of this section you will be able to:

- Explain why one GeoLibre project can be drawn by four different rendering
  engines, and pick the right one for a task.
- Stream a 20-billion-point USGS 3DEP LiDAR survey of Reno in the browser and
  read it by elevation and by ASPRS classification.
- Turn on 3D terrain, drive it from a Cloud-Optimized GeoTIFF, and choose an
  honest vertical exaggeration.
- Open the same map on the Cesium 3D globe and come back without losing
  anything.
- Animate ten years of earthquakes with the Time Slider, and tell it apart
  from the globe's scene clock.
- Save views as bookmarks and measure true distance, heading, and terrain
  profile.

## Lecture (15 min)

### There is no separate 3D view

Desktop GIS usually keeps 3D in a second window: the QGIS 3D map view, an
ArcGIS Pro scene beside a map. GeoLibre has no such split. Tilt the map and
the 3D content already in the layer stack is there: terrain, extruded
buildings, point clouds, 3D Tiles. The camera has five numbers (center, zoom,
bearing, and **pitch**, up to 85°), and the status bar shows all of them.

GeoLibre goes one step further and separates the project from the thing that
paints it. The project store holds plain layer records, styles, and a camera,
not MapLibre sources or Cesium primitives. Each rendering engine subscribes to
the same store, so switching engines is not a conversion: layers, visibility,
opacity, most styling, and the camera simply carry over.

| Engine | Best suited to | Credentials |
| --- | --- | --- |
| **MapLibre GL JS** (default) | The widest tool and plugin support: vector styles, rasters, terrain, lightweight 3D | None |
| **CesiumJS** | A true 3D globe: curvature at every scale, terrain as a surface, 3D Tiles, CZML, streamed point clouds | None required; a Cesium ion token adds Cesium World Terrain and ion assets |
| **Mapbox GL JS** | Mapbox styles and services, Mapbox Standard | A Mapbox access token |
| **ArcGIS Maps SDK** | Native ArcGIS services, Esri basemaps, projections Web Mercator cannot draw | None; an ArcGIS API key adds Esri basemap styles |

Switch with **View → Rendering engine**. Rules of thumb:

- **Start on MapLibre.** Every exercise in this workshop runs there.
- **Use Cesium** when the third dimension or time is the point: terrain-heavy
  scenes, photogrammetry, orbits and trajectories, continental extents where
  Mercator distortion misleads.
- **Use ArcGIS** when your data lives in ArcGIS services or the projection is
  the message (Equal Earth, Spilhaus).
- **Use Mapbox** when a Mapbox style is the deliverable.

**Capability gating** keeps this honest. A command the active engine cannot
run is greyed out with a reason, a layer it cannot draw stays in the project
with a tag such as **2D only**, and a plugin that does not support the engine
is suspended rather than half-mounted. If a tool is enabled, it works there.

!!! tip "Coming from QGIS or ArcGIS Pro"
    Think of the engine as the canvas, not the project. Switching to Cesium is
    like opening the QGIS 3D view, except the globe is a full workspace with
    its own tools, and the switch is saved with the project.

### Point clouds: the COG idea, in 3D

A LiDAR survey of a metro area holds billions of points. The formats differ
mainly in whether they can be **streamed**:

| Format | What it is | How GeoLibre reads it |
| --- | --- | --- |
| **LAS** | ASPRS interchange format, uncompressed | Downloaded whole |
| **LAZ** | LASzip-compressed LAS, about a quarter of the size | Downloaded whole |
| **COPC** (`.copc.laz`) | One LAZ file with points in an octree and an index at the front | Streamed by view and level of detail |
| **EPT** (`ept.json`) | An octree of many small files described by a manifest | Streamed by view and level of detail |

The distinction is the same one that separates a plain GeoTIFF from a COG. A
COPC or EPT survey opens at full extent with a coarse sample and fetches finer
octree nodes only where you zoom, up to a **point budget**. The USGS publishes
its whole 3DEP LiDAR program as public EPT on Amazon S3. If you publish point
clouds yourself, publish COPC (PDAL's `writers.copc` converts LAS and LAZ).

Classified LiDAR assigns every point an ASPRS class code:

| Code | Class | Code | Class |
| --- | --- | --- | --- |
| 0 | Never classified | 6 | Building |
| 1 | Unclassified | 7 | Low point (noise) |
| 2 | Ground | 9 | Water |
| 3, 4, 5 | Low, medium, high vegetation | 17 | Bridge deck |
| | | 18 | High noise |

Ground points (class 2) build bare-earth DEMs like the Reno-Tahoe DEM from
Section 3. How far a survey goes beyond ground depends on its contract, as
Exercise 6.2 shows.

### Terrain, and the honesty rule

**Controls → Terrain** drapes the basemap and your layers over keyless global
elevation tiles. Double-click the terrain button to set the **vertical
exaggeration** or to swap the source for a single-band COG DEM (EPSG:3857 or
EPSG:4326) read in small HTTP range requests, so a 1 m LiDAR DEM can shape the
scene instead of a global 30 m model.

Exaggeration is a presentation decision with no correct value. At 1× most
landscapes look flatter than they feel; at 1.5-2× subtle relief becomes
legible; past 3× you are making a graphic, not a map. **State the
exaggeration whenever you publish a 3D image.** A reader cannot infer it.

### Two models of time

| | Time Slider | Cesium scene clock |
| --- | --- | --- |
| Animates | **Layers**: shows features whose date falls in the current step, or a cube's time slice | **Entities**: positions and appearance are functions of time (CZML) |
| Use it for | Tables of dated observations: earthquakes, permits, survey epochs, Zarr or NetCDF time axes | Moving things: satellites, flights, vehicle tracks |
| Engines | MapLibre and Mapbox (suspended when Cesium is the primary engine) | Cesium |

You do not import data into a special time-aware layer: you add layers
normally and **bind** them to the shared timeline. The time window is a filter
like any other, so it combines with quick filters and expression filters.

### Small tools that carry context

- **Bookmarks** (**Controls → Bookmark**) save the camera **and** the visible
  layers, in folders, inside the project, so they travel with a shared link.
- **Measure** (**Controls → Measure**) reports distance, area, or a circle,
  plus the true **great-circle heading** and, when elevation is available,
  slope-following **Terrain (3D)** distance with gain and loss. It measures on
  a sphere, which is fine for a quick look. For numbers in a report use the
  field calculator or the processing tools, which measure on the WGS 84
  ellipsoid: *Measure to look, the field calculator to record.*

## Hands-on (35 min)

Start a new project: **Project → New...**, name it
`NGIS 2026 - 6 3D and time`, pick the **Liberty 3D** basemap, and click
**Create**. Liberty 3D is the Liberty style with the camera tilted into a 3D
view; its buildings rise in 3D when you zoom in to a city.

### Exercise 6.1: Stream the USGS Reno-Carson survey (5 min)

1. Choose **Add data → LiDAR layer**. The **Add LiDAR layer** panel opens on
   the left of the map.
2. Under **Load COPC or EPT from URL**, paste the USGS 3DEP Reno-Carson 2017
   (QL1) survey and click **Load**:

    ```text
    https://s3-us-west-2.amazonaws.com/usgs-lidar-public/USGS_LPC_NV_Reno_Carson_QL1_2017_LAS_2018/ept.json
    ```

3. The map flies to the survey (zoom about 9). It runs from north of Reno
   past Carson City to the east shore of Lake Tahoe, plus a block east of
   Carson City. Points are colored by **Elevation** with **Viridis**; the
   ramp reads **1260** to **3669** (meters).
4. Scroll the panel to **Loaded Point Clouds**: the survey reports
   **20,286,530,383 points**. The browser is drawing a sample of a few million
   and refining it as you zoom.
5. Notice that **Z Offset** is ticked with an offset of **-1260** m, the
   survey's lowest elevation. That lowers the cloud so it sits on the flat
   map instead of floating a kilometer above it.

!!! question "Discussion"
    A 20-billion-point survey appeared in a few seconds, and the Layers panel
    has one new row tagged **LIDAR**. What did the browser actually download
    to draw this view, and what would a plain LAZ download of the same survey
    cost?

### Exercise 6.2: Read the classification (6 min)

1. In the panel, under **Styling**, set **Color By** to **Classification**. A
   class list appears with **Show All** and **Hide All** buttons.
2. Read the list. This survey lists **Never Classified, Unclassified, Ground,
   Low Point (Noise), Water, Bridge Deck, High Noise** and two extra codes.
   There is no Building or Vegetation class: the QL1 contract classified
   ground and water, and left everything above ground as **Unclassified**.
3. At this regional view much of the map is magenta. Click **Hide All**, then
   tick **High Noise** alone: those magenta points are class 18, high noise
   (birds, haze, multipath returns) that a coarse sample over-represents.
4. Untick **High Noise** and tick **Ground** alone. The brown ground points
   show holes wherever buildings and trees stood, because those returns are
   in class 1, not class 2.

    ![Only the ground class of the Reno-Carson survey, with gaps where buildings and trees stood](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s06-lidar-ground-only.webp)

5. Click **Show All** and set **Color By** back to **Elevation**.

!!! tip "Click the label, not the box"
    If a class checkbox does not respond, click the class name next to it.

### Exercise 6.3: Tilt the camera and add terrain from a COG (6 min)

1. Choose **View → Set view...** and enter **Longitude** `-119.80`,
   **Latitude** `39.25`, **Zoom** `10.2`, **Pitch** `55`, **Bearing** `-15`.
   Click **Go**. The status bar reads **Pitch: 55.0°** and
   **Bearing: -15.0°**, and the survey now recedes toward Reno.
2. Close the LiDAR panel (**×**). Choose **Controls → Terrain**. A mountain
   button joins the map controls on the right, already switched on, and the
   basemap drapes over global elevation tiles.
3. **Double-click** the mountain button. The **Terrain exaggeration** dialog
   opens.
4. Set **Vertical exaggeration** to `2`. In **Terrain source**, paste the
   workshop DEM, click **Use COG DEM**, then **Done**:

    ```text
    https://data.source.coop/opengeos/data/workshops/ngis-2026/reno_tahoe_dem.tif
    ```

5. The terrain is now built from the 30 m Reno-Tahoe COG, fetched tile by
   tile in range requests, at 2×. Drag with the right mouse button (or
   `Ctrl`+drag) to change pitch and bearing and look along the Carson Range.
   Click the compass to reset north.

!!! note "Terrain travels with the project"
    Saving the project records that terrain is on, the exaggeration, and the
    COG source URL, so the finished project reopens at 2× on the workshop
    DEM. A DEM opened from a local file has no URL to save, so it falls back
    to global terrain. If you publish a 3D screenshot, write the exaggeration
    in the caption.

### Exercise 6.4: The same map on the Cesium globe (5 min)

1. Choose **View → Rendering engine → Cesium**. The first switch loads the
   Cesium engine, which takes a few seconds.
2. The camera and the LiDAR layer carry over. The satellite imagery can
   take 20 to 30 seconds to appear on the first switch, so the cloud may
   float over a starry background at first. The survey is streamed
   natively by Cesium onto a satellite-imagery globe with real terrain, so
   the Carson Range and the Lake Tahoe basin rise without any exaggeration
   setting.

    ![The Reno-Carson point cloud streamed onto the Cesium globe](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s06-cesium-lidar.webp)

3. Look at the globe's own controls at the top right: **Reset view** (home),
   a **scene-mode picker** (**3D globe**, **2D map**, **Columbus view**), a
   **Basemap** picker, and fullscreen. Try Columbus view, then go back to
   **3D globe**. Each scene-mode switch zooms out to the whole Earth; click
   **Zoom to layer** on the LiDAR row to fly back to Reno rather than
   scrolling in from space.
4. A note at the bottom right suggests adding a Cesium Ion token. It is
   optional: the globe works without one.
5. Choose **View → Rendering engine → MapLibre**. Everything is where you
   left it, except that the LiDAR panel's **Color By** is back to
   **Elevation**.

!!! note "Expected Diagnostics warnings"
    The Diagnostics counter in the status bar climbs by about ten on the
    first Cesium switch. They are deprecation warnings from the Cesium
    library (*"... has been moved from cesium/engine to cesium/core"*) and
    are harmless.

### Exercise 6.5: Ten years of earthquakes in time (8 min)

1. **Add data → Vector layer**, paste the GeoParquet earthquake file, and
   click **Load**:

    ```text
    https://data.source.coop/opengeos/data/workshops/ngis-2026/nv_earthquakes.parquet
    ```

2. Close the panel and rename the layer `Nevada earthquakes` (double-click
   its name). Hide the LiDAR layer (eye icon), and use **View → Set view...**
   with **Longitude** `-117.6`, **Latitude** `38.9`, **Zoom** `6.2`, **Pitch**
   `0`, **Bearing** `0` to see all of Nevada.
3. On the `Nevada earthquakes` row, open **Layer actions (⋯) → Bind to time
   slider...**. **Time property** is already `time`; leave **Show features**
   at **In the current step** and click **Bind**.
4. A timeline docks below the map, spanning **2016** to **2025** with the
   **Y** (year) step selected. Click **2020**. Two clusters dominate: the
   Monte Cristo Range sequence in west-central Nevada and the tail of the 2019
   Ridgecrest sequence in California.

    ![The Time Slider bound to the earthquake layer, showing 2020](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s06-time-slider-2020.webp)

5. Click play (▶) and watch the decade year by year. Use these counts to
   check what you see:

    | Year | Events | Largest | Year | Events | Largest |
    | --- | --- | --- | --- | --- | --- |
    | 2016 | 349 | M5.6 | 2021 | 756 | M6.0 |
    | 2017 | 286 | M4.1 | 2022 | 381 | M4.8 |
    | 2018 | 158 | M4.5 | 2023 | 292 | M4.5 |
    | 2019 | 3,070 | M7.1 | 2024 | 444 | M5.7 |
    | 2020 | 1,871 | M6.5 | 2025 | 424 | M4.8 |

6. Pause, then switch the step to **M** (month). The marker reads
   **Jan 2020**. Click **Next** (⏭) four times to reach **May 2020** (811
   events: the Monte Cristo Range M6.5 of May 15 and its aftershocks). Then
   click **Previous** (⏮) ten times to reach **Jul 2019**, the busiest month
   of the decade (2,486 events: Ridgecrest, M7.1 on July 6).

!!! question "Discussion"
    2019 has ten times the events of 2018, yet most of them are not in
    Nevada. What would you change, with what you learned in Section 4, so the
    animation shows only Nevada? And which **Show features** option would
    turn this into a map of where earthquakes have accumulated?

### Exercise 6.6: Bookmark a view and measure it (5 min)

1. Choose **View → Set view...** with **Longitude** `-119.85`, **Latitude**
   `39.2`, **Zoom** `8.8`, **Pitch** `0`, **Bearing** `0`.
2. Choose **Controls → Bookmark**. Type `Reno to Mount Rose` in **Bookmark
   name...**, keep **Include complete layer state** ticked, and click **+**.
3. Zoom far out, then click the bookmark name. The map returns to zoom
   **8.80** with the same layers visible. Close the Bookmarks panel.
4. Choose **Controls → Measure**; **Distance** is already selected. Click
   the University of Nevada, Reno (the venue, just north of downtown), then
   double-click the summit of Mount Rose to finish. The peak is not labelled
   at this zoom: it sits about two-thirds of the way from Reno toward the
   north shore of Lake Tahoe, northeast of Incline Village.
5. Read the panel. You should see about **24 km**, a **Heading** of about
   **202° SSW**, and a **Terrain (3D)** block: a surface distance slightly
   longer than the straight one (about 24.7 km), **Gain / loss**, and
   **Min / max elevation** of roughly **1,380 m / 3,230 m**. Your exact
   numbers depend on where you clicked.
6. Click **Clear All** and close the panel.

!!! tip "Heading is not screen angle"
    The heading is the true great-circle initial bearing, not the angle the
    line makes on screen. Draw a line from Washington, D.C. to London at low
    zoom: it looks due east, but the heading reads about 50°.

Save the project (**Project → Save**).

### Bonus 6.7: Downtown Reno in 3D, and the winter sun (if you finish early)

1. **View → Set view...**: **Longitude** `-119.8138`, **Latitude**
   `39.5296`, **Zoom** `16`, **Pitch** `60`, **Bearing** `-30`. Hide the
   earthquake and LiDAR layers. The Liberty basemap's buildings stand as 3D
   blocks along Virginia Street and the Truckee River.
2. Choose **Controls → Sun**. The panel opens on **06/21/2024**, the summer
   solstice. Click the month in **Date** and type `12` to make it
   December 21, the winter solstice (change only the month: retyping the
   year resets the field). Click the hour in **Time** and type `0330P` for
   **03:30 PM**. The buildings take on warm, low-angle winter light. Drag the
   time-of-day slider under the clock, or press play, to watch the light
   move. The sun position is computed on your machine; nothing is sent
   anywhere.
3. Close the Sun panel with its **×** button.

### Bonus 6.8: Full detail on a small classified cloud (if you finish early)

Regional surveys give the big picture; a small COPC shows full detail and a
richer classification. Open this link in a new tab:

```text
https://web.geolibre.app/?data=https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz
```

1. The Autzen Stadium cloud (Eugene, Oregon) streams in at full extent:
   **10,653,336 points**.
2. Open **Add data → LiDAR layer** and set **Color By** to
   **Classification**. This time the list includes **Ground, High
   Vegetation, Building, Water, Transmission Tower, Bridge Deck** and several
   custom codes.
3. Use **View → Set view...**: **Longitude** `-123.0688`, **Latitude**
   `44.0590`, **Zoom** `16.3`, **Pitch** `60`, **Bearing** `30`. Buildings are
   orange, trees green, water blue, and the stadium seating gray: it was left
   as **Never Classified**, which is exactly the kind of error the **Point
   Cloud Annotation** plugin is built to fix.

    ![The Autzen COPC colored by ASPRS classification](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s06-autzen-classification.webp)

4. Tick **Enable point picking** and click a few points to read their
   attributes.

## Check your work

[Open the finished project](https://web.geolibre.app/?url=https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/06-3d-and-time.geolibre.json){ .md-button .md-button--primary }

The finished project ([`06-3d-and-time.geolibre.json`](https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/06-3d-and-time.geolibre.json))
restores the Reno-Carson survey, the earthquake layer bound to the Time Slider
at 2020, and two bookmarks. It opens on the tilted camera (pitch 55°,
bearing -15°) with terrain on at 2× from the workshop DEM.

## Going further

- **Plugins → Web services → USGS LiDAR** maps where 3DEP point clouds exist,
  streams them into the view, and clips one to an area you draw as COPC.
  **USGS 3DEP** is the raster counterpart: the 1 m, 1/3 arc-second, and 1
  arc-second DEMs derived from that LiDAR.
- **Add data → ICESat-2 / GEDI** reads NASA spaceborne LiDAR granules in the
  browser; **Layer actions → Along-track profile** charts ground and canopy
  along a beam.
- **Plugins → Point cloud annotation** labels points with box, lasso, and
  brush tools, and saves the labels with the project.
- **View → Split view** puts a MapLibre pane beside a Cesium pane that
  follows it at the same ground resolution.
- **Add data → CZML dynamic 3D scene** (Cesium only) loads time-dynamic
  scenes such as satellite orbits that animate on the globe clock.
- **Controls → Record map tour...** turns keyframes into a video. Hold each
  stop for three or four seconds; slower reads better.
- **Plugins → Timelapse** animates annual Sentinel-2, Landsat, and land-cover
  basemaps with no scene search at all.
- Read [Rendering Engines](../../user-guide/rendering-engines.md),
  [Cesium Renderer](../../cesium-renderer.md),
  [Map Controls](../../user-guide/map-controls.md),
  [Indoor Maps](../../user-guide/indoor-maps.md), and
  [Point Cloud Annotation](../../user-guide/point-cloud-annotation.md).

---

**Break: 2:50 - 3:00.** Next: [7. Communicating and Collaborating](07-communicating-collaborating.md)
