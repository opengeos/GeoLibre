# MapLibre GL JS migration log — codex

## 2026-07-20 — MapLibre canvas snapshot and story paint mutation → `MapEngineClient.viewport.capture` and typed story extensions

- Source: MapLibre — `map.getCanvas()`, `getContainer().querySelectorAll("canvas")`,
  `project`/`unproject`, `getBearing`, direct `idle` listeners, zoom/bounds
  reads, and direct story layer opacity paint mutation in print, atlas, and
  story-handout flows.
- Files touched: `apps/geolibre-desktop/src/lib/print-layout-export.ts` before
  → thin `MapEngineClient` capture consumer; new
  `packages/map/src/capture/{canvas-surfaces.ts,maplibre-capture.ts}`;
  `packages/map/src/engine/{types.ts,maplibre-engine.ts,handle.ts,cesium-engine.ts,transient-overlays.ts,extensions.ts}`;
  `apps/geolibre-desktop/src/components/{layout/PrintLayoutDialog.tsx,storymap/StoryMapHandoutDialog.tsx}`;
  `tests/{print-capture,map-engine-interactions,engine-contracts,maplibre-engine,engine-boundary}.test.ts`.
- ArcGIS approach: a future ArcGIS adapter implements `MapView.takeScreenshot`
  behind `viewport.capture`; `MapView` camera/viewpoint data supplies the same
  capture metadata and camera operations. Story opacity remains a typed
  engine-extension command rather than a renderer object escape hatch.
- What changed: MapLibre canvas compositing, geographic clipping, pixel-scale
  measurement, and bearing calculation are adapter-private. Print preview,
  atlas export, and story handouts now depend only on capture, camera, layer,
  and extension ports. Hidden transient overlays restore their exact prior
  visibility even when capture fails.
- Gap / limitation: MapLibre captures a composited set of DOM canvases, whereas
  ArcGIS exposes a screenshot API with different overlay inclusion semantics.
- Workaround: preserve the public `MapCaptureResult` canvas and metadata shape;
  the MapLibre adapter composites full-viewport deck surfaces today. Removal
  criteria: replace the MapLibre adapter in Phase 6 after the ArcGIS screenshot
  adapter has conformance coverage for the same result contract.
- Tradeoff accepted: capture allocates an offscreen canvas and performs a
  best-effort redraw per request; this preserves current print fidelity at the
  cost of transient memory/CPU during exports.
- Status: done.
- Verification: `node --import tsx --test tests/print-capture.test.ts
  tests/map-engine-interactions.test.ts tests/engine-contracts.test.ts
  tests/maplibre-engine.test.ts tests/engine-boundary.test.ts` → 25 passed;
  `npm run build` → passed.
- Follow-up: move map/video and tour recording plus inset-map lifecycle into
  the same engine boundary in Task 10.

## 2026-07-20 — MapLibre canvas stream and camera tour → engine capture, camera, and interaction ports

- Source: MapLibre — `canvas.captureStream`, direct `map.getCanvas()` frame
  reads, `triggerRepaint`, `jumpTo`/`flyTo`/`moveend`, and native navigation
  handler enable/disable during map and tour video recording.
- Files touched: `apps/geolibre-desktop/src/lib/{map-recorder.ts,tour-recorder.ts}`
  before → compatibility re-exports; new
  `packages/map/src/capture/{map-recorder.ts,tour-recorder.ts}`; recorder
  dialogs before → `MapEngineClient` consumers; `packages/map/src/engine/{types.ts,maplibre-engine.ts,handle.ts,cesium-engine.ts}`;
  `packages/map/package.json` and lockfile.
- ArcGIS approach: a future ArcGIS adapter supplies `MapView.takeScreenshot`
  through `viewport.capture`, `goTo` through `camera.applyView`/`whenIdle`, and
  navigation suppression through `interactions.suspendNavigation`.
- What changed: recorders create a stable output canvas and sample it with
  `MediaRecorder`, but receive every input frame from the engine rather than a
  MapLibre canvas. Tour keyframes use engine camera transitions, engine idle
  waits, and a restoration closure for navigation state. Existing app imports
  remain thin compatibility re-exports while ownership is in `@geolibre/map`.
- Gap / limitation: MapLibre can repaint continuously on demand; other engines
  may deliver screenshots more slowly than the requested video frame rate.
- Workaround: permit only one capture request at a time and retain the latest
  output frame until the adapter resolves the next capture. Removal criteria:
  remove this throttle when the ArcGIS adapter exposes a tested continuous
  capture stream with equivalent backpressure semantics.
- Tradeoff accepted: screenshot capture can duplicate frame memory and drop
  intermediate frames under load, trading peak frame-rate fidelity for a strict
  renderer boundary and a portable recorder contract.
- Status: done.
- Verification: `node --import tsx --test tests/map-recorder.test.ts
  tests/tour-recorder.test.ts tests/engine-contracts.test.ts` → 59 passed;
  `npm run build` → passed.
- Follow-up: migrate the story presentation's inset-map and marker lifecycle
  through an engine-owned React host in Task 10.

## 2026-07-20 — Story inset `new maplibregl.Map`/`Marker` → restricted engine host and marker port

- Source: MapLibre — direct `new maplibregl.Map`, `new maplibregl.Marker`,
  `setCenter`, marker DOM visibility, native container lookup, and direct story
  layer-style mutation in the scroll-driven story presenter.
- Files touched: `apps/geolibre-desktop/src/components/storymap/StoryMapPresenter.tsx`
  before → `MapEngineClient` marker/camera/extension/viewport consumer; new
  `packages/map/src/InsetMapCanvas.tsx`; `packages/map/src/index.ts`; new
  `tests/inset-map-canvas.test.ts`; boundary baseline.
- ArcGIS approach: the future adapter maps the inset host to a lazily created
  `@arcgis/core/views/MapView`, camera changes to `MapView.goTo`, and the story
  point to a `Graphic` in a `GraphicsLayer`; React stays coupled only to the
  engine handle and marker contract.
- What changed: `StoryMapPresenter` creates and updates its main marker through
  `interactions.createMarker`, invokes typed story opacity extensions, and
  portals into `viewport.getElement`. `InsetMapCanvas` configures, mounts,
  resizes, disables controls/navigation, updates, and destroys a secondary lazy
  engine handle without returning a concrete map object.
- Gap / limitation: MapLibre's HTML marker element can carry arbitrary CSS,
  while ArcGIS marker graphics use symbol renderers rather than DOM elements.
- Workaround: keep the existing inset-dot CSS class as an engine-neutral marker
  element input. Removal criteria: replace it with a named marker-symbol option
  once the ArcGIS adapter and MapLibre adapter share a tested visual-marker
  contract.
- Tradeoff accepted: an inset starts a second renderer instance and marker hide
  transitions recreate a marker, trading small startup/allocation cost for
  deterministic cleanup and no SDK leakage into the app.
- Status: done.
- Verification: `node --import tsx --test tests/inset-map-canvas.test.ts
  tests/engine-boundary.test.ts tests/map-engine-camera-consumers.test.ts
  tests/storymap-pdf.test.ts` → 22 passed; `npm run build` → passed.
- Follow-up: introduce Plugin API v2 in Task 11; Codex, 2026-07-20.

## 2026-07-20 — Flat native controller surface → typed `MapEngine` capability groups

- Source: MapLibre — the broad `MapController` API and native
  `maplibregl.Map` methods currently mix lifecycle, camera, queries, controls,
  capture, transient interaction, and plugin mounting in one public surface.
- Files touched: planning documentation only:
  `.migrate-docs/codex/00-overview.md`,
  `.migrate-docs/codex/maplibre.md`, and
  `.migrate-docs/codex/gaps-and-workarounds.md`; planned contract files are
  `packages/map/src/engine/types.ts` and
  `packages/map/src/engine/capabilities.ts`.
- ArcGIS approach: retain the required §5.2 lifecycle/view/layer/hit-test/event
  methods on `MapEngine`, then expose only typed engine-neutral capability
  groups for viewport/navigation, layer inspection/presentation,
  controls/terrain, capture, transient interaction, and renderer extensions.
  ArcGIS adapters may omit unsupported optional capabilities but must advertise
  that fact and pass the same capability conformance checks.
- What changed: the Phase 0 plan now has a concrete contract decomposition and
  sequences consumer migration by capability group before removing the public
  `MapController` export and native `GeoLibreAppAPI.getMap` access.
- Gap / limitation: capture and existing external MapLibre plugins depend on
  renderer-specific behavior. A generic `unknown` native handle would preserve
  behavior cheaply but would make the seam unenforceable and is therefore
  rejected.
- Workaround: expose engine-neutral capture results/surfaces and extension
  commands through named capabilities. Keep any compatibility object needed by
  an existing external MapLibre plugin private to `MapLibreEngine`; removal
  criteria are removal of the MapLibre fallback in Phase 6 or migration of the
  plugin to the public engine-neutral extension API.
- Tradeoff accepted: optional capability checks add API ceremony, and moving
  concrete plugin ownership under the adapter creates more Phase 0 relocation
  work, but future ArcGIS adapters remain isolated from MapLibre types.
- Status: partial.
- Verification: inspected `MapCanvas.tsx`, `SecondaryMapCanvas.tsx`,
  `map-controller.ts`, `GeoLibreAppAPI`, `PluginManager`, the current MapLibre
  consumer inventory, existing controller/Cesium tests, Playwright config, and
  CI gates. No runtime test was run because this is planning-only.
- Follow-up: reviewer approves or adjusts the capability grouping and
  commit-sized Phase 0 sequence before implementation begins.

## 2026-07-20 — Conflicting Phase 0 scopes → strict `MapEngine` boundary

- Source: MapLibre — the façade-only Phase 0 wording in
  `migration-design.md` §5.3/§8 and the proposed transitional public native-map
  access conflicted with the §2.2 requirement that every renderer operation go
  through `MapEngine`.
- Files touched: `.migrate-docs/migration-design.md` before → strict Phase 0
  contract; `docs/superpowers/plans/2026-07-20-phase0-map-engine-seam.md`
  retained as superseded history; `.migrate-docs/codex/00-overview.md` and
  `.migrate-docs/codex/maplibre.md` updated with implementation status.
- ArcGIS approach: establish the complete engine-neutral client ports and
  adapter boundary before adding `ArcGISSceneEngine` or `ArcGISMapEngine`, so
  both ArcGIS adapters can implement the same tested contract without MapLibre
  escape hatches.
- What changed: the user instruction to implement the master migration plan is
  treated as confirmation of its strict-scope recommendation. The design now
  requires MapLibre and Cesium adapters, consumer migration, Plugin API v2,
  concrete first-party runtime relocation, and a zero-violation boundary gate
  by Phase 0 exit.
- Gap / limitation: external Plugin API v1 exposes native MapLibre/deck.gl
  objects and cannot satisfy the strict seam.
- Workaround: reject v1 plugins before executing their code and provide a
  documented Plugin API v2 based on `MapEngineClient`. Removal criteria: none;
  native renderer access is intentionally not restored.
- Tradeoff accepted: external v1 plugins must be republished for v2, and Phase
  0 is substantially larger than a façade-only refactor.
- Status: done.
- Verification: `git diff --cached --check` → passed; no runtime test applies
  because production code is unchanged.
- Follow-up: implement the contracts and boundary ratchet on
  `codex-migrate-to-arcgisjsapi`, then update this log with test evidence.

## 2026-07-20 — Public `MapController` dependency graph → strict `MapEngine` contract and ratchet

- Source: MapLibre — public `MapController` imports plus direct `maplibre-gl`,
  `maplibre-gl-*`, deck.gl, three.js, and Cesium imports across applications and
  plugins.
- Files touched: `packages/map/src/index.ts` before → engine contracts exported;
  new `packages/map/src/engine/types.ts` and
  `packages/map/src/engine/extensions.ts`; new
  `tests/engine-contracts.test.ts`, `tests/engine-boundary.test.ts`, and
  `tests/fixtures/engine-boundary-baseline.json`.
- ArcGIS approach: define lifecycle, camera, layer, viewport, interaction,
  control, event, marker, popup, capture, and extension-command contracts using
  only GeoLibre, GeoJSON, DOM, and primitive types. Future `MapView` and
  `SceneView` adapters must implement these ports without exporting ArcGIS SDK
  objects.
- What changed: `MapEngine` and its restricted `MapEngineClient` are now the
  typed target for all renderer operations. A recursive source test snapshots
  197 reviewed path/pattern leaks outside `packages/map` and fails if a leak is
  added, renamed without review, or changes renderer pattern.
- Gap / limitation: the repository still has all 197 baseline violations; this
  commit establishes the enforceable destination but does not yet migrate a
  consumer.
- Workaround: keep the explicit ratchet baseline green while each subsequent
  commit removes its migrated entries. Removal criteria: the fixture becomes an
  empty array at strict Phase 0 exit.
- Tradeoff accepted: the initial baseline is large and creates intentional
  fixture churn during relocation, but it makes boundary regressions visible
  while permitting small, behavior-preserving commits.
- Status: done.
- Verification: `node --import tsx --test tests/engine-contracts.test.ts
  tests/engine-boundary.test.ts` → 4 passed; `npx tsc --noEmit --strict
  --skipLibCheck --moduleResolution bundler --module esnext --target es2022
  --lib es2022,dom --types node tests/engine-contracts.test.ts` → passed;
  scoped ESLint and `git diff --check` → passed.
- Follow-up: implement the stable synchronous handle and lazy MapLibre adapter,
  then begin deleting reviewed boundary entries.

## 2026-07-20 — `MapController` lifecycle → lazy `MapLibreEngine` adapter

- Source: MapLibre — eager `MapController` construction, raw MapLibre event
  payloads, and direct controller method calls for camera, layers, controls,
  queries, markers, popups, capture, and transient overlays.
- Files touched: new `packages/map/src/engine/handle.ts`,
  `packages/map/src/engine/registry.ts`, and
  `packages/map/src/engine/maplibre-engine.ts`; `packages/map/src/index.ts`
  before → stable handle/registry exports; new `tests/engine-test-fakes.ts`,
  `tests/map-engine-handle.test.ts`, and `tests/maplibre-engine.test.ts`.
- ArcGIS approach: use a synchronous engine handle in React while the selected
  adapter loads asynchronously. The same handle can later load an ArcGIS
  `MapView`/`SceneView` adapter without changing consumer refs or exposing the
  SDK view.
- What changed: the handle preserves the initial view, queues mutations in
  call order, forwards one normalized event stream, and cancels pending work on
  destroy. `MapLibreEngine` dynamically imports `MapController`, delegates
  store-layer reconciliation to `waitAndSyncLayers`, and implements all public
  capability ports without a `getMap()` or `getController()` escape hatch.
- Gap / limitation: consumers still mount `MapCanvas` and receive
  `MapController`; this adapter is implemented and tested but is not yet the
  active React host.
- Workaround: retain the controller internally as a compatibility
  implementation until `EngineCanvas` replaces the concrete hosts. Removal
  criteria: all hosts and consumers use `MapEngineClient`, after which the
  public controller export is deleted.
- Tradeoff accepted: the stable handle contains small neutral defaults and
  optimistic control results while an adapter is loading; queued operations and
  adapter events reconcile those values once mounting completes.
- Status: done.
- Verification: `node --import tsx --test tests/map-engine-handle.test.ts
  tests/maplibre-engine.test.ts tests/map-controller.test.ts
  tests/engine-boundary.test.ts` → 51 passed; scoped strict TypeScript and ESLint
  checks → passed; `git diff --check` → passed.
- Follow-up: extract the existing Cesium viewer lifecycle behind the same seam
  and encode unsupported capabilities explicitly.

## 2026-07-20 — Concrete pane components → engine-id `EngineCanvas` host

- Source: MapLibre — application imports of `MapCanvas`/`SecondaryMapCanvas`,
  the primary `MapController` ref, concrete secondary host selection, and direct
  container-resize calls.
- Files touched: new `packages/map/src/EngineCanvas.tsx`;
  `packages/map/src/engine/{extensions.ts,handle.ts,maplibre-engine.ts,registry.ts}`
  and `packages/map/src/index.ts` before → host/factory/metadata support;
  `apps/geolibre-desktop/src/components/layout/{DesktopShell.tsx,MapGrid.tsx}`
  before → engine-id host selection; boundary fixture 197 → 196 entries; new
  `tests/engine-registry.test.ts` and `e2e/engine-param.spec.ts`.
- ArcGIS approach: make React select an engine by neutral id and consume a
  stable `MapEngineClient`; later `arcgis-map` and `arcgis-scene` ids can enter
  the registry without changing the application host or pane chrome.
- What changed: secondary MapLibre/Cesium panes now mount through one store-led
  host that owns configuration, layer effects, camera echo handling, diagnostics,
  and resize commands. `DesktopShell` publishes a `MapEngineClient` ref and
  resolves the primary `?engine=` value through the registry. Layer support
  labels use registry metadata rather than a Cesium component import.
- Gap / limitation: primary MapLibre identify/photo behavior still lives in
  legacy `MapCanvas`, and unmigrated internal consumers still call controller
  methods.
- Workaround: `EngineCanvas` attaches a package-private `MapEngineClient` proxy
  to the existing primary controller and forwards unknown legacy members only
  inside the repository. Removal criteria: camera/control, query/interaction,
  and plugin consumer slices are complete, after which primary hosting uses the
  normal lazy handle and the proxy is deleted.
- Tradeoff accepted: primary MapLibre is not fully lazy during this transitional
  commit, but behavior and plugin readiness timing remain unchanged while the
  public application ref and secondary hosts move to the final seam.
- Status: partial.
- Verification: `npm run build -w geolibre-desktop` → passed;
  `node --import tsx --test tests/engine-registry.test.ts
  tests/engine-contracts.test.ts tests/engine-conformance.test.ts
  tests/engine-boundary.test.ts tests/maplibre-engine.test.ts
  tests/cesium-engine.test.ts` → 27 passed; `npx playwright test
  e2e/engine-param.spec.ts` → 2 passed; scoped ESLint and `git diff --check` →
  passed (two unrelated pre-existing hook warnings remain in `DesktopShell`).
- Follow-up: migrate camera/view/control consumers to `MapEngineClient` and
  remove their corresponding boundary entries.

## 2026-07-20 — Native camera/control calls → `MapEngineClient` ports

- Source: MapLibre — `MapController` camera methods, native `moveend` and
  pointer listeners, MapLibre markers used by place search, built-in control
  setters, terrain exaggeration, story-camera tokens, and the assistant's
  `run_maplibre_js` native-map escape hatch.
- Files touched: `apps/geolibre-desktop/src/components/{layout,panels,processing,storymap}/**`
  and `hooks/{useCollaboration,useCommandBridge,useEmbedBridge,useNotebookBridge,useProjectFileActions,useViewportHistory}.ts`
  before → camera/control/event/marker operations through `MapEngineClient`;
  `apps/geolibre-desktop/src/lib/{map-engine-camera.ts,build-project-snapshot.ts,selection-actions.ts,scripting/**,assistant/**,pyodide/**}`
  before → engine-neutral helpers and scripting errors;
  `packages/map/src/engine/{types,handle,maplibre-engine,cesium-engine}.ts`
  before → story-camera and marker-color support; boundary fixture 196 → 178
  entries; new `tests/map-engine-camera-consumers.test.ts`.
- ArcGIS approach: future ArcGIS adapters implement camera movement with
  `MapView.goTo`/`SceneView.goTo`, pointer and move events through the view event
  API, graphics-backed markers, and ArcGIS widget/ground settings behind the
  same engine-neutral ports. Application code depends only on those ports and
  never receives an ArcGIS view or MapLibre map.
- What changed: project snapshots and collaboration retain store authority but
  read the live camera through `camera.readView`; collaboration presence uses
  normalized engine events; history restores and story playback carry typed
  tags; zoom/reset/fit/projection/terrain/control-label operations use the
  camera and control ports; place search creates an engine marker; partial fly
  operations preserve the remaining view fields; native assistant JavaScript
  execution was deleted and old command callers receive an actionable
  unsupported-command error.
- Gap / limitation: consumers that also need source/style inspection, capture,
  or transient interactions retain a temporary `MapController &
  MapEngineClient` ref until the following capability slices migrate those
  operations. Cesium applies story chapter views but does not reproduce
  MapLibre's optional 30-second post-transition rotation.
- Workaround: the primary adapter-private compatibility proxy satisfies the
  temporary intersection while every migrated operation goes through a public
  port. Removal criteria: layer-query, capture, interaction, and plugin-runtime
  slices reach zero `MapController` consumers. The Cesium story limitation is
  removed when the ArcGIS `SceneView` adapter implements the neutral story
  camera sequence.
- Tradeoff accepted: the history implementation now classifies scripted moves
  by explicit string tags instead of counters/native event fields, and mixed
  consumers carry a temporary intersection type; this adds short-lived typing
  churn but makes event provenance portable and prevents native objects from
  entering new code.
- Status: partial.
- Verification: `npm run build -w geolibre-desktop` → passed;
  `node --import tsx --test tests/map-engine-camera-consumers.test.ts
  tests/engine-boundary.test.ts tests/maplibre-engine.test.ts
  tests/cesium-engine.test.ts tests/map-engine-handle.test.ts
  tests/core-project.test.ts tests/collab-protocol.test.ts` → 82 passed;
  `git diff --check` → passed.
- Follow-up: migrate live layer/source/style queries and feature operations to
  `MapEngineClient.layers`, then remove the corresponding intersection types.

## 2026-07-20 — Renderer source/style queries → adapter-owned feature-query core

- Source: MapLibre — application/plugin helpers inspected `getStyle()`,
  `querySourceFeatures()`, and viewport bounds to discover store-layer sources,
  recover vector-tile features, and merge tile-clipped geometry.
- Files touched: `packages/plugins/src/plugins/geo-editor-view-import.ts` before
  → `packages/map/src/engine/feature-query.ts` plus editor-only
  `geo-editor-import-state.ts`; `packages/map/src/{map-controller.ts,index.ts}`
  and `engine/{types.ts,maplibre-engine.ts}` before → adapter-owned query and
  render-target delegation; package manifests/lockfile and
  `tests/{geo-editor-view-import,map-controller,maplibre-engine}.test.ts`.
- ArcGIS approach: keep store-layer ids as the only public query key. Future
  ArcGIS adapters resolve those ids to `FeatureLayer`/`GraphicsLayer` objects
  privately and return normalized GeoJSON/hits through `MapLayerPort`, without
  exposing a view, layer, source, or SDK feature.
- What changed: viewport filtering, tile-fragment deduplication, source-layer
  resolution, and style inspection moved into `@geolibre/map`. The MapLibre
  controller now reports queryable content targets and performs in-view queries
  for the adapter; live GeoJSON/raster reads, identify, and highlight remain
  available only through the public layer port. Editor normalization/change
  tracking remains renderer-neutral in the plugin package.
- Gap / limitation: application call sites still need conversion to
  `MapEngineClient.layers`; the primary compatibility controller remains until
  those consumers no longer request native source/style objects.
- Workaround: compatibility re-exports preserve the existing plugin API while
  new application code imports query contracts from `@geolibre/map`. Removal
  criteria: Task 8 leaves no app-side `getSource`, `getLayer`, `getStyle`, or
  `queryRenderedFeatures` call.
- Tradeoff accepted: `MapRenderTarget` gains optional queryability metadata so
  editor UIs can list valid store targets without learning renderer layer
  types. This small contract addition avoids a second discovery API and remains
  implementable by ArcGIS adapters.
- Status: partial.
- Verification: `npm run build` → passed; `node --import tsx --test
  tests/geo-editor-view-import.test.ts tests/map-controller.test.ts
  tests/maplibre-engine.test.ts tests/feature-selection.test.ts
  tests/sql-query-layer.test.ts` → 112 passed; `git diff --check` → passed.
- Follow-up: convert export, story, attribute-table, processing, style, editor,
  notebook, scripting, and assistant consumers to the layer port.

## 2026-07-20 — Application layer reads → `MapEngineClient.layers`

- Source: MapLibre — application-side live-source recovery, basemap style-layer
  listing, viewport feature queries, click identify listeners, processing
  bounds, and native-map screenshot reads across export, table, story, editor,
  notebook, scripting, and assistant surfaces.
- Files touched: `apps/geolibre-desktop/src/components/{layout,panels,processing,storymap}/**`
  before → layer/camera/viewport port consumers; `hooks/{useCommandBridge,useNotebookBridge}.ts`
  before → normalized click subscriptions and identify; new
  `lib/map-engine-layer-data.ts` plus `lib/{vector-export.ts,scripting/scriptingApi.ts,assistant/tools.ts}`
  before → store-first snapshot recovery; boundary fixture 178 → 167 entries;
  new `tests/map-engine-layer-consumers.test.ts`.
- ArcGIS approach: ArcGIS `FeatureLayer.queryFeatures`, hit testing, layer-list
  ordering, and screenshot capture remain adapter-private. Consumers address
  only store layer ids and receive GeoJSON, normalized hits, render-target ids,
  bounds, or canvases from `MapEngineClient`.
- What changed: inline store GeoJSON always wins; renderer-held collections are
  read through `layers.readGeoJson` only when absent and remain local snapshots.
  Attribute Table no longer writes recovered data into the store. Story export
  recovers live GeoJSON/raster specs through the port; editor import uses
  queryable render targets and `queryInView`; layer/style insertion lists use
  neutral render targets; processing uses camera bbox; notebook/widget clicks
  use normalized engine events plus `queryAtLngLat`; scripting screenshots use
  `viewport.capture`; assistant and scripting layer reads share one store-first
  helper. The explicit geometry-edit action may promote a snapshot into the
  store because editing deliberately transfers authority to project state.
- Gap / limitation: transient overlay mutation, print/graticule capture,
  offline-style packaging, and first-party plugin activation still contain
  concrete renderer access assigned to Tasks 9–11. Editor/plugin callers retain
  temporary `MapController & MapEngineClient` intersections for plugin runtime
  methods, not for layer queries.
- Workaround: those remaining native paths stay on the reviewed boundary
  fixture and the package-private primary compatibility proxy. Removal criteria:
  Tasks 9–11 relocate each operation under an engine capability and delete its
  fixture entry.
- Tradeoff accepted: snapshot recovery is asynchronous for exports, scripting,
  and assistant summaries, while viewport query remains synchronous to preserve
  the editor interaction path. Both return plain GeoJSON and neither exposes or
  caches a renderer object.
- Status: done.
- Verification: `npm run build` → passed; `node --import tsx --test
  tests/engine-boundary.test.ts tests/map-engine-layer-consumers.test.ts
  tests/geo-editor-view-import.test.ts tests/map-controller.test.ts
  tests/maplibre-engine.test.ts tests/feature-selection.test.ts
  tests/sql-query-layer.test.ts` → 117 passed; `git diff --check` → passed.
- Follow-up: extract point picking, bounds drawing, markers, and transient
  overlays for Task 9, starting with the remaining application-side source/layer
  mutations.

## 2026-07-20 — MapLibre gestures, markers, and style overlays → ArcGIS-ready interaction ports

- Source: MapLibre — `Map#on` point and rubber-band gestures, navigation-handler
  toggles, `new maplibregl.Marker`, direct GeoJSON source/layer mutation,
  `styledata` restoration, and `project`/`unproject` calls used by transient
  application tools.
- Files touched: new `packages/map/src/engine/{pick-point.ts,draw-bounds.ts,markers.ts,transient-overlays.ts}`;
  `packages/map/src/engine/{types.ts,maplibre-engine.ts,handle.ts,cesium-engine.ts}`
  before → interaction lifecycle delegated adapter-side; application consumers
  in `apps/geolibre-desktop/src/components/{layout,processing}/**` plus
  `lib/print-extent.ts` before → `MapEngineClient` interaction/event/viewport
  ports; boundary fixture 167 → 154 entries; new
  `tests/map-engine-interactions.test.ts` and adapter projection coverage.
- ArcGIS approach: future `MapView`/`SceneView` adapters translate normalized
  point and drag input from `View.on`, create marker graphics, and retain
  transient geometry in adapter-owned `GraphicsLayer` instances. Consumers pass
  only WGS84 coordinates, GeoJSON, DOM marker content, and primitive style
  values; no ArcGIS `View`, `Graphic`, or layer object crosses the seam.
- What changed: point picking and click-drag bounds drawing now share
  cancellation, Escape/blur cleanup, cursor restoration, navigation locking,
  antimeridian normalization, minimum-size rejection, and optional Shift-aspect
  snapping inside the adapter. Marker handles gained rotation alignment,
  rotation updates, drag event cleanup, and safe pre-ready forwarding.
  Transient overlays retain their specs across MapLibre style replacement and
  own source/layer visibility, paint updates, dynamic property color, dash,
  removal, and destruction. GPS, remote presence, field capture,
  georeferencing, raster/basemap selection, pixel picking, recorder-region
  framing, print extent, and processing previews now use only engine ports;
  saved observations and layers still enter the store solely through explicit
  user actions.
- Gap / limitation: the neutral overlay style is intentionally smaller than a
  complete MapLibre expression/style surface, and Task 10 capture/graticule
  paths plus Task 11 plugin runtimes still require the package-private primary
  compatibility controller.
- Workaround: expose only the concrete transient styles required by migrated
  tools (`lineColorProperty`, dash, fill/line/point primitives) and keep
  renderer-specific gesture implementations adapter-private. Removal criteria:
  replace the MapLibre helper implementations with ArcGIS view/graphics
  implementations and delete the compatibility proxy after Tasks 10–11.
- Tradeoff accepted: high-frequency overlays update a retained GeoJSON source
  and reapply a small fixed paint set rather than exposing arbitrary renderer
  styles. This adds a few adapter calls per update but preserves a portable,
  enforceable contract and style-reload recovery.
- Status: done.
- Verification: `npm run build` → passed; `npm run test:frontend` → 3,412 passed,
  1 skipped, 0 failed; focused interaction/conformance/field/GPS/print/recorder
  suite → 122 passed; scoped ESLint → 0 errors (one pre-existing
  `ProcessingDialog` hook warning); `git diff --check` → passed.
- Follow-up: migrate capture, print/graticule inspection, recording, and
  offline-style packaging through Task 10 engine ports.

## 2026-07-20 — MapLibre-native external Plugin API v1 → versioned Plugin API v2 gate

- Source: MapLibre — external `GeoLibreAppAPI.getMap`, MapLibre `IControl`,
  `addMapControl`/`removeMapControl`, `getDeckGL`, and
  `getMaplibreGlRaster` access previously available to unversioned external
  plugin archives and URL manifests.
- Files touched: `packages/plugins/src/{api-version.ts,types.ts,plugin-manager.ts}`
  before → explicit v2 external manifest/export and activation context;
  `apps/geolibre-desktop/src/lib/{plugin-archive-unpack.ts,external-plugins.ts}`
  before → pre-execution validation; new
  `external-plugin-validation.ts`; `apps/geolibre-desktop/src-tauri/src/lib.rs`
  before → filesystem-manifest validation; `docs/plugin-api.md` and plugin
  validation tests.
- ArcGIS approach: expose `MapEngineClient` as the external renderer surface so
  a future `MapView` or `SceneView` adapter supplies camera, layer, viewport,
  and interaction behavior without an ArcGIS or MapLibre object crossing the
  plugin boundary.
- What changed: browser archive, URL, and Tauri filesystem loaders reject a
  missing, v1, or unknown API version with `Plugin requires Plugin API 2.`
  before fetching an entry source or executing entry code. Exported plugin and
  manifest versions must agree. `PluginManager` supplies an activation context
  that preserves the existing `restoresPanelCollapseState` behavior.
- Gap / limitation: first-party plugin runtimes still use the legacy internal
  `GeoLibreAppAPI` while their concrete MapLibre/deck.gl implementations are
  relocated beneath the adapter in the following tasks; the public type cannot
  yet be stripped without breaking those preserved runtimes.
- Workaround: version-gate all external plugins immediately and maintain the
  legacy surface only for in-repository first-party runtime migration. Removal
  criteria: every first-party renderer runtime is hosted adapter-side and the
  public API type can contain only store/UI helpers plus `MapEngineClient`.
- Tradeoff accepted: v1 external plugins now fail rather than receiving a
  compatibility native-map shim, and first-party runtime relocation is
  deliberately staged; this favors a hard external seam over short-term
  third-party compatibility.
- Status: partial.
- Verification: `node --import tsx --test tests/plugin-manager.test.ts
  tests/plugin-archive-unpack.test.ts tests/plugin-integrity.test.ts
  tests/external-plugin-assets.test.ts tests/external-plugin-api-version.test.ts`
  → 54 passed; `cargo test --manifest-path apps/geolibre-desktop/src-tauri/Cargo.toml
  external_plugins_require_api_version_two` → 1 passed; `npm run build` → passed.
- Follow-up: move the concrete built-in MapLibre control runtimes to the lazy
  adapter-owned hosted-runtime registry, then remove the legacy public native
  API types; Codex, 2026-07-20.
