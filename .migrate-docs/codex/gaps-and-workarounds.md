# ArcGIS migration gaps and workarounds — codex

## 2026-07-21 — Cesium 3D Tiles → ArcGIS SceneView I3S layer classification

- `ArcGISSceneEngine` deliberately does not accept generic `3d-tiles` store
  records. ArcGIS requires choosing `SceneLayer` or `IntegratedMeshLayer` from
  I3S `layerType` metadata; treating a Cesium Tileset URL as either class would
  fail at runtime.
- Current workaround: `?sceneEngine=arcgis` renders only core draped layers and
  reports `3d-tiles` unsupported. Remove this guard when a tested metadata probe
  and explicit I3S adapter path land. See [Cesium log](cesium.md).

## 2026-07-21 — Multiple MapLibre popups → one ArcGIS view popup

- `MapView` and `SceneView` expose one documented view popup. The ArcGIS
  adapters therefore serialize MapEngine popup ownership and do not map the
  MapLibre-specific `maxWidth` or per-popup `closeOnClick` options. See the
  [MapLibre log](maplibre.md#2026-07-21--maplibre-popupsetdomcontent--arcgis-mapviewopenpopup)
  and [Cesium log](cesium.md#2026-07-21--cesium-overlay-popup-gap--arcgis-sceneviewopenpopup).

- 2026-07-20 — Native canvas capture and legacy external MapLibre plugins need
  adapter-private compatibility, but the public seam will expose only typed
  capture/extension capabilities—not an SDK object or `unknown` native handle.
  See [the capability decision](maplibre.md#2026-07-20--flat-native-controller-surface--typed-mapengine-capability-groups).
- 2026-07-20 — External Plugin API v1 is incompatible with the strict seam and
  is rejected before code execution; first-party runtimes move adapter-private
  and external authors migrate to v2. See [the governance decision](maplibre.md#2026-07-20--conflicting-phase-0-scopes--strict-mapengine-boundary).
- 2026-07-20 — The strict boundary begins with 197 reviewed violations; the
  checked-in ratchet permits only monotonic removal until the fixture is empty.
  See [the boundary step](maplibre.md#2026-07-20--public-mapcontroller-dependency-graph--strict-mapengine-contract-and-ratchet).
- 2026-07-20 — Cesium lacks several capabilities required by 2D consumers;
  capability checks plus typed errors prevent silent behavior loss. See
  [the Cesium adapter step](cesium.md#2026-07-20--react-owned-cesiumviewer--lazy-cesiumengine-adapter).

## 2026-07-20 — Per-renderer behavior tests → shared adapter conformance

- Source: MapLibre and Cesium — independent lifecycle, camera, layer sync,
  query, and event behavior that previously had no common acceptance contract.
- Files touched: new `tests/engine-conformance.test.ts`; existing
  `tests/engine-test-fakes.ts`, `tests/maplibre-engine.test.ts`, and
  `tests/cesium-engine.test.ts` retained as focused adapter tests.
- ArcGIS approach: expose `runEngineConformance` as the reusable acceptance
  harness that future ArcGIS `MapView` and `SceneView` adapters must enter with
  an explicit capability/layer matrix.
- What changed: MapLibre and Cesium are both registered against identical
  mount/destroy, view tolerance, store layer add/remove/reorder, normalized hit,
  event unsubscribe, stable-handle queue, and unsupported-control assertions.
- Gap / limitation: conformance can prove contract semantics but cannot prove
  browser rendering fidelity or SDK-specific visual output.
- Workaround: keep focused adapter tests and browser smoke tests alongside the
  shared suite. Removal criteria: none; conformance and visual verification test
  different risks and remain complementary.
- Tradeoff accepted: each adapter needs a deterministic SDK/viewer harness and
  an explicit matrix, increasing test setup in exchange for making capability
  differences reviewable.
- Status: done.
- Verification: `node --import tsx --test tests/engine-conformance.test.ts
  tests/maplibre-engine.test.ts tests/cesium-engine.test.ts
  tests/engine-boundary.test.ts` → 22 passed; scoped strict TypeScript and ESLint
  checks → passed; `git diff --check` → passed.
- Follow-up: register `ArcGISMapEngine` and `ArcGISSceneEngine` in later phases
  before either becomes selectable.
