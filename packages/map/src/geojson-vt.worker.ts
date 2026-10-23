/// <reference lib="webworker" />
// Holds the tile indexes of large local vector layers and encodes their tiles
// off the main thread (see geojson-vt-index.ts). geojson-vt-protocol.ts spawns
// one of these while any such layer is on the map and terminates it when the
// last one is removed.
import { createTileIndexSession, type TileWorkerRequest } from "./geojson-vt-index";

const worker = self as unknown as DedicatedWorkerGlobalScope;
const handle = createTileIndexSession((message, transfer) => worker.postMessage(message, transfer));

worker.addEventListener("message", (event: MessageEvent<TileWorkerRequest>) => {
  handle(event.data);
});
