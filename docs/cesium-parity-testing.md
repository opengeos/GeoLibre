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
| [#2291](https://github.com/opengeos/GeoLibre/issues/2291) | Projection follows the scene mode; native controls move between host corners | Scene-mode tests, DOM lifecycle tests, hidden-control position restoration, and browser fullscreen checks after moving the control |

The baseline browser reproduction of #2275 left the status bar at `Coords: —`
while pointing at the globe. The corrected browser reports longitude/latitude
and clears the readout on exit. The real US cities dataset produces 109 entities
and 109 labels. Label collision avoidance and the advanced label data-defined
appearance fields are outside this batch. Scene-mode persistence is also not
added here; #2291 describes it as a possible follow-up.

## Remaining work and ordering

| Issues | Next work | Required evidence |
| --- | --- | --- |
| #2276 | Manual placement and shared extent drawing | Real pointer drag, cancellation, camera-input restoration, antimeridian extent, and raster-subset workflow |
| #2277 | Engine-neutral capture, readiness, printing, and recording | Nonblank exported pixels, tile/tileset readiness, print output, recorded frames, and renderer teardown during capture |
| #2278 | Shared per-feature style evaluation | Classified/rule/expression examples compared with MapLibre; invalid-expression fallback; live changes |
| #2280 | Filters, shared timeline, story opacity | Composed filters narrow together; clearing restores features; fades restore latest styles without mutating the project |
| #2281 | Extrusion and Z geometry | Known-height buildings and elevation profiles; scale/base/offset checks and terrain interactions |
| #2282 | Clustering and large-vector primitives | Cluster counts and zoom thresholds, feature picking, mixed geometry, removal, and measured performance on 50k+ features |
| #2283 | Raster protocol bridge | Actual COG, DEM, raster PMTiles, and MBTiles; cancellation, errors, bounds, tile levels, and symbology |
| #2284 | Hybrid native/drape vector-tile path | Real MVT/PMTiles/ArcGIS tiles, adjacent-tile seams, picking, style changes, cancellation, and bounded rendering resources |
| #2285 | Native I3S, point clouds, splats; deck.gl gating | Real public sources for each supported format, resource disposal, picking, and accurate unsupported-layer badges |
| #2286 | Keyless and COG terrain | Known elevations, tile boundaries, source replacement, exaggeration, missing tiles, and keyless browser checks |
| #2287 | Native environment plugins | Sun/time changes, atmosphere, spin stop/start, cloud cleanup, and flight input/teardown in both themes |
| #2288, #2262 | Audit remaining plugin compatibility requirements against merged engine declarations | Activation and renderer swaps must not leave orphan controls; command palette and menus must agree |
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
