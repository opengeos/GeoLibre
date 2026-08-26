# Managing Layers

The **Layers panel** on the left lists every layer in the project, from the topmost drawing layer down to the basemap. Selecting a layer here drives the [Style panel](styling.md) and the [Attribute table](attribute-table.md).

![The Layers panel: a group, two vector layers with the selected one's action buttons expanded, and the basemap at the bottom](https://assets.geolibre.app/images/geolibre-layers-panel.webp)

## Layer order and visibility

- **Visibility**: click the eye button to show or hide a layer. The **Hide all layers** button at the top of the panel hides every layer at once.
- **Order**: drag a layer to reorder it, or use the move up and move down actions. Layers higher in the list draw on top. The basemap (**Background**) always stays at the bottom.
- **Opacity**: each layer has an opacity slider from 0 to 100 percent.

## Blend modes

The [Style panel](styling.md) carries a **Blend** menu, above the symbology
controls, that sets how a layer's colours combine with the map below it.
Opacity dilutes a layer; a blend mode mixes it, so the layers underneath still
read through at full saturation.

The classic use is shading: put a hillshade, a terrain raster, or a dark
basemap under a thematic fill or an aerial image, set the top layer to
**Multiply**, and the relief shows through the colour instead of being hidden by
it. Lowering opacity instead would wash out both.

| Mode | What it does | Typical use |
| --- | --- | --- |
| **Normal** | Ordinary transparency — the default | Everything else |
| **Multiply** | Darkens: the two colours are multiplied | Colour or imagery over a hillshade; adding shadow |
| **Screen** | Lightens: the inverse of Multiply | Lifting a dark layer out of a dark basemap |
| **Lighten** | Keeps whichever colour is brighter | Overlaying bright features without darkening the map |
| **Add** | Sums the colours, clipping toward white | Glow effects, heat and density overlays |

Blending applies to a layer's fills, outlines, points, markers, and raster
tiles. **Labels are deliberately excluded** and always draw normally, so place
names stay legible over a multiplied hillshade.

!!! warning "Overlapping points and 3D buildings blend twice"

    Polygons, lines, and raster tiles blend as a whole layer: two overlapping
    polygons in the same layer combine with the map beneath them, not with each
    other. Points and 3D extrusions cannot, because MapLibre provides no
    layer-level compositing step for them, so each symbol blends separately.
    Where two point symbols overlap on screen the overlap is blended twice and
    reads noticeably darker under Multiply than the rest of the symbol.

    If that shows in your map, reduce the overlap (a smaller radius, clustering,
    or a scale-dependent minimum zoom), or convert the points to polygons.

A blend mode is saved with the project and travels with a copied style, but it
is a GeoLibre rendering setting with no equivalent in the MapLibre or Mapbox
style specification, so it is dropped when you export a layer's style to a style
file, SLD, or QML.

!!! note "Why these five modes"

    MapLibre draws every layer into one WebGL canvas and offers no per-layer
    blending API, so GeoLibre applies these modes inside the renderer using the
    GPU's fixed-function blend stage. That stage can express these five and no
    more. Photoshop-style modes such as Overlay, Colour Dodge, and Soft Light
    need to read the colours already on the canvas from inside a shader, which
    is not possible here without an extra full-frame copy on every draw. Darken
    and Subtract are not offered either: their GPU equations also act on the
    transparency channel, which would erase the map wherever the layer does not
    cover it. See [maplibre-gl-js#8073](https://github.com/maplibre/maplibre-gl-js/pull/8073)
    for the upstream work that would widen this list.

Blending is applied while MapLibre draws a layer, so it reaches only the layers
GeoLibre itself styles. The following are drawn or styled elsewhere, and so have
no Blend menu:

- **3D Tiles, Gaussian splats, LiDAR point clouds, and deck.gl overlays**, which
  draw with their own WebGL renderer instead of MapLibre's.
- **Cloud-Optimized GeoTIFFs** added through **Add Data > Raster Layer**, for
  the same reason on their default rendering engine.
- **Vector layers added through Add Data > Vector Layer**, which do draw through
  MapLibre but are styled by their own control rather than by GeoLibre, so there
  is no point at which the blend mode could be applied.

Everything else blends: local and remote GeoJSON, ordinary raster layers (XYZ,
WMS, WMTS), PMTiles, MBTiles, and vector tiles.

## Per-layer actions

Selecting a layer expands a row of icon buttons on its card:

| Button | What it does |
| --- | --- |
| **Move up** / **Move down** | Shift the layer one position in the stack. |
| **Zoom to layer** | Fit the map to the layer's extent (for layers whose bounds are known). |
| **Identify features** | Click features on the map to see their attributes in a popup. On a raster layer this reads the pixel value instead, and on a multiband raster it also builds a [spectral profile](styling.md#spectral-profile). |
| **Open Style panel** | Select the layer and open its [styling controls](styling.md). |
| **Layer actions** | The full menu, below. |
| **Metadata** | Inspect the layer's source and configuration. |
| **Remove layer** | Delete the layer from the project. |

The **Layer actions** menu (the `…` button) holds everything else:

![The Layer actions menu on a vector layer](https://assets.geolibre.app/images/geolibre-layer-actions.webp)

| Item | What it does |
| --- | --- |
| **Rename** | Change the layer's display name. |
| **Open Style panel** | Same as the palette button on the card. |
| **New group from layer** | Wrap this layer in a new [group](#layer-groups). |
| **Edit geometry** | Hand the layer to the GeoEditor for vertex-level editing. |
| **Load features into editor…** | Copy features from this layer into the GeoEditor's sketch layer. |
| **Open attribute table** | Show this layer's records in the [Attribute table](attribute-table.md). |
| **Quick analysis** | Run a buffer, centroids, convex hull, or bounding box over the whole layer with no dialog. See [Right-click quick actions](map-controls.md#right-click-quick-actions). |
| **Select features** | The interactive selection modes: by click, rectangle, polygon, freehand, or radius, plus **Clear Selection**. Hold `Shift` to add, `Alt` to remove, `Shift`+`Alt` to intersect, and `Esc` to cancel. |
| **Select by Expression…** / **Select by Location…** | Build a selection from an attribute expression or a spatial relationship. Both are also on the [Edit menu](interface.md#the-top-toolbar). |
| **Bind to Time Slider…** | Drive the Time Slider from one of this layer's date or number fields. |
| **Export** | Write the layer out as GeoJSON, GeoParquet, GeoPackage, KML, KMZ, zipped Shapefile, or CSV (attributes only). |
| **Styles** | Import and export symbology — see [below](#importing-and-exporting-styles). |
| **Save to My Data** | Store the fully configured layer in your personal library, ready to re-add from the [Browser panel](adding-data.md#the-browser-panel) in any later project. |
| **Copy style** / **Paste style** | Carry symbology from one layer to another. |
| **Refresh** / **Auto refresh** | Reload the source now, or on an interval — see [Refreshing live layers](#refreshing-live-layers). |

Some entries are unavailable on layers they do not apply to: **Select by Location** needs a second layer to compare against, and **Paste style** needs a style on the clipboard.

### Importing and exporting styles

Vector layers have a **Layer actions → Styles** submenu for symbology interchange:

- **Export GeoLibre URL style** writes a compact `.geolibre.style.json` file designed for the [`data` and `style` URL parameters](embedding.md#open-remote-data). It contains no feature data. Its MapLibre render layers use the original GeoJSON filename stem as `source`, allowing one style document to distinguish GeoJSON members in a ZIP.
- **Export as Mapbox GL style** writes a self-contained Mapbox/MapLibre style with the layer's GeoJSON embedded.
- **Export as OGC SLD** and **Export as QGIS QML** produce styles for other desktop and server GIS software.
- **Import style (GeoLibre URL / Mapbox GL / SLD / QML)…** applies a supported style file to the selected layer. When importing a GeoLibre URL style interactively, the filename-based `source` association is ignored because the selected layer is the target.
- **Saved styles (Style Manager)…** applies a preset from your style library, or saves the current symbology into it. The same library is reachable from **Settings → Style Manager**.

To use a GeoLibre URL style, upload it to a CORS-enabled web host and open GeoLibre with both URLs:

```text
https://web.geolibre.app/?data=https://assets.geolibre.app/data/places.geojson&style=https://assets.geolibre.app/data/sample.style.json
```

See [Embedding & Sharing](embedding.md#open-remote-data) for GeoParquet and PMTiles deep links, ZIP source matching, REST API responses, raster-style JSON, and encoding nested URLs.

## Layer groups

Groups are folders in the layer stack. They can nest, so a project can carry a real hierarchy rather than one flat list.

- **Create**: **New group** adds an empty folder. **New group from layer** wraps the layer you are on, and **New group from selected layers** wraps a multi-selection.
- **Fill**: **Move to group** moves one layer, **Move selected layers to group** moves a whole selection in one step (keeping their relative order), and **Add data to group** opens Add Data with the new layer targeted at that group.
- **Organize**: rename a group, collapse or expand it, move it up or down, and set a group-level opacity that applies to everything inside.
- **Visibility**: hiding a group hides its layers. A layer inside a hidden group is marked *Hidden because its group is not visible*, so you can tell it apart from a layer you turned off yourself.
- **Remove**: **Ungroup (keep layers)** dissolves the folder and leaves its layers in place; **Delete group and layers** removes both.

Groups and their nesting are saved with the project, and [importing a QGIS project](projects.md#importing-a-qgis-project) brings that project's group tree across.

## Refreshing live layers

WFS and GeoJSON URL layers can refresh automatically so the map stays current with a changing source. Open the layer's refresh configuration and choose an interval (for example off, 15 seconds, 30 seconds, 1 minute, 5 minutes, 15 minutes, or a custom value), or trigger a manual refresh.

Each reloadable layer persists a **connection** record with the project, so the refresh cadence survives a save and reopen. The record also carries the layer's synchronization status — when it last succeeded and the most recent error — which the Layers panel shows, and an on-failure policy that decides whether a failed refresh keeps the last good data or clears it. See [Project Format](../project-format.md) for the schema.

## DuckDB layers

Layers added from a [DuckDB source](adding-data.md#databases) or produced by the [SQL Workspace](sql-workspace.md) support identify, selection, and the attribute table like any vector layer. You can also materialize a DuckDB query result into an editable GeoJSON layer when you want to edit its geometry or attributes.

## The basemap

The **Background** entry at the bottom of the panel is the basemap. Toggle its visibility and adjust its opacity here. To change which basemap is shown, use the **Basemaps** plugin from the [Plugins menu](plugins.md). See [Adding Data](adding-data.md#basemaps).

!!! tip "Editing geometry"
    To draw or edit features directly on the map, activate the **GeoEditor** plugin from the [Plugins menu](plugins.md). It adds drawing, vertex editing, and deletion tools for GeoJSON layers.
