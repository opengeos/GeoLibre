// osmix (@osmix/core) chooses its buffer type at module load with
// `typeof SharedArrayBuffer !== "undefined" ? SharedArrayBuffer : ArrayBuffer`,
// and elsewhere does `buffer instanceof SharedArrayBuffer` — which throws a
// ReferenceError, not a graceful `false`, when SharedArrayBuffer is undefined.
//
// SharedArrayBuffer is only defined on cross-origin-isolated pages (COOP/COEP
// headers), which GeoLibre is not (and enabling COEP would break the many
// cross-origin map tiles/images the app loads). Alias it to ArrayBuffer so
// osmix builds on resizable ArrayBuffers instead. We never rely on shared
// memory: the worker converts to plain GeoJSON and posts it back by copy.
//
// This module must be imported before any @osmix module, so it is the first
// import in osm-pbf.ts.
if (typeof globalThis.SharedArrayBuffer === "undefined") {
  (globalThis as unknown as { SharedArrayBuffer: ArrayBufferConstructor }).SharedArrayBuffer =
    ArrayBuffer;
}

export {};
