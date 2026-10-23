import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import { isPlaceholderLayer } from "../packages/map/src/placeholders";
import { addPMTilesAsset } from "../packages/plugins/src/plugins/stac-layers";

// The committed z0-4 archive tests/pmtiles-extract.test.ts reads.
const bytes = new Uint8Array(
  readFileSync(fileURLToPath(new URL("./fixtures/mini.pmtiles", import.meta.url))),
);
const HREF = "https://example.org/warehouse/mini.pmtiles";

/** Serves the fixture over Range requests, so the reader behaves as it does against a real host. */
function rangeServer(served: Uint8Array = bytes): typeof fetch {
  return (async (_url, init) => {
    const range = /bytes=(\d+)-(\d+)/.exec(String(new Headers(init?.headers).get("range") ?? ""));
    assert.ok(range, "reading an archive must send a Range header");
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), served.length - 1);
    return new Response(served.slice(start, end + 1) as unknown as BodyInit, {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${served.length}` },
    });
  }) as typeof fetch;
}

describe("adding a STAC item's PMTiles asset", () => {
  const realFetch = globalThis.fetch;

  before(() => {
    globalThis.fetch = rangeServer();
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    useAppStore.setState({ layers: [] });
  });

  it("reads the archive and adds a layer that renders, named for the item", async () => {
    const id = await addPMTilesAsset(HREF, "item-1 — PMTiles vector tiles");

    const layer = useAppStore.getState().layers.find((entry) => entry.id === id);
    assert.ok(layer, "the layer reached the store");
    assert.equal(layer.name, "item-1 — PMTiles vector tiles");
    assert.equal(layer.type, "pmtiles");
    assert.equal(isPlaceholderLayer(layer), false);
    assert.equal(layer.source.url, `pmtiles://${HREF}`);
    // The fixture holds PNG tiles, so it lands on the raster path.
    assert.equal(layer.metadata.tileType, "raster");
    assert.deepEqual(layer.metadata.nativeLayerIds, [`${id}-raster`]);
  });

  it("adds nothing for a vector archive with no layer metadata, and says so to its caller", async () => {
    // Byte 99 is the tile type: 1 is MVT, and the fixture's metadata carries no vector_layers.
    const asVector = bytes.slice();
    asVector[99] = 1;
    globalThis.fetch = rangeServer(asVector);

    assert.equal(await addPMTilesAsset(HREF, "item-1 — PMTiles vector tiles"), null);
    assert.deepEqual(useAppStore.getState().layers, []);
    globalThis.fetch = rangeServer(bytes);
  });

  it("hands the caller's signal to the read, not a fresh one of the reader's", async () => {
    // The reader makes its own controller when given none, so the question is whose signal
    // arrives: an already-aborted one only turns up if the caller's was carried down.
    const arrived: boolean[] = [];
    globalThis.fetch = (async (_url, init) => {
      arrived.push(init?.signal?.aborted ?? false);
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as typeof fetch;

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(addPMTilesAsset(HREF, "item-1 — PMTiles vector tiles", controller.signal));
    assert.deepEqual(arrived, [true]);
    assert.deepEqual(useAppStore.getState().layers, []);
    globalThis.fetch = rangeServer();
  });
});
