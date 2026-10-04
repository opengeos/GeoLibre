// Installs the tiling worker for large local vector layers (see
// geojson-vt-protocol.ts). Kept out of the protocol module so the published
// headless build, which ships no worker file, never references one: only the
// app entry (index.ts) imports this module.
import { setGeoJsonVtWorkerFactory } from "./geojson-vt-protocol";

setGeoJsonVtWorkerFactory(() =>
  typeof Worker === "undefined"
    ? null
    : new Worker(new URL("./geojson-vt.worker.ts", import.meta.url), { type: "module" }),
);
