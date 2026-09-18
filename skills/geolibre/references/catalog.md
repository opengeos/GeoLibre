# Catalog: basemaps, ramps, formats, embedding

`list_catalog` (MCP) is the authoritative, always-current version of the first
three sections. This page is for when you need the names without a round trip.

## Basemaps

Named MapLibre vector styles, accepted by `set_basemap` / `Map.set_basemap`:

| Name | Look |
| --- | --- |
| `liberty` | The default. Full-detail OpenStreetMap cartography. |
| `bright` | Lighter, higher-contrast general-purpose style. |
| `positron` | Muted grey — the right choice under a choropleth or any data layer. |
| `dark` | Dark background, for bright data and night-mode pages. |
| `fiord` | Desaturated blue-grey. |

A full MapLibre style JSON URL works anywhere a name does.

**Raster basemaps are not basemaps here.** OpenStreetMap raster tiles, Esri
imagery, and any `{z}/{x}/{y}` service are *layers*: add them with
`add_tile_layer` at `index=0`, with an `attribution`.

## Color ramps

Accepted by `classify_layer`, `add_colorbar`, `Map.add_choropleth`, and
`add_raster_layer(colormap=...)`:

`viridis` · `plasma` · `inferno` · `magma` · `cividis` · `turbo` · `spectral` ·
`blues` · `greens` · `oranges` · `reds` · `purples` · `terrain` · `rdylgn` ·
`rdylbu` · `rdbu` · `coolwarm` · `jet` · `greys` · `gray`

**The colorbar control renders a narrower set.** Layer symbology
(`classify_layer`, `Map.add_choropleth`) honors every name above, but the on-map
colorbar is drawn by `maplibre-gl-components`, whose named-ramp table is
case-sensitive and does not include `blues`, `greens`, `oranges`, `reds`,
`purples`, `greys`, `rdylgn`, `rdylbu`, or `rdbu` — those silently draw as
viridis. When the colorbar has to match a layer styled with one of them, pass
explicit stops instead of a name:

```text
add_colorbar(path=..., colors=["#eff6ff", "#93c5fd", "#2563eb", "#1e3a8a"],
             vmin=0, vmax=10000000, label="Population")
```

Rules of thumb: sequential (`blues`, `viridis`) for a quantity that runs low to
high; diverging (`rdbu`, `coolwarm`, `spectral`) only when there is a meaningful
midpoint such as zero or an average; `terrain` for elevation. Avoid `jet` for
anything quantitative — it invents boundaries that aren't in the data.

## Legend presets

`add_legend(builtin=...)`:

| Preset | Title |
| --- | --- |
| `nlcd` | NLCD Land Cover (20 classes, official color table) |
| `esa_worldcover` | ESA WorldCover (11 classes) |

`esa`, `worldcover`, `esa_world_cover`, and `nlcd_land_cover` are accepted
aliases.

## Classification schemes

`equal-interval` splits the value range into even bands — good when the values
are roughly uniform, bad when a few outliers stretch the range and flatten
everything else into one class. `quantile` puts an equal count of features in
each class — good for skewed data such as population or income, but the class
widths then vary, so the legend must show the breaks.

## Layer types

`geojson`, `xyz`, `raster`, `wms`, `vector-tiles`, `mbtiles`, `arcgis`,
`pmtiles`, `cog`, `flatgeobuf`, `zarr`, `lidar`, `gaussian-splat`, `geoparquet`,
`duckdb-query`, `3d-tiles`.

## Data formats

| Format | How it gets in |
| --- | --- |
| GeoJSON | Directly, inlined or by URL |
| GeoParquet | DuckDB-WASM in the browser; imported as GeoJSON from a local file |
| FlatGeobuf | Read in place, or imported as GeoJSON |
| Shapefile (`.zip`) | Converted in-browser (`shpjs`, DuckDB fallback) |
| GeoPackage, KML/KMZ, GPX, CSV, delimited text | Converted on import |
| COG / GeoTIFF | `cog` layer, rendered on the GPU or through a tiler |
| PMTiles, MBTiles | Tiled sources (MBTiles is desktop-only, via a local protocol) |
| WMS, WMTS, WFS | OGC service layers |
| ArcGIS FeatureServer / MapServer / ImageServer / VectorTileServer | Native support |
| Zarr, LiDAR (COPC/LAZ), 3D Tiles, Gaussian splats | Through the bundled plugins |

Everything renders from WGS84 lon/lat. Reproject before adding if your source is
in a projected CRS.

## Viewing and embedding a finished project

The browser build is hosted at <https://web.geolibre.app/>. It runs entirely
client-side.

| Parameter | Example | Effect |
| --- | --- | --- |
| `url` | `?url=https://.../project.geolibre.json` | Load a project from a public URL |
| `data` | `?data=https://.../places.geojson` | Load public GeoJSON/GeoParquet/PMTiles/COG directly |
| `style` | `?style=https://.../sample.style.json` | Apply a style to the `data` layer |
| `layout` | `?layout=viewer` | `viewer` (read-only chrome) or `compact` (icon-only) |
| `maponly` | `?maponly` | Map only — no toolbar, panels, or status bar |
| `toolbar` / `panels` | `?toolbar=none&panels=collapsed` | Trim individual chrome |
| `theme` | `?theme=dark` | Force a color theme |
| `locale` / `lang` | `?lang=zh` | Set the UI language |

Combine freely: `?url=<project>&maponly&theme=dark` is a clean embed.

`url=` and `data=` are fetched by the **browser**, so the target must be public
or same-origin — a login-gated URL will not load in the hosted viewer, because
the cookie is not sent cross-origin.

For programmatic control of a live embedded instance, use `@geolibre/embed`, the
typed iframe client published to npm. See
<https://geolibre.app/user-guide/embedding/>.

## Other surfaces, for orientation

- **Sidecar** (`backend/geolibre_server`, FastAPI on `127.0.0.1:8765`) — optional
  Python service behind the Whitebox toolbox, format conversion, and rasterio
  raster tools. Not needed to author a project.
- **AI Assistant** — the app's own in-panel chat, which acts through the app's
  store so its edits are undoable. A different thing from this skill.
- **Processing** — ~800 Whitebox WASM tools plus a client-side Turf.js registry,
  reachable from Python via `Map.run_algorithm` / `Map.run_whitebox_tool` in a
  notebook.
