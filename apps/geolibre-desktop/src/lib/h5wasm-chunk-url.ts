/**
 * Absolute URL of the main build's h5wasm chunk, for the remote NetCDF worker.
 *
 * The worker is a separate Vite build, so a plain `import("h5wasm")` in it would
 * ship a second ~4.8 MB copy of libhdf5. A production build instead replaces
 * this module (see `vite-plugins/shared-h5wasm.ts`) with the URL of the one
 * chunk the main thread already loads, and the worker imports that.
 *
 * `null` in the dev server and under Node tests, where the worker imports
 * h5wasm normally.
 */
export const h5wasmChunkUrl: string | null = null;
