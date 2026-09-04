# USGS NLDI workflows

GeoLibre includes a **USGS NLDI** plugin for tracing a point to the National
Hydrography Dataset (NHD) network and displaying the result on the map.

## Trace a map point

1. Open **Plugins → USGS NLDI**.
2. Choose **Complete flowline**, **Upstream only**, or **Downstream only**.
3. Click a point on the map.

The plugin calls the NLDI `nldi-flowtrace` process. It draws the returned NHD
flowline in blue, and, when the point is not already on a flowline, the
elevation-based `raindropPath` in orange. The clicked point is marked in red.

## Basin workflow

After a trace, GeoLibre calls NLDI hydrolocation for the clicked coordinate.
When a COMID is available, use **Basin from hydrolocation** to request the
simplified upstream basin. The selected COMID also enables navigation options
for upstream mainstem, upstream tributaries, downstream mainstem, and
downstream diversions. Set a distance in kilometres and choose **1. Load
sources & plot navigation** to load the available catalogs. You can then choose NHD flowlines,
streamgages (`ca_gages` or `nwissite`), groundwater wells (`nwisgw`),
Geospatial Fabric points (`gfv11_pois`), HUC12 pour points (`huc12pp`),
New Mexico water sites (`nmwdi-st`), or another catalog returned by NLDI.
Choose **Plot another navigation layer** to draw the selected features on the
map; flowlines are purple and point catalogs are also rendered by the
navigation layer. These are chained
workflows: the selected map point feeds hydrolocation, its COMID feeds the
basin or navigation request, and the result is rendered on the map.

Use **Export rendered results to GeoJSON** to save the selected point,
flowline, raindrop path, basin, and any plotted navigation features as one
GeoJSON FeatureCollection. The `_nldiLayer` property identifies each result
group in the exported file.

Use **Add rendered results to GeoLibre Layers** to copy the current NLDI
results into the Layers panel. GeoLibre creates one **USGS NLDI results** group
containing the flowline, raindrop path, selected point, basin, and every
navigation result plotted so far. These copied layers remain in the project
even after the temporary NLDI map overlays are cleared.

The plugin uses the public USGS service at
`https://api.water.usgs.gov/nldi`; network access and the service’s CORS policy
are required.
