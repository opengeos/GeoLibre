import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import { config } from "maplibre-gl";
import Pbf from "pbf";
import { featureCollectionToGeoArrow, type GeoArrowBatch } from "@geolibre/core";
import {
  ensureGeoJsonVtProtocol,
  GEOJSONVT_PROTOCOL,
  registerGeoJsonVtSource,
  unregisterGeoJsonVtSource,
  TileWorkerHost,
} from "../packages/map/src/geojson-vt-protocol";
import {
  buildTileIndex,
  buildTileIndexFromBinary,
  encodeTile,
  createTileIndexSession,
  TILE_WORKER_CHUNK_FEATURES,
  type TileWorkerRequest,
} from "../packages/map/src/geojson-vt-index";

interface DecodedTile {
  layers: Record<
    string,
    { length: number; feature(index: number): { properties: Record<string, unknown> } }
  >;
}

const { VectorTile } = createRequire(import.meta.url)("@mapbox/vector-tile") as {
  VectorTile: new (pbf: Pbf) => DecodedTile;
};

type ProtocolHandler = (
  params: { url: string },
  abort: AbortController,
) => Promise<{ data: ArrayBuffer }>;

function protocolHandler(): ProtocolHandler {
  ensureGeoJsonVtProtocol();
  const handler = (config as { REGISTERED_PROTOCOLS?: Record<string, ProtocolHandler> })
    .REGISTERED_PROTOCOLS?.[GEOJSONVT_PROTOCOL];
  assert.ok(handler, "geojson-vt protocol should be registered");
  return handler;
}

function pointGridBatch(count: number): GeoArrowBatch {
  const coordinates = new Float64Array(count * 2);
  const properties: Record<string, unknown>[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const lng = (i % 100) * 0.001;
    const lat = Math.floor(i / 100) * 0.001;
    coordinates[i * 2] = lng;
    coordinates[i * 2 + 1] = lat;
    properties[i] = { idx: i, label: `Point_${i}` };
  }
  return {
    geometryType: "Point",
    coordinates,
    coordDimensions: 2,
    featureCount: count,
    properties,
  };
}

describe("GeoArrow binary vector tiling integration", () => {
  it("chunks binary properties and IDs while preserving tiles and cancelling superseded builds", async () => {
    const messages: TileWorkerRequest[] = [];
    let response: ArrayBuffer | undefined;
    const session = createTileIndexSession(
      (message) => {
        response = message.data;
      },
      (run) => run(),
    );
    const worker = {
      addEventListener() {},
      postMessage(message: TileWorkerRequest) {
        messages.push(message);
        session(message);
      },
      terminate() {},
    } as unknown as Worker;
    const host = new TileWorkerHost(worker);
    const options = { cluster: false, clusterRadius: 50, clusterMaxZoom: 14 };
    const batch = pointGridBatch(TILE_WORKER_CHUNK_FEATURES * 2 + 1);
    const withIds = {
      ...batch,
      featureIds: Array.from({ length: batch.featureCount }, (_, i) => i),
    };
    await host.buildBinary("chunked", 1, withIds, options, () => true);
    assert.equal(messages[0].type, "binary-begin");
    if (messages[0].type === "binary-begin") {
      assert.equal(messages[0].batch.properties, undefined);
      assert.equal(messages[0].batch.featureIds, undefined);
    }
    const chunks = messages.filter((message) => message.type === "binary-properties");
    assert.deepEqual(
      chunks.map((chunk) => chunk.properties?.length),
      [2000, 2000, 1],
    );
    assert.deepEqual(
      chunks.map((chunk) => chunk.featureIds?.length),
      [2000, 2000, 1],
    );
    assert.equal(messages.at(-1)?.type, "build");
    session({ type: "tile", requestId: 1, layerId: "chunked", z: 0, x: 0, y: 0 });
    assert.deepEqual(response, encodeTile(buildTileIndexFromBinary(withIds, options), 0, 0, 0));
    assert.equal(batch.coordinates.length, batch.featureCount * 2, "store buffers remain attached");

    messages.length = 0;
    let checks = 0;
    await host.buildBinary("cancelled", 2, withIds, options, () => ++checks === 1);
    assert.deepEqual(
      messages.map((message) => message.type),
      ["binary-begin", "binary-properties"],
    );
  });

  it("builds tile index from GeoArrowBatch with identical tiles to GeoJSONVT", () => {
    const batch = pointGridBatch(500);
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: Array.from({ length: 500 }, (_, i) => ({
        type: "Feature",
        properties: { idx: i, label: `Point_${i}` },
        geometry: {
          type: "Point",
          coordinates: [(i % 100) * 0.001, Math.floor(i / 100) * 0.001],
        },
      })),
    };

    const options = { cluster: false, clusterRadius: 50, clusterMaxZoom: 16 };
    const binaryIndex = buildTileIndexFromBinary(batch, options);
    const standardIndex = buildTileIndex(fc, options);

    const binaryTileBytes = encodeTile(binaryIndex, 0, 0, 0);
    const standardTileBytes = encodeTile(standardIndex, 0, 0, 0);

    assert.ok(binaryTileBytes.byteLength > 0, "binary tile should not be empty");
    assert.equal(
      binaryTileBytes.byteLength,
      standardTileBytes.byteLength,
      "encoded binary tile size should match standard GeoJSONVT",
    );

    const decoded = new VectorTile(new Pbf(binaryTileBytes));
    assert.ok(decoded.layers.data, "layer 'data' should exist in encoded MVT tile");
    assert.equal(decoded.layers.data.length, 500, "all 500 points should be present in tile");
  });

  it("serves binary GeoArrow vector tiles via geolibre-gjvt protocol", async () => {
    const handler = protocolHandler();
    const layerId = "geoarrow-test-layer-1";
    const batch = pointGridBatch(100);

    const rebuilt = registerGeoJsonVtSource(layerId, batch, {
      cluster: false,
      clusterRadius: 50,
      clusterMaxZoom: 16,
    });
    assert.equal(rebuilt, true);

    const abort = new AbortController();
    const result = await handler({ url: `geolibre-gjvt://${layerId}/0/0/0` }, abort);
    assert.ok(result.data.byteLength > 0);

    const tile = new VectorTile(new Pbf(result.data));
    assert.equal(tile.layers.data.length, 100);

    // Unchanged batch reference reuses index
    const rebuiltSame = registerGeoJsonVtSource(layerId, batch, {
      cluster: false,
      clusterRadius: 50,
      clusterMaxZoom: 16,
    });
    assert.equal(rebuiltSame, false);

    unregisterGeoJsonVtSource(layerId);
    const afterDrop = await handler({ url: `geolibre-gjvt://${layerId}/0/0/0` }, abort);
    assert.equal(afterDrop.data.byteLength, 0, "dropped layer serves empty tile");
  });

  it("handles polygon GeoArrow batch with inner holes", () => {
    // 1 polygon with 2 rings
    const coordinates = new Float64Array([
      0, 0, 10, 0, 10, 10, 0, 10, 0, 0, 2, 2, 4, 2, 4, 4, 2, 4, 2, 2,
    ]);
    const ringOffsets = new Int32Array([0, 5, 10]);
    const geomOffsets = new Int32Array([0, 2]);

    const batch: GeoArrowBatch = {
      geometryType: "Polygon",
      coordinates,
      coordDimensions: 2,
      geomOffsets,
      ringOffsets,
      featureCount: 1,
      properties: [{ name: "PolygonHole" }],
    };

    const options = { cluster: false, clusterRadius: 50, clusterMaxZoom: 16 };
    const index = buildTileIndexFromBinary(batch, options);
    const tileBytes = encodeTile(index, 0, 0, 0);

    assert.ok(tileBytes.byteLength > 0);
    const decoded = new VectorTile(new Pbf(tileBytes));
    assert.equal(decoded.layers.data.length, 1);
    assert.equal(decoded.layers.data.feature(0).properties.name, "PolygonHole");
  });

  it("handles empty and zero-feature GeoArrowBatch without errors", () => {
    const emptyBatch: GeoArrowBatch = {
      geometryType: "Point",
      coordinates: new Float64Array(0),
      coordDimensions: 2,
      featureCount: 0,
    };
    const options = { cluster: false, clusterRadius: 50, clusterMaxZoom: 16 };
    const index = buildTileIndexFromBinary(emptyBatch, options);
    const tileBytes = encodeTile(index, 0, 0, 0);
    assert.equal(tileBytes.byteLength, 0);
  });

  it("executes binary tile session in Worker simulation", async () => {
    const postedMessages: unknown[] = [];
    const session = createTileIndexSession(
      (msg) => postedMessages.push(msg),
      (cb) => setTimeout(cb, 0),
    );

    const batch = pointGridBatch(10);
    const options = { cluster: false, clusterRadius: 50, clusterMaxZoom: 16 };

    // Send binary message
    session({
      type: "binary",
      layerId: "worker-binary-layer",
      generation: 1,
      options,
      batch,
    });

    // Request tile
    session({
      type: "tile",
      requestId: 99,
      layerId: "worker-binary-layer",
      z: 0,
      x: 0,
      y: 0,
    });

    await new Promise((r) => setTimeout(r, 20));

    assert.equal(postedMessages.length, 1);
    const response = postedMessages[0] as { type: string; requestId: number; data: ArrayBuffer };
    assert.equal(response.type, "tile");
    assert.equal(response.requestId, 99);
    assert.ok(response.data.byteLength > 0);

    const decoded = new VectorTile(new Pbf(response.data));
    assert.equal(decoded.layers.data.length, 10);
  });
});
