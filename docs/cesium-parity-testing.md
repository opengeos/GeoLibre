# Cesium parity implementation and test plan

Review baseline: `73bcb847`, September 6, 2026. The open issues are tracked by
[#2259](https://github.com/opengeos/GeoLibre/issues/2259). An open tracker is not
proof that every requirement remains missing: feature picking has landed, and
plugin engine declarations and menu gating have also landed.

## First implementation batch

| Issue | Change | Verification |
| --- | --- | --- |
| [#2275](https://github.com/opengeos/GeoLibre/issues/2275) | Ground cursor coordinates, optional elevation, ellipsoid fallback, and cleanup | Engine tests cover signed height, sky, fallback, morphing, and destruction; interaction tests cover store updates, preference changes, exit, and queued events; browser checks cover both themes and renderer swaps |
| [#2279](https://github.com/opengeos/GeoLibre/issues/2279) | Field/expression labels, text size and color, halos, line/polygon anchors, zoom limits, opacity | Real Cesium graphics tests and a real US cities GeoJSON layer in the running app |
| [#2291](https://github.com/opengeos/GeoLibre/issues/2291) | Projection follows the scene mode; native controls move between host corners, and a remount restores each control's last visibility and corner | Scene-mode tests, DOM lifecycle tests, hidden-control position restoration, remount tests, and browser fullscreen checks after moving the control |

The baseline browser reproduction of #2275 left the status bar at `Coords: —`
while pointing at the globe. The corrected browser reports longitude/latitude
and clears the readout on exit. The real US cities dataset produces 109 entities
and 109 labels. Label collision avoidance and the advanced label data-defined
appearance fields are outside this batch, and so are the `LabelStyle` placement
fields the globe does not read yet: `anchor`, `rotation`, `placement` (line
placement along a path), `maxWidth`, and `allowOverlap`. A label styled with
them on the 2D map renders centred and unrotated on the globe; #2279 is not
complete until they are honoured. Scene-mode persistence is also not added
here; #2291 describes it as a possible follow-up.

## Remaining work and ordering

| Issues | Next work | Required evidence |
| --- | --- | --- |
| #2276 | Implemented manual placement and shared extent drawing | Real pin drag and Done, rectangle drawing and Escape in both themes, renderer swaps, and Esri World Imagery extraction to a 22×12 EPSG:4326 GeoTIFF with nonconstant pixels; unit coverage includes antimeridian extents, pointer ownership, sky release, blur, and cancellation |
| #2277 | Engine-neutral capture, readiness, viewport/extent printing, video and tour recording | Nonblank 872×648 PNG; real print PNG; 11.6 s H.264 recording at 872×648; two-stop VP9 WebM tour; failed-layer and renderer-destruction capture tests. Atlas masks and map-series camera fitting retain their MapLibre gate. |
| #2278 (implemented) | Shared per-feature style evaluation | Real Natural Earth countries categorized by continent and populated places sized proportionally by population rendered on the globe and compared with the 2D map in both themes; unit tests evaluate the real core expressions for single, categorized, graduated, rule-based (with per-rule radius/width/colour/opacity overrides and the else rule), expression (including the invalid-expression fallback), proportional size, metre-unit strokes (zoom re-resolution), and simplestyle; layer-sync tests cover per-entity baking, point-to-circle conversion, in-place opacity restyle versus reload |
| #2280 (merged in #2298) | Filters, shared timeline, story opacity | Composed filters narrow together; clearing restores features; fades restore latest styles without mutating the project |
| #2281 (merged in #2299) | Extrusion and Z geometry | Known-height buildings and elevation profiles; scale/base/offset checks and terrain interactions |
| #2282 (implemented for points) | Clustering and large-vector primitives | Real populated-places clustering on the globe with counts and the `clusterMaxZoom` cutoff, and a 60k-point layer as one primitive batch, verified in both themes; unit tests cover the plan (point-only, markers, elevation, threshold), count abbreviation, bubble sizes, the cluster handler and refresh, batch building with feature refs, picking, quick filters, in-place opacity, removal, and the zoom toggle. Batched ground polygons and lines are not part of this pass (see #2311) |
| #2283 (implemented) | Raster protocol bridge | Real UC Berkeley COG (RGB, EPSG:3857) rendered pixel-identical to the 2D map, and a real raster PMTiles archive (Protomaps Terrarium z9) draped on the globe in both themes; unit tests cover template expansion, the registry path through a real `addProtocol` handler, back-pressure, destruction, empty tiles, the COG state-to-tiler mapping with automatic percentile stretch, the PMTiles header bounds, TMS templates, the unregistered-scheme error, and the raster symbology mapping. MBTiles and the native XYZ fetcher share the registry path and are desktop-only, so they are covered by the routing tests rather than the browser run. |
| #2284 | Hybrid native/drape vector-tile path | Real MVT/PMTiles/ArcGIS tiles, adjacent-tile seams, picking, style changes, cancellation, and bounded rendering resources |
| #2285 | Native I3S, point clouds, splats; deck.gl gating | Real public sources for each supported format, resource disposal, picking, and accurate unsupported-layer badges |
| #2286 (implemented) | Keyless and COG terrain | Real Mount Rainier Terrarium relief (~4,315 m), local DEM sample (835 m versus 839 m source pixel after grid resampling), shared tile edges, source replacement, and both themes |
| #2287 (implemented) | Native environment plugins | Sun clock and lighting on/off, atmosphere/sky box on/off and restore, spin start/stop, cloud imagery add/remove, and flight take-over/teardown verified in the real app in both themes; unit tests cover each Cesium branch against the real Cesium maths with a faked widget |
| #2288, #2262 | Enforce declared support in activation, URL dispatch, project restore, delayed controls, and command palette | Tests cover unsupported callbacks, renderer round trips, saved settings, and compatible-control remounting. The wider control facade and native plugin implementations remain separate work. |
| #2289 | Python/MCP/embed renderer authoring | Project round trips, renderer events, pane kinds, invalid inputs, and docs examples |
| #2290 | Cesium-native authoring features | Separate real-data verification for Ion, tileset styling, clipping, KML/CZML, and terrain sampling |
| #2261, #2259 | Update umbrella completion only after child requirements are verified | Accurate supported-layer predicates and an explicit record of remaining gaps |

## Test gates

1. Reproduce the missing behavior in the real app before changing it.
2. Add focused tests at the engine boundary. Use actual Cesium math and graphics
   where possible; mock only the browser/GPU lifecycle that Node cannot provide.
3. Exercise the app in both themes with real geospatial data. Verify the visible
   result as well as store/engine state, and test switching back to MapLibre.
4. Run relevant existing suites, the production build, lint, and formatting hooks.
5. Keep tracking issues open until all child requirements are complete. Do not
   advertise a new capability or supported layer kind before its workflow works.

Catalog audit: Source Coop, Open Data Catalogs, and ArcGIS Hub already declare
both engines. STAC explicitly retains MapLibre dependencies for footprint
picking. Planetary Computer and NASA Earthdata read their controls’ map;
Hugging Face delegates file loading to the vector/raster controls. These are
not automatically safe to ungate based on their catalog UI alone.

Keyless globes now use Mapzen Terrarium heightmaps; an Ion token selects World Terrain. Controls → Terrain exaggeration accepts local and HTTP COG DEMs on either renderer. Shared edge samples avoid cracks between heightmap tiles; requests and tile caches are bounded and disposed with the source.
