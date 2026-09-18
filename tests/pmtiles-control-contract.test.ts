import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
// Imported before any global is swapped: the package pulls in a wasm loader that reads `fetch`.
import { PMTilesLayerControl } from "maplibre-gl-components";
import {
  pmtilesControlLayerId,
  pmtilesLayerKinds,
  pmtilesVectorLayerId,
} from "../packages/map/src/pmtiles-layer";
import { useAppStore } from "../packages/core/src/store";
import {
  __getPMTilesControlForTests,
  createPMTilesLayerAddHandler,
  __resetPMTilesControlForTests,
  addPMTilesLayerFromUrl,
} from "../packages/plugins/src/plugins/maplibre-components";

/**
 * `maplibre-gl-components`' PMTiles control names its MapLibre layers `${sourceId}-${name}-${kind}`
 * from the **raw** source-layer name, and reports ids only for the source layers the panel has
 * ticked while still reporting the whole archive in `sourceLayers`. Neither is exported, and
 * GeoLibre reads both: `layer-sync` matches those ids so it takes the layers already on the map
 * rather than adding its own on top, and the bridge reads the selection so the store holds what the
 * user ticked. Drift in either is silent, so this drives the real control against a real archive.
 */

const V3_HEADER_BYTES = 127;
// Byte offsets into the v3 header, from the PMTiles spec.
const ROOT_OFFSET = 8;
const ROOT_LENGTH = 16;
const METADATA_OFFSET = 24;
const METADATA_LENGTH = 32;
const LEAF_OFFSET = 40;
const LEAF_LENGTH = 48;
const TILE_DATA_OFFSET = 56;
const INTERNAL_COMPRESSION = 97;
const TILE_TYPE = 99;

/**
 * A real PMTiles archive whose metadata names `sourceLayers`, built by rewriting the committed
 * raster fixture's metadata section and marking it MVT. `_addLayer` reads the header and the
 * metadata and never asks for a tile, so no tiles are needed — but the reader it uses is the real
 * one, and it rejects anything that is not a valid v3 archive.
 */
function vectorArchive(sourceLayers: string[]): Uint8Array {
  const raster = new Uint8Array(
    readFileSync(fileURLToPath(new URL("./fixtures/mini.pmtiles", import.meta.url))),
  );
  const view = new DataView(raster.buffer, raster.byteOffset, raster.byteLength);
  const u64 = (at: number) => Number(view.getBigUint64(at, true));
  // The rebuild below moves the metadata section and slides everything after it, which holds only
  // while the tile data starts where the leaf directories end. `gen-pmtiles-fixture.mjs` emits that
  // today; a regenerated fixture that does not is rejected here rather than silently corrupted,
  // since no tile is ever read back.
  assert.equal(new TextDecoder().decode(raster.subarray(0, 7)), "PMTiles", "a v3 archive");
  assert.equal(raster[7], 3, "spec version 3");
  assert.equal(
    u64(TILE_DATA_OFFSET),
    u64(LEAF_OFFSET) + u64(LEAF_LENGTH),
    "no gap before the tiles",
  );
  const gzipped = raster[INTERNAL_COMPRESSION] === 2;
  assert.ok(
    raster[INTERNAL_COMPRESSION] === 1 || gzipped,
    "the metadata written below is plain or gzip, matching what the header declares",
  );

  const root = raster.subarray(u64(ROOT_OFFSET), u64(ROOT_OFFSET) + u64(ROOT_LENGTH));
  const json = JSON.stringify({ vector_layers: sourceLayers.map((id) => ({ id })) });
  const metadata = gzipped ? new Uint8Array(gzipSync(json)) : new TextEncoder().encode(json);
  // Everything from the leaf directories on is copied verbatim; only its offset moves.
  const tail = raster.subarray(u64(LEAF_OFFSET));

  // `slice`, not `subarray`: this copies, so writing through `header.buffer` cannot reach the
  // fixture's bytes.
  const header = raster.slice(0, V3_HEADER_BYTES);
  const out = new DataView(header.buffer);
  const rootAt = V3_HEADER_BYTES;
  const metadataAt = rootAt + root.length;
  const leafAt = metadataAt + metadata.length;
  out.setBigUint64(ROOT_OFFSET, BigInt(rootAt), true);
  out.setBigUint64(METADATA_OFFSET, BigInt(metadataAt), true);
  out.setBigUint64(METADATA_LENGTH, BigInt(metadata.length), true);
  out.setBigUint64(LEAF_OFFSET, BigInt(leafAt), true);
  out.setBigUint64(TILE_DATA_OFFSET, BigInt(leafAt + u64(LEAF_LENGTH)), true);
  header[TILE_TYPE] = 1; // mvt, so the control takes its vector branch

  const archive = new Uint8Array(leafAt + tail.length);
  archive.set(header, 0);
  archive.set(root, rootAt);
  archive.set(metadata, metadataAt);
  archive.set(tail, leafAt);
  return archive;
}

/**
 * A `fetch` serving `bytes` with the Range semantics the PMTiles reader needs. Anything that is not
 * the archive goes to the real one — the components package initialises a wasm module through
 * `fetch` when it loads, and would otherwise be handed PMTiles bytes.
 */
function serve(bytes: Uint8Array): typeof fetch {
  const real = globalThis.fetch;
  return (async (url, init) => {
    if (!new URL(String(url), "https://x.test").pathname.endsWith(".pmtiles")) {
      // The components package initialises a wasm module through `fetch` when it loads, from an
      // inlined `data:` URL. Anything else would be a real request: refused rather than passed on,
      // so a bump that starts fetching from a CDN fails here instead of quietly needing a network.
      assert.match(String(url), /^(data|blob):/, "the contract test must not reach the network");
      return real(url as never, init as never);
    }
    const range = /bytes=(\d+)-(\d+)/.exec(String(new Headers(init?.headers).get("range") ?? ""));
    if (!range) {
      return new Response(bytes.slice() as unknown as BodyInit, {
        status: 200,
        headers: { "content-length": String(bytes.length) },
      });
    }
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), bytes.length - 1);
    return new Response(bytes.slice(start, end + 1) as unknown as BodyInit, {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` },
    });
  }) as typeof fetch;
}

/** Records what the control drew, and answers anything else it asks of a map. */
function recordingMap(document: Document): { added: string[]; map: unknown } {
  const added: string[] = [];
  const map = new Proxy(
    {
      addLayer: (layer: { id: string }) => added.push(layer.id),
      getLayer: () => undefined,
      getSource: () => undefined,
      getCanvasContainer: () => document.createElement("div"),
    } as Record<string, unknown>,
    {
      get: (target, key) => target[key as string] ?? (() => undefined),
    },
  );
  return { added, map };
}

async function addArchive(sourceLayers: string[], ticked?: string[]) {
  const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
  const globals = globalThis as Record<string, unknown>;
  const restore = { document: globals.document, window: globals.window, fetch: globals.fetch };
  globals.document = document;
  // `_ensureProtocol` prefers a `maplibregl` on `window`, which spares this a real map build.
  globals.window = Object.assign(window, { maplibregl: { addProtocol: () => {} } });
  globals.fetch = serve(vectorArchive(sourceLayers));
  try {
    const control = new PMTilesLayerControl({}) as unknown as {
      onAdd: (map: unknown) => unknown;
      addLayer: (url: string) => Promise<void>;
      getState: () => {
        layers: { id: string; sourceLayers: string[]; layerIds: string[] }[];
        error: string | null;
      };
      _state: { selectedSourceLayers: string[] };
    };
    const { added, map } = recordingMap(document as unknown as Document);
    control.onAdd(map);
    // The panel's checkboxes write here. Reached directly rather than through a rendered click, so
    // that a rename of the field fails this test rather than quietly leaving nothing ticked.
    if (ticked) control._state.selectedSourceLayers = ticked;
    await control.addLayer(`https://example.test/${sourceLayers.join("-")}.pmtiles`);
    const state = control.getState();
    // `_addLayer` swallows every failure into `state.error`, so without this a broken fixture, a
    // refused fetch or a changed reader reads as "the id scheme moved" via a `TypeError` below.
    assert.equal(state.error, null, "the control loaded the archive");
    return { info: state.layers[0]!, added };
  } finally {
    globals.document = restore.document;
    globals.window = restore.window;
    globals.fetch = restore.fetch;
  }
}

describe("the id scheme the PMTiles control reports", () => {
  it("names its layers after the raw source layer, not the encoded one", async () => {
    const name = "zones residentielles";
    const { info, added } = await addArchive(["roads", name]);

    for (const kind of pmtilesLayerKinds) {
      assert.ok(
        info.layerIds.includes(pmtilesControlLayerId(info.id, name, kind)),
        `the control still names ${kind} ids \`\${sourceId}-\${rawName}-\${kind}\``,
      );
      assert.ok(
        !info.layerIds.includes(pmtilesVectorLayerId(info.id, name, kind)),
        "and still does not encode the name, which is why both schemes are matched",
      );
    }
    assert.deepEqual(added, info.layerIds, "and it draws exactly the ids it reports");
  });

  // `pmtilesLayerOptions` reads the same split: every source layer in `sourceLayers`, and ids for
  // the ticked ones alone.
  it("reports the whole archive but names ids only for the ticked source layers", async () => {
    const { info } = await addArchive(["roads", "water"], ["roads"]);

    assert.deepEqual(info.sourceLayers, ["roads", "water"], "the whole archive is reported");
    assert.deepEqual(
      info.layerIds,
      pmtilesLayerKinds.map((kind) => pmtilesControlLayerId(info.id, "roads", kind)),
      "but only the ticked source layer is named",
    );
  });
});

/**
 * A panel add, end to end: the real control's own `layeradd` through the real handler into the
 * store. What the user ticked reaches the store as a field of the emitted state, so a rename or a
 * reset of that field fails here rather than silently putting the whole archive in.
 */
describe("adding an archive through the panel with a source layer unticked", () => {
  it("puts only the ticked source layer in the store", async () => {
    const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
    const globals = globalThis as Record<string, unknown>;
    const restore = { document: globals.document, window: globals.window, fetch: globals.fetch };
    globals.document = document;
    globals.window = Object.assign(window, { maplibregl: { addProtocol: () => {} } });
    globals.fetch = serve(vectorArchive(["roads", "water"]));
    const store = useAppStore.getState();
    for (const layer of [...store.layers]) store.removeLayer(layer.id);
    for (const group of [...store.layerGroups]) store.removeLayerGroup(group.id);
    __resetPMTilesControlForTests();
    try {
      const control = new PMTilesLayerControl({}) as unknown as {
        onAdd: (map: unknown) => unknown;
        on: (event: string, handler: unknown) => unknown;
        addLayer: (url: string) => Promise<void>;
        _state: { selectedSourceLayers: string[] };
      };
      const { map } = recordingMap(document as unknown as Document);
      control.onAdd(map);
      control.on("layeradd", createPMTilesLayerAddHandler());
      // The panel's checkboxes write here; reached directly because only they do.
      control._state.selectedSourceLayers = ["water"];

      await control.addLayer("https://example.test/panel.pmtiles");

      const layers = useAppStore.getState().layers;
      assert.deepEqual(
        layers.map((layer) => layer.source.sourceLayers),
        [["water"]],
        "`roads` was unticked, so it is not the project's",
      );
      // `_emit` spreads the control's whole state, so a write to a renamed field would still reach
      // the handler and this would pass on `sourceLayers` alone. The ids are what the control
      // actually drew: under a rename it draws both source layers and reports six of them.
      assert.deepEqual(layers[0]!.metadata.nativeLayerIds, [
        "pmtiles-source-0-water-fill",
        "pmtiles-source-0-water-line",
        "pmtiles-source-0-water-circle",
      ]);
    } finally {
      globals.document = restore.document;
      globals.window = restore.window;
      globals.fetch = restore.fetch;
      __resetPMTilesControlForTests();
    }
  });
});

/**
 * The URL add path, end to end against the real control: Add Data, Source Cooperative and Hugging
 * Face all reach `addPMTilesLayerFromUrl`, and none of them shows a tick UI.
 */
describe("adding an archive by URL while the panel holds a stale tick", () => {
  it("rejects malformed and non-HTTP programmatic archive URLs", async () => {
    const app = {
      translate: (_key: string, fallback: string) => fallback,
    } as never;
    await assert.rejects(addPMTilesLayerFromUrl(app, "not a URL"), /valid HTTP\(S\)/);
    await assert.rejects(
      addPMTilesLayerFromUrl(app, "file:///tmp/archive.pmtiles"),
      /valid HTTP\(S\)/,
    );
  });

  it("puts the whole archive in the store, not just what was ticked for another one", async () => {
    const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
    const globals = globalThis as Record<string, unknown>;
    const restore = {
      document: globals.document,
      window: globals.window,
      fetch: globals.fetch,
      requestAnimationFrame: globals.requestAnimationFrame,
    };
    globals.document = document;
    globals.window = Object.assign(window, { maplibregl: { addProtocol: () => {} } });
    globals.fetch = serve(vectorArchive(["roads", "buildings"]));
    globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
    const store = useAppStore.getState();
    for (const layer of [...store.layers]) store.removeLayer(layer.id);
    __resetPMTilesControlForTests();
    try {
      const { map } = recordingMap(document as unknown as Document);
      const app = {
        addMapControl: (control: { onAdd: (map: unknown) => unknown }) => {
          control.onAdd(map);
          return true;
        },
      } as never;

      await addPMTilesLayerFromUrl(app, "https://example.test/by-url.pmtiles");
      // What the panel would hold after the user unticked a source layer of some other archive.
      // Reached directly because only the panel's own checkboxes write it.
      (
        __getPMTilesControlForTests() as { _state: { selectedSourceLayers: string[] } }
      )._state.selectedSourceLayers = ["roads"];
      // A query string, the shape a presigned URL takes: `programmaticPMTilesAdds` is keyed on this
      // exact string, so a control that trimmed or rewrote it before echoing it back would let the
      // stale tick above through and strand `buildings` outside the store.
      await addPMTilesLayerFromUrl(app, "https://example.test/by-url-2.pmtiles?sig=abc%2F123");

      assert.deepEqual(
        useAppStore
          .getState()
          .layers.filter((layer) => layer.metadata.sourceId === "pmtiles-source-1")
          .map((layer) => layer.name),
        ["roads", "buildings"],
        "`buildings` is in the project even though the stale tick kept it off the map",
      );
    } finally {
      globals.document = restore.document;
      globals.window = restore.window;
      globals.fetch = restore.fetch;
      globals.requestAnimationFrame = restore.requestAnimationFrame;
      __resetPMTilesControlForTests();
    }
  });
});
