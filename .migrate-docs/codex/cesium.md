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
