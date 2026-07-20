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

## 2026-07-20 — Eager Layer Control descriptor → lazy MapLibre hosted runtime

- Source: MapLibre — the built-in Layer Control plugin directly called the
  MapLibre controller's built-in-control visibility and position methods from
  `@geolibre/plugins`, causing the plugin package to own renderer behavior.
- Files touched: `packages/plugins/src/plugins/layer-control.ts` before → thin
  `createHostedMapPlugin` descriptor; new
  `packages/plugins/src/hosted-map-plugin.ts`; moved implementation to
  `packages/map/src/maplibre-runtime/layer-control.ts`; new adapter-private
  `maplibre-runtime/{types.ts,registry.ts}`; `MapLibreEngine` before → hosted
  extension-command dispatcher; `createAppAPI` before → `MapEngineClient` host
  reference; new runtime-registry tests.
- ArcGIS approach: descriptors address `MapEngineClient.invoke` only. A future
  ArcGIS adapter can register a plugin-id runtime backed by `MapView` UI
  components without loading or exposing a MapLibre controller.
- What changed: the MapLibre runtime registry keeps implementations per engine
  instance and dynamically imports a runtime only when that plugin activates.
  The descriptor preserves its id, name, version, default active flag, and
  persisted corner position while forwarding activation, deactivation, and
  position changes through the typed hosted-plugin commands.
- Gap / limitation: only the Layer Control is relocated in this initial
  registry commit; other first-party controls still own concrete renderer code
  under `@geolibre/plugins` until their focused moves land.
- Workaround: keep the registry's narrow runtime context engine-only and add
  one concrete runtime family at a time. Removal criteria: every first-party
  renderer runtime has moved adapter-side and no plugin source imports a
  renderer SDK or native controller type.
- Tradeoff accepted: first activation incurs a dynamic-import boundary and can
  fail asynchronously, trading a small initial delay for adapter ownership and
  plugin-manager rollback rather than a permanently eager renderer bundle.
- Status: partial.
- Verification: `node --import tsx --test tests/hosted-map-runtime-registry.test.ts
  tests/plugin-manager.test.ts tests/maplibre-engine.test.ts
  tests/engine-contracts.test.ts` → 44 passed; `npm run build` → passed.
- Follow-up: relocate annotations and the remaining simple MapLibre controls
  into this registry while preserving their ids, state, and restore behavior;
  Codex, 2026-07-20.

## 2026-07-20 — Street View `IControl` plugin → adapter-private hosted runtime

- Source: MapLibre — `StreetViewControl` construction, native
  `addControl`/`removeControl`, and runtime environment credential refresh were
  implemented in the public first-party plugin module.
- Files touched: `packages/plugins/src/plugins/maplibre-streetview.ts` before
  → engine-neutral hosted descriptor; moved concrete control lifecycle to
  `packages/map/src/maplibre-runtime/streetview.ts`; runtime registry/types and
  `MapLibreEngine` before → adapter-private native-control context.
- ArcGIS approach: an ArcGIS implementation can bind the same stable plugin id
  to a lazily loaded `MapView`-owned street-level panel; application and plugin
  descriptor code has no access to either MapLibre or an ArcGIS SDK object.
- What changed: the adapter now constructs/removes the Street View control,
  repositions it, and handles runtime credential changes. The descriptor
  preserves its id, title, version, and position while sending lifecycle work
  through `MapEngineClient.invoke`.
- Gap / limitation: Street View remains a MapLibre control with provider-owned
  Google/Mapillary UI; no ArcGIS `MapView` equivalent is selected yet.
- Workaround: confine the provider-specific control and its DOM lifecycle to
  the `MapLibreEngine` runtime context. Removal criteria: replace the runtime
  with an ArcGIS-backed street-level panel with the same plugin-id contract.
- Tradeoff accepted: refreshing runtime environment credentials now flows
  through an adapter-owned context, adding an internal indirection but keeping
  native controls out of public plugin code.
- Status: partial.
- Verification: `node --import tsx --test tests/hosted-map-runtime-registry.test.ts
  tests/maplibre-engine.test.ts tests/plugin-manager.test.ts` → 41 passed;
  `npm run build` → passed.
- Follow-up: relocate the next self-contained control runtimes and retain the
  lazy registry as the only MapLibre mounting path; Codex, 2026-07-20.

## 2026-07-20 — Provider control plugins → lazy adapter-owned Web Services runtimes

- Source: MapLibre — FEMA NFHL, NASA Earthdata, EnviroAtlas, and National Map
  controls created native raster sources/layers and synchronized them with the
  project store from public plugin modules.
- Files touched: moved `maplibre-{fema-wms,nasa-earthdata,enviroatlas,national-map}.ts`
  and `web-service-sync.ts` from `packages/plugins/src/plugins/` to
  `packages/map/src/maplibre-runtime/`; originals before → hosted descriptors;
  registry/dependency manifests/lockfile and `web-service-sync` test import
  updated.
- ArcGIS approach: future adapter-specific provider panels resolve the same
  store-layer records to `MapView` layers privately. Their UI code, source
  objects, and native map operations remain behind the engine rather than a
  plugin API escape hatch.
- What changed: all four control lifecycles now dynamically load under the
  MapLibre adapter and receive native add/remove-control capability only in its
  private runtime context. The common store synchronizer moved with those
  runtimes; it still mirrors provider state into the existing store and adopts
  restored store layers without creating a second source of truth.
- Gap / limitation: each provider's MapLibre control still owns service-specific
  native layer state, including source ids and upstream panel behavior.
- Workaround: retain provider-specific state adapter-private and persist only
  normalized layer records through `@geolibre/core`. Removal criteria: an ArcGIS
  provider implementation can rebuild the same records without the MapLibre
  controls.
- Tradeoff accepted: four independently split chunks add activation latency and
  move package ownership dependencies into `@geolibre/map`, in exchange for
  eliminating renderer imports and native control calls from `@geolibre/plugins`.
- Status: partial.
- Verification: `node --import tsx --test tests/web-service-sync.test.ts
  tests/hosted-map-runtime-registry.test.ts tests/plugin-manager.test.ts
  tests/maplibre-engine.test.ts` → 55 passed; `npm run build` → passed.
- Follow-up: move remaining self-contained controls (starting with annotations,
  basemap, and Overture) and then eliminate the legacy public renderer methods;
  Codex, 2026-07-20.

## 2026-07-20 — PluginManager native-control restore hook → hosted runtime collapse contract

- Source: MapLibre — project restore previously intercepted each plugin's
  public `addMapControl` call to collapse a MapLibre panel after activation.
- Files touched: `packages/map/src/maplibre-runtime/types.ts` before → shared
  `restoreHostedControlPanel`; Street View and Web Services runtimes before →
  consume `collapsed` activation context; hosted-runtime tests updated.
- ArcGIS approach: retain the renderer-neutral activation context and let each
  adapter apply it to the equivalent `MapView` widget/panel state, without
  exposing a control object to `PluginManager`.
- What changed: `createHostedMapPlugin` forwards PluginManager's existing
  restore intent through the typed engine command. Adapter-owned controls
  collapse immediately on restore and defer regular user activation expansion
  to avoid the menu click-outside race.
- Gap / limitation: the helper only covers controls already hosted in the
  registry; unmoved legacy plugins still use the existing manager interception.
- Workaround: every subsequent hosted control calls the shared helper. Removal
  criteria: no plugin invokes public native `addMapControl`, after which the
  old manager interception and native control type can be removed.
- Tradeoff accepted: collapse behavior is now explicit in each adapter runtime
  rather than automatic at the manager boundary, adding small lifecycle code
  but preserving renderer isolation and exact restore semantics.
- Status: partial.
- Verification: `node --import tsx --test tests/hosted-map-runtime-registry.test.ts
  tests/plugin-manager.test.ts tests/maplibre-engine.test.ts` → 42 passed;
  `npm run build` → passed.
- Follow-up: include this helper in every remaining hosted control relocation;
  Codex, 2026-07-20.

## 2026-07-20 — Eager default-control lifecycle assumption → lazy adapter runtime commands

- Source: MapLibre — the active-by-default Layer Control is mounted by
  `MapController` before `PluginManager` has an app API, so restoring it as
  inactive or changing its saved corner could call a hosted runtime that had
  never been activated or imported.
- Files touched: `packages/map/src/maplibre-runtime/registry.ts` before → lazy
  lifecycle-command loading; `tests/hosted-map-runtime-registry.test.ts` before
  → active-by-default restoration coverage.
- ArcGIS approach: a future ArcGIS adapter keeps the same descriptor commands
  and resolves its lazy `MapView` widget when a default widget's first request
  is hide or reposition, without exposing the widget to PluginManager.
- What changed: the per-engine registry now lazy-loads an unloaded runtime for
  deactivation and positioning as well as activation. Deactivation is applied
  once the chunk resolves; positioning returns that the adapter accepted the
  persisted request while applying it immediately after the runtime loads.
- Gap / limitation: the current extension command shape is synchronous for
  position and void for deactivation, so a first-command chunk-load failure
  cannot be returned to PluginManager.
- Workaround: catch and report lazy lifecycle failures in the adapter; the
  persisted descriptor position remains the source of truth for a later retry.
  Removal criteria: make hosted lifecycle commands uniformly asynchronous only
  if all PluginManager callers can surface and recover from those failures.
- Tradeoff accepted: a default control can incur a one-time lazy-load delay
  during project restore, in exchange for preserving adapter ownership and
  avoiding an eager renderer runtime at application startup.
- Status: partial.
- Verification: `node --import tsx --test tests/hosted-map-runtime-registry.test.ts
  tests/plugin-manager.test.ts tests/maplibre-engine.test.ts` → 43 passed.
- Follow-up: relocate the next self-contained MapLibre controls and update the
  boundary ratchet in the same verified commit; Codex, 2026-07-20.

## 2026-07-20 — USGS LiDAR `UsgsLidarControl` → lazy MapLibre adapter runtime

- Source: MapLibre — the standalone `UsgsLidarControl` dynamically loaded a
  deck.gl-backed point-cloud viewer, directly mounted/removed a native control,
  forced the MapLibre projection to Mercator, and added the 3DEP coverage WMS
  record from `@geolibre/plugins`.
- Files touched: moved
  `packages/plugins/src/plugins/maplibre-usgs-lidar.ts` before →
  `packages/map/src/maplibre-runtime/usgs-lidar.ts`; moved the upstream type
  shim with it; original plugin module before → hosted descriptor; hosted
  registry, package manifests/lockfile, and boundary fixture updated.
- ArcGIS approach: a future adapter can pair a `PointCloudLayer`-backed viewer
  with a `WMSLayer` coverage overlay under the same plugin id, using its own
  `MapView` widget lifecycle and the normalized store-layer record.
- What changed: the adapter now owns the dynamic control import and native
  control lifecycle. Projection preference and the coverage layer continue to
  be updated through `@geolibre/core` store actions; the runtime neither changes
  ingest nor retains a competing data model. Restore collapse intent reaches
  the adapter-owned panel through `restoreHostedControlPanel`.
- Gap / limitation: the upstream LiDAR viewer is deck.gl-specific and only
  renders under its Mercator viewport assumptions; ArcGIS point-cloud service
  compatibility is not yet validated for the USGS COPC search flow.
- Workaround: retain the existing Mercator preference transition and 3DEP WMS
  store layer inside the MapLibre runtime. Removal criteria: an ArcGIS runtime
  reproduces the search/viewer interaction and store-layer semantics without
  the deck.gl control.
- Tradeoff accepted: activation now crosses both hosted-runtime and LiDAR
  dynamic-import boundaries, trading initial panel latency for a smaller startup
  bundle and no renderer SDK import in the plugin package.
- Status: partial.
- Verification: `node --import tsx --test tests/engine-boundary.test.ts
  tests/hosted-map-runtime-registry.test.ts tests/plugin-manager.test.ts
  tests/maplibre-engine.test.ts` → 44 passed; `npm run build` → passed; the
  reviewed boundary ratchet fell from 145 to 137 violations.
- Follow-up: relocate the Esri Wayback control next, preserving its normalized
  store-layer synchronization and historical release state; Codex, 2026-07-20.

## 2026-07-20 — Esri Wayback `EsriWaybackControl` → lazy MapLibre adapter runtime

- Source: MapLibre — the Historical Imagery plugin constructed and mounted
  `EsriWaybackControl`, amended native source attribution, and synchronized
  current/persistent Wayback imagery into store-layer records from
  `@geolibre/plugins`.
- Files touched: moved
  `packages/plugins/src/plugins/maplibre-esri-wayback.ts` before →
  `packages/map/src/maplibre-runtime/esri-wayback.ts`; original plugin module
  before → hosted descriptor; hosted registry, package manifests/lockfile, and
  boundary fixture updated.
- ArcGIS approach: a future adapter can represent the selected historical
  release with adapter-owned `WebTileLayer`/`ImageryLayer` equivalents and keep
  the same normalized records in the store for layer panels and persistence.
- What changed: all concrete control lifecycle, MapLibre attribution mutation,
  and release/persistent-layer reconciliation now run within the lazy adapter
  runtime. The control still updates the existing store records through its
  previous actions; the runtime does not change ingest or create a second data
  authority. Restore collapse intent is now applied through the hosted-runtime
  contract before deferred layer synchronization.
- Gap / limitation: Wayback's upstream control owns MapLibre source/layer ids
  and Esri release-specific raster implementation details that do not map
  directly to a single ArcGIS layer type.
- Workaround: preserve stable normalized store metadata (release id, URL,
  date, attribution) while confining source mutation to MapLibre. Removal
  criteria: an ArcGIS Wayback runtime can rebuild matching store records and
  attribution from the selected release without native MapLibre objects.
- Tradeoff accepted: Historical Imagery loads as a separate runtime chunk on
  first activation, trading a small delay for a strict package boundary and
  renderer-neutral plugin descriptor.
- Status: partial.
- Verification: `npm run build` → passed; `node --import tsx --test
  tests/hosted-map-runtime-registry.test.ts tests/plugin-manager.test.ts
  tests/maplibre-engine.test.ts` → 43 passed; `node --import tsx --test
  tests/engine-boundary.test.ts` → passed; the reviewed boundary ratchet fell
  from 137 to 135 violations.
- Follow-up: add stateful hosted-runtime support before moving controls whose
  persisted UI state must survive a project restore; Codex, 2026-07-20.

## 2026-07-20 — Stateful MapLibre control callbacks → serializable hosted-runtime contract

- Source: MapLibre — stateful controls such as Overture expose native
  `getState`/`setState` and sometimes require a host-specific text-export
  callback, neither of which can be retained on a renderer-neutral plugin
  descriptor.
- Files touched: `packages/map/src/engine/extensions.ts` before → state/export
  fields on typed hosted-plugin activation; `packages/map/src/maplibre-runtime/types.ts`
  before → adapter-private activation context; `packages/plugins/src/hosted-map-plugin.ts`
  before → validated state cache and text-export forwarding; hosted registry
  tests updated.
- ArcGIS approach: an ArcGIS hosted widget reports serializable widget state
  through the same callback and accepts the same project snapshot on
  activation; any `MapView`-specific export remains adapter-side.
- What changed: a descriptor can validate and cache project state without
  importing a renderer. On activation it sends that state and a state-change
  callback through `MapEngineClient`; an optional host text-export callback is
  likewise forwarded only to the adapter runtime. A loaded runtime applies
  valid state immediately, while an inactive one restores it on next activate.
- Gap / limitation: these callbacks are intentionally narrow and do not model
  arbitrary host services or native control instances.
- Workaround: add a named, typed activation field only when a concrete runtime
  needs a portable value/callback. Removal criteria: none before Phase 6; a
  future ArcGIS runtime reuses the contract instead of widening it to a native
  map escape hatch.
- Tradeoff accepted: descriptor closures retain a serializable state snapshot
  and an extra callback path, trading minor plumbing for project-restore
  fidelity and strict renderer isolation.
- Status: done.
- Verification: `node --import tsx --test tests/hosted-map-runtime-registry.test.ts
  tests/plugin-manager.test.ts tests/maplibre-engine.test.ts` → 44 passed;
  `npm run build` → passed.
- Follow-up: move Overture Maps onto this stateful hosted-runtime contract;
  Codex, 2026-07-20.

## 2026-07-20 — Overture Maps control/store mirror → stateful lazy MapLibre runtime

- Source: MapLibre — `OvertureMapsControl` owned PMTiles theme layers, native
  control mounting, panel state, and a bidirectional custom-layer store mirror
  in the first-party plugin package.
- Files touched: moved
  `packages/plugins/src/plugins/maplibre-overture-maps.ts` before →
  `packages/map/src/maplibre-runtime/overture-maps.ts`; original plugin module
  before → stateful hosted descriptor; hosted registry, package manifests/
  lockfile, and boundary fixture updated.
- ArcGIS approach: a future adapter can build theme-specific `VectorTileLayer`
  instances or a custom layer view behind an ArcGIS widget, reporting the same
  serializable theme/release/panel state and normalized store-layer records.
- What changed: the adapter now owns Overture's native PMTiles layer/control
  lifecycle, state-event reporting, and desktop text-export bridge. The
  existing store synchronizer still mirrors control visibility/opacity into
  normalized external-native custom layers and adopts Layer Panel edits; it
  remains the application source of truth and data ingest is unchanged.
- Gap / limitation: Overture's per-theme PMTiles source/layer-id mechanics and
  its deck/MapLibre rendering implementation have no validated ArcGIS
  equivalent yet.
- Workaround: retain the MapLibre-specific reconciler inside the adapter and
  persist only renderer-neutral state plus store records. Removal criteria: an
  ArcGIS implementation recreates the theme/release semantics and passes the
  same store-state/restore tests without MapLibre source ids.
- Tradeoff accepted: state changes travel through one extra callback and first
  activation loads a dedicated runtime chunk, trading small bookkeeping and
  delay for exact project persistence without renderer imports in plugins.
- Status: partial.
- Verification: `npm run build` → passed; `node --import tsx --test
  tests/engine-boundary.test.ts tests/hosted-map-runtime-registry.test.ts
  tests/plugin-manager.test.ts tests/maplibre-engine.test.ts` → 45 passed; the
  reviewed boundary ratchet fell from 135 to 134 violations.
- Follow-up: relocate the next controls that depend on adapter-owned map
  callbacks, starting with Basemap Control; Codex, 2026-07-20.

## 2026-07-20 — Reverse Geocode `Map.on`/`Popup` → MapEngine click and popup ports

- Source: MapLibre — Reverse Geocode directly registered a `map.on("click")`
  handler, changed `map.getCanvas().style.cursor`, and lazy-imported
  `maplibregl.Popup` to render/update/remove the lookup result.
- Files touched: `packages/plugins/src/plugins/maplibre-reverse-geocode.ts`
  before → MapEngine-only plugin lifecycle; `packages/map/src/engine/types.ts`
  before → popup close lifecycle callback; `packages/map/src/engine/maplibre-engine.ts`
  before → MapLibre adapter implementation; reverse-geocode and engine-boundary
  tests before → MapEngine fakes and lower reviewed baseline.
- ArcGIS approach: a future ArcGIS adapter maps the normalized click subscription
  to `MapView.on("click")` and the popup lifecycle to `MapView.popup.open()` /
  close events, keeping the plugin dependent only on the MapEngine contract.
- What changed: the plugin now receives normalized `LngLat` tuples through
  `app.map.on`, obtains its cursor element through `viewport.getElement()`, and
  uses `interactions.showPopup`/`closePopup` with a stable popup id. An optional
  `onClose` callback was added to the typed interaction port and implemented in
  the MapLibre adapter, so a lookup that resolves after the user closes its
  popup cannot reopen it. Geocoder requests remain untouched and no data is
  persisted outside the existing store.
- Gap / limitation: ArcGIS popup content and close event behavior have not yet
  been implemented by an ArcGIS MapEngine adapter.
- Workaround: preserve the existing custom DOM popup as a renderer-neutral
  interaction payload and translate it adapter-side. Removal criteria: replace
  the MapLibre implementation when the ArcGIS adapter passes the same click,
  close-during-fetch, and teardown tests through `MapView.popup`.
- Tradeoff accepted: popup content is rebuilt for the loading/result states and
  the MapEngine gains one lifecycle callback, trading small port surface area
  for no direct renderer import in the plugin package and correct async closure
  handling.
- Status: partial.
- Verification: `node --import tsx --test tests/reverse-geocode.test.ts
  tests/engine-boundary.test.ts tests/engine-contracts.test.ts
  tests/maplibre-engine.test.ts` → 15 passed; `npm run build` → passed; the
  reviewed engine-boundary baseline fell from 134 to 133 violations.
- Follow-up: relocate Basemap Control through the lazy adapter runtime while
  retaining the store as the basemap source of truth; Codex, 2026-07-20.

## 2026-07-20 — Basemap Control native lifecycle → lazy MapLibre adapter runtime

- Source: MapLibre — `maplibre-gl-basemap-control` directly constructed its
  native control in the plugin package, mounted it on the native map, and
  synchronized style/raster selections through the public app API.
- Files touched: moved
  `packages/plugins/src/plugins/maplibre-basemap-control.ts` before →
  `packages/map/src/maplibre-runtime/basemap-control.ts`; original plugin file
  before → renderer-neutral descriptor; hosted-runtime registry, extension
  activation types, workspace manifests/lockfile, public exports, tests, and
  boundary baseline updated.
- ArcGIS approach: a future ArcGIS hosted widget will use `Map`/`MapView`
  basemap assignment for style choices and `WebTileLayer` records for stacked
  raster basemaps, while receiving the same typed hosted-runtime activation
  command and normalized store state.
- What changed: the descriptor now invokes only typed `MapEngineClient`
  hosted-plugin commands and supplies the translated confirmation callback.
  The lazy adapter runtime owns the native control, provider credentials,
  native events, and native mount lifecycle. It reads/writes the existing
  background-style and layer store actions directly; stacked raster basemap
  records remain store-authoritative and data ingest is unchanged.
- Gap / limitation: MapLibre's provider menu, style URL substitution, and
  stacked-raster control behavior have not been validated against an ArcGIS
  widget equivalent.
- Workaround: keep the MapLibre-specific provider/control reconciliation inside
  the adapter and preserve only normalized style/layer records plus a narrow
  confirmation callback at the seam. Removal criteria: replace the runtime
  when an ArcGIS widget passes the same store-sync, restore, and style-replace
  confirmation tests without MapLibre source or layer ids.
- Tradeoff accepted: the adapter duplicates a small store-layer builder and
  first activation loads a dedicated runtime chunk, trading minor maintenance
  and startup delay for store authority and no renderer imports in the plugin
  package.
- Status: partial.
- Verification: `node --import tsx --test tests/basemap-control-plugin.test.ts
  tests/engine-boundary.test.ts tests/hosted-map-runtime-registry.test.ts
  tests/plugin-manager.test.ts tests/maplibre-engine.test.ts` → 48 passed;
  `npm run build` → passed; the reviewed engine-boundary baseline fell from
  133 to 132 violations.
- Follow-up: relocate another first-party MapLibre plugin that still reaches a
  native map object; Codex, 2026-07-20.

## 2026-07-20 — Sun Simulation canvas/light renderer → lazy MapLibre runtime

- Source: MapLibre — the Sun Simulation plugin directly used a MapLibre
  `CanvasSource`, raster layer, `Map#setLight`, style-data listener, and
  animation frame loop beside its renderer-neutral solar clock and panel state.
- Files touched: `packages/plugins/src/plugins/maplibre-sun.ts` before →
  renderer-neutral descriptor/state façade;
  `packages/map/src/maplibre-runtime/sun.ts` added for native rendering;
  `packages/core/src/sun-simulation.ts` added for shared pure model; core
  exports, hosted-runtime registry, tests, and boundary fixture updated.
- ArcGIS approach: a future ArcGIS adapter can drive
  `SceneView.environment.lighting` from the shared clock and render the night
  mask through an adapter-owned `MediaLayer` or graphics overlay, while keeping
  the same normalized plugin state and hosted-runtime callback.
- What changed: pure astronomy, settings normalization, and panel subscriptions
  remain renderer-neutral. The descriptor invokes only typed hosted-plugin
  commands; the lazy MapLibre runtime owns canvas/source/layer lifecycle,
  style restoration, scene-light restoration, and RAF playback. Runtime clock
  updates report normalized settings through the existing typed state callback.
  No map data is ingested or persisted by this feature.
- Gap / limitation: ArcGIS has different 2D canvas-overlay and 3D environment
  lighting models; the `MediaLayer`/graphics implementation has not yet been
  prototyped or matched for mask resampling and light restoration.
- Workaround: retain the MapLibre renderer only inside its lazy runtime and
  share the clock/astronomy contract through `@geolibre/core`. Removal criteria:
  replace that runtime when an ArcGIS adapter passes the same state restore,
  animation, style-reload, and previous-light restoration tests.
- Tradeoff accepted: a small pure module is now shared by core and the adapter,
  and first activation loads a runtime chunk, trading minor module plumbing and
  a short delay for strict renderer isolation and reusable ArcGIS input state.
- Status: partial.
- Verification: `node --import tsx --test tests/sun-simulation.test.ts
  tests/engine-boundary.test.ts tests/hosted-map-runtime-registry.test.ts
  tests/plugin-manager.test.ts tests/maplibre-engine.test.ts` → 58 passed;
  `npm run build` → passed; the reviewed engine-boundary baseline fell from
  132 to 131 violations.
- Follow-up: move another first-party renderer-owning plugin into a lazy
  adapter runtime; Codex, 2026-07-20.

## 2026-07-20 — Weather raster `setTiles`/error listener → MapEngine layer port

- Source: MapLibre — shared Clouds/Precipitation playback directly obtained a
  `RasterTileSource` to call `setTiles()` and registered a native `Map#error`
  listener to pause after a source-specific failure burst.
- Files touched: `packages/plugins/src/plugins/weather-layer.ts` before →
  MapEngine layer/event operations; `packages/map/src/engine/types.ts`, handle,
  MapLibre and Cesium adapters before → typed `setRasterTiles` support and
  normalized source id; engine, weather, consumer, and boundary tests updated.
- ArcGIS approach: an ArcGIS adapter can update an adapter-owned `WebTileLayer`
  URL/template (or replace its layer source) through the same `setRasterTiles`
  port and normalize layer load errors from `LayerView`/layer events.
- What changed: weather playback now asks `app.map.layers` to replace a live
  raster's templates and subscribes through `app.map.on("error")`. The MapLibre
  adapter resolves the private source and calls `RasterTileSource#setTiles`; it
  also exposes MapLibre's `sourceId` as the normalized error source. Frame
  discovery, fetches, store synchronization, persistence, and activation
  behavior remain unchanged, so the store is still authoritative and data
  ingest was not touched.
- Gap / limitation: ArcGIS tile-template replacement and source-load error
  attribution differ by layer class and have not been implemented or
  conformance-tested yet.
- Workaround: keep the precise MapLibre mutation inside the adapter while the
  portable port describes only an already-rendered logical raster layer and its
  templates. Removal criteria: an ArcGIS adapter updates weather frames and
  triggers the same source-specific circuit-breaker tests without MapLibre ids.
- Tradeoff accepted: the core layer port grows by one focused write operation
  and Cesium currently reports it unsupported, trading a small contract cost
  for store-first playback without a native map escape hatch.
- Status: partial.
- Verification: `node --import tsx --test tests/weather-layer.test.ts
  tests/maplibre-engine.test.ts tests/engine-contracts.test.ts
  tests/engine-boundary.test.ts tests/map-engine-layer-consumers.test.ts` → 25
  passed; `npm run build` → passed; the reviewed engine-boundary baseline fell
  from 131 to 130 violations.
- Follow-up: move the next first-party plugin that still imports a concrete
  renderer; Codex, 2026-07-20.

## 2026-07-20 — Directions `MapLibreGlDirections` session/control → ArcGIS `RouteTask` + `GraphicsLayer`

- Source: MapLibre — the Directions plugin directly lazy-imported
  `@maplibre/maplibre-gl-directions`, constructed its interactive native session,
  attached a `LoadingIndicatorControl`, and owned native waypoint/route events.
- Files touched: `packages/plugins/src/plugins/maplibre-directions.ts` before →
  renderer-neutral descriptor and banner-state façade;
  `packages/map/src/maplibre-runtime/directions.ts` added for the native runtime;
  `packages/core/src/directions.ts` added for shared structural route metrics;
  hosted-runtime registry, typed extension map, MapLibre/Cesium adapters,
  workspace manifests/lockfile, contract fakes, directions tests, and boundary
  fixture updated.
- ArcGIS approach: a future ArcGIS adapter will use `RouteTask.solve()` for
  routing, `GraphicsLayer` route/stop graphics, and `MapView.on("click")` for
  interaction. It can preserve the same renderer-neutral route summary and
  `directions.remove-last` / `directions.clear` commands without exposing an
  ArcGIS object to the plugin or banner.
- What changed: the descriptor now activates/deactivates only through the typed
  hosted-runtime commands, accepts validated transient session snapshots, and
  sends remove/clear actions through named `MapEngine` extensions. The lazy
  adapter runtime owns the MapLibre Directions import, map instance, loading
  control, native events, route request cancellation, and teardown. The
  plugin's active state remains owned by the existing PluginManager/store path;
  waypoint and route values are intentionally transient session UI state, as
  before. Data ingest and persisted layer records were not changed.
- Gap / limitation: MapLibre Directions supplies a ready-made interactive UI and
  default OSRM demo-server workflow, while ArcGIS separates click/stop editing,
  `RouteTask` solving, and route graphics; equivalent no-key routing behavior
  also needs an explicit provider choice.
- Workaround: keep the MapLibre-specific interactive session inside the lazy
  adapter runtime and expose only normalized metrics and two typed commands.
  Removal criteria: replace it when an ArcGIS runtime provides the same
  add/drag/remove, cancellation, route-loading, and teardown behavior through
  `RouteTask`/graphics tests without MapLibre imports or native handles.
- Tradeoff accepted: the seam gains two focused extension commands and the
  banner receives state through a callback, trading a little contract and
  lifecycle plumbing for strict renderer isolation; first activation loads a
  dedicated Directions runtime chunk.
- Status: partial.
- Verification: `node --import tsx --test tests/directions.test.ts
  tests/engine-boundary.test.ts tests/engine-contracts.test.ts
  tests/hosted-map-runtime-registry.test.ts tests/plugin-manager.test.ts
  tests/maplibre-engine.test.ts` → 58 passed; `npm run build` → passed (the
  normal JupyterLite-unavailable notice and browser externalization warnings
  remained non-fatal); the reviewed engine-boundary baseline fell from 130 to
  129 violations.
- Follow-up: relocate the next first-party plugin that still imports a concrete
  renderer; Codex, 2026-07-20.

## 2026-07-20 — Earth Engine `PluginControl` → ArcGIS `WebTileLayer` + custom authentication UI

- Source: MapLibre — the toolbar-owned Earth Engine panel directly constructed
  `maplibre-gl-earth-engine`'s `PluginControl`, mounted/hidden it as a native
  control, and patched its private layer hooks to mirror raster records into
  the GeoLibre store.
- Files touched: `packages/plugins/src/plugins/maplibre-earth-engine.ts` before
  → renderer-neutral toolbar façade;
  `packages/map/src/maplibre-runtime/earth-engine.ts` added for native control,
  private hooks, and store reconciliation; Earth Engine OAuth helper/type
  declaration moved from `packages/plugins` before → an adapter-owned
  `@geolibre/map/earth-engine-auth` subpath shared by GeoAgent; hosted-runtime
  registry, extension map, MapLibre/Cesium adapters, workspace manifests/
  lockfile, Rust source comment, contract fakes, Earth Engine test, and boundary
  fixture updated.
- ArcGIS approach: a future adapter can render authenticated Earth Engine tile
  templates with an adapter-owned `WebTileLayer` (or `ImageryLayer` where a
  compatible image service exists) and build a dedicated OAuth/script workflow
  with ArcGIS widgets or Calcite UI. This keeps the toolbar on the same typed
  lifecycle and visibility contract while the renderer selects its provider.
- What changed: opening the panel now lazily activates the MapLibre hosted
  runtime; hiding it sends the typed `earth-engine.hide` command; teardown uses
  the existing hosted-plugin lifecycle. The runtime dynamically imports and
  subclasses `PluginControl`, owns its native DOM/control lifecycle and private
  callbacks, and retains the prior bidirectional `useAppStore` layer sync, so
  store records remain authoritative. OAuth behavior, GeoAgent's shared auth
  functions, generated raster records, and data ingest are unchanged.
- Gap / limitation: ArcGIS has no equivalent to the MapLibre control's bundled
  Earth Engine script editor, asset workflow, and default authentication UI;
  Earth Engine tiles remain a third-party provider rather than a native ArcGIS
  analysis service.
- Workaround: isolate the existing control and its undocumented private-member
  bridge in the lazy MapLibre runtime while exposing only visibility through the
  seam. Removal criteria: replace it once an ArcGIS adapter can authenticate,
  create/store-sync Earth Engine tile layers, run the supported scripts, and
  pass the same layer add/remove/opacity/visibility/teardown tests without
  `PluginControl` or MapLibre types.
- Tradeoff accepted: `@geolibre/map` now exposes a narrow, renderer-adjacent
  OAuth helper subpath for GeoAgent and owns the Earth Engine/Tauri dependencies;
  that package wiring and one typed hide command trade modest complexity for
  strict lazy renderer isolation and preservation of store authority.
- Status: partial.
- Verification: `node --import tsx --test tests/earth-engine-plugin.test.ts
  tests/engine-boundary.test.ts tests/engine-contracts.test.ts
  tests/hosted-map-runtime-registry.test.ts tests/plugin-manager.test.ts
  tests/maplibre-engine.test.ts` → 49 passed; `npm run build` → passed (normal
  JupyterLite-unavailable notice and browser externalization warnings were
  non-fatal); the production build emitted separate `earth-engine`,
  `earth-engine-auth`, `maplibre-earth-engine`, and browser-SDK chunks; the
  reviewed engine-boundary baseline fell from 129 to 128 violations.
- Follow-up: relocate the next first-party plugin that still imports a concrete
  renderer; Codex, 2026-07-20.

## 2026-07-20 — GeoAgent `GeoAgentControl`/native overlays → ArcGIS agent commands + `GraphicsLayer`

- Source: MapLibre — the GeoAgent plugin directly lazy-loaded
  `maplibre-gl-geoagent`, accessed its private MapLibre/Earth Engine tool
  surface, mounted the native control, and synchronized its native overlay
  registry to store records.
- Files touched: `packages/plugins/src/plugins/maplibre-geoagent.ts` before →
  generic renderer-neutral hosted descriptor;
  `packages/map/src/maplibre-runtime/geoagent.ts` and
  `geoagent-layer-sync.ts` added for native control/tool lifecycle and store
  mirror; hosted-runtime registry, workspace manifests/lockfile, existing
  GeoAgent sync-test import, and boundary fixture updated.
- ArcGIS approach: a future agent adapter should translate approved agent
  actions into `MapView` operations and adapter-owned `GraphicsLayer`,
  `FeatureLayer`, and `WebTileLayer` records. The outer plugin remains a typed
  hosted descriptor, so an ArcGIS implementation can retain activation,
  positioning, rollback, and store-sync behavior without exposing `MapView` to
  the agent package.
- What changed: the public plugin now delegates all lifecycle and position work
  through `MapEngineClient`'s hosted-plugin commands. The lazy MapLibre runtime
  owns the GeoAgent control, MapLibre/Earth Engine imports, private tool patches,
  OAuth enhancement, projection-independent native overlay mutations, and the
  previous bidirectional store reconciliation. Agent-created layer records stay
  store-authoritative; no data-ingest entry point or project schema changed.
- Gap / limitation: the upstream GeoAgent tool runner emits MapLibre-specific
  commands and exposes an undocumented overlay registry, while ArcGIS has no
  drop-in equivalent for its script execution, layer ids, or Earth Engine
  integration.
- Workaround: isolate that control, its private types, and its overlay registry
  inside the lazy adapter runtime while preserving normalized `GeoLibreLayer`
  records at the boundary. Removal criteria: replace it once an ArcGIS-native
  agent maps the supported tools to graphics/layers and passes the existing
  add/remove/kind-switch/visibility/opacity/store-selection tests without
  MapLibre or deck.gl handles.
- Tradeoff accepted: the adapter now co-locates a substantial store-mirror
  helper and relies on the same upstream private tool fields, trading some
  adapter maintenance for a standard public descriptor and strict renderer
  isolation.
- Status: partial.
- Verification: `node --import tsx --test tests/geoagent-layer-sync.test.ts
  tests/engine-boundary.test.ts tests/engine-contracts.test.ts
  tests/hosted-map-runtime-registry.test.ts tests/plugin-manager.test.ts
  tests/maplibre-engine.test.ts` → 70 passed; `npm run build` → passed (normal
  JupyterLite-unavailable notice and browser externalization warnings were
  non-fatal); the build retained dedicated GeoAgent runtime chunks; the reviewed
  engine-boundary baseline fell from 128 to 125 violations.
- Follow-up: relocate the next first-party plugin that still imports a concrete
  renderer; Codex, 2026-07-20.

## 2026-07-20 — Planetary Computer `PlanetaryComputerControl`/TiTiler raster sources → ArcGIS `WebTileLayer` or `ImageryLayer`

- Source: MapLibre — `maplibre-gl-planetary-computer`'s native
  `PlanetaryComputerControl`, `STACClient`, `TiTilerClient`, direct
  `map.addSource`/`addLayer`, and private control layer-manager state used to
  replay saved raster layers with stable GeoLibre IDs.
- Files touched: `packages/plugins/src/plugins/maplibre-planetary-computer.ts`
  before → renderer-neutral lifecycle façade;
  `packages/map/src/maplibre-runtime/planetary-computer.ts` added for the
  MapLibre control, STAC/TiTiler clients, native source/layer restore, and
  store mirror; hosted-runtime registry, workspace manifests/lockfile, boundary
  fixture, and `tests/planetary-computer-plugin.test.ts` added/updated.
- ArcGIS approach: a future adapter should create adapter-owned `WebTileLayer`
  records from TiTiler URLs, using `ImageryLayer` only where the provider
  exposes a compatible image service. The current app-facing façade needs only
  the typed hosted lifecycle, so that provider choice remains adapter-private.
- What changed: opening and closing the Processing-menu panel now activates or
  deactivates the lazy MapLibre hosted runtime. Project restoration first checks
  for normalized Planetary Computer store layers, then sends a private hosted
  activation request to replay them. The adapter retains the prior native
  control lifecycle, stable-ID restoration, private upstream layer-manager
  bridge, and bidirectional visible/opacity store synchronization; data ingest
  and the `GeoLibreLayer` project representation are unchanged.
- Gap / limitation: ArcGIS has no drop-in equivalent to the upstream Planetary
  Computer control's STAC search UX, TiTiler URL generation, or undocumented
  layer-manager registry needed to reattach a saved layer under its original
  native ID.
- Workaround: isolate the control and its version-pinned private API usage in a
  lazy MapLibre runtime while preserving only normalized, store-authoritative
  raster records at the seam. Removal criteria: replace it when an ArcGIS
  runtime can search/select the supported STAC sources, create equivalent tile
  layers, preserve project restore IDs/order/opacity/visibility, and pass the
  same teardown tests without MapLibre control internals.
- Tradeoff accepted: the adapter keeps the existing private upstream restore
  bridge and owns the Planetary Computer dependency, trading ongoing dependency
  compatibility checks for lazy loading and a strict renderer boundary.
- Status: partial.
- Verification: `node --import tsx --test tests/planetary-computer-plugin.test.ts
  tests/hosted-map-runtime-registry.test.ts tests/engine-contracts.test.ts
  tests/maplibre-engine.test.ts tests/engine-boundary.test.ts` → 17 passed;
  `npm run build` → passed (normal JupyterLite-unavailable notice and browser
  externalization warnings were non-fatal); the production build emitted a
  separate `planetary-computer` runtime chunk; the reviewed engine-boundary
  baseline fell from 125 to 124 violations.
- Follow-up: relocate the next first-party plugin that still imports a concrete
  renderer; Codex, 2026-07-20.

## 2026-07-20 — MapLibre globe canvas overlays → ArcGIS `SceneView` `RenderNode`

- Source: MapLibre — the Atmospheric Effects plugin's direct `maplibregl.Map`
  canvas/container access, `move`/`resize` events, globe projection checks, and
  layered DOM canvases used for the starfield, comets, and atmosphere halo.
- Files touched: `packages/plugins/src/plugins/maplibre-effects.ts` before →
  renderer-neutral settings façade; `packages/core/src/effects-settings.ts`
  added for the serializable settings model; `packages/map/src/maplibre-runtime/effects.ts`
  added for MapLibre canvas/globe behavior; hosted-runtime registry, core index,
  ellipse-test import, boundary fixture, and `tests/effects-plugin.test.ts`
  added/updated.
- ArcGIS approach: a future 3D adapter should implement the globe-bound visual
  effect as a `SceneView` `RenderNode` (or a dedicated external-renderer
  equivalent), using SceneView camera/view state instead of MapLibre DOM canvas
  stacking. A future 2D variant can use a `BaseLayerViewGL2D` only if the effect
  remains a required product capability.
- What changed: the plugin now owns only normalized serializable settings and
  invokes hosted lifecycle/state commands. The lazy MapLibre runtime owns every
  concrete map/canvas/event operation and rebinds to a reinitialized map. The
  active-by-default restore helper no longer loads a runtime when effects are
  inactive. Store/project settings remain the authority and no data ingest code
  changed.
- Gap / limitation: MapLibre permits z-indexed DOM canvases beneath its globe;
  ArcGIS SceneView has a managed WebGL render pipeline and no like-for-like DOM
  canvas layer at the same depth.
- Workaround: keep the existing stacked-canvas renderer private to the MapLibre
  runtime while preserving the settings model independently. Removal criteria:
  replace it when a SceneView render node reproduces the desired globe-only
  ordering, camera tracking, resize/visibility lifecycle, and settings behavior
  without MapLibre containers or events.
- Tradeoff accepted: settings now flow through a small façade/runtime state
  handshake and the legacy canvas technique remains MapLibre-specific, trading
  a little lifecycle indirection for lazy loading and strict renderer isolation.
- Status: partial.
- Verification: `node --import tsx --test tests/effects-settings.test.ts
  tests/globe-halo-ellipse.test.ts tests/effects-plugin.test.ts
  tests/hosted-map-runtime-registry.test.ts tests/engine-contracts.test.ts
  tests/maplibre-engine.test.ts tests/engine-boundary.test.ts` → 30 passed;
  `npm run build` → passed (normal JupyterLite-unavailable notice and browser
  externalization warnings were non-fatal); the production build emitted a
  separate `effects` runtime chunk; the reviewed engine-boundary baseline fell
  from 124 to 123 violations.
- Follow-up: relocate the next first-party plugin that still imports a concrete
  renderer; Codex, 2026-07-20.
