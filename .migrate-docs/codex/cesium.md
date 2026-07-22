# Cesium migration log — codex

## 2026-07-20 — React-owned `Cesium.Viewer` → lazy `CesiumEngine` adapter

- Source: Cesium — `CesiumCanvas` directly owned the dynamic Cesium import,
  asset setup, `Viewer`, camera events, input classification, world terrain,
  and `CesiumLayerSync` lifecycle.
- Files touched: `packages/map/src/CesiumCanvas.tsx` before → engine-neutral
  compatibility host; new `packages/map/src/engine/cesium-engine.ts`;
  `packages/map/src/engine/types.ts`, `packages/map/src/engine/registry.ts`, and
  `packages/map/src/index.ts` before → typed capability error and lazy Cesium
  registration; new `tests/cesium-engine.test.ts`.
- ArcGIS approach: isolate the current globe behind the same contract that a
  future ArcGIS `SceneView` adapter will implement. Asset preparation, token
  handling, viewer construction, camera conversion, layer reconciliation, and
  native events remain private to the lazy adapter.
- What changed: `CesiumEngine` owns mount/destroy, camera round-tripping and
  echo suppression, user-driven event classification, supported-layer sync,
  terrain setup, and cleanup during dynamic imports. `CesiumCanvas` now reads
  and writes the store only through engine-neutral methods/events.
- Gap / limitation: the existing Cesium path has no engine-neutral capture,
  controls, identify, marker, popup, or transient-overlay implementation.
- Workaround: `supports()` reports false and each corresponding call throws
  `MapEngineCapabilityError` with the engine id and capability. Removal
  criteria: an ArcGIS `SceneView` adapter implements and conformance-tests that
  capability, or product requirements explicitly retain it as unsupported.
- Tradeoff accepted: unsupported operations fail loudly instead of silently
  degrading, so consumers must capability-check when a globe pane is active.
- Status: done.
- Verification: `node --import tsx --test tests/cesium-engine.test.ts
  tests/cesium-camera.test.ts tests/cesium-layer-sync.test.ts
  tests/engine-boundary.test.ts` → 38 passed; scoped strict TypeScript and ESLint
  checks → passed; `git diff --check` → passed.
- Follow-up: register both current adapters in the common conformance suite,
  then replace concrete React hosts with `EngineCanvas`.

## 2026-07-21 — Cesium range/heading camera → ArcGIS `SceneView` zoom/heading/tilt camera

- Source: Cesium — `cesium-camera.ts` converts `MapViewState` through a metric
  camera range and Cesium's horizon-referenced pitch before reading it back.
- Files touched: new `packages/map/src/engine/arcgis-scene-camera.ts`; new
  `tests/arcgis-scene-camera.test.ts`.
- ArcGIS approach: use the installed ArcGIS SDK's documented `SceneView.zoom`
  plus `goTo({ center, zoom, heading, tilt })`; its camera tilt is already
  nadir-referenced, so it maps directly from the store pitch.
- What changed: introduced pure store ↔ SceneView camera conversion, including
  angle normalization, a 0–85° tilt guard, invalid-snapshot fallback, and
  floating-point echo suppression.
- Gap / limitation: a `SceneView` can alter scale/camera state while resolving
  elevation, so exact metric parity with Cesium's range-based conversion is not
  guaranteed.
- Workaround: use the public SceneView zoom/camera fields and suppress only
  negligible floating-point echoes. Removal criteria: replace this helper only
  if a tested SceneView scale mismatch requires a measured range conversion.
- Tradeoff accepted: keeps the adapter simple and lazy at the cost of deferring
  elevation-aware camera-parity calibration until real SceneView validation.
- Status: partial.
- Verification: `node --import tsx --test tests/arcgis-scene-camera.test.ts` →
  3 passed.
- Follow-up: use this helper in the lazy `ArcGISSceneEngine` and test it against
  the existing MapEngine conformance contract.

## 2026-07-21 — Cesium `Viewer` secondary globe → lazy ArcGIS `SceneView` opt-in

- Source: Cesium — `CesiumEngine` renders the token-gated secondary 3D globe
  through `EngineCanvas`, with store-owned layers and camera events.
- Files touched: new `packages/map/src/engine/arcgis-scene-engine.ts`; updated
  `packages/map/src/engine/{types,registry}.ts`, `packages/map/src/{EngineCanvas,index}.ts`,
  `apps/geolibre-desktop/src/components/layout/MapGrid.tsx`, and
  `tests/{arcgis-engine-fake,arcgis-scene-engine,engine-conformance,engine-registry}.test.ts`;
  updated `e2e/engine-param.spec.ts`.
- ArcGIS approach: lazy-load public `@arcgis/core/views/SceneView` plus `Map`,
  `Basemap`, `WebTileLayer`, `GeoJSONLayer`, `WMSLayer`, and `WMTSLayer`; use
  `reactiveUtils.watch(() => view.stationary)` for navigation completion.
- What changed: added the `arcgis-scene` MapEngine adapter. It configures the
  existing local ArcGIS asset path, retains native OSM and Esri attribution,
  rebuilds SceneView layers exclusively from store snapshots, enters the shared
  conformance suite, and is selected for secondary globe panes only with
  `?sceneEngine=arcgis`. Cesium remains the default and fallback.
- Gap / limitation: Cesium `3d-tiles` URLs are not yet translated. ArcGIS
  `SceneLayer` versus `IntegratedMeshLayer` selection requires I3S service
  metadata and cannot safely be guessed from a generic Cesium 3D Tiles URL.
- Workaround: the SceneView adapter advertises only GeoJSON/raster/XYZ/WMS/WMTS
  support and labels unsupported 3D Tiles as 2D-only in the pane menu. Removal
  criteria: implement an I3S metadata probe with explicit `SceneLayer` /
  `IntegratedMeshLayer` tests.
- Tradeoff accepted: SceneView is a lazy opt-in but adds an approximately 814 kB
  uncompressed SceneView chunk when requested; no API key or Cesium Ion token
  is needed for the keyless OSM baseline.
- Status: partial.
- Verification: `node --import tsx --test tests/arcgis-scene-camera.test.ts
  tests/arcgis-scene-engine.test.ts tests/engine-conformance.test.ts
  tests/engine-registry.test.ts` → 35 passed; `npm run build` → passed;
  `npx playwright test e2e/engine-param.spec.ts -g "SceneView" --reporter=line`
  → 1 passed in headless Chromium, with zero diagnostic errors.
- Follow-up: add I3S 3D-layer support and an elevation/API-key path before
  replacing Cesium as the secondary-globe default.

## 2026-07-21 — Cesium globe picking → ArcGIS `SceneView.hitTest`

- Source: Cesium — the secondary globe had no seam-level feature-picking
  implementation; store-backed GeoJSON was therefore rendered but could not be
  identified through the shared `MapEngine` query contract.
- Files touched: new `packages/map/src/engine/arcgis-feature-query.ts`; updated
  `packages/map/src/engine/arcgis-scene-engine.ts`,
  `packages/map/src/engine/registry.ts`, and ArcGIS adapter/conformance tests
  under `tests/` before → SceneView feature-query capability.
- ArcGIS approach: use documented `SceneView.hitTest(point, { include })` with
  the adapter's own `GeoJSONLayer` instances, then translate only `graphic`
  results into store-owned neutral DTOs.
- What changed: SceneView GeoJSON serialization carries a private feature
  index; `hitTest` and `layers.queryAtLngLat` resolve it against the store
  snapshot. The adapter now advertises `feature-query` while keeping all
  renderer objects private.
- Gap / limitation: 3D Tiles, terrain intersections, raster/WMS/WMTS results,
  highlights, and popups remain unsupported; SceneView may also omit graphics
  occluded by ground according to its documented hit-test behavior.
- Workaround: restrict inclusion and result translation to known store GeoJSON
  layers. Removal criteria: add explicit, conformance-tested DTO mappings for
  each additional layer family or interaction behavior.
- Tradeoff accepted: the 3D adapter deliberately returns no generic ground or
  SDK-layer results, favoring store fidelity over broad but renderer-specific
  picking.
- Status: partial.
- Verification: `node --import tsx --test tests/arcgis-map-engine.test.ts
  tests/arcgis-scene-engine.test.ts tests/engine-conformance.test.ts
  tests/engine-registry.test.ts` → 36 passed; `npm run lint -- --quiet` →
  passed; `npm run build` → passed (normal JupyterLite-unavailable notice and
  browser-externalization warnings were non-fatal).
- Follow-up: assess explicit I3S and terrain result DTOs before enabling any
  3D-layer picking beyond GeoJSON; Codex, 2026-07-21.

## 2026-07-21 — Cesium overlay popup gap → ArcGIS `SceneView.openPopup`

- Source: Cesium — the seam-level secondary-globe path had no popup capability,
  so renderer-neutral tools could not present their existing DOM content in an
  ArcGIS 3D pane.
- Files touched: `packages/map/src/engine/arcgis-scene-engine.ts`,
  `packages/map/src/engine/registry.ts`, and ArcGIS adapter/conformance tests
  under `tests/` before → SceneView popup capability and deterministic view fake.
- ArcGIS approach: call documented `SceneView.openPopup({ location, content })`
  and `closePopup()`, observing the public popup `visible` property through
  `reactiveUtils.watch` for user closure.
- What changed: the SceneView adapter accepts the neutral DOM-content popup
  command, owns one active popup, maps its anchor to the documented location,
  and forwards user/programmatic closure only through `onClose`.
- Gap / limitation: SceneView offers one popup per view; no equivalent for
  multiple Cesium overlay popups, per-call MapLibre max width, or close-on-click
  policy is implemented.
- Workaround: automatic feature popups are disabled and the adapter serializes
  one application-owned popup lifecycle. Removal criteria: define and test a
  product-level multi-popup policy using supported SceneView APIs.
- Tradeoff accepted: native ArcGIS popup layout and docking may differ from the
  former overlay appearance, but preserves SDK keyboard and close semantics.
- Status: partial.
- Verification: `node --import tsx --test tests/arcgis-map-engine.test.ts
  tests/arcgis-scene-engine.test.ts tests/engine-conformance.test.ts
  tests/engine-registry.test.ts tests/reverse-geocode.test.ts` → 43 passed;
  `npm run lint -- --quiet` → passed; `npm run build` → passed (normal
  JupyterLite-unavailable notice and browser-externalization warnings were
  non-fatal).
- Follow-up: evaluate SceneView popup placement against 3D terrain only when
  I3S/terrain interaction support is explicitly scoped; Codex, 2026-07-21.

## 2026-07-21 — Cesium transient entities/selection → ArcGIS `SceneView` `GeoJSONLayer`

- Source: Cesium — temporary GeoJSON entities and selected features are
  renderer presentation state, not persisted project layers; the MapEngine seam
  exposes them through transient-overlay and highlight commands.
- Files touched: `packages/map/src/engine/arcgis-scene-engine.ts`,
  `packages/map/src/engine/registry.ts`, and ArcGIS adapter/conformance tests
  under `tests/` before → SceneView transient-overlay capability and deterministic
  layer collection fake.
- ArcGIS approach: create public, blob-backed `GeoJSONLayer` instances and
  manage them exclusively in the SceneView map's public `layers` collection;
  derive selection geometry from the current store GeoJSON snapshot.
- What changed: the lazy SceneView adapter supports creation, visibility,
  removal, highlight derivation, and remount restoration of transient overlays,
  while keeping those layers absent from `syncLayers` input and store state.
- Gap / limitation: generic Cesium entity rendering and selection styling do not
  have a direct SDK-neutral equivalent here; supplied style and fit options are
  retained by the seam but currently render as GeoJSONLayer defaults.
- Workaround: use supported GeoJSONLayer lifecycle APIs for preview/selection.
  Removal criteria: approve an engine-neutral symbol/fit contract then map it to
  documented ArcGIS renderers and navigation.
- Tradeoff accepted: this intentionally supports GeoJSON overlay parity first,
  not arbitrary Cesium entity types or private SceneView internals.
- Status: partial.
- Verification: `node --import tsx --test tests/arcgis-map-engine.test.ts
  tests/arcgis-scene-engine.test.ts tests/engine-conformance.test.ts
  tests/engine-registry.test.ts tests/map-engine-layer-consumers.test.ts` → 44
  passed; `npm run lint -- --quiet` → passed; `npm run build` → passed (normal
  JupyterLite-unavailable notice and browser-externalization warnings were
  non-fatal); `npx playwright test e2e/engine-param.spec.ts -g "ArcGIS opt-in|ArcGIS
  SceneView" --reporter=line` → 2 passed.
- Follow-up: scope 3D-native overlay types only after explicit data-model and
  interaction requirements exist; Codex, 2026-07-21.

## 2026-07-22 — Cesium canvas capture → ArcGIS `SceneView.takeScreenshot`

- Source: Cesium — globe capture needs a renderer-neutral canvas result for
  print/export without exposing the native viewer or capture surface through the
  MapEngine boundary.
- Files touched: `packages/map/src/capture/arcgis-capture.ts`,
  `packages/map/src/engine/arcgis-scene-engine.ts`,
  `packages/map/src/engine/registry.ts`, and ArcGIS adapter/conformance tests
  under `tests/` before → SceneView capture capability using shared public-SDK
  screenshot conversion.
- ArcGIS approach: invoke documented `SceneView.takeScreenshot({ area })`, copy
  returned `ImageData` to an application canvas, and keep the SceneView heading
  as the neutral capture bearing.
- What changed: SceneView supports full/bounded capture, emits neutral metadata,
  and suppresses only requested transient GeoJSON overlays while capturing,
  restoring their public layer visibility regardless of completion/failure.
- Gap / limitation: a SceneView screenshot is a 2D rendered image; it cannot
  expose a native Cesium canvas or guarantee the former viewer's imagery,
  terrain, DOM-widget, and GPU-composition behavior.
- Workaround: use the SDK screenshot as the only SDK-private operation and copy
  it into the existing neutral canvas result. Removal criteria: none unless a
  future engine-neutral export format replaces canvas capture.
- Tradeoff accepted: copying raw pixels adds memory proportional to screenshot
  area but keeps concrete ArcGIS and Cesium objects out of the public contract.
- Status: partial.
- Verification: `node --import tsx --test tests/arcgis-map-engine.test.ts
  tests/arcgis-scene-engine.test.ts tests/engine-conformance.test.ts
  tests/engine-registry.test.ts tests/map-engine-layer-consumers.test.ts` → 46
  passed; `npm run lint -- --quiet` → passed; `npm run build` → passed (normal
  JupyterLite-unavailable notice and browser-externalization warnings were
  non-fatal); `npx playwright test e2e/engine-param.spec.ts -g "ArcGIS opt-in|ArcGIS
  SceneView" --reporter=line` → 2 passed.
- Follow-up: test real SceneView screenshot output in GPU-enabled browser CI
  before claiming 3D print/export parity; Codex, 2026-07-22.

## 2026-07-22 — Cesium `Cesium3DTileset` I3S path → ArcGIS `SceneLayer` / `IntegratedMeshLayer`

- Source: Cesium — the secondary globe accepts a store `3d-tiles` record and
  renders its URL as a `Cesium3DTileset`; the ArcGIS I3S add-data path marks
  its store records with `metadata.sourceKind: "arcgis-i3s"`.
- Files touched: `packages/map/src/engine/arcgis-scene-engine.ts` and
  `tests/arcgis-engine-fake.ts` / `tests/arcgis-scene-engine.test.ts` before →
  lazy I3S metadata classification and native SceneView layer construction.
- ArcGIS approach: request the public SceneServer JSON metadata (`f=json`) and
  select documented `SceneLayer` for `3DObject` or `IntegratedMeshLayer` for
  `IntegratedMesh`; both constructors remain inside the lazy SceneView adapter.
- What changed: explicitly marked I3S store layers now resolve asynchronously,
  mount in their store ordering when the current reconciliation is still live,
  and emit a neutral engine error for bad metadata, unsupported layer types, or
  failed service requests.
- Gap / limitation: generic Cesium 3D Tiles, Google Photorealistic Tiles, and
  unmarked `3d-tiles` records cannot be safely mapped to either I3S layer class
  and remain unsupported in ArcGIS SceneView.
- Workaround: scope support to the existing `arcgis-i3s` source-kind marker and
  require the service's declared `layerType`. Removal criteria: introduce a
  reviewed neutral 3D-source taxonomy for non-I3S inputs before adding another
  ArcGIS adapter path.
- Tradeoff accepted: initial I3S display waits for one metadata request; the
  revision guard favors current store ordering and avoids stale async layers
  over optimistically mounting the wrong ArcGIS layer class.
- Status: partial.
- Verification: `node --import tsx --test tests/arcgis-scene-engine.test.ts
  tests/engine-conformance.test.ts tests/engine-registry.test.ts` → 37 passed;
  `node --import tsx --test tests/arcgis-map-engine.test.ts
  tests/arcgis-scene-engine.test.ts tests/engine-conformance.test.ts
  tests/engine-registry.test.ts tests/map-engine-layer-consumers.test.ts` → 47
  passed; `npm run lint -- --quiet` → passed; `npm run build` → passed (normal
  JupyterLite-unavailable notice and browser-externalization warnings were
  non-fatal); `npx playwright test e2e/engine-param.spec.ts -g "ArcGIS opt-in|ArcGIS
  SceneView" --reporter=line` → 2 passed.
- Follow-up: verify an actual public `3DObject` and `IntegratedMesh` SceneServer
  in GPU-enabled browser CI, then assess terrain/altitude parity; Codex,
  2026-07-22.

## 2026-07-22 — Cesium globe picking/extent gestures → ArcGIS `SceneView` click/drag events

- Source: Cesium — globe tools need neutral next-point and bounded-drag gestures
  without leaking the Cesium viewer or native screen-space handlers.
- Files touched: `packages/map/src/engine/arcgis-interactions.ts`,
  `packages/map/src/engine/arcgis-scene-engine.ts`, and ArcGIS fake/adapter
  tests under `tests/` before → SceneView public event gesture helpers.
- ArcGIS approach: use documented `SceneView` click/drag events and their public
  `mapPoint`, action, button, and `stopPropagation()` members to resolve neutral
  coordinates and a bbox.
- What changed: SceneView now supports abortable point picking and left-drag
  bounds preview/completion with cleanup of temporary event listeners.
- Gap / limitation: SceneView terrain intersection and a visible 3D sketch
  rectangle are not represented; the bbox uses longitude/latitude values only.
- Workaround: retain the neutral preview callback and defer terrain-aware sketch
  visualization until an engine-neutral 3D selection model is approved.
  Removal criteria: a supported shared selection/terrain contract.
- Tradeoff accepted: stopping propagation while drawing prevents native globe
  navigation for that gesture, which is required to make the selected extent
  deterministic.
- Status: partial.
- Verification: `node --import tsx --test tests/arcgis-map-engine.test.ts
  tests/arcgis-scene-engine.test.ts tests/engine-conformance.test.ts
  tests/engine-registry.test.ts tests/map-engine-layer-consumers.test.ts` → 49
  passed; `npm run lint -- --quiet` → passed; `npm run build` → passed (normal
  JupyterLite-unavailable notice and browser-externalization warnings were
  non-fatal).
- Follow-up: add only the remaining reviewed interaction commands, then make the
  capability advertisement and conformance matrix change together; Codex,
  2026-07-22.

## 2026-07-22 — Cesium camera-input suspension → ArcGIS `SceneView.navigation` action map

- Source: Cesium — globe interaction consumers need a reversible way to suspend
  camera navigation and to suppress double-click zoom while application gestures
  own the input stream.
- Files touched: `packages/map/src/engine/arcgis-scene-engine.ts` and ArcGIS
  fake/adapter tests under `tests/` before → SceneView navigation action-map and
  event-handle restoration.
- ArcGIS approach: use the documented `SceneView.navigation.actionMap`, touch,
  momentum, and gamepad properties, plus public double-click event propagation
  control; no private SceneView input manager is accessed.
- What changed: SceneView supports neutral double-click policy and reversible
  suspension of primary/secondary/tertiary drag, wheel, touch, momentum, and
  gamepad navigation.
- Gap / limitation: the aggregate ArcGIS action map is not a one-to-one Cesium
  camera-controller surface and cannot preserve mutations made concurrently by
  external SDK code while suspended.
- Workaround: snapshot and restore the complete reviewed public state. Removal
  criteria: add a neutral navigation lease protocol only if concurrent adapters
  are introduced.
- Tradeoff accepted: restoration intentionally reasserts application state to
  avoid leaving SceneView partially disabled after a temporary gesture.
- Status: partial.
- Verification: `node --import tsx --test tests/arcgis-map-engine.test.ts
  tests/arcgis-scene-engine.test.ts tests/engine-conformance.test.ts
  tests/engine-registry.test.ts tests/map-engine-layer-consumers.test.ts` → 51
  passed; `npm run lint -- --quiet` → passed; `npm run build` → passed (normal
  JupyterLite-unavailable notice and browser-externalization warnings were
  non-fatal).
- Follow-up: port marker presentation/drag lifecycle before advertising the
  interaction capability; Codex, 2026-07-22.

## 2026-07-22 — Cesium entity/HTML marker presentation → ArcGIS public projection DOM marker

- Source: Cesium — secondary-globe consumers require store-independent cursor,
  location, and story marker presentation with position, rotation, drag, and
  cleanup semantics.
- Files touched: `packages/map/src/engine/arcgis-markers.ts`,
  `packages/map/src/engine/arcgis-scene-engine.ts`, registry/conformance tests,
  and ArcGIS fake/adapter tests under `tests/` before → SceneView-projected DOM
  marker lifecycle.
- ArcGIS approach: use public `SceneView.toScreen`/`toMap` and the view container
  for an adapter-owned element; native SceneView and graphic instances remain
  private and never cross MapEngine.
- What changed: SceneView now owns custom/default DOM markers with neutral
  position, rotation, drag events, removal, and map-motion refresh, completing
  the current interaction/marker capability set.
- Gap / limitation: DOM markers do not drape, occlude, or pitch-align like a
  native Cesium entity or ArcGIS 3D graphic.
- Workaround: preserve the existing UI element semantics for low-count consumer
  markers. Removal criteria: approve a shared 3D marker elevation/occlusion
  model before replacing this adapter presentation.
- Tradeoff accepted: favoring DOM fidelity means markers may not be suitable for
  high-volume or terrain-aware scene data; those belong in a future layer model.
- Status: partial.
- Verification: `node --import tsx --test tests/arcgis-map-engine.test.ts
  tests/arcgis-scene-engine.test.ts tests/engine-conformance.test.ts
  tests/engine-registry.test.ts tests/map-engine-layer-consumers.test.ts` → 53
  passed; `npm run lint -- --quiet` → passed; `npm run build` → passed (normal
  JupyterLite-unavailable notice and browser-externalization warnings were
  non-fatal).
- Follow-up: run GPU/browser validation against real SceneView terrain before
  claiming globe-marker visual parity; Codex, 2026-07-22.

## 2026-07-22 — Cesium camera footprint → ArcGIS `SceneView.toMap` corner bounds

- Source: Cesium — globe/print consumers need a renderer-neutral visible bbox
  without exposing the native camera or globe object.
- Files touched: `packages/map/src/engine/arcgis-scene-engine.ts` and ArcGIS
  adapter tests under `tests/` before → SceneView public corner projection.
- ArcGIS approach: project four public screen corners with `SceneView.toMap`
  and return normalized longitude/latitude bounds through the existing camera
  port.
- What changed: SceneView now returns a neutral bbox for a measurable mounted
  viewport instead of `null`.
- Gap / limitation: terrain, pitch, and horizon make this a conservative
  geographic bbox, not a terrain-clipped camera footprint.
- Workaround: preserve the current bbox contract. Removal criteria: approve a
  terrain-aware neutral footprint model before adding one.
- Tradeoff accepted: conservative bounds make current print consumers work
  without leaking SceneView geometries.
- Status: partial.
- Verification: `node --import tsx --test tests/arcgis-map-engine.test.ts
  tests/arcgis-scene-engine.test.ts tests/engine-conformance.test.ts
  tests/engine-registry.test.ts tests/map-engine-layer-consumers.test.ts` → 55
  passed; `npm run lint -- --quiet` → passed.
- Follow-up: none; Codex, 2026-07-22.

## 2026-07-22 — Cesium viewer controls → ArcGIS `SceneView.ui` public widgets

- Source: Cesium — secondary-globe navigation, compass, fullscreen, and locate
  controls must remain available through the renderer-neutral controls port.
- Files touched: `packages/map/src/engine/arcgis-controls.ts`,
  `packages/map/src/engine/arcgis-scene-engine.ts`,
  `packages/map/src/engine/registry.ts`, and ArcGIS scene/conformance tests under
  `tests/` before → adapter-private SceneView public widget lifecycle.
- ArcGIS approach: lazily use documented ArcGIS Zoom, Compass, Fullscreen, and
  Locate widgets with public `SceneView.ui.add`, `move`, and `remove`; no SDK
  object crosses `MapEngine`.
- What changed: SceneView now supports neutral visibility/position state and
  compass labels for the matched controls, destroys widgets with the view, and
  advertises the controls capability only alongside its tested port behavior.
- Gap / limitation: ScaleBar is MapView-only; ArcGIS has no public SceneView
  vertical-exaggeration, globe-toggle, logo, or store-authoritative layer-list
  equivalent. Native attribution must stay visible.
- Workaround: unsupported controls return `false`; terrain exaggeration stays at
  neutral `1`; no LayerList is mounted because native visibility edits would make
  the SDK state authoritative. Removal criteria: approve a store-dispatching
  control contract and identify supported SceneView equivalents.
- Tradeoff accepted: partial control parity preserves source-of-truth and
  attribution guarantees, at the cost of not exposing every former Cesium UI
  option in the ArcGIS opt-in.
- Status: partial.
- Verification: `node --import tsx --test tests/arcgis-map-engine.test.ts
  tests/arcgis-scene-engine.test.ts tests/engine-conformance.test.ts
  tests/engine-registry.test.ts` → 52 passed; `npm run lint -- --quiet` →
  passed; `npm run build` → passed (normal JupyterLite notice and Vite browser
  externalization warnings were non-fatal); `npx playwright test
  e2e/engine-param.spec.ts -g "ArcGIS opt-in|ArcGIS SceneView" --reporter=line`
  → 2 passed.
- Follow-up: browser-validate SceneView controls, keyboard focus, and required
  attribution before claiming visual parity; Codex, 2026-07-22.
