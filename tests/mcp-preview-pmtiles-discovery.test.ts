import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { gzipSync } from "fflate";
import { Compression, SharedPromiseCache, TileType } from "pmtiles";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import { buildTileIndex, encodeTile } from "../packages/map/src/geojson-vt-index";
import {
  getRegisteredPMTilesArchive,
  hasPMTilesArchive,
  registerPMTilesSource,
  unregisterPMTilesArchive,
} from "../packages/map/src/pmtiles-archive";
import {
  ConsentPMTilesSource,
  decompressPreviewPMTiles,
  decompressPreviewPMTilesDirectory,
  discoverPreviewPMTilesLayer,
  MAX_PMTILES_BLOCK_BYTES,
  MAX_PMTILES_RANGE_BYTES,
  MAX_PMTILES_SOURCE_LAYERS,
  needsPMTilesDiscovery,
  previewPMTilesStyleLayerIds,
} from "../apps/geolibre-mcp-app/src/pmtiles-preview";
import type { NetworkConsent } from "../apps/geolibre-mcp-app/src/network-consent";

const registered: string[] = [];
afterEach(() => {
  for (const key of registered.splice(0)) unregisterPMTilesArchive(key);
});

function layer(): GeoLibreLayer {
  return {
    id: "url-only",
    name: "Counties",
    type: "pmtiles",
    visible: true,
    opacity: 0.7,
    source: {
      type: "vector",
      url: "https://archives.example.com/counties.pmtiles",
      sourceLayers: [],
    },
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      sourceKind: "pmtiles-url",
      externalNativeLayer: true,
      sourceId: "counties",
      nativeLayerIds: ["saved-placeholder"],
    },
    popup: { click: true },
  };
}

/** A valid single-tile MVT archive, with gzip-compressed directory and JSON metadata. */
function archiveBytes(
  metadata: unknown,
  compressed = true,
  rawDirectory?: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const tile = new Uint8Array(
    encodeTile(
      buildTileIndex(
        {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { NAME: "County" },
              geometry: { type: "Point", coordinates: [0, 0] },
            },
          ],
        },
        { cluster: false, clusterRadius: 50, clusterMaxZoom: 14 },
      ),
      0,
      0,
      0,
    ),
  );
  assert.ok(tile.length < 128);
  const pack = (bytes: Uint8Array): Uint8Array => (compressed ? gzipSync(bytes) : bytes);
  const directory = pack(rawDirectory ?? new Uint8Array([1, 0, 1, tile.length, 1]));
  const json = pack(new TextEncoder().encode(JSON.stringify(metadata)));
  const metadataOffset = 127 + directory.length;
  const tileOffset = metadataOffset + json.length;
  const bytes = new Uint8Array(tileOffset + tile.length);
  bytes.set(new TextEncoder().encode("PMTiles"));
  bytes[7] = 3;
  const header = new DataView(bytes.buffer);
  for (const [offset, value] of [
    [8, 127],
    [16, directory.length],
    [24, metadataOffset],
    [32, json.length],
    [40, tileOffset],
    [48, 0],
    [56, tileOffset],
    [64, tile.length],
    [72, 1],
    [80, 1],
    [88, 1],
  ])
    header.setBigUint64(offset, BigInt(value), true);
  bytes[96] = 1;
  bytes[97] = compressed ? Compression.Gzip : Compression.None;
  bytes[98] = Compression.None;
  bytes[99] = TileType.Mvt;
  for (const [offset, value] of [
    [102, -180],
    [106, -85],
    [110, 180],
    [114, 85],
  ])
    header.setInt32(offset, value * 1e7, true);
  bytes.set(directory, 127);
  bytes.set(json, metadataOffset);
  bytes.set(tile, tileOffset);
  return bytes;
}

function openArchive(bytes: Uint8Array<ArrayBuffer>) {
  const key = `https://archives.example.com/test-${registered.length}.pmtiles`;
  const calls: Array<[number, number]> = [];
  const controller = new AbortController();
  const fetchRange: NetworkConsent["fetchRange"] = async (_url, offset, length, signal) => {
    signal?.throwIfAborted();
    calls.push([offset, length]);
    return { data: bytes.slice(offset, offset + length).buffer, totalSize: bytes.length };
  };
  const source = new ConsentPMTilesSource(key, key, fetchRange, controller.signal);
  registerPMTilesSource(source, {
    decompress: (buffer, compression) =>
      decompressPreviewPMTiles(buffer, compression, controller.signal),
    cache: new SharedPromiseCache(16, undefined, (buffer, compression) =>
      decompressPreviewPMTilesDirectory(buffer, compression, controller.signal),
    ),
  });
  registered.push(key);
  const archive = getRegisteredPMTilesArchive(key)!;
  return { archive, calls, controller, key, source };
}

describe("consent-backed PMTiles source-layer discovery", () => {
  it("reads real header/metadata bytes and preserves the saved project", async () => {
    const original = layer();
    const saved = JSON.stringify(original);
    const opened = openArchive(archiveBytes({ vector_layers: [{ id: "data" }] }));
    assert.equal(needsPMTilesDiscovery(original), true);
    const resolved = await discoverPreviewPMTilesLayer(
      original,
      opened.archive,
      opened.controller.signal,
    );
    assert.deepEqual(resolved.source.sourceLayers, ["data"]);
    assert.deepEqual(resolved.metadata.nativeLayerIds, [
      "counties-data-fill",
      "counties-data-line",
      "counties-data-circle",
    ]);
    assert.deepEqual(previewPMTilesStyleLayerIds(resolved), resolved.metadata.nativeLayerIds);
    assert.equal(resolved.source.encoding, "mvt");
    assert.equal(resolved.opacity, 0.7);
    assert.deepEqual(resolved.popup, original.popup);
    assert.equal(needsPMTilesDiscovery(resolved), false);
    assert.equal(JSON.stringify(original), saved);
    assert.ok(opened.calls.length >= 2);
    assert.equal(opened.archive.source, opened.source);
    assert.ok((await opened.archive.getZxy(0, 0, 0))!.data.byteLength > 0);
  });

  it("keeps MLT encoding and recognizes image formats without reading vector metadata", async () => {
    const opened = openArchive(archiveBytes({ vector_layers: [{ id: "data" }] }));
    const header = await opened.archive.getHeader();
    const mlt = await discoverPreviewPMTilesLayer(
      layer(),
      {
        getHeader: async () => ({ ...header, tileType: TileType.Mlt }),
        getMetadata: () => opened.archive.getMetadata(),
      },
      opened.controller.signal,
    );
    assert.equal(mlt.source.encoding, "mlt");
    const raster = await discoverPreviewPMTilesLayer(
      layer(),
      {
        getHeader: async () => ({ ...header, tileType: TileType.Png }),
        getMetadata: async () => {
          throw new Error("Raster discovery must not fetch vector metadata");
        },
      },
      opened.controller.signal,
    );
    assert.equal(raster.source.type, "raster");
    assert.deepEqual(raster.metadata.nativeLayerIds, ["counties-raster"]);
  });

  it("rejects missing, malformed, excessive, and colliding source-layer names", async () => {
    for (const [metadata, expected] of [
      [null, /does not declare vector source-layer names/],
      [{}, /does not declare vector source-layer names/],
      [{ vector_layers: [] }, /does not declare vector source-layer names/],
      [{ vector_layers: [{ id: 42 }] }, /declares an invalid source-layer name/],
      [{ vector_layers: [{ id: "a/b" }, { id: "a_2Fb" }] }, /source-layer names conflict/],
      [
        {
          vector_layers: Array.from({ length: MAX_PMTILES_SOURCE_LAYERS + 1 }, (_, n) => ({
            id: `layer${n}`,
          })),
        },
        /declares too many source layers/,
      ],
    ] as const) {
      const opened = openArchive(archiveBytes(metadata));
      await assert.rejects(
        discoverPreviewPMTilesLayer(layer(), opened.archive, opened.controller.signal),
        expected,
      );
    }
  });

  it("refuses excessive metadata before requesting its byte range", async () => {
    const bytes = archiveBytes(
      { vector_layers: [{ id: "data" }], padding: "x".repeat(1024 * 1024) },
      false,
    );
    const opened = openArchive(bytes);
    await assert.rejects(
      discoverPreviewPMTilesLayer(layer(), opened.archive, opened.controller.signal),
      /metadata is too large/,
    );
    assert.deepEqual(opened.calls, [[0, 16384]]);
  });

  it("rejects unsupported tile compression before reading metadata", async () => {
    for (const compression of [Compression.Brotli, Compression.Zstd]) {
      const bytes = archiveBytes({ vector_layers: [{ id: "data" }] });
      bytes[98] = compression;
      const opened = openArchive(bytes);
      await assert.rejects(
        discoverPreviewPMTilesLayer(layer(), opened.archive, opened.controller.signal),
        /compression is not supported/,
      );
      assert.deepEqual(opened.calls, [[0, 16384]]);
    }
  });

  it("rejects unknown tile formats without treating them as raster imagery", async () => {
    const bytes = archiveBytes({});
    bytes[99] = TileType.Unknown;
    const opened = openArchive(bytes);
    await assert.rejects(
      discoverPreviewPMTilesLayer(layer(), opened.archive, opened.controller.signal),
      /tile format/,
    );
  });

  it("bounds directory expansion before the library parses entry arrays", async () => {
    for (const directory of [new Uint8Array([255, 255, 255, 127]), new Uint8Array([1, 0])]) {
      const opened = openArchive(
        archiveBytes({ vector_layers: [{ id: "data" }] }, true, directory),
      );
      await assert.rejects(opened.archive.getHeader(), /directory/);
    }
  });

  it("never creates a direct remote source for an unregistered archive", () => {
    const opened = openArchive(archiveBytes({ vector_layers: [{ id: "data" }] }));
    unregisterPMTilesArchive(opened.key);
    assert.equal(getRegisteredPMTilesArchive(opened.key), undefined);
    assert.equal(hasPMTilesArchive(opened.key), false);
    assert.equal(
      getRegisteredPMTilesArchive("https://unknown.example.com/archive.pmtiles"),
      undefined,
    );
    assert.equal(hasPMTilesArchive("https://unknown.example.com/archive.pmtiles"), false);
    assert.deepEqual(opened.calls, []);
  });

  it("aborts header reads with the preview even when the library supplies no signal", async () => {
    const controller = new AbortController();
    let active: AbortSignal | undefined;
    const fetchRange: NetworkConsent["fetchRange"] = (_url, _offset, _length, signal) =>
      new Promise((_resolve, reject) => {
        active = signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const source = new ConsentPMTilesSource(
      "cancelled-header",
      "https://example.com/archive.pmtiles",
      fetchRange,
      controller.signal,
    );
    registerPMTilesSource(source, { decompress: decompressPreviewPMTiles });
    registered.push(source.getKey());
    const pending = getRegisteredPMTilesArchive(source.getKey())!.getHeader();
    controller.abort(new DOMException("Preview closed", "AbortError"));
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(active?.aborted, true);
  });

  it("combines the preview lifecycle with tile cancellation and refuses excessive reads", async () => {
    const lifecycle = new AbortController();
    const tile = new AbortController();
    let active: AbortSignal | undefined;
    const reads: number[] = [];
    const fetchRange: NetworkConsent["fetchRange"] = async (_url, _offset, length, signal) => {
      active = signal;
      reads.push(length);
      return { data: new ArrayBuffer(length) };
    };
    const source = new ConsentPMTilesSource(
      "tile",
      "https://example.com/archive.pmtiles",
      fetchRange,
      lifecycle.signal,
    );
    await source.getBytes(0, 4, tile.signal);
    lifecycle.abort();
    assert.equal(active?.aborted, true);
    assert.equal(tile.signal.aborted, false);
    await assert.rejects(source.getBytes(0, 4), { name: "AbortError" });
    const fresh = new ConsentPMTilesSource(
      "large",
      "https://example.com/archive.pmtiles",
      fetchRange,
    );
    await fresh.getBytes(0, MAX_PMTILES_RANGE_BYTES);
    await assert.rejects(fresh.getBytes(0, MAX_PMTILES_RANGE_BYTES + 1), /too large/);
    assert.deepEqual(reads, [4, MAX_PMTILES_RANGE_BYTES]);
  });
});

describe("bounded PMTiles preview decompression", () => {
  it("stops gzip expansion and rejects unsupported compression", async () => {
    const bomb = gzipSync(new Uint8Array(MAX_PMTILES_BLOCK_BYTES + 1));
    await assert.rejects(
      decompressPreviewPMTiles(new Uint8Array(bomb).buffer, Compression.Gzip),
      /too large/,
    );
    await assert.rejects(
      decompressPreviewPMTiles(new ArrayBuffer(0), Compression.Brotli),
      /compression/,
    );
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      decompressPreviewPMTiles(new ArrayBuffer(0), Compression.None, aborted.signal),
      { name: "AbortError" },
    );
    const closing = new AbortController();
    const inFlight = decompressPreviewPMTiles(
      new Uint8Array(bomb).buffer,
      Compression.Gzip,
      closing.signal,
    );
    closing.abort(new DOMException("Preview replaced", "AbortError"));
    await assert.rejects(inFlight, { name: "AbortError" });
  });
});
