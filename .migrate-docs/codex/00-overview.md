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
- Implemented: map-video and tour-video recording now build their output canvas
  from `viewport.capture`; tours use engine camera transitions/idle waits and a
  restorable navigation suspension. The boundary ratchet is down to 149 reviewed
  violations.
- Implemented: story presentation now owns its main marker, layer effects, and
  viewport portal through `MapEngineClient`; an `@geolibre/map` inset host mounts
  and tears down a restricted lazy engine handle. The boundary ratchet is down
  to 147 reviewed violations.
- Implemented: external plugin manifests and entry exports now require Plugin
  API v2 before archive extraction, URL entry fetch, or module execution. The
  version gate and restore activation context are complete; public native API
  removal follows with first-party runtime relocation.
- Implemented: the MapLibre adapter now owns a per-engine lazy hosted-runtime
  registry. Layer Control and Street View are relocated descriptor/runtime
  pairs; a runtime-import failure reaches the existing plugin activation
  rollback. Active-by-default controls lazily resolve their adapter runtime on
  first hide or position request, preserving restored project state.
- Implemented: FEMA NFHL, NASA Earthdata, EnviroAtlas, and National Map now
  run as lazy MapLibre provider-control runtimes. Their bidirectional
  store-sync helper moved with them; store layers remain authoritative and
  restored controls receive their collapse intent through the runtime contract.
- Implemented: the USGS LiDAR viewer, its upstream type shim, and its dynamic
  deck.gl loading path now belong to the MapLibre adapter. The source-of-truth
  projection preference and 3DEP coverage layer remain store actions; the
  boundary ratchet is down to 137 reviewed violations.
- Implemented: Historical Imagery now loads as an adapter-owned Esri Wayback
  runtime. Its release/persistent imagery records remain synchronized through
  the store; the boundary ratchet is down to 135 reviewed violations.
- Implemented: stateful hosted controls can now pass validated serializable
  project state and the existing text-export host service through typed
  `MapEngineClient` activation commands, without exposing a renderer object.
- Implemented: Overture Maps now owns its PMTiles control/runtime and
  bidirectional store mirror inside the MapLibre adapter while the plugin keeps
  only a validated stateful descriptor; the boundary ratchet is 134 reviewed
  violations.
- Implemented: Reverse Geocode now subscribes, changes its cursor, and owns
  loading/result popup lifecycle solely through `MapEngineClient`; a typed
  popup-close callback prevents stale lookup results from reopening a dismissed
  popup, and the boundary ratchet is 133 reviewed violations.
- Implemented: Basemap Control is now a renderer-neutral descriptor backed by a
  lazy MapLibre adapter runtime. Background-style selection and stacked raster
  basemap records continue through the existing store actions; the boundary
  ratchet is 132 reviewed violations.
- Implemented: Sun Simulation keeps its pure clock/astronomy model and panel
  state renderer-neutral, while its MapLibre canvas mask, scene light, and
  animation loop are a lazy adapter runtime. The boundary ratchet is 131
  reviewed violations.
- Implemented: animated Weather layers replace live raster tiles and observe
  source failures through the typed layer/event ports; their remote frame
  loading and store records remain untouched. The boundary ratchet is 130
  reviewed violations.
- Implemented: cancelable point/bounds gestures, marker rotation and drag
  lifecycle, double-click drawing policy, and restorable transient GeoJSON
  overlays now live behind `MapEngineClient.interactions`. GPS, collaboration,
  field collection, georeferencing, raster/basemap subset selection, time-series
  picking, region selection, print extent, and processing consumers are
  renderer-neutral. That earlier slice reduced the boundary baseline to 154
  reviewed violations; later entries record subsequent reductions.
