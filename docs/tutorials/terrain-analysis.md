# Terrain Analysis

This tutorial derives terrain products from a digital elevation model (DEM): a hillshade, a slope map, and contour lines. It uses the [Raster tools](../user-guide/processing.md#raster) under **Processing → GeoLibre Toolbox → Raster**.

!!! note "Desktop app required"
    The raster tools run on the rasterio Python sidecar, which the desktop app manages. They are not available in the browser build. See [Getting Started](../getting-started.md#optional-python-sidecar).

## 1. Load a DEM

Add an elevation raster as a layer, for example a GeoTIFF or COG DEM (see [Adding Data](../user-guide/adding-data.md)). The raster tools take a file path in and write a file path out, so a local or accessible raster works best.

## 2. Hillshade

1. Open **Processing → GeoLibre Toolbox → Raster → Hillshade**.
2. Choose the DEM as input and set the azimuth, altitude, and z-factor if you want to adjust the lighting.
3. Run it. The shaded-relief raster is added to the map. Place it under your other layers and lower their opacity for a relief backdrop.

## 3. Slope and aspect

- **Processing → GeoLibre Toolbox → Raster → Slope** computes steepness from the DEM.
- **Processing → GeoLibre Toolbox → Raster → Aspect** computes the compass direction of the steepest slope.

Run either against the DEM and style the output with a [colormap](../user-guide/styling.md). Open the **Colorbar** from the [Controls menu](../user-guide/map-controls.md) to show the value scale.

## 4. Contours

1. Open **Processing → GeoLibre Toolbox → Raster → Contour**.
2. Choose the DEM and set the contour **interval** (the elevation difference between lines).
3. Run it to generate contour lines as a vector layer, which you can label and style like any vector data.

## 5. Clip to an area of interest

To restrict outputs to a study area, use **Processing → GeoLibre Toolbox → Raster → Clip by extent** (a bounding box) or **Clip by mask layer** (a vector mask). See [Processing Tools](../user-guide/processing.md#raster).

## Next steps

- Convert raster outputs to vectors with **Polygonize**, or write a **Raster to COG** for sharing. See [Cloud-Native Data](cloud-native-data.md).
- Animate a time series of rasters with the Time Slider plugin. See [Data Integrations](../user-guide/data-integrations.md).
