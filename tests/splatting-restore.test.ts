import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src/types";
import { useAppStore } from "../packages/core/src/store";
import {
  __setComponentsModuleLoaderForTests,
  type ComponentsModules,
} from "../packages/plugins/src/plugins/components/constructors";
import {
  openSplattingLayerPanel,
  restoreSplattingLayers,
  teardownSplattingControl,
} from "../packages/plugins/src/plugins/components/splatting";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// Regression tests for two splatting-control bugs (opengeos/GeoLibre#2643):
// saved splat layers were never reloaded, and a fresh control restarted its ids
// at splat-0 / model-0, so a new load could take a saved layer's id and
// overwrite it.

type Placement = {
  longitude?: number;
  latitude?: number;
  altitude?: number;
  rotation?: [number, number, number];
  scale?: number;
};
type LoadOptions = Placement & { id?: string; flyTo?: boolean };
type AssetPlacement = Required<Placement> & { id: string; type: "splat" | "model"; url: string };
type Handler = (event: {
  url?: string;
  splatId?: string;
  modelId?: string;
  placement?: AssetPlacement;
}) => void;

let lastControl: FakeSplatControl | null = null;

// Mirrors the public API of maplibre-gl-splat's GaussianSplatControl (0.3+)
// that GeoLibre uses: generated `splat-N` / `model-N` ids skip ids the
// `isIdReserved` option claims, an explicit `id` is used as given (and rejected
// when taken), `flyTo` overrides the option per call, and load events carry the
// resolved placement. Model ids are taken after an await, as upstream does.
class FakeSplatControl {
  splats = new Map<string, AssetPlacement>();
  models = new Map<string, AssetPlacement>();
  flyToDuringLoad: boolean[] = [];
  hidden = false;
  private counters = { splat: 0, model: 0 };
  private handlers = new Map<string, Handler[]>();

  constructor(private options: { flyTo?: boolean; isIdReserved?: (id: string) => boolean }) {
    lastControl = this;
  }

  on(event: string, handler: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  off(): void {}

  private emit(event: string, payload: Parameters<Handler>[0]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }

  private nextId(type: "splat" | "model"): string {
    for (;;) {
      const id = `${type}-${this.counters[type]++}`;
      if (!this.options.isIdReserved?.(id) && !this.splats.has(id) && !this.models.has(id)) {
        return id;
      }
    }
  }

  private place(type: "splat" | "model", url: string, options?: LoadOptions): string {
    if (options?.id && (this.splats.has(options.id) || this.models.has(options.id))) {
      throw new Error(`id ${options.id} is taken`);
    }
    const id = options?.id ?? this.nextId(type);
    this.flyToDuringLoad.push(options?.flyTo ?? this.options.flyTo ?? true);
    const placement: AssetPlacement = {
      id,
      type,
      url,
      longitude: options?.longitude ?? 1,
      latitude: options?.latitude ?? 2,
      altitude: options?.altitude ?? 0,
      rotation: options?.rotation ?? (type === "splat" ? [-90, 90, 0] : [90, 0, 0]),
      scale: options?.scale ?? 0.5,
    };
    (type === "splat" ? this.splats : this.models).set(id, placement);
    this.emit(`${type}load`, { url, [`${type}Id`]: id, placement });
    return id;
  }

  async loadSplat(url: string, options?: LoadOptions): Promise<string> {
    return this.place("splat", url, options);
  }

  async loadModel(url: string, options?: LoadOptions): Promise<string> {
    await Promise.resolve();
    return this.place("model", url, options);
  }

  removeSplat(id: string): void {
    if (this.splats.delete(id)) this.emit("splatremove", { splatId: id });
  }

  removeModel(id: string): void {
    if (this.models.delete(id)) this.emit("modelremove", { modelId: id });
  }

  show(): void {
    this.hidden = false;
  }

  hide(): void {
    this.hidden = true;
  }

  expand(): void {}
}

const visibilityCalls: Array<[string, boolean]> = [];
const opacityCalls: Array<[string, number]> = [];

class FakeSplatLayerAdapter {
  constructor(private control: FakeSplatControl) {}

  getLayerIds(): string[] {
    return [...this.control.splats.keys(), ...this.control.models.keys()];
  }

  getLayerState(): { opacity: number } {
    return { opacity: 1 };
  }

  setVisibility(id: string, visible: boolean): void {
    visibilityCalls.push([id, visible]);
  }

  setOpacity(id: string, opacity: number): void {
    opacityCalls.push([id, opacity]);
  }

  removeLayer(): void {}

  destroy(): void {}
}

const fakeModules = [
  {},
  { GaussianSplatControl: FakeSplatControl, GaussianSplatLayerAdapter: FakeSplatLayerAdapter },
] as unknown as ComponentsModules;

const app = {
  addMapControl: () => true,
  removeMapControl: () => {},
} as unknown as GeoLibreAppAPI;

function savedSplatLayer(
  id: string,
  url: string,
  extra: Partial<GeoLibreLayer> = {},
  source: Record<string, unknown> = {},
): GeoLibreLayer {
  const assetType = id.startsWith("model") ? "model" : "splat";
  return {
    id,
    name: id,
    type: "gaussian-splat",
    source: { assetType, sourceId: id, type: "gaussian-splat", url, ...source },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      assetType,
      customLayerType: "gaussian-splat",
      externalNativeLayer: true,
      identifiable: false,
      sourceId: id,
      sourceKind: "splatting-url",
    },
    sourcePath: url,
    ...extra,
  } as GeoLibreLayer;
}

function geoJsonLayer(id: string): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
  } as GeoLibreLayer;
}

function storeLayer(id: string): GeoLibreLayer | undefined {
  return useAppStore.getState().layers.find((layer) => layer.id === id);
}

async function openControl(): Promise<FakeSplatControl> {
  openSplattingLayerPanel(app);
  // Let the constructor load, the mount, and the mount-time restore run.
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  await restoreSplattingLayers(app);
  assert.ok(lastControl, "the splat control was created");
  return lastControl;
}

describe("splatting control", () => {
  beforeEach(() => {
    __setComponentsModuleLoaderForTests(() => Promise.resolve(fakeModules));
    lastControl = null;
    visibilityCalls.length = 0;
    opacityCalls.length = 0;
    const state = useAppStore.getState();
    for (const layer of [...state.layers]) state.removeLayer(layer.id);
  });

  afterEach(() => {
    teardownSplattingControl(app);
    __setComponentsModuleLoaderForTests(null);
  });

  it("does not hand a new load the id of a layer already in the store", async () => {
    // Not a splat layer, so nothing restores it: only the id is taken.
    useAppStore.getState().addLayer(geoJsonLayer("splat-0"));
    useAppStore.getState().addLayer(geoJsonLayer("model-0"));
    const control = await openControl();

    const splatId = await control.loadSplat("https://example.org/a.splat");
    const modelId = await control.loadModel("https://example.org/b.glb");

    assert.equal(splatId, "splat-1");
    assert.equal(modelId, "model-1");
    // The layers that owned the ids are untouched.
    assert.equal(storeLayer("splat-0")?.type, "geojson");
    assert.equal(storeLayer("model-0")?.type, "geojson");
    assert.equal(storeLayer("splat-1")?.type, "gaussian-splat");
    assert.equal(storeLayer("model-1")?.type, "gaussian-splat");
  });

  it("reloads saved layers under their saved ids, placement and visibility", async () => {
    useAppStore
      .getState()
      .addLayer(
        savedSplatLayer(
          "splat-3",
          "https://example.org/saved.splat",
          { visible: false, opacity: 0.4 },
          { longitude: 10, latitude: 20, altitude: 5, rotation: [1, 2, 3], scale: 2 },
        ),
      );
    useAppStore.getState().addLayer(savedSplatLayer("model-2", "https://example.org/saved.glb"));
    const control = await openControl();

    assert.deepEqual([...control.splats.keys()], ["splat-3"]);
    assert.deepEqual([...control.models.keys()], ["model-2"]);
    assert.equal(control.splats.get("splat-3")?.longitude, 10);
    assert.equal(control.splats.get("splat-3")?.latitude, 20);
    assert.deepEqual(control.splats.get("splat-3")?.rotation, [1, 2, 3]);
    // The saved placement stays on the store layer.
    assert.deepEqual(
      (storeLayer("splat-3")?.source as Record<string, unknown>).rotation,
      [1, 2, 3],
    );
    // The saved hidden state and opacity are pushed onto the reloaded asset and
    // kept on the store layer.
    assert.deepEqual(visibilityCalls, [["splat-3", false]]);
    assert.deepEqual(opacityCalls, [["splat-3", 0.4]]);
    assert.equal(storeLayer("splat-3")?.visible, false);
    assert.equal(storeLayer("splat-3")?.opacity, 0.4);
    // No per-restore fly-to; a restored control stays hidden until opened.
    assert.deepEqual(control.flyToDuringLoad, [false, false]);
    assert.equal(useAppStore.getState().layers.length, 2);

    // A later load skips the restored ids.
    const nextId = await control.loadSplat("https://example.org/new.splat");
    assert.notEqual(nextId, "splat-3");
    assert.equal(storeLayer("splat-3")?.sourcePath, "https://example.org/saved.splat");
  });

  it("records a load's placement on its store layer so it can be restored", async () => {
    const control = await openControl();

    const id = await control.loadSplat("https://example.org/a.splat", {
      longitude: 7,
      latitude: 8,
      altitude: 9,
    });

    const source = storeLayer(id)?.source as Record<string, unknown>;
    assert.equal(source.longitude, 7);
    assert.equal(source.latitude, 8);
    assert.equal(source.altitude, 9);
    // Not passed, so taken from the placement the control reports.
    assert.deepEqual(source.rotation, [-90, 90, 0]);
    assert.equal(source.scale, 0.5);
  });

  it("restores a layer whose id is not splat-N or model-N", async () => {
    useAppStore
      .getState()
      .addLayer(
        savedSplatLayer("my-scan", "https://example.org/scan.splat", {}, { assetType: "splat" }),
      );
    const control = await openControl();
    assert.deepEqual([...control.splats.keys()], ["my-scan"]);
  });

  it("does not reload a layer that is already loaded", async () => {
    useAppStore.getState().addLayer(savedSplatLayer("splat-0", "https://example.org/saved.splat"));
    const control = await openControl();
    await restoreSplattingLayers(app);
    openSplattingLayerPanel(app);
    await restoreSplattingLayers(app);

    assert.equal(control.flyToDuringLoad.length, 1);
  });

  it("restores a layer added while an earlier restore is still running", async () => {
    const control = await openControl();
    useAppStore.getState().addLayer(savedSplatLayer("model-1", "https://example.org/one.glb"));
    const first = restoreSplattingLayers(app);
    // The first restore has snapshotted the store and is awaiting its load.
    useAppStore.getState().addLayer(savedSplatLayer("model-2", "https://example.org/two.glb"));
    const second = restoreSplattingLayers(app);
    await Promise.all([first, second]);

    assert.deepEqual([...control.models.keys()].sort(), ["model-1", "model-2"]);
  });
});
