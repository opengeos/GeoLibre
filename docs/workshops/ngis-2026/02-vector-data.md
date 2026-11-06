# 2. Accessing Cloud-Hosted Vector Data

!!! info "9:00 - 10:00 a.m."
    Lecture 15 min · Hands-on 35 min · Break 9:50 - 10:00

## Learning goals

- Load vector data from public URLs: GeoJSON, CSV with coordinates, and
  FlatGeobuf.
- Style a layer with single, graduated, and categorized symbology.
- Add labels and a legend.
- Explore features in the attribute table.

## Lecture (15 min)

### Where cloud-hosted vector data lives

Public vector data is published in many places: government open-data portals,
GitHub repositories, object storage buckets (Amazon S3, Source Cooperative,
Hugging Face), and APIs. If a file has a public HTTPS URL and the server sends
cross-origin (CORS) headers, GeoLibre can read it directly in the browser.

| Format | Strength | Weakness |
| --- | --- | --- |
| GeoJSON | Human-readable, universal | Large, must be read whole |
| CSV with lon/lat columns | Easy to produce from any spreadsheet or API | Points only, no CRS metadata |
| Shapefile (zipped) | Everywhere in legacy GIS | Many sidecar files, 2 GB limit, 10-character field names |
| GeoPackage | One SQLite file, many layers | Not designed for partial reads over HTTP |
| FlatGeobuf | Streams features, has a spatial index | Less common than GeoJSON |
| GeoParquet | Compressed, columnar, fast to query | Binary, needs a Parquet reader |

GeoLibre's **Add data → Vector layer** reads all of these. In the browser,
formats MapLibre cannot draw natively are converted on the fly by DuckDB-WASM
Spatial. Vector data is reprojected to WGS84 (EPSG:4326) on load, using the CRS
stored in the file. If a layer lands in the wrong place or not at all, its CRS
is probably missing or not an EPSG code: convert it to WGS84 first, or set
**Source CRS override** in the Add Vector Layer panel.

### Symbology in one slide

- **Single symbology**: one color for every feature.
- **Graduated**: a numeric field split into classes (equal interval, quantile,
  natural breaks, and others) and mapped to a color ramp. Use it for
  magnitudes, rates, and densities.
- **Categorized**: one color per distinct value. Use it for types and
  classes.
- **Rule-based** and **Advanced expression**: full control with MapLibre
  expressions.

Quantile classes put the same number of features in each class, which works
well for skewed data such as earthquake magnitudes, where most events are
small.

## Hands-on (35 min)

Start a new project: **Project → New...**, name it
`NGIS 2026 - 2 Vector data and styling`, keep the **Liberty** basemap, and click
**Create**.

### Exercise 2.1: Load the counties (3 min)

1. **Add data → Vector layer**, paste the URL below, and click **Load**:

    ```text
    https://assets.geolibre.app/data/workshops/ngis-2026/nv_counties.geojson
    ```

2. Also load the landmarks:

    ```text
    https://assets.geolibre.app/data/workshops/ngis-2026/reno_sites.geojson
    ```

3. Close the panel and rename the layers `Nevada counties` and
   `Reno-Tahoe sites` (double-click the name).

### Exercise 2.2: Load earthquakes from a CSV (5 min)

The USGS earthquake catalog exports CSV files with `latitude` and `longitude`
columns. This extract holds 8,031 M2.5+ earthquakes from 2016 through 2025.

1. **Add data → Delimited text layer**.
2. **Layer name**: `Nevada earthquakes`.
3. **Source type**: Delimited text URL. Paste:

    ```text
    https://assets.geolibre.app/data/workshops/ngis-2026/nv_earthquakes.csv
    ```

4. Click **Retrieve columns**. The dialog reports **Retrieved 8 columns** and
   picks `longitude` and `latitude` automatically.
5. Leave **Coordinate system** blank (the coordinates are already WGS84) and
   click **Add layer**.

### Exercise 2.3: Graduated symbols by magnitude (8 min)

1. Click the palette icon on the `Nevada earthquakes` row to open the Style
   panel.
2. Set **Style type** to **Graduated**.
3. **Attribute**: `mag`. **Classes**: 5. **Scheme**: **Quantile**.
4. Click the **Colormap** button and choose **Plasma**.
5. Click **Apply style type**. The stops read about 2.5, 2.6, 2.72, 2.9, and
   3.28: most events are barely above the M2.5 cutoff.
6. Try **Scheme: Equal interval** and apply again. Most points fall into the
   first class. Which scheme tells the better story? Switch back to
   **Quantile**.

!!! tip "Style suggestions"
    The Style panel also offers one-click suggestions based on the data, such
    as **Categorize by magType**, **Graduate by depth**, and **Heatmap**. Try
    **Heatmap**, then switch back.

### Exercise 2.4: Outline counties and label them (6 min)

1. Open the Style panel for `Nevada counties`.
2. Next to **Fill color**, tick **Transparent**. Set **Stroke width** to `2`.
3. Scroll to **Labels**, tick **Show labels**, and set **Label field** to
   `NAME`. County names appear at their centroids.

### Exercise 2.5: Legend and attribute table (8 min)

1. Choose **Controls → Legend**. The legend lists each layer and the five
   magnitude classes.
2. On the `Nevada earthquakes` row, open **Layer actions (⋯) → Open attribute
   table**. The table docks below the map and reports **8031 features**.
3. Tick **Zoom to selection** in the table toolbar, sort by `mag`, and click
   the strongest event (M7.1, Ridgecrest, California, July 2019) to find it on
   the map.
4. Explore the table toolbar: field statistics, charts, and **Select by
   expression**.
5. Close the table and save the project (**Project → Save**).

![Earthquakes graduated by magnitude, labeled county outlines, and the legend](https://assets.geolibre.app/images/workshops/ngis-2026/s02-vector-styling.webp)

### Exercise 2.6: FlatGeobuf (5 min)

FlatGeobuf streams features in order and carries a spatial index, so it loads
faster than GeoJSON for large layers.

1. **Add data → FlatGeobuf layer**. Paste the 3,235 US counties into
   **Vector URL** (the **Format** reads FlatGeobuf) and click **Add Layer**:

    ```text
    https://assets.geolibre.app/data/workshops/ngis-2026/us_counties.fgb
    ```

2. The layer list tags it `FLATGEOBUF`. Compare how long it takes with the
   17-county GeoJSON, then remove the layer (trash icon) to keep this project
   focused on Nevada.

## Check your work

[Open the finished project](https://web.geolibre.app/?url=https://assets.geolibre.app/projects/workshops/ngis-2026/02-vector-styling.geolibre.json){ .md-button .md-button--primary }

!!! note "Why this project file is larger"
    A CSV layer is converted to points when it loads, and the converted
    features are embedded in the saved project, so this project is about 2 MB.
    Layers loaded from GeoJSON, GeoParquet, or tiles store only their URL.

## Going further

- **Add data → Administrative boundaries** adds geoBoundaries polygons for any
  country.
- **Plugins → Web services → US state GIS** browses every state's open-data
  portal, including Nevada's.
- Read [Styling Layers](../../user-guide/styling.md) and
  [Attribute Table](../../user-guide/attribute-table.md).

---

**Break: 9:50 - 10:00.** Next: [3. Cloud-Native Formats](03-cloud-native-formats.md)
