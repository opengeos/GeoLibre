# Master migration plan — synthesis of the four agent plans

- **Date:** 2026-07-20
- **Role of this doc:** consolidates what the four planning runtimes learned into
  one governing Phase 0 plan. It sits between `migration-design.md` (the design)
  and the per-runtime logs (`antigravity/`, `claude/`, `codex/`, `copilot/`),
  which remain the decision-level record.
- **Sources synthesized:**
  - [`antigravity/maplibre.md`](antigravity/maplibre.md) — façade-scope Phase 0 design
  - [`claude/maplibre.md`](claude/maplibre.md) — coupling inventory, scope conflict discovery, arbitration record
  - [`codex/maplibre.md`](codex/maplibre.md) — typed capability-group contract decomposition
  - [`copilot/maplibre.md`](copilot/maplibre.md) — strict-boundary sequencing + Plugin API v2
  - `migration-design.md` (published design, §5.2/§5.3/§8) and the façade-scope
    implementation plan `docs/superpowers/plans/2026-07-20-phase0-map-engine-seam.md` (7 tasks)

---

## 1. Where all four plans agree (consensus — treat as settled)

Every runtime independently converged on the same architecture:

1. **`MapEngine` is the seam.** It is the only rendering contract ArcGIS
   adapters will ever implement; `MapLibreEngine` delegates to the existing
   `MapController` during Phase 0 with zero behavior change.
2. **The store stays the source of truth** and data ingest is untouched
   (design §2.2) — no plan proposed otherwise.
3. **The published eight-method interface (§5.2) is too small.** All four
   discovered that the real public surface consumed outside `@geolibre/map` is
   far broader than `mount/destroy/applyView/readView/syncLayers/supportsLayer/hitTest/on`.
4. **A conformance suite gates every adapter** before it can ship.
5. **No runtime code has changed anywhere.** All four runs are planning-only;
   Phase 0 implementation has not started.

## 2. The shared discovery: the real coupling surface

Measured independently and consistently:

- **164 `MapController` references across 74 files** (`rg '\bMapController\b' apps packages`
  — claude and copilot, identical numbers).
- **80+ React components** coupled to `mapControllerRef.current` (antigravity).
- Concrete operations in live use beyond the proposed interface: `getMap()`,
  `fitLayer`/`fitBounds`, camera methods, native controls, terrain, projection,
  canvas capture, source/style access, transient interaction, markers.
- The **plugin API is natively typed**: `packages/plugins/src/types.ts` exposes
  `MapLibreMap`, `IControl`, deck.gl modules, and `maplibre-gl-raster`;
  `GeoLibreAppAPI` exposes `getMap`, `addMapControl`/`removeMapControl`,
  native-layer registration, `getDeckGL`, `getMaplibreGlRaster`. External plugin
  manifests carry **no API-version field** (browser or Tauri validator).

Consequence accepted by all: Phase 0 cannot be *only* a thin façade — the
question the plans split on is *when* the boundary is enforced, not *whether*.

## 3. The central conflict: Phase 0 scope — and its resolution

Two contradictory scopes exist on record (flagged by claude's conflict entry;
neither self-resolved):

| | Façade scope | Strict scope |
|---|---|---|
| **Backed by** | Published design §5.3/§8 ("no rewrite; it delegates"); antigravity's plan; the existing 7-task plan in `docs/superpowers/plans/` | Reviewer decisions recorded **independently in two sessions** (claude 2026-07-20, copilot 2026-07-20); codex's contract is built for it |
| **Phase 0 size** | Small, zero-behavior refactor; `getController()` escape hatch | Broad pure refactor: 74 files of consumers migrated, plugin runtimes relocated, before any ArcGIS work |
| **Boundary enforced** | Progressively, through Phase 2 | By Phase 0 exit: no app/plugin module imports `MapController`, `maplibre-gl`, or MapLibre control types |

**Resolution this master plan adopts: the strict scope governs, executed in
stages so the façade work is its first milestone.** Rationale:

- Two independent reviewer selections chose strict; the only artifacts backing
  façade-as-endpoint predate those decisions.
- The scopes are not actually either/or: the façade plan's 7 tasks (interface,
  façade, registry, conformance suite, host refactor, `?engine` selection) are
  the *first commits* of the strict scope. Nothing in it is thrown away — only
  its exit criteria are extended.
- Codex's key argument seals the design point: a generic `unknown`/raw native
  handle would preserve behavior cheaply but **makes the seam unenforceable**,
  so it is rejected. Antigravity's `getController()` survives only as an
  **internal transitional device confined to `@geolibre/map`** — never exported.

**Governance precondition (copilot + claude, mandatory):** §2.2 says a design
change requires updating the design doc before proceeding, and
`migration-design.md` §5.3/§8 still carries the façade wording. Therefore,
before any runtime change:

1. The user confirms the strict scope (confirmed on 2026-07-20 by instructing
   Codex to implement this master plan autonomously to completion).
2. `migration-design.md` §5.3/§8 is amended to the strict Phase 0 exit, and
   §5.2 gains the capability groups (§4 below).
3. `docs/superpowers/plans/2026-07-20-phase0-map-engine-seam.md` is marked
   superseded-as-endpoint and re-scoped as Stage B of this plan.
4. The superseded/conflicting log entries get a pointer to this document.

## 4. The contract shape: typed capability groups (from codex)

Retain the §5.2 core (`mount`, `destroy`, `applyView`, `readView`,
`syncLayers`, `supportsLayer`, `hitTest`, `on`) and add **named, typed,
engine-neutral capability groups** — planned in
`packages/map/src/engine/types.ts` and `packages/map/src/engine/capabilities.ts`:

- **Viewport / navigation** — fit-to-layer, fit-to-bounds, camera moves, projection.
- **Layer inspection / presentation** — feature/source queries, style-derived state.
- **Controls / terrain** — control mounting, terrain toggles.
- **Capture** — engine-neutral capture results/surfaces (never the raw canvas API).
- **Transient interaction** — markers, hover/draw affordances.
- **Renderer extensions** — typed commands replacing direct plugin mounting.

Rules all four plans are compatible with:

- Optional capabilities are **advertised** by each adapter and
  **conformance-tested**; ArcGIS adapters may omit one but must say so.
- **No capability may expose an SDK object or an `unknown` native handle.**
- Any compatibility object a legacy integration needs stays **private to
  `MapLibreEngine`**; removal criterion is Phase 6 (MapLibre deletion).

## 5. Plugin API v2 (from copilot, reconciled with codex)

Reviewer-accepted on 2026-07-20: **seam enforcement over Plugin API v1
compatibility.**

- Plugin API v2 keeps store-backed data and UI registration but replaces native
  renderer access (`getMap`, `getDeckGL`, `getMaplibreGlRaster`, native
  controls/layers) with **typed engine-neutral commands** dispatched to the
  active `MapEngine`.
- Manifests and exports gain an **explicit API version**; incompatible v1
  plugins are **rejected with an actionable migration error** (browser and
  Tauri validators both). A migration guide ships in `docs/plugin-api.md`.
- v1 packages stop loading after Phase 0 until republished — tradeoff accepted;
  native renderer access is intentionally never restored.
- **Reconciling codex's open item:** codex wanted adapter-private compatibility
  verified against the plugin-install E2E fixture before removing public
  `getMap`. With the v1 break accepted, adapter-private compatibility applies
  only to **built-in** wrappers relocated under `@geolibre/map`; the
  plugin-install E2E fixture is **migrated to a v2 fixture plugin** (and a v1
  fixture asserting the rejection error), not used to preserve v1.
- Implementation scope: `packages/plugins/src/{types.ts,plugin-manager.ts}`,
  `apps/geolibre-desktop/src/{hooks/usePlugins.ts,lib/external-plugins.ts,lib/plugin-archive-unpack.ts}`,
  `apps/geolibre-desktop/src-tauri/src/lib.rs`, `docs/plugin-api.md`.

## 6. Unified Phase 0 plan (staged; each stage independently shippable and CI-green)

**Stage A — Governance (no runtime change).** Steps 1–4 of §3 above.

**Stage B — The seam.** Execute the existing 7-task plan, adjusted: engine
contract types **plus capability groups** (§4), test fakes, `MapLibreEngine`
façade delegating to `MapController` (`getController()` internal to
`@geolibre/map` only), engine registry, parameterized conformance suite,
`MapCanvas`/`SecondaryMapCanvas` host refactor, `?engine=` selection defaulting
to `maplibre`. Zero user-visible change; existing tests keep passing.

**Stage C — Consumer migration by capability group** (codex's sequencing).
Migrate the 74 files of app/hook/scripting consumers group by group —
viewport/navigation → layer inspection → controls/terrain → capture →
transient interaction — each group a reviewable PR with the boundary ratchet
(§7) tightened behind it.

**Stage D — Plugin relocation + Plugin API v2.** Move concrete MapLibre/deck.gl
plugin mounting from `@geolibre/plugins` under the `MapLibreEngine` adapter,
preserving plugin ids, store records, UI registrations, and project state.
Land the v2 version field, command union, validators, docs, and fixtures (§5).

**Stage E — Exit.** Remove the public `MapController` export and
`GeoLibreAppAPI.getMap`; boundary checks green (§7); full `npm run ci` and
Playwright suite pass.

**Merged exit criteria:**

- [ ] App behaves identically with `engine=maplibre` (zero user-visible change).
- [ ] `rg '\bMapController\b' apps packages --glob '!packages/map/**'` → 0 matches.
- [ ] No app/plugin module imports `maplibre-gl` or MapLibre plugin/control types.
- [ ] Conformance suite green for `MapLibreEngine`; capability advertisements tested.
- [ ] v1 plugin rejected with the actionable error; v2 fixture plugin installs (browser + Tauri).
- [ ] `npm run ci` passes; coverage ratchet holds (78/78/63 frontend, 55 backend).
- [ ] Every decision logged via `document-migration` into the runtime's log dir.

## 7. What each runtime uniquely taught (keep applying these)

- **antigravity:** quantified the React-side blast radius (80+ components) and
  showed a delegating façade with a scoped escape hatch keeps compile- and
  runtime-compatibility — the template for Stage B.
- **claude:** measured the true coupling (164 refs / 74 files); caught that the
  minimal interface and §2.2 were mutually unsatisfiable; and — most
  importantly — caught two concurrent sessions producing contradictory scopes
  because the design doc wasn't amended at decision time, then **blocked
  instead of self-resolving**. Process rule going forward: *a scope decision is
  not made until `migration-design.md` is amended in the same change*; one
  shared decision must be cross-linked into every runtime's log.
- **codex:** the capability-group decomposition, the rejection of `unknown`
  native handles as seam-destroying, migration sequenced by capability group,
  and adapter-private (never public) legacy compatibility.
- **copilot:** the amend-design-first sequencing, and Plugin API v2 with an
  explicit version gate and an intentional, documented v1 break.

## 8. Accepted tradeoffs and open items carried forward

- **Tradeoff (accepted twice by review):** Phase 0 becomes a broad pure
  refactor with real regression risk, before any ArcGIS adapter lands — the
  price of an enforceable seam.
- **Resolved:** user confirmation of the strict-scope arbitration (§3 step 1)
  was received on 2026-07-20; Stage A may proceed.
- **Open:** exact capability-group method shapes are locked by the reviewed
  Stage B/C plan, not this document.
- **Open (unchanged from the design):** headless `SceneView` launch flags and
  ArcGIS API key are Phase 1 prerequisites; the engine-neutral style model is
  the Phase 4 keystone and needs its own brainstorm.
