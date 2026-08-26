# Attribute Table

The **Attribute table** shows the records of the selected vector or DuckDB layer. Open it from **Layer actions → Open attribute table**, or expand it from the **Attribute table** button on the status bar and then select a layer in the [Layers panel](layers.md).

![The attribute table docked below the map, showing a vector layer's records and its toolbar](https://assets.geolibre.app/images/geolibre-attribute-table.webp)

## The toolbar

| Button | What it does |
| --- | --- |
| **Edit** / **Save** | Turn on inline editing, then write the changes back to the layer. See [Editing values](#editing-values). |
| **Explore** | Open the [Column explorer](#column-explorer). |
| **Statistics** | Summary statistics for one field. See [Field statistics](#field-statistics). |
| **Charts** | Chart one or two fields without leaving the table. See [Charts](#charts). |
| **Dashboard** | Open the [Dashboard](processing.md#dashboard) with this layer preselected, to build a persistent panel of widgets. |
| **Export** | Write the records you are viewing to a file. See [Exporting](#exporting). |
| **Search attributes…** | Filter rows to those matching the text you type, across every field. |
| **Zoom to selection** | Keep the map framed on the selected features as the selection changes. |
| **Show All Features / Show Selected** | Show every record, or only the selected ones. The count updates with the selection. |

The bar along the bottom reports the record count and how many are selected.

## Reading and navigating

- **Sort** by clicking a column header to order rows ascending or descending.
- **Resize** columns by dragging their borders, and scroll horizontally when a layer has many fields.
- **Resize the panel** by dragging its top edge, which is worth doing before working through a long table.

## Linking to the map

The attribute table and the map stay in sync:

- Selecting a row highlights the corresponding feature on the map.
- **Zoom to selection** keeps the map framed on what is selected.
- Selections support multiple features at once, and the same selection drives **Edit → Export Selected Features as Layer** and the [selection tools](layers.md#per-layer-actions).

## Column explorer

**Explore** profiles every field in the layer at once: its type, how many records are populated, how many are null, how many distinct values it holds, and the shape of its distribution — a ranked bar chart of the commonest values for text fields, a histogram with min, mean, and max for numeric ones. Filter the field list by name when a layer has many columns.

![The Column explorer, profiling the type, completeness, and distribution of every field in a layer](https://assets.geolibre.app/images/geolibre-column-explorer.webp)

It is the fastest way to answer "what is actually in this data?" before styling or filtering it — a field that is 90% null, or a "numeric" field with one non-numeric outlier, shows up immediately.

## Field statistics

**Statistics** summarizes one field at a time. Every field reports **Count**, **Nulls**, and **Unique**; a numeric field adds **Min**, **Max**, **Mean**, **Median**, **Std dev**, and **Sum**, while a text field lists its most frequent values with their counts. **Copy** puts the whole summary on the clipboard.

![The Field statistics dialog summarizing a numeric field](https://assets.geolibre.app/images/geolibre-field-statistics.webp)

## Charts

**Charts** plots the current layer without adding anything to the project: pick a chart type (histogram, scatter, bar, line, box plot, or pie), the field or fields to plot, and any type-specific options such as the bin count. **Download** saves the chart as an image.

![The Charts dialog showing a histogram of a numeric field](https://assets.geolibre.app/images/geolibre-attribute-charts.webp)

Charts here are throwaway views. For charts that are saved with the project and cross-filter each other, build them in the [Dashboard](processing.md#dashboard) instead.

## Editing values

For editable layers (including GeoJSON layers and materialized DuckDB layers), click **Edit** to change attribute values inline, then **Save** to commit them. Combine this with the **GeoEditor** plugin to edit both geometry and attributes. See [Managing Layers](layers.md).

## DuckDB layers

Layers produced by the [SQL Workspace](sql-workspace.md) or added from a [DuckDB source](adding-data.md#databases) behave like vector layers here, with full identify, selection, and attribute table support. You can keep several DuckDB query-result layers open at once.

## Exporting

You can export the records you are viewing as GeoJSON, GeoParquet, GeoPackage, a zipped Shapefile, or CSV (attributes only). The same formats are available from a layer's **Layer actions → Export** submenu in the [Layers panel](layers.md), which adds KML and KMZ. Exporting to Shapefile surfaces a warning when field names exceed the format's 10-character limit. The [SQL Workspace](sql-workspace.md) additionally exports query results as CSV or GeoParquet, and the [Conversion tools](processing.md#conversion) write cloud-native formats.
