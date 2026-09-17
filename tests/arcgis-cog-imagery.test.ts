import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArcgisCogLayer } from "../packages/map/src/arcgis-cog-imagery";
import { compileArcgisLayer, isArcgisPluginLayer } from "../packages/map/src/arcgis-layers";
import type { ArcgisSdk } from "../packages/map/src/arcgis-sdk";
import type { CogTilerModule } from "../packages/map/src/cog-imagery";
import { cachingCogTiler } from "../packages/map/src/cog-imagery";
import { geojsonLayer } from "./helpers/layer-fixtures";

const layer = geojsonLayer({
  type: "cog",
  geojson: undefined,
  source: { type: "raster", url: "https://example.test/a.tif" },
  metadata: {
    bandCount: 4,
    rasterState: { mode: "rgb", bands: [4, 3, 2], gamma: 1.5 },
  },
});
function fakeSdk() {
  return {
    layers: {
      BaseTileLayer: {
        createSubclass(definition: object) {
          class Raster {
            pending?: Promise<unknown>;
            destroyed = false;
            addResolvingPromise(p: Promise<unknown>) {
              this.pending = p;
            }
            constructor(props: object) {
              Object.assign(this, props);
            }
          }
          Object.assign(Raster.prototype, definition);
          return Raster;
        },
      },
    },
    webMercatorUtils: {
      geographicToWebMercator: (extent: object) => ({
        ...extent,
        spatialReference: { wkid: 3857 },
      }),
    },
    Extent: class {
      constructor(props: object) {
        Object.assign(this, props);
      }
    },
  } as unknown as ArcgisSdk;
}

describe("ArcGIS COG imagery", () => {
  it("exposes a Web Mercator extent before opening the COG", () => {
    let opened = false;
    const raster = createArcgisCogLayer(
      fakeSdk(),
      { ...layer, metadata: { ...layer.metadata, bounds: [1, 2, 3, 4] } },
      {},
      async () => {
        opened = true;
        throw new Error("must remain lazy");
      },
    );
    assert.equal(opened, false);
    assert.deepEqual(raster.fullExtent, {
      xmin: 1,
      ymin: 2,
      xmax: 3,
      ymax: 4,
      spatialReference: { wkid: 3857 },
    });
  });
  it("recognizes browser files and includes raster visualization changes in the plan", () => {
    const local = {
      ...layer,
      source: { type: "raster" },
      metadata: {
        ...layer.metadata,
        externalNativeLayer: true,
        localBytesUrl: "blob:local",
      },
    };
    assert.equal(isArcgisPluginLayer(local), false);
    const plan = compileArcgisLayer(local);
    assert.equal(plan.kind, "cog");
    const changed = compileArcgisLayer({
      ...local,
      metadata: { ...local.metadata, rasterState: { bands: [1] } },
    });
    assert.notDeepEqual(changed, plan);
    assert.throws(() => compileArcgisLayer({ ...local, metadata: {} }), /no readable source/);
  });

  it("loads once, preserves XYZ order and style, and cancels before decoding", async () => {
    let opens = 0;
    let statisticsReads = 0;
    let renders = 0;
    let call: unknown[] = [];
    const tiler = {
      openCog: async () => {
        opens++;
        return {
          boundsLonLat: [-5, -4, 3, 2],
          statistics: async () => {
            statisticsReads++;
            return {
              b4: { min: 4, max: 40 },
              b3: { min: 3, max: 30 },
              b2: { min: 2, max: 20 },
            };
          },
          renderTileRGBA: async (...args: unknown[]) => {
            renders++;
            call = args;
            return null;
          },
        };
      },
    } as unknown as CogTilerModule;
    const cached = cachingCogTiler(tiler);
    const native = createArcgisCogLayer(fakeSdk(), layer, {}, async () => cached);
    const previous = globalThis.document;
    Object.assign(globalThis, {
      document: { createElement: () => ({ width: 0, height: 0 }) },
    });
    try {
      const loading = native as unknown as {
        load(): void;
        pending: Promise<unknown>;
        fullExtent: { spatialReference: { wkid: number } };
      };
      loading.load();
      await loading.pending;
      assert.equal(loading.fullExtent.spatialReference.wkid, 3857);
      await native.fetchTile(5, 7, 9);
      await native.fetchTile(5, 7, 10);
      assert.equal(opens, 1);
      assert.deepEqual(call, [
        5,
        10,
        7,
        {
          bidx: [4, 3, 2],
          gamma: 1.5,
          rescale: [
            [4, 40],
            [3, 30],
            [2, 20],
          ],
        },
      ]);
      const abort = new AbortController();
      abort.abort();
      await assert.rejects(native.fetchTile(5, 7, 9, { signal: abort.signal }), {
        name: "AbortError",
      });
      assert.equal(renders, 2);
      const restyled = createArcgisCogLayer(
        fakeSdk(),
        {
          ...layer,
          metadata: { ...layer.metadata, rasterState: { mode: "rgb", bands: [4, 3, 2], gamma: 2 } },
        },
        {},
        async () => cached,
      );
      await restyled.fetchTile(5, 7, 9);
      assert.equal(opens, 1, "restyling reuses the open source");
      assert.equal(statisticsReads, 1, "restyling reuses source statistics");
      assert.equal((call[3] as { gamma: number }).gamma, 2);
      Object.assign(native, { destroyed: true });
      await assert.rejects(native.fetchTile(5, 7, 9), { name: "AbortError" });
      assert.equal(renders, 3);
    } finally {
      Object.assign(globalThis, { document: previous });
    }
  });
});
