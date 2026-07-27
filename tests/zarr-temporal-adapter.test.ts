import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import {
  __setComponentsModuleLoaderForTests,
  addZarrRasterLayer,
  type ComponentsModules,
} from "../packages/plugins/src/plugins/maplibre-components.ts";
import {
  __resetTemporalLayersForTests,
  getTemporalLayerAdapter,
} from "../packages/plugins/src/plugins/temporal-layers.ts";
import { __resetZarrTimeAttributeCacheForTests } from "../packages/plugins/src/plugins/zarr-time-axis.ts";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// A Zarr cube's time is an internal dimension, so `addZarrLayer` registers a
// temporal adapter that the Time Slider drives through `setSelector`
// (opengeos/GeoLibre#1448). This drives the real registration path with a
// stand-in for maplibre-gl-components' ZarrLayerControl.

const STORE_URL = "https://example.org/era5.zarr";
// A daily axis stored the CF way: raw offsets plus a `units` attribute. Only the
// store metadata can say these are days-since-2020, not calendar years.
const RAW_TIME_VALUES = [0, 1, 2, 3, 4];
const selectorCalls: {
  layerId: string;
  selector: Record<string, number | string>;
}[] = [];
let dimensionValues: Record<string, (number | string)[]> = {};

class ZarrLayerControlStub {
  private handlers = new Map<string, Set<(event: unknown) => void>>();
  private layers: {
    id: string;
    url: string;
    variable: string;
    colormap: string[];
    clim: [number, number];
    opacity: number;
  }[] = [];
  private instances = new Map<string, unknown>();
  private counter = 0;

  on(event: string, handler: (event: unknown) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: (event: unknown) => void) {
    this.handlers.get(event)?.delete(handler);
  }

  hide() {}

  async addLayer(url?: string, variable?: string) {
    const id = `zarr-layer-${this.counter++}`;
    this.layers.push({
      id,
      url: url ?? "",
      variable: variable ?? "",
      colormap: ["#000000"],
      clim: [0, 1],
      opacity: 1,
    });
    // Mirrors the renderer: the loaded coordinates hang off the layer instance,
    // and the raw (undecoded) values are what the adapter has to work from.
    this.instances.set(id, {
      dimensionValues,
      setSelector: (selector: Record<string, number | string>) => {
        selectorCalls.push({ layerId: id, selector });
      },
    });
    this.emit("layeradd", { url, layerId: id, state: { layers: this.layers } });
  }

  getLayersMap() {
    return this.instances;
  }

  setLayerOpacity() {}
  setLayerVisibility() {}
  removeLayer() {}

  private emit(event: string, payload: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

const app = {
  addMapControl: () => true,
  removeMapControl: () => {},
  getMap: () => null,
} as unknown as GeoLibreAppAPI;

function installStubModule(): void {
  __setComponentsModuleLoaderForTests(
    (): Promise<ComponentsModules> =>
      Promise.resolve([
        { ZarrLayerControl: ZarrLayerControlStub } as unknown as NonNullable<ComponentsModules[0]>,
        null,
      ]),
  );
}

/** Serve the store's consolidated metadata so the CF units can be read. */
function installFetchStub(attributes: Record<string, unknown> | null): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (attributes && url === `${STORE_URL}/.zmetadata`) {
      return {
        ok: true,
        json: async () => ({ metadata: { "time/.zattrs": attributes } }),
      };
    }
    return { ok: false, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Wait for the adapter the add path registers asynchronously. */
async function waitForAdapter(layerId: string, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    const adapter = getTemporalLayerAdapter(layerId);
    if (adapter) return adapter;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

beforeEach(() => {
  dimensionValues = { time: [...RAW_TIME_VALUES], lat: [0, 1], lon: [0, 1] };
  selectorCalls.length = 0;
  installStubModule();
});

afterEach(() => {
  useAppStore.setState({ layers: [] });
  __resetTemporalLayersForTests();
  __resetZarrTimeAttributeCacheForTests();
});

describe("a Zarr layer's temporal adapter", () => {
  it("registers an adapter whose axis is decoded with the store's CF units", async () => {
    const restoreFetch = installFetchStub({ units: "days since 2020-01-01" });
    try {
      const id = await addZarrRasterLayer(app, {
        url: STORE_URL,
        variable: "t2m",
      });
      const adapter = await waitForAdapter(id);
      assert.ok(adapter, "expected addZarrLayer to register a temporal adapter");
      assert.equal(adapter.dimension, "time");
      assert.deepEqual(adapter.getTimeValues(), [
        Date.UTC(2020, 0, 1),
        Date.UTC(2020, 0, 2),
        Date.UTC(2020, 0, 3),
        Date.UTC(2020, 0, 4),
        Date.UTC(2020, 0, 5),
      ]);
    } finally {
      restoreFetch();
    }
  });

  it("steps the renderer to the slice nearest the date it is given", async () => {
    const restoreFetch = installFetchStub({ units: "days since 2020-01-01" });
    try {
      const id = await addZarrRasterLayer(app, {
        url: STORE_URL,
        variable: "t2m",
      });
      const adapter = await waitForAdapter(id);
      assert.ok(adapter);

      // A date between two slices snaps to the closer one, so a month-stepping
      // timeline over a daily cube still lands on a real time value.
      await adapter.setTime(new Date(Date.UTC(2020, 0, 3, 20)));
      assert.deepEqual(selectorCalls.at(-1), {
        layerId: id,
        selector: { time: 3 },
      });

      // A date past the end of the axis clamps rather than failing.
      await adapter.setTime(new Date(Date.UTC(2030, 0, 1)));
      assert.deepEqual(selectorCalls.at(-1), {
        layerId: id,
        selector: { time: 4 },
      });

      // The selector is written back to the store, so the Metadata panel and the
      // project file show the slice on screen.
      const layer = useAppStore.getState().layers.find((item) => item.id === id);
      assert.deepEqual(layer?.metadata.selector, { time: 4 });
    } finally {
      restoreFetch();
    }
  });

  it("registers no adapter for a cube with no time dimension", async () => {
    dimensionValues = { month: [1, 2, 3], band: [0, 1] };
    const restoreFetch = installFetchStub(null);
    try {
      const id = await addZarrRasterLayer(app, {
        url: STORE_URL,
        variable: "climate",
      });
      assert.equal(await waitForAdapter(id, 6), undefined);
    } finally {
      restoreFetch();
    }
  });

  it("drops the adapter when the layer is removed", async () => {
    const restoreFetch = installFetchStub({ units: "days since 2020-01-01" });
    try {
      const id = await addZarrRasterLayer(app, {
        url: STORE_URL,
        variable: "t2m",
      });
      assert.ok(await waitForAdapter(id));
      useAppStore.getState().removeLayer(id);
      assert.equal(getTemporalLayerAdapter(id), undefined);
    } finally {
      restoreFetch();
    }
  });
});
