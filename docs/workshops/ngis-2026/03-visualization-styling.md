# 3. Visualization and Styling

!!! info "10:00 - 11:00 a.m."
    Lecture 15 min · Hands-on 35 min · Break 10:50 - 11:00

## Learning goals

By the end of this section you will be able to:

- Choose a renderer (single, graduated, categorized, rule-based) and a
  classification scheme that fit the data, and explain the choice.
- Show dense point data as graduated symbols, proportional symbols, a heatmap,
  or clusters, and know what each one says about the data.
- Label polygons and design the popup and hover tooltip a reader will see.
- Style a single-band raster: color ramp, stretch range, histogram, and
  opacity over a hillshade.
- Edit the generated legend and compose a print layout with a title, legend,
  scale bar, and north arrow.

## Lecture (15 min)

### Styling starts before you open the Style panel

A freshly loaded vector layer is already readable: GeoLibre gives each new
layer its own color from a palette, a matching outline, and a point radius or
line width that suits its geometry. For small layers the Style panel also
offers a **Style suggestions** strip built from the data (for example
**Categorize by magType** or **Heatmap**); it disappears once you edit the
layer's style. That default is a starting point, not cartography. The moment
after you load six files, you can tell them apart; that is when you decide
what actually needs styling.

All styling lives in the **Style panel** on the right (the palette icon on a
layer row). Changes to symbol properties apply live. Classification changes
wait for **Apply style type**, so you can try a different scheme or class
count and watch the stop list update before anything reaches the map.

!!! tip "Coming from QGIS or ArcGIS Pro"
    The renderer names map almost one-to-one: single symbol, categorized,
    graduated, rule-based. The difference is underneath: GeoLibre compiles
    every renderer to MapLibre style expressions, and the **Advanced
    expression** renderer exposes that same machinery directly. Because the
    other rendering engines read the same compiled styles, a categorized layer
    looks the same on the 2D map and the 3D globe (Section 6).

### The style types

| Style type | What it does | Use it for |
| --- | --- | --- |
| **Single symbology** | One style for every feature | Reference layers, outlines |
| **Graduated** | A numeric field split into classes and colored from a ramp | Magnitudes, rates, densities |
| **Categorized** | One color per distinct value (1 to 12 classes, or **All**) | Types, classes, codes |
| **Rule-based** | A list of filters, each with its own symbol and zoom range | When one field does not decide the symbol |
| **Advanced expression** | A MapLibre expression you write | Full control |

### Classification schemes decide the story

A graduated map is only as honest as its class breaks. The **Scheme** menu
offers six ways to place them:

| Scheme | Breaks | Suits |
| --- | --- | --- |
| **Equal interval** | Equal-width value ranges | Evenly spread data, round-number steps |
| **Quantile** | Equal feature counts per class | Ranking; every color gets used |
| **Natural breaks** | Gaps in the distribution (Jenks-style) | Clustered data with real breaks |
| **Standard deviation** | Classes one standard deviation wide around the mean | Departure from average, with a diverging ramp |
| **Geometric interval** | Breaks that grow by a constant ratio | Skewed data spanning orders of magnitude |
| **Manual** | Whatever you type | Policy thresholds, matching another map |

Editing a break by hand switches the scheme to **Manual** automatically, so
the method shown never claims to have produced breaks you typed. The legend
then prints the method under the field ("Quantile, 5 classes"). A choropleth
without its classification method is not fully specified; that caption lets a
reader judge it.

Earthquake magnitudes are a good test case. The Gutenberg-Richter law says
each step down in magnitude has about ten times as many events, so the
workshop catalog is dominated by small earthquakes just above its M2.5
cutoff. You will see the same 8,031 events tell four different stories
depending on the scheme.

### Points at density

One circle per point stops working somewhere around a few thousand features.
Point layers have a **Point renderer** control:

| Renderer | Shows | Watch out for |
| --- | --- | --- |
| **Single symbol** | Every point, styled by the renderer above | Overplotting hides dense areas |
| **Heatmap** | A density surface; **Weight field** can weight it by a value | Unweighted, it maps *records*, not *amounts* |
| **Clustered** | Count bubbles that split as you zoom | Counts are built before some filters apply |

**Proportional size** (**Size by value**) scales circles by a numeric field.
The scaling is linear in radius, but readers judge area, so a feature worth
twice as much looks about four times as big. Keep the size range modest.

### Labels, popups, and tooltips

Labels are the text a map shows unasked; popups and tooltips are what it shows
when asked.

- **Labels** take a field or a MapLibre expression, with a halo, size, letter
  case, wrap width, zoom range, and **Data-defined overrides** for size,
  color, opacity, visibility, and placement priority. If you change one thing
  about a label layer, add a halo.
- **The popup designer** (the **Popup** section of the Style panel) picks the
  title field, which fields appear and in what order, a readable label for
  each, and how each value is formatted (number, date, link, image). By
  default a popup shows every column, including internal ids; the designer is
  how you give a shared map popups meant for readers.
- **Hover tooltips** show the title plus one or two fields you tick, as the
  pointer moves. They suit dense choropleths where clicking every polygon is
  tedious.
- **Identify visible layers** (the pointer icon in the Layers panel header)
  is the analyst's view: one click returns features and raster pixel values
  from every visible layer, grouped by layer.

### Styling rasters

A single-band raster such as a DEM is colored by mapping values through a
**Color ramp**. Three settings decide what the result says:

- **Min** and **Max**, the range the ramp stretches across. Left blank, they
  read **auto**: the 2nd to 98th percentile of the band.
- **No data**, **Auto (from file)** by default. A wrong nodata value (a DEM
  stretched from -9999 to 4000) is the most common reason a raster renders as
  one flat color.
- **Stretch** (**Linear**, **Logarithmic**, **Square root**) for skewed data.

The **Histogram** under the ramp shows the distribution with the stretch
window shaded between two handles. It explains *why* a raster looks the way it
does: a long tail washes out the image, a spike is a flat surface or an
undeclared nodata value. **Viewport stretch** fits the range to the pixels on
screen, which is good for exploring but makes two views incomparable.

To combine color and relief, put a colored DEM at partial opacity over a
hillshade. Vector layers also offer a **Blend** control (**Multiply** keeps
full-strength color over relief), but layers drawn by the COG raster engine do
not, so for rasters you use opacity.

### Legends and layouts

**Controls → Legend** is generated from the visible layers' styles: class rows
for graduated and categorized layers, a gradient bar for raster ramps. It
cannot drift out of sync with the map. Edit mode renames, hides, and reorders
entries without touching the layers. The same legend feeds **Project → Print
layout…**, which composes a page with title, subtitle, legend, scale bar,
north arrow, date, and footer, and exports PNG, PDF, or SVG.

## Hands-on (35 min)

### Exercise 3.1: Set up the project (3 min)

1. Choose **Project → New…**, name the project
   `NGIS 2026 - 3 Visualization and styling`, pick the **Positron** basemap
   (a light gray background that lets colors stand out), and click
   **Create**.
2. Choose **Add data → Vector layer**. Paste each URL and click **Load**:

    ```text
    https://data.source.coop/opengeos/data/workshops/ngis-2026/nv_counties.geojson
    https://data.source.coop/opengeos/data/workshops/ngis-2026/nv_earthquakes.parquet
    ```

    Each layer arrives in its own palette color (for example blue counties
    and red earthquakes).

3. Close the panel. Choose **Add data → Raster layer**, paste each URL, and
   click **Load** (hillshade first, so it ends up below the DEM):

    ```text
    https://data.source.coop/opengeos/data/workshops/ngis-2026/reno_tahoe_hillshade.tif
    https://data.source.coop/opengeos/data/workshops/ngis-2026/reno_tahoe_dem.tif
    ```

4. Close the panel. New layers go on top, so the two rasters now cover the
   vectors. Click **Move down** (the down arrow on the layer row) on
   `reno_tahoe_hillshade.tif` twice, then on `reno_tahoe_dem.tif` twice. The
   order from the top is now `nv_earthquakes`, `nv_counties`,
   `reno_tahoe_dem.tif`, `reno_tahoe_hillshade.tif`.
5. Hide both rasters (eye icon) for now, and click **Zoom to layer** on
   `nv_counties`.

### Exercise 3.2: Graduated symbols and classification schemes (6 min)

1. Click the palette icon on `nv_earthquakes` to open its Style panel. Above
   **Style type**, the **Style suggestions** strip offers **Categorize by
   magType**, **Graduate by depth**, and **Heatmap**. Leave them for now; the
   strip goes away once you apply your own style.
2. Set **Style type** to **Graduated**, **Attribute** to `mag`, **Classes** to
   5, and **Scheme** to **Quantile**.
3. Click the **Colormap** button and choose **Plasma**. The stops read
   **2.5, 2.6, 2.72, 2.9, 3.28**: four of the five classes cover less than one
   magnitude unit.
4. Before applying, switch **Scheme** through the other options and read the
   stops each time:

    | Scheme | Class starts |
    | --- | --- |
    | Quantile | 2.5, 2.6, 2.72, 2.9, 3.28 |
    | Equal interval | 2.5, 3.42, 4.34, 5.26, 6.18 |
    | Natural breaks | 2.5, 3.11, 3.71, 4.32, 5.22 |
    | Geometric interval | 2.5, 3.08, 3.80, 4.68, 5.76 |
    | Standard deviation | 2.5, 2.72, 3.17, 3.63 (only four classes) |

5. Set **Scheme** back to **Quantile** and click **Apply style type**.
6. Scroll down to the symbol settings. Set **Outline color** to `#ffffff`,
   **Stroke width** to `0.5`, and **Circle radius** to `4`. A thin white
   outline separates overlapping points.

!!! question "Discussion"
    Standard deviation returned four classes, not five. Breaks that would fall
    outside the data's range are dropped, and magnitudes cannot go below the
    catalog's 2.5 cutoff. With Equal interval, almost every point lands in the
    first class. Which scheme would you publish for a general audience, and
    which for seismologists who care about the rare large events?

### Exercise 3.3: Proportional symbols, heatmap, and clusters (6 min)

1. Still on `nv_earthquakes`, find **Proportional size** and tick **Size by
   value**. Set **Size field** to `mag`. GeoLibre fills **Min value** `2.5`
   and **Max value** `7.1` from the data. Set **Max size (px)** to `16`.
2. Large events now stand out by both color and size: the M7.1 Ridgecrest
   (2019) and M6.5 Monte Cristo Range (2020) sequences in particular.
3. Set **Point renderer** to **Heatmap**. With **Weight field** at **None
   (equal weight)**, the surface shows where earthquakes are *recorded*. Set
   **Heatmap radius** to `15` to tighten it.
4. Set **Weight field** to `mag`. Each event now counts 2.5 to 7.1 times, and
   at this radius nearly every cluster saturates to the top color (dark
   red). Set the
   weight back to **None (equal weight)**.
5. Set **Point renderer** to **Clustered**. Count bubbles appear, labeled
   with the number of events they hold. At the statewide view from **Zoom to
   layer** (about zoom 5.8), two bubbles dominate: about **2.9k** on the
   Monte Cristo Range sequence in Esmeralda County and about **3.8k** near
   Ridgecrest in California (exact counts depend on your zoom). Zoom in and
   watch them split. Unclustered
   points keep the graduated colors.
6. Set **Point renderer** back to **Single symbol**.

!!! question "Discussion"
    An unweighted heatmap of crime reports is a map of reporting, not of
    crime. What does an unweighted earthquake heatmap show, and why might a
    dense seismometer network in one area exaggerate it?

![Earthquakes as graduated, proportional symbols with labeled county outlines and the generated legend](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s03-vector-symbology.webp)

### Exercise 3.4: County outlines and labels (5 min)

1. Open the Style panel for `nv_counties`.
2. Next to **Fill color**, tick **Transparent**. Set **Outline color** to
   `#333333` and **Stroke width** to `1.5`.
3. Scroll to **Labels** and tick **Show labels**. Set **Label field** to
   `NAME`, **Letter case** to **UPPERCASE**, and **Text size** to `12`. The
   default white halo (**Halo width** 1.5) keeps the names readable over the
   earthquake points.
4. Washoe is a multipart polygon. With **Duplicate labels** at its default,
   **Label every feature**, each part can get its own label once there is
   room for it (zoom in to see a second WASHOE); **One label per location**
   keeps just one.
5. Optional: look at **Data-defined overrides**. **Size**, **Color**,
   **Opacity**, **Visibility**, and **Priority** each take a per-feature
   MapLibre expression (lower priority values are placed first when labels
   collide), as does the **Expression (optional)** box for the label text.
   They use the same Expression Builder as filters and field calculation in
   Section 4.

!!! tip "Label fewer things"
    The better order is to decide what the map is for, label only that, and
    put the rest in the popup. Use **Min zoom** on labels so a layer that is
    right at zoom 10 is not noise at zoom 5.

### Exercise 3.5: Design a popup and a hover tooltip (6 min)

1. Still in the `nv_counties` Style panel, scroll to **Popup**.
2. Set **Title field** to `NAMELSAD` (for example "Elko County") and untick
   **Show the feature id row**.
3. In **Add a field…**, pick `ALAND`. Set its **Label** to `Land area`,
   **Value type** to **Number**, **Decimals** to `0`, tick **Group
   thousands**, and set **Suffix** to ` m²`. Tick **In hover tooltip**.
4. Add `GEOID` and set its **Label** to `County FIPS code`.
5. Tick **Show tooltip on hover** at the top of the Popup section. A **Hover
   tooltips** switch appears at the top of the Layers panel and pushes the
   layer rows down a little. Move the pointer over Elko County: the tooltip reads **Elko County, Land area
   44,478,647,069 m²**.
6. Click the **Identify features** button (the pointer icon) on the
   `nv_counties` row and click Nye County. The popup reads **Nye County**,
   **Land area 47,090,939,214 m²**, **County FIPS code 32023**, with **Edit
   geometry** and **Edit attributes** buttons (Section 4 uses them). Click
   the Identify button again to turn it off.
7. Now design the earthquake popup. Open the `nv_earthquakes` Style panel,
   set **Title field** to `place`, untick **Show the feature id row**, and
   add three fields:
    - `mag`, **Label** `Magnitude`.
    - `depth`, **Label** `Depth`, **Value type** **Number**, **Decimals**
      `1`, **Suffix** ` km`.
    - `time`, **Label** `Date`, **Value type** **Date**.
8. Identify an earthquake. The `time` column stores milliseconds since 1970,
   but the popup now shows a calendar date, for example **62 km NNW of Wells,
   Nevada**, Magnitude 2.5, Depth 3.8 km, Date 4/12/2018.

![The popup designer: a county popup with a formatted land area and a renamed FIPS field](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s03-popup-designer.webp)

!!! note "Popup design travels with the project"
    The design saves into the `.geolibre.json` file, so shared links, embeds,
    and story maps (Section 7) show readers your popup, not the raw table.
    Fields hidden in the attribute table stay out of the popup too.

### Exercise 3.6: Style the elevation model (7 min)

1. Show `reno_tahoe_dem.tif` and `reno_tahoe_hillshade.tif` again and click
   **Zoom to layer** on the DEM.
2. Open the DEM's Style panel. Under **Raster symbology**, **Render mode** is
   **Single band (pseudocolor)** with a **gray** ramp.
3. Open **Color ramp** and choose **terrain**. Look at the map: the low
   valleys around Reno and Carson City turn blue, as if they were water.
4. Look at the **Histogram**. The automatic range runs from **1,356.48** to
   **2,692.9** (the 2nd to 98th percentile), so the lowest valley floors sit
   at the bottom of the ramp, where the terrain ramp is blue. The tall spike
   is Lake Tahoe: thousands of pixels at the same lake-surface elevation,
   about 1,897 m.
5. Type `800` in **Min** and `3300` in **Max**. The valleys turn green, and
   blue now appears only where nothing is that low. The legend's gradient bar
   updates to 800 to 3,300.
6. Drag the DEM's opacity slider in the Layers panel to about `0.65`. The
   hillshade below shows through and the Carson Range gains relief.
7. Click **Identify visible layers** (the pointer icon in the Layers panel
   header), then click the Carson Range northeast of Lake Tahoe. One popup,
   **Identified results (3)**, lists the county with your popup design, the
   DEM elevation, and the hillshade value, each in its own group. Click the
   header button again to turn it off.

![The DEM with a terrain ramp at 0.65 opacity over the hillshade, and Identify visible layers returning three results](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s03-raster-identify.webp)

!!! question "Discussion"
    Why is a fixed Min and Max better than **Viewport stretch** for a map you
    will print beside a legend, and when is a viewport stretch the better
    choice?

### Exercise 3.7: Edit the legend (4 min)

1. Choose **Controls → Legend**. It lists the earthquake classes with the
   caption **Quantile, 5 classes**, the counties, and gradient bars for both
   rasters.
2. Hover over the legend header and click **Edit legend** (the pencil
   icon). Each entry name becomes a text box: click `nv_earthquakes` and type
   `Earthquake magnitude`, then rename `nv_counties` to `Nevada counties` and
   `reno_tahoe_dem.tif` to `Elevation (m)`. (The pencil on an entry row is
   **Customize items**, for editing the class rows; you do not need it here.)
3. Click **Hide from legend** on `reno_tahoe_hillshade.tif`. It stays on the
   map; a hillshade needs no key.
4. Set **Position** to **Bottom left** and click **Done editing** (the check
   icon).

!!! tip "Legend order is rhetoric"
    Stack order is a drawing decision; legend order is an argument. Put the
    layer the map is *about* first. The renamed entries also appear in the
    print layout, so you edit them once.

### Exercise 3.8: Print layout (5 min)

1. Hide `reno_tahoe_dem.tif` and `reno_tahoe_hillshade.tif`. This page is an
   earthquake map; see the warning below.
2. Choose **Project → Print layout…**. The defaults are **A4**,
   **Landscape**, with **Title**, **Subtitle**, **Legend**, **Scale bar**,
   **North arrow**, and **Date** ticked.
3. Set **Title** to `Earthquakes of the Reno-Tahoe Region` and **Subtitle**
   to `M2.5+ earthquakes, 2016-2025 (USGS ComCat)`.
4. Tick **Footer text** and enter
   `Made with GeoLibre at the NGIS 2026 workshop. Data: USGS, US Census Bureau.`
5. Click **Recapture map**. The preview shows the legend with your renamed
   entries, the scale bar with the current scale, and the north arrow.
6. Click **Export PNG**. The A4 page renders at 150 DPI, 1754 × 1240 pixels.
   Chrome and Edge may ask where to save it; otherwise it goes to your
   downloads folder.
7. Close the dialog, show both rasters again, and save the project
   (**Project → Save**).

![An A4 landscape print layout exported to PNG](https://data.source.coop/opengeos/data/workshops/ngis-2026/images/s03-print-layout.webp)

!!! warning "If the preview says Could not capture the map image"
    The layout waits for the map to finish rendering before it copies it. In
    the current release a recolored COG raster can keep the map from
    settling, and after 30 seconds the preview gives up with **Could not
    capture the map image**. Close the dialog, hide the raster layers, and
    open the layout again.

### Bonus: Save a style and try a categorized renderer (if you finish early)

1. In the `nv_earthquakes` Style panel, click **Saved styles…** at the top of
   the panel. The **Style manager** opens with built-in presets.
2. Click **Save current style…**, name it `Quakes by magnitude`, add the tags
   `earthquakes, point`, keep **Full style** and **My library (all
   projects)**, and click **Save style**. It appears under **My library**.
3. Close the Style manager. Set **Style type** to **Categorized**,
   **Attribute** to `magType`, **Classes** to **All (9)**, and **Colormap** to
   **Turbo**, then click **Apply style type**.
4. Nearly every point turns the first two colors: `ml` (local magnitude,
   6,497 events) and `md` (duration magnitude, 894) dominate, followed by
   `mw` (369) and `mlr` (246). A category field with a long tail of rare
   values is common; **Most frequent** decides which values get named classes
   when you ask for fewer.
5. Open **Saved styles…** again and click **Apply** on `Quakes by magnitude`.
   The status line reads **Applied "Quakes by magnitude" to nv_earthquakes**,
   and the graduated style returns.

## Check your work

[Open the finished project](https://web.geolibre.app/?url=https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/03-visualization-styling.geolibre.json){ .md-button .md-button--primary }

The finished project ([`03-visualization-styling.geolibre.json`](https://data.source.coop/opengeos/data/workshops/ngis-2026/projects/03-visualization-styling.geolibre.json))
opens on the Reno-Tahoe DEM over the hillshade, with the graduated
earthquakes, labeled counties, both popup designs, the hover tooltip, and the
edited legend.

## Going further

- **Rule-based styling**: set **Style type** to **Rule-based** on the
  earthquakes and build rules such as "mag ≥ 5" in red with a large radius,
  each with its own symbol and zoom range. Save your graduated style first
  (see the Bonus) so you can restore it.
- **Discrete raster classes**: tick **Classify into discrete classes** on the
  DEM to turn the ramp into hypsometric classes, each with its own color and
  opacity. **Opacity classes** keeps the ramp smooth but fades a value range.
- **Symbology pack**: on a polygon layer, **Geometry generator → Derived
  geometry** draws centroids, bounding boxes, convex hulls, or buffers at
  draw time, and **Line decoration** adds arrows or ticks along lines.
- **Diagrams**: **Chart type** draws a pie, donut, or bar chart on each
  feature from several numeric fields, for composition rather than
  classification.
- **Reuse styles across projects**: **Layer actions → Styles** exports a
  layer's style as GeoLibre style JSON, Mapbox/MapLibre style JSON, OGC SLD,
  or QGIS QML, and **Project → Export → Export layer styles…** writes every
  layer's style to one file keyed by layer name.
- **Gridlines and minimap**: **Controls → Gridlines** draws a geographic,
  UTM, or MGRS/USNG grid, and **Controls → Minimap** adds an overview map;
  both are captured by the print layout.
- **Check accessibility**: **View → Color vision preview** shows how your map
  reads to people with common color-vision deficiencies. Rainbow ramps such
  as Turbo and Jet are the usual casualties.
- Read [Styling Layers](../../user-guide/styling.md),
  [Print Layout](../../user-guide/print-layout.md), and
  [Map Controls](../../user-guide/map-controls.md).

---

**Break: 10:50 - 11:00.** Next: [4. Attributes, Editing, and Spatial SQL](04-attributes-editing-sql.md)
