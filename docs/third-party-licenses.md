# Third-party licenses

GeoLibre is MIT licensed. Two dependencies have terms worth calling out.

## gdal3.js

The Georeferencer's GeoTIFF/COG export uses an unmodified copy of
[gdal3.js](https://github.com/bugra9/gdal3.js), licensed under the
[GNU LGPL, version 2.1 or later](https://github.com/bugra9/gdal3.js/blob/master/LICENSE).
Its JavaScript loader is included in GeoLibre builds; its WebAssembly and data
files are fetched from jsDelivr when you export. Every build carries the license
and a link to the exact source version at `licenses/gdal3.js/`.

## Mapbox GL JS

Mapbox GL JS is not included in GeoLibre. When you choose a Mapbox map, your
browser loads it directly from Mapbox's CDN, and its use is subject to the
[Mapbox Terms of Service](https://www.mapbox.com/legal/tos/).
