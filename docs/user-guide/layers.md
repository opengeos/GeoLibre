# Managing Layers

The **Layers panel** on the left lists every layer in the project, from the topmost drawing layer down to the basemap. Selecting a layer here drives the [Style panel](styling.md) and the [Attribute table](attribute-table.md).

![Layers panel with a vector layer and the basemap](https://data.geolibre.app/images/geolibre-layer-panel.webp)

## Layer order and visibility

- **Visibility**: click the eye button to show or hide a layer. The **Hide all layers** button at the top of the panel hides every layer at once.
- **Order**: drag a layer to reorder it, or use the move up and move down actions. Layers higher in the list draw on top. The basemap (**Background**) always stays at the bottom.
- **Opacity**: each layer has an opacity slider from 0 to 100 percent.

## Per-layer actions

Each layer exposes a set of actions:

- **Zoom to layer**: fit the map to the layer's extent (for layers whose bounds are known).
- **Identify features**: click features on the map to see their attributes in a popup.
- **Labels**: toggle text labels for vector layers that have a label field.
- **Metadata / Properties**: inspect the layer's source and configuration.
- **Remove layer**: delete the layer from the project.
- **Insert before**: control where a new layer is placed in the stack.

### Importing and exporting styles

Vector layers have a **Layer actions → Styles** submenu for symbology interchange:

- **Export GeoLibre URL style** writes a compact `.geolibre.style.json` file designed for the [`data` and `style` URL parameters](embedding.md#open-remote-data). It contains no feature data. Its MapLibre render layers use the original GeoJSON filename stem as `source`, allowing one style document to distinguish GeoJSON members in a ZIP.
- **Export as Mapbox GL style** writes a self-contained Mapbox/MapLibre style with the layer's GeoJSON embedded.
- **Export as OGC SLD** and **Export as QGIS QML** produce styles for other desktop and server GIS software.
- **Import style (GeoLibre URL / Mapbox GL / SLD / QML)…** applies a supported style file to the selected layer. When importing a GeoLibre URL style interactively, the filename-based `source` association is ignored because the selected layer is the target.

To use a GeoLibre URL style, upload it to a CORS-enabled web host and open GeoLibre with both URLs:

```text
https://web.geolibre.app/?data=https%3A%2F%2Fassets.geolibre.app%2Fdata%2Fplaces.geojson&style=https%3A%2F%2Fassets.geolibre.app%2Fdata%2Fsample.style.json
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
