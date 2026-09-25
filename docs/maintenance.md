# Maintenance Notes

This page collects the repository rules that are easy to break **silently** —
hand-written mirrors of unexported upstream constants, coverage and audit gates,
publishing layouts, and generated files. `CLAUDE.md` links here rather than
restating any of it.

If you are just getting set up, read [Contributing](contributing.md) first.

## Dependency bumps that need a manual check

Several features depend on values or DOM contracts that upstream packages do not
export, so GeoLibre mirrors them by hand. Drift usually produces **no build
error** — the feature just stops working. After bumping any of the packages
below (**including Dependabot PRs**), do the listed check and run the frontend
suite.

### `geolibre-wasm` (`packages/processing/package.json`)

- **Processing menu catalog.** `ProcessingMenu.tsx` renders from a checked-in,
  auto-generated catalog, `apps/geolibre-desktop/src/lib/whitebox-menu-catalog.ts`
  (do not hand-edit). Run `node scripts/gen-whitebox-menu-catalog.mjs` and commit
  the result, or new/renamed WASM tools silently miss the menu. The Processing
  *dialog* lists tools dynamically, so the gap only shows in the menu. Whitebox
  translations are optional external packs in `opengeos/geolibre-language-packs`,
  not entries generated into GeoLibre's bundled locale JSON.
- **`MAX_VECTOR_PMTILES_ZOOM`** (`packages/processing/src/wasm-convert.ts`)
  mirrors the deepest zoom `vector_to_pmtiles` accepts (18 — past it the tool
  exits with `validation error: max_zoom must be <= 18`). The cap lives inside
  the WASM binary and is not exported. If it drifts, the browser's Vector to
  PMTiles either refuses a zoom the tiler would now accept, or accepts one it
  will reject after the user has waited. This is **not** the sidecar's cap:
  freestiler allows 24 (`MAX_PMTILES_ZOOM` in `ConversionDialog.tsx`, mirroring
  `backend/geolibre_server/geolibre_server/app/conversion.py`), and the dialog
  validates against whichever engine is about to run.
  `tests/wasm-convert.test.ts` fails if the mirror drifts.
- **`DISTANCE_SEGMENTS` / `NON_DISTANCE_NAMES`**
  (`apps/geolibre-desktop/src/lib/whitebox-distance-params.ts`) decide, by
  parameter *name*, which Whitebox parameters are ground distances and so get the
  Processing dialog's metric unit picker (GeoLibre#1540). The segments are
  generic (`tolerance`, `radius`, `length`, `resolution`), so a tool can carry a
  matching name that is not a length — `corridor_tolerance` is a 0–1 fraction.
  Those are safe today only because the picker is confined to tools whose every
  dataset input is a vector layer, and the colliding names happen to sit on
  imagery/LiDAR tools; that is a coincidence, not a guarantee. Scan the new
  catalog for a `double` matching the rule whose description reads as a fraction,
  ratio, angle or weight, and add it to `NON_DISTANCE_NAMES`. If one is missed,
  that tool's field offers metres and silently converts a dimensionless number as
  if it were a distance.

### `maplibre-gl`

- **`GLOBE_CONTROL_TOGGLE_SELECTOR`** (`packages/map/src/globe-control-toggle.ts`)
  mirrors the class names MapLibre's own `GlobeControl` puts on its toggle button
  — `maplibregl-ctrl-globe` and `maplibregl-ctrl-globe-enabled`, swapped on every
  projection change. `MapCanvas` persists a projection change from a **click** on
  that button rather than from the `projectiontransition` event, because style
  initialization and project reconciliation emit that event too and a stale one
  overwrites the projection of a project that has just loaded.
  `tests/globe-control-toggle.test.ts` builds a real `GlobeControl` and fails if
  the mirror stops matching.
- **Per-layer blend modes** (`packages/map/src/layer-blend-modes.ts`) wrap three
  *unexported* `maplibre-gl` internals, because MapLibre renders every layer into
  one canvas and ships no per-layer blend API (upstream draft:
  maplibre/maplibre-gl-js#8073). The wrappers are `Painter.prototype.renderLayer`
  (brackets one layer's draws), `Painter.prototype.useProgram` (tells the
  layer-opacity composite draw from the draws feeding it), and
  `Context.prototype.setColorMode` (the single place every draw resolves GL blend
  state). Fill and line layers additionally get `fill-layer-opacity` /
  `line-layer-opacity` pinned just under 1 by `style-mapper`, which elects
  MapLibre 6's render-to-texture composite so a layer blends **as a whole** rather
  than once per overlapping polygon. `installLayerBlendModes` feature-detects
  every seam and disables the feature (hiding the Style-panel control) rather than
  breaking the map, so drift fails *quietly* — which is why
  `tests/layer-blend-modes.test.ts` asserts the seams and
  `e2e/blend-modes.spec.ts` asserts real pixels. Run both on a bump.

  See [Adding a blend mode](#adding-a-blend-mode) before extending the list.
- **`DEFAULT_MARKER_OFFSET_Y`**
  (`apps/geolibre-desktop/src/components/storymap/storymap-engine.ts`) mirrors the
  `-14` px vertical offset `maplibregl.Marker` applies to its default pin.
  `createStoryMapMarker` (also reused by Field Collection's capture marker in
  `apps/geolibre-desktop/src/lib/field-collection-map.ts`) positions that pin by
  hand on every engine (Mapbox, Cesium, ArcGIS, and MapLibre alike), so if a bump changes the default pin's
  anchor or offset, story markers drift off their coordinate with no error.
  Compare with `defaultMarker.ts`/`marker.ts` upstream and play a story on a
  non-MapLibre renderer.

### `@deck.gl/mapbox` and `@deck.gl/maplibre`

`bridgeArcgisDeckControl` (`packages/plugins/src/plugins/arcgis-deck/control-adapter.ts`)
reads each overlay's private `_props` field so ArcGIS can transfer its initial
layers into a native `ArcgisDeckOverlay` without mounting the MapLibre control.
The cast hides upstream changes from TypeScript. After either deck.gl package is
bumped, run `tests/arcgis-control-adapters.test.ts` and confirm the overlay still
exposes `_props` with the initial `DeckProps` object.

### `@loaders.gl/tiles` (via `@deck.gl/geo-layers`) — tile cache cap

`applyThreeDTilesTilesetMemoryLimit` (`packages/plugins/src/plugins/arcgis-i3s-tiles.ts`)
works around `Tileset3D` trimming its tile cache against a `maximumMemoryUsage`
field it never copies from the load options, so the cap stays at 32 MB and
every camera move evicts the tiles just drawn (issue #2560). The same PR turned
`memoryAdjustedScreenSpaceError` off because it ratchets the level of detail
down once that cache fills. After bumping deck.gl or loaders.gl, run
`tests/arcgis-i3s-tiles.test.ts`: its real-`Tileset3D` case fails if the field
is renamed or no longer starts at 32 MB. If upstream starts honouring the
option, the helper can go.

### `@maplibre/maplibre-gl-style-spec`

`propertySpecFor` (`packages/core/src/expressions.ts`) fabricates the
**unexported** `StylePropertySpecification` shape that `createExpression` uses for
expected-result-type enforcement (the Expression Builder's filter → boolean /
color checks). The cast hides any contract change from the compiler, so run the
frontend suite — the "enforces an expected result type" test in
`tests/expressions.test.ts` fails if the shape stops being honored.

`cssColor` (`packages/map/src/cesium-feature-style.ts`) turns the `Color`
object a compiled colour expression evaluates to into CSS by reading its
`toString()` and accepting an `rgba(` or `#` prefix. That format is how the
spec's `Color` happens to print, not a documented contract: if a bump changes
it, the globe silently paints every classified feature the flat fallback colour
rather than failing. The "classifies by a categorical field" test in
`tests/cesium-feature-style.test.ts` goes through a real compiled expression,
so run the frontend suite after a bump and re-verify a categorized layer on the
globe.

`SPEC_DEFAULT_COLOR` (`packages/map/src/mapbox-style-import.ts`) mirrors the
spec's `default` for `fill-color`, `line-color` and `circle-color` — `#000000`
for all three — which is the colour a stacked class layer naming none is
imported as.
It is hard-coded rather than read from the spec because `@geolibre/map` is a
published package and does not depend on it (only `packages/core` does). The
frontend suite guards both directions: a test in
`tests/mapbox-style-import.test.ts` asserts the spec still says
`SPEC_DEFAULT_COLOR`, and the behavioural tests beside it assert an imported
colourless class renders that colour, so a change to either side fails.

`COLOR_OVERRIDING_PAINT` in the same file mirrors the other half of that
lookup: the paint properties that draw the feature themselves, so that the
colour default does not apply. The spec encodes it as `line-color`'s
`requires: [{ "!": "line-pattern" }]`, which the same test asserts. `fill-pattern`
and `line-gradient` are listed for the same reason but the spec does not encode
it, so only the `line-pattern` entry is a mirror a test can guard; the other two
rest on how MapLibre renders them. A class using any of them is not imported as
black — it declines the stack.

### Web Services control packages (`packages/plugins/package.json`)

- **Docked panel DOM bridge.** `dockable-map-control.ts` adapts
  `maplibre-gl-fema-wms`, `maplibre-gl-nasa-earthdata`,
  `maplibre-gl-enviroatlas`, and `maplibre-gl-national-map` by calling the
  control lifecycle directly and moving the panel element that `onAdd()`
  appends to the map container into GeoLibre's native right-panel host. Vantor
  returns a wrapper instead, so the bridge selects its `.vantor-panel`
  descendant. The scoped CSS in `index.css` mirrors each package's panel,
  header, toggle, close, and resize-handle class names. After bumping any of
  these packages, activate every migrated Web Services plugin and verify that
  its catalog renders, resizing the GeoLibre dock preserves the content, and
  no vendor panel remains under the map container.

### `maplibre-gl-components` (`packages/plugins/package.json`)

- **`MAP_PANEL_SELECTOR`**
  (`apps/geolibre-desktop/src/components/layout/RecordVideoDialog.tsx`) mirrors
  the **rendered** control class names — `maplibre-gl-html-control`,
  `maplibre-gl-legend`, `maplibre-gl-colorbar` — so Record Video's "Include map
  panels" option can rasterize those on-map overlays into the recording. These are
  the display elements, deliberately **not** the `*-gui-control` authoring
  editors. If a class drifts, the option silently stops burning that panel into
  the video (or the checkbox never appears) with no build error.
- **The PMTiles control's layer ids** (`pmtilesControlLayerId` /
  `pmtilesIdsForSourceLayers` / `pmtilesIdNamesSourceLayer`,
  `packages/map/src/pmtiles-layer.ts`, read from `layer-sync.ts` and
  `packages/plugins/src/plugins/maplibre-components.ts`) mirror an unexported fact
  about `PMTilesLayerControl`: it names its MapLibre layers
  `${sourceId}-${name}-${kind}` from the **raw** source-layer name, where
  `pmtilesVectorLayerId` percent-encodes it. The two agree for every name needing
  no encoding, so a store layer carrying the control's own ids — the archive kept
  whole, or a split part, which keeps the ids naming its own source layer — is
  recognised under the encoded scheme alone until a name holds a `/`, a space or
  non-ASCII. Then `layer-sync` decides the source layer has no native layer and
  adds a **second** fill/line/circle trio on top of the control's: drawn twice,
  and only the control's copy answers the panel. Both schemes are therefore
  matched, and only ids naming a source layer the store actually holds are kept.

  What the user **ticked** is deliberately *not* inferred from those ids:
  `selectedSourceLayers` is a documented field of the exported
  `PMTilesLayerControlState` handed to every handler, so `pmtilesLayerOptions`
  reads it and the compiler checks it — the rules for a stale selection, and for
  the archive ids the control reuses across a panel close, are written at that
  function and at `addPMTilesArchive`. A reused id is the one case GeoLibre cannot
  repair: two archives then name one MapLibre source, the first to sync wins it
  and the other draws nothing, so `addPMTilesArchive` warns rather than pretending
  otherwise — while an archive that takes a layer over outright is drawn
  correctly, keeping the name, folder and styling of the one it replaced.
  `tests/pmtiles-control-contract.test.ts` drives a **real** control against a
  real archive, through the real `layeradd` handler into the store, and fails if
  the id scheme moves or the selection stops reaching the handler.

- **The MeasureControl's `_panel` and `_sourceId`**
  (`packages/plugins/src/plugins/terrain-measure.ts`, via `measurePanelElement`
  and `measureSourceId`) are private members that only the control knows: the
  panel carries GeoLibre's Terrain (3D)/heading sections and the resize styling,
  and the source id is how `lidar-measure-mirror.ts` finds the geometry it
  redraws above a LiDAR point cloud (#2533). Both readers warn and fall back to
  doing nothing on a rename, so after a bump check the console for
  "MeasureControl: …not found" and confirm the Terrain section still appears and
  a measured line still shows inside a point cloud.
- **The measure paint** (`MEASURE_LINE_COLOR`/`MEASURE_LINE_WIDTH`/
  `MEASURE_FILL_COLOR`, `packages/plugins/src/plugins/lidar-measure-mirror.ts`)
  is passed to the control explicitly rather than left to its defaults, because
  the deck.gl mirror has to repaint the same geometry in the same colour. Change
  one form and change the RGBA twin beside it;
  `tests/lidar-measure-mirror.test.ts` asserts the pair agrees.

### `maplibre-gl-basemap-control` (`packages/plugins/package.json`)

`BASEMAP_PANEL_SELECTOR` / `BASEMAP_ROW_SELECTOR` / `BASEMAP_ROW_ID_ATTR`
(`packages/plugins/src/plugins/basemap-thumbnails.ts`) mirror the DOM the control
renders — `.basemap-control-panel`, `.basemap-control-result`, `data-basemap-id` —
which the Basemaps panel's thumbnails hook into to find rows and join each one
back to its catalog entry. That package exports only
`BasemapControl`/`BasemapDefinition`, so a renamed class fails nothing at build
time: the queries stop matching and thumbnails silently stop appearing.
`tests/basemap-thumbnails.test.ts` builds a real control and asserts its rendered
panel against the mirror.

The same file's `hasUnresolvedPlaceholder` deliberately matches the **complement**
of the tile tokens it substitutes rather than mirroring that package's credential
placeholders (`{api-key}`, `{aws-region}`), so a new provider's placeholder is
skipped instead of being fetched literally. Keep it that way rather than
enumerating placeholder names.

### `maplibre-gl-vector` (`packages/plugins/package.json`)

`MAX_VECTOR_BYTES` (`packages/plugins/src/plugins/remote-file-formats.ts`) mirrors
`MAX_REMOTE_FILE_BYTES`, an **internal, unexported** constant in that package
(2 GiB — DuckDB-WASM holds remote file sizes in 32 bits). It cannot be imported,
so re-check `src/lib/utils/remote.ts` in that package and update the mirror if it
moved. If it drifts, the remote-browse panels (Source Cooperative, Hugging Face)
silently block GeoParquet the engine could now open, or offer an Add that is
certain to fail. Updating the constant is enough: the limit the user is shown is
rendered from it, not written into the copy.

`remote-file-formats.ts` is the **single** home for this and the other
format/reader/size rules those panels share — a per-panel copy would miss this
check, so add new browse panels against that module rather than duplicating it
(`source-coop-api.ts` re-exports it under its own names for compatibility).

### `maplibre-gl-lidar` (`packages/plugins/package.json`) — half checked by the compiler

The space-effects engine raises the MapLibre canvas to `z-index: 4` so its
starfield canvases can sit underneath. That package renders point clouds into an
**overlaid** deck.gl canvas which it parks in the canvas container, directly
after the map canvas, tagged `DECK_CANVAS_CLASS`
(`maplibre-gl-lidar-canvas`). `effectsOverlayCss()`
(`packages/plugins/src/plugins/maplibre-effects.ts`) hands that wrapper the
canvas's own z-index. Drop the rule and the wrapper falls below the raised
canvas, hiding the point cloud outright; drop the re-parenting upstream and the
wrapper goes back to covering the Measure/Colorbar/Legend/HTML/Bookmark panels
(#2530).

`lidar-measure-mirror.ts` draws the Measure tool's line/polygon into that same
overlay (`LidarControl.getDeckOverlay()`) with `depthTest: false`, the trick the
plugin's own cross-section line uses to sit above the points. Two things there
are not compiler checked: deck paints its layers in insertion order, so the
mirror re-appends itself on any frame where it is no longer the overlay's last
layer (streaming adds a chunk layer whenever the viewport pulls in new nodes),
and the geometry is read from the MapLibre/Mapbox `geojson` source's `_data`
field, since neither library exposes a public reader. Losing either costs only
the mirror — the measured line goes back to being hidden inside the cloud, which
is what #2533 was.

The **class** is a hand-kept copy of the package's `DECK_CANVAS_CLASS`, not an
import: `maplibre-gl-lidar` builds into its own lazy chunk, and importing even
this one string would pull that chunk onto the startup path.
`tests/effects-settings.test.ts` builds its expected selector from the package
export, so a rename upstream fails `npm run test:frontend`. The **placement** is not visible to the compiler, so
`e2e/lidar-canvas-stacking.spec.ts` mounts the real control and asserts the
resulting DOM order and z-indices — run it on a bump
(`npx playwright test e2e/lidar-canvas-stacking.spec.ts --project=features`).

The `?data=` LiDAR deep link leans on two more things the compiler cannot see.
`isStreamedLidarUrl` (`apps/geolibre-desktop/src/lib/data-url.ts`) copies the
routing at the top of `LidarControl.loadPointCloud` (an `/ept.json` suffix or a
`.copc.` anywhere in the URL streams; anything else downloads whole) so that only
whole downloads get the size check. If upstream changes that routing, update the
copy, or a streamed file gets a needless size check and a downloaded one skips
it. `addLidarLayerFromUrl` also relies on `load` firing, and adding the store
layer, before `loadPointCloud` resolves; it throws if not.
`tests/lidar-url-layer.test.ts` pins the GeoLibre side of both. Re-read
`loadPointCloud` on a bump.

### `maplibre-gl-raster` — stretch and gamma curves

`buildContinuousColormapRgba`
(`packages/plugins/src/plugins/raster-symbology.ts`) mirrors the render
pipeline's value adjustments **by hand**, inverted. Value-range opacity paints
its alpha into the injected 256-wide colormap texture, so it has to map a
texture column back to a data value — and the renderer samples that texture
*after* rescale, the stretch curve and gamma. The mirror therefore applies each
curve's **inverse**, in the reverse of the renderer's order — gamma first, then
the stretch:

- gamma — renderer `pow(x, 1 / max(gamma, 0.0001))`, mirror
  `pow(t, max(gamma, 0.0001))`
- `sqrt` stretch — renderer `sqrt(x)`, mirror `t * t`
- `log` stretch — renderer `log(1 + 99x) / log(1 + 99)`, mirror
  `(100^t - 1) / 99`

None of it is exported: the curves live in the package's `pushAdjustments` /
shader modules, and the strength constant (99) is a hard-coded prop. If
upstream reorders the pipeline, changes a curve, or retunes the log strength,
nothing fails to build — opacity thresholds just drift off the values the user
typed, and only under a non-default stretch or gamma. On a bump, re-read that
package's `pushAdjustments` for the forward curves and their order (its own
`inverseStretch` helper, used for the histogram ticks, is a second copy of the
two stretch inverses above) and run `tests/raster-symbology.test.ts`.

### `maplibre-gl-raster` — checked by the compiler

`GeoLibreCogRenderEngine` (`packages/plugins/src/types.ts`) mirrors the
`RenderEngine` union that package exports (`maplibre-gl-raster` |
`cog-tiler-wasm` | `titiler`). It is hand-written rather than imported because
`types.ts` is the public plugin-API surface and importing there would make that
package's types a hard dependency of every external plugin. Unlike the mirrors
above this one is checked by the **compiler**:
`CogRenderEngineMirrorIsExact` in
`packages/plugins/src/plugins/maplibre-raster.ts` asserts both directions of
assignability against the real imported type, so a renamed or dropped engine
identifier fails `npm run typecheck`. Nothing extra to do on a bump beyond letting
the build run.

### `tauri-plugin-persisted-scope` — private on-disk format

`PersistedScopeState` (`apps/geolibre-desktop/src-tauri/src/lib.rs`) mirrors the
plugin's private bincode `Scope` structure so GeoLibre can remove legacy
per-photo grants before the plugin synchronously replays them at startup. On a
`tauri-plugin-persisted-scope` bump, compare the upstream struct's field order
and types against this mirror and run the Rust scope-cleanup tests. Bincode
encodes fields positionally, so an upstream layout change is not compiler
checked.

The `bincode` dependency itself is pinned to the **1.x** line and Dependabot is
configured (`.github/dependabot.yml`) to skip its major bumps: the plugin writes
the file with bincode 1, so GeoLibre must decode and re-encode it with the same
wire format. Only move when `tauri-plugin-persisted-scope` moves. (bincode 3.0.0
is additionally a deliberately unbuildable release — its whole source is
`compile_error!("https://xkcd.com/2347/")`.)

### `@tauri-apps/plugin-http` — two upstream *behaviors*, not APIs

`createNativeSidecarFetch`
(`apps/geolibre-desktop/src/lib/sidecar-fetch.ts`) routes Windows sidecar traffic
through the plugin's native `fetch` and hardens it with two options whose effect
comes from `reqwest`'s implementation rather than from any documented contract.
The option *names* are compiler-checked — `NativeFetchInit` is derived from
`typeof import("@tauri-apps/plugin-http").fetch`, so a renamed or dropped option
fails `npm run typecheck` — but the semantics are not, and both fail silently:

- `maxRedirections: 0` maps to `reqwest::redirect::Policy::none()`
  (`tauri-plugin-http/src/commands.rs`). Without it the native client follows
  redirects, and `reqwest` only strips `Authorization`/`Cookie` across hosts, so
  the per-launch `X-GeoLibre-Token` would be replayed to whatever a 3xx pointed
  at.
- `proxy: { all: { url, noProxy: "*" } }` is how the sidecar reaches the loopback
  directly. The plugin has no "disable proxy" switch, but any `ClientBuilder::proxy`
  call sets `auto_sys_proxy = false` (`reqwest/src/async_impl/client.rs`), and
  `NoProxy::from_string("*")` matches every host
  (`hyper-util/src/client/proxy/matcher.rs`), so the supplied proxy never
  intercepts either. This matters because reqwest's `system-proxy` feature *is*
  in the resolved graph (confirm with
  `cargo tree -e features -i reqwest`; the plugin's default
  `macos-system-configuration` feature pulls it in), and hyper-util's Windows
  reader copies the registry `ProxyOverride` list verbatim — it never expands the
  `<local>` token Windows writes for "bypass proxy server for local addresses".
  Drop this and a corporate-proxied Windows machine sends the sidecar request
  body and token to the proxy.

`tests/sidecar-fetch.test.ts` pins the options the adapter passes, which catches a
careless edit here but cannot exercise the Rust side. On a plugin bump, re-check
both behaviors against the sources above; the failure modes are a leaked token and
a sidecar that is unreachable only for proxied users, neither of which shows up in
CI or on an unproxied dev machine.

### `cesium` / `@cesium/engine` / `@cesium/widgets` — runtime assets fetched by URL

The 3D globe pane loads its code from **`@cesium/engine`** but its runtime
assets from the **`cesium`** wrapper. Both are dependencies and both must move
together: `cesium@1.x` pins the matching `@cesium/engine`, and the prebuilt
Workers/Assets staged from the wrapper have to match the engine running them.
**`@cesium/widgets`** is a third dependency on the same clock — it depends on
`@cesium/engine` itself — and it supplies the globe's home, scene-mode and
fullscreen buttons (`packages/map/src/cesium-widget-controls.ts`).

The code imports the engine and the widgets directly rather than through the
`cesium` barrel, which re-exports both and defeats tree-shaking — the base-layer
picker, geocoder, info box and Knockout all shipped in the lazy chunk even when
the pane built a bare `CesiumWidget`. Reverting to `import("cesium")` adds
~340 KB back with no build error and no test failure.

After a bump, check all five — none of these fail the build:

- **Asset copy.** `vite-plugins/copy-cesium-assets.ts` copies `Assets`,
  `ThirdParty`, `Widgets` and `Workers` out of `cesium/Build/Cesium` into
  `public/cesium/`, keyed on the installed version. The copy is gitignored, so a
  stale one is refreshed automatically. A directory *renamed or removed*
  upstream fails loudly — `cpSync` throws `ENOENT` from `buildStart`, so the dev
  server and the build both stop. The silent case is the opposite one: a runtime
  directory *added* upstream is simply not in `RUNTIME_DIRS`, so it is never
  copied and only surfaces as a 404 when the globe reaches for it.
- **`CESIUM_BASE_URL`.** `CesiumCanvas.tsx` derives it from the app's
  `BASE_URL`, not a hardcoded `/cesium`, so a sub-path deploy (the `/demo/`
  build) still resolves. Cesium reads it at import time; if the Workers 404 the
  render loop dies with no error boundary.
- **The stylesheets.** `CesiumCanvas.tsx` links four paths by hand
  (`CESIUM_CSS_PATHS`) rather than the 32 KB `Widgets/widgets.css`:
  `Widgets/CesiumWidget/CesiumWidget.css` for the canvas sizing, credit
  container and error panel; `Widgets/shared.css` for the `.cesium-button`
  chrome both toolbar widgets are built from; and
  `Widgets/SceneModePicker/SceneModePicker.css` plus
  `Widgets/FullscreenButton/FullscreenButton.css` for those two widgets. Check
  every one after a bump — a `<link>` to a path upstream moved 404s silently, and
  the failure is cosmetic in a way no assertion catches: the globe still mounts,
  but its canvas stops filling the pane, or a toolbar button loses its size and
  renders 0x0. (The home button has no stylesheet of its own; `shared.css` is
  all it needs.)
- **The widget classes and view models.** `cesium-widget-controls.ts` builds
  `HomeButton`, `SceneModePicker` and `FullscreenButton` directly and writes
  their tooltips through `viewModel.tooltip` / `tooltip2D` / `tooltip3D` /
  `tooltipColumbusView`. `index.css` then restyles them through Cesium's own
  class names (`.cesium-button`, `.cesium-toolbar-button`,
  `.cesium-sceneModePicker-wrapper`). A renamed observable leaves the English
  default in place; a renamed class leaves Cesium's dark-blue chrome on a
  GeoLibre toolbar. Neither fails the build. Tooltip assertions live in
  `e2e/cesium-primary-renderer.spec.ts`, alongside control mounting and alignment
  checks. The fullscreen button is the fragile
  one: its tooltip is a read-only computed, so the translated string is written
  onto the element from a `fullscreenchange` listener and survives only because
  DOM listeners fire in registration order. If a bump makes the widget update
  its own title differently — batched on a microtask, or bound to another
  target — the label reverts to English *after the first toggle*, which is why
  the spec toggles fullscreen and re-reads the title rather than checking it
  once at mount.

  **Scene-mode lifetime:** the 2D/3D/Columbus picker controls the current
  `CesiumWidget` only. Recreating the widget, including switching to MapLibre
  and back or reopening a project, starts in 3D. The project retains its
  rendering engine and camera, but does not serialize the Cesium scene mode.
  Scene-mode persistence is outside the toolbar integration's scope; adding it
  requires an explicit project/store field and restoration for each Cesium pane.
- **PWA globs.** `**/cesium-*` / `**/Cesium-*` in `vite.config.ts` keep the
  chunk out of the app-shell precache and CacheFirst-cache it instead. A chunk
  renamed out of that pattern would be precached, adding megabytes to first load.

`e2e/cesium-globe.spec.ts` mounts the real engine keyless and drags the globe,
so it catches a broken `CESIUM_BASE_URL` or a dead chunk.
`e2e/cesium-primary-renderer.spec.ts` adds the toolbar: it asserts the three
buttons mount, carry translated tooltips, and share a right edge, which catches a
renamed view-model observable and the 0x0-button case of a missing stylesheet.
Neither catches the rest of the CSS regression or the bundle-size one — check
those by eye and in the build output.

### ArcGIS Maps SDK for JavaScript — loaded from Esri's CDN

The ArcGIS renderer (`docs/arcgis-renderer.md`) has **no npm dependency**.
`packages/map/src/arcgis-sdk.ts` imports the SDK's ES modules from
`https://js.arcgis.com/<ARCGIS_SDK_VERSION>/@arcgis/core/…` at runtime and
types the surface it uses by hand, so nothing here is checked by the compiler
against Esri's declarations. Bumping `ARCGIS_SDK_VERSION` is therefore a
manual check, not a Dependabot event:

- **Module paths and default exports.** `SDK_MODULES` in `arcgis-sdk.ts` lists
  every module the engine loads. `tests/arcgis-renderer.test.ts` only checks the
  assembly against fakes; probe the real CDN (`curl -sI` each URL returns 200)
  and mount a pane in a browser — a moved module rejects the whole load and the
  pane shows the error banner. Also check the deck adapter's lazy imports in
  `packages/plugins/src/plugins/arcgis-deck/overlay.ts`:
  `layers/Layer`, `views/2d/layers/BaseLayerViewGL2D`, and
  `views/3d/webgl/RenderNode`. Mount a deck.gl layer in both a 2D MapView and a
  local SceneView after a version bump; those imports are outside the engine's
  module registry.
- **The legacy widgets.** `widgets/Zoom`, `Compass`, `ScaleBar`, `Fullscreen`
  and `Locate` back the built-in controls. Esri deprecated them in 4.32 in
  favour of web components and still ships them in 5.x with a console warning
  each; a release that drops them breaks `setBuiltInControlVisible`. The
  replacement is the `@arcgis/map-components` CDN build. Attribution already
  uses the 5.x path: the view draws it while `view.attributionVisible` is on,
  so the deprecated `Attribution` widget is not loaded.
- **The ESM CDN notice.** The SDK logs "Only use ES modules from ArcGIS CDN for
  testing" on load; Esri's documented production path is an npm build, which
  this renderer deliberately avoids (see the size argument in issue #2421). The
  AMD CDN (`<script src="https://js.arcgis.com/<version>/">`) is the supported
  alternative if the ESM CDN is ever withdrawn.
- **Hit-test attributes.** `GeoJSONLayer` graphics only carry the fields the
  renderer reads unless `outFields: ["*"]` is set; identify depends on the
  compiler's `gl__id` field arriving. `e2e/arcgis-renderer.spec.ts` (opt-in,
  `ARCGIS_API_KEY`) is the check.
- **CSP and caching.** `https://js.arcgis.com/` is allow-listed in `script-src`
  and `font-src` in `tauri.conf.json` and `docker/nginx.conf`, and cached by
  the `geolibre-arcgis-sdk` service-worker rule in `vite.config.ts`. The
  version is in every URL, so a bump mints new cache entries.

## Adding a blend mode

**Do not add a blend mode without checking it in the browser.** MapLibre's blend
state covers the alpha channel too, and it composites a blended layer as one
viewport-filling quad, so any mode that does not reduce to "leave the destination
alone" at zero source alpha repaints the whole map. That is what disqualified
`darken` (a `MIN` equation erased the entire basemap to transparent black) and
`subtract` (a reverse subtract left the canvas at `dstA - srcA`, showing the page
through the layer). The shipped list is `BLEND_MODES` in `@geolibre/core`, and
both the unit test's blend simulator and the e2e spec pin their exclusion.

Only `fill` and `line` have a `*-layer-opacity` in the style spec, so only they
blend as a **whole layer**; `circle` and `fill-extrusion` blend per symbol and
visibly double-darken where symbols overlap on screen (measured under Multiply:
`rgb(23, 77, 220)` in the overlap vs `rgb(76, 136, 222)` on a single symbol). That
is upstream's limitation, documented in
[Managing Layers](user-guide/layers.md); the test "has a layer-level composite for
fill and line only" fails if a bump adds one of the missing properties, at which
point extend `COMPOSITE_LAYER_TYPES` and `style-mapper` together and drop the
caveat.

The Style-panel control (`blendModeControl` in `StylePanel.tsx`, rendered in each
of its terminal branches) is gated on `!pluginOwnsPaint && !controlRendersLayer`:
blending only reaches layers **GeoLibre itself paints**, so anything a control
renders or paints (3D Tiles, Gaussian splats, LiDAR, the COG raster control, and
Add Vector Layer, which sets `customLayerType` *and* `controlOwnsPaint`) is
excluded — layer-sync never applies `fillPaint`/`linePaint` to those, so the
`*-layer-opacity` that elects the composite never lands and a Blend menu there
would silently do nothing. Keep `docs/user-guide/layers.md` and
`tests/layer-blend-modes.test.ts` ("the layer kinds the Blend control is offered
for") in step with that gate; build the test's mocks the way the real controls
build their metadata, or they pass on shapes that never occur.

## Coverage floors

The `:coverage` test variants run the same suites and print a coverage summary;
CI runs them so every build reports coverage. They are **gated on a floor**:
`test:frontend:coverage` fails below 78% lines / 78% branches / 63% functions, and
`test:backend:coverage` fails below 55% (`--cov-fail-under`). The floors sit a few
points under the current numbers as a **ratchet** — regressions fail CI, and when
coverage rises comfortably above a floor, raise the floor to lock in the gain.

The frontend report only counts files a test actually imports, so a module with no
test does not appear at all rather than as 0%. That is the part that bites:
writing the *first* test for a large untested module reads as a coverage
**regression**, because the module and everything it imports enter the denominator
at once. GeoLibre#1784 added a test that imported `usePlugins.ts` and so pulled in
the whole built-in plugin registry, 39 files, dropping function coverage 72.90% →
60.36% and reddening `main`. The fix is to test against a leaf module rather than
to lower the floor (GeoLibre#1888 extracted `lib/plugin-layer-queries.ts`;
`geo-editor-geometry.ts` in `@geolibre/plugins` is the same pattern). Check what a
new test *transitively* imports before assuming a coverage drop means the code got
worse.

`test:frontend:coverage` runs through `scripts/coverage-check.mjs` rather than
calling `node --test` directly. Node still enforces all three floors; the wrapper
only re-measures once when **line** coverage alone comes up short with every test
passing. Line coverage is nondeterministic on CI (GeoLibre#1889: two runs over
byte-identical sources reported 81.82% and 76.47%, 114 of 444 files differing on
lines and *none* on branches or functions), and it is not reproducible locally on
either Node 22 or 26. Branch and function shortfalls, and any test failure, fail on
the spot with no retry, so a real regression still fails fast. `classify()` is
exported and covered by `tests/coverage-check.test.ts` — change the retry policy
there, not by loosening a floor. If the retry starts firing regularly, fix the
measurement instead of widening the mitigation.

The backend coverage run (and `npm run ci`, which calls the `:coverage` variants)
needs `pytest-cov` from the backend `dev` extra. Install the **`test`** extra to
run the *full* backend suite — without the optional engines
(geopandas/rasterio/sedona/httpx) the vector/raster/SQL/ML tests skip themselves
and CI is green but hollow: `pip install -e "backend/geolibre_server[test]"`.

## Dependency updates and the audit allowlist

Dependencies are watched two ways: **Dependabot** (`.github/dependabot.yml`) opens
grouped weekly update PRs for npm, pip (backend + `python/`), cargo, and Actions,
and the CI **`audit` job** runs `npm run audit:ci` (blocking) plus a non-blocking
`pip-audit` of the resolved backend environment.

`audit:ci` is `scripts/audit-check.mjs`, a thin wrapper over `npm audit
--omit=dev` that still fails on every high/critical advisory *except* the ones
listed in its `ALLOWLIST`. The wrapper exists because plain `npm audit` cannot
accept a single finding, so one unpatchable transitive advisory reddens every PR
until upstream ships a fix — which for an unmaintained leaf package may be never.
Only allowlist an advisory when there is **no patched version to upgrade to** and
the vulnerable code is **unreachable from a GeoLibre runtime path**, and say why on
both counts in the entry. Anything upgradeable gets upgraded instead. Stale entries
print a warning rather than failing, since the advisory database is a live service
and a transient omission must not redden an unrelated PR.

When the fix is a scoped `overrides` entry (such as `@loaders.gl/compression` →
`fflate`), npm 12 accepts it and `npm ls` then checks against the override's
range. The lockfile still lists the package's own declared dependency (`fflate:
0.7.4`), though, and npm keeps the old nested copy, so `npm ls` reports it as
`invalid`. Delete that package's
nested `node_modules/.../<pkg>` entries from `package-lock.json` (and from
`node_modules`), then run `npm install` again so it resolves them fresh. Confirm
with `npm ls <pkg>` before you commit.

If no other package already installs a copy that satisfies the override, npm
does not fetch one. It leaves the package out of the tree and `npm audit`
reports 0 vulnerabilities, which looks like a fix but isn't. That is why the
`texture-compressor` → `image-size@^2.0.4` override needed a hand-written lock
entry: `version`, `resolved`, `integrity`, `license`, `bin` and `engines`, taken
from `npm view <pkg>@<version> --json` (npm 12 wraps that output in an array).
Check a fresh `npm ci` with `npm ls <pkg>` before you commit. That override
patches GHSA-w3rx-r6r6-pgpr and GHSA-5p2g-fcmc-qvqq, but image-size 2.x takes a
buffer rather than a path, so texture-compressor's own CLI can no longer read
image sizes. GeoLibre never runs it: only `@loaders.gl/textures`'
`encodeImageURLToCompressedTextureURL`, a Node-only encoder, spawns it via
`npx`. Drop the override once loaders.gl stops depending on texture-compressor
(4.5.x already makes it a peer).

## Publishing `@geolibre/core` and `@geolibre/map`

Both are published to npm by `.github/workflows/publish-packages.yml` on each
GitHub Release, alongside `@geolibre/embed`. Their checked-in
`main`/`types`/`exports` point at TypeScript **source**, because that is how the
monorepo consumes them: Vite, `tsc` and tsx all resolve `./src/index.ts` through
the package's own `exports`, so `npm run dev` and
`node --import tsx --test tests/<name>.test.ts` need no build step.

The npm tarball ships `dist` instead, and npm cannot express that split on its
own: unlike pnpm and Yarn it deliberately **ignores entry fields nested under
`publishConfig`** (npm/cli#7586), so a manifest that only states its dist entries
there publishes `./src/index.ts` to consumers who never receive `src`. The
published entries therefore live under `publishConfig`, and
`scripts/prepare-npm-package.mjs` hoists them (and pins the `"*"`
`@geolibre/core` dependency to the release version) just before `npm publish`.

Point those top-level fields at `dist` and every frontend test that imports a
`@geolibre/map` subpath fails with `ERR_MODULE_NOT_FOUND`, because `dist` is
gitignored and nothing builds it before the suite.
`tests/prepare-npm-package.test.ts` guards both halves, including that each
published path is one the package's own `tsdown` entries actually emit
(`--format esm --dts` writes `<entry>.mjs` and `<entry>.d.mts`, **not** `.d.ts`).
The release workflow does build both packages, but a green build proves only that
the bundles were written, not that every path the manifest publishes names one of
them, so nothing else would notice that drift.

## The bundled sidecar lockfile

`backend/geolibre_server/uv.lock` **is committed** (the root `.gitignore` ignores
`uv.lock` everywhere else and negates it for this one path). That project is
bundled into the desktop installers and launched with
`uv run --frozen --project <resource dir>` from `src-tauri/src/lib.rs` — a
directory the user cannot write (`C:\Program Files\…`,
`/usr/lib/GeoLibre Desktop/…`). Ship it lockless and uv resolves, then tries to
*write* `uv.lock` there, fails with "Permission denied" and exits 2 — which reaches
the user as "Jupyter server exited before it was ready (exit code: 2)" with the
cause invisible.

So: any edit to that `pyproject.toml`'s dependencies must land with a refreshed
lock (`uv lock --project backend/geolibre_server`). CI's "Check the bundled sidecar
lockfile is in sync" step (`uv lock --check`) fails if they drift.

## Credentials must never reach a redistributable build

Anything we hand to someone else — the Jupyter wheel above all — must carry no
credential of ours. Three properties of this build make that easy to get wrong,
and every guard below blocks one of them.

1. `apps/geolibre-desktop/vite.config.ts` bridges bare shell vars into their
   `VITE_` names — `GOOGLE_MAPS_API_KEY` → `VITE_GOOGLE_MAPS_API_KEY`, and the
   same for `MAPBOX_TOKEN` and `CESIUM_TOKEN`. Convenient for local testing;
   it also means the build machine's shell is build input.
2. Something in the graph reads `import.meta.env` as a **whole object**. Vite
   cannot tell which keys such a read wants, so it stops replacing per key and
   inlines the entire env record — every `VITE_` var on the build machine — into
   every chunk that read reaches. Ours was `packages/core/src/runtime-env.ts`;
   the one we cannot fix is `@clerk/shared`'s `getEnvVariable.mjs`, which does
   `import.meta.env[name]` with a computed name, so the inlined record lands in
   the `ClerkGate-*.js` chunk.
3. `python/hatch_build.py` skips the JS build when `static/app` already exists
   and `GEOLIBRE_FORCE_JS_BUILD` is unset. A local `python -m build` therefore
   packages whatever an earlier `npm run build:embed` left staged, with no
   JavaScript running at all.

### The rules now

- **`BUILD_ENV_KEYS`** in `vite.config.ts` is the allowlist of `VITE_` names that
  may reach a bundle. `pruneBuildEnv()` deletes every other `VITE_` var from
  `process.env` before Vite reads it. Adding a new build-time var means adding it
  here — otherwise it silently resolves to undefined.
- **`CREDENTIAL_ENV_KEYS`** is the subset that authenticates as, and bills to,
  whoever ran the build. In a *redistributable* build these are blanked to `""`
  (blanked, not deleted, so a `.env` file cannot reintroduce them). A build is
  redistributable when `GEOLIBRE_EMBED=1` (the Jupyter wheel) or
  `GEOLIBRE_STRIP_CREDENTIALS=1`.
  The web deploy is **not** redistributable: it is our own site using our own
  referrer-restricted keys, and it keeps them.
- Public-by-design identifiers stay in every build: the Clerk *publishable* key,
  the Auth0 client ID and domain, the GEE OAuth client ID, the GA measurement ID.
  `publish-python.yml` deliberately injects the GEE client ID into the wheel.
- Prefer `getBuildEnvironment()` from `@geolibre/core` over reading
  `import.meta.env` yourself. A whole-object read re-opens cause (2) for every
  chunk it reaches, and nothing in the type system will tell you.

Each stripped credential resolves through `getRuntimeEnvironment()`, which
overlays `window.__GEOLIBRE_RUNTIME_ENV__` from Settings → Environment variables.
So a wheel user supplies their own token and the affected surfaces degrade as
documented: Mapbox prompts in the basemap API-keys view, the 3D globe loses
terrain and Ion imagery (the pane itself still works), Protomaps basemaps are
hidden.

### The scan

`scripts/scan-credentials.mjs` verifies the **output**. A build run by hand can
satisfy every rule above and still be wrong, and a third-party asset dropped into
the tree can arrive with a key already inside it — neither is visible from the
config. It runs in two places:

- `scripts/build-embed.mjs`, before staging `dist-embed` into the Python package.
- `python/hatch_build.py`, before packaging any wheel or sdist — including the
  stale-assets path (3) above, which no JS-side guard can cover. This one needs
  no Node.

Both read `scripts/credential-patterns.json`, so the JS and Python scanners
cannot drift; the file is force-included into the sdist so an sdist → wheel build
is gated too. `tests/credential-scan.test.ts` covers it.

To scan any built directory by hand:

```bash
node scripts/scan-credentials.mjs apps/geolibre-desktop/dist-embed
```

### When the scan fires after a dependency bump

`allowedValueHashes` in `credential-patterns.json` holds the SHA-256 of values
that match a pattern but are public by design — currently CesiumJS's built-in
default Ion token, which ships inside `cesium` and appears in every build. A
Cesium upgrade changes that token, so the guard will fire on the new one.

That is intended. Decode the payload before doing anything: CesiumJS's has
`sub: "CesiumJS"` and `iss: "https://api.cesium.com"`. Only once you have
confirmed it is the vendor's own token, replace the hash. Never add a hash to
silence a finding you have not decoded — the whole point of the list is that it
is short and every entry was checked.

Bundled plugin drop-ins under `apps/geolibre-desktop/public/plugins/<id>/` are
scanned too. They are third-party build artifacts that are not committed here, so
a hardcoded key inside one is fixed in that plugin's own repository, never by
allowlisting it. Note that removing such a drop-in does not clean a `dist/` built
while it was present: Vite copies `public/` into the output and only clears that
output when a build actually runs. Rebuild, or delete the stale directory.

## Generated files and cross-file sync

- **Processing tool metadata.** Names, descriptions, group labels, parameter
  labels/help and select options live in registries with no i18n access, so the
  dialogs resolve them through
  `apps/geolibre-desktop/src/lib/processing-tool-i18n.ts` and fall back to the
  registry's own English string. For the four small bundled registries,
  `en.json`'s `processing.toolMeta`/`processing.toolGroup` subtrees are the
  **generated** baseline translators work from. After adding or renaming one of
  those tools, parameters, or select options, run `npm run i18n:tools` and commit
  the result; CI fails on drift. Whitebox's much larger metadata is deliberately
  absent from all bundled locales and comes from optional, validated packs at
  `languages.geolibre.app` (or local file import); do not add
  `processing.toolMeta.whitebox`, `processing.whitebox.categories`, `menuTool`, or
  `menuSubcategory` back to a bundled locale.
- **The agent skill.** `skills/geolibre/` is a *user-facing* agent skill — a
  `SKILL.md` plus `references/` that teaches an external AI agent to author
  `.geolibre.json` projects through `geolibre-mcp`, the Python package, or
  hand-written JSON. It is not for contributors working on GeoLibre itself. It
  restates things that live elsewhere: the MCP tool surface
  (`python/src/geolibre/mcp/server.py`), the basemap/color-ramp/legend catalogs
  (`python/src/geolibre/basemaps.py`, `color_ramp.py`, `legends.py`), the project
  schema ([Project Format](project-format.md)), and the embed parameters
  ([Embedding](user-guide/embedding.md)). `python/tests/test_agent_skill.py`
  guards the parts that can be checked mechanically: every registered MCP tool
  must appear in the tool reference, every tool and `Map` method the skill names
  must exist, and the basemap, color-ramp, legend-preset, layer-type, frontmatter,
  and reference-file lists must match their sources. It cannot check prose, so a
  changed size cap, limit, or behavioral caveat still has to be carried over by
  hand — update the skill in the same PR. A stale caveat sends an agent down a
  path that no longer works, with no failure anywhere.
