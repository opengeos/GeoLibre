/// <reference lib="webworker" />
// Stands in for `h5wasm` inside the remote NetCDF worker's production build
// (see `vite-plugins/shared-h5wasm.ts`). It re-exports the main build's h5wasm
// chunk, fetched by URL, so the worker bundle does not carry its own copy of
// libhdf5. Never imported directly: the reader reaches it through its lazy
// `import("h5wasm")`, by which time the worker has recorded the URL.
import { getH5wasmUrl } from "./h5wasm-url";

type H5wasmModule = Record<string, unknown> & { default?: unknown };

const h5wasm = (await import(/* @vite-ignore */ getH5wasmUrl())) as H5wasmModule;

export default h5wasm.default ?? h5wasm;
export const ready = h5wasm.ready;
export const File = h5wasm.File;
export const FS = h5wasm.FS;
