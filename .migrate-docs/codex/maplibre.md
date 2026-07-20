# MapLibre GL JS migration log — codex

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
