import type { MapController } from "@geolibre/map";
import consoleApiSource from "./console_api.py?raw";
import { getPyodideIndexUrl, isDefaultPyodideIndexUrl } from "./pyodide-config";
import { createScriptingHandlers, type ScriptingDeps } from "../scripting/scriptingApi";

// Main-thread Pyodide runtime backing the in-app Python Console. Unlike the
// vector-tools worker (pyodide-vector-loader.ts), this runs on the main thread on
// purpose: the console's `geolibre` facade must reach the live Zustand store and
// MapController synchronously, which a Web Worker cannot. The runtime is a
// memoized singleton, so the multi-MB download happens once and the Python
// namespace (user variables) persists across panel open/close.

// Minimal slice of the Pyodide API we use (Pyodide ships no npm types here; it is
// loaded from the CDN at runtime, like the worker).
interface PyProxyFn {
  (...args: unknown[]): unknown;
  destroy?: () => void;
}

interface PyodideAPI {
  loadPackage: (names: string | string[]) => Promise<unknown>;
  runPython: (code: string) => unknown;
  runPythonAsync: (code: string) => Promise<unknown>;
  registerJsModule: (name: string, module: object) => void;
  setStdout: (options?: { batched?: (text: string) => void }) => void;
  setStderr: (options?: { batched?: (text: string) => void }) => void;
  globals: { get: (name: string) => unknown };
}

export interface ConsoleCompletion {
  /** The text fragment being completed (the chars to replace before the caret). */
  prefix: string;
  /** Candidate identifiers, sorted. */
  candidates: string[];
}

type LoadPyodide = (options: { indexURL: string }) => Promise<PyodideAPI>;

declare global {
  interface Window {
    loadPyodide?: LoadPyodide;
    // Emscripten factory exposed by pyodide.asm.js. loadPyodide() dynamically
    // `import()`s pyodide.asm.js only when this is not already a function, so
    // pre-injecting the script (below) lets us skip that CSP-blocked import.
    _createPyodideModule?: unknown;
  }
}

export interface ConsoleRunResult {
  /** Captured stdout/stderr plus the repr of the last expression. */
  output: string;
  /** The error message (with Python traceback) when the run failed, else null. */
  error: string | null;
}

type ProgressListener = (phase: string) => void;
const progressListeners = new Set<ProgressListener>();

/**
 * Subscribe to runtime load-progress phases ("Downloading Python runtime", …).
 *
 * @param listener - Called with each phase as it happens.
 * @returns An unsubscribe function.
 */
export function onConsoleProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

function emitProgress(phase: string): void {
  for (const listener of progressListeners) listener(phase);
}

// Both this script memo and the runtimePromise singleton below are intentionally
// not keyed on indexURL: `getPyodideIndexUrl()` is stable for the app's lifetime,
// so the console always resolves the same URL. Runtime mirror-switching is out of
// scope; supporting it would mean rebuilding the whole runtime, not just rekeying
// this promise.
let scriptPromise: Promise<void> | null = null;

// Generous bound on each runtime-script fetch. Large enough for the multi-MB
// pyodide.asm.js over a slow link, small enough to escape a dead mirror.
const SCRIPT_FETCH_TIMEOUT_MS = 60_000;

/**
 * Fetch a Pyodide runtime script and run it via a `blob:` URL, then confirm it
 * defined the global it is supposed to.
 *
 * Tauri's `script-src` CSP only allows the jsDelivr CDN origins, so a custom
 * `VITE_PYODIDE_INDEX_URL` mirror cannot be reached as a direct `<script src>`
 * nor by Pyodide's own dynamic `import()` — but `connect-src` permits `https:`
 * fetches and `script-src` permits `blob:`, so fetch-then-blob reaches any
 * mirror. The vector-tools worker sidesteps the same CSP via `importScripts`;
 * this is the main-thread equivalent, mirroring `external-plugins.ts`.
 *
 * @param scriptUrl - The absolute URL of the script to load.
 * @param isReady - Predicate that returns true once the script's global is
 *   present; used to reject a 200 HTML error page or corrupted payload (which
 *   `onload` does not catch) so the `.catch` memo reset enables a clean retry.
 * @param label - Human-readable name of the global, for the diagnostic message.
 */
async function injectScript(
  scriptUrl: string,
  isReady: () => boolean,
  label: string,
): Promise<void> {
  if (isReady()) return;
  // Read as an ArrayBuffer rather than text: pyodide.asm.js is the multi-MB
  // Emscripten runtime, and decoding it to a (UTF-16) JS string before copying
  // it into the Blob would roughly triple its peak memory footprint. The Blob
  // is fed straight to a <script src>, so the raw bytes are all we need.
  let source: ArrayBuffer;
  // Bound the fetch so a hung or misconfigured mirror surfaces an error (and
  // the caller's memo reset enables a retry) instead of an infinite spinner.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCRIPT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(scriptUrl, { signal: controller.signal });
    // The timeout only guards against a dead/unresponsive mirror, which is
    // disproven the moment headers arrive. Clear it here so a slow but live
    // mirror isn't aborted partway through the multi-MB asm.js body download.
    clearTimeout(timeout);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    source = await response.arrayBuffer();
  } catch (cause) {
    throw new Error(`Failed to load the Pyodide runtime script from ${scriptUrl}.`, { cause });
  } finally {
    // Idempotent; covers a fetch that rejects before the clear above.
    clearTimeout(timeout);
  }
  const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = blobUrl;
      // The script's globals persist once it has executed, so the element is
      // dead weight afterwards; remove it on every path to keep the DOM clean
      // (and so a retry never leaves orphan <script> tags).
      script.onload = () => {
        script.remove();
        if (isReady()) {
          resolve();
          return;
        }
        reject(
          new Error(
            `Pyodide script loaded but ${label} is not defined; the content at ${scriptUrl} may be incorrect.`,
          ),
        );
      };
      // `onerror` fires when the browser fails to load the blob resource, not
      // when the executed script throws (those reach window.onerror); word the
      // message as a load failure accordingly.
      script.onerror = () => {
        script.remove();
        reject(new Error(`Failed to load the injected Pyodide runtime script from ${scriptUrl}.`));
      };
      document.head.appendChild(script);
    });
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/**
 * Load Pyodide's two entry scripts once so the runtime can initialize from any
 * `indexURL`, including a self-hosted mirror, under Tauri's CSP.
 *
 * `pyodide.js` defines `window.loadPyodide`. For a custom mirror we then also
 * pre-inject `pyodide.asm.js` (which defines `globalThis._createPyodideModule`)
 * because `loadPyodide()` otherwise dynamically `import()`s that file from
 * `indexURL`, and that import is blocked by `script-src` for a non-whitelisted
 * mirror. Pyodide skips the import when `_createPyodideModule` is already a
 * function, so the pre-injected blob short-circuits it. The default jsDelivr CDN
 * is already in `script-src`, so we skip the asm.js pre-injection there and let
 * Pyodide's own (cache-aware, streaming) import run, keeping the common path
 * unchanged. Pyodide's remaining assets (wasm, lockfile, wheels) load via
 * `fetch`, allowed by `connect-src`, so passing `indexURL` to
 * `loadPyodide({ indexURL })` resolves them unchanged.
 */
function loadPyodideScript(indexURL: string): Promise<void> {
  scriptPromise ??= (async () => {
    await injectScript(
      `${indexURL}pyodide.js`,
      () => typeof window.loadPyodide === "function",
      "window.loadPyodide",
    );
    if (isDefaultPyodideIndexUrl(indexURL)) return;
    // Custom mirror only. Pyodide 0.27.x's loadPyodide() does a dynamic
    // import() of pyodide.asm.js solely when globalThis._createPyodideModule is
    // not already a function, so pre-defining it via the blob path
    // short-circuits that CSP-blocked import. This hinges on an
    // Emscripten/Pyodide internal: re-verify it still holds whenever
    // PYODIDE_VERSION in pyodide-config.ts is bumped.
    await injectScript(
      `${indexURL}pyodide.asm.js`,
      () => typeof window._createPyodideModule === "function",
      "window._createPyodideModule",
    );
  })().catch((error) => {
    scriptPromise = null;
    throw error;
  });
  return scriptPromise;
}

let runtimePromise: Promise<PyodideAPI> | null = null;

async function createRuntime(deps: ScriptingDeps): Promise<PyodideAPI> {
  const indexURL = getPyodideIndexUrl();
  emitProgress("Downloading Python runtime");
  await loadPyodideScript(indexURL);
  if (!window.loadPyodide) {
    throw new Error("Pyodide failed to initialize.");
  }
  const pyodide = await window.loadPyodide({ indexURL });

  emitProgress("Setting up GeoLibre");
  // Expose the shared scripting handlers (plus on-demand package loading) to
  // Python as the `_geolibre_js` module; console_api.py wraps them as `geolibre`.
  const facade = {
    ...createScriptingHandlers(deps),
    loadPackage: (name: string) => pyodide.loadPackage(name),
  };
  pyodide.registerJsModule("_geolibre_js", facade);
  pyodide.runPython(consoleApiSource);
  return pyodide;
}

/**
 * Initialize (or reuse) the console runtime. The first caller's deps win; the
 * `getController` accessor is stable for the app's lifetime, so this is safe.
 *
 * @param deps - Accessors for the live map controller.
 */
export function initConsoleRuntime(deps: ScriptingDeps): Promise<PyodideAPI> {
  runtimePromise ??= createRuntime(deps).catch((error) => {
    // Clear the memo so a later attempt can retry after a transient failure.
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

/**
 * Run a snippet of user Python in the console runtime, capturing output.
 *
 * Uses `runPythonAsync` so top-level `await` works (e.g. `await
 * geolibre.run_algorithm(...)`). User variables persist across calls because the
 * code runs in the runtime's shared globals.
 *
 * @param deps - Accessors for the live map controller (used on first init).
 * @param source - The Python source to execute.
 * @returns Captured output and an error message (with traceback) on failure.
 */
// Runs are serialized through this queue: stdout/stderr capture is
// instance-global, so an overlapping call (e.g. a rapid double-trigger before the
// UI disables Run, or a console + editor run racing) would clobber the active
// `append` closure. Chaining each run after the previous keeps captures isolated.
let runQueue: Promise<unknown> = Promise.resolve();

export function runConsoleCode(deps: ScriptingDeps, source: string): Promise<ConsoleRunResult> {
  const result = runQueue.then(() => runConsoleCodeImpl(deps, source));
  // Keep the chain alive even if a run rejects (it shouldn't — impl catches).
  runQueue = result.catch(() => undefined);
  return result;
}

async function runConsoleCodeImpl(deps: ScriptingDeps, source: string): Promise<ConsoleRunResult> {
  const pyodide = await initConsoleRuntime(deps);
  let output = "";
  const append = (text: string) => {
    output += text.endsWith("\n") ? text : `${text}\n`;
  };
  // stdout and stderr are intentionally merged into one chronological `output`
  // stream (like a terminal); `error` is reserved for an actual raised exception.
  // So a non-raising `sys.stderr` write (e.g. warnings.warn) appears in `output`.
  pyodide.setStdout({ batched: append });
  pyodide.setStderr({ batched: append });
  try {
    const result = await pyodide.runPythonAsync(source);
    // Echo the last expression like a REPL (Python None comes back as undefined).
    if (result !== undefined && result !== null) {
      const proxy = result as { toString?: () => string; destroy?: () => void };
      // Destroy the proxy even if toString() throws, or it leaks the underlying
      // Python object and its JS reference.
      try {
        append(typeof proxy.toString === "function" ? proxy.toString() : String(result));
      } finally {
        if (typeof proxy.destroy === "function") proxy.destroy();
      }
    }
    return { output, error: null };
  } catch (error) {
    return {
      output,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    pyodide.setStdout();
    pyodide.setStderr();
  }
}

/**
 * Compute autocomplete candidates for the editor by introspecting the live
 * runtime namespace (attributes for `obj.`, otherwise globals/builtins/keywords).
 *
 * @param deps - Accessors for the live map controller (used on first init).
 * @param source - The full editor text.
 * @param cursor - The caret offset into `source`.
 * @returns The prefix being completed and the sorted candidate identifiers.
 */
export async function completeConsoleCode(
  deps: ScriptingDeps,
  source: string,
  cursor: number,
): Promise<ConsoleCompletion> {
  const pyodide = await initConsoleRuntime(deps);
  const completer = pyodide.globals.get("_geolibre_complete") as PyProxyFn;
  try {
    const json = completer(source, cursor) as string;
    return JSON.parse(json) as ConsoleCompletion;
  } finally {
    completer.destroy?.();
  }
}

/** Convenience for the panel: pull a controller accessor into the deps shape. */
export function consoleDeps(getController: () => MapController | null): ScriptingDeps {
  return { getController };
}
