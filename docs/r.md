# R package

[![R-CMD-check](https://github.com/opengeos/geolibre-r/actions/workflows/R-CMD-check.yaml/badge.svg)](https://github.com/opengeos/geolibre-r/actions/workflows/R-CMD-check.yaml)

The **`geolibre`** R package embeds the full GeoLibre map in RStudio, Quarto,
R Markdown, and Shiny through [`htmlwidgets`](https://www.htmlwidgets.org/).
It creates standard `.geolibre.json` projects, so maps can move between R and
the GeoLibre web or desktop application.

[View the R package website](https://r.geolibre.app/){ .md-button .md-button--primary }
[Open the interactive example](https://r.geolibre.app/articles/interactive-map.html){ .md-button }
[Browse the source](https://github.com/opengeos/geolibre-r){ .md-button }

## Installation

The package is currently available from GitHub while its first CRAN submission
is prepared:

```r
install.packages("pak")
pak::pak("opengeos/geolibre-r")
```

After it is published on CRAN, install the released version with:

```r
install.packages("geolibre")
```

## Quick start

Create an interactive map from GeoJSON and set its initial camera:

```r
library(geolibre)

places <- list(
  type = "FeatureCollection",
  features = list(list(
    type = "Feature",
    properties = list(name = "Washington, DC"),
    geometry = list(
      type = "Point",
      coordinates = c(-77.0369, 38.9072)
    )
  ))
)

geolibre(map_only = TRUE) |>
  add_geojson(
    places,
    name = "Places",
    style = list(fillColor = "#dc2626", circleRadius = 8)
  ) |>
  set_view(center = c(-77.0369, 38.9072), zoom = 10)
```

The widget is responsive in the RStudio Viewer and rendered HTML documents.
Its map loads the hosted GeoLibre application, so viewing it requires an
internet connection unless `app_url` points to a self-hosted deployment.

## Spatial data with `sf`

`add_sf()` accepts an `sf` object and transforms it to WGS 84 before passing
GeoJSON to the browser:

```r
library(sf)

nc <- st_read(system.file("shape/nc.shp", package = "sf"), quiet = TRUE)

geolibre() |>
  add_sf(nc, name = "North Carolina counties")
```

The `sf` package is optional. On Linux, installing it may require system
libraries such as GDAL, GEOS, PROJ, and UDUNITS.

## Remote rasters

GeoLibre reads remote Cloud Optimized GeoTIFFs directly in the browser. The
server hosting the raster must support CORS and HTTP range requests.

```r
geolibre() |>
  add_raster(
    "https://example.org/visual.tif",
    name = "Satellite image",
    bands = c(1, 2, 3)
  )
```

## Project files

Save the widget state as a portable GeoLibre project and restore it later:

```r
map <- geolibre() |> add_geojson(places)
save_project(map, "example.geolibre.json")

restored <- geolibre(load_project("example.geolibre.json"))
```

The saved project can also be opened in GeoLibre Web or GeoLibre Desktop. In a
Shiny application, browser-side changes are available through
`input$<outputId>_project`.

## Shiny

Use `geolibreOutput()` and `renderGeolibre()` to render a map. A proxy updates
the live widget without rebuilding the output:

```r
library(shiny)
library(geolibre)

ui <- fluidPage(
  geolibreOutput("map", height = "80vh"),
  actionButton("reset", "Reset view")
)

server <- function(input, output, session) {
  map <- reactiveVal(geolibre(map_only = TRUE))
  output$map <- renderGeolibre(map())

  observeEvent(input$reset, {
    next_map <- set_view(map(), center = c(0, 20), zoom = 2)
    map(next_map)
    update_geolibre(geolibre_proxy("map"), next_map)
  })
}

shinyApp(ui, server)
```

## Self-hosting

Set a custom GeoLibre application URL for one widget or for the R session:

```r
geolibre(app_url = "https://gis.example.org/")

options(geolibre.app_url = "https://gis.example.org/")
```

The deployment must expose the GeoLibre web app and its `?embed=1` project
bridge. See the [package reference](https://r.geolibre.app/reference/) for the
complete API.
