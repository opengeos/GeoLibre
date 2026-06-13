# Attribute Table

The **Attribute table** shows the records of the selected vector or DuckDB layer. Expand it from the **Attribute table** button on the status bar at the bottom of the window, then select a layer in the [Layers panel](layers.md) to populate it.

![Attribute table](https://data.geolibre.app/images/geolibre-attribute-table.webp)

## Reading and navigating

- **Sort** by clicking a column header to order rows ascending or descending.
- **Resize** columns by dragging their borders, and scroll horizontally when a layer has many fields.
- **Filter** rows by attribute value to narrow large tables.

## Linking to the map

The attribute table and the map stay in sync:

- Selecting a row highlights the corresponding feature on the map.
- You can zoom the map to the selected feature.
- Selections support multiple features at once.

## Editing values

For editable layers (including GeoJSON layers and materialized DuckDB layers), you can edit attribute values inline. Combine this with the **GeoEditor** plugin to edit both geometry and attributes. See [Managing Layers](layers.md).

## DuckDB layers

Layers produced by the [SQL Workspace](sql-workspace.md) or added from a [DuckDB source](adding-data.md#databases) behave like vector layers here, with full identify, selection, and attribute table support. You can keep several DuckDB query-result layers open at once.

## Exporting

You can export the records you are viewing as GeoJSON, GeoParquet, GeoPackage, a zipped Shapefile, or CSV (attributes only). The same formats are available from a layer's context menu in the [Layers panel](layers.md). Exporting to Shapefile surfaces a warning when field names exceed the format's 10-character limit. The [SQL Workspace](sql-workspace.md) additionally exports query results as CSV or GeoParquet, and the [Conversion tools](processing.md#conversion) write cloud-native formats.
