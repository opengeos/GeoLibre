# OGC API Coverages fixtures

These are public pygeoapi GDPS temperature sample responses retrieved on 2026-11-25:

- `gdps-collection.json`: <https://demo.pygeoapi.io/master/collections/gdps-temperature?f=json>
- `gdps-temperature.json`: <https://demo.pygeoapi.io/master/collections/gdps-temperature/coverage?f=json&bbox=-80,43,-79,44>

The coverage contains a 7 by 7 regular CRS84 grid and 49 Float64 `TMP` values in degrees Celsius. It is sample data, not a current weather forecast. The fixtures preserve the service's metadata and values. Tests check cell-center georeferencing, axis order, numerical precision, missing values and linked CoverageJSON components using these responses.

The service advertises CoverageJSON and GRIB for this collection. These fixtures do not demonstrate a public GeoTIFF endpoint or OGC API Processes support.
