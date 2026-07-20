# Document Migration Steps

**Canonical skill body — single source of truth.** Every agent (Claude, Codex,
Antigravity, Copilot) is routed here by its own thin adapter. Follow this file
exactly. Do not copy or fork it; edit it here and every agent inherits the change.

## The migration

GeoLibre is being migrated **off** four rendering libraries **onto** the
**ArcGIS Maps SDK for JavaScript** (`@arcgis/core` + `@arcgis/map-components`):

| Source library      | Role today                              | Typical ArcGIS target (a hint, not a rule)                                    |
| ------------------- | --------------------------------------- | ----------------------------------------------------------------------------- |
| **MapLibre GL JS**  | 2D vector/raster map, sources & layers  | `MapView` + `Map`, `FeatureLayer` / `VectorTileLayer` / `GraphicsLayer`, renderers, popups |
| **deck.gl**         | GPU overlays (points, 3D, raster)       | `FeatureLayer` renderers, `GraphicsLayer`, custom WebGL (`RenderNode` / `BaseLayerViewGL2D`), or `@deck.gl/arcgis` interop |
| **three.js**        | Custom 3D meshes / effects              | `SceneView` `RenderNode` / external renderer, mesh `Graphic`, `SceneLayer`     |
| **Cesium**          | 3D globe, terrain, 3D tiles             | `SceneView`, elevation/ground, `SceneLayer` / `IntegratedMeshLayer` / I3S 3D tiles |

The target-column APIs are **starting points**, not prescriptions — record what
you actually used.

## Your job

While you migrate, **document each meaningful step as you take it** so the work
can be reconstructed and compared across agents. You are producing a running
record, not a final report — append immediately, do not batch it up for the end.

## When to document (triggers)

Write an entry whenever any of these happens:

- A source API/pattern was **ported** to an ArcGIS equivalent.
- An **ArcGIS equivalent was chosen** among several (say why this one).
- A MapLibre / deck.gl / three.js / Cesium capability has **no ArcGIS
  equivalent**, or ArcGIS does it materially differently (a **gap**).
- A **workaround** or shim was adopted.
- A **tradeoff** was explicitly accepted (perf, fidelity, DX, bundle size).
- A step was **blocked** or an approach **rejected** as not feasible.
- An architecture/sequencing decision was made that affects later steps.

If in doubt, write it down. A migration is judged on its gaps and workarounds as
much as its successes.

## Where the docs go

Write **only** into **your own agent folder**:

```
.migrate-docs/<agent>/
  00-overview.md            status dashboard + index (keep current)
  maplibre.md               MapLibre GL JS → ArcGIS step log
  deckgl.md                 deck.gl → ArcGIS step log
  threejs.md                three.js → ArcGIS step log
  cesium.md                 Cesium → ArcGIS step log
  gaps-and-workarounds.md   cross-cutting ArcGIS limitations + workarounds
```

`<agent>` is **your own short slug**, lowercase:

- Claude → `.migrate-docs/claude/`
- Codex → `.migrate-docs/codex/`
- Antigravity → `.migrate-docs/antigravity/`
- Copilot → `.migrate-docs/copilot/`

Put each entry in the file for the **source library** it concerns. Cross-cutting
ArcGIS gaps (things that bit you across multiple libraries) also get a one-line
pointer in `gaps-and-workarounds.md`.

## Concurrency rules (all four agents may run at once)

- **Only ever write inside your own `.migrate-docs/<agent>/` folder.** Never
  edit another agent's folder, and never edit `document-migration.md`.
- Do not treat another agent's notes as ground truth — they may have made
  different choices. Compare, don't copy.
- Keep `00-overview.md` current after each step so a reviewer can see status at a
  glance without reading every entry.

## Procedure

1. Take the migration step (or hit the gap/decision).
2. Pick the source-library file in your folder. Create it from the templates
   below if it doesn't exist yet.
3. **Append** a dated entry using the **Migration-step entry template**.
4. Link concrete artifacts: source file paths (before → after), PRs, commits.
5. Update the dashboard in `00-overview.md`.
6. Run the completion checks before moving on.

## Migration-step entry template

Use this exact structure. All fields are required; write `none` where a field
does not apply — do not delete fields.

```markdown
## YYYY-MM-DD — <Source API/feature> → <ArcGIS equivalent>

- Source: <MapLibre | deck.gl | three.js | Cesium> — the exact API/pattern being
  migrated (e.g. `new maplibregl.Map(...)`, deck.gl `ScatterplotLayer`,
  three.js `WebGLRenderer`, Cesium `Cesium3DTileset`).
- Files touched: paths, before → after (e.g. `packages/map/src/MapController.ts`).
- ArcGIS approach: the `@arcgis/core` / map-component API used and why this one.
- What changed: concrete description of the code transformation.
- Gap / limitation: capability the source lib had that ArcGIS lacks or does
  differently — or `none`.
- Workaround: what you did instead, and the removal criteria (what future
  ArcGIS feature or change would let this be deleted) — or `none`.
- Tradeoff accepted: explicit downside/cost (perf, visual fidelity, bundle,
  DX) — or `none`.
- Status: done | partial | blocked | rejected.
- Verification: how you checked it — build/typecheck/renders/test, with the
  command and result (e.g. `npm run typecheck` → passed; renders in dev at
  localhost:5173). Not "looks right" — evidence.
- Follow-up: next action and rough owner/date, or `none`.
```

## Decision branching

- **Rejection / not feasible:** emphasize the constraint, the evidence, and the
  ArcGIS-specific reason. Record what would make it feasible later.
- **Workaround:** record the trigger condition and the removal criteria.
- **Architecture change:** include migration impact on later steps and whether
  rollback is feasible.
- **Uncertain:** record the assumption and a review date.

## `00-overview.md` shape

Keep a compact dashboard at the top of your folder:

```markdown
# Migration overview — <agent>

Target: ArcGIS Maps SDK for JavaScript (@arcgis/core + @arcgis/map-components)
Last updated: YYYY-MM-DD

| Source library | Status              | Blockers / open gaps            |
| -------------- | ------------------- | ------------------------------- |
| MapLibre GL JS | not started         | —                               |
| deck.gl        | not started         | —                               |
| three.js       | not started         | —                               |
| Cesium         | not started         | —                               |

## Index
- [MapLibre](maplibre.md)
- [deck.gl](deckgl.md)
- [three.js](threejs.md)
- [Cesium](cesium.md)
- [Gaps & workarounds](gaps-and-workarounds.md)

## Key decisions & open questions
- (running list)
```

Status values: `not started` · `in progress` · `partial` · `blocked` · `done`.

## Quality checks

An entry is complete only if **all** pass:

- Date and a `From → To` title are present.
- The source API and the ArcGIS approach are both named specifically.
- Gap / limitation is answered (a real gap, or `none`), not skipped.
- Workaround (if any) has removal criteria.
- Tradeoff is explicit, not implied.
- Verification records how it was checked, with evidence — not an assertion.
- A reviewer who is not you could understand and defend the step.

Do not skip fields. `none` is a valid value; a deleted field is not.
