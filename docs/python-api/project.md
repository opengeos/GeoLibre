# project

The `geolibre.project` package builds `.geolibre.json` projects and their
layers. Every name below is also importable from `geolibre.project` directly.
Each name is defined in one submodule, so code that monkeypatches a module
global (in tests, say) must patch it on that submodule, for example
`geolibre.project.fetch._assert_public_url`; patching the re-export on
`geolibre.project` does not reach the submodule's own references.

::: geolibre.project

## Core layer builders

::: geolibre.project.layers
    options:
      heading_level: 3

## Raster layers

::: geolibre.project.raster
    options:
      heading_level: 3

## OGC and ArcGIS services

::: geolibre.project.services
    options:
      heading_level: 3

## 3D, point cloud and Cesium layers

::: geolibre.project.scene
    options:
      heading_level: 3

## Popups and tooltips

::: geolibre.project.popups
    options:
      heading_level: 3

## Marker and label styles

::: geolibre.project.styles
    options:
      heading_level: 3

## Filter expressions and floor levels

::: geolibre.project.expressions
    options:
      heading_level: 3

## Layer metadata

::: geolibre.project.metadata
    options:
      heading_level: 3

## Plugin state

::: geolibre.project.plugins
    options:
      heading_level: 3

## Story maps and bookmarks

::: geolibre.project.story
    options:
      heading_level: 3

## Dashboards and print layouts

::: geolibre.project.layout
    options:
      heading_level: 3

## Credential redaction

::: geolibre.project.credentials
    options:
      heading_level: 3

## Remote GeoJSON

::: geolibre.project.fetch
    options:
      heading_level: 3
