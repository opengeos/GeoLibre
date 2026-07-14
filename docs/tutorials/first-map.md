# Your First Map

This tutorial takes you from an empty workspace to a styled map with inspectable data, in a few minutes. You can do all of it in the [live viewer](https://web.geolibre.app/).

## 1. Open GeoLibre

Open [web.geolibre.app](https://web.geolibre.app/), or launch the desktop app. You start with a basemap and an empty [Layers panel](../user-guide/layers.md).

## 2. Add a layer

1. Open **Add Data → Vector Layer**.
2. In the Add Vector panel, enter a vector URL. You can use the sample countries dataset:
   ```text
   https://data.source.coop/giswqs/opengeos/countries.parquet
   ```
3. Click **Load**. The countries appear on the map and a `countries` layer is added to the Layers panel.

![Add Vector Layer panel with the sample URL ready to load](https://data.geolibre.app/images/geolibre-add-vector-panel.webp)

See [Adding Data](../user-guide/adding-data.md) for every supported source.

## 3. Style the layer

1. Select the `countries` layer in the Layers panel. The [Style panel](../user-guide/styling.md) opens on the right.
2. Adjust the **Fill color**, **Outline color**, and **Fill opacity** to taste.
3. To make a choropleth, set **Style type** to **Graduated**, pick a numeric field (for example a population or GDP column), choose a **Colormap**, and click **Apply style type**.

## 4. Inspect the data

1. Click **Attribute table** on the status bar to expand it, then select the `countries` layer to load its records. See [Attribute Table](../user-guide/attribute-table.md).
2. Sort by a column, or filter to find a feature. Selecting a row highlights it on the map.
3. You can also turn on **Identify features** for the layer and click a country on the map to see its attributes in a popup.

## 5. Save or share

- In the desktop app, use **Project → Save** to write a `.geolibre.json` file.
- Anywhere, use **Project → Share** to upload the project and get a public link. See [Sharing & Embedding](sharing-embedding.md).

## Next steps

- Load cloud-native and remote formats in [Cloud-Native Data](cloud-native-data.md).
- Run geometry tools in [Vector Analysis](vector-analysis.md).
- Query your data in [Spatial SQL](spatial-sql.md).
