import path from "node:path";
import type { Plugin } from "vite";

// One copy of h5wasm (libhdf5 compiled to a ~4.8 MB single-file module) for the
// whole production build.
//
// Both the main thread (local NetCDF/HDF files, `local-netcdf.ts`) and the
// remote NetCDF worker (`src/workers/netcdf-remote.worker.ts`) import h5wasm.
// Vite bundles a worker as a separate build that cannot share chunks with the
// main graph, so each build used to emit its own `hdf5_hl-*.js`: two
// near-identical 4.8 MB files differing only in minifier choices.
//
// The main build now emits h5wasm as an explicit chunk (the same one the main
// thread's lazy `import("h5wasm")` resolves to) and fills in
// `src/lib/h5wasm-chunk-url.ts` with its URL. The client passes that URL to the
// worker, and the worker build swaps `h5wasm` for `src/workers/h5wasm-from-main.ts`,
// which imports the chunk by URL. Dev is untouched: workers there are served by
// the dev server and import h5wasm normally.

const CHUNK_URL_MODULE = /\/src\/lib\/h5wasm-chunk-url\.ts$/;

/**
 * Main build: emits h5wasm as a named chunk and exposes its URL through
 * `src/lib/h5wasm-chunk-url.ts`. The chunk keeps the `hdf5_hl` name, which the
 * PWA precache exclusion matches.
 *
 * @returns The Vite plugin.
 */
export function sharedH5wasmChunkPlugin(): Plugin {
  // Whether load() replaced src/lib/h5wasm-chunk-url.ts this build. If the file
  // moves and CHUNK_URL_MODULE stops matching, the main thread still gets its
  // one h5wasm chunk but the worker is sent a null URL and throws at runtime.
  let urlModuleReplaced = false;
  return {
    name: "geolibre-shared-h5wasm-chunk",
    apply: "build",
    buildStart() {
      urlModuleReplaced = false;
    },
    load(id) {
      if (!CHUNK_URL_MODULE.test(id)) return null;
      urlModuleReplaced = true;
      const ref = this.emitFile({
        type: "chunk",
        id: "h5wasm",
        name: "hdf5_hl",
        preserveSignature: "strict",
      });
      // The file URL renders base-relative ("/assets/…") or already absolute,
      // depending on `base`. Resolve it here so the worker, whose own URL is
      // the base for its imports, gets a URL it cannot misread.
      return `export const h5wasmChunkUrl = new URL(import.meta.ROLLUP_FILE_URL_${ref}, import.meta.url).href;\n`;
    },
    // Worker builds land in this bundle as emitted files, so a second h5wasm
    // copy (a new worker importing it without the shim, or a bundler change
    // that stops the emitted chunk coalescing with the lazy import) is visible
    // here. Fail rather than ship 4.8 MB twice again.
    generateBundle(_, bundle) {
      if (!urlModuleReplaced) {
        this.error(
          "src/lib/h5wasm-chunk-url.ts was not replaced with the h5wasm chunk URL, so " +
            "the remote NetCDF worker could not load h5wasm. Update CHUNK_URL_MODULE " +
            "in vite-plugins/shared-h5wasm.ts if the file moved.",
        );
      }
      const copies = Object.keys(bundle).filter((fileName) =>
        /(?:^|\/)hdf5_hl-[^/]*\.js$/.test(fileName),
      );
      if (copies.length !== 1) {
        this.error(
          `Expected exactly one h5wasm chunk (hdf5_hl-*.js), found ${copies.length}: ` +
            `${copies.join(", ") || "none"}. See vite-plugins/shared-h5wasm.ts.`,
        );
      }
    },
  };
}

/**
 * Worker builds: resolves `h5wasm` to the shim that imports the main build's
 * chunk by URL instead of bundling another copy.
 *
 * @param shimPath - Absolute path of `src/workers/h5wasm-from-main.ts`.
 * @returns The Vite plugin.
 */
export function workerH5wasmFromMainPlugin(shimPath: string): Plugin {
  const shim = path.resolve(shimPath);
  return {
    name: "geolibre-worker-h5wasm-from-main",
    apply: "build",
    enforce: "pre",
    resolveId(source) {
      return source === "h5wasm" ? shim : null;
    },
  };
}
