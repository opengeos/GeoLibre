# Styling Layers

The **Style panel** on the right edits the appearance of the layer selected in the [Layers panel](layers.md). Vector and raster layers each get their own set of controls.

![The Style panel with a categorized style: an attribute, a colormap, and one colour per category](https://assets.geolibre.app/images/geolibre-style-panel.webp)

## Vector styling

For vector layers the Style panel covers fill, stroke, points, labels, and 3D extrusion:

- **Fill**: fill color and fill opacity for polygons.
- **Stroke**: line color and width for lines and polygon outlines.
- **Points**: circle radius for point layers.
- **Labels**: text color, size, halo color, and halo width.
- **3D extrusion**: turn polygons into extruded blocks, with a height field, height scale, base height, and color. Advanced expressions are available for both height and color.

You can also set a per-style minimum and maximum zoom so a style only applies within a zoom range.

### Point renderer (heatmap and clustering)

For point-only GeoJSON layers — whether dropped on the map, produced by a tool, or loaded through **Add Vector Layer** in the geojson render mode — the Style panel adds a **Point renderer** control:

| Renderer | Description |
| --- | --- |
| **Single symbol** | One circle per point (the default). |
| **Heatmap** | A density surface colored from cold to hot. Adjust **Heatmap radius** (the kernel size in pixels) and **Heatmap intensity**. |
| **Clustered** | Group nearby points into bubbles labeled with the count; zooming in splits them apart. Adjust the **Cluster radius** (in pixels) and the **Cluster max zoom** above which points stop clustering. Individual (unclustered) points keep the layer's circle style. |

The renderer choice is saved with the project.

### Style type (data-driven styling)

The **Style type** control chooses how feature values map to color:

| Style type | Description |
| --- | --- |
| **Single symbology** | One uniform style for every feature. |
| **Graduated** | Classify a numeric attribute into classes and colour them from a ramp. |
| **Categorized** | Give each of an attribute's distinct values its own colour. |
| **Rule-based** | Build a list of rules, each with its own filter, symbol properties, and optional scale-dependent visibility. |
| **Advanced expression** | Drive styling with a custom MapLibre expression for full control. |

Graduated and categorized styles share four more controls, and then list the generated stops so you can fine-tune an individual colour before applying:

- **Attribute** — the field the style reads.
- **Classes** — 2 to 12 classes for a graduated style; 1 to 12 for a categorized one, plus an **All (n)** option that gives every distinct value its own colour.
- **Scheme** — how the stops are chosen. Graduated offers **Equal interval**, **Quantile**, and **Natural breaks**; categorized offers **Most frequent**, **Alphabetical**, and **First values**.
- **Colormap** — the named colour ramp the classes are drawn from.

Nothing reaches the map until you click **Apply style type**, so you can adjust the classification and watch the stop list update first.

### Diagram symbology

Below the renderer controls, a **Diagram** control draws a small chart on each feature instead of (or as well as) a plain symbol: **Pie chart**, **Donut chart**, **Bar chart**, or **Stacked bar chart**, built from the numeric fields you pick. Set it to **None** to turn diagrams off. It is the usual way to show a composition — vote share, land-cover mix, age structure — per polygon or per point.

### Style interchange and URL styles

The selected vector layer's **Layer actions → Styles** submenu imports and exports GeoLibre URL style JSON, Mapbox/MapLibre style JSON, OGC SLD, and QGIS QML. A GeoLibre URL style is a compact MapLibre style whose feature data is supplied separately through the `data` URL parameter. Export one when you want to publish the current symbology beside hosted GeoJSON or a ZIP of GeoJSON files; import it when you want to apply that symbology to a layer already open in GeoLibre.

See [Managing Layers](layers.md#importing-and-exporting-styles) for the menu workflow and [Embedding & Sharing](embedding.md#open-remote-data) for the JSON conventions.

!!! tip "Choropleth maps"
    To make a choropleth, select **Graduated**, pick a numeric attribute, choose a colormap, and click **Apply style type**. See the [Your First Map tutorial](../tutorials/first-map.md).

### Popups and hover tooltips

Further down the Style panel, the **Popup** section designs what a viewer sees when they interact with a feature, rather than the raw column dump the Identify popup shows by default. It matters most for a map you share: a `layout=viewer` embed, a shared project, or a story-map chapter, where the recipient clicks a feature and would otherwise get join artifacts, editor-tracking columns, and internal ids alongside the fields you meant them to read.

- **Show popup on click (Identify)** and **Show tooltip on hover** are independent switches. The click popup is on by default; the hover tooltip is off.
- **Title field** leads the popup with the feature's own name rather than the layer's. **Title expression** does the same from an expression, and wins over the field.
- **Body expression** replaces the whole popup body — the field rows and the feature id row with them — with a sentence built from the feature's properties, for authors who want prose rather than a table. Both boxes open the same expression builder that backs [data-driven styling](#style-type-data-driven-styling), labels, and filters.
- **Fields** chooses which attributes appear and in what order. Add a field from the picker, drag its handle (or use the arrow buttons) to reorder, and give it a **Label** to show instead of the raw column name. Leave the list empty — or remove every field you added — to keep the default: every visible field, in the data's own order.
- **Value type** formats the value: **Number** (decimals, thousands separator), **Date** (date, date and time, time, ISO 8601, or year), **Link**, **Image**, or plain **Text**. For **Text**, **Number** and **Date** fields, **Prefix** and **Suffix** wrap the result, which is where a currency symbol or a unit goes.
- **In hover tooltip** puts a field in the tooltip's short subset. Keep it to one or two fields: the tip follows the pointer, so it is a glance, not a table. Image fields are skipped there and stay in the click popup, where there is room to show the picture.

Layers loaded through **Add Vector Layer** are designed here too. That panel has its own **Popup** checkbox per layer, which opens a separate, unstyled attribute table on click; it is off by default so the two do not both answer the same click, and the design above is what a viewer gets. Tick it only if you want the control's raw table back.

Fields you hid or excluded from the [attribute table](attribute-table.md) stay out of the popup: the popup design selects from the visible fields and cannot re-expose a hidden one. A layer with nothing configured behaves exactly as before, and the whole design saves with the project, so it travels to the Python package and the MCP authoring tools as well.

## Raster styling

For raster layers the Style panel exposes image adjustments:

- **Brightness** (minimum and maximum)
- **Saturation**
- **Contrast**
- **Hue rotation** (in degrees)

These let you tune the look of GeoTIFF, COG, and tile-based raster layers without changing the underlying data.

### Spectral profile

For a **multiband** raster — a stacked Landsat or Sentinel scene, a NetCDF/HDF cube, or any COG with more than one band — the Style panel adds a **Spectral profile** chart of one pixel's value across every band.

Turn on **Identify** for the layer in the [Layers panel](layers.md), then click the map. Each click adds a numbered dot on the map and a matching curve in the chart, so you can click water, vegetation, and asphalt and compare the three responses side by side. Up to six points are compared at once; older points age off as you add more.

- The chart plots against **wavelength** when the file declares one wavelength per band, and against **band number** otherwise. A wavelength list that doesn't match the band count is ignored rather than trusted, so a stale one can't mislabel the axis.
- Only the tile containing the clicked pixel is fetched, not the whole scene, so profiling a large remote COG stays fast.
- **Pop out** floats the chart in a draggable, resizable window over the map; **PNG** and **CSV** export it.

Single-band rasters produce no profile — use Identify on its own to read the pixel value. Clicks outside the raster, or on a pixel that is nodata in every band, are dropped without disturbing the points you have already collected.

A remote GeoJSON, GeoParquet, or vector PMTiles layer opened with the `data` URL parameter can receive a GeoLibre/MapLibre vector style through `style`. A remote COG can receive a raster style instead. Raster URL styles support band mode and selection, rescale ranges, colormap and reversal, nodata, opacity, gamma, stretch, and normalized-difference index presets. See the [remote data examples](embedding.md#open-remote-data).

## Legends and colorbars

To display a legend or a continuous colorbar on the map, open them from the [Controls menu](map-controls.md). They reflect the styling you set here.
