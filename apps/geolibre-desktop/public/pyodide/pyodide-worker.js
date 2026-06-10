/*
 * GeoLibre Pyodide vector worker (classic Web Worker).
 *
 * Runs the GeoPandas/Shapely vector tools entirely in the browser. This is a
 * plain JS file served from public/ (NOT bundled by Vite) on purpose: Pyodide
 * 0.27's loader only supports a classic worker (importScripts) or the main
 * thread — a module worker hits its "Cannot determine runtime environment"
 * error. Loading the CDN UMD via importScripts also avoids bundling
 * pyodide.mjs's dynamic node: imports.
 *
 * Protocol (postMessage):
 *   in:  { type: "init", indexURL, vectorOpsSource }
 *        { type: "run",  id, request }   // request = {tool_id, geojson, overlay, parameters}
 *   out: { type: "progress", phase }
 *        { type: "ready" }
 *        { type: "result", id, geojson, messages }
 *        { type: "error",  id, message }   // id omitted for init failures
 *
 * The main thread (pyodide-vector-loader.ts) reads the Python source via a Vite
 * ?raw import and hands it over in the init message, so the single
 * source-of-truth backend module is what runs here.
 */

let readyPromise = null;
let pyodide = null;

async function initialize(indexURL, vectorOpsSource) {
  self.postMessage({ type: "progress", phase: "Downloading Python runtime" });
  // The UMD build attaches loadPyodide to the worker global scope.
  // Trust note: importScripts has no SRI, and Pyodide loads its own
  // pyodide.asm.js/WASM from indexURL internally, so verifying this entry
  // script alone would not secure the runtime. The default CDN therefore
  // carries a trust assumption; self-host via VITE_PYODIDE_INDEX_URL to remove
  // the external dependency (see docs/user-guide/processing.md).
  self.importScripts(`${indexURL}pyodide.js`);
  pyodide = await self.loadPyodide({ indexURL });

  self.postMessage({ type: "progress", phase: "Loading GeoPandas" });
  // geopandas pulls shapely, pyproj, pandas, numpy, fiona transitively.
  await pyodide.loadPackage("geopandas");

  // Define run_vector_tool / run_vector_tool_json (the shared backend module).
  pyodide.runPython(vectorOpsSource);
  self.postMessage({ type: "ready" });
}

self.onmessage = async (event) => {
  const data = event.data || {};

  if (data.type === "init") {
    readyPromise ??= initialize(data.indexURL, data.vectorOpsSource).catch(
      (err) => {
        // Reset so a later init can retry after a transient failure.
        readyPromise = null;
        self.postMessage({
          type: "error",
          message:
            err && err.message ? err.message : "Failed to load Python runtime",
        });
        // Do not re-throw: the posted "error" message is the sole error
        // channel, and re-throwing would reject this catch() promise with no
        // live awaiter (readyPromise is already null) — an unhandled rejection.
      },
    );
    return;
  }

  if (data.type === "run") {
    const { id, request } = data;
    try {
      if (!readyPromise) throw new Error("Pyodide worker not initialized");
      await readyPromise;
      // A run that was awaiting readyPromise when init failed lands here with no
      // runtime; surface a clean error rather than a null dereference below.
      if (!pyodide) throw new Error("Python runtime is not available");
      // JSON-string boundary: avoids PyProxy lifetime management and matches the
      // sidecar's JSON contract exactly.
      const fn = pyodide.globals.get("run_vector_tool_json");
      // fn is a PyProxy and must be destroyed even if the call throws (e.g. a
      // GeoPandas ValueError), or it leaks the underlying Python object. Use
      // optional chaining so a missing global doesn't mask the original error.
      let out;
      try {
        out = fn(JSON.stringify(request));
      } finally {
        fn?.destroy();
      }
      const parsed = JSON.parse(out);
      self.postMessage({
        type: "result",
        id,
        geojson: parsed.geojson,
        messages: parsed.messages,
      });
    } catch (err) {
      self.postMessage({
        type: "error",
        id,
        message: err && err.message ? err.message : String(err),
      });
    }
  }
};
