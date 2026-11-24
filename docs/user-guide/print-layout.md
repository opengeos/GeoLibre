# Print Layout

**Project → Print Layout...** composes a print-ready map with a title, legend,
scale bar, north arrow, and optional data blocks, then exports it to PNG, PDF,
or SVG. It can also generate an atlas: a map series with one page per feature
or a run of pages along a line.

![The Print Layout composer, with the page settings on the left and a live preview on the right](https://assets.geolibre.app/images/geolibre-print-layout.webp)

The controls are on the left and the live **Preview** on the right. The preview
is built from a capture of the live map; after you pan, zoom, or restyle the
map, press **Recapture map** to refresh it. Drag the splitter between the two
halves, or the dialog's corner grip, to make more room.

The layout is saved with the project, so reopening the composer brings back the
same page, elements, and atlas settings. A project has one layout.

## Title

**Title** (defaults to the project name) and **Subtitle** head the page.
**Title placement** puts them **Outside frame** (above the map) or
**Inside frame** (over it), and **Alignment** sets **Left**, **Center**, or
**Right**.

## Page

**Size** offers paper and screen presets:

| Group | Sizes |
| --- | --- |
| Paper | A4 (210 × 297 mm), A3 (297 × 420 mm), Letter (8.5 × 11 in), Legal (8.5 × 14 in), Tabloid (11 × 17 in) |
| Screen / digital | Full HD (1920 × 1080 px), HD (1280 × 720 px), 4K UHD (3840 × 2160 px), Square (1080 × 1080 px) |

**Custom…** takes a **Width** and **Height** in px or mm. **Orientation**
switches between **Portrait** and **Landscape** (not for custom sizes), and
**Margin** is **Normal**, **Narrow**, or **None (borderless)**. **Page
background** colours the page around the map: the title block, the footer row
and the margins. On a dark colour the title and the footer switch to light text,
so a dark map can sit on a dark page. **Export resolution** sets the DPI that
PNG and PDF exports render a paper page at: **72 DPI**, **150 DPI** (the
default), or **300 DPI**. Screen sizes always export at their exact pixel size.
On the largest papers 300 DPI is lowered slightly (A3 to about 294, Tabloid
to about 299), so the page stays within the largest canvas every browser
engine can draw.

## Map frame, scale, and extent

- **Map frame**: the **Map background** color shows where the map has no data;
  **Map frame color** and **Map frame width** draw the border around the map
  (width `0` hides it). **Map panels** sets the look of everything drawn over
  the map (a title placed inside the frame, the north arrow, the scale bar, the
  legend and the other blocks): **Light** panels with dark text, or **Dark**
  panels with light text for dark maps.
- **Scale (1:N)**: type a scale or pick one from **Presets…** (1:500 up to
  1:100,000). Applying it zooms the live map to that scale and recaptures. It
  is available on paper (mm) pages once the map has been captured. If the map's
  zoom limits cannot reach the scale, the composer uses the closest one it can
  and says so.
- **Print extent**: **Draw extent on map** lets you drag a box on the map to set
  the exact print area; hold `Shift` to match the page proportions. Then choose
  **Use active viewport** or **Clip to custom extent**, or **Clear extent**.
  While clipping to a custom extent, the scale input is disabled because the
  extent fixes the scale.

## Map elements

Tick the elements to place on the page under **Map elements**:

| Element | Notes |
| --- | --- |
| **Title**, **Subtitle** | See [Title](#title). |
| **Legend** | Built from the visible layers. See [Legend editor](#legend-editor). |
| **Scale bar**, **North arrow** | **Group north arrow & scale bar** places them together. |
| **Date** | The export date. |
| **Include GeoLibre attribution** | Adds "Created with GeoLibre". |
| **Footer text** | Free text along the bottom of the page. |
| **Page border** | With **Border color** and **Border width**. |
| **Info block (title block)** | An engineering-style block with **Author**, **Project No.**, **CRS**, **Revision**, and the scale. |
| **Colorbar** | A continuous color scale with **Colormap**, **Min value**, **Max value**, **Label**, **Orientation**, **Position**, and **Length**. |
| **Custom legend** | Hand-made legend entries. See [Custom legend](#custom-legend). |
| **Attribute table** | A table of a layer's records. See [Data blocks](#data-blocks). |
| **Chart** | A bar, pie, or line chart. See [Data blocks](#data-blocks). |
| **Overview map (inset)** | A second map frame locating the main map. See [Overview map](#overview-map). |
| **Coordinate grid** | Ticks and labels around the map frame. See [Coordinate grid](#coordinate-grid). |

Colorbar, custom legend and data blocks snap to the page corners through their
**Position** setting. The title, legend, scale bar, north arrow, footer, the map
frame and the overview map can also be placed by hand: see
[Arranging elements](#arranging-elements). The composer has no free text boxes
or image and logo elements. The gridlines plugin (**Controls → Gridlines**) is a
separate, on-map grid: it is captured with the map, and the map is fitted so its
edge labels are not cropped.

### Overview map

**Overview map (inset)** adds a small locator map, by default in the lower-left
corner of the main frame. It has its own **Basemap** (Positron, Liberty, Bright,
Dark, Fiord or OpenStreetMap) and a **Zoom out (levels)** setting: how many zoom
levels it sits out from the main map, so the main map's extent reads as a
rectangle in its surroundings. **Extent color** sets that rectangle's color.
When the main extent is too small to read as a box at the inset's zoom, a ring
marks the spot instead.

The overview map renders on its own hidden map, so it never moves your map or
changes its basemap. The extent rectangle is drawn from the captured map's
georeference, so the overview needs a flat 2D view (rotated is fine). A globe or
tilted capture cannot render the overview. Recapture in 2D or turn the overview
off before exporting. Export waits until the matching overview basemap has
loaded; a failed load shows a retry button.

### Coordinate grid

**Coordinate grid** draws ticks and labels around the outside of the map frame:

- **Coordinates**: **Latitude/longitude (DMS)** (`45°30′N`),
  **Latitude/longitude (decimal)** (`45.5°N`), **UTM** (`345000mE`, with the
  zone, such as `33N`, below the frame), or **MGRS** (two-digit kilometre
  values inside the 100 km square, with the grid zone and square, such as
  `33U VP`, below the frame). UTM and MGRS use the zone of the frame's centre.
- **Interval**: degrees for latitude/longitude, meters for UTM and MGRS. `0`
  picks a readable interval for the map's extent. Positive MGRS intervals round
  up to whole kilometers, matching the labels' precision.
- **Label size (pt)**: the label size in points on the printed page.
- **Draw grid lines across the map**: adds lines across the map as well as the
  border ticks.

Left and right labels read bottom to top, and a label that would overlap its
neighbour is skipped. The grid is drawn from the captured map's georeference,
so like the overview rectangle it needs a 2D, untilted view. It is drawn by the
layout itself, so it is as sharp in PNG, PDF and SVG exports as in the preview.
MGRS is limited to one 100 km square; a frame crossing square boundaries shows
a notice instead of an ambiguous grid. The automatic frame reserves a label
band. When a frame placed by hand leaves too little outside space, ticks and
labels move inside that edge.

### Arranging elements

Click **Arrange** above the preview to show a dashed handle around every
movable element: the map frame, the overview map, the title, the legend, the
scale bar, the north arrow and the footer. Drag an element to move it, or drag
its corner handle to resize it. The map frame and overview map resize freely;
the other elements scale in proportion. A focused handle also moves with the
arrow keys (`Shift` for bigger steps, `Alt` to resize). **Reset layout** puts
everything back in its automatic place, and **Done** hides the handles.

Positions are stored as fractions of the page, so the arrangement lands in the
same place at every export resolution and is saved with the project. Moving
the map frame changes its shape on the page, and the scale, the atlas fit and
the GeoPDF georeference follow it.

### Legend editor

When **Legend** is ticked, the legend editor lists one entry per visible layer
(and its classes). For each entry you can:

- edit the label to rename it on the page,
- hide or show it with the eye button,
- move a layer entry up or down.

**Legend title** sets the heading, **Group classes by layer** nests classes
under their layer, and the reset button returns to the automatic legend. The
editor changes the project's legend, the same one **Controls → Legend** shows,
so edits appear in both places. Entries come from layers; to add items that are
not layers, use a custom legend.

### Custom legend

**Custom legend** draws a legend you build by hand: a **Legend title**, then a
color and **Label** for each row, with **Add item** and remove buttons, and a
**Position**. **Import from dictionary** replaces the rows from JSON such as
`{"Forest": "#228b22", "Water": "#1e90ff"}`.

### Data blocks

**Attribute table** and **Chart** read a vector layer whose features are loaded
in the app (a GeoJSON or other local vector layer).

- **Attribute table**: choose the **Layer**, a **Heading**, the **Columns**,
  **Sort by** and **Order**, and **Max rows** (up to 50), or
  **Adjust number of rows to fit page**.
- **Chart**: choose the **Layer**, a **Chart type** (**Bar**, **Pie**, or
  **Line**), the **Category field**, and an **Aggregate** (**Count**, **Sum**,
  or **Mean**, with a **Value field** for the last two).

Both take a **Page extent filter**: **All features**, only features completely
within the page extent, or only features intersecting it. In an atlas they can
also show only the current atlas feature.

## Atlas (map series)

Tick **Generate a multi-page map series** to turn the layout into a template
that is repeated for a series of extents. The atlas needs a flat map; it is not
available on the Cesium globe or the ArcGIS 3D scene.

1. Pick a **Coverage layer**, a vector layer whose features drive the pages.
2. Choose the **Coverage**:
    - **One page per feature** frames each feature in turn.
    - **Pages along a line** walks each line feature in order, one page per
      **Segment length (km)** (20 km by default). A series is capped at 5,000
      pages; increase the segment length if you hit the cap.
3. Choose a **Page name field** (by default the feature number).
4. Set the **Page extent**: **Margin around feature** (a percentage) or, on
   paper pages, a **Fixed scale**.
5. Optionally:
    - **Mask area outside current feature** dims everything outside the current
      polygon (one page per feature, polygon layers only).
    - **Sort by** and **Order** set the page order (one page per feature).
    - **Filter** limits the pages to matching features, for example
      `POP2000 > 100000 and ST = "CA"`. Comparisons are `=`, `!=`, `>`, `>=`,
      `<`, `<=`, and `contains`, joined with `and`.

The preview shows **Page X of Y** with previous and next buttons, and moves the
live map to each page's feature.

### Atlas tokens

Use these tokens in the title, subtitle, footer, and the
**Page file name (ZIP export)**:

| Token | Value |
| --- | --- |
| `{atlas.name}` | The page name. |
| `{atlas.pagenumber}` | The page number. |
| `{atlas.total}` | The number of pages. |
| `{atlas.attr:FIELD}` | The current feature's `FIELD` value. Along a line, `km_start`, `km_end`, `segment`, and `segments` are also available. |

The default page file name is `{atlas.pagenumber}-{atlas.name}`.

## Exporting

| Button | Output |
| --- | --- |
| **Export PNG** | A raster image of the page. In an atlas it becomes **Export PNG ZIP**: one PNG per page in a ZIP file. |
| **Export PDF** | A georeferenced PDF (GeoPDF) page of the chosen size. In an atlas it becomes **Export PDF (N pages)**: one multi-page PDF, each page georeferenced to its own map. |
| **Export SVG** | An SVG of the page. Not available in an atlas. |
| **Copy to Clipboard** | The page as a PNG on the clipboard. |

The file is named after the title. Paper pages render at the **Export
resolution** (150 DPI by default); screen presets and pixel custom sizes render
at their exact pixel size. An atlas export
reports its progress page by page, and the dialog stays open until it finishes.

!!! note "What is vector and what is raster"
    **SVG** is the format to choose when the layout is going on to a vector
    editor such as Inkscape or Illustrator: the title, legend, scale bar, north
    arrow, tables, charts, and borders are written as editable text and paths.
    The map itself, and any image-based marker icons, stay embedded as images.
    The **PDF** is an image of the whole page, at the export resolution, placed
    on a PDF page, not vector content.

## GeoPDF

A PDF export carries the map frame's coordinates in the ISO 32000 geospatial
format, so GIS and mobile mapping apps (QGIS and other GDAL-based tools, or
Avenza Maps) open it in the right place, and a GPS-enabled app can show your
position on the printed map in the field. The georeference covers the map frame
only, not the title, legend, or margins, and it is written in the map's CRS:
Web Mercator on the default map, or the map's own CRS when it uses one with an
EPSG code.

The georeference is exact only while the screen is a flat view of that CRS, so
some views export as a plain PDF instead. Hover **Export PDF** to see which you
will get. To get a GeoPDF:

- Remove any tilt (pitch); a rotated (bearing) map is fine.
- On a globe, zoom in until the globe flattens to Mercator (around zoom 12), or
  switch the map projection to Mercator.
- Use a custom CRS that has an EPSG code.
- Use an Earth map. Moon and Mars projects export plain PDFs.

!!! tip "Getting a sharper map"
    The map is captured from the on-screen map, so its detail is limited by the
    size of the map on your screen, whatever the page size. Maximize the window
    (or use a high-DPI display) before **Recapture map** for a large print. Text
    and other layout elements are drawn at full output resolution.

A **View → Color vision preview** does not affect exports: the layout is always
exported in the map's real colors.
