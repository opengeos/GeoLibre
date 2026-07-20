# Migration overview — codex

Target: ArcGIS Maps SDK for JavaScript (@arcgis/core + @arcgis/map-components)
Last updated: 2026-07-20

| Source library | Status      | Blockers / open gaps |
| -------------- | ----------- | -------------------- |
| MapLibre GL JS | in progress | Strict Phase 0 implementation started on `codex-migrate-to-arcgisjsapi` |
| deck.gl        | not started | —                    |
| three.js       | not started | —                    |
| Cesium         | in progress | Adapter complete; ArcGIS `SceneView` replacement remains |

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
- Implemented: Cesium viewer/camera/layer ownership is behind `CesiumEngine`;
  the compatibility canvas now talks only to the seam, and unsupported optional
  capabilities throw `MapEngineCapabilityError`.
- Implemented: the shared conformance suite runs the same lifecycle, view,
  layer-order, hit, event-unsubscribe, pre-ready queue, and unsupported-operation
  assertions against MapLibre and Cesium.
- Implemented: applications select panes only through `EngineCanvas` and engine
  ids. The boundary ratchet is down to 196 reviewed violations; the primary
  controller compatibility bridge remains package-private pending consumer
  migration.
- Implemented: camera, viewport-history, collaboration-presence, project
  snapshot, story-camera, built-in-control, terrain, place-search, scripting,
  and assistant consumers now use engine ports. Tagged engine events replace
  native move payloads, `run_maplibre_js` is removed, and the boundary ratchet
  is down to 178 reviewed violations.
- Implemented: MapLibre source/style discovery, vector-tile viewport querying,
  and clipped-feature deduplication now live adapter-side in `@geolibre/map`.
  Export, Attribute Table, story, processing, editor, notebook/widget,
  scripting, and assistant consumers use the layer/camera/viewport ports;
  renderer snapshots stay store-first and read-only. The boundary ratchet is
  down to 167 reviewed violations.
- Implemented: viewport capture now belongs to `MapEngineClient.viewport`.
  Print preview/atlas and story handouts receive composited renderer-neutral
  snapshots, while camera bounds/zoom range, graticule inspection, hidden
  transient overlays, and story opacity effects stay behind typed engine ports.
  The boundary ratchet is down to 151 reviewed violations.
- Implemented: cancelable point/bounds gestures, marker rotation and drag
  lifecycle, double-click drawing policy, and restorable transient GeoJSON
  overlays now live behind `MapEngineClient.interactions`. GPS, collaboration,
  field collection, georeferencing, raster/basemap subset selection, time-series
  picking, region selection, print extent, and processing consumers are
  renderer-neutral. The boundary ratchet is down to 154 reviewed violations.
