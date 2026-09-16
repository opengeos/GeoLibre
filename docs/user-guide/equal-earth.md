# Equal Earth overview

Choose **Controls → Equal Earth overview** to view the world in an equal-area
projection. Drag to pan; use the mouse wheel, double-click, or the focused map's
arrow and `+`/`-` keys to navigate. **Open detailed map** switches to zoom 3.

Below zoom 3, GeoLibre displays bundled Natural Earth country boundaries and
available GeoJSON vector layers. At zoom 3 and above, the regular Mercator map
returns with your selected basemap and all its layers. Zooming out restores the
overview. Select the menu item again to return to Mercator at every zoom level,
or use the globe button to switch to the globe.

The overview follows layer visibility, group opacity, basic point/line/polygon
styles, thematic fill colors, and feature filters. Original geographic data stays
unchanged for analysis, saving, and export. The mode is saved with the project
and follows the shared projection preference in secondary 2D map panes.

## Limitations

The overview is a separate display, not native Equal Earth support in MapLibre.
Raster imagery, vector tiles, terrain, plugin overlays, labels, advanced symbols,
and editing remain available in the detailed map. A notice identifies when some
visible layers have no GeoJSON data available to the overview. The overview
blocks map editing, picking, and measurement gestures to avoid interpreting
Equal Earth pixels as Mercator positions.

Image capture and full-view Print Layout capture use the overview pixels. Clear
any geographic print extent before printing the overview; extent cropping is
available on the detailed map. The print scale is measured horizontally at the
capture center. Standalone story-map HTML uses Mercator.

## Dependencies and data

The overview lazily loads the small `d3-geo` module and a bundled public-domain
Natural Earth 1:110m country dataset. It needs no API key, tile service, replacement
map renderer, or additional WASM runtime. D3 handles curved paths, polygon holes,
and clipping at the antimeridian. The bundled basemap is available offline.
