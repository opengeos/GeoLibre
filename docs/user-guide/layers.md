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

## Refreshing live layers

WFS and GeoJSON URL layers can refresh automatically so the map stays current with a changing source. Open the layer's refresh configuration and choose an interval (for example off, 15 seconds, 30 seconds, 1 minute, 5 minutes, 15 minutes, or a custom value), or trigger a manual refresh.

## DuckDB layers

Layers added from a [DuckDB source](adding-data.md#databases) or produced by the [SQL Workspace](sql-workspace.md) support identify, selection, and the attribute table like any vector layer. You can also materialize a DuckDB query result into an editable GeoJSON layer when you want to edit its geometry or attributes.

## The basemap

The **Background** entry at the bottom of the panel is the basemap. Toggle its visibility and adjust its opacity here. To change which basemap is shown, use the **Basemaps** plugin from the [Plugins menu](plugins.md). See [Adding Data](adding-data.md#basemaps).

!!! tip "Editing geometry"
    To draw or edit features directly on the map, activate the **GeoEditor** plugin from the [Plugins menu](plugins.md). It adds drawing, vertex editing, and deletion tools for GeoJSON layers.
