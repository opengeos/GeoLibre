# Acknowledgements

GeoLibre stands on the shoulders of the open-source geospatial and web
communities. This page recognizes the projects, organizations, and individuals
whose work makes GeoLibre possible. If we have inadvertently left someone out,
please [open an issue](https://github.com/opengeos/GeoLibre/issues) so we can
correct it.

## Open-source projects

GeoLibre is built almost entirely on free and open-source software. We are
grateful to the maintainers and contributors of the following projects (and the
many transitive dependencies they rely on).

### Mapping and rendering

- [MapLibre GL JS](https://maplibre.org/) — the core map rendering engine.
- [deck.gl](https://deck.gl/) and the [vis.gl](https://vis.gl/) / Open Visualization toolkit — raster, point-cloud, and 3D overlays.
- [Three.js](https://threejs.org/) — 3D rendering used by globe and atmosphere effects.
- [PMTiles](https://github.com/protomaps/PMTiles) and [Protomaps](https://protomaps.com/) — single-file tile archives.
- [OpenFreeMap](https://openfreemap.org/) and [CARTO](https://carto.com/) basemaps, and the broader [OpenStreetMap](https://www.openstreetmap.org/) community whose data underpins them.
- [Overture Maps Foundation](https://overturemaps.org/) — open map data.

### Data, formats, and analysis

- [DuckDB](https://duckdb.org/) and [DuckDB-WASM](https://github.com/duckdb/duckdb-wasm) with the **Spatial** extension — in-browser spatial SQL and vector conversion.
- [Apache Sedona](https://sedona.apache.org/) and [PGlite](https://pglite.dev/) (with PostGIS) — additional in-browser SQL engines.
- [Turf.js](https://turfjs.org/) — client-side vector geometry tools.
- [GDAL/OGR](https://gdal.org/), [GeoTIFF.js](https://geotiffjs.github.io/), [proj4js](https://github.com/proj4js/proj4js), [shpjs](https://github.com/calvinmetcalf/shapefile-js), and [FlatGeobuf](https://flatgeobuf.org/) — geospatial data formats and reprojection.
- [GeoParquet](https://geoparquet.org/) and the [Apache Arrow](https://arrow.apache.org/) / Parquet ecosystem.
- [STAC](https://stacspec.org/) — the SpatioTemporal Asset Catalog specification and tooling.
- [Zarr](https://zarr.dev/) and [CarbonPlan](https://carbonplan.org/) — cloud-native multidimensional array access.
- [H3](https://h3geo.org/) — hexagonal hierarchical spatial indexing.

### Python sidecar and notebooks

- [FastAPI](https://fastapi.tiangolo.com/), [rasterio](https://rasterio.readthedocs.io/), [GeoPandas](https://geopandas.org/), [Shapely](https://shapely.readthedocs.io/), and [pyproj](https://pyproj4.github.io/pyproj/) — the optional Python sidecar.
- [WhiteboxTools](https://www.whiteboxgeo.com/) — the Whitebox geoprocessing toolbox.
- [segment-geospatial (SamGeo)](https://github.com/opengeos/segment-geospatial) and Meta AI's [Segment Anything](https://segment-anything.com/) — AI segmentation.
- [Jupyter](https://jupyter.org/), [JupyterLite](https://jupyterlite.readthedocs.io/), [Pyodide](https://pyodide.org/), and [anywidget](https://anywidget.dev/) — the embedded notebook experience.
- [leafmap](https://leafmap.org/) — the API style and inspiration for the `geolibre` Python package.

### App framework and UI

- [Tauri](https://tauri.app/) — the cross-platform desktop and mobile shell.
- [React](https://react.dev/), [Vite](https://vite.dev/), and [TypeScript](https://www.typescriptlang.org/).
- [Zustand](https://github.com/pmndrs/zustand) — application state management.
- [Radix UI](https://www.radix-ui.com/), [shadcn/ui](https://ui.shadcn.com/), [Tailwind CSS](https://tailwindcss.com/), and [Lucide](https://lucide.dev/) — UI primitives and icons.
- [react-i18next](https://react.i18next.com/) — internationalization.

The **Atmospheric Effects** plugin (deep-space backdrop, parallax starfield,
comets, and the globe atmosphere halo) adapts the technique and visual design
from [Leonel Dias](https://leoneljdias.github.io/)'s article
[*Globe atmosphere, halo, and comets*](https://leoneljdias.github.io/posts/globe-atmosphere-halo-comets/) —
the layered Canvas 2D approach, the halo gradient and "screen" blend, the
limb-sampling that keeps the halo aligned under pitch, and the starfield/comet
parameters.

## Community contributors

GeoLibre is shaped by the people who try it, report bugs, request features, and
help others get started. Thank you to everyone who has opened an issue, started
a discussion, or shared GeoLibre with their community.

- [**Ryanphoenix**](https://github.com/Ryanphoenix) — for many valued
  contributions to the project, including issue reports, feedback, and
  improvements.

### Beta testers

- [**René van der Velde**](https://github.com/renevandervelde), Netherlands — an experienced QGIS practitioner who has
  championed GeoLibre as an approachable entry-level to mid-tier GIS option and
  contributed thoughtful, detailed bug reports and feature requests during early
  testing.

## Get involved

Want to see your name here? Contributions of every size are welcome — from
filing a well-described bug report to writing a plugin. See the
[Contributing guide](contributing.md) to get started.
