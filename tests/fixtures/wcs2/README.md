# Public WCS 2.0.1 metadata

Retrieved 2026-11-25 directly from these public services without authentication or modified responses:

- [MapServer capabilities](https://demo.mapserver.org/cgi-bin/wcs?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCapabilities)
- [MapServer ndvi description](https://demo.mapserver.org/cgi-bin/wcs?SERVICE=WCS&VERSION=2.0.1&REQUEST=DescribeCoverage&COVERAGEID=ndvi)
- [USGS 3DEP capabilities](https://elevation.nationalmap.gov/arcgis/services/3DEPElevation/ImageServer/WCSServer?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCapabilities)
- [USGS 3DEP description](https://elevation.nationalmap.gov/arcgis/services/3DEPElevation/ImageServer/WCSServer?SERVICE=WCS&VERSION=2.0.1&REQUEST=DescribeCoverage&COVERAGEID=DEP3Elevation)

The MapServer coverage uses EPSG:26915, while the USGS coverage uses EPSG:3857. Both advertise `x y` envelope and grid axes. Discovery must preserve geographic OWS bounding boxes where advertised, and requests must read axis labels from the description rather than assume latitude/longitude order.

Protocol references: [OGC WCS](https://www.ogc.org/standards/wcs/), [GeoServer WCS reference](https://docs.geoserver.org/stable/en/user/services/wcs/reference/), and [GDAL WCS driver](https://gdal.org/en/stable/drivers/raster/wcs.html).

The two GetCoverage fixtures use `FORMAT=image/tiff`, `SUBSETTINGCRS=http://www.opengis.net/def/crs/EPSG/0/4326`, repeated `SUBSET=x(west,east)` and `SUBSET=y(south,north)`, and `SCALESIZE=x(64),y(64)`. The response bytes are stored losslessly as Base64 text (`*.b64`) so text-formatting hooks cannot change MIME line endings or binary TIFF samples; tests decode them before calling the real parser:

- MapServer `ndvi`: bounds `[-94,45,-93.8,45.2]`, returns a direct 64 by 64 TIFF, EPSG:4326. This particular subset has all zero values, so it proves the transport and geometry rather than a nonzero vegetation signal.
- USGS `DEP3Elevation`: bounds `[-89.5,40,-89.48,40.02]`, returns MIME parts `text/xml` and `image/tiff` with boundary `wcs` even though TIFF was requested. Independent Rasterio decoding of the TIFF part confirms 64 by 64, EPSG:4326, all 4,096 pixels finite, and elevations from 177.01031494140625 to 192.84918212890625. The raw multipart response is retained unchanged.

The app's existing TIFF assertion correctly rejects a raw multipart envelope. WCS 2 support needs to extract and validate its TIFF part before using the existing bounded raster import path, rather than treat this genuine service response as a failed raster.
