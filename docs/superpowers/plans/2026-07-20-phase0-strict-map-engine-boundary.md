# Phase 0 Strict MapEngine Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

> **Runtime adaptation:** this plan was synthesized in a Copilot session, but
> each implementing runtime writes only to its own `.migrate-docs/<agent>/`
> folder and authors its own commits. The Copilot paths and co-author trailers
> in task examples record plan provenance; they are not instructions to
> misattribute another runtime's implementation commits.

**Goal:** Introduce the complete `MapEngine` seam and finish Phase 0 with no
concrete MapLibre, deck.gl, three.js, or Cesium renderer access outside
`@geolibre/map`, while preserving current first-party behavior and replacing
external Plugin API v1 with engine-neutral Plugin API v2.

**Architecture:** `@geolibre/core` remains the source of truth and data ingest is
unchanged. `@geolibre/map` owns lazy engine adapters, concrete renderer/plugin
runtimes, and an expanded engine-neutral client contract; the app and
`@geolibre/plugins` hold only `MapEngineClient` references. Existing plugin ids
and project-state keys remain stable, but external plugins must declare API
version 2 and use engine-neutral map capabilities.

**Tech Stack:** TypeScript 7, React 19, Zustand, MapLibre GL JS, CesiumJS,
deck.gl, three.js, npm workspaces, Node test runner with `tsx`, Playwright,
Tauri v2/Rust.

## Global Constraints

- Work on a branch, never `main`; attribute commits to their actual author.
- `@geolibre/core` store, `GeoLibreLayer`, `MapViewState`, and
  `.geolibre.json` remain authoritative and engine-neutral.
- All engine reads and writes go through `MapEngine`/`MapEngineClient`.
- SDKs and hosted renderer extensions load dynamically; module-scope imports are
  type-only.
- Do not modify DuckDB-WASM, `ST_Read`, shpjs, KMZ, file pickers, Add Data
  parsing, or other ingest paths.
- Preserve current first-party behavior, plugin ids, project plugin settings,
  and the default `maplibre` engine.
- External Plugin API v1 compatibility is intentionally not preserved.
- The pure `@maplibre/maplibre-gl-style-spec` expression compiler in
  `@geolibre/core` is not a renderer escape hatch; its replacement remains
  Phase 4 work.
- Every new engine capability requires conformance coverage.
- Frontend coverage remains at least 78% lines, 78% branches, and 63%
  functions; backend remains at least 55%.
- Log each decision immediately in the implementing runtime's own
  `.migrate-docs/<agent>/` folder.
- Use targeted tests per commit, scoped pre-commit before push, and `npm run ci`
  at the phase exit.

## Target File Structure

| Path | Responsibility |
| --- | --- |
| `packages/map/src/engine/types.ts` | Pure engine/client contracts, events, camera, layer, viewport, interaction, popup, control, and capture types. |
| `packages/map/src/engine/extensions.ts` | Typed extension-command map and dispatcher signatures. |
| `packages/map/src/engine/handle.ts` | Stable synchronous handle that queues mutations while an adapter lazy-loads. |
| `packages/map/src/engine/registry.ts` | Engine ids, query-param resolution, capability metadata, and lazy factories. |
| `packages/map/src/engine/maplibre-engine.ts` | `MapEngine` adapter over the current `MapController`. |
| `packages/map/src/engine/cesium-engine.ts` | `MapEngine` adapter extracted from `CesiumCanvas`. |
| `packages/map/src/EngineCanvas.tsx` | Engine-agnostic React host for primary and secondary panes. |
| `packages/map/src/maplibre-runtime/**` | Concrete MapLibre/deck.gl/three.js built-in plugin runtimes and helpers. |
| `packages/plugins/src/hosted-map-plugin.ts` | Engine-neutral built-in descriptor factory preserving plugin ids/state keys. |
| `tests/engine-boundary.test.ts` | Source-level gate preventing concrete renderer imports outside `@geolibre/map`. |
| `tests/engine-conformance.test.ts` | Parameterized adapter contract suite. |

## Contract to Implement

`packages/map/src/engine/types.ts` must define the following shape. Keep the
original eight seam operations and group additional capabilities so consumers
do not grow another monolithic controller:

```ts
import type {
  GeoLibreLayer,
  MapPreferences,
  MapProjection,
  MapViewState,
  StoryChapterLocation,
} from "@geolibre/core";
import type { Feature, FeatureCollection, Geometry } from "geojson";

export type MapEngineId = "maplibre" | "cesium";
export type MapEngineCapability =
  | "capture"
  | "controls"
  | "feature-query"
  | "interactions"
  | "markers"
  | "popups"
  | "transient-overlays";
export type LngLat = [number, number];
export type BBox = [number, number, number, number];
export interface ScreenPoint { x: number; y: number }
export interface HitFeature {
  layerId: string;
  featureId: string | null;
  properties: Record<string, unknown>;
  geometry: Geometry | null;
}
export type Unsubscribe = () => void;

export interface MapEngineEventMap {
  load: { reason: "mount" | "style" };
  idle: undefined;
  movestart: { userDriven: boolean };
  move: { view: MapViewState; userDriven: boolean };
  moveend: { view: MapViewState; userDriven: boolean; tag?: string };
  click: { point: ScreenPoint; lngLat: LngLat };
  dblclick: { point: ScreenPoint; lngLat: LngLat };
  contextmenu: { point: ScreenPoint; lngLat: LngLat };
  pointermove: { point: ScreenPoint; lngLat: LngLat };
  pointerleave: undefined;
  dragstart: undefined;
  resize: undefined;
  error: { message: string; detail?: string; source?: string; status?: number; url?: string };
}

export interface MapCameraPort {
  readView(): MapViewState;
  applyView(view: MapViewState, options?: {
    mode?: "jump" | "ease" | "fly";
    durationMs?: number;
    tag?: string;
  }): void;
  flyToLocation(location: StoryChapterLocation): void;
  fitBounds(bounds: BBox, options?: { padding?: number; animate?: boolean }): void;
  fitLayer(layer: GeoLibreLayer): void;
  zoomIn(): void;
  zoomOut(): void;
  resetNorth(): void;
  resetPitch(): void;
  resetNorthPitch(): void;
  readProjection(): MapProjection;
  isMoving(): boolean;
  whenIdle(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<void>;
}

export interface MapLayerPort {
  readGeoJson(layerId: string): Promise<FeatureCollection | null>;
  readRasterSource(layerId: string): Record<string, unknown> | null;
  queryInView(layerId: string): Feature[];
  listRenderTargets(): Array<{ id: string; scope: "basemap" | "content" | "overlay" }>;
  queryAtLngLat(lngLat: LngLat, layerId?: string): Promise<HitFeature[]>;
  setHighlight(layer: GeoLibreLayer | undefined, featureIds: readonly string[], options?: { fit?: boolean }): void;
  clearHighlight(): void;
}

export interface MapViewportPort {
  project(lngLat: LngLat): ScreenPoint | null;
  unproject(point: ScreenPoint): LngLat | null;
  getElement(): HTMLElement | null;
  getRect(): DOMRectReadOnly | null;
  capture(options?: { bounds?: BBox; hideOverlayIds?: string[] }): Promise<{
    canvas: HTMLCanvasElement;
    width: number;
    height: number;
    metersPerPixel: number;
    bearing: number;
  }>;
}

export interface MapInteractionPort {
  pickPoint(options?: { signal?: AbortSignal }): Promise<LngLat | null>;
  drawBounds(options?: {
    aspectRatio?: number;
    signal?: AbortSignal;
    onPreview?: (bounds: BBox | null) => void;
  }): Promise<BBox | null>;
  createMarker(options: MapMarkerOptions): MapMarkerHandle;
  upsertGeoJsonOverlay(spec: GeoJsonOverlaySpec): void;
  setOverlayVisible(id: string, visible: boolean): void;
  removeOverlay(id: string): void;
  showPopup(options: {
    id: string;
    lngLat: LngLat;
    content: HTMLElement;
    closeOnClick?: boolean;
    maxWidth?: string;
  }): void;
  closePopup(id: string): void;
}

export interface MapControlPort {
  getBuiltInState(control: BuiltInMapControl): {
    visible: boolean;
    position: MapControlPosition;
  };
  setBuiltInState(
    control: BuiltInMapControl,
    state: Partial<{ visible: boolean; position: MapControlPosition }>,
  ): boolean;
  setLabels(labels: Partial<Record<"compass" | "terrain" | "background", string>>): void;
  getTerrainExaggeration(): number;
  setTerrainExaggeration(value: number): void;
}

export interface MapEngineClient {
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

export interface MapEngine extends MapEngineClient {
  mount(container: HTMLElement, initialView: MapViewState): Promise<void>;
  destroy(): void;
  configure(options: {
    preferences?: MapPreferences;
    basemapStyleUrl?: string;
    basemapVisible?: boolean;
    basemapOpacity?: number;
  }): void;
  applyView(view: MapViewState): void;
  readView(): MapViewState;
  syncLayers(layers: GeoLibreLayer[]): void;
  supports(capability: MapEngineCapability): boolean;
  supportsLayer(layer: GeoLibreLayer): boolean;
  hitTest(point: ScreenPoint): Promise<HitFeature[]>;
}
```

`MapMarkerOptions`, `MapMarkerHandle`, `GeoJsonOverlaySpec`,
`BuiltInMapControl`, and `MapControlPosition` must also be engine-neutral
contracts in this file. `MapEngineExtensionMap` starts with hosted-plugin
lifecycle commands and is augmented by focused runtime modules:

```ts
export interface MapEngineExtensionMap {
  "hosted-plugin.activate": {
    input: { pluginId: string; position?: MapControlPosition; collapsed?: boolean };
    output: boolean | Promise<boolean>;
  };
  "hosted-plugin.deactivate": {
    input: { pluginId: string };
    output: void;
  };
  "hosted-plugin.set-position": {
    input: { pluginId: string; position: MapControlPosition; collapsed?: boolean };
    output: boolean;
  };
  "hosted-plugin.get-state": {
    input: { pluginId: string };
    output: unknown;
  };
  "hosted-plugin.apply-state": {
    input: { pluginId: string; state: unknown };
    output: boolean;
  };
}
```

---

### Task 1: Align the Source-of-Truth Design

**Files:**
- Modify: `.migrate-docs/migration-design.md:43-61,148-187,236-261`
- Modify: `docs/superpowers/plans/2026-07-20-phase0-map-engine-seam.md`
- Modify: `.migrate-docs/copilot/{00-overview.md,maplibre.md,gaps-and-workarounds.md}`

**Produces:** one unambiguous strict Phase 0 definition before runtime edits.

- [ ] Create the implementation branch:

```bash
git switch -c feat/phase0-strict-map-engine-boundary
```

- [ ] Update §5.2 with the expanded capability ports above and state that
  engine-neutral additions require conformance tests.
- [ ] Update §5.3/§8 so Phase 0 includes all app/plugin concrete access,
  `CesiumEngine`, Plugin API v2, and the boundary test.
- [ ] Retain the old plan only as a clearly marked historical/superseded file.
- [ ] Append a migration entry with status `done` and verification
  `git diff --check`.
- [ ] Run `git diff --check`.
- [ ] Commit:

```bash
git add .migrate-docs docs/superpowers/plans
git commit -m "docs(migration): align Phase 0 with the strict engine boundary

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Add the Contracts and Boundary Gate

**Files:**
- Create: `packages/map/src/engine/{types.ts,extensions.ts}`
- Modify: `packages/map/src/index.ts`
- Create: `tests/engine-boundary.test.ts`
- Create: `tests/engine-contracts.test.ts`
- Create: `tests/fixtures/engine-boundary-baseline.json`

**Produces:** `MapEngine`, `MapEngineClient`, capability ports, typed extension
commands, and a source-level architectural test.

- [ ] Write failing contract tests that instantiate a complete fake and assert
  typed event unsubscribe, nested port availability, and extension result
  inference.
- [ ] Write a boundary ratchet that recursively scans `apps/**` and
  `packages/**` outside `packages/map/**` for runtime imports of
  `maplibre-gl`, `maplibre-gl-*`, `@deck.gl/*`, `three`, and `cesium`, and for
  `MapController` imports. Exempt only type-free metadata strings and
  `@maplibre/maplibre-gl-style-spec`.
- [ ] Snapshot the reviewed current violations in
  `tests/fixtures/engine-boundary-baseline.json`; fail on any new violation or
  any baseline entry whose path/pattern changes unexpectedly. Later tasks remove
  entries as they migrate files, keeping every commit green.
- [ ] Add the contracts exactly as specified above and export them from
  `@geolibre/map`.
- [ ] Run:

```bash
node --import tsx --test tests/engine-contracts.test.ts
node --import tsx --test tests/engine-boundary.test.ts
```

Expected: both pass against the reviewed ratchet baseline.

- [ ] Commit the contracts and explicit red architecture gate:

```bash
git add packages/map/src/engine packages/map/src/index.ts tests/engine-*.test.ts tests/fixtures/engine-boundary-baseline.json
git commit -m "feat(map): define the strict MapEngine contract

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Build the Stable Handle and MapLibre Adapter

**Files:**
- Create: `packages/map/src/engine/{handle.ts,maplibre-engine.ts,registry.ts}`
- Create: `tests/{engine-test-fakes.ts,map-engine-handle.test.ts,maplibre-engine.test.ts}`
- Modify: `packages/map/src/index.ts`

**Produces:**
- `createMapEngineHandle(id: MapEngineId): MapEngine`
- `resolvePrimaryEngineId(search: string): "maplibre"`
- lazy `MapLibreEngine` delegation to the existing controller.

- [ ] Test that the handle exists synchronously, queues ordered mutations before
  mount, returns the initial view before readiness, forwards events once, and
  cancels pending work on destroy.
- [ ] Test `resolvePrimaryEngineId("?engine=maplibre")` and warning/fallback for
  unknown or not-yet-available engines.
- [ ] Test that `MapLibreEngine.mount()` dynamically imports the controller,
  emits one `load:mount`, emits `load:style` only for later style changes,
  delegates `syncLayers` to `waitAndSyncLayers`, and normalizes errors/hits.
- [ ] Implement controller ports package-privately; never expose
  `getController()` or `getMap()`.
- [ ] Run:

```bash
node --import tsx --test tests/map-engine-handle.test.ts tests/maplibre-engine.test.ts tests/map-controller.test.ts
```

- [ ] Commit:

```bash
git add packages/map/src/engine packages/map/src/index.ts tests/engine-test-fakes.ts tests/map-engine-handle.test.ts tests/maplibre-engine.test.ts
git commit -m "refactor(map): wrap MapLibre in the MapEngine adapter

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Put Cesium Behind the Same Seam

**Files:**
- Create: `packages/map/src/engine/cesium-engine.ts`
- Modify: `packages/map/src/{CesiumCanvas.tsx,cesium-camera.ts,cesium-layer-sync.ts,index.ts}`
- Create: `tests/cesium-engine.test.ts`

**Produces:** lazy `CesiumEngine implements MapEngine`; `CesiumCanvas` becomes
an internal compatibility wrapper pending `EngineCanvas`.

- [ ] Write tests for camera round-trip, supported layer kinds, layer
  add/remove/reorder, move echo suppression, and destroy during dynamic import.
- [ ] Extract viewer lifecycle, event translation, camera sync, and
  `CesiumLayerSync` ownership from the React component into the adapter.
- [ ] Keep Ion token and asset preparation adapter-specific and lazy.
- [ ] Return explicit unsupported/no-op results for capabilities Cesium never
  had: `supports()` returns false and the corresponding operation throws a typed
  `MapEngineCapabilityError`. Encode this in conformance expectations.
- [ ] Run:

```bash
node --import tsx --test tests/cesium-engine.test.ts tests/cesium-camera.test.ts tests/cesium-layer-sync.test.ts
```

- [ ] Commit:

```bash
git add packages/map/src/engine/cesium-engine.ts packages/map/src/CesiumCanvas.tsx packages/map/src/cesium-*.ts packages/map/src/index.ts tests/cesium-*.test.ts
git commit -m "refactor(map): put Cesium behind the MapEngine seam

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Add the Adapter Conformance Suite

**Files:**
- Create: `tests/engine-conformance.test.ts`
- Modify: `tests/engine-test-fakes.ts`

**Produces:** `runEngineConformance(name, factory, expectations)` used for
MapLibre and Cesium now, ArcGIS adapters later.

- [ ] Parameterize mount/destroy, view round-trip tolerance, layer capability
  matrix, add/remove/reorder bookkeeping, hit normalization, event unsubscribe,
  pre-ready queueing, and unsupported capability behavior.
- [ ] Register both adapters with explicit capability expectations.
- [ ] Run:

```bash
node --import tsx --test tests/engine-conformance.test.ts tests/maplibre-engine.test.ts tests/cesium-engine.test.ts
```

- [ ] Commit:

```bash
git add tests/engine-conformance.test.ts tests/engine-test-fakes.ts
git commit -m "test(map): gate adapters with engine conformance

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Replace Concrete Canvas Hosts

**Files:**
- Create: `packages/map/src/EngineCanvas.tsx`
- Modify: `packages/map/src/{MapCanvas.tsx,SecondaryMapCanvas.tsx,CesiumCanvas.tsx,index.ts}`
- Modify: `apps/geolibre-desktop/src/components/layout/{DesktopShell.tsx,MapGrid.tsx}`
- Create: `tests/engine-registry.test.ts`
- Create: `e2e/engine-param.spec.ts`

**Produces:** primary and secondary panes select only by engine id; no app import
of `CesiumCanvas`, `MapController`, or a concrete SDK.

- [ ] Make `EngineCanvas` own mount/destroy, store subscriptions, group effects,
  camera echo suppression, readiness, diagnostics, and resize.
- [ ] Convert primary-only identify/photo popup behavior to
  `interactions.showPopup`, `layers.queryAtLngLat`, and engine events.
- [ ] Convert `MapGrid` to `<EngineCanvas engineId={...}>`; use registry
  capability metadata for “2D only” labels.
- [ ] Preserve existing `data-testid` values and `onControllerReady` timing,
  renaming the callback/ref types to engine equivalents.
- [ ] Move every MapLibre/plugin stylesheet import from app `main.tsx` into the
  lazy MapLibre runtime preparation path.
- [ ] Run:

```bash
node --import tsx --test tests/engine-registry.test.ts tests/engine-conformance.test.ts
npx playwright test e2e/engine-param.spec.ts
```

- [ ] Commit:

```bash
git add packages/map/src apps/geolibre-desktop/src/components/layout/DesktopShell.tsx apps/geolibre-desktop/src/components/layout/MapGrid.tsx apps/geolibre-desktop/src/main.tsx tests/engine-registry.test.ts e2e/engine-param.spec.ts
git commit -m "refactor(map): host every pane through EngineCanvas

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Migrate Camera, View, and Control Consumers

**Files:**
- Modify: `apps/geolibre-desktop/src/components/{layout,panels,processing,storymap}/**/*.{ts,tsx}`
- Modify: `apps/geolibre-desktop/src/hooks/{useCollaboration.ts,useEmbedBridge.ts,useProjectFileActions.ts,useViewportHistory.ts}`
- Modify: `apps/geolibre-desktop/src/lib/{build-project-snapshot.ts,selection-actions.ts,scripting/scriptingApi.ts,assistant/tools.ts,pyodide/pyodide-console.ts}`
- Create: `tests/map-engine-camera-consumers.test.ts`

**Produces:** app refs use `MapEngineClient | null`; camera/control consumers use
`camera` and `controls` ports.

- [ ] Cover tagged viewport-history moves, dirty-state semantics, project
  snapshot fallback, collaboration camera messages, story playback, reset/zoom,
  terrain exaggeration, and localized control labels.
- [ ] Replace `readView`, `applyView`, `flyTo`, `fitBounds`, `fitLayer`, `zoom*`,
  reset methods, projection reads, and built-in control calls.
- [ ] Remove the `run_maplibre_js` assistant/scripting command rather than
  preserving a native debug backdoor; return a documented unsupported-command
  error to old callers.
- [ ] Run:

```bash
node --import tsx --test tests/map-engine-camera-consumers.test.ts tests/viewport-history.test.ts tests/core-project.test.ts tests/collab-protocol.test.ts
```

- [ ] Commit:

```bash
git add apps/geolibre-desktop/src tests/map-engine-camera-consumers.test.ts
git commit -m "refactor(app): route camera and controls through MapEngine

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Migrate Layer Queries and Feature Operations

**Files:**
- Modify: `apps/geolibre-desktop/src/components/{layout,panels,processing,storymap}/**/*.{ts,tsx}`
- Modify: `apps/geolibre-desktop/src/lib/{vector-export.ts,scripting/scriptingApi.ts,assistant/tools.ts}`
- Move/adapt: `packages/plugins/src/plugins/geo-editor-view-import.ts` → `packages/map/src/engine/feature-query.ts`
- Modify tests: `tests/{geo-editor-view-import,map-controller,feature-selection,sql-query-layer}.test.ts`

**Produces:** no app-side `getSource`, `getLayer`, `getStyle`, or
`queryRenderedFeatures`.

- [ ] Add failing tests for live GeoJSON/raster snapshot recovery, in-view
  queries, render-target listing, identify, highlight, and DuckDB bridge
  behavior.
- [ ] Migrate Attribute Table, layer export, story export, processing bbox,
  Style Panel, editor import, notebook, scripting, and assistant call sites to
  `layers`.
- [ ] Keep store records authoritative; snapshots only recover renderer-held
  data for export/query and never write parallel state.
- [ ] Run:

```bash
node --import tsx --test tests/geo-editor-view-import.test.ts tests/map-controller.test.ts tests/feature-selection.test.ts tests/sql-query-layer.test.ts
```

- [ ] Commit:

```bash
git add packages/map/src/engine/feature-query.ts apps/geolibre-desktop/src tests/geo-editor-view-import.test.ts tests/map-controller.test.ts tests/feature-selection.test.ts tests/sql-query-layer.test.ts
git commit -m "refactor(map): expose engine-neutral layer queries

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 9: Extract Interactions, Markers, and Transient Overlays

**Files:**
- Move/adapt: `apps/geolibre-desktop/src/lib/print-extent.ts` → `packages/map/src/engine/draw-bounds.ts`
- Create: `packages/map/src/engine/{markers.ts,transient-overlays.ts,pick-point.ts}`
- Modify consumers: `RasterSubsetPanel.tsx`, `BasemapExtractPanel.tsx`,
  `ProcessingDialog.tsx`, `FieldCollectionDialog.tsx`,
  `GeoreferencerDialog.tsx`, `GpsTrackingDialog.tsx`,
  `RemoteCursorsOverlay.tsx`, `LayerPanelPlaceSearch.tsx`,
  `PixelTimeSeriesControl.tsx`, `RegionSelectOverlay.tsx`
- Create: `tests/map-engine-interactions.test.ts`

**Produces:** all gesture, transform, marker, and temporary source/layer work
uses `viewport`/`interactions`.

- [ ] Write tests for cancelable point/bounds picking, aspect ratio, drag
  callbacks, overlay upsert/update/remove, marker cleanup, and projection
  round-trip.
- [ ] Move concrete event/source/layer/marker code into MapLibre adapter helpers.
- [ ] Keep UI state and resulting `GeoLibreLayer` creation in existing app code.
- [ ] Run:

```bash
node --import tsx --test tests/map-engine-interactions.test.ts tests/print-capture.test.ts tests/gps-tracking.test.ts tests/field-collection.test.ts
```

- [ ] Commit:

```bash
git add packages/map/src/engine apps/geolibre-desktop/src tests/map-engine-interactions.test.ts
git commit -m "refactor(map): abstract map interactions and overlays

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 10: Extract Capture, Recording, and Inset Maps

**Files:**
- Move/adapt: `apps/geolibre-desktop/src/lib/{print-layout-export.ts,map-recorder.ts,tour-recorder.ts}` → `packages/map/src/capture/**`
- Modify: `PrintLayoutDialog.tsx`, `RecordVideoDialog.tsx`,
  `RecordTourDialog.tsx`, `StoryMapHandoutDialog.tsx`,
  `StoryMapPresenter.tsx`
- Create: `packages/map/src/InsetMapCanvas.tsx`
- Modify tests: `tests/{print-capture,map-recorder,tour-recorder,storymap-pdf}.test.ts`

**Produces:** capture uses `viewport.capture`; inset maps mount through a
restricted engine handle instead of `new maplibregl.Map/Marker`.

- [ ] Test map-only capture, geographic clipping, hidden overlays, dimensions,
  bearing/metres-per-pixel metadata, restoration after failure, and inset
  lifecycle cleanup.
- [ ] Preserve `preserveDrawingBuffer`, map-panel inclusion, story handout,
  print atlas, and tour behavior.
- [ ] Run:

```bash
node --import tsx --test tests/print-capture.test.ts tests/map-recorder.test.ts tests/tour-recorder.test.ts tests/storymap-pdf.test.ts
```

- [ ] Commit:

```bash
git add packages/map/src/capture packages/map/src/InsetMapCanvas.tsx apps/geolibre-desktop/src tests
git commit -m "refactor(map): move capture and inset rendering behind MapEngine

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 11: Introduce External Plugin API v2

**Files:**
- Modify: `packages/plugins/src/{types.ts,plugin-manager.ts}`
- Create: `packages/plugins/src/hosted-map-plugin.ts`
- Modify: `apps/geolibre-desktop/src/lib/{external-plugins.ts,plugin-archive-unpack.ts}`
- Modify: `apps/geolibre-desktop/src-tauri/src/lib.rs`
- Modify: `docs/plugin-api.md`
- Modify tests: `tests/{plugin-manager,plugin-archive-unpack,plugin-integrity,external-plugin-assets}.test.ts`

**Interfaces:**

```ts
export const GEOLIBRE_PLUGIN_API_VERSION = 2 as const;

export interface GeoLibrePlugin {
  apiVersion: typeof GEOLIBRE_PLUGIN_API_VERSION;
  id: string;
  name: string;
  version: string;
  activate(app: GeoLibreAppAPI, context: { collapsed?: boolean }): boolean | void | Promise<boolean | void>;
  deactivate(app: GeoLibreAppAPI): void;
  // existing URL/state/position hooks remain engine-neutral
}

export interface GeoLibreExternalPluginManifest {
  apiVersion: typeof GEOLIBRE_PLUGIN_API_VERSION;
  // existing fields unchanged
}

export interface GeoLibreAppAPI {
  map: MapEngineClient;
  // retain store-backed data, file, toolbar, right-panel, and floating-panel APIs
  // remove getMap/addMapControl/removeMapControl/native-layer/deck/raster-module APIs
}
```

- [ ] Write red tests that reject missing/1/unknown `apiVersion` in browser zip,
  URL, and Rust filesystem loaders with “requires Plugin API 2”.
- [ ] Add `apiVersion: 2` validation before importing/executing entry code.
- [ ] Remove native renderer methods/types from the public API.
- [ ] Preserve restore-collapse behavior through activation context, including
  `restoresPanelCollapseState`.
- [ ] Document v1→v2 replacements and the intentional compatibility break.
- [ ] Run:

```bash
node --import tsx --test tests/plugin-manager.test.ts tests/plugin-archive-unpack.test.ts tests/plugin-integrity.test.ts tests/external-plugin-assets.test.ts
cargo test --manifest-path apps/geolibre-desktop/src-tauri/Cargo.toml external_plugin
```

- [ ] Commit:

```bash
git add packages/plugins/src apps/geolibre-desktop/src/lib apps/geolibre-desktop/src-tauri/src/lib.rs docs/plugin-api.md tests
git commit -m "feat(plugins): introduce engine-neutral Plugin API v2

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 12: Add the Hosted Runtime Registry and Move Simple Controls

**Files:**
- Create: `packages/map/src/maplibre-runtime/{registry.ts,types.ts}`
- Move simple control wrappers from `packages/plugins/src/plugins/` to
  `packages/map/src/maplibre-runtime/`: layer control, annotations, basemap
  control, directions, EnviroAtlas, Esri Wayback, FEMA WMS, GeoAgent, NASA
  Earthdata, National Map, Overture, Planetary Computer, Street View, USGS
  LiDAR, elevation profile.
- Replace originals with thin `createHostedMapPlugin(...)` descriptors.
- Update corresponding tests to import concrete helpers from `packages/map`.

**Produces:** lazy hosted-runtime lookup keyed by unchanged plugin id.

- [ ] Test activate/deactivate/reposition/state/restore-collapse and a failed
  dynamic import rollback.
- [ ] Ensure each registry entry dynamically imports its runtime only when
  activated.
- [ ] Keep plugin names, ids, versions, defaults, project keys, and URL handlers
  unchanged.
- [ ] Run the affected plugin tests plus `tests/plugin-manager.test.ts`.
- [ ] Commit:

```bash
git add packages/map/src/maplibre-runtime packages/plugins/src tests
git commit -m "refactor(plugins): host MapLibre controls inside the map adapter

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 13: Move Vector and Editor Runtimes

**Files:**
- Move to `packages/map/src/maplibre-runtime/vector/`:
  `maplibre-vector.ts`, `vector-layer-sync.ts`, `maplibre-geo-editor.ts`,
  `geo-editor-geometry.ts`, remaining editor query helpers, and related shims.
- Keep engine-neutral descriptors in `packages/plugins/src/plugins/`.
- Update app imports and vector/editor tests.

- [ ] Test add/restore/reload, symbology sync, source replacement, geometry edit,
  view import, panel state, and desktop picker callbacks.
- [ ] Run:

```bash
node --import tsx --test tests/vector-*.test.ts tests/geo-editor-*.test.ts
```

- [ ] Commit:

```bash
git add packages/map/src/maplibre-runtime/vector packages/plugins/src apps/geolibre-desktop/src tests
git commit -m "refactor(map): host vector and editor runtimes

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 14: Move Raster and Components Runtimes

**Files:**
- Move to `packages/map/src/maplibre-runtime/raster/`:
  `maplibre-components.ts`, `maplibre-raster.ts`, raster layer sync/palette/
  symbology/texture, colormaps, terrain measure, kerchunk, local NetCDF,
  swipe COG mirror, and component constructors.
- Keep engine-neutral descriptors and data-only public types in
  `@geolibre/plugins` only when they contain no renderer imports.
- Update app imports and raster/component tests.

- [ ] Test control lifecycle, COG add/restore/order, palette and symbology,
  NetCDF/Zarr, terrain measure, panel state, and failure rollback.
- [ ] Run:

```bash
node --import tsx --test tests/raster-*.test.ts tests/local-netcdf.test.ts tests/kerchunk-reference-store.test.ts tests/terrain-measure.test.ts tests/components-constructors-loader.test.ts
```

- [ ] Commit:

```bash
git add packages/map/src/maplibre-runtime/raster packages/plugins/src apps/geolibre-desktop/src tests
git commit -m "refactor(map): host raster and components runtimes

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 15: Move deck.gl, three.js, 3D, Time, and Effects Runtimes

**Files:**
- Move to focused directories under `packages/map/src/maplibre-runtime/`:
  `arcgis-i3s-tiles.ts`, `maplibre-3d-tiles.ts`, `deckgl-viz/**`,
  `shared-deck-overlay.ts`, route animation, Mapillary, OpenAerialMap, reverse
  geocode, effects, sun, clouds/precipitation weather runtime, swipe, time
  slider, timelapse, DuckDB, Earth Engine, graticule, and web-service sync.
- Move `arcgis-maplibre.d.ts` and `maplibre-gl-usgs-lidar.d.ts` with runtimes.
- Keep thin descriptors and engine-neutral provider/data helpers in plugins.
- Update app imports and all directly affected tests.

- [ ] Register typed command augmentations for each UI action currently exported
  as a concrete helper; app wrappers call `engine.invoke`.
- [ ] Preserve shared deck singleton behavior, projection locks, layer ordering,
  time-slider restore, route video, effects settings, and weather animation.
- [ ] Run affected focused tests in batches, then:

```bash
node --import tsx --test tests/{arcgis-i3s-tiles,three-d-tiles,deck-viz,shared-deck-overlay,route-animation,mapillary,sun-simulation,clouds,precipitation,time-slider-config,timelapse-plugin,effects-settings,web-service-sync}.test.ts
```

- [ ] Commit by independently reviewable runtime group rather than one giant
  change:

```text
refactor(map): host deck and 3D runtimes
refactor(map): host time weather and effects runtimes
refactor(map): host remaining MapLibre service runtimes
```

Each commit carries the Copilot trailer and passes its affected tests.

---

### Task 16: Rewire the Desktop Plugin Boundary and Dependencies

**Files:**
- Modify: `apps/geolibre-desktop/src/hooks/usePlugins.ts`
- Modify: app consumers importing moved plugin helpers.
- Modify: `packages/{map,plugins}/package.json`
- Modify: `apps/geolibre-desktop/package.json`
- Modify: `package-lock.json`
- Modify: `packages/map/src/index.ts`
- Modify: `packages/plugins/src/index.ts`
- Modify: `tests/engine-boundary.test.ts`
- Delete: `tests/fixtures/engine-boundary-baseline.json`

**Produces:** no public controller/native renderer export and a green boundary
test.

- [ ] Make `createAppAPI` receive `MapEngineClient`, not `MapController`.
- [ ] Remove native map/control/layer/deck/raster methods; delegate `map` directly
  to the narrowed engine client.
- [ ] Move renderer dependencies from desktop/plugins manifests into
  `@geolibre/map`; add `@geolibre/map` to plugins for engine-client types.
- [ ] Remove eager renderer CSS and stale dependencies.
- [ ] Stop exporting `MapController`, concrete canvases, and concrete runtime
  types from public package indexes.
- [ ] Make `tests/engine-boundary.test.ts` pass with zero violations.
- [ ] Delete the ratchet baseline and change the test to require an empty
  violation set.
- [ ] Run:

```bash
npm install
node --import tsx --test tests/engine-boundary.test.ts tests/plugin-manager.test.ts tests/plugin-ui-surfaces.test.ts
npm run build
```

- [ ] Commit:

```bash
git add apps/geolibre-desktop packages package.json package-lock.json tests/engine-boundary.test.ts
git commit -m "refactor: enforce the MapEngine package boundary

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 17: Phase Exit Verification and Migration Record

**Files:**
- Modify: `.migrate-docs/copilot/{00-overview.md,maplibre.md,deckgl.md,threejs.md,cesium.md,gaps-and-workarounds.md}`
- Modify documentation only where paths/APIs changed.

- [ ] Run the targeted adapter/boundary gate:

```bash
node --import tsx --test tests/engine-conformance.test.ts tests/maplibre-engine.test.ts tests/cesium-engine.test.ts tests/engine-boundary.test.ts
```

- [ ] Run all frontend coverage and E2E:

```bash
npm run test:frontend:coverage
npm run test:e2e
```

- [ ] Verify every touched shipping target:

```bash
npm run build
npm run build:embed
npm run check:rust
npm run ci
```

- [ ] Run scoped pre-commit over every changed path.
- [ ] Verify measurable exit conditions:
  - `rg '\bMapController\b|from ["'\"']maplibre-gl|from ["'\"']@deck\.gl|from ["'\"']three|from ["'\"']cesium' apps packages --glob '!packages/map/**'`
    returns no renderer-boundary violations.
  - `?engine=maplibre` paints identically.
  - primary/secondary camera sync, project save/open, identify, selection,
    plugin restore, print/video capture, and Cesium secondary panes pass.
  - Plugin API v1 manifests are rejected before code execution with the v2
    migration message.
- [ ] Append complete migration entries with actual command results; update the
  overview statuses.
- [ ] Commit:

```bash
git add .migrate-docs/copilot docs
git commit -m "docs(migration): record the Phase 0 engine boundary

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Plan Self-Review

- **Scope:** one phase only—Phase 0. ArcGIS dependencies, `MapView`, and
  `SceneView` are not added.
- **Contract coverage:** store authority, strict seam, lazy adapters,
  conformance, no ingest changes, all targets, and migration logging are mapped
  to explicit tasks.
- **Known compatibility choice:** Plugin API v1 is rejected; no hidden native
  shim remains.
- **Rollback:** each runtime group preserves plugin ids/state and is separately
  revertible until Task 16 removes public native dependencies.
- **No placeholders:** implementation signatures, file groups, tests, commands,
  expected gates, and commits are specified.
