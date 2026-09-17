import assert from "node:assert/strict";
import { it } from "node:test";
import { compileArcgisLayer } from "../packages/map/src/arcgis-layers";
import { createArcgisArchiveLayer } from "../packages/map/src/arcgis-tile-archives";
import type { ArcgisSdk } from "../packages/map/src/arcgis-sdk";
import { geojsonLayer } from "./helpers/layer-fixtures";

it("serves archive bytes to the SDK and isolates/cancels interceptor lifetimes", async () => {
  const plan = compileArcgisLayer(
    geojsonLayer({
      geojson: undefined,
      type: "pmtiles",
      source: {
        url: "https://example.test/archive.pmtiles",
        sourceLayers: ["buildings"],
        type: "vector",
        maxzoom: 5,
      },
    }),
  );
  assert.equal(plan.kind, "archive");
  if (plan.kind !== "archive") return;
  const interceptors: { urls: string; before(options: { url: string }): Promise<ArrayBuffer> }[] =
    [];
  const sdk = {
    config: { request: { interceptors } },
    layers: {
      VectorTileLayer: class {
        constructor(props: object) {
          Object.assign(this, props);
        }
      },
    },
  } as unknown as ArcgisSdk;
  const requests: number[][] = [];
  const a = createArcgisArchiveLayer(sdk, plan, {}, async (z, x, y) => {
    requests.push([z, x, y]);
    return new Uint8Array([1, 2, 3]);
  });
  const b = createArcgisArchiveLayer(sdk, plan, {}, async () => null);
  assert.equal(interceptors.length, 2);
  const first = interceptors[0],
    second = interceptors[1];
  assert.notEqual(first.urls, second.urls);
  assert.deepEqual(
    await first.before({ url: first.urls + "source.json?f=json" }),
    await first.before({ url: first.urls + "source.json" }),
  );
  assert.deepEqual(
    new Uint8Array(await first.before({ url: first.urls + "5/2/3.pbf" })),
    new Uint8Array([1, 2, 3]),
  );
  assert.deepEqual(requests, [[5, 2, 3]]);
  assert.equal((await second.before({ url: second.urls + "5/2/3.pbf" })).byteLength, 0);
  a.dispose();
  a.dispose();
  assert.deepEqual(interceptors, [second]);
  await assert.rejects(first.before({ url: first.urls + "5/2/3.pbf" }), { name: "AbortError" });
  assert.equal(requests.length, 1);
  b.dispose();
  assert.equal(interceptors.length, 0);
});

it("crops the correct parent quadrant when zooming beyond a raster archive", async () => {
  const plan = compileArcgisLayer(
    geojsonLayer({
      geojson: undefined,
      type: "mbtiles",
      source: {
        type: "raster",
        tiles: ["geolibre-mbtiles://tile/{z}/{x}/{y}"],
        maxzoom: 2,
      },
    }),
  );
  if (plan.kind !== "archive") throw new Error("Expected archive plan");
  const originalDocument = globalThis.document;
  const originalBitmap = globalThis.createImageBitmap;
  let draw: unknown[] = [],
    reads: number[][] = [],
    closed = false;
  Object.assign(globalThis, {
    document: {
      createElement: () => ({
        getContext: () => ({
          drawImage: (...args: unknown[]) => {
            draw = args;
          },
        }),
      }),
    },
    createImageBitmap: async () => ({
      width: 256,
      height: 256,
      close: () => {
        closed = true;
      },
    }),
  });
  try {
    const sdk = {
      layers: {
        BaseTileLayer: {
          createSubclass: (definition: object) => {
            class Raster {
              constructor(props: object) {
                Object.assign(this, props);
              }
            }
            Object.assign(Raster.prototype, definition);
            return Raster;
          },
        },
      },
    } as unknown as ArcgisSdk;
    const bridge = createArcgisArchiveLayer(sdk, plan, {}, async (z, x, y) => {
      reads.push([z, x, y]);
      return new Uint8Array([1]);
    });
    const layer = bridge.layer as unknown as {
      fetchTile(z: number, y: number, x: number): Promise<unknown>;
    };
    await layer.fetchTile(4, 7, 5);
    assert.deepEqual(reads, [[2, 1, 1]]);
    assert.deepEqual(draw.slice(1), [64, 192, 64, 64, 0, 0, 256, 256]);
    assert.equal(closed, true);
    bridge.dispose();
    await assert.rejects(layer.fetchTile(4, 7, 5), { name: "AbortError" });
    assert.equal(reads.length, 1);
  } finally {
    Object.assign(globalThis, { document: originalDocument, createImageBitmap: originalBitmap });
  }
});
