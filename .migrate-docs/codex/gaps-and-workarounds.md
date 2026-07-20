# ArcGIS migration gaps and workarounds — codex

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
