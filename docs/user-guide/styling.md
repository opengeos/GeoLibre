# Styling Layers

The **Style panel** on the right edits the appearance of the layer selected in the [Layers panel](layers.md). Vector and raster layers each get their own set of controls.

## Vector styling

For vector layers the Style panel covers fill, stroke, points, labels, and 3D extrusion:

- **Fill**: fill color and fill opacity for polygons.
- **Stroke**: line color and width for lines and polygon outlines.
- **Points**: circle radius for point layers.
- **Labels**: text color, size, halo color, and halo width.
- **3D extrusion**: turn polygons into extruded blocks, with a height field, height scale, base height, and color. Advanced expressions are available for both height and color.

You can also set a per-style minimum and maximum zoom so a style only applies within a zoom range.

### Style type (data-driven styling)

The **Style type** control chooses how feature values map to color:

| Style type | Description |
| --- | --- |
| **Single symbology** | One uniform style for every feature. |
| **Graduated** | Classify a numeric field into classes with a color ramp. Choose the field, the number of classes, a classification scheme (such as equal interval or quantile), and a colormap. |
| **Categorized** | Assign a color per unique category value of a field. |
| **Expression** | Drive styling with a custom MapLibre expression for full control. |

For graduated and categorized styles, GeoLibre generates the class breaks or category stops and shows them in the panel, where you can fine-tune individual colors before applying.

!!! tip "Choropleth maps"
    To make a choropleth, select **Graduated**, pick a numeric attribute, choose a colormap, and click **Apply style type**. See the [Your First Map tutorial](../tutorials/first-map.md).

## Raster styling

For raster layers the Style panel exposes image adjustments:

- **Brightness** (minimum and maximum)
- **Saturation**
- **Contrast**
- **Hue rotation** (in degrees)

These let you tune the look of GeoTIFF, COG, and tile-based raster layers without changing the underlying data.

## Legends and colorbars

To display a legend or a continuous colorbar on the map, open them from the [Controls menu](map-controls.md). They reflect the styling you set here.
