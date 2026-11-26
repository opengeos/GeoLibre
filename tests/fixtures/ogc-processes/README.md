# OGC API Processes sample

`hello-world.json` is the public pygeoapi process description retrieved on
2026-11-25 from
<https://demo.pygeoapi.io/master/processes/hello-world?f=json>.
It exercises real input schemas, execution links and advertised job controls.

Protocol tests also cover the public service's synchronous document output
shape (`outputs` as an array) and its asynchronous `201 Created` response.
Both synchronous and asynchronous requests were executed against this service,
their status and results were retrieved, and only those verification jobs were
dismissed afterward. The tests themselves do not contact the public service.

Specification: <https://docs.ogc.org/is/18-062r2/18-062r2.html>.

`metadata-record.json` is the GeoJSON output returned on 2026-11-26 by the same
public service's `pygeometa-metadata-generate` process, using its `oarec-record`
schema and the upstream [sample MCF](https://github.com/geopython/pygeometa/blob/master/sample.mcf.yml).
The service returns this Feature directly inside its `outputs` array, without
a `value` wrapper. Real browser validation imported its polygon onto the map
and downloaded the result, checking all coordinates and its metadata title.
Its verification job was dismissed afterward.

`gdps-striped-float64.tif` comes from the 7 × 7 GDPS temperature snapshot
downloaded from the same public service's `gdps-temperature` collection for
bbox `[-80, 43, -79, 44]`. Rasterio rewrote the verified numerical snapshot as
striped Float64 and replaced its first pixel with NaN to exercise NoData.
The other 48 samples are unchanged. The conversion regression independently
reads every source and converted sample with geotiff.js and checks exact
Float64 equality, including NaN, CRS and NoData metadata.

`striped-uint64.tif` and `striped-int64.tif` are synthetic 2 × 2 WGS84 TIFFs
written with Rasterio, with samples `[[9007199254740993, 9007199254740995], [1, 2]]`.
Their extent is `[0, 0, 2, 2]`, their pixel size is one degree, and they are
striped with no compression. The first two integers cannot be represented
exactly by Float64. Import tests read the real TIFF metadata and verify that
these results are rejected before lossy conversion or layer publication.
