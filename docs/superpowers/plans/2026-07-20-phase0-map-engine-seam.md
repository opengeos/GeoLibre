# Phase 0 — Extract the MapEngine Seam: Implementation Plan

> **SUPERSEDED:** Do not execute this façade-scope plan. The reviewer selected
> strict §2.2 enforcement for the Phase 0 exit, including removal of concrete
> renderer access outside `@geolibre/map` and Plugin API v2. Use
> `2026-07-20-phase0-strict-map-engine-boundary.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the `MapEngine` interface in `@geolibre/map`, wrap today's MapLibre code behind it as `MapLibreEngine`, add `?engine=` selection, and add a parameterized engine-conformance suite — with **zero user-visible change**.

**Architecture:** Formalize the seam Cesium already proved: `@geolibre/core`'s store stays the single source of truth; a new `packages/map/src/engine/` directory holds the engine contract (`types.ts`), a `MapLibreEngine` **façade** that delegates to the existing `MapController` (no rewrite), and a registry mapping engine ids to lazily-created adapters. `MapCanvas` becomes the engine-agnostic host for its **core lifecycle** (mount / applyView / readView / syncLayers / destroy); its MapLibre-only rich wiring (popups, plugins, controllerRef) keeps using the concrete `MapController` via a documented transitional accessor. The seam design is `.migrate-docs/migration-design.md` §5; this plan implements §8.

**Tech Stack:** TypeScript, React 19, Zustand (`@geolibre/core`), MapLibre GL JS (behind the façade), `node --test` + `tsx` for unit tests, Playwright for E2E.

## Global Constraints

Copied from `.migrate-docs/migration-design.md` §2 and repo `CLAUDE.md` — every task implicitly includes these:

- **Never commit to `main`.** All work on branch `feat/phase0-map-engine-seam`; open a PR at the end.
- **The store is the source of truth** — `@geolibre/core` (`GeoLibreLayer`, `MapViewState`, `.geolibre.json`) stays engine-neutral; engines read and reconcile, never become a parallel source of state.
- **Nothing outside `@geolibre/map` talks to a concrete engine.** The app selects an engine by id string only.
- **Adapters are type-only at module scope; the engine SDK loads inside `mount()`** (the `CesiumCanvas` pattern).
- **The conformance suite is the gate** — `MapLibreEngine` must pass it before the host swaps onto it.
- **Data ingest is off-limits** — DuckDB-WASM/`shpjs`/KMZ/Add-Data code is upstream of the engine; do not touch.
- **Zero user-visible change.** App behaves identically with `engine=maplibre` (the default).
- **Coverage ratchet holds:** frontend ≥ 78% lines / 78% branches / 63% functions (`npm run test:frontend:coverage`).
- **No new user-facing strings** (the `?engine` param is dev-gated; `console.warn` only), so no i18n catalog changes. No new external hosts, so no Tauri CSP change.
- **Pre-commit is scoped:** `pre-commit run --files <changed paths>` before pushing (the unscoped hook runs a full build).
- Node 22+, npm (repo tracks `package-lock.json`).
- **Log every migration decision** via the `document-migration` skill into `.migrate-docs/claude/` as you work (design doc §2.6) — entries use the exact template in `.migrate-docs/document-migration.md`.

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `packages/map/src/engine/types.ts` | create | The engine contract: `MapEngine`, `MapEngineEvent`, event payloads, `HitFeature`, `ScreenPoint`, `Unsubscribe`. Pure types, zero runtime code. |
| `packages/map/src/engine/maplibre-engine.ts` | create | `MapLibreEngine` façade delegating to `MapController`. Type-only imports at module scope; `./map-controller` value-imported inside `mount()`. |
| `packages/map/src/engine/registry.ts` | create | `MapEngineId`, `ENGINE_IDS`, `resolveEngineId()` (param → id with fallback+warn), `createEngine()` (id → lazily-imported adapter). |
| `packages/map/src/index.ts` | modify | Export the new engine surface. |
| `packages/map/src/MapCanvas.tsx` | modify | Host refactor: mount via the selected engine; route view/layer flows through the `MapEngine` interface; keep MapLibre-only wiring on the controller via `engine.getController()`. |
| `apps/geolibre-desktop/src/lib/engine-param.ts` | create | `getInitialEngineId()` — resolve `?engine=` once (mirrors `getInitialLanguage()` in `apps/geolibre-desktop/src/i18n/index.ts:141`). |
| `apps/geolibre-desktop/src/components/layout/DesktopShell.tsx` | modify | Pass `engineId` to `<MapCanvas>` (line ~1940). |
| `tests/engine-test-fakes.ts` | create | Shared stub controller + fake MapLibre map for the engine tests (not a `.test.ts`, so the runner skips it). |
| `tests/maplibre-engine.test.ts` | create | Unit tests: the façade's delegation, event translation, hitTest, null-guards. |
| `tests/engine-registry.test.ts` | create | Unit tests: id resolution and fallback. |
| `tests/engine-conformance.test.ts` | create | Parameterized cross-engine contract suite; Phase 0 registers `MapLibreEngine`. |
| `e2e/engine-param.spec.ts` | create | Boots the app with `?engine=maplibre` and with an unknown value; asserts the map paints either way. |

Not touched: `map-controller.ts`, `layer-sync.ts`, `SecondaryMapCanvas.tsx`, `CesiumCanvas.tsx`, all data-ingest code, the store.

**Design decisions locked for this plan** (logged in `.migrate-docs/claude/maplibre.md`):

1. **Engine-specific config rides the constructor, not `mount()`.** §5.2 fixes `mount(container, initialView)`; MapLibre's `styleUrl`/`mapPreferences`/`controlVisibility` are `MapLibreEngineOptions` passed to `new MapLibreEngine(options)`. ArcGIS engines will do the same with their own options.
2. **`MapLibreEngine.getController()` is a documented transitional escape hatch**, used only inside `@geolibre/map` (`MapCanvas`) and to fill the existing `controllerRef` prop. Removal criteria: Phase 2 grows the interface to cover what the 2D host actually needs; Phase 6 deletes the façade.
3. **Only the core flows reroute in Phase 0** (mount, destroy, applyView, readView, syncLayers, moveend). The ~15 other `MapController` calls in `MapCanvas` stay direct — rerouting them adds risk with no payoff until a second 2D engine exists (Phase 2).
4. **Conformance runs headless via an injected fake map** — the established idiom from `tests/map-controller.test.ts` (`MapControllerInternals` cast). `mount()` and rendering stay in E2E.
5. **Split-pane engine choice stays `viewKind`-based** (`SecondaryMapView.viewKind`); `?engine=` selects the primary map's engine only. The optional hidden store field from §8 slice 3 is deferred to Phase 1 (YAGNI).

---

### Task 1: Branch + engine contract types

**Files:**
- Create: `packages/map/src/engine/types.ts`
- Modify: `packages/map/src/index.ts`

**Interfaces:**
- Consumes: `GeoLibreLayer`, `MapViewState` from `@geolibre/core`; `Geometry` from `geojson`.
- Produces: `MapEngine`, `MapEngineEvent`, `MapEngineEventPayloads`, `HitFeature`, `ScreenPoint`, `Unsubscribe` — every later task imports these from `./engine/types` (package consumers via `@geolibre/map`).

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/phase0-map-engine-seam
```

- [ ] **Step 2: Write the types file**

Create `packages/map/src/engine/types.ts`:

```ts
import type { GeoLibreLayer, MapViewState } from "@geolibre/core";
import type { Geometry } from "geojson";

// The engine seam (migration-design.md §5.2): every rendering engine —
// MapLibre today, ArcGIS SceneView/MapView later — implements this interface,
// and nothing outside @geolibre/map talks to a concrete engine. The shape is
// modeled on what CesiumCanvas + CesiumLayerSync + cesium-camera already do;
// MapLibreEngine (./maplibre-engine.ts) is the reference implementation.
// Adding a capability here is a design change: extend the conformance suite
// (tests/engine-conformance.test.ts) in the same commit.

/** A screen-space pixel position within the engine's canvas. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * One feature returned by {@link MapEngine.hitTest}. Mirrors the shape of
 * MapController.identifyFeatures so the existing identify/popup UI can consume
 * hits from any engine unchanged.
 */
export interface HitFeature {
  layerId: string;
  featureId: string | null;
  properties: Record<string, unknown>;
  geometry: Geometry | null;
}

export type Unsubscribe = () => void;

export type MapEngineEvent = "moveend" | "click" | "load" | "error";

/** Per-event payloads for {@link MapEngine.on}. */
export interface MapEngineEventPayloads {
  /**
   * The camera settled. `userDriven` is true only for pointer/wheel/touch
   * moves (MapLibre's `originalEvent`; Cesium needs the input-flag pattern from
   * CesiumCanvas) so hosts can mark the project dirty on real moves only.
   */
  moveend: { view: MapViewState; userDriven: boolean };
  click: { point: ScreenPoint; lngLat: [number, number] };
  /** The engine finished its initial load and can accept layer syncs. */
  load: void;
  error: { message: string };
}

/**
 * A rendering engine behind the seam. Lifecycle: construct (engine-specific
 * options) → `mount()` (lazy-loads the SDK, attaches to the container) →
 * `on()`/`applyView()`/`syncLayers()`/… → `destroy()`. Methods other than
 * `mount()`/`destroy()`/`supportsLayer()` may be called only between a
 * resolved `mount()` and `destroy()`; outside that window they no-op (or
 * return an empty/default value) rather than throw.
 */
export interface MapEngine {
  /** Lazy-load the engine SDK and attach to `container` at `initialView`. */
  mount(container: HTMLElement, initialView: MapViewState): Promise<void>;
  destroy(): void;
  /** Store camera → engine (cf. applyMapViewToCamera). */
  applyView(view: MapViewState): void;
  /** Engine camera → store (cf. readMapViewFromCamera). */
  readView(): MapViewState;
  /** Reconcile the store's layers onto the engine (cf. CesiumLayerSync.sync). */
  syncLayers(layers: GeoLibreLayer[]): void;
  /** Whether this engine can render the layer's *kind* (cf. isCesiumSupportedLayerType). */
  supportsLayer(layer: GeoLibreLayer): boolean;
  /** Identify features at a screen point (popups / identify UI). */
  hitTest(point: ScreenPoint): Promise<HitFeature[]>;
  on<E extends MapEngineEvent>(
    event: E,
    handler: (payload: MapEngineEventPayloads[E]) => void,
  ): Unsubscribe;
}
```

- [ ] **Step 3: Export from the package index**

In `packages/map/src/index.ts`, append:

```ts
export type {
  HitFeature,
  MapEngine,
  MapEngineEvent,
  MapEngineEventPayloads,
  ScreenPoint,
  Unsubscribe,
} from "./engine/types";
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc -b`
Expected: exit 0, no errors. (Pure types — the build is the test; runtime tests start in Task 2.)

- [ ] **Step 5: Commit**

```bash
git add packages/map/src/engine/types.ts packages/map/src/index.ts
git commit -m "feat(map): add the MapEngine seam interface (Phase 0, types only)"
```

---

### Task 2: Test fakes + `MapLibreEngine` façade

**Files:**
- Create: `tests/engine-test-fakes.ts`
- Create: `packages/map/src/engine/maplibre-engine.ts`
- Modify: `packages/map/src/index.ts`
- Test: `tests/maplibre-engine.test.ts`

**Interfaces:**
- Consumes: `MapEngine` + payload types from Task 1; `MapController` (type-only) with `init/destroy/applyView/readView/waitAndSyncLayers/identifyFeatures/getMap` (`packages/map/src/map-controller.ts:387,827,873,923,972,1353,487`).
- Produces: `class MapLibreEngine implements MapEngine` with `constructor(options?: MapLibreEngineOptions)` and `getController(): MapController | null`; `interface MapLibreEngineOptions { styleUrl?: string; mapPreferences?: MapPreferences; controlVisibility?: Partial<Record<BuiltInMapControl, boolean>> }`. Tasks 3–5 rely on these exact names. Test fakes: `makeFakeMap()` and `injectController(engine, controller)` used by Tasks 2 and 4.

- [ ] **Step 1: Write the shared test fakes**

Create `tests/engine-test-fakes.ts`. The camera/event/identify surface is complete below; the source/layer surface mirrors the raster subset of `makeFakeMap` in `tests/map-controller.test.ts` (kept minimal — the conformance suite syncs `xyz` layers only, whose sync path needs just sources + raster layers):

```ts
import type { MapController } from "../packages/map/src/map-controller";
import type { MapViewState } from "../packages/core/src/types";

/** A camera + raster-layer + event fake of maplibregl.Map, enough to drive the
 * engine seam headlessly (no DOM, no WebGL). Camera state round-trips through
 * jumpTo/getters; `fire()` lets tests trigger map events. */
export interface FakeMap {
  view: { center: [number, number]; zoom: number; bearing: number; pitch: number };
  sources: Map<string, Record<string, unknown>>;
  layers: Map<string, Record<string, unknown>>;
  order: string[];
  calls: { method: string; args: unknown[] }[];
  renderedFeatures: unknown[];
  fire: (type: string, event?: unknown) => void;
}

export function makeFakeMap(): { map: unknown; fake: FakeMap } {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  const fake: FakeMap = {
    view: { center: [-100, 40], zoom: 2, bearing: 0, pitch: 0 },
    sources: new Map(),
    layers: new Map(),
    order: [],
    calls: [],
    renderedFeatures: [],
    fire: (type, event) => {
      for (const handler of handlers.get(type) ?? []) handler(event);
    },
  };
  const record = (method: string, ...args: unknown[]) => fake.calls.push({ method, args });
  const insertBefore = (id: string, beforeId?: string) => {
    const existing = fake.order.indexOf(id);
    if (existing !== -1) fake.order.splice(existing, 1);
    const at = beforeId ? fake.order.indexOf(beforeId) : -1;
    if (at === -1) fake.order.push(id);
    else fake.order.splice(at, 0, id);
  };
  const map = {
    // --- camera ---
    jumpTo: (opts: Partial<FakeMap["view"]> & { center?: [number, number] }) => {
      record("jumpTo", opts);
      if (opts.center) fake.view.center = [...opts.center] as [number, number];
      if (opts.zoom !== undefined) fake.view.zoom = opts.zoom;
      if (opts.bearing !== undefined) fake.view.bearing = opts.bearing;
      if (opts.pitch !== undefined) fake.view.pitch = opts.pitch;
    },
    getCenter: () => ({ lng: fake.view.center[0], lat: fake.view.center[1] }),
    getZoom: () => fake.view.zoom,
    getBearing: () => fake.view.bearing,
    getPitch: () => fake.view.pitch,
    getBounds: () => ({
      getWest: () => fake.view.center[0] - 1,
      getSouth: () => fake.view.center[1] - 1,
      getEast: () => fake.view.center[0] + 1,
      getNorth: () => fake.view.center[1] + 1,
    }),
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }),
    // --- events ---
    on: (type: string, handler: (event: unknown) => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
    },
    off: (type: string, handler: (event: unknown) => void) => {
      handlers.get(type)?.delete(handler);
    },
    once: (type: string, handler: (event: unknown) => void) => {
      const wrapped = (event: unknown) => {
        handlers.get(type)?.delete(wrapped);
        handler(event);
      };
      map.on(type, wrapped);
    },
    // --- identify ---
    project: (lngLat: [number, number]) => ({ x: lngLat[0], y: lngLat[1] }),
    unproject: (point: [number, number]) => ({ lng: point[0], lat: point[1] }),
    queryRenderedFeatures: () => fake.renderedFeatures,
    // --- style / sources / layers (raster subset) ---
    getStyle: () => ({
      layers: fake.order.map((id) => ({ id, ...fake.layers.get(id) })),
      sources: Object.fromEntries(fake.sources),
    }),
    getSource: (id: string) =>
      fake.sources.has(id)
        ? {
            type: (fake.sources.get(id)?.type as string) ?? "raster",
            serialize: () => ({ ...fake.sources.get(id) }),
          }
        : undefined,
    addSource: (id: string, spec: Record<string, unknown>) => {
      fake.sources.set(id, spec);
      record("addSource", id, spec);
    },
    removeSource: (id: string) => {
      fake.sources.delete(id);
      record("removeSource", id);
    },
    getLayer: (id: string) => (fake.layers.has(id) ? { id, ...fake.layers.get(id) } : undefined),
    addLayer: (spec: Record<string, unknown>, beforeId?: string) => {
      fake.layers.set(spec.id as string, spec);
      insertBefore(spec.id as string, beforeId);
      record("addLayer", spec, beforeId);
    },
    removeLayer: (id: string) => {
      fake.layers.delete(id);
      const at = fake.order.indexOf(id);
      if (at !== -1) fake.order.splice(at, 1);
      record("removeLayer", id);
    },
    moveLayer: (id: string, beforeId?: string) => {
      insertBefore(id, beforeId);
      record("moveLayer", id, beforeId);
    },
    setLayoutProperty: (...args: unknown[]) => record("setLayoutProperty", ...args),
    setPaintProperty: (...args: unknown[]) => record("setPaintProperty", ...args),
    setFilter: (...args: unknown[]) => record("setFilter", ...args),
    hasImage: () => true,
    addImage: (...args: unknown[]) => record("addImage", ...args),
    removeImage: (...args: unknown[]) => record("removeImage", ...args),
    // --- lifecycle / controls ---
    remove: () => record("remove"),
    addControl: (...args: unknown[]) => record("addControl", ...args),
    removeControl: (...args: unknown[]) => record("removeControl", ...args),
    resize: () => record("resize"),
  };
  return { map, fake };
}

/** A call-recording stand-in for MapController, for façade delegation tests. */
export interface StubController {
  calls: { method: string; args: unknown[] }[];
  view: MapViewState;
  map: unknown;
  identifyResult: unknown[];
}

export function makeStubController(): { controller: MapController; stub: StubController } {
  const { map } = makeFakeMap();
  const stub: StubController = {
    calls: [],
    view: { center: [8, 47], zoom: 6, bearing: 15, pitch: 30 },
    map,
    identifyResult: [],
  };
  const record = (method: string, ...args: unknown[]) => stub.calls.push({ method, args });
  const controller = {
    init: (...args: unknown[]) => {
      record("init", ...args);
      return map;
    },
    destroy: () => record("destroy"),
    applyView: (...args: unknown[]) => record("applyView", ...args),
    readView: () => {
      record("readView");
      return stub.view;
    },
    waitAndSyncLayers: (...args: unknown[]) => record("waitAndSyncLayers", ...args),
    identifyFeatures: (...args: unknown[]) => {
      record("identifyFeatures", ...args);
      return stub.identifyResult;
    },
    getMap: () => stub.map,
  } as unknown as MapController;
  return { controller, stub };
}

/**
 * Reach into an engine's internals to install a controller without running
 * mount() (which needs DOM + WebGL) — the same documented idiom
 * tests/map-controller.test.ts uses to inject a fake map (MapControllerInternals).
 */
export function injectController(engine: unknown, controller: MapController): void {
  (engine as { controller: MapController | null }).controller = controller;
}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/maplibre-engine.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "../packages/core/src/types";
import { MapLibreEngine } from "../packages/map/src/engine/maplibre-engine";
import { injectController, makeFakeMap, makeStubController } from "./engine-test-fakes";

// The MapLibreEngine façade must be pure delegation onto MapController — no
// behavior of its own beyond event/coordinate translation. A stub controller
// records the calls; a fake map drives the event and identify paths.

function layer(id: string, type: string): GeoLibreLayer {
  return {
    id,
    name: id,
    type: type as GeoLibreLayer["type"],
    source: {},
    visible: true,
    opacity: 1,
    style: {},
    metadata: {},
  };
}

describe("MapLibreEngine delegation", () => {
  it("delegates applyView / readView / syncLayers / destroy to the controller", () => {
    const engine = new MapLibreEngine();
    const { controller, stub } = makeStubController();
    injectController(engine, controller);

    const view = { center: [8, 47] as [number, number], zoom: 6, bearing: 15, pitch: 30 };
    engine.applyView(view);
    engine.syncLayers([layer("a", "xyz")]);
    assert.deepEqual(engine.readView(), stub.view);
    engine.destroy();

    const methods = stub.calls.map((c) => c.method);
    assert.deepEqual(methods, ["applyView", "waitAndSyncLayers", "readView", "destroy"]);
    assert.deepEqual(stub.calls[0].args[0], view);
  });

  it("supports every layer kind (MapLibre is the reference 2D engine)", () => {
    const engine = new MapLibreEngine();
    for (const type of ["geojson", "xyz", "wms", "wmts", "raster", "3d-tiles"]) {
      assert.equal(engine.supportsLayer(layer("l", type)), true, type);
    }
  });

  it("no-ops (and returns the default view) before mount", async () => {
    const engine = new MapLibreEngine();
    engine.applyView({ center: [0, 0], zoom: 1, bearing: 0, pitch: 0 });
    engine.syncLayers([]);
    engine.destroy();
    assert.deepEqual(engine.readView(), { center: [-100, 40], zoom: 2, bearing: 0, pitch: 0 });
    assert.deepEqual(await engine.hitTest({ x: 10, y: 10 }), []);
    assert.equal(typeof engine.on("moveend", () => {}), "function");
  });

  it("translates moveend into { view, userDriven } and unsubscribes cleanly", () => {
    const engine = new MapLibreEngine();
    const { controller, stub } = makeStubController();
    injectController(engine, controller);
    const { fake, map } = makeFakeMap();
    stub.map = map;

    const seen: { userDriven: boolean }[] = [];
    const off = engine.on("moveend", (payload) => {
      assert.deepEqual(payload.view, stub.view);
      seen.push({ userDriven: payload.userDriven });
    });
    fake.fire("moveend", {});
    fake.fire("moveend", { originalEvent: {} });
    assert.deepEqual(seen, [{ userDriven: false }, { userDriven: true }]);
    off();
    fake.fire("moveend", {});
    assert.equal(seen.length, 2);
  });

  it("hitTest unprojects the screen point and returns identify hits", async () => {
    const engine = new MapLibreEngine();
    const { controller, stub } = makeStubController();
    injectController(engine, controller);
    stub.identifyResult = [
      { layerId: "a", featureId: "1", properties: { name: "x" }, geometry: null },
    ];

    const hits = await engine.hitTest({ x: 12, y: 34 });
    assert.deepEqual(hits, stub.identifyResult);
    const identify = stub.calls.find((c) => c.method === "identifyFeatures");
    // The fake map's unproject maps (x, y) → (lng, lat) 1:1.
    assert.deepEqual(identify?.args[0], [12, 34]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --import tsx --test tests/maplibre-engine.test.ts`
Expected: FAIL — `Cannot find module '../packages/map/src/engine/maplibre-engine'`.

- [ ] **Step 4: Implement the façade**

Create `packages/map/src/engine/maplibre-engine.ts`:

```ts
import type { GeoLibreLayer, MapPreferences, MapViewState } from "@geolibre/core";
import type maplibregl from "maplibre-gl";
import type { BuiltInMapControl, MapController } from "../map-controller";
import type {
  HitFeature,
  MapEngine,
  MapEngineEvent,
  MapEngineEventPayloads,
  ScreenPoint,
  Unsubscribe,
} from "./types";

// The MapLibre adapter for the MapEngine seam (migration-design.md §5.3): a
// façade over the existing MapController / layer-sync — pure delegation, no
// rewrite. Module scope carries only type imports; the controller module is
// value-imported inside mount() so this file satisfies the adapter contract
// (§2.2) even though MapLibre, as today's default engine, is on the boot path
// anyway via MapCanvas. The lazy import becomes load-bearing when Phase 5
// flips the default engine to ArcGIS.

/** Matches MapController.readView()'s no-map fallback (map-controller.ts:923). */
const DEFAULT_VIEW: MapViewState = { center: [-100, 40], zoom: 2, bearing: 0, pitch: 0 };

/** Engine-specific setup, mirroring MapController.init's options (minus the
 * view, which mount() carries per the MapEngine contract). */
export interface MapLibreEngineOptions {
  styleUrl?: string;
  mapPreferences?: MapPreferences;
  controlVisibility?: Partial<Record<BuiltInMapControl, boolean>>;
}

export class MapLibreEngine implements MapEngine {
  private controller: MapController | null = null;

  constructor(private readonly options: MapLibreEngineOptions = {}) {}

  async mount(container: HTMLElement, initialView: MapViewState): Promise<void> {
    if (this.controller) return;
    const { createMapController } = await import("../map-controller");
    const controller = createMapController();
    controller.init(container, {
      styleUrl: this.options.styleUrl,
      mapView: initialView,
      mapPreferences: this.options.mapPreferences,
      controlVisibility: this.options.controlVisibility,
    });
    this.controller = controller;
  }

  destroy(): void {
    this.controller?.destroy();
    this.controller = null;
  }

  applyView(view: MapViewState): void {
    this.controller?.applyView(view);
  }

  readView(): MapViewState {
    return this.controller ? this.controller.readView() : DEFAULT_VIEW;
  }

  syncLayers(layers: GeoLibreLayer[]): void {
    // waitAndSyncLayers (not syncLayers): it defers reconciliation until the
    // style is ready, which is what every current host already relies on.
    this.controller?.waitAndSyncLayers(layers);
  }

  supportsLayer(_layer: GeoLibreLayer): boolean {
    // MapLibre is the reference 2D engine: today's layer-sync renders (or
    // placeholder-handles) every store layer kind.
    return true;
  }

  async hitTest(point: ScreenPoint): Promise<HitFeature[]> {
    const controller = this.controller;
    const map = controller?.getMap();
    if (!controller || !map) return [];
    const lngLat = map.unproject([point.x, point.y]);
    return controller.identifyFeatures([lngLat.lng, lngLat.lat]);
  }

  on<E extends MapEngineEvent>(
    event: E,
    handler: (payload: MapEngineEventPayloads[E]) => void,
  ): Unsubscribe {
    const map = this.controller?.getMap();
    if (!map) return () => {};
    type Emit = (payload: MapEngineEventPayloads[E]) => void;
    let type: string = event;
    let wrapped: (e: never) => void;
    switch (event) {
      case "moveend":
        wrapped = (e: { originalEvent?: unknown }) =>
          (handler as Emit)({
            view: this.readView(),
            userDriven: Boolean(e?.originalEvent),
          } as MapEngineEventPayloads[E]);
        break;
      case "click":
        wrapped = (e: maplibregl.MapMouseEvent) =>
          (handler as Emit)({
            point: { x: e.point.x, y: e.point.y },
            lngLat: [e.lngLat.lng, e.lngLat.lat],
          } as MapEngineEventPayloads[E]);
        break;
      case "error":
        wrapped = (e: { error?: { message?: string } }) =>
          (handler as Emit)({
            message: e?.error?.message ?? String(e?.error ?? "unknown map error"),
          } as MapEngineEventPayloads[E]);
        break;
      default:
        // "load"
        type = "load";
        wrapped = () => (handler as Emit)(undefined as MapEngineEventPayloads[E]);
        break;
    }
    map.on(type as never, wrapped as never);
    return () => map.off(type as never, wrapped as never);
  }

  /**
   * TRANSITIONAL (Phase 0–2): the concrete controller for MapLibre-only wiring
   * (identify popups, plugins, MapCanvas's controllerRef). Only code inside
   * @geolibre/map may call this; it disappears when Phase 2 grows the MapEngine
   * interface to cover the 2D host's real needs. Logged in
   * .migrate-docs/claude/maplibre.md.
   */
  getController(): MapController | null {
    return this.controller;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --test tests/maplibre-engine.test.ts`
Expected: PASS (all 5 subtests).

- [ ] **Step 6: Export from the package index**

In `packages/map/src/index.ts`, append:

```ts
export { MapLibreEngine, type MapLibreEngineOptions } from "./engine/maplibre-engine";
```

- [ ] **Step 7: Full frontend suite + typecheck**

Run: `npm run test:frontend && npx tsc -b`
Expected: all suites PASS (nothing existing changed behavior), tsc exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/map/src/engine/maplibre-engine.ts packages/map/src/index.ts tests/engine-test-fakes.ts tests/maplibre-engine.test.ts
git commit -m "feat(map): add MapLibreEngine, the MapEngine facade over MapController"
```

---

### Task 3: Engine registry + id resolution

**Files:**
- Create: `packages/map/src/engine/registry.ts`
- Modify: `packages/map/src/index.ts`
- Test: `tests/engine-registry.test.ts`

**Interfaces:**
- Consumes: `MapEngine` (Task 1), `MapLibreEngine`/`MapLibreEngineOptions` (Task 2).
- Produces: `ENGINE_IDS: readonly ["maplibre"]`, `type MapEngineId = "maplibre"`, `resolveEngineId(raw: string | null | undefined): MapEngineId`, `createEngine(id: MapEngineId, options?: MapLibreEngineOptions): Promise<MapEngine>`. Tasks 5–6 rely on these exact names. Phase 1 extends `ENGINE_IDS` with `"arcgis-scene"` and turns the options parameter into a per-id map.

- [ ] **Step 1: Write the failing tests**

Create `tests/engine-registry.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MapLibreEngine } from "../packages/map/src/engine/maplibre-engine";
import { createEngine, ENGINE_IDS, resolveEngineId } from "../packages/map/src/engine/registry";

describe("resolveEngineId", () => {
  it("defaults to maplibre for absent values", () => {
    assert.equal(resolveEngineId(null), "maplibre");
    assert.equal(resolveEngineId(undefined), "maplibre");
    assert.equal(resolveEngineId(""), "maplibre");
  });

  it("accepts every registered id", () => {
    for (const id of ENGINE_IDS) assert.equal(resolveEngineId(id), id);
  });

  it("falls back to maplibre (with a warning) on unknown values", () => {
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      assert.equal(resolveEngineId("bogus"), "maplibre");
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /Unknown "engine" value "bogus"/);
  });
});

describe("createEngine", () => {
  it("creates a MapLibreEngine for the maplibre id", async () => {
    const engine = await createEngine("maplibre");
    assert.ok(engine instanceof MapLibreEngine);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/engine-registry.test.ts`
Expected: FAIL — `Cannot find module '../packages/map/src/engine/registry'`.

- [ ] **Step 3: Implement the registry**

Create `packages/map/src/engine/registry.ts`:

```ts
import type { MapLibreEngineOptions } from "./maplibre-engine";
import type { MapEngine } from "./types";

// Engine selection for the seam (migration-design.md §8 slice 3). The app
// resolves an id (e.g. from the dev-gated ?engine= query param) and hands it
// back here; only this module knows the concrete adapter classes, keeping the
// "nothing outside @geolibre/map talks to a concrete engine" contract. Each
// adapter module is dynamically imported so it stays in its own build chunk.
// Phase 1 adds "arcgis-scene" here (and per-id option types).

export const ENGINE_IDS = ["maplibre"] as const;
export type MapEngineId = (typeof ENGINE_IDS)[number];

/** Resolve a raw (query-param) value to a known engine id; unknown values warn
 * and fall back to the default so a stale/typoed URL still boots the app. */
export function resolveEngineId(raw: string | null | undefined): MapEngineId {
  if (!raw) return "maplibre";
  if ((ENGINE_IDS as readonly string[]).includes(raw)) return raw as MapEngineId;
  console.warn(`[geolibre] Unknown "engine" value "${raw}"; falling back to "maplibre".`);
  return "maplibre";
}

/** Instantiate the adapter for `id`. The heavy engine SDK still loads later,
 * inside the adapter's mount(); this only pulls the (featherweight) adapter
 * module. */
export async function createEngine(
  id: MapEngineId,
  options: MapLibreEngineOptions = {},
): Promise<MapEngine> {
  switch (id) {
    case "maplibre": {
      const { MapLibreEngine } = await import("./maplibre-engine");
      return new MapLibreEngine(options);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/engine-registry.test.ts`
Expected: PASS (4 subtests).

- [ ] **Step 5: Export from the package index**

In `packages/map/src/index.ts`, append:

```ts
export {
  createEngine,
  ENGINE_IDS,
  resolveEngineId,
  type MapEngineId,
} from "./engine/registry";
```

- [ ] **Step 6: Commit**

```bash
git add packages/map/src/engine/registry.ts packages/map/src/index.ts tests/engine-registry.test.ts
git commit -m "feat(map): add the engine registry and ?engine id resolution"
```

---

### Task 4: Engine conformance suite

**Files:**
- Test: `tests/engine-conformance.test.ts`

**Interfaces:**
- Consumes: `MapEngine` (Task 1), `MapLibreEngine` + `injectController`/`makeFakeMap` (Task 2), real `createMapController` (`packages/map/src/map-controller.ts:2592`), `isSameView` (`packages/map/src/cesium-camera.ts:155`).
- Produces: `runEngineConformance(name, factory)` — the parameterized contract runner. Phase 1's `ArcGISSceneEngine` registers a second factory here; that is the §2.2 gate for any new adapter.

- [ ] **Step 1: Write the suite (it should pass immediately — the adapter already exists; this task's deliverable is the reusable gate)**

Create `tests/engine-conformance.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer, MapViewState } from "../packages/core/src/types";
import { isSameView } from "../packages/map/src/cesium-camera";
import { MapLibreEngine } from "../packages/map/src/engine/maplibre-engine";
import type { MapEngine } from "../packages/map/src/engine/types";
import { createMapController, type MapController } from "../packages/map/src/map-controller";
import { injectController, makeFakeMap, type FakeMap } from "./engine-test-fakes";

// The cross-engine contract gate (migration-design.md §10): one parameterized
// spec run against every MapEngine adapter — same GeoLibreLayer[] in, same
// non-rendering behavior out. Rendering correctness stays in E2E (WebGL needs
// a browser); each factory returns an engine in a mounted-equivalent state
// backed by fakes. A new or changed adapter MUST register a factory here and
// pass (§2.2).

interface ConformanceHarness {
  engine: MapEngine;
  /** Ids of sources the engine currently holds, in no particular order. */
  sourceIds: () => string[];
  /** Fire the engine's underlying "camera settled" event. */
  fireMoveEnd: (userDriven: boolean) => void;
}

function xyzLayer(id: string): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "xyz" as GeoLibreLayer["type"],
    source: { tiles: [`https://tiles.example/${id}/{z}/{x}/{y}.png`], tileSize: 256 },
    visible: true,
    opacity: 1,
    style: {},
    metadata: {},
  };
}

const SUPPORTED_2D_KINDS = ["geojson", "xyz", "wms", "wmts", "raster"];

function runEngineConformance(name: string, factory: () => ConformanceHarness): void {
  describe(`engine conformance: ${name}`, () => {
    it("reports layer-kind support consistently", () => {
      const { engine } = factory();
      for (const kind of SUPPORTED_2D_KINDS) {
        assert.equal(
          engine.supportsLayer({ ...xyzLayer("probe"), type: kind as GeoLibreLayer["type"] }),
          true,
          kind,
        );
      }
    });

    it("round-trips applyView → readView within isSameView tolerance", () => {
      const { engine } = factory();
      const view: MapViewState = { center: [8.54, 47.37], zoom: 11, bearing: 30, pitch: 45 };
      engine.applyView(view);
      assert.ok(isSameView(engine.readView(), view));
    });

    it("syncLayers adds, removes, and re-syncs bookkeeping", () => {
      const { engine, sourceIds } = factory();
      engine.syncLayers([xyzLayer("a"), xyzLayer("b")]);
      assert.deepEqual([...sourceIds()].sort(), ["source-a", "source-b"]);
      engine.syncLayers([xyzLayer("b")]);
      assert.deepEqual(sourceIds(), ["source-b"]);
      engine.syncLayers([]);
      assert.deepEqual(sourceIds(), []);
    });

    it("emits moveend with the current view and the userDriven flag", () => {
      const { engine, fireMoveEnd } = factory();
      const seen: { view: MapViewState; userDriven: boolean }[] = [];
      const off = engine.on("moveend", (payload) => void seen.push(payload));
      fireMoveEnd(false);
      fireMoveEnd(true);
      assert.equal(seen.length, 2);
      assert.equal(seen[0].userDriven, false);
      assert.equal(seen[1].userDriven, true);
      assert.ok(isSameView(seen[0].view, engine.readView()));
      off();
      fireMoveEnd(true);
      assert.equal(seen.length, 2);
    });

    it("hitTest resolves to an array (empty when nothing is under the point)", async () => {
      const { engine } = factory();
      assert.deepEqual(await engine.hitTest({ x: 5, y: 5 }), []);
    });

    it("destroy() is idempotent and returns the engine to the unmounted state", () => {
      const { engine } = factory();
      engine.destroy();
      engine.destroy();
      engine.syncLayers([xyzLayer("a")]); // must no-op, not throw
      assert.deepEqual(engine.readView(), { center: [-100, 40], zoom: 2, bearing: 0, pitch: 0 });
    });
  });
}

// --- MapLibreEngine: real MapController + fake map (no DOM/WebGL) -----------

interface MapControllerInternals {
  map: unknown;
  styleReady: boolean;
}

function makeMapLibreHarness(): ConformanceHarness {
  const engine = new MapLibreEngine();
  const controller = createMapController();
  const { map, fake } = makeFakeMap();
  const internals = controller as unknown as MapControllerInternals;
  internals.map = map;
  internals.styleReady = true;
  injectController(engine, controller as MapController);
  return {
    engine,
    sourceIds: () => [...fake.sources.keys()].filter((id) => id.startsWith("source-")),
    fireMoveEnd: (userDriven: boolean) =>
      fake.fire("moveend", userDriven ? { originalEvent: {} } : {}),
  };
}

runEngineConformance("MapLibreEngine", makeMapLibreHarness);
```

Notes for the implementer:
- `source-a` is the id `sourceId()` in `packages/map/src/geojson-loader.ts` produces (`source-${layer.id}`); confirm with that file and adjust the `sourceIds` filter if the raster path names sources differently — `tests/raster-layer-sync.test.ts` shows the exact ids the raster sync uses.
- If `waitAndSyncLayers` defers via a `load` handler even with `styleReady = true` (see `map-controller.ts:972`), drive it with `fake.fire("load")` inside `syncLayers`-asserting tests — `tests/map-controller.test.ts` shows which internals flags make sync run synchronously.
- The camera round-trip runs through `constrainMapView` (`map-controller.ts:2415`); with the controller's default `DEFAULT_PROJECT_PREFERENCES.map` (no `restrictBounds`) it never touches the map beyond `jumpTo`, so the fake suffices.

- [ ] **Step 2: Run the suite**

Run: `node --import tsx --test tests/engine-conformance.test.ts`
Expected: PASS (6 subtests). If a fake-map method is missing (layer-sync touches more of the style API than the raster subset), extend `tests/engine-test-fakes.ts` with the recorded no-op and re-run — the failure message names the missing method.

- [ ] **Step 3: Full frontend suite**

Run: `npm run test:frontend`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/engine-conformance.test.ts tests/engine-test-fakes.ts
git commit -m "test(map): add the parameterized engine-conformance suite (gate for adapters)"
```

---

### Task 5: MapCanvas host refactor

**Files:**
- Modify: `packages/map/src/MapCanvas.tsx` (props at `:39`, mount effect at `:927-1047`, layer effects at `:1056` and `:1087`, camera effect at `:1373`)

**Interfaces:**
- Consumes: `createEngine`, `MapEngineId` (Task 3); `MapLibreEngine.getController()` (Task 2).
- Produces: `MapCanvasProps` gains `engineId?: MapEngineId` (default `"maplibre"`); everything else — including `controllerRef` — is unchanged, so `DesktopShell` keeps working untouched until Task 6.

- [ ] **Step 1: Extend the props**

In `packages/map/src/MapCanvas.tsx:39`:

```ts
export interface MapCanvasProps {
  controllerRef?: React.MutableRefObject<MapController | null>;
  onMapDiagnosticEvent?: (event: MapDiagnosticEvent) => void;
  onControllerReady?: () => void;
  /**
   * Which rendering engine draws the primary map (migration-design.md §8).
   * Default "maplibre". Read once at mount; changing it later has no effect
   * until the canvas remounts (engine hot-swap is out of Phase 0's scope).
   */
  engineId?: MapEngineId;
}
```

Add the imports at the top of the file:

```ts
import { createEngine, type MapEngineId } from "./engine/registry";
import type { MapLibreEngine } from "./engine/maplibre-engine";
import type { MapEngine } from "./engine/types";
```

- [ ] **Step 2: Rework the mount effect to go through the engine**

Replace the body of the mount effect (`MapCanvas.tsx:927-1047`). New refs next to the existing `controller` ref: `const engineRef = useRef<MapEngine | null>(null);` and `const engineIdRef = useRef(engineId ?? "maplibre"); engineIdRef.current = engineId ?? "maplibre";`

The effect keeps its exact current contents with these changes only (CesiumCanvas's cancelled-guard pattern, `packages/map/src/CesiumCanvas.tsx:134-296`, is the model):

```tsx
useEffect(() => {
  if (!containerRef.current || engineRef.current) return;
  const container = containerRef.current;
  let cancelled = false;

  // Resize wiring attaches synchronously (the observer may fire before the
  // async mount resolves; resize no-ops until the map exists). This is the
  // block currently at lines 995-1031, with `mc.getMap()?.resize()` replaced by
  // `controller.current?.getMap()?.resize()` and the trailing `resizeMap()`
  // call MOVED into the async continuation below (today it runs right after
  // the synchronous init).
  /* … resizeMap / panel-resize handlers / ResizeObserver, unchanged otherwise … */

  void (async () => {
    const engine = await createEngine(engineIdRef.current, {
      styleUrl: basemapStyleUrl,
      mapPreferences,
    });
    await engine.mount(container, mapView);
    if (cancelled || !container.isConnected) {
      engine.destroy();
      return;
    }
    engineRef.current = engine;

    // TRANSITIONAL (Phase 0): the rich single-map wiring below (popups,
    // diagnostics, projection, controllerRef for the app/plugins) is
    // MapLibre-specific and reaches the concrete controller. It migrates
    // behind the MapEngine interface in Phase 2. Only "maplibre" exists as a
    // primary-map engine in Phase 0, so the cast cannot mis-fire.
    const mc = (engine as MapLibreEngine).getController();
    const map = mc?.getMap();
    if (!mc || !map) return;
    controller.current = mc;
    if (controllerRef) controllerRef.current = mc;

    /* … every map.on(...) handler currently at lines 939-993, byte-identical,
       except updateView (line 950-959) which becomes:

       const updateView = (event?: { originalEvent?: unknown }) => {
         if (useAppStore.getState().ui.storymapPresenting) return;
         setMapView(engine.readView(), Boolean(event?.originalEvent));
       };
    … */

    // A store camera change during the await window above would otherwise be
    // dropped (the applyView effect saw engineRef.current === null). Re-apply
    // the latest store view if it moved past the one mount() was given.
    const latest = useAppStore.getState().mapView;
    if (latest !== mapView) engine.applyView(latest);

    resizeMap(); // moved from line 1031
  })();

  return () => {
    cancelled = true;
    /* … observer/listener cleanup, unchanged (lines 1034-1039) … */
    engineRef.current?.destroy(); // destroys the controller (façade delegation)
    engineRef.current = null;
    controller.current = null;
    if (controllerRef) controllerRef.current = null;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

Implementer notes:
- The `map.on("load")` handler (`:982-993`) stays byte-identical — it already re-reads `useAppStore.getState()` and syncs layers/basemap/highlight, which also covers any layer change that landed during the await window.
- `mc.waitAndSyncLayers` inside that load handler (`:984`) becomes `engine.syncLayers(...)` — same delegate.
- Do not touch the `mousemove`/`mouseout`/`error`/`projectiontransition` handlers beyond the closure variable rename (`mc`/`map` still in scope).

- [ ] **Step 3: Route the store-driven effects through the engine**

- `:1056` and `:1087`: `controller.current?.waitAndSyncLayers(...)` → `engineRef.current?.syncLayers(...)` (same arguments).
- `:1373`: `controller.current?.applyView(mapView)` → `engineRef.current?.applyView(mapView)`.
- Every other `controller.current?.…` call in the file stays as-is (decision 3).

- [ ] **Step 4: Verify — frontend suite, typecheck, E2E smoke**

Run: `npm run test:frontend && npx tsc -b`
Expected: PASS / exit 0.

Run: `npx playwright test e2e/smoke.spec.ts` (first time: `npx playwright install chromium`)
Expected: PASS — the primary map paints and accepts a GeoJSON drop exactly as before the refactor.

- [ ] **Step 5: Commit**

```bash
git add packages/map/src/MapCanvas.tsx
git commit -m "refactor(map): mount the primary map through the MapEngine seam"
```

---

### Task 6: App-side `?engine` selection

**Files:**
- Create: `apps/geolibre-desktop/src/lib/engine-param.ts`
- Modify: `apps/geolibre-desktop/src/components/layout/DesktopShell.tsx:1940`
- Test: `e2e/engine-param.spec.ts`

**Interfaces:**
- Consumes: `resolveEngineId`, `MapEngineId` from `@geolibre/map` (Task 3); `MapCanvasProps.engineId` (Task 5).
- Produces: `getInitialEngineId(): MapEngineId` — resolved once per page load, memoized so re-renders can't repeat the unknown-value warning.

- [ ] **Step 1: Write the app-side resolver**

Create `apps/geolibre-desktop/src/lib/engine-param.ts`:

```ts
import { resolveEngineId, type MapEngineId } from "@geolibre/map";

// Dev-gated engine selection for the primary map (migration-design.md §8 slice
// 3): ?engine=maplibre today, ?engine=arcgis-scene once Phase 1 lands. Mirrors
// the ?locale pattern (src/i18n/index.ts getInitialLanguage) — resolved from
// the URL once per page load; unknown values warn and fall back to the
// default. Deliberately not persisted and not in the store: split-pane engine
// choice stays SecondaryMapView.viewKind until Phase 1.

let resolved: MapEngineId | null = null;

export function getInitialEngineId(): MapEngineId {
  if (resolved) return resolved;
  resolved =
    typeof window === "undefined"
      ? "maplibre"
      : resolveEngineId(new URLSearchParams(window.location.search).get("engine"));
  return resolved;
}
```

(The pure resolution logic is already unit-tested in `tests/engine-registry.test.ts`; this wrapper only reads `window` and caches.)

- [ ] **Step 2: Pass it to the canvas**

In `apps/geolibre-desktop/src/components/layout/DesktopShell.tsx`, add the import and extend the `<MapCanvas` element at `:1940`:

```tsx
import { getInitialEngineId } from "@/lib/engine-param";
```

```tsx
<MapCanvas
  engineId={getInitialEngineId()}
  /* existing props unchanged */
```

(Check the file's existing import style — if it uses relative paths instead of a `@/` alias, follow the file.)

- [ ] **Step 3: Write the E2E spec**

Create `e2e/engine-param.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

// Phase 0 of the ArcGIS migration: ?engine= selects the primary map's engine.
// Only "maplibre" exists yet, so both a valid and an unknown value must boot
// the same MapLibre map — the unknown one after a console warning, never a
// blank canvas.

test("boots the MapLibre engine with ?engine=maplibre", async ({ page }) => {
  await page.goto("/?engine=maplibre");
  await expect(page.getByTestId("map-canvas")).toBeVisible();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 30_000 });
});

test("warns and falls back to maplibre on an unknown ?engine value", async ({ page }) => {
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });
  await page.goto("/?engine=bogus");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 30_000 });
  expect(warnings.some((text) => text.includes('Unknown "engine" value "bogus"'))).toBe(true);
});
```

- [ ] **Step 4: Run the E2E spec**

Run: `npx playwright test e2e/engine-param.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/geolibre-desktop/src/lib/engine-param.ts apps/geolibre-desktop/src/components/layout/DesktopShell.tsx e2e/engine-param.spec.ts
git commit -m "feat(app): dev-gated ?engine selector for the primary map"
```

---

### Task 7: Full verification, migration log, PR

**Files:**
- Modify: `.migrate-docs/claude/maplibre.md` (append per-step entries), `.migrate-docs/claude/00-overview.md` (status)

- [ ] **Step 1: Full CI gate**

Run: `npm run ci`
Expected: build + frontend (with coverage ≥ 78/78/63) + worker + backend + rust all PASS. If backend/rust are unavailable locally, run at minimum `npm run build && npm run test:frontend:coverage && npm run test:worker` and let CI cover the rest — say so in the PR.

- [ ] **Step 2: Exit-criteria check (design doc §8)**

- App behaves identically with `engine=maplibre` (Task 5 smoke + Task 6 spec).
- Conformance suite green for `MapLibreEngine` (Task 4).
- Zero user-visible change: no i18n, CSP, or store-schema diffs in `git diff main --stat`.

- [ ] **Step 3: Update the migration log**

Append implementation entries (one per landed task, using the exact template in `.migrate-docs/document-migration.md`) to `.migrate-docs/claude/maplibre.md`, and set MapLibre's row in `.migrate-docs/claude/00-overview.md` to `in progress — Phase 0 seam landed`. Include verification evidence (commands + results) in each entry.

- [ ] **Step 4: Pre-commit on the changed files, push, PR**

```bash
pre-commit run --files packages/map/src/engine/*.ts packages/map/src/MapCanvas.tsx packages/map/src/index.ts apps/geolibre-desktop/src/lib/engine-param.ts apps/geolibre-desktop/src/components/layout/DesktopShell.tsx tests/engine-*.ts tests/maplibre-engine.test.ts e2e/engine-param.spec.ts
git push -u origin feat/phase0-map-engine-seam
gh pr create --title "Phase 0: extract the MapEngine seam" --body "$(cat <<'EOF'
## Summary
- Adds the `MapEngine` interface, `MapLibreEngine` façade over `MapController`, engine registry, and dev-gated `?engine=` selection (migration-design.md §8)
- Primary map now mounts through the seam; zero user-visible change (`engine=maplibre` default)
- Parameterized engine-conformance suite gates every current and future adapter

## Test plan
- [ ] `npm run ci`
- [ ] `npx playwright test e2e/engine-param.spec.ts e2e/smoke.spec.ts`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review (performed while writing)

- **Spec coverage vs. §8:** slice 1 (interface) → Task 1; slice 2 (façade) → Task 2; slice 3 (selection) → Tasks 3+6; slice 4 (host refactor) → Task 5; slice 5 (conformance) → Task 4. Exit criteria → Task 7. The "optional hidden store field" of slice 3 is deliberately deferred (decision 5, logged).
- **Contracts (§2.2):** store untouched; only `@geolibre/map` names concrete engines (the app passes an id string); `maplibre-engine.ts` is type-only at module scope with the value import inside `mount()`; conformance suite added; data ingest untouched.
- **Type consistency:** `MapLibreEngineOptions`/`getController()`/`createEngine`/`resolveEngineId`/`engineId` names match across Tasks 2→6; `HitFeature` matches `identifyFeatures`' return shape (`map-controller.ts:1353`); `DEFAULT_VIEW` matches `readView`'s fallback (`map-controller.ts:923`).
- **Known uncertainty, contained:** the exact source-id naming and `waitAndSyncLayers`' deferral behavior against the fake map are verified-by-test in Task 4 Step 2, with the reference files named (`tests/raster-layer-sync.test.ts`, `tests/map-controller.test.ts`) for the adjustment if an assertion needs different ids.
