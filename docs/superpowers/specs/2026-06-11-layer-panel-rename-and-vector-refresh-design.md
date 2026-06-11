# Layer rename, Load button border fix, and Add-Vector-Layer auto refresh

Date: 2026-06-11

## Summary

Three independent changes, two repos:

1. **Rename layers** in the GeoLibre Layers panel (GeoLibre only).
2. **Fix the clipped "Load" button focus ring** in the Add Vector Layer panel (GeoLibre only).
3. **Enable Auto Refresh for Add-Vector-Layer GeoJSON-URL layers** via a new upstream `reloadLayer()` API (maplibre-gl-vector + GeoLibre).

Parts 1 and 2 ship together in a GeoLibre PR. Part 3 is upstream-first: add and release `reloadLayer()` in maplibre-gl-vector, then bump the dependency and wire it in GeoLibre.

## Part 1: Rename layers

### Goal
Let users rename a layer's display label in the Layers panel.

### Background
- `GeoLibreLayer.name` (`packages/core/src/types.ts`) is a pure display label. MapLibre sync keys off `layer.id`, never `name`, so a rename cannot break rendering (`packages/map/src/layer-sync.ts`, `map-controller.ts`).
- The store already has a generic `updateLayer(id, patch)` action (`packages/core/src/store.ts`), so renaming is `updateLayer(layer.id, { name })`. No new store action.

### Design (`apps/geolibre-desktop/src/components/panels/LayerPanel.tsx`)
- Track edit state with component state: `editingLayerId: string | null` and `editingName: string`.
- The layer name `<span>` (currently `LayerPanel.tsx:610`) renders as a text `<input>` when `editingLayerId === layer.id`, otherwise as the existing span.
- **Two entry triggers** (per user's choice):
  - Double-click the name span enters edit mode.
  - A new **Rename** `DropdownMenuItem` (with a `Pencil` icon) added at the top of the per-layer `...` menu (before "Materialize"/"Refresh").
- On entering edit mode the input auto-focuses and selects all text.
- **Commit:** Enter key or input blur calls `updateLayer(layer.id, { name: trimmed })`. No-op when the value is empty or unchanged. **Escape** cancels without committing.
- `stopPropagation` on the input's mouse/key events so editing does not toggle layer selection or trigger drag.
- Applies only to real `GeoLibreLayer` entries, not the synthetic "Background" basemap row.

### Testing
- A `tests/*.test.ts` frontend test asserting `updateLayer` renames and that sync/MapLibre is unaffected (name is not used as a key). Manual verification in the running app for the double-click and menu paths, including Escape-cancel and empty-name no-op.

## Part 2: Load button border clipping

### Goal
The "Load" button's focus ring in the Add Vector Layer panel is clipped on its right edge. Show the full ring.

### Root cause
- The button is the upstream `maplibre-gl-vector` `.vector-control-button`. Its `:focus` style is `outline: 2px solid; outline-offset: 2px` (upstream `maplibre-gl-vector.css`).
- The button sits flush against the right edge of `.vector-control-content`, which has `overflow-y: auto`. Per CSS, that forces `overflow-x` to a clipping value, so the offset focus ring is cut off on the right.

### Design (`apps/geolibre-desktop/src/index.css`)
- Add a scoped override under `.geolibre-vector-panel` (never edit `node_modules`, per repo convention) that gives the focus ring room so it is not clipped. Preferred approach: a few px of `padding-right` on `.vector-control-content` (and matching left padding to stay symmetric), or reduce the button's `outline-offset` so the ring stays inside the clip box.
- Choose whichever reads cleanest in the running app and verify visually in both light and dark themes.

### Testing
- Visual verification in the running web app: focus/click the Load button and confirm the full ring renders, including the right edge, in light and dark mode.

## Part 3: Auto Refresh for Add-Vector-Layer GeoJSON-URL layers

### Goal
A GeoJSON layer added through the Add Vector Layer panel via an HTTP(S) URL should support manual Refresh and Auto Refresh, matching WFS layers.

### Background / why it is currently excluded
- WFS layers are added through `addGeoJsonLayer` and are store-rendered GeoJSON; the existing refresh path re-fetches and calls `updateLayer({ geojson })` (`apps/geolibre-desktop/src/lib/layer-refresh.ts`).
- Add-Vector-Layer URL layers are created by the external maplibre-gl-vector control, which owns native MapLibre sources/layers. Their store layer is tagged `externalNativeLayer: true` and `sourceKind: "maplibre-gl-vector"` (`packages/plugins/src/plugins/vector-layer-sync.ts: createVectorStoreLayer`).
- `refreshSourceUrl` returns `null` when `externalNativeLayer === true` (`layer-refresh.ts:188`), so these layers are never refreshable. The store-geojson refresh path also cannot drive them, because the control renders the data, not the store.
- The control exposes only `addData()` and `removeLayer()` (no in-place reload). Remove + re-add would mint a new layer id each refresh, breaking selection, ordering, and the auto-refresh timer config. Hence the upstream-first approach.

### Upstream change (maplibre-gl-vector)

Add an in-place reload that re-fetches a URL-backed layer while preserving its id, source id, style, render mode, and position. Model it on the existing in-place `setRenderMode()` re-render (`src/lib/core/LayerManager.ts`).

`LayerManager.reloadLayer(id)`:
1. Look up the record; return `undefined` if missing. If `record.source` is not a URL string, return the current info unchanged (files/in-memory GeoJSON are static).
2. Emit `loading` (`Refreshing <name>...`).
3. Tear down current presentation: `_detachPicker`, `removeLayersAndSource(map, layerIds, sourceId)`, unregister the tile provider if any, reset `record.info.layerIds = []`.
4. Drop the stale engine table (`record.tableName`) and clear it, so the next ingest re-fetches fresh data.
5. Re-run the load pipeline preserving the current render mode/ingest mode/sourceLayer: `_addGeoJSON(record, opts)` for GeoJSON render, else `_addViaEngine(record, opts)`. Passing the resolved `renderMode` ('geojson'/'tiles') keeps the chosen mode stable.
6. Emit `layerupdated` (same event `setRenderMode` uses) and return the refreshed info.

`VectorControl.reloadLayer(id)` delegates to `this._layerManager?.reloadLayer(id)`. Expose it on the type declarations (`dist/types`) and the React imperative handle (`VectorControlReact` / `react.ts`) for parity with `removeLayer`/`getLayers`.

Add a unit test (vitest) that reloads a URL layer and asserts the id/sourceId are preserved and the data re-fetches. Release a new version (the opengeos packages publish to npm on `gh release create`).

### GeoLibre wiring (after the upstream release)
- Bump the `maplibre-gl-vector` dependency to the release that includes `reloadLayer()`.
- `packages/plugins/src/plugins/vector-layer-sync.ts`: add `reloadLayer` to the `VectorSyncableControl` type.
- `packages/plugins/src/plugins/maplibre-vector.ts`: export an accessor for the active control (or a `refreshVectorLayer(id)` helper) so the refresh handler can reach it.
- `apps/geolibre-desktop/src/lib/layer-refresh.ts`: treat a vector-control layer (`type === "geojson"`, `externalNativeLayer === true`, `sourceKind === "maplibre-gl-vector"`) with an HTTP(S) URL as refreshable, instead of bailing on the `externalNativeLayer` flag.
- `apps/geolibre-desktop/src/components/panels/LayerPanel.tsx`: branch `handleRefreshLayer` so vector-control layers refresh through `control.reloadLayer(layer.id)`, while existing store-geojson layers keep the `refreshGeoJsonLayer` + `updateLayer` path. The id is stable across reload, so the existing auto-refresh scheduler (keyed by `layer.id`) keeps working without timer churn. Update the menu hint text accordingly.

### Testing
- Upstream: vitest for `reloadLayer` (id/source preserved, data re-fetched).
- GeoLibre: frontend test that `isRefreshableLayer` returns true for a vector-control URL layer; manual verification in the running app that manual Refresh and Auto Refresh both work for an Add-Vector-Layer URL layer and the layer id/selection/position survive a refresh.

## Sequencing
1. GeoLibre PR: Part 1 + Part 2.
2. maplibre-gl-vector: implement + test + release `reloadLayer()`.
3. GeoLibre PR: bump dep + Part 3 wiring.
