import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { config } from "maplibre-gl";
import {
  disposeGeoJsonVtWorker,
  ensureGeoJsonVtProtocol,
  GEOJSONVT_PROTOCOL,
  registerGeoJsonVtSource,
  setGeoJsonVtWorkerFactory,
  unregisterGeoJsonVtSource,
} from "../packages/map/src/geojson-vt-protocol";
import {
  TILE_WORKER_CHUNK_FEATURES,
  createTileIndexSession,
  type GeoJsonVtSourceOptions,
  type TileWorkerMessage,
  type TileWorkerRequest,
} from "../packages/map/src/geojson-vt-index";

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

let toWorker: TileWorkerRequest[] = [];
let spawned = 0;
let terminated = 0;
/** When set, a new fake worker fails to load (an `error` instead of running). */
let failToLoad = false;

/**
 * An in-process stand-in for geojson-vt.worker.ts: the same session, with every
 * message structured-cloned (tile buffers transferred) and delivered on a later
 * task in both directions, as across a real worker boundary.
 */
class FakeWorker {
  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  private terminated = false;
  private handle = createTileIndexSession(
    (message: TileWorkerMessage, transfer: Transferable[]) => {
      const data = structuredClone(message, { transfer });
      setImmediate(() => this.emit("message", data));
    },
    (callback) => setImmediate(callback),
  );

  constructor() {
    spawned += 1;
    if (failToLoad) setImmediate(() => this.emit("error", undefined));
  }

  private emit(type: string, data: unknown) {
    if (this.terminated) return;
    for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(request: TileWorkerRequest) {
    const data = structuredClone(request);
    toWorker.push(data);
    setImmediate(() => {
      if (!this.terminated && !failToLoad) this.handle(data);
    });
  }

  terminate() {
    this.terminated = true;
    terminated += 1;
  }
}

function installFakeWorker() {
  setGeoJsonVtWorkerFactory(() => new FakeWorker() as unknown as Worker);
}

function removeWorker() {
  setGeoJsonVtWorkerFactory(null);
}

const registered = new Set<string>();

function register(
  layerId: string,
  geojson: GeoJSON.FeatureCollection,
  options: GeoJsonVtSourceOptions = PLAIN,
): boolean {
  registered.add(layerId);
  return registerGeoJsonVtSource(layerId, geojson, options);
}

afterEach(() => {
  for (const layerId of registered) unregisterGeoJsonVtSource(layerId);
  registered.clear();
  disposeGeoJsonVtWorker();
  removeWorker();
  toWorker = [];
  spawned = 0;
  terminated = 0;
  failToLoad = false;
});

const PLAIN: GeoJsonVtSourceOptions = { cluster: false, clusterRadius: 50, clusterMaxZoom: 14 };
const CLUSTERED: GeoJsonVtSourceOptions = { cluster: true, clusterRadius: 50, clusterMaxZoom: 14 };

/** Deterministic pseudo-random points with mixed property types. */
function points(count: number, seed = 1): GeoJSON.FeatureCollection {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const features: GeoJSON.Feature[] = [];
  for (let i = 0; i < count; i++) {
    features.push({
      type: "Feature",
      properties: { id: i, val: random(), cat: ["a", "b", "c"][i % 3], flag: i % 2 === 0 },
      geometry: { type: "Point", coordinates: [-10 + random() * 20, -10 + random() * 20] },
    });
  }
  return { type: "FeatureCollection", features };
}

function squares(count: number): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let i = 0; i < count; i++) {
    const x = (i % 50) * 0.3 - 7;
    const y = Math.floor(i / 50) * 0.3 - 7;
    features.push({
      type: "Feature",
      properties: { i, name: `sq${i}`, nested: { k: i } },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [x, y],
            [x + 0.2, y],
            [x + 0.2, y + 0.2],
            [x, y + 0.2],
            [x, y],
          ],
        ],
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Tiles from z0 down to z6 that cover the [-10, 10] test area. */
const TILES: [number, number, number][] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 1],
  [2, 1, 1],
  [2, 2, 2],
  [3, 3, 3],
  [3, 4, 4],
  [4, 7, 7],
  [4, 8, 8],
  [5, 15, 15],
  [5, 16, 16],
  [6, 31, 31],
  [6, 32, 32],
  // Off the data: empty.
  [6, 0, 0],
];

async function tile(layerId: string, [z, x, y]: [number, number, number]): Promise<Uint8Array> {
  const { data } = await protocolHandler()(
    { url: `${GEOJSONVT_PROTOCOL}://${encodeURIComponent(layerId)}/${z}/${x}/${y}` },
    new AbortController(),
  );
  return new Uint8Array(data);
}

/** Every tile in TILES for a layer, tiled inline on this thread. */
async function inlineTiles(
  geojson: GeoJSON.FeatureCollection,
  options: GeoJsonVtSourceOptions,
): Promise<Uint8Array[]> {
  removeWorker();
  register("inline-reference", geojson, options);
  const tiles = await Promise.all(TILES.map((xyz) => tile("inline-reference", xyz)));
  unregisterGeoJsonVtSource("inline-reference");
  registered.delete("inline-reference");
  return tiles;
}

describe("geojson-vt tiling worker", () => {
  it("is installed by the app entry and tiles inline where Workers are unavailable", async () => {
    // index.ts installs the real factory; node has no Worker, so it declines.
    await import("../packages/map/src/geojson-vt-worker-factory");
    const geojson = points(200);
    register("L", geojson, PLAIN);
    assert.ok((await tile("L", [0, 0, 0])).byteLength > 0);
    assert.equal(spawned, 0);
  });

  for (const [name, geojson, options] of [
    ["points", points(5_000), PLAIN],
    ["polygons", squares(2_500), PLAIN],
    ["clustered points", points(5_000, 7), CLUSTERED],
  ] as const) {
    it(`serves the same tile bytes as inline tiling: ${name}`, async () => {
      const expected = await inlineTiles(geojson, options);
      assert.ok(expected.some((bytes) => bytes.byteLength > 0));

      installFakeWorker();
      register("L", geojson, options);
      const actual = await Promise.all(TILES.map((xyz) => tile("L", xyz)));
      assert.deepEqual(actual, expected);
      assert.equal(spawned, 1);
      // The features crossed in chunks, and every tile was cut by the worker.
      assert.equal(
        toWorker.filter((message) => message.type === "features").length,
        Math.ceil(geojson.features.length / TILE_WORKER_CHUNK_FEATURES),
      );
      assert.equal(toWorker.filter((message) => message.type === "tile").length, TILES.length);
    });
  }

  it("serves the new data after a rebuild, even one that overtakes the previous build", async () => {
    const first = points(6_000, 3);
    const second = points(4_000, 11);
    const expected = await inlineTiles(second, PLAIN);

    installFakeWorker();
    assert.equal(register("L", first, PLAIN), true);
    // Replace the data while the first build's chunks are still being posted.
    assert.equal(register("L", second, PLAIN), true);
    const actual = await Promise.all(TILES.map((xyz) => tile("L", xyz)));
    assert.deepEqual(actual, expected);
    // The superseded build stopped posting part-way.
    const firstBuild = toWorker.find((message) => message.type === "begin");
    assert.ok(firstBuild && firstBuild.type === "begin");
    assert.equal(
      toWorker.some(
        (message) => message.type === "build" && message.generation === firstBuild.generation,
      ),
      false,
    );
  });

  it("reuses the worker's index while the data is unchanged", async () => {
    installFakeWorker();
    const geojson = points(1_000);
    assert.equal(register("L", geojson, PLAIN), true);
    assert.equal(register("L", geojson, PLAIN), false);
    await tile("L", [0, 0, 0]);
    assert.equal(toWorker.filter((message) => message.type === "build").length, 1);
  });

  it("answers an aborted request empty and cancels it in the worker", async () => {
    installFakeWorker();
    register("L", points(3_000), PLAIN);
    await tile("L", [0, 0, 0]);
    const controller = new AbortController();
    const pending = protocolHandler()({ url: `${GEOJSONVT_PROTOCOL}://L/1/0/0` }, controller);
    // Abort once the request is on its way to the worker.
    while (toWorker.filter((message) => message.type === "tile").length < 2) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    controller.abort();
    const { data } = await pending;
    assert.equal(data.byteLength, 0);
    assert.ok(toWorker.some((message) => message.type === "cancel"));
  });

  it("tiles inline when the worker fails to load, and stops spawning workers", async () => {
    const geojson = squares(1_000);
    const expected = await inlineTiles(geojson, PLAIN);

    failToLoad = true;
    installFakeWorker();
    register("L", geojson, PLAIN);
    const actual = await Promise.all(TILES.map((xyz) => tile("L", xyz)));
    assert.deepEqual(actual, expected);

    register("M", geojson, PLAIN);
    assert.deepEqual(await tile("M", [0, 0, 0]), expected[0]);
    assert.equal(spawned, 1);
  });

  it("terminates the worker with the last tiled layer and spawns a new one later", async () => {
    installFakeWorker();
    register("L", points(500), PLAIN);
    register("M", points(500, 5), PLAIN);
    unregisterGeoJsonVtSource("L");
    assert.equal(terminated, 0);
    assert.ok(toWorker.some((message) => message.type === "drop" && message.layerId === "L"));
    unregisterGeoJsonVtSource("M");
    assert.equal(terminated, 1);

    register("N", points(500), PLAIN);
    assert.ok((await tile("N", [0, 0, 0])).byteLength > 0);
    assert.equal(spawned, 2);
  });

  it("answers empty for an unknown layer or a malformed URL", async () => {
    installFakeWorker();
    register("L", points(100), PLAIN);
    assert.equal((await tile("nope", [0, 0, 0])).byteLength, 0);
    const { data } = await protocolHandler()(
      { url: `${GEOJSONVT_PROTOCOL}://L/zero/0/0` },
      new AbortController(),
    );
    assert.equal(data.byteLength, 0);
  });
});

describe("createTileIndexSession", () => {
  it("skips a queued tile that is cancelled before it is encoded", () => {
    const posted: TileWorkerMessage[] = [];
    const scheduled: Array<() => void> = [];
    const handle = createTileIndexSession(
      (message) => posted.push(message),
      (callback) => scheduled.push(callback),
    );
    handle({ type: "begin", layerId: "L", generation: 1, options: PLAIN });
    handle({ type: "features", layerId: "L", generation: 1, features: points(50).features });
    handle({ type: "build", layerId: "L", generation: 1 });
    handle({ type: "tile", requestId: 1, layerId: "L", z: 0, x: 0, y: 0 });
    handle({ type: "tile", requestId: 2, layerId: "L", z: 0, x: 0, y: 0 });
    handle({ type: "cancel", requestId: 1 });
    while (scheduled.length) scheduled.shift()!();
    assert.deepEqual(
      posted.map((message) => message.requestId),
      [2],
    );
    assert.ok(posted[0].data.byteLength > 0);
  });

  it("ignores chunks of a superseded build and answers empty for a dropped layer", () => {
    const posted: TileWorkerMessage[] = [];
    const handle = createTileIndexSession(
      (message) => posted.push(message),
      (callback) => callback(),
    );
    handle({ type: "begin", layerId: "L", generation: 1, options: PLAIN });
    handle({ type: "begin", layerId: "L", generation: 2, options: PLAIN });
    handle({ type: "features", layerId: "L", generation: 1, features: points(50).features });
    handle({ type: "build", layerId: "L", generation: 1 });
    handle({ type: "build", layerId: "L", generation: 2 });
    // Generation 2 had no features: its tiles are empty.
    handle({ type: "tile", requestId: 1, layerId: "L", z: 0, x: 0, y: 0 });
    handle({ type: "drop", layerId: "L" });
    handle({ type: "tile", requestId: 2, layerId: "L", z: 0, x: 0, y: 0 });
    assert.deepEqual(
      posted.map((message) => [message.requestId, message.data.byteLength]),
      [
        [1, 0],
        [2, 0],
      ],
    );
  });
});
