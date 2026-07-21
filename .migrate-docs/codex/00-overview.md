# Migration overview — codex

Target: ArcGIS Maps SDK for JavaScript (@arcgis/core + @arcgis/map-components)
Last updated: 2026-07-20

| Source library | Status      | Blockers / open gaps |
| -------------- | ----------- | -------------------- |
| MapLibre GL JS | in progress | ArcGIS `MapView` opt-in is 2D/core-layer only; MapLibre style and optional runtime parity remain |
| deck.gl        | not started | —                    |
| three.js       | not started | —                    |
| Cesium         | in progress | ArcGIS `SceneView` is a core-layer opt-in; I3S/terrain/keyed parity remains |

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
- Implemented: Directions now owns its native MapLibre routing session and
  loading control in a lazy adapter runtime. Its banner consumes validated,
  transient session state and sends remove/clear requests through typed engine
  commands; the boundary ratchet is 129 reviewed violations.
- Implemented: Earth Engine's native control, private control hooks, and
  store-layer reconciliation are now a lazy MapLibre runtime. The toolbar holds
  only renderer-neutral visibility state and invokes typed lifecycle/hide
  commands; the boundary ratchet is 128 reviewed violations.
- Implemented: GeoAgent now uses the generic hosted-plugin descriptor while its
  native MapLibre/deck.gl/Earth Engine tools and store-backed overlay mirror run
  in a lazy adapter runtime. The boundary ratchet is 125 reviewed violations.
- Implemented: Planetary Computer's native control, STAC/TiTiler clients, and
  saved-layer replay now run in a lazy MapLibre adapter runtime. The app only
  sends hosted lifecycle requests for open, close, and store-layer restoration;
  the boundary ratchet is 124 reviewed violations.
- Implemented: Atmospheric Effects now keeps its serializable settings model
  renderer-neutral while the MapLibre canvas stack, map events, and globe math
  run in a lazy adapter runtime. The boundary ratchet is 123 reviewed
  violations.
- Implemented: Annotations now exposes only serialized labels, position, and
  hosted MapEngine commands; its MapLibre toolbar, pointer/text interactions,
  and transient preview layers are lazy adapter runtime code. The persisted
  GeoJSON annotation layer remains store-authoritative, and the boundary
  ratchet is 122 reviewed violations.
- Implemented: Time Slider's persisted time-binding model and timestamp/date
  helpers now belong to core; MapLibre expression translation remains isolated
  pending relocation of the native slider runtime. This preserves store metadata
  and gives ArcGIS a direct `FeatureFilter`-model input.
- Implemented: Time Slider's native control, source adapters, theme observer,
  and MapLibre time filtering now run only in a lazy MapLibre hosted runtime.
  The plugin keeps validated serialized project state and typed MapEngine
  calls; store layers remain authoritative. The boundary ratchet is now 119
  reviewed violations.
- Implemented: pixel-series DTOs and pure chart/export transformations now
  belong to core, and COG pixel reads now run through a typed lazy MapEngine
  extension; the adapter preserves the existing request semantics without
  changing ingest.
- Implemented: Gridlines' serialized model is in core and its MapLibre
  `line`/`symbol` layers, control, events, and sidebar panel are a lazy adapter
  runtime. The typed panel host preserves the existing UI and reduces the
  boundary baseline to 118 without changing project state or ingest.
- Implemented: Mapillary coverage, selection, viewer, and floating-panel DOM
  are a lazy MapLibre runtime. Typed panel and store-layer bridges keep layer
  records host-owned and reduce the boundary baseline to 117.
- Implemented: value-identical camera events now preserve the authoritative
  `mapView` reference, preventing a MapEngine `applyView`/`moveend` echo from
  recursively re-running synchronized-view effects.
- Implemented: the ArcGIS JavaScript SDK is package-local and its runtime
  workers/styles/locales are staged under the app base path for a lazy opt-in
  `MapView`; MapLibre remains the default engine.
- Implemented: a pure `MapViewState` ↔ ArcGIS `MapView` camera conversion
  retains project pitch and detects only floating-point camera echoes.
- Implemented: `?engine=arcgis` now selects a lazy, store-first ArcGIS 2D
  `MapView` adapter. It mounts an attributed OpenStreetMap `WebTileLayer`,
  reconciles GeoJSON/raster/XYZ/WMS/WMTS store records, and enters the shared
  engine conformance suite; the engine-boundary baseline fell 117 → 115;
  MapLibre remains the default engine.
- Implemented: ArcGIS `SceneView` camera conversion now maps the store's
  center/zoom/bearing/pitch through documented SceneView zoom/heading/tilt
  properties; the lazy 3D adapter and browser parity remain in progress.
- Implemented: `?sceneEngine=arcgis` selects a lazy, keyless `SceneView` for a
  secondary 3D globe. It is conformance- and browser-tested for store-driven
  GeoJSON/raster/XYZ/WMS/WMTS layers; generic Cesium 3D Tiles remain unsupported
  pending explicit I3S layer classification.
- Implemented: ArcGIS `MapView` and `SceneView` now advertise feature-query
  support for store-backed GeoJSON only. ArcGIS hit results are translated into
  neutral DTOs from the current store snapshot; raster, vector-tile, highlight,
  and popup parity remain open.
- Implemented: ArcGIS `MapView` and `SceneView` now provide one native,
  MapEngine-owned DOM-content popup and report user closure through the existing
  neutral callback. Automatic SDK feature popups remain disabled so application
  event routing stays authoritative.
- Implemented: ArcGIS `MapView` and `SceneView` now mount transient GeoJSON
  overlays and store-backed selection highlights as lazy, adapter-owned
  `GeoJSONLayer` instances. The store layer snapshot remains authoritative;
  preview and highlight layers are removed/recreated with the view runtime and
  never enter it.
- Implemented: cancelable point/bounds gestures, marker rotation and drag
  lifecycle, double-click drawing policy, and restorable transient GeoJSON
  overlays now live behind `MapEngineClient.interactions`. GPS, collaboration,
  field collection, georeferencing, raster/basemap subset selection, time-series
  picking, region selection, print extent, and processing consumers are
  renderer-neutral. That earlier slice reduced the boundary baseline to 154
  reviewed violations; later entries record subsequent reductions.
