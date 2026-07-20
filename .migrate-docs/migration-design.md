# Design: Migrate GeoLibre's rendering stack to the ArcGIS Maps SDK for JavaScript

- **Status:** Approved design. Umbrella + Phase 0 & Phase 1 detail. Later phases get their own brainstorm when reached.
- **Author:** Sascha Brunner (with Claude Code)
- **Role of this doc:** the **single source of truth** for the migration. It is written to be handed to *any* agent as the seed briefing so that agent can **plan and execute its own slice** without re-deriving the design. Read §2 first if you are an implementing agent.

## 1. Summary

Replace GeoLibre's four-engine rendering stack — **MapLibre GL JS** (primary 2D),
**deck.gl** (GPU overlays drawn through MapLibre), **three.js** (used inside MapLibre
plugins), and **Cesium** (a separate 3D globe) — with the **ArcGIS Maps SDK for
JavaScript** (`@arcgis/core` / `@arcgis/map-components`), consolidating on one
vendor-supported SDK for 2D + 3D + analysis.

This is a **re-platform, not a library swap**: MapLibre's model (Mapbox GL style
spec, sources/layers, ~40 `maplibre-gl-*` plugins, SLD/QML/Mapbox-style
import/export) is currently the app's rendering data model. The migration is
staged behind a new **`MapEngine` seam** so the app stays shippable and CI stays
green at every step, and so any surface that ArcGIS handles poorly can stay on
MapLibre indefinitely (partial migration is a valid resting state).

## 2. How to use this document (for the implementing agent)

**Working model:** one design doc (this file), many agents. Each agent owns **one
phase — or one task within a phase** — and **does its own planning** from this
doc. There is no separate central plan to wait on. This section is your contract
for how to do that so parallel agents converge instead of diverging.

### 2.1 Your loop, per slice of work

1. **Read** this doc end to end, plus the files named in your phase (§7–§9) and the
   coupling inventory (§13). Read the repo `CLAUDE.md`.
2. **Plan your slice yourself** — break it into commit-sized, independently
   verifiable steps. Use the Definition of Done in §2.4 as your acceptance bar.
   You do not need anyone to hand you a task list; derive it.
3. **Implement** on a branch (never on `main` — §2.5).
4. **Log every migration decision** as you make it via the `document-migration`
   skill into your own `.migrate-docs/<agent>/` folder (§2.6). This is how the
   next agent learns what ArcGIS equivalent you chose and what you hit.
5. **Verify** against §10 and your Definition of Done. Do not claim done without
   evidence (`npm run ci` / the relevant test command output).

### 2.2 Shared contracts you MUST NOT break

These keep parallel agents compatible. Changing any of them is a design change —
stop and update this doc (and flag it) before proceeding.

- **The store is the source of truth.** `@geolibre/core` (`GeoLibreLayer`,
  `MapViewState`, `.geolibre.json`) stays engine-neutral. Engines *read* it and
  reconcile to it; they do not become a parallel source of state.
- **The `MapEngine` interface (§5.2) is the seam.** Every engine implements it;
  nothing outside `@geolibre/map` talks to a concrete engine. If you need a new
  capability from the engine, add it to the interface (and its conformance test),
  not a one-off backdoor.
- **Adapters are lazy-loaded, type-only at module scope.** An engine's SDK is
  imported inside `mount()` so it stays in its own build chunk and off the other
  engine's boot path (the pattern `CesiumCanvas` already uses).
- **The conformance suite (§10) is the gate.** A new/changed adapter must pass it.
- **Data ingest is off-limits for this migration.** DuckDB-WASM `ST_Read`, shpjs,
  KMZ, Add-Data menus produce `GeoLibreLayer` records upstream of the engine —
  don't touch them; they already emit engine-neutral data.

### 2.3 Decide, then record (don't silently choose)

Whenever you pick an ArcGIS equivalent, hit a gap, adopt a workaround, accept a
tradeoff, or reject/block a step — **record it** (§2.6). Silent choices are how
parallel agents contradict each other.

### 2.4 Definition of Done (reuse this per slice)

- [ ] App still builds and runs on **all three targets** it touches (web,
      Tauri desktop, and — if the slice affects bundling/assets — the Jupyter
      wheel).
- [ ] `npm run ci` passes (build + frontend + worker + backend + rust).
- [ ] New code has tests; the coverage **ratchet** holds (frontend 78% lines /
      78% branches / 63% functions; backend 55%). Raise a floor if you clear it.
- [ ] For an engine adapter: the **conformance suite** passes for it.
- [ ] Migration decisions logged to the implementing runtime's own
      `.migrate-docs/<agent>/` folder (§2.6).
- [ ] No behavior change on the still-default engine unless the slice's whole
      point is to change it.
- [ ] Work is on a branch with a PR (§2.5).

### 2.5 Repo conventions every agent follows (from `CLAUDE.md`)

- **Never commit to `main`.** Branch, open a PR.
- **CSP allowlist** (Tauri) must gain any new external ArcGIS host
  (`*.arcgis.com`, `*.arcgisonline.com`, tile/geocode/route hosts).
- **i18n:** user-facing strings go through `t()`; style with logical Tailwind
  utilities (`ms-`/`me-`/`ps-`/`pe-`/`text-start`), not physical (`ml-`/`left-`),
  because the UI mirrors for RTL.
- **MapLibre control CSS fixes** go in `apps/geolibre-desktop/src/index.css`,
  never `node_modules`.
- **Pre-commit** runs a full build (`npm-build` hook); scope it:
  `pre-commit run --files <paths>`.
- Honor the constant-mirror notes in `CLAUDE.md` if your slice touches those
  files.

### 2.6 Where migration knowledge accumulates

`.migrate-docs/` is the migration's memory:

- **`.migrate-docs/migration-design.md`** — this doc, the design (broad, stable).
- **`.migrate-docs/<agent>/`** — per-step decision log, written via the
  `document-migration` skill in the implementing runtime's own folder: each
  ArcGIS equivalent chosen, gap found, workaround, tradeoff, or rejected step.
  Write here *as you work*, not after; never write into another runtime's log.

An agent planning a later phase should read all existing runtime logs and treat
them as comparison evidence, not as ground truth; the design and master plan
remain authoritative.

## 3. Motivation

- **Consolidate the stack** (primary driver): stop maintaining four render engines
  and ~40 plugin wrappers; get 2D, 3D, and analysis under one supported API.
- **Esri ecosystem** (secondary): first-class hosted feature services, Living
  Atlas, portal integration become available.

## 4. Decisions locked in this brainstorm

| # | Decision | Choice |
|---|----------|--------|
| Goal | End state | **Full replacement** — retire MapLibre, deck.gl, three, Cesium |
| Driver | Why | **Consolidate the stack** + Esri ecosystem as a bonus |
| Licensing | Key handling | **Key-optional, open basemaps default** — runs with zero setup on open XYZ/vector/WMS; Esri basemaps/geocode/route light up when an ArcGIS API key is supplied |
| Parity | "Done" bar | **Core-first, drop the long tail** — rebuild core map + project format + top data sources; defer/drop niche plugins per demand |
| Approach | How | **Strangler-fig behind a `MapEngine` seam**, Cesium first |
| A | deck.gl fate | **Retire entirely** — re-express overlays as native ArcGIS graphics/layers |
| B | Which plugins | Port **top ~10** data-source plugins by usage; defer/drop the rest with a logged list |
| C | SLD/QML/Mapbox style | **Full round-trip** against ArcGIS |
| D | Project-format style | **Engine-neutral** style representation in `.geolibre.json` |

**Coupling note (C × D):** full style round-trip (C) is only tractable if it
targets the engine-neutral style layer (D): `SLD ⇄ neutral ⇄ {MapLibre paint |
ArcGIS renderer}`, never `SLD ⇄ ArcGIS` directly. This puts the **engine-neutral
style model on the critical path** (a Phase 4 keystone) and it will likely need
its own dedicated brainstorm when reached.

## 5. Architecture — the `MapEngine` seam

### 5.1 Why the seam is affordable

The store is **already engine-neutral**. `GeoLibreLayer[]` and `MapViewState`
(`@geolibre/core`) are consumed today by both MapLibre (`layer-sync.ts`) and
Cesium (`cesium-layer-sync.ts` + `cesium-camera.ts`). Cesium is a de-facto second
engine that never touches MapLibre. The seam formalizes that pattern.

### 5.2 The interface

`@geolibre/map` exposes a core `MapEngine` lifecycle plus a narrowed,
engine-neutral `MapEngineClient` used by the app and plugin packages. The shape
is modeled on what `CesiumCanvas` + `CesiumLayerSync` + `cesium-camera` already
do, expanded to cover the concrete controller surface found during the Phase 0
coupling inventory:

```ts
interface MapEngineClient {
  camera: MapCameraPort;
  layers: MapLayerPort;
  viewport: MapViewportPort;
  interactions: MapInteractionPort;
  controls: MapControlPort;
  invoke<K extends keyof MapEngineExtensionMap>(
    command: K,
    input: MapEngineExtensionMap[K]["input"],
  ): MapEngineExtensionMap[K]["output"];
  on<K extends keyof MapEngineEventMap>(
    event: K,
    handler: (payload: MapEngineEventMap[K]) => void,
  ): Unsubscribe;
}

interface MapEngine extends MapEngineClient {
  mount(container: HTMLElement, initialView: MapViewState): Promise<void>;
  destroy(): void;
  configure(options: MapEngineConfiguration): void;
  applyView(view: MapViewState): void;
  readView(): MapViewState;
  syncLayers(layers: GeoLibreLayer[]): void;
  supports(capability: MapEngineCapability): boolean;
  supportsLayer(layer: GeoLibreLayer): boolean;
  hitTest(point: ScreenPoint): Promise<HitFeature[]>;
}
```

The named ports cover viewport/navigation, layer inspection/presentation,
controls/terrain, capture, transient interaction, and renderer extensions.
Capabilities may be optional, but adapters must advertise unsupported behavior
and the conformance suite must test it. No public contract may return a concrete
SDK object, an `unknown` native handle, `MapController`, `maplibregl.Map`, a
deck.gl instance, a three.js renderer, or a Cesium viewer. Any new capability is
a design change and lands with conformance coverage.

### 5.3 Adapters (all lazy-loaded, own build chunk, type-only engine imports)

- `MapLibreEngine` — a **façade** over today's `MapController`/`layer-sync` plus
  the concrete built-in MapLibre/deck.gl/three.js runtimes. It delegates rather
  than rewriting rendering behavior. Ships in Phase 0.
- `CesiumEngine` — extracts today's independent `CesiumCanvas` lifecycle behind
  the same seam in Phase 0 so app code no longer talks to Cesium directly.
- `ArcGISSceneEngine` — `SceneView`, replaces Cesium. Phase 1.
- `ArcGISMapEngine` — `MapView`, replaces the 2D core. Phase 2+.

### 5.4 What stays vs. changes

**Unchanged (source of truth):**
- `@geolibre/core` — store, `GeoLibreLayer`, `MapViewState`, `.geolibre.json`.
- **Data ingest** — DuckDB-WASM `ST_Read`, `shpjs`, KMZ, Add-Data menus, Tauri
  dialogs. Upstream of the engine; emits `GeoLibreLayer` records; survives the swap.

**Changes:**
- `MapCanvas.tsx` becomes a thin **engine-agnostic host**: reads an `engine`
  selector, instantiates the chosen adapter, forwards store subscriptions — the
  way it already forwards to `CesiumCanvas` in a split pane.
- Camera math (`cesium-camera.ts`, ~165 lines of pure `MapViewState ↔ camera`
  functions) is **reused, not thrown away**: it ports to `arcgis-camera.ts` for
  `SceneView`'s `Camera` (position + tilt + heading), staying engine-free and
  unit-testable.

## 6. Goals / Non-goals

**Goals**
- One rendering SDK (ArcGIS) for 2D + 3D once complete.
- App remains shippable and CI-green after every phase.
- Zero-setup / key-free operation preserved via open basemaps by default.
- Existing data-ingest pipeline and `@geolibre/core` store untouched.

**Non-goals**
- Rebuilding the UI/shell UX (engine migration, not a redesign).
- Preserving every one of the ~40 `maplibre-gl-*` plugins (out per "drop the long tail").
- Changing `.geolibre.json` semantics beyond adding an engine-neutral style representation.

## 7. Phase roadmap (7 phases, each independently shippable)

| Phase | Title | Ships | Reversible? |
|-------|-------|-------|-------------|
| 0 | Extract the seam | Pure refactor, no user-visible change | n/a |
| 1 | ArcGIS replaces Cesium (3D) | 3D globe on `SceneView`; Cesium retired at exit | Yes, until the Phase-1-exit deletion of Cesium |
| 2 | ArcGIS opt-in 2D engine | `MapView` behind toggle, MapLibre still default | Yes — toggle off |
| 3 | Absorb deck.gl & three | Native ArcGIS overlays; top ~10 plugins ported | Partial |
| 4 | Style & project-format bridge | Engine-neutral style + SLD/QML/Mapbox round-trip | Partial |
| 5 | Flip the default | ArcGIS default across desktop/web/Jupyter | Yes — one release |
| 6 | Retire MapLibre | Delete MapLibre/deck.gl/three/Cesium + ~40 plugins | No (terminal) |

MapLibre stays the default until Phase 5. You can stop after any phase with a
working, shipped app. **Each phase is an ownable unit** — an agent takes it,
plans it (§2.1), and the phase's exit criteria are its acceptance bar.

### Phase summaries (2–6)

- **Phase 2 — ArcGIS opt-in 2D.** `ArcGISMapEngine` (`MapView`). Port **core** layer
  kinds only: basemaps (open default, Esri when keyed), GeoJSON, raster/XYZ/WMS/WMTS.
  Biggest single phase; the conformance suite (§10) keeps it honest.
- **Phase 3 — Absorb deck.gl & three.** Overlays that rendered *through* MapLibre go
  native: point clouds / 3D tiles / photorealistic → `SceneLayer`/`IntegratedMesh`;
  deck-viz overlays → ArcGIS graphics. three.js drops out with its host plugins.
  Port top ~10 data-source plugins (usage pass ranks them); log what's dropped.
- **Phase 4 — Style & project-format bridge.** Build the engine-neutral style model
  (D); re-express SLD/QML/Mapbox-style as full round-trip (C) through it;
  `.geolibre.json` gains the neutral style so projects round-trip on either engine.
  Likely needs its own brainstorm before an agent plans it.
- **Phase 5 — Flip the default.** ArcGIS default everywhere; MapLibre selectable as
  fallback for one release.
- **Phase 6 — Retire MapLibre.** Delete `MapLibreEngine`, `layer-sync.ts`,
  `map-controller.ts`, the ~40 `maplibre-gl-*` plugins, deck.gl, three, Cesium.

## 8. Phase 0 — Extract the strict seam (agent briefing)

**Objective:** introduce the complete `MapEngine`/`MapEngineClient` boundary and
finish with no concrete MapLibre, deck.gl, three.js, or Cesium access outside
`@geolibre/map`. Wrap current behavior in `MapLibreEngine` and `CesiumEngine`,
host every pane through the engine registry, add the adapter conformance suite,
and replace external Plugin API v1 with engine-neutral Plugin API v2. This is a
pure rendering-boundary refactor with **zero first-party user-visible change**;
external v1 plugins are intentionally rejected with an actionable migration
error.

**Required slices:**
1. **Contracts and boundary ratchet.** Add the core interface, typed capability
   ports, extension commands, contract tests, and a source-level violation
   baseline that can only shrink.
2. **Adapters and conformance.** Add the lazy stable handle, registry,
   `MapLibreEngine`, `CesiumEngine`, and a parameterized suite covering lifecycle,
   view, layers, hits, events, capability advertisements, and pre-ready queuing.
3. **Engine hosts.** Replace primary and secondary concrete canvases with an
   engine-agnostic host while keeping `maplibre` the default.
4. **Consumer migration.** Move camera/control, layer-query, interaction,
   marker/transient-overlay, capture, recording, and inset-map consumers onto
   `MapEngineClient` ports. Do not touch ingest or store authority.
5. **Plugin API v2 and runtime relocation.** Add an explicit v2 manifest/export
   version, reject v1 before code execution, and move concrete built-in renderer
   runtimes under the MapLibre adapter while preserving ids and project state.
6. **Strict exit.** Remove public controller/native renderer exports and require
   the boundary test to report zero violations.

The commit-sized implementation sequence is governed by
`.migrate-docs/migration-plan.md` and
`docs/superpowers/plans/2026-07-20-phase0-strict-map-engine-boundary.md`.

**Exit criteria:** app behaves identically with `engine=maplibre`; the
conformance suite is green for MapLibre and Cesium; app/plugin modules contain
no concrete renderer access; Plugin API v1 is rejected and a v2 fixture loads;
`npm run ci`, Playwright, web, Tauri, and Jupyter/embed verification pass.

## 9. Phase 1 — ArcGIS replaces Cesium (agent briefing)

**Objective:** `ArcGISSceneEngine` (`SceneView`) reaches parity with today's
Cesium globe, then Cesium is retired. First real ArcGIS bet, on the cheapest,
most isolated surface.

**External prerequisites (gather before/early — an agent cannot produce these):**
- **Headless-`SceneView` launch flags** from prior projects that render a
  `SceneView` in headless Chrome/Playwright (SwiftShader/ANGLE or GPU-CI config).
  Record them in the E2E config and log the source in `.migrate-docs/claude/`.
- **An ArcGIS API key** to exercise the keyed path (Esri imagery/elevation). The
  keyless path needs nothing.

**Suggested slices:**
1. **Deps & asset staging.** `@arcgis/core` (+ `@arcgis/map-components` if adopting
   `<arcgis-scene>`). Stage `esri/` assets via a vite plugin analogous to
   `apps/geolibre-desktop/vite-plugins/copy-cesium-assets.ts`, deriving the path
   from `import.meta.env.BASE_URL` (the sub-path-deploy fix Cesium uses), or
   configure `@arcgis/core`'s `assetsPath`.
2. **Camera math.** `packages/map/src/engine/arcgis-camera.ts` — port
   `cesium-camera.ts`: reuse `groundResolution`/`zoomToRange`/`rangeToZoom` to map
   `MapViewState` ↔ ArcGIS `Camera` (`position {lng,lat,z}`, `heading`, `tilt`).
   Port the unit tests alongside.
3. **Layer sync.** `packages/map/src/engine/arcgis-scene-layer-sync.ts` mirroring
   `CesiumLayerSync.sync`: GeoJSON → `GraphicsLayer`/`FeatureLayer`; imagery
   (xyz/raster/wms/wmts) → `WebTileLayer`/`WMSLayer`/`WMTSLayer`; 3D Tiles →
   `SceneLayer` vs `IntegratedMeshLayer` chosen by the i3s `layerType`
   (`…/SceneServer?f=json` → `layers[0].layerType`; wrong class throws at runtime).
4. **Engine adapter.** `packages/map/src/engine/arcgis-scene-engine.ts` implements
   `MapEngine`, lazy-loading `@arcgis/core` inside `mount()`.
5. **Framing.** Initial `camera` + `view.goTo(HOME, {animate:false})` in the ready
   handler to avoid the globe fly-in.
6. **Key handling.** Key-optional: key → Esri world imagery/elevation; no key →
   keyless open imagery on the ellipsoid (mirrors Cesium's `ionToken` fallback).
7. **CSP / hosts.** Add ArcGIS hosts to the Tauri CSP allowlist.
8. **Wire in.** Mount where Cesium mounts today (`SecondaryMapCanvas` split pane);
   expose the `arcgis-scene` engine option.
9. **Headless 3D E2E.** Apply the recovered launch flags; add a `SceneView` smoke spec.
10. **Parity & retire.** Parity checklist vs Cesium (GeoJSON drape, imagery
    stacking/opacity, 3D tiles + altitude offset, camera round-trip). Once met,
    delete `CesiumCanvas.tsx`, `cesium-layer-sync.ts`, `cesium-camera.ts`,
    `copy-cesium-assets.ts`, and the `cesium` dependency.

**Exit criteria:** 3D globe renders every layer kind Cesium did, at parity;
headless `SceneView` E2E paints; Cesium fully removed; `npm run ci` passes.

## 10. Testing strategy

- **Engine-conformance suite** (Phase 0): one parameterized spec run against every
  adapter — same `GeoLibreLayer[]` in, assert supported kinds, view round-trip,
  capability flags. The safety net that lets adapters swap.
- **Pure-function unit tests** for camera math (port `cesium-camera` tests to
  `arcgis-camera`). Honor the coverage ratchet (78/78/63 frontend, 55 backend).
- **Headed / configured-headless browser** for 3D visual correctness; use the
  recovered known-good headless-WebGL settings.
- **Manual parity checkpoints** at each phase boundary: load the same
  `.geolibre.json` on MapLibre vs ArcGIS and compare.

## 11. Risks & open items

1. **Styling paradigm gap (largest).** Mapbox GL style spec (data-driven
   `paint`/`layout`, `layer-sync.ts` @ 3,351 lines, fill-patterns, line-decorations,
   label dedup) does not map cleanly to ArcGIS renderers/symbols + Arcade. Simple
   fills/lines/circles port easily; expression-driven styling needs per-case
   re-authoring. Main content of Phases 2–4; the engine-neutral style layer (D) is
   the mitigation.
2. **Bundle size across three targets.** `@arcgis/core` is multi-MB. Web/desktop
   absorb it; the **Jupyter anywidget wheel** is the pinch point (size + `esri/`
   asset staging). Open item — strategy decided when Phase 5 nears.
3. **Headless 3D verification (solved-with-config).** `SceneView` needs the right
   browser flags to paint headlessly; working setups exist in other projects.
   Action: recover and record the exact flags. Not a blocker.
4. **CSP / host allowlist.** Add ArcGIS hosts to the Tauri CSP (Phase 1).

**Open decisions to revisit per-phase (not blockers):**
- Exact "top ~10" data-source plugins to keep (Phase 3) — needs a usage/telemetry
  ranking pass over the 40+.
- Engine-neutral style model shape (Phase 4) — likely its own brainstorm.

## 12. Glossary of the concrete ArcGIS mappings (quick reference)

| GeoLibre concept | MapLibre today | ArcGIS target |
|------------------|----------------|---------------|
| 2D map host | `Map` + `MapCanvas` | `MapView` (`ArcGISMapEngine`) |
| 3D globe | Cesium `Viewer` | `SceneView` (`ArcGISSceneEngine`) |
| GeoJSON layer | GeoJSON source + fill/line/circle layers | `FeatureLayer` / `GraphicsLayer` |
| XYZ/raster tiles | raster source | `WebTileLayer` |
| WMS / WMTS | raster source | `WMSLayer` / `WMTSLayer` |
| 3D Tiles (i3s) | `maplibre-3d-tiles` (three.js) | `SceneLayer` / `IntegratedMeshLayer` |
| deck.gl overlays | shared `MapboxOverlay` | native ArcGIS graphics/layers (deck retired) |
| Camera | `MapViewState` | `Camera` (position/heading/tilt) |
| Symbology | Mapbox `paint`/`layout` | ArcGIS renderers/symbols + Arcade |

## 13. Appendix — current coupling inventory (why this is a re-platform)

| Surface | Files / size | Coupling to MapLibre |
|---------|-------------|----------------------|
| Layer reconciliation | `packages/map/src/layer-sync.ts` (3,351 LoC), `map-controller.ts` (2,594 LoC) | Reconciles store → MapLibre sources/layers directly |
| Map host | `MapCanvas.tsx` (1,377 LoC) | Owns the MapLibre map instance |
| Style import/export | `sld-*.ts`, `qml-*.ts`, `mapbox-style-*.ts` (~4k LoC) | All expressed in Mapbox GL style spec |
| Plugins | ~40 of 70 in `packages/plugins/src/plugins/` | Thin wrappers over `maplibre-gl-*` packages |
| deck.gl | `shared-deck-overlay.ts`, `deckgl-viz/*` | Draws through MapLibre via shared `MapboxOverlay` (`map.__deck`) |
| three.js | inside `maplibre-3d-tiles`, splat plugins | Lives inside MapLibre plugins |
| **Cesium (precedent)** | `CesiumCanvas.tsx`, `cesium-layer-sync.ts`, `cesium-camera.ts` (~900 LoC) | **Independent engine, clean seam — the template** |
