# Migration overview — codex

Target: ArcGIS Maps SDK for JavaScript (@arcgis/core + @arcgis/map-components)
Last updated: 2026-07-20

| Source library | Status      | Blockers / open gaps |
| -------------- | ----------- | -------------------- |
| MapLibre GL JS | in progress | Strict Phase 0 implementation started on `codex-migrate-to-arcgisjsapi` |
| deck.gl        | not started | —                    |
| three.js       | not started | —                    |
| Cesium         | not started | —                    |

Status values: not started · in progress · partial · blocked · done

## Index
- [MapLibre](maplibre.md)
- [deck.gl](deckgl.md)
- [three.js](threejs.md)
- [Cesium](cesium.md)
- [Gaps & workarounds](gaps-and-workarounds.md)

## Key decisions & open questions
- Decision: extend the §5.2 core contract with typed, engine-neutral capability
  groups for viewport/navigation, layer inspection/presentation,
  controls/terrain, capture, transient interaction, and renderer extensions.
  Optional capabilities are advertised and conformance-tested; no capability
  may expose an SDK object or `unknown` native-map handle.
- Decision: external Plugin API v1 is intentionally rejected. Plugin API v2
  exposes `MapEngineClient`; only first-party concrete runtimes are relocated
  adapter-private, preserving their ids and project state.
- Decision: the instruction to implement the master plan confirms the strict
  Phase 0 arbitration recorded in `.migrate-docs/migration-plan.md` §3.
- Implemented: the engine-neutral contract and typed extension command map are
  exported from `@geolibre/map`; the boundary ratchet records 197 reviewed
  path/pattern violations and rejects additions or unreviewed changes.
- Implemented: `createMapEngineHandle("maplibre")` is synchronous, queues
  ordered pre-ready mutations, forwards normalized events, and lazy-loads a
  `MapLibreEngine` that keeps `MapController` private to the adapter.
