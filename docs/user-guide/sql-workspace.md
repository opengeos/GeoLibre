# SQL Workspace

The **SQL Workspace** runs DuckDB Spatial SQL right in the app, against your loaded layers, local files, and remote URLs. Open it from **Processing > SQL Workspace**. The spatial extension is loaded for you, so `ST_*` functions are available.

![SQL Workspace](https://data.geolibre.app/images/geolibre-sql-workspace.webp)

## Querying loaded layers

Every loaded vector layer is exposed as a queryable table; the dialog lists the available table names at the top. Write a query in the editor and click **Run** to see the results.

```sql
SELECT name, ST_Area(geometry) AS area
FROM countries
ORDER BY area DESC
LIMIT 10;
```

## Reading files and URLs

You can query files and remote URLs directly. The workspace auto-wraps a bare URL into the matching reader (for example Parquet, CSV, JSON, or GeoJSON) and streams remote files over HTTP range requests, so you do not have to download them first.

```sql
SELECT *
FROM 'https://data.source.coop/giswqs/opengeos/countries.parquet'
LIMIT 100;
```

## Sample queries and history

- **Sample queries** and **Sample query for layer** menus drop ready-made queries into the editor to get you started.
- Your previous queries are kept in a **history** so you can rerun them.

## Using the results

When a query returns geometry, you can **add the result to the map** as a new layer (with an optional layer name). The result layer behaves like any vector layer, with [identify, selection, and the attribute table](attribute-table.md). You can also **export** results as CSV or GeoParquet.

!!! tip "Multiple result layers"
    You can add several DuckDB query-result layers to the same project and keep them all open at once.

See the [Spatial SQL tutorial](../tutorials/spatial-sql.md) for an end-to-end walkthrough. The SQL Workspace works in both the browser and the desktop app because it runs on DuckDB-WASM.
