import type { MapController } from "@geolibre/map";
import consoleApiSource from "./console_api.py?raw";
import { getPyodideIndexUrl } from "./pyodide-config";
import {
  createScriptingHandlers,
  type ScriptingDeps,
} from "../scripting/scriptingApi";

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

let scriptPromise: Promise<void> | null = null;

/** Inject the CDN `pyodide.js` once so `window.loadPyodide` is available. */
function loadPyodideScript(indexURL: string): Promise<void> {
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    if (window.loadPyodide) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = `${indexURL}pyodide.js`;
    script.onload = () => resolve();
    // The shared `.catch` below owns resetting scriptPromise on failure.
    script.onerror = () =>
      reject(new Error("Failed to load the Pyodide runtime script."));
    document.head.appendChild(script);
  }).catch((error) => {
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

export function runConsoleCode(
  deps: ScriptingDeps,
  source: string,
): Promise<ConsoleRunResult> {
  const result = runQueue.then(() => runConsoleCodeImpl(deps, source));
  // Keep the chain alive even if a run rejects (it shouldn't — impl catches).
  runQueue = result.catch(() => undefined);
  return result;
}

async function runConsoleCodeImpl(
  deps: ScriptingDeps,
  source: string,
): Promise<ConsoleRunResult> {
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
        append(
          typeof proxy.toString === "function"
            ? proxy.toString()
            : String(result),
        );
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
export function consoleDeps(
  getController: () => MapController | null,
): ScriptingDeps {
  return { getController };
}
