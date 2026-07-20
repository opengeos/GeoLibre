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
